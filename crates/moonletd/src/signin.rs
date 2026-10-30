//! Sign-ins that come back to localhost (X75). When a command on a member
//! opens a sign-in whose `redirect_uri` is a loopback port it listens on
//! itself, the member registers a **callback** for that port. The Mac whose
//! app opens the URL listens on its own `127.0.0.1:<port>`, and passes each
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
pub fn listeners(lsof: &str) -> Vec<u32> {
    lsof.lines()
        .filter_map(|l| l.strip_prefix('p'))
        .filter_map(|p| p.trim().parse().ok())
        .collect()
}

/// The pids listening on TCP port `port` on this machine.
async fn listening(port: u16) -> Vec<u32> {
    let out = tokio::process::Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fpn"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await;
    out.map(|o| listeners(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

/// The parent of `pid`, from `ps`.
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

/// Hands `request` to this machine's `127.0.0.1:<port>` and gives what it
/// answered, until it closes the connection.
pub async fn answer(port: u16, request: &[u8]) -> Result<Vec<u8>> {
    let run = async {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .with_context(|| format!("nothing answers on port {port}"))?;
        s.write_all(request).await?;
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

/// Listens on this Mac's `127.0.0.1:<port>` for [`LIFETIME`], passing each
/// request to `pass`, until it answers `gone` (the command stopped
/// listening). An error when the port is taken here.
pub async fn forward(port: u16, pass: Pass) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    tokio::spawn(async move {
        let end = Instant::now() + LIFETIME;
        loop {
            let left = end.saturating_duration_since(Instant::now());
            let Ok(Ok((mut stream, _))) = tokio::time::timeout(left, listener.accept()).await
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

    #[test]
    fn only_the_calling_command_or_its_ancestors_count_as_listening_itself() {
        // gcloud (85399) runs sh (85440), which runs the CLI (85441).
        let lineage = [85441, 85440, 85399];
        assert!(listens_itself(&[85399], &lineage));
        // A database's port, held by an unrelated process.
        assert!(!listens_itself(&[312], &lineage));
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
