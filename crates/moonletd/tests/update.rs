//! X69: a host updates itself to the release a Mac asks for. The daemon runs
//! from `<MOONLET_HOME>/bin`, as `install.sh` installs it, and downloads from
//! a fake release server signed with a test key (`MOONLET_RELEASES` and
//! `MOONLET_RELEASE_KEY`, honoured by debug builds only).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::methods::{self, TerminalCreate};
use moonlet_proto::types::{DaemonInfo, TerminalInfo};
use serde_json::{Value, json};
use moonlet_proto::methods::{MobilePairing, MobileStatus};
use moonlet_proto::{Frame, Message, PROTOCOL_VERSION, read_frame, write_frame};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

async fn send(s: &mut TcpStream, m: Message) {
    write_frame(s, &Frame::Json(m)).await.unwrap();
}

async fn next(s: &mut TcpStream) -> Option<Message> {
    loop {
        match tokio::time::timeout(Duration::from_secs(60), read_frame(s)).await.expect("no reply in time") {
            Ok(Some(Frame::Json(m))) => return Some(m),
            Ok(Some(_)) => {}
            _ => return None,
        }
    }
}

/// Asks `daemon.update` on a tailnet connection and returns the reply.
async fn update_over(s: &mut TcpStream, id: u64, version: &str) -> Message {
    send(s, Message::Request { id, method: "daemon.update".into(), params: json!({ "version": version }) }).await;
    loop {
        match next(s).await.expect("connection closed") {
            m @ Message::Response { id: rid, .. } if rid == id => return m,
            _ => {}
        }
    }
}

/// The error code and message of a failed request.
fn refused(m: &Message) -> (String, String) {
    match m {
        Message::Response { error: Some(e), .. } => (e.code.clone(), e.message.clone()),
        other => panic!("expected an error, got {other:?}"),
    }
}

/// What the fake `moonlet` CLI in the release prints, so the test can tell
/// the installed file came from the archive.
const NEW_CLI: &[u8] = b"#!/bin/sh\necho moonlet 9.9.9\n";

fn b64(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(s)
}

/// A key pair, as Tauri's signer writes them: base64 of minisign's text.
struct Key {
    pk: minisign::PublicKey,
    sk: minisign::SecretKey,
}

impl Key {
    fn new() -> Key {
        let minisign::KeyPair { pk, sk } = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        Key { pk, sk }
    }

    fn public(&self) -> String {
        b64(&self.pk.to_box().unwrap().into_string())
    }

    fn sign(&self, data: &[u8]) -> Vec<u8> {
        let sig = minisign::sign(Some(&self.pk), &self.sk, data, None, None).unwrap();
        b64(&sig.into_string()).into_bytes()
    }
}

/// `moonlet-<os>-<arch>.tar.gz` holding a `moonletd` that says it is 9.9.9
/// and runs the built daemon otherwise (so the handoff works), and a
/// `moonlet` that says 9.9.9.
fn archive() -> Vec<u8> {
    tgz(&daemon_saying("9.9.9"))
}

/// A `moonletd` whose `--version` says `version`.
fn daemon_saying(version: &str) -> Vec<u8> {
    format!(
        "#!/bin/sh\n[ \"$1\" = --version ] && {{ echo \"moonletd {version}\"; exit 0; }}\nexec '{}' \"$@\"\n",
        env!("CARGO_BIN_EXE_moonletd")
    )
    .into_bytes()
}

