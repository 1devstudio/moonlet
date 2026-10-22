//! X41: a Mac's daemon links to its central host as a worker. Two daemons
//! run here: the central host listens on 127.0.0.1 (`MOONLET_MOBILE_ADDRS`)
//! instead of a Tailscale address, and the worker pairs with its code, as
//! the desktop app does.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::methods::{DeviceKind, LinkInfo, LinkState, MobilePairing, WorkerInfo};
use moonlet_proto::{Frame, Message};
use serde_json::{Value, json};

const WORKER_ID: &str = "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37";

struct Daemon {
    home: tempfile::TempDir,
    socket: PathBuf,
    env: Vec<(String, String)>,
    child: Child,
}

impl Daemon {
    async fn start(home: tempfile::TempDir, env: &[(&str, &str)]) -> Daemon {
        let socket = home.path().join("run").join("d.sock");
        let env: Vec<(String, String)> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let child = spawn(home.path(), &socket, &env).await;
        Daemon {
            home,
            socket,
            env,
            child,
        }
    }

    async fn restart(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.child = spawn(self.home.path(), &self.socket, &self.env).await;
    }

    async fn app(&self) -> Client {
        Client::connect(&self.socket, "moonlet-app").await.unwrap()
    }

    async fn call<T: serde::de::DeserializeOwned>(&self, method: &str, params: Value) -> T {
        self.app().await.request(method, params).await.unwrap()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn spawn(home: &Path, socket: &Path, env: &[(String, String)]) -> Child {
    let child = Command::new(env!("CARGO_BIN_EXE_moonletd"))
        .arg("daemon")
        .env("MOONLET_HOME", home)
        .env("MOONLET_SOCK", socket)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    wait_for_socket(&socket.to_path_buf(), Duration::from_secs(15))
        .await
        .unwrap();
    child
}

/// A port nothing listens on yet, so a restarted central host keeps its
/// address.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// The central host `studio-mini`: tailnet access on, pinging every 200 ms.
/// It keeps its port across restarts, so the port is fixed. Another test's
/// daemon can take a free port first, so this waits for its own daemon to
/// listen, and moves to another port if it never does.
async fn central() -> (Daemon, String) {
    for _ in 0..5 {
        let home = tempfile::tempdir().unwrap();
        let port = free_port();
        std::fs::write(
            home.path().join("mobile.json"),
            format!(r#"{{ "enabled": true, "port": {port} }}"#),
        )
        .unwrap();
        let d = Daemon::start(
            home,
            &[
                ("MOONLET_MOBILE_ADDRS", "127.0.0.1"),
                ("MOONLET_WORKER_PING_MS", "200"),
            ],
        )
        .await;
        let addr = format!("127.0.0.1:{port}");
        for _ in 0..40 {
            let st: Value = d.call("mobile.status", json!({})).await;
            if st["listening"].as_array().is_some_and(|l| l.contains(&json!(addr))) {
                return (d, addr);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    panic!("the central host never listened");
}

/// A worker daemon with a fixed worker id. Its own "Tailscale address" is
/// 127.0.0.2, so linking to 127.0.0.1 is not linking to itself.
async fn worker(id: &str, name: &str) -> Daemon {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("link.json"),
        json!({ "central": null, "worker": { "id": id, "name": name, "enabled": false } })
            .to_string(),
    )
    .unwrap();
    Daemon::start(home, &[("MOONLET_MOBILE_ADDRS", "127.0.0.2")]).await
}

/// Pairs as a desktop with a fresh code from `central`; returns the token.
async fn pair(central: &Daemon, addr: &str, device: &str) -> String {
    let p: MobilePairing = central.call("mobile.pair_start", json!({})).await;
    moonlet_link::tailnet::pair(&[addr.to_string()], &p.code, device, DeviceKind::Desktop)
        .await
        .unwrap()
        .token
}

/// Points `worker` at `central` and turns the link on.
async fn link(worker: &Daemon, addr: &str, token: &str) -> LinkInfo {
    worker
        .call(
            "link.set",
            json!({
                "central": { "name": "studio-mini", "addrs": [addr], "token": token },
                "worker": { "enabled": true },
            }),
        )
        .await
}

async fn eventually<F, Fut>(what: &str, mut ok: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        if ok().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{what} never happened");
}

async fn workers(central: &Daemon) -> Vec<WorkerInfo> {
    central.call("worker.list", json!({})).await
}

/// Waits for the next event called `name` on `c`.
async fn next_event(c: &mut Client, name: &str) -> Value {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(15), c.next_frame())
            .await
            .unwrap_or_else(|_| panic!("no {name} event"))
            .unwrap()
            .expect("the daemon closed the connection");
        if let Frame::Json(Message::Event { name: n, data }) = frame
            && n == name
        {
            return data;
        }
    }
}

/// A scratch repository whose origin URL carries a token, with a fixed
/// root commit.
fn shop_repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ],
        &[
            "remote",
            "add",
            "origin",
            "https://user:token@github.com/acme/shop.git",
        ],
    ] {
        let ok = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_DATE", "2026-10-21T12:00:00Z")
            .env("GIT_COMMITTER_DATE", "2026-10-21T12:00:00Z")
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }
}

