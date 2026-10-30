//! Sign-ins that come back to localhost (X75). When a command on a member
//! opens a sign-in whose `redirect_uri` is a loopback port it listens on
//! itself, the member registers a **callback** for that port. The Mac whose
//! app opens the URL listens on its own loopback `<port>`, and passes each
//! request the browser makes there to the member, which hands it to the
//! command's port and answers what the command answered.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// How long a callback, and the forward for it, lasts at most.
pub const LIFETIME: Duration = Duration::from_secs(10 * 60);
/// The most a request or an answer through a forward may be.
const MAX_BYTES: usize = 1024 * 1024;
/// How long a forwarded request waits for the command's answer.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);

/// The pids `lsof -Fpn` lists as listening, from its output.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub fn listeners(lsof: &str) -> Vec<u32> {
    lsof.lines()
        .filter_map(|l| l.strip_prefix('p'))
        .filter_map(|p| p.trim().parse().ok())
        .collect()
}

/// The socket inodes `/proc/net/tcp` or `/proc/net/tcp6` lists as
/// listening on port `port`, from its text.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn listening_inodes(proc_net_tcp: &str, port: u16) -> Vec<u64> {
    proc_net_tcp
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let local = f.get(1)?.rsplit_once(':')?.1;
            let listen = *f.get(3)? == "0A";
            (listen && u16::from_str_radix(local, 16).ok()? == port)
                .then(|| f.get(9)?.parse().ok())
                .flatten()
        })
        .collect()
}

/// The parent pid in a `/proc/<pid>/stat` line.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parent_in_stat(stat: &str) -> Option<u32> {
    // The command's name, in parentheses, may hold spaces or parentheses.
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// The pids listening on TCP port `port` on this machine, from `lsof`.
#[cfg(not(target_os = "linux"))]
async fn listening(port: u16) -> Vec<u32> {
    let out = tokio::process::Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fpn"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await;
    match out {
        Ok(o) => listeners(&String::from_utf8_lossy(&o.stdout)),
        Err(e) => {
            tracing::warn!("cannot run lsof to find a sign-in's listener: {e}");
            Vec::new()
        }
    }
}