fn tgz(daemon: &[u8]) -> Vec<u8> {
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut tar = tar::Builder::new(gz);
    for (name, data) in [("moonletd", daemon), ("moonlet", NEW_CLI)] {
        let mut h = tar::Header::new_gnu();
        h.set_size(data.len() as u64);
        h.set_mode(0o755);
        h.set_cksum();
        tar.append_data(&mut h, name, data).unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap()
}

fn asset() -> String {
    format!("moonlet-{}-{}.tar.gz", std::env::consts::OS, std::env::consts::ARCH)
}

/// Serves `files` by path over plain HTTP, each after `delay`; anything
/// else is a 404.
async fn release_server(files: HashMap<String, Vec<u8>>, delay: Duration) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let files = Arc::new(files);
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else { return };
            let files = files.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match s.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&buf).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                tokio::time::sleep(delay).await;
                let (status, body) = match files.get(&path) {
                    Some(b) => ("200 OK", b.clone()),
                    None => ("404 Not Found", b"Not Found".to_vec()),
                };
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(reply.as_bytes()).await;
                let _ = s.write_all(&body).await;
            });
        }
    });
    format!("http://{addr}")
}

/// A release `v9.9.9` with the archive for this machine, signed by `key`.
async fn release(key: &Key) -> String {
    release_after(key, Duration::ZERO).await
}

async fn release_after(key: &Key, delay: Duration) -> String {
    let data = archive();
    let sig = key.sign(&data);
    let a = asset();
    release_server(
        HashMap::from([
            (format!("/v9.9.9/{a}"), data),
            (format!("/v9.9.9/{a}.sig"), sig),
        ]),
        delay,
    )
    .await
}

/// A daemon run from `<home>/bin/moonletd`, a copy of the built one.
struct Host {
    home: tempfile::TempDir,
    socket: PathBuf,
    child: Child,
}

impl Host {
    async fn start(releases: &str, key: &Key) -> Host {
        Host::start_from(releases, key, true).await
    }