#[tokio::test]
async fn a_linked_worker_is_listed_on_the_central_host_with_its_projects() {
    let (central, addr) = central().await;
    let worker = worker(WORKER_ID, "Alex's MacBook Pro").await;
    let repo = worker.home.path().join("shop");
    shop_repo(&repo);
    let _: Value = worker.call("project.add", json!({ "path": repo })).await;
    let token = pair(&central, &addr, "Alex's MacBook Pro").await;

    let mut events = worker.app().await;
    link(&worker, &addr, &token).await;
    loop {
        let info: LinkInfo =
            serde_json::from_value(next_event(&mut events, "link.changed").await).unwrap();
        if matches!(info.state, LinkState::Connected { .. }) {
            break;
        }
    }
    let got: LinkInfo = worker.call("link.get", json!({})).await;
    assert!(matches!(got.state, LinkState::Connected { .. }), "{got:?}");
    assert_eq!(got.central.unwrap().name, "studio-mini");

    eventually("the worker is listed with a round trip", || async {
        workers(&central)
            .await
            .first()
            .is_some_and(|w| w.rtt_ms.is_some())
    })
    .await;
    let list: Value = central.call("worker.list", json!({})).await;
    assert!(!list.to_string().contains("token"), "{list}");
    let w = &serde_json::from_value::<Vec<WorkerInfo>>(list).unwrap()[0];
    assert_eq!(w.worker.id, WORKER_ID);
    assert_eq!(w.worker.name, "Alex's MacBook Pro");
    assert_eq!(
        w.worker.os,
        if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        }
    );
    assert_eq!(
        w.worker.arch,
        if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x86_64"
        }
    );
    assert!(w.worker.cores >= 1);
    assert_eq!(w.worker.version, env!("CARGO_PKG_VERSION"));
    let projects: Vec<(Option<&str>, Option<&str>)> = w
        .worker
        .projects
        .iter()
        .map(|p| (p.identity.origin.as_deref(), p.identity.root.as_deref()))
        .collect();
    assert_eq!(
        projects,
        [(
            Some("github.com/acme/shop"),
            Some("5af9891b3892ce4e1d3fd498c75b6aaf1b27d96a")
        )]
    );
}

/// Links a fresh worker to `central` and waits until it is listed.
async fn linked_worker(central: &Daemon, addr: &str) -> Daemon {
    let worker = worker(WORKER_ID, "Alex's MacBook Pro").await;
    let token = pair(central, addr, "Alex's MacBook Pro").await;
    link(&worker, addr, &token).await;
    eventually("the worker is listed", || async {
        workers(central).await.len() == 1
    })
    .await;
    worker
}

