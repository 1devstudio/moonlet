//! What the daemon's end-to-end tests share: scratch daemons and raw
//! tailnet connections. Each test file uses part of it.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::{Frame, Message};
use serde_json::{Value, json};

/// A scratch `moonletd` with its own home, killed when dropped.
pub struct Daemon {
    pub home: tempfile::TempDir,
    pub socket: PathBuf,
    pub env: Vec<(String, String)>,
    pub child: Child,
    /// The `moonletd` it runs.
    pub exe: PathBuf,
}

fn spawn(exe: &Path, home: &Path, socket: &Path, env: &[(String, String)]) -> Child {
    Command::new(exe)
        .arg("daemon")
        .env("MOONLET_HOME", home)
        .env("MOONLET_SOCK", socket)
        // This test counts as the app when it sends the credential (X75).
        .env("MOONLET_TEST_APP_EXE", std::env::current_exe().unwrap())
        .env("MOONLET_EXIT_WITH", std::process::id().to_string())
        // Never the real `tailscale` (X39); a test may name a stub.
        .env("MOONLET_TAILSCALE", "/nonexistent/tailscale")
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

impl Daemon {
    pub async fn start(home: tempfile::TempDir, env: &[(&str, &str)]) -> Daemon {
        Daemon::start_from(Path::new(env!("CARGO_BIN_EXE_moonletd")), home, env).await
    }

    /// [`Self::start`] with the `moonletd` at `exe`, such as a copy of the
    /// built one where an installed daemon would be.
    pub async fn start_from(exe: &Path, home: tempfile::TempDir, env: &[(&str, &str)]) -> Daemon {
        let socket = home.path().join("run").join("d.sock");
        let env: Vec<(String, String)> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let child = spawn(exe, home.path(), &socket, &env);
        wait_for_socket(&socket, Duration::from_secs(15))
            .await
            .unwrap();
        Daemon {
            home,
            socket,
            env,
            child,
            exe: exe.to_path_buf(),
        }
    }

    /// Stops the daemon; [`Self::restart`] starts it again.
    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// Stops the daemon and starts it again on the same home.
    pub async fn restart(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
        self.child = spawn(&self.exe, self.home.path(), &self.socket, &self.env);
        wait_for_socket(&self.socket, Duration::from_secs(15))
            .await
            .unwrap();
    }

    /// This Mac's app: it sends the credential its daemon wrote (X75).
    pub async fn app(&self) -> Client {
        Client::connect_app(&self.socket, self.home.path())
            .await
            .unwrap()
    }

    pub async fn call<T: serde::de::DeserializeOwned>(&self, method: &str, params: Value) -> T {
        self.app().await.request(method, params).await.unwrap()
    }

    /// [`Self::call`], giving the daemon's error instead of panicking.
    pub async fn try_call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.app()
            .await
            .request::<Value, Value>(method, params)
            .await
            .map_err(|e| e.to_string())
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A port nothing listens on yet, so a restarted daemon keeps its address.
pub fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// A connection by hand to a tailnet listener: authenticated with `token`,
/// saying hello as `client`.
pub async fn raw(addr: &str, token: &str, client: &str) -> tokio::net::TcpStream {
    use moonlet_proto::{read_frame, write_frame};
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let auth = Message::Auth {
        token: Some(token.into()),
        pair: None,
        device: None,
        route: None,
        kind: None,
    };
    write_frame(&mut s, &Frame::Json(auth)).await.unwrap();
    assert!(matches!(
        read_frame(&mut s).await.unwrap(),
        Some(Frame::Json(Message::Authed { .. }))
    ));
    let hello = Message::Hello {
        protocol: moonlet_proto::PROTOCOL_VERSION,
        client: client.into(),
        app_token: None,
    };
    write_frame(&mut s, &Frame::Json(hello)).await.unwrap();
    assert!(matches!(
        read_frame(&mut s).await.unwrap(),
        Some(Frame::Json(Message::Welcome { .. }))
    ));
    s
}

/// Puts `token` for studio-mini at `addr` in the host list of the app
/// whose home is `home` (X57), as the app keeps the token it paired with
/// before it hands it to its daemon's link (X41).
pub fn keep_in_app_hosts(home: &Path, addr: &str, token: &str) {
    std::fs::write(
        home.join("app-hosts.json"),
        json!({ "remotes": [], "tailnet": [{ "id": "studio-mini", "device_id": "d1", "addrs": [addr], "token": token }] })
            .to_string(),
    )
    .unwrap();
}

/// What a worker's daemon sends to register as `id`.
pub fn registration(id: &str, name: &str) -> Value {
    json!({ "id": id, "name": name, "os": "macos", "arch": "arm64", "cores": 10, "version": "0.1.32", "projects": [] })
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Waits up to `limit` for `get` to give a value; returns it.
pub async fn within_value<T, F, Fut>(limit: Duration, what: &str, mut get: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let start = Instant::now();
    while start.elapsed() < limit {
        if let Some(v) = get().await {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{what} did not happen within {limit:?}");
}

/// Waits up to `limit` for `ok`; returns how long it took.
pub async fn within<F, Fut>(limit: Duration, what: &str, mut ok: F) -> Duration
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let start = Instant::now();
    while start.elapsed() < limit {
        if ok().await {
            return start.elapsed();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{what} did not happen within {limit:?}");
}

/// Writes a change to record `id` of `kind` into `d`'s own account log,
/// as any process of the user's on that member could while its daemon is
/// stopped, then starts the daemon again: a change its app never asked for,
/// which the daemon sends its central host as its own (X68).
pub async fn write_into_own_log(d: &mut Daemon, kind: &str, id: &str, field: &str, value: Value) {
    d.stop();
    let path = d.home.path().join("account.json");
    let mut log: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let member = log["member"].as_str().unwrap().to_string();
    let seq = log["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["stamp"]["member"] == json!(member))
        .filter_map(|c| c["seq"].as_u64())
        .max()
        .unwrap_or(0)
        + 1;
    log["changes"].as_array_mut().unwrap().push(json!({
        "stamp": { "ms": now_ms(), "n": 0, "member": member },
        "seq": seq,
        "kind": kind,
        "id": id,
        "op": { "set": { "field": field, "value": value } },
    }));
    std::fs::write(&path, serde_json::to_vec(&log).unwrap()).unwrap();
    d.restart().await;
}