/// The pids listening on TCP port `port` on this machine, from `/proc`:
/// a Linux host may have neither `lsof` nor `ps`.
#[cfg(target_os = "linux")]
async fn listening(port: u16) -> Vec<u32> {
    tokio::task::spawn_blocking(move || {
        let inodes: Vec<u64> = ["/proc/net/tcp", "/proc/net/tcp6"]
            .iter()
            .filter_map(|f| std::fs::read_to_string(f).ok())
            .flat_map(|t| listening_inodes(&t, port))
            .collect();
        if inodes.is_empty() {
            return Vec::new();
        }
        let sockets: Vec<String> = inodes.iter().map(|i| format!("socket:[{i}]")).collect();
        let Ok(procs) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        procs
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
            .filter(|pid| {
                std::fs::read_dir(format!("/proc/{pid}/fd")).is_ok_and(|fds| {
                    fds.flatten().any(|fd| {
                        std::fs::read_link(fd.path())
                            .is_ok_and(|l| sockets.iter().any(|s| l.as_os_str() == s.as_str()))
                    })
                })
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// The parent of `pid`, from `ps`.
#[cfg(not(target_os = "linux"))]
async fn parent_of(pid: u32) -> Option<u32> {
    let out = tokio::process::Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// The parent of `pid`, from `/proc/<pid>/stat`.
#[cfg(target_os = "linux")]
async fn parent_of(pid: u32) -> Option<u32> {
    let stat = tokio::fs::read_to_string(format!("/proc/{pid}/stat"))
        .await
        .ok()?;
    parent_in_stat(&stat)
}

/// `pid` and its ancestors, up to but not including `stop` (the daemon,
/// which started the terminal or agent) or the first process.
async fn lineage(pid: u32, stop: u32) -> Vec<u32> {
    let mut out = Vec::new();
    let mut at = pid;
    while at > 1 && at != stop && out.len() < 64 {
        out.push(at);
        match parent_of(at).await {
            Some(p) => at = p,
            None => break,
        }
    }
    out
}

/// Whether one of `listening` is `caller` or an ancestor of it, below the
/// daemon: the command that opened the URL listens for its own sign-in.
pub fn listens_itself(listening: &[u32], lineage: &[u32]) -> bool {
    listening.iter().any(|p| lineage.contains(p))
}

/// A sign-in that waits for the browser to come back to its port.
#[derive(Debug, Clone)]
struct Callback {
    until: Instant,
}

/// This member's callbacks, by port.
#[derive(Default)]
pub struct Callbacks {
    list: Mutex<BTreeMap<u16, Callback>>,
}

impl Callbacks {
    /// Registers a callback for the port `url` comes back to, when the
    /// process `caller` (the CLI that `moonlet-open` ran) or one of its
    /// ancestors below this daemon listens on it. Gives the port.
    pub async fn register(&self, url: &str, caller: Option<u32>) -> Option<u16> {
        self.register_below(url, caller?, std::process::id()).await
    }

    /// [`Self::register`], `daemon` being the process that started the
    /// terminal or agent: neither it nor its own ports ever count.
    async fn register_below(&self, url: &str, caller: u32, daemon: u32) -> Option<u16> {
        let port = moonlet_core::browser::redirect_port(url)?;
        let lineage = lineage(caller, daemon).await;
        let listening: Vec<u32> = listening(port)
            .await
            .into_iter()
            .filter(|p| *p != daemon)
            .collect();
        if !listens_itself(&listening, &lineage) {
            return None;
        }
        self.list.lock().unwrap().insert(
            port,
            Callback {
                until: Instant::now() + LIFETIME,
            },
        );
        Some(port)
    }

    /// Whether port `port` has a callback still waiting: registered, not
    /// timed out, and something still listening on it.
    pub async fn waiting(&self, port: u16) -> bool {
        let alive = {
            let mut list = self.list.lock().unwrap();
            list.retain(|_, c| c.until > Instant::now());
            list.contains_key(&port)
        };
        if alive && listening(port).await.is_empty() {
            self.list.lock().unwrap().remove(&port);
            return false;
        }
        alive
    }
}

/// One HTTP request read from `stream`: its head, and its body as its
/// `Content-Length` says.
async fn read_request(stream: &mut tokio::net::TcpStream) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_BYTES {
            bail!("the request is too big");
        }
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
            let body: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
            if buf.len() >= end + 4 + body {
                break;
            }
        }
    }
    Ok(buf)
}

/// `request` with its `Connection` header made `close`: the browser asks
/// to keep its connection, but the command's answer ends where it closes.
fn closing(request: &[u8]) -> Vec<u8> {
    let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") else {
        return request.to_vec();
    };
    let head = String::from_utf8_lossy(&request[..end]);
    let mut lines = head.split("\r\n");
    let mut out = String::from(lines.next().unwrap_or_default());
    for line in lines {
        let name = line.split(':').next().unwrap_or_default().trim();
        if !name.eq_ignore_ascii_case("connection") && !name.eq_ignore_ascii_case("keep-alive") {
            out.push_str("\r\n");
            out.push_str(line);
        }
    }
    out.push_str("\r\nConnection: close\r\n\r\n");
    let mut out = out.into_bytes();
    out.extend_from_slice(&request[end + 4..]);
    out
}

/// Hands `request` to this machine's `127.0.0.1:<port>`, or `[::1]:<port>`
/// when the command listens there only, and gives what it answered, until
/// it closes the connection.
pub async fn answer(port: u16, request: &[u8]) -> Result<Vec<u8>> {
    let run = async {
        let mut s = match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            Ok(s) => s,
            Err(_) => tokio::net::TcpStream::connect(("::1", port))
                .await
                .with_context(|| format!("nothing answers on port {port}"))?,
        };
        s.write_all(&closing(request)).await?;
        let mut out = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let n = s.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            out.extend_from_slice(&chunk[..n]);
            if out.len() > MAX_BYTES {
                bail!("the answer is too big");
            }
        }
        Ok(out)
    };
    tokio::time::timeout(ANSWER_TIMEOUT, run)
        .await
        .context("the command did not answer")?
}

/// What a forward hands a request to: the member's port, over the link.
pub type Pass = std::sync::Arc<
    dyn Fn(Vec<u8>) -> moonlet_link::BoxFuture<'static, Result<Vec<u8>, moonlet_proto::RpcError>>
        + Send
        + Sync,
>;

/// Binds this Mac's `127.0.0.1:<port>`, and `[::1]:<port>` where the Mac
/// has IPv6, for a browser that goes back to `localhost` or `[::1]`. An
/// error when either is taken here.
async fn bind_loopback(
    port: u16,
) -> std::io::Result<(tokio::net::TcpListener, Option<tokio::net::TcpListener>)> {
    let v4 = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let v6 = match tokio::net::TcpListener::bind(("::1", port)).await {
        Ok(l) => Some(l),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => return Err(e),
        Err(_) => None,
    };
    Ok((v4, v6))
}