#[tokio::test]
async fn a_worker_that_stops_answering_pings_is_dropped() {
    let (central, addr) = central().await;
    let worker = linked_worker(&central, &addr).await;
    // A closed lid: the process stops, its connection stays open.
    let pid = nix::unistd::Pid::from_raw(worker.child.id() as i32);
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGSTOP).unwrap();
    let stopped = Instant::now();
    eventually("the worker is dropped", || async {
        workers(&central).await.is_empty()
    })
    .await;
    // Three pings 200 ms apart, each given 200 ms to answer.
    assert!(
        stopped.elapsed() >= Duration::from_millis(400),
        "dropped after {:?}",
        stopped.elapsed()
    );
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGCONT).unwrap();
    // Awake again, it links again without help.
    eventually("the worker is back", || async {
        workers(&central).await.len() == 1
    })
    .await;
}

#[tokio::test]
async fn turning_the_link_off_drops_the_worker_at_once_and_a_restarted_central_host_gets_it_back() {
    let (mut central, addr) = central().await;
    let worker = linked_worker(&central, &addr).await;
    let mut events = central.app().await;

    let off = Instant::now();
    let info: LinkInfo = worker
        .call("link.set", json!({ "worker": { "enabled": false } }))
        .await;
    assert_eq!(info.state, LinkState::Off);
    let list: Vec<WorkerInfo> =
        serde_json::from_value(next_event(&mut events, "workers.changed").await).unwrap();
    assert!(list.is_empty());
    assert!(
        off.elapsed() < Duration::from_secs(1),
        "closed after {:?}",
        off.elapsed()
    );

    let _: LinkInfo = worker
        .call("link.set", json!({ "worker": { "enabled": true } }))
        .await;
    eventually("the worker is back", || async {
        workers(&central).await.len() == 1
    })
    .await;

    central.restart().await;
    eventually("the worker links to the restarted central host", || async {
        workers(&central).await.len() == 1
    })
    .await;
}

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// A central host that answers every `auth` with protocol 99 and moonletd
/// 9.9.9; returns its address and how many times it was reached.
async fn newer_central() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let reached = std::sync::Arc::new(AtomicUsize::new(0));
    let count = reached.clone();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = listener.accept().await.unwrap();
            count.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let _ = moonlet_proto::read_frame(&mut s).await;
                let authed = Message::Authed {
                    device_id: "d1".into(),
                    token: None,
                    protocol: Some(99),
                    daemon_version: Some("9.9.9".into()),
                    host: Some("studio-mini".into()),
                    os: Some("macos".into()),
                };
                let _ = moonlet_proto::write_frame(&mut s, &Frame::Json(authed)).await;
                tokio::time::sleep(Duration::from_secs(30)).await;
            });
        }
    });
    (addr, reached)
}

async fn link_state(worker: &Daemon) -> LinkState {
    worker.call::<LinkInfo>("link.get", json!({})).await.state
}

#[tokio::test]
async fn a_central_host_on_another_protocol_needs_an_update_and_waits_for_a_retry() {
    use std::sync::atomic::Ordering;
    let (addr, reached) = newer_central().await;
    let worker = worker(WORKER_ID, "Alex's MacBook Pro").await;
    link(&worker, &addr, TOKEN).await;
    let want = LinkState::NeedsUpdate {
        daemon_version: "9.9.9".into(),
    };
    eventually("needs_update", || async {
        link_state(&worker).await == want
    })
    .await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(reached.load(Ordering::SeqCst), 1, "it retried by itself");
    let _: LinkInfo = worker.call("link.retry", json!({})).await;
    eventually("a retry", || async { reached.load(Ordering::SeqCst) == 2 }).await;
    // Changing the settings tries again too.
    let _: LinkInfo = worker
        .call("link.set", json!({ "worker": { "name": "Work laptop" } }))
        .await;
    eventually("a retry on link.set", || async {
        reached.load(Ordering::SeqCst) == 3
    })
    .await;
}