    /// With `installed`, the daemon runs from `<home>/bin`; without, from
    /// the build folder, where it cannot update itself.
    async fn start_from(releases: &str, key: &Key, installed: bool) -> Host {
        let home = tempfile::tempdir().unwrap();
        let built = Path::new(env!("CARGO_BIN_EXE_moonletd"));
        let exe = if installed {
            let bin = home.path().join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::copy(built, bin.join("moonletd")).unwrap();
            std::fs::copy(built.with_file_name("moonlet"), bin.join("moonlet")).unwrap();
            bin.join("moonletd")
        } else {
            built.to_path_buf()
        };
        std::fs::write(home.path().join("mobile.json"), r#"{ "enabled": true, "port": 0 }"#).unwrap();
        let socket = home.path().join("run").join("d.sock");
        let child = Command::new(exe)
            .arg("daemon")
            .env("MOONLET_HOME", home.path())
            .env("MOONLET_SOCK", &socket)
            .env("MOONLET_MOBILE_ADDRS", "127.0.0.1")
            .env("MOONLET_RELEASES", releases)
            .env("MOONLET_RELEASE_KEY", key.public())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        wait_for_socket(&socket, Duration::from_secs(15)).await.unwrap();
        Host { home, socket, child }
    }

    async fn app(&self) -> Client {
        Client::connect(&self.socket, "moonlet-app").await.unwrap()
    }

    /// Pairs a device of `kind` over the tailnet listener and returns a
    /// connection past `hello`.
    async fn paired(&self, kind: &str) -> TcpStream {
        let mut app = self.app().await;
        let mut addr = None;
        for _ in 0..100 {
            let st: MobileStatus = app.request("mobile.status", json!({})).await.unwrap();
            if let Some(a) = st.listening.first() {
                addr = Some(a.clone());
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let addr = addr.expect("the daemon never listened");
        let p: MobilePairing = app.request("mobile.pair_start", json!({ "kind": kind })).await.unwrap();
        let mut s = TcpStream::connect(&addr).await.unwrap();
        send(&mut s, Message::Auth { token: None, pair: Some(p.code), device: Some(format!("a {kind}")), route: None, kind: Some(serde_json::from_value(json!(kind)).unwrap()) }).await;
        assert!(matches!(next(&mut s).await, Some(Message::Authed { .. })));
        let client = if kind == "phone" { "moonlet-mobile" } else { "moonlet-app" };
        send(&mut s, Message::Hello { protocol: PROTOCOL_VERSION, client: client.into() }).await;
        assert!(matches!(next(&mut s).await, Some(Message::Welcome { .. })));
        s
    }

    async fn pid(&self) -> u32 {
        let info: DaemonInfo = self.app().await.request(methods::DAEMON_INFO, ()).await.unwrap();
        info.pid
    }

    /// Waits for a daemon other than `pid` to answer, and returns it.
    async fn next_daemon(&self, pid: u32) -> DaemonInfo {
        for _ in 0..300 {
            if let Ok(mut c) = Client::connect(&self.socket, "test").await
                && let Ok(info) = c.request::<_, DaemonInfo>(methods::DAEMON_INFO, ()).await
                && info.pid != pid
            {
                return info;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("no new daemon after the update");
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // The daemon that took over is not our child.
        if let Ok(pid) = std::fs::read_to_string(self.socket.with_file_name("d.pid")) {
            let _ = Command::new("kill").arg(pid.trim()).stderr(Stdio::null()).status();
        }
    }
}

#[tokio::test]
async fn the_app_updates_its_host_and_every_session_carries_on() {
    let key = Key::new();
    let releases = release(&key).await;
    let host = Host::start(&releases, &key).await;
    let mut app = host.app().await;
    let before: DaemonInfo = app.request(methods::DAEMON_INFO, ()).await.unwrap();
    let session: TerminalInfo = app
        .request(
            methods::TERMINAL_CREATE,
            TerminalCreate {
                cwd: host.home.path().display().to_string(),
                command: vec!["/bin/sleep".into(), "600".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();

    let reply: Value = app.request("daemon.update", json!({ "version": "9.9.9" })).await.unwrap();
    assert_eq!(reply, json!({ "from": env!("CARGO_PKG_VERSION"), "to": "9.9.9" }));

    let after = host.next_daemon(before.pid).await;
    assert_ne!(after.pid, before.pid);
    let mut c = Client::connect(&host.socket, "test").await.unwrap();
    let list: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    let same = list.iter().find(|t| t.id == session.id).expect("the session is still there");
    assert_eq!(same.pid, session.pid);
    assert!(same.exit.is_none());
    assert_eq!(std::fs::read(host.home.path().join("bin/moonlet")).unwrap(), NEW_CLI);
}

#[tokio::test]
async fn a_paired_mac_may_update_its_host_but_a_phone_and_an_agent_may_not() {
    let key = Key::new();
    let releases = release(&key).await;
    let host = Host::start(&releases, &key).await;
    let pid = host.pid().await;

    let mut phone = host.paired("phone").await;
    assert_eq!(refused(&update_over(&mut phone, 1, "9.9.9").await), ("forbidden".into(), "update moonlet from a Mac".into()));
    let mut cli = Client::connect(&host.socket, "moonlet-cli").await.unwrap();
    let e = cli.request::<_, Value>("daemon.update", json!({ "version": "9.9.9" })).await.unwrap_err();
    assert_eq!(e.to_string(), "forbidden: update moonlet from the app");
    // Nor a worker's link (X41), which a linked host's daemon opens.
    let mut worker = Client::connect(&host.socket, "moonletd-worker").await.unwrap();
    let e = worker.request::<_, Value>("daemon.update", json!({ "version": "9.9.9" })).await.unwrap_err();
    assert_eq!(e.to_string(), "forbidden: update moonlet from the app");
    assert_eq!(host.pid().await, pid);

    let mut mac = host.paired("desktop").await;
    let reply = update_over(&mut mac, 2, "9.9.9").await;
    let Message::Response { result: Some(r), error: None, .. } = reply else { panic!("{reply:?}") };
    assert_eq!(r, json!({ "from": env!("CARGO_PKG_VERSION"), "to": "9.9.9" }));
    host.next_daemon(pid).await;
}

#[tokio::test]
async fn an_update_that_cannot_be_trusted_or_found_changes_nothing() {
    let key = Key::new();
    let data = archive();
    let a = asset();
    // Signed by another key.
    let releases = release_server(
        HashMap::from([(format!("/v9.9.9/{a}"), data.clone()), (format!("/v9.9.9/{a}.sig"), Key::new().sign(&data))]),
        Duration::ZERO,
    )
    .await;
    let host = Host::start(&releases, &key).await;
    let pid = host.pid().await;
    let installed = std::fs::read(host.home.path().join("bin/moonletd")).unwrap();
    let mut app = host.app().await;
    let mut ask = async |v: &str| app.request::<_, Value>("daemon.update", json!({ "version": v })).await.unwrap_err().to_string();

    assert_eq!(ask("9.9.9").await, "bad_signature: the release's signature does not match moonlet's key");
    assert!(ask("9.9.8").await.starts_with(&format!("download_failed: {releases}/v9.9.8/{a}.sig: 404")), "{}", ask("9.9.8").await);
    assert_eq!(ask("0.0.1").await, format!("not_newer: moonlet {} is not older than 0.0.1", env!("CARGO_PKG_VERSION")));
    assert_eq!(ask("latest").await, "invalid_params: not a version: latest");

    assert_eq!(std::fs::read(host.home.path().join("bin/moonletd")).unwrap(), installed);
    let mut left: Vec<String> = std::fs::read_dir(host.home.path().join("bin"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into())
        .collect();
    left.sort();
    assert_eq!(left, ["moonlet", "moonletd"]);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(host.pid().await, pid);
}

#[tokio::test]
async fn a_daemon_run_from_elsewhere_does_not_update_itself() {
    let key = Key::new();
    let releases = release(&key).await;
    let host = Host::start_from(&releases, &key, false).await;
    let e = host.app().await.request::<_, Value>("daemon.update", json!({ "version": "9.9.9" })).await.unwrap_err();
    assert!(e.to_string().starts_with("unsupported: moonletd runs from "), "{e}");
}

#[tokio::test]
async fn one_update_at_a_time() {
    let key = Key::new();
    let releases = release_after(&key, Duration::from_secs(2)).await;
    let host = Host::start(&releases, &key).await;
    let pid = host.pid().await;
    let mut first = host.app().await;
    let first = tokio::spawn(async move { first.request::<_, Value>("daemon.update", json!({ "version": "9.9.9" })).await });
    tokio::time::sleep(Duration::from_millis(500)).await;
    let e = host.app().await.request::<_, Value>("daemon.update", json!({ "version": "9.9.9" })).await.unwrap_err();
    assert_eq!(e.to_string(), "busy: an update or upgrade is already in progress");
    assert!(first.await.unwrap().is_ok());
    host.next_daemon(pid).await;
}

/// A release signed with moonlet's key but holding another version (an old
/// release served under a new tag) is refused.
#[tokio::test]
async fn a_signed_release_of_another_version_is_refused() {
    let key = Key::new();
    let old = tgz(&daemon_saying(env!("CARGO_PKG_VERSION")));
    let a = asset();
    let releases = release_server(
        HashMap::from([(format!("/v9.9.9/{a}"), old.clone()), (format!("/v9.9.9/{a}.sig"), key.sign(&old))]),
        Duration::ZERO,
    )
    .await;
    let host = Host::start(&releases, &key).await;
    let pid = host.pid().await;
    let installed = std::fs::read(host.home.path().join("bin/moonletd")).unwrap();
    let e = host.app().await.request::<_, Value>("daemon.update", json!({ "version": "9.9.9" })).await.unwrap_err();
    assert_eq!(
        e.to_string(),
        format!("install_failed: the release holds moonletd {}, not 9.9.9", env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(std::fs::read(host.home.path().join("bin/moonletd")).unwrap(), installed);
    let mut left: Vec<String> = std::fs::read_dir(host.home.path().join("bin"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into())
        .collect();
    left.sort();
    assert_eq!(left, ["moonlet", "moonletd"]);
    assert_eq!(host.pid().await, pid);
}