/// The next connection on either of a forward's listeners.
async fn accept(
    v4: &tokio::net::TcpListener,
    v6: Option<&tokio::net::TcpListener>,
) -> std::io::Result<tokio::net::TcpStream> {
    match v6 {
        Some(v6) => tokio::select! {
            a = v4.accept() => a.map(|(s, _)| s),
            a = v6.accept() => a.map(|(s, _)| s),
        },
        None => v4.accept().await.map(|(s, _)| s),
    }
}

/// Listens on this Mac's loopback `<port>` for [`LIFETIME`], passing each
/// request to `pass`, until it answers `gone` (the command stopped
/// listening). An error when the port is taken here.
pub async fn forward(port: u16, pass: Pass) -> std::io::Result<()> {
    let (v4, v6) = bind_loopback(port).await?;
    tokio::spawn(async move {
        let end = Instant::now() + LIFETIME;
        loop {
            let left = end.saturating_duration_since(Instant::now());
            let Ok(Ok(mut stream)) = tokio::time::timeout(left, accept(&v4, v6.as_ref())).await
            else {
                return;
            };
            let request = match read_request(&mut stream).await {
                Ok(r) => r,
                Err(e) => {
                    tracing::debug!(port, "a sign-in's request: {e:#}");
                    continue;
                }
            };
            match pass(request).await {
                Ok(answer) => {
                    let _ = stream.write_all(&answer).await;
                    let _ = stream.shutdown().await;
                }
                Err(e) => {
                    let _ = stream
                        .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                    if e.code == "gone" || e.code == "forbidden" {
                        return;
                    }
                }
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `lsof -nP -iTCP:8095 -sTCP:LISTEN -Fpn` with `python3 -m
    /// http.server 8095 --bind 127.0.0.1` listening (macOS 27).
    const LSOF: &str = "p85443\nf3\nn127.0.0.1:8095\n";

    #[test]
    fn lsof_names_the_listening_process() {
        assert_eq!(listeners(LSOF), [85443]);
        assert_eq!(listeners(""), Vec::<u32>::new());
    }

    /// `/proc/net/tcp` and `/proc/net/tcp6` on Debian 13 (python:3.12-slim,
    /// which has neither `lsof` nor `ps`), with a Python process listening
    /// on `127.0.0.1:8085` and `[::1]:8086`.
    const PROC_NET_TCP: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode                                                     
   0: 0100007F:1F95 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 11838614 1 0000000018bf0821 100 0 0 10 0                  
";
    const PROC_NET_TCP6: &str = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1F96 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 11838615 1 00000000457ef864 100 0 0 10 0
";
    /// `/proc/7/stat` of a `sh` whose parent is pid 1, same container.
    const PROC_STAT: &str = "7 (sh) S 1 1 1 0 -1 4194304 88 0 0 0 0 0 0 0 20 0 1 0 64715938 2473984 329 18446744073709551615 187650708471808 187650708599020 281474406712544 0 0 0 0 6 65536 1 0 0 17 2 0 0 0 0 0 187650708663136 187650708668944 187651116544000 281474406715074 281474406715088 281474406715088 281474406715372 0\n";

    #[test]
    fn proc_names_the_listening_sockets_and_a_parent_without_lsof_or_ps() {
        assert_eq!(listening_inodes(PROC_NET_TCP, 8085), [11838614]);
        assert_eq!(listening_inodes(PROC_NET_TCP6, 8086), [11838615]);
        assert_eq!(listening_inodes(PROC_NET_TCP, 8086), Vec::<u64>::new());
        assert_eq!(parent_in_stat(PROC_STAT), Some(1));
        assert_eq!(parent_in_stat("42 (a) b (c) S 17 42 42"), Some(17));
    }

    #[test]
    fn only_the_calling_command_or_its_ancestors_count_as_listening_itself() {
        // gcloud (85399) runs sh (85440), which runs the CLI (85441).
        let lineage = [85441, 85440, 85399];
        assert!(listens_itself(&[85399], &lineage));
        // A database's port, held by an unrelated process.
        assert!(!listens_itself(&[312], &lineage));
    }

    /// Starts `script`, a Python server that prints its port, and gives the
    /// process and the port.
    fn python_server(script: &str) -> (std::process::Child, u16) {
        let mut child = std::process::Command::new("python3")
            .args(["-c", script])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(child.stdout.as_mut().unwrap()),
            &mut line,
        )
        .unwrap();
        (child, line.trim().parse().unwrap())
    }

    /// An HTTP/1.1 callback server, which keeps a connection open after
    /// its answer unless the request asks it to close, as Node's and Go's do.
    const KEEP_ALIVE_SERVER: &str = r#"
import http.server
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def do_GET(self):
        body = b"You are now authenticated"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
print(srv.server_address[1], flush=True)
srv.serve_forever()
"#;

    #[tokio::test]
    async fn a_command_that_keeps_its_connection_open_answers_at_once() {
        let (mut server, port) = python_server(KEEP_ALIVE_SERVER);
        // As a browser sends it.
        let request =
            b"GET /?code=4 HTTP/1.1\r\nHost: localhost:8085\r\nConnection: keep-alive\r\n\r\n";
        let got = tokio::time::timeout(Duration::from_secs(5), answer(port, request)).await;
        let _ = server.kill();
        let got = got.expect("an answer within 5 s").unwrap();
        let got = String::from_utf8_lossy(&got);
        assert!(got.starts_with("HTTP/1.1 200"), "{got:?}");
        assert!(
            got.ends_with("\r\n\r\nYou are now authenticated"),
            "{got:?}"
        );
    }

    #[tokio::test]
    async fn a_sign_in_that_comes_back_to_ipv6_loopback_is_forwarded_and_answered() {
        // The command listens on [::1] only, as a server bound to
        // `localhost` may.
        let (mut server, port) = python_server(&KEEP_ALIVE_SERVER.replace(
            "srv = http.server.HTTPServer((\"127.0.0.1\", 0), H)",
            "import socket\nhttp.server.HTTPServer.address_family = socket.AF_INET6\nsrv = http.server.HTTPServer((\"::1\", 0), H)",
        ));
        let request = b"GET /?code=4 HTTP/1.1\r\nHost: [::1]\r\n\r\n";
        let got = answer(port, request).await;
        let _ = server.kill();
        let got = String::from_utf8_lossy(&got.unwrap()).to_string();
        assert!(got.ends_with("You are now authenticated"), "{got:?}");
        // The browser goes back to [::1] on the Mac: the forward is there.
        let free = std::net::TcpListener::bind("[::1]:0").unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);
        let pass: Pass = std::sync::Arc::new(|_| {
            Box::pin(async { Ok(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec()) })
        });
        forward(port, pass).await.unwrap();
        let mut s = tokio::net::TcpStream::connect(("::1", port)).await.unwrap();
        s.write_all(b"GET /?code=4 HTTP/1.1\r\nHost: [::1]\r\n\r\n")
            .await
            .unwrap();
        let mut got = String::new();
        tokio::time::timeout(Duration::from_secs(5), s.read_to_string(&mut got))
            .await
            .unwrap()
            .unwrap();
        assert!(got.ends_with("\r\n\r\nok"), "{got:?}");
    }

    #[tokio::test]
    async fn a_callback_is_registered_only_for_a_port_the_calling_command_listens_on() {
        // This test process listens, and asks as itself, below a daemon
        // that is not one of its ancestors.
        let mine = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = mine.local_addr().unwrap().port();
        let url =
            format!("https://id.example.test/auth?redirect_uri=http%3A%2F%2Flocalhost%3A{port}%2F");
        let callbacks = Callbacks::default();
        let me = std::process::id();
        assert_eq!(callbacks.register_below(&url, me, 0).await, Some(port));
        assert!(callbacks.waiting(port).await);
        // A port another process holds gets none.
        let mut other = std::process::Command::new("python3")
            .args(["-c", "import socket,time;s=socket.socket();s.bind(('127.0.0.1',0));s.listen();print(s.getsockname()[1],flush=True);time.sleep(30)"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(other.stdout.as_mut().unwrap()),
            &mut line,
        )
        .unwrap();
        let theirs: u16 = line.trim().parse().unwrap();
        let url = format!(
            "https://id.example.test/auth?redirect_uri=http%3A%2F%2Flocalhost%3A{theirs}%2F"
        );
        assert_eq!(callbacks.register_below(&url, me, 0).await, None);
        // Nor does a port of the daemon's own.
        let url =
            format!("https://id.example.test/auth?redirect_uri=http%3A%2F%2Flocalhost%3A{port}%2F");
        assert_eq!(
            Callbacks::default().register_below(&url, me, me).await,
            None
        );
        let _ = other.kill();
        // Once nothing listens, it waits no more.
        drop(mine);
        assert!(!callbacks.waiting(port).await);
    }
}