#[tokio::test]
async fn a_mac_the_central_host_removed_says_so_and_waits_for_a_retry() {
    let (central, addr) = central().await;
    let worker = linked_worker(&central, &addr).await;
    let status: moonlet_proto::methods::MobileStatus =
        central.call("mobile.status", json!({})).await;
    let device = status
        .devices
        .iter()
        .find(|d| d.name == "Alex's MacBook Pro")
        .unwrap()
        .id
        .clone();
    let _: Value = central.call("mobile.revoke", json!({ "id": device })).await;
    let want = LinkState::Refused;
    eventually("refused", || async { link_state(&worker).await == want }).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(link_state(&worker).await, want, "it retried by itself");
}

/// A worker by hand: authenticated with `token`, hello as `client`.
async fn raw(addr: &str, token: &str, client: &str) -> tokio::net::TcpStream {
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
    };
    write_frame(&mut s, &Frame::Json(hello)).await.unwrap();
    assert!(matches!(
        read_frame(&mut s).await.unwrap(),
        Some(Frame::Json(Message::Welcome { .. }))
    ));
    s
}

fn registration(id: &str, name: &str) -> Value {
    json!({ "id": id, "name": name, "os": "macos", "arch": "arm64", "cores": 10, "version": "0.1.28", "projects": [] })
}

/// Sends request `id` and returns its reply; answers the central host's
/// own requests on the way. `None` when the connection closed.
async fn ask(
    s: &mut tokio::net::TcpStream,
    id: u64,
    method: &str,
    params: Value,
) -> Option<Message> {
    use moonlet_proto::{read_frame, write_frame};
    let req = Message::Request {
        id,
        method: method.into(),
        params,
    };
    write_frame(s, &Frame::Json(req)).await.ok()?;
    loop {
        match tokio::time::timeout(Duration::from_secs(10), read_frame(s))
            .await
            .expect("no reply")
        {
            Ok(Some(Frame::Json(m @ Message::Response { id: rid, .. }))) if rid == id => {
                return Some(m);
            }
            Ok(Some(Frame::Json(Message::Request { id: rid, .. }))) => {
                write_frame(s, &Frame::Json(Message::ok(rid, json!({}))))
                    .await
                    .ok()?;
            }
            Ok(Some(_)) => {}
            _ => return None,
        }
    }
}

fn refused(reply: &Option<Message>) -> Option<String> {
    match reply {
        Some(Message::Response { error: Some(e), .. }) => Some(e.code.clone()),
        _ => None,
    }
}

#[tokio::test]
async fn the_central_hosts_requests_start_at_id_1_and_a_worker_manages_no_devices() {
    use moonlet_proto::read_frame;
    let (central, addr) = central().await;
    let token = pair(&central, &addr, "Alex's MacBook Pro").await;
    let mut w = raw(&addr, &token, "moonletd-worker").await;
    assert_eq!(
        refused(
            &ask(
                &mut w,
                1,
                "worker.register",
                registration(WORKER_ID, "Alex's MacBook Pro")
            )
            .await
        ),
        None
    );
    let first = loop {
        match read_frame(&mut w).await.unwrap() {
            Some(Frame::Json(Message::Request { id, method, .. })) => break (id, method),
            Some(_) => {}
            None => panic!("closed"),
        }
    };
    assert_eq!(first, (1, "worker.ping".to_string()));
    assert_eq!(
        refused(&ask(&mut w, 2, "mobile.status", json!({})).await).as_deref(),
        Some("forbidden")
    );

    // The app's connection with the same token is no worker.
    let mut app = raw(&addr, &token, "moonlet-app").await;
    let other = registration("5b0c7a3e-0d7e-4a51-8f1e-6c2b9a4d3e10", "Fake");
    assert_eq!(
        refused(&ask(&mut app, 1, "worker.register", other).await).as_deref(),
        Some("forbidden")
    );
}

#[tokio::test]
async fn one_connection_links_one_worker() {
    let (central, addr) = central().await;
    let token = pair(&central, &addr, "Alex's MacBook Pro").await;
    let mut w = raw(&addr, &token, "moonletd-worker").await;
    assert_eq!(
        refused(
            &ask(
                &mut w,
                1,
                "worker.register",
                registration(WORKER_ID, "Alex's MacBook Pro")
            )
            .await
        ),
        None
    );
    let other = registration("5b0c7a3e-0d7e-4a51-8f1e-6c2b9a4d3e10", "Another");
    assert_eq!(
        refused(&ask(&mut w, 2, "worker.register", other).await).as_deref(),
        Some("forbidden")
    );
    let list: Vec<Value> = central.call("worker.list", json!({})).await;
    assert_eq!(list.len(), 1, "{list:?}");
}

#[tokio::test]
async fn a_worker_id_links_once_and_names_may_repeat() {
    let (central, addr) = central().await;
    let token = pair(&central, &addr, "Alex's MacBook Pro").await;
    let mut first = raw(&addr, &token, "moonletd-worker").await;
    ask(
        &mut first,
        1,
        "worker.register",
        registration(WORKER_ID, "MacBook Pro"),
    )
    .await
    .unwrap();
    let mut second = raw(&addr, &token, "moonletd-worker").await;
    ask(
        &mut second,
        1,
        "worker.register",
        registration(WORKER_ID, "MacBook Pro"),
    )
    .await
    .unwrap();
    // The older connection is closed.
    assert!(ask(&mut first, 2, "worker.list", json!({})).await.is_none());
    let other = "5b0c7a3e-0d7e-4a51-8f1e-6c2b9a4d3e10";
    let mut third = raw(&addr, &token, "moonletd-worker").await;
    ask(
        &mut third,
        1,
        "worker.register",
        registration(other, "MacBook Pro"),
    )
    .await
    .unwrap();
    let ids: Vec<String> = workers(&central)
        .await
        .into_iter()
        .map(|w| w.worker.id)
        .collect();
    assert_eq!(ids, [other, WORKER_ID]);
}

#[tokio::test]
async fn a_mac_cannot_link_to_itself() {
    let home = tempfile::tempdir().unwrap();
    let mac = Daemon::start(home, &[("MOONLET_MOBILE_ADDRS", "100.101.102.103")]).await;
    let mut app = mac.app().await;
    let e = app
        .request::<_, LinkInfo>(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": ["100.101.102.103:47428"], "token": TOKEN } }),
        )
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "invalid_params: this Mac is the central host"
    );
}

#[tokio::test]
async fn only_the_macs_app_sets_or_retries_the_link() {
    let (central, addr) = central().await;
    let token = pair(&central, &addr, "Alex's MacBook Pro").await;
    let elsewhere = json!({
        "central": { "name": "evil", "addrs": ["100.64.0.9:47428"], "token": "ab".repeat(32) },
        "worker": { "enabled": true }
    });

    // A paired device over the tailnet, phone or desktop.
    let mut device = raw(&addr, &token, "moonlet-app").await;
    assert_eq!(
        refused(&ask(&mut device, 1, "link.set", elsewhere.clone()).await).as_deref(),
        Some("forbidden")
    );
    assert_eq!(
        refused(&ask(&mut device, 2, "link.retry", json!({})).await).as_deref(),
        Some("forbidden")
    );

    // An agent's `moonlet` CLI on the Mac itself.
    let mut cli = Client::connect(&central.socket, "moonlet-cli").await.unwrap();
    let e = cli
        .request::<_, Value>("link.set", elsewhere)
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), "forbidden: only the moonlet app manages the link");
    let e = cli
        .request::<_, Value>("link.retry", json!({}))
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), "forbidden: only the moonlet app manages the link");

    // Nothing changed.
    let info: Value = central.call("link.get", json!({})).await;
    assert_eq!(info["central"], Value::Null, "{info}");
}

#[tokio::test]
async fn only_the_macs_app_starts_or_retries_a_copy() {
    // X60: a copy clones and writes on this Mac, so a paired device or an
    // agent's CLI may only list copies.
    let (central, addr) = central().await;
    let token = pair(&central, &addr, "Alex's MacBook Pro").await;
    let mut device = raw(&addr, &token, "moonlet-app").await;
    let start = json!({ "session": "s1" });
    assert_eq!(
        refused(&ask(&mut device, 1, "sync.start", start.clone()).await).as_deref(),
        Some("forbidden")
    );
    assert_eq!(
        refused(&ask(&mut device, 2, "sync.retry", json!({ "copy": "c1" })).await).as_deref(),
        Some("forbidden")
    );
    let mut cli = Client::connect(&central.socket, "moonlet-cli").await.unwrap();
    let e = cli.request::<_, Value>("sync.start", start).await.unwrap_err();
    assert_eq!(e.to_string(), "forbidden: only the moonlet app manages sync");
    let e = cli
        .request::<_, Value>("sync.retry", json!({ "copy": "c1" }))
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), "forbidden: only the moonlet app manages sync");
    let copies: Value = cli.request("sync.list", json!({})).await.unwrap();
    assert_eq!(copies, json!([]));
}

#[tokio::test]
async fn one_link_set_says_link_changed_once() {
    let (central, addr) = central().await;
    let worker = linked_worker(&central, &addr).await;
    let mut events = worker.app().await;
    let _: LinkInfo = worker.call("link.set", json!({ "central": null })).await;
    let mut changes = Vec::new();
    let quiet = tokio::time::Instant::now() + Duration::from_millis(700);
    while let Ok(Ok(Some(frame))) = tokio::time::timeout_at(quiet, events.next_frame()).await {
        if let Frame::Json(Message::Event { name, data }) = frame
            && name == "link.changed"
        {
            changes.push(data["state"]["kind"].clone());
        }
    }
    assert_eq!(changes, [json!("off")]);
}

#[tokio::test]
async fn another_paired_device_cannot_take_a_workers_id() {
    let (central, addr) = central().await;
    let mac = pair(&central, &addr, "Alex's MacBook Pro").await;
    let phone = pair(&central, &addr, "Alex's iPhone").await;
    let mut real = raw(&addr, &mac, "moonletd-worker").await;
    assert_eq!(
        refused(&ask(&mut real, 1, "worker.register", registration(WORKER_ID, "MacBook Pro")).await),
        None
    );
    let mut impostor = raw(&addr, &phone, "moonletd-worker").await;
    assert_eq!(
        refused(&ask(&mut impostor, 1, "worker.register", registration(WORKER_ID, "MacBook Pro")).await)
            .as_deref(),
        Some("forbidden")
    );
    // The real worker keeps its link.
    assert!(ask(&mut real, 2, "worker.list", json!({})).await.is_some());
}

#[tokio::test]
async fn a_mac_removed_and_paired_again_links_with_its_worker_id() {
    let (central, addr) = central().await;
    let first = pair(&central, &addr, "Alex's MacBook Pro").await;
    let mut old = raw(&addr, &first, "moonletd-worker").await;
    assert_eq!(
        refused(&ask(&mut old, 1, "worker.register", registration(WORKER_ID, "MacBook Pro")).await),
        None
    );
    let status: moonlet_proto::methods::MobileStatus =
        central.call("mobile.status", json!({})).await;
    let device = status
        .devices
        .iter()
        .find(|d| d.name == "Alex's MacBook Pro")
        .unwrap()
        .id
        .clone();
    let _: Value = central.call("mobile.revoke", json!({ "id": device })).await;

    // The same Mac pairs again: a new device, the same worker id.
    let again = pair(&central, &addr, "Alex's MacBook Pro").await;
    let mut new = raw(&addr, &again, "moonletd-worker").await;
    assert_eq!(
        refused(&ask(&mut new, 1, "worker.register", registration(WORKER_ID, "MacBook Pro")).await),
        None
    );
}

#[tokio::test]
async fn a_second_mac_with_the_same_worker_id_says_so_and_waits() {
    let (central, addr) = central().await;
    let _first = linked_worker(&central, &addr).await;
    // A second Mac with this Mac's link.json, as a migration copies it.
    let second = worker(WORKER_ID, "Alex's MacBook Air").await;
    let token = pair(&central, &addr, "Alex's MacBook Air").await;
    link(&second, &addr, &token).await;
    let want = LinkState::Error {
        message: "another Mac links with this worker id".into(),
    };
    eventually("an error", || async { link_state(&second).await == want }).await;
    let names: Vec<_> = workers(&central).await.into_iter().map(|w| w.worker.name).collect();
    assert_eq!(names, ["Alex's MacBook Pro"]);
}

#[tokio::test]
async fn a_mac_that_removed_itself_cannot_register_on_its_closing_connection() {
    let (central, addr) = central().await;
    let token = pair(&central, &addr, "Alex's MacBook Pro").await;
    let mut s = raw(&addr, &token, "moonletd-worker").await;
    assert_eq!(refused(&ask(&mut s, 1, "mobile.unpair", json!({})).await), None);
    assert_eq!(
        refused(&ask(&mut s, 2, "worker.register", registration(WORKER_ID, "MacBook Pro")).await)
            .as_deref(),
        Some("forbidden")
    );
}

#[tokio::test]
async fn a_new_name_reaches_the_central_host_while_linked() {
    let (central, addr) = central().await;
    let worker = linked_worker(&central, &addr).await;
    let _: LinkInfo = worker
        .call("link.set", json!({ "worker": { "name": "Work laptop" } }))
        .await;
    eventually("the new name", || async {
        workers(&central).await.first().map(|w| w.worker.name.clone()) == Some("Work laptop".into())
    })
    .await;
}

#[tokio::test]
async fn a_retry_leaves_a_working_link_alone() {
    let (central, addr) = central().await;
    let worker = linked_worker(&central, &addr).await;
    let since = workers(&central).await[0].connected_since;
    let _: LinkInfo = worker.call("link.retry", json!({})).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let now = workers(&central).await;
    assert_eq!(now.len(), 1);
    assert_eq!(now[0].connected_since, since, "the link was made again");
}

/// Reads until the daemon ends the connection; returns the error it gave.
async fn ended(s: &mut tokio::net::TcpStream) -> Option<String> {
    use moonlet_proto::read_frame;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut why = None;
    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), read_frame(s)).await {
            Ok(Ok(Some(Frame::Json(Message::Response { id: 0, error: Some(e), .. })))) => {
                why = Some(e.message)
            }
            Ok(Ok(Some(_))) => {}
            Ok(Ok(None)) | Ok(Err(_)) => return why,
            Err(_) => panic!("the connection stayed open"),
        }
    }
    panic!("the connection stayed open");
}

#[tokio::test]
async fn only_a_worker_sends_packs() {
    use moonlet_proto::write_frame;
    let (central, addr) = central().await;
    let token = pair(&central, &addr, "Alex's MacBook Pro").await;
    let pack = Frame::Pack {
        transfer: 1,
        data: b"PACK".to_vec(),
    };

    // A paired device over the tailnet, as a phone or the app.
    for client in ["moonlet-mobile", "moonlet-app"] {
        let mut s = raw(&addr, &token, client).await;
        write_frame(&mut s, &pack).await.unwrap();
        assert_eq!(
            ended(&mut s).await.as_deref(),
            Some("only a worker sends packs"),
            "{client}"
        );
    }

    // The app and the CLI on the Mac itself.
    for client in ["moonlet-app", "moonlet-cli"] {
        let c = Client::connect(&central.socket, client).await.unwrap();
        let mut s = c.into_stream();
        write_frame(&mut s, &pack).await.unwrap();
        let mut buf = Vec::new();
        let n = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::io::AsyncReadExt::read_to_end(&mut s, &mut buf),
        )
        .await
        .expect("the connection stayed open");
        assert!(n.is_ok(), "{client}");
    }

    // A worker may.
    let mut w = raw(&addr, &token, "moonletd-worker").await;
    write_frame(&mut w, &pack).await.unwrap();
    assert_eq!(
        refused(
            &ask(
                &mut w,
                1,
                "worker.register",
                registration(WORKER_ID, "Alex's MacBook Pro")
            )
            .await
        ),
        None
    );
}
