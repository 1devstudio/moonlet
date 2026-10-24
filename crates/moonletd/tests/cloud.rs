//! X63 end to end: cloud workers' settings, machines made with the fake
//! provider, idle time, limits and the sweep. Needs `moonletd` built
//! (`cargo test --workspace`).

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::methods::{DeviceKind, MobilePairing};
use moonlet_proto::{Frame, Message};
use serde_json::{Value, json};

struct Daemon {
    home: tempfile::TempDir,
    socket: PathBuf,
    env: Vec<(String, String)>,
    child: Child,
}

impl Daemon {
    async fn start(home: tempfile::TempDir, env: &[(&str, &str)]) -> Daemon {
        let socket = home.path().join("run").join("d.sock");
        let child = spawn(home.path(), &socket, env).await;
        Daemon {
            home,
            socket,
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            child,
        }
    }

    async fn restart(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let env: Vec<(&str, &str)> = self
            .env
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        self.child = spawn(self.home.path(), &self.socket, &env).await;
    }

    async fn app(&self) -> Client {
        Client::connect(&self.socket, "moonlet-app").await.unwrap()
    }

    async fn call<T: serde::de::DeserializeOwned>(&self, method: &str, params: Value) -> T {
        self.app().await.request(method, params).await.unwrap()
    }

    async fn fails(&self, method: &str, params: Value) -> String {
        let e = self
            .app()
            .await
            .request::<_, Value>(method, params)
            .await
            .unwrap_err();
        e.to_string()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn spawn(home: &Path, socket: &Path, env: &[(&str, &str)]) -> Child {
    let child = Command::new(env!("CARGO_BIN_EXE_moonletd"))
        .arg("daemon")
        .env("MOONLET_HOME", home)
        .env("MOONLET_SOCK", socket)
        .env("CLAUDE_CONFIG_DIR", home.join("claude"))
        .envs(env.iter().copied())
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

/// A central host listening on the loopback for paired devices.
async fn listening() -> (Daemon, String) {
    let home = tempfile::tempdir().unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    std::fs::write(
        home.path().join("mobile.json"),
        format!(r#"{{ "enabled": true, "port": {port} }}"#),
    )
    .unwrap();
    let d = Daemon::start(home, &[("MOONLET_MOBILE_ADDRS", "127.0.0.1")]).await;
    let addr = format!("127.0.0.1:{port}");
    for _ in 0..100 {
        let st: Value = d.call("mobile.status", json!({})).await;
        if st["listening"]
            .as_array()
            .is_some_and(|l| l.contains(&json!(addr)))
        {
            return (d, addr);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("never listened on {addr}");
}

async fn pair(d: &Daemon, addr: &str, device: &str, kind: DeviceKind) -> String {
    let p: MobilePairing = d.call("mobile.pair_start", json!({})).await;
    moonlet_link::tailnet::pair(&[addr.to_string()], &p.code, device, kind)
        .await
        .unwrap()
        .token
}

/// The error code a paired device gets for `method`, or None.
async fn as_device(addr: &str, token: &str, method: &str, params: Value) -> Option<String> {
    as_device_client(addr, token, "moonlet-app", method, params).await
}

/// [`as_device`], as connection `client`.
async fn as_device_client(
    addr: &str,
    token: &str,
    client: &str,
    method: &str,
    params: Value,
) -> Option<String> {
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
    read_frame(&mut s).await.unwrap();
    let hello = Message::Hello {
        protocol: moonlet_proto::PROTOCOL_VERSION,
        client: client.into(),
    };
    write_frame(&mut s, &Frame::Json(hello)).await.unwrap();
    read_frame(&mut s).await.unwrap();
    let req = Message::Request {
        id: 7,
        method: method.into(),
        params,
    };
    write_frame(&mut s, &Frame::Json(req)).await.unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(10), read_frame(&mut s))
            .await
            .expect("no reply")
            .unwrap();
        if let Some(Frame::Json(Message::Response { id: 7, error, .. })) = frame {
            return error.map(|e| e.code);
        }
    }
}

fn settings() -> Value {
    json!({
        "providers": { "hetzner": { "token": "hc-secret-token" } },
        "tailscale": { "client_id": "kQ7cLient1CNTRL", "client_secret": "tskey-client-secret", "tag": "tag:moonlet-worker" },
        "idle_minutes": 15,
        "max_machines": 2,
        "max_hours_month": 40
    })
}

#[tokio::test]
async fn cloud_get_returns_no_secrets() {
    let d = Daemon::start(tempfile::tempdir().unwrap(), &[]).await;
    let _: Value = d.call("cloud.set", settings()).await;
    let got: Value = d.call("cloud.get", json!({})).await;
    assert_eq!(
        got["providers"],
        json!({ "hetzner": { "has_token": true } })
    );
    assert_eq!(
        got["tailscale"],
        json!({ "client_id": "kQ7cLient1CNTRL", "has_client_secret": true, "tag": "tag:moonlet-worker" })
    );
    assert_eq!(
        (
            got["idle_minutes"].clone(),
            got["max_machines"].clone(),
            got["max_hours_month"].clone()
        ),
        (json!(15), json!(2), json!(40))
    );
    let text = got.to_string();
    assert!(
        !text.contains("hc-secret-token") && !text.contains("tskey-client-secret"),
        "{text}"
    );
    // Kept for the central host alone.
    let file = d.home.path().join("cloud.json");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        std::fs::read_to_string(&file)
            .unwrap()
            .contains("hc-secret-token")
    );
    // A field left out keeps its value; Hetzner is the provider on offer.
    let _: Value = d.call("cloud.set", json!({ "idle_minutes": 0 })).await;
    let got: Value = d.call("cloud.get", json!({})).await;
    assert_eq!(got["idle_minutes"], json!(0));
    assert_eq!(got["providers"]["hetzner"]["has_token"], json!(true));
    assert_eq!(got["kinds"][0]["id"], json!("hetzner"));
    assert_eq!(got["kinds"][0]["fields"][0]["secret"], json!(true));
    assert_eq!(
        d.fails("cloud.set", json!({ "idle_minutes": 1441 })).await,
        "invalid_params: the idle time is from 0 to 1440 minutes"
    );
}

#[tokio::test]
async fn cloud_set_from_the_cli_or_a_phone_is_forbidden() {
    let (d, addr) = listening().await;
    let mut cli = Client::connect(&d.socket, "moonlet-cli").await.unwrap();
    let e = cli
        .request::<_, Value>("cloud.set", settings())
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "forbidden: only the moonlet app manages cloud workers"
    );
    let phone = pair(&d, &addr, "Alex's iPhone", DeviceKind::Phone).await;
    assert_eq!(
        as_device(&addr, &phone, "cloud.set", settings())
            .await
            .as_deref(),
        Some("forbidden")
    );
    let desktop = pair(&d, &addr, "Alex's MacBook Pro", DeviceKind::Desktop).await;
    // A paired Mac's daemon, linked as a worker, speaks for no one.
    assert_eq!(
        as_device_client(&addr, &desktop, "moonletd-worker", "cloud.set", settings())
            .await
            .as_deref(),
        Some("forbidden")
    );
    assert_eq!(
        as_device(&addr, &desktop, "cloud.set", settings()).await,
        None
    );
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A project `shop` with one commit, added to `d`; gives its id.
async fn shop(d: &Daemon) -> String {
    let repo = d.home.path().join("src/shop");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README.md"), "shop\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "shop"]);
    let project: Value = d.call("project.add", json!({ "path": repo })).await;
    project["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn a_session_asks_for_the_cloud_when_it_is_made() {
    let d = Daemon::start(tempfile::tempdir().unwrap(), &[]).await;
    let project = shop(&d).await;
    let cloudy: Value = d
        .call(
            "session.create",
            json!({ "project_id": project, "name": "big-refactor", "agent": "none", "cloud": true }),
        )
        .await;
    let plain: Value = d
        .call(
            "session.create",
            json!({ "project_id": project, "name": "fix-cart", "agent": "none" }),
        )
        .await;
    let listed: Vec<Value> = d.call("session.list", json!({})).await;
    let cloud_of = |id: &Value| {
        listed
            .iter()
            .find(|s| s["id"] == *id)
            .map(|s| s["cloud"].clone())
            .unwrap()
    };
    assert_eq!(cloud_of(&cloudy["id"]), json!(true));
    assert_eq!(cloud_of(&plain["id"]), Value::Null);
}

/// A central host `studio-mini` listening on the loopback, with the fake
/// provider making its machines in `fake`.
struct Cloud {
    d: Daemon,
    addr: String,
    fake: tempfile::TempDir,
    project: String,
    key: String,
}

const SHOP_CONFIG: &str = "[heavy]\ncommands = [\"sh run.sh\"]\nmachine_setup = \"ci.sh\"\n";

impl Drop for Cloud {
    /// The fake machines' daemons go with the test.
    fn drop(&mut self) {
        for e in std::fs::read_dir(self.fake.path())
            .into_iter()
            .flatten()
            .flatten()
        {
            if let Some(pid) = std::fs::read_to_string(e.path().join("pid"))
                .ok()
                .and_then(|p| p.trim().parse::<i32>().ok())
            {
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(pid),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
        }
    }
}

async fn cloud_with(config: &str, env: &[(&str, &str)]) -> Cloud {
    let home = tempfile::tempdir().unwrap();
    let fake = tempfile::tempdir().unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    std::fs::write(
        home.path().join("mobile.json"),
        format!(r#"{{ "enabled": true, "port": {port} }}"#),
    )
    .unwrap();
    std::fs::write(
        home.path().join("link.json"),
        r#"{ "central": null, "worker": { "id": "c0ffee00-0000-4000-8000-000000000001", "name": "studio-mini", "enabled": false } }"#,
    )
    .unwrap();
    let fake_dir = fake.path().to_str().unwrap().to_string();
    let mut all = vec![
        ("MOONLET_MOBILE_ADDRS", "127.0.0.1"),
        ("MOONLET_CLOUD_FAKE", fake_dir.as_str()),
        ("MOONLET_TEST_LOAD", "0.5"),
        ("SHELL", "/bin/sh"),
    ];
    all.extend_from_slice(env);
    let d = Daemon::start(home, &all).await;
    let addr = format!("127.0.0.1:{port}");
    for _ in 0..100 {
        let st: Value = d.call("mobile.status", json!({})).await;
        if st["listening"]
            .as_array()
            .is_some_and(|l| l.contains(&json!(addr)))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let repo = d.home.path().join("src/shop");
    std::fs::create_dir_all(repo.join(".moonlet")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join(".moonlet/config.toml"), config).unwrap();
    std::fs::write(repo.join("ci.sh"), "echo deps installed\n").unwrap();
    std::fs::write(repo.join("run.sh"), "echo out\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "shop"]);
    let project: Value = d.call("project.add", json!({ "path": repo })).await;
    let root = project["identity"]["root"].as_str().unwrap();
    let key = format!(" {root}");
    let _: Value = d
        .call(
            "cloud.set",
            json!({
                "providers": { "fake": {} },
                "projects": { key.clone(): { "overflow": false, "provider": "fake", "type": "small", "location": "here", "image": "none" } }
            }),
        )
        .await;
    Cloud {
        d,
        addr,
        fake,
        project: project["id"].as_str().unwrap().to_string(),
        key,
    }
}

async fn cloud() -> Cloud {
    cloud_with(SHOP_CONFIG, &[]).await
}

impl Cloud {
    async fn machines(&self) -> Value {
        self.d.call("cloud.machines", json!({})).await
    }

    /// Waits until machine `id` is in `state`; gives it.
    async fn until(&self, id: &str, state: &str) -> Value {
        for _ in 0..600 {
            let all = self.machines().await;
            let found = all["machines"]
                .as_array()
                .into_iter()
                .chain(all["removed"].as_array())
                .flatten()
                .find(|m| m["id"] == id)
                .cloned();
            if let Some(m) = found
                && m["state"] == state
            {
                return m;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("machine {id} never {state}: {}", self.machines().await);
    }

    async fn up(&self) -> Value {
        self.d
            .call("cloud.up", json!({ "project": self.project }))
            .await
    }
}

#[tokio::test]
async fn the_fake_provider_is_off_without_its_setting() {
    let d = Daemon::start(tempfile::tempdir().unwrap(), &[]).await;
    let got: Value = d.call("cloud.get", json!({})).await;
    let ids: Vec<&str> = got["kinds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["hetzner"]);
    let c = cloud().await;
    let got: Value = c.d.call("cloud.get", json!({})).await;
    let ids: Vec<&str> = got["kinds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["hetzner", "fake"]);
}

#[tokio::test]
async fn startup_steps_arrive_in_order_with_durations() {
    let c = cloud().await;
    let m = c.up().await;
    assert_eq!(m["state"], json!("creating"));
    assert!(
        m["name"].as_str().unwrap().starts_with("moonlet-shop-"),
        "{m}"
    );
    let ready = c.until(m["id"].as_str().unwrap(), "ready").await;
    let steps: Vec<(String, String)> = ready["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["label"].as_str().unwrap().to_string(),
                s["state"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let version = env!("CARGO_PKG_VERSION");
    assert_eq!(
        steps,
        [
            ("Created at Fake cloud".to_string(), "done".to_string()),
            ("Joined your tailnet".into(), "done".into()),
            (format!("Installed moonlet {version}"), "done".into()),
            ("Paired with studio-mini".into(), "done".into()),
            ("Machine setup ci.sh".into(), "done".into()),
        ]
    );
    assert!(
        ready["steps"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["took_ms"].is_u64()),
        "{ready}"
    );
    // It is a worker of the central host, taking heavy commands.
    let workers: Vec<Value> = c.d.call("worker.list", json!({})).await;
    assert_eq!(workers.len(), 1, "{workers:?}");
    assert_eq!(workers[0]["name"], ready["name"]);
    assert_eq!(workers[0]["heavy"], json!(true));
}

impl Cloud {
    /// The fake machines' folders, oldest first.
    fn fake_dirs(&self) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = std::fs::read_dir(self.fake.path())
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.join("meta.json").exists())
            .collect();
        dirs.sort();
        dirs
    }

    /// The device token the first fake machine paired with.
    fn machine_token(&self) -> String {
        let link: Value = serde_json::from_slice(
            &std::fs::read(self.fake_dirs()[0].join("home/link.json")).unwrap(),
        )
        .unwrap();
        link["central"]["token"].as_str().unwrap().to_string()
    }

    async fn ready(&self) -> Value {
        let m = self.up().await;
        self.until(m["id"].as_str().unwrap(), "ready").await
    }

    fn steer(&self, file: &str, value: &str) {
        std::fs::write(self.fake.path().join(file), value).unwrap();
    }
}

/// Whether `token` still opens a connection.
async fn authed(addr: &str, token: &str) -> bool {
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
    matches!(
        read_frame(&mut s).await,
        Ok(Some(Frame::Json(Message::Authed { .. })))
    )
}

#[tokio::test]
async fn a_cloud_device_may_call_only_worker_methods() {
    let c = cloud().await;
    c.ready().await;
    let token = c.machine_token();
    for method in [
        "session.list",
        "terminal.list",
        "terminal.attach",
        "cloud.set",
        "heavy.approve",
        "mobile.status",
    ] {
        assert_eq!(
            as_device_client(&c.addr, &token, "moonletd-worker", method, json!({}))
                .await
                .as_deref(),
            Some("forbidden"),
            "{method}"
        );
    }
    // Nor does it hear the central host's events.
    use moonlet_proto::{read_frame, write_frame};
    let mut s = tokio::net::TcpStream::connect(&c.addr).await.unwrap();
    let auth = Message::Auth {
        token: Some(token.clone()),
        pair: None,
        device: None,
        route: None,
        kind: None,
    };
    write_frame(&mut s, &Frame::Json(auth)).await.unwrap();
    read_frame(&mut s).await.unwrap();
    let hello = Message::Hello {
        protocol: moonlet_proto::PROTOCOL_VERSION,
        client: "moonletd-worker".into(),
    };
    write_frame(&mut s, &Frame::Json(hello)).await.unwrap();
    read_frame(&mut s).await.unwrap();
    let _: Value =
        c.d.call(
            "session.create",
            json!({ "project_id": c.project, "name": "fix-cart", "agent": "none" }),
        )
        .await;
    while let Ok(Ok(Some(frame))) =
        tokio::time::timeout(Duration::from_millis(500), read_frame(&mut s)).await
    {
        assert!(
            !matches!(frame, Frame::Json(Message::Event { .. })),
            "{frame:?}"
        );
    }
}

#[tokio::test]
async fn a_cloud_device_goes_away_with_its_machine() {
    let c = cloud().await;
    let m = c.ready().await;
    // Listed under its machine, never as a paired device.
    let status: Value = c.d.call("mobile.status", json!({})).await;
    assert_eq!(status["devices"], json!([]));
    let token = c.machine_token();
    assert!(authed(&c.addr, &token).await);
    let _: Value =
        c.d.call("cloud.down", json!({ "machine": m["name"] }))
            .await;
    c.until(m["id"].as_str().unwrap(), "removed").await;
    assert!(!authed(&c.addr, &token).await);
}

#[tokio::test]
async fn removing_revokes_the_device_retires_and_destroys() {
    let c = cloud().await;
    let m = c.ready().await;
    let dir = c.fake_dirs()[0].clone();
    let _: Value = c.d.call("cloud.down", json!({ "machine": m["id"] })).await;
    let removed = c.until(m["id"].as_str().unwrap(), "removed").await;
    assert_eq!(removed["reason"], json!("removed on request"));
    assert!(!dir.exists(), "the provider still has it");
    let workers: Vec<Value> = c.d.call("worker.list", json!({})).await;
    for _ in 0..50 {
        let workers: Vec<Value> = c.d.call("worker.list", json!({})).await;
        if workers.is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("still a worker: {workers:?}");
}

#[tokio::test]
async fn removing_logs_the_machine_out_of_the_tailnet() {
    let c = cloud().await;
    let m = c.ready().await;
    let _: Value = c.d.call("cloud.down", json!({ "machine": m["id"] })).await;
    c.until(m["id"].as_str().unwrap(), "removed").await;
    // The fake machine's `tailscale` notes its arguments here.
    let calls = std::fs::read_to_string(c.fake.path().join("tailscale-calls")).unwrap_or_default();
    assert_eq!(calls, "logout\n");
}

#[tokio::test]
async fn a_ready_machine_names_its_worker() {
    let c = cloud().await;
    let m = c.ready().await;
    let workers: Vec<Value> = c.d.call("worker.list", json!({})).await;
    assert_eq!(workers.len(), 1, "{workers:?}");
    assert_eq!(m["worker"], workers[0]["id"]);
}

#[tokio::test]
async fn a_slow_create_call_still_comes_up() {
    let c = cloud().await;
    c.steer("slow-create", "1000");
    let m = c.ready().await;
    assert_eq!(m["steps"][0]["state"], json!("done"), "{m}");
}

#[tokio::test]
async fn remove_now_removes_an_idle_machine_at_once() {
    let c = cloud().await;
    let m = c.ready().await;
    let started = std::time::Instant::now();
    let _: Value =
        c.d.call("cloud.down", json!({ "machine": m["name"] }))
            .await;
    c.until(m["id"].as_str().unwrap(), "removed").await;
    assert!(started.elapsed() < Duration::from_secs(5));
    let all = c.machines().await;
    assert_eq!(all["machines"], json!([]));
    assert_eq!(all["removed"][0]["name"], m["name"]);
}

#[tokio::test]
async fn a_failing_destroy_is_retried_and_reported_after_three_tries() {
    let c = cloud_with(SHOP_CONFIG, &[("MOONLET_TEST_CLOUD_BACKOFF_MS", "200")]).await;
    let m = c.ready().await;
    let id = m["id"].as_str().unwrap().to_string();
    c.steer("fail-destroy", "4");
    let _: Value = c.d.call("cloud.down", json!({ "machine": id })).await;
    let mut reported = Value::Null;
    for _ in 0..100 {
        let all = c.machines().await;
        if let Some(m) = all["machines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == id.as_str())
            && m["error"].is_string()
        {
            reported = m.clone();
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(reported["state"], json!("removing"), "{reported}");
    assert_eq!(reported["error"], json!("503 Service Unavailable"));
    assert!(reported["error_since"].is_u64());
    assert!(reported["error_at"].as_u64() >= reported["error_since"].as_u64());
    let removed = c.until(&id, "removed").await;
    assert_eq!(removed["error"], Value::Null);
}

#[tokio::test]
async fn retry_tries_a_failing_removal_again_at_once() {
    // Tries at 0 s, 1 s and 3 s; the next would be at 7 s.
    let c = cloud_with(SHOP_CONFIG, &[("MOONLET_TEST_CLOUD_BACKOFF_MS", "1000")]).await;
    let m = c.ready().await;
    let id = m["id"].as_str().unwrap().to_string();
    c.steer("fail-destroy", "3");
    let _: Value = c.d.call("cloud.down", json!({ "machine": id })).await;
    let mut reported = false;
    for _ in 0..100 {
        let all = c.machines().await;
        if all["machines"][0]["error"].is_string() {
            reported = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(reported);
    // Retry is `cloud.down` again.
    let _: Value = c.d.call("cloud.down", json!({ "machine": id })).await;
    for _ in 0..30 {
        if c.machines().await["removed"][0]["id"] == id.as_str() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("not removed within 1.5 s of Retry");
}

#[tokio::test]
async fn a_machine_that_never_joins_is_removed_at_the_deadline() {
    let c = cloud_with(SHOP_CONFIG, &[("MOONLET_TEST_CLOUD_DEADLINE_MS", "1500")]).await;
    c.steer("no-join", "");
    let m = c.up().await;
    let removed = c.until(m["id"].as_str().unwrap(), "removed").await;
    let reason = removed["reason"].as_str().unwrap();
    assert!(
        reason.starts_with(&format!(
            "{} did not come up in ",
            m["name"].as_str().unwrap()
        )),
        "{reason}"
    );
    assert!(
        reason.ends_with("; last: Created at Fake cloud"),
        "{reason}"
    );
    assert!(c.fake_dirs().is_empty());
}

#[tokio::test]
async fn a_machine_whose_link_stays_down_is_removed() {
    let c = cloud_with(
        SHOP_CONFIG,
        &[
            ("MOONLET_TEST_CLOUD_LINK_DOWN_MS", "1000"),
            ("MOONLET_WORKER_PING_MS", "200"),
        ],
    )
    .await;
    let m = c.ready().await;
    let pid: i32 = std::fs::read_to_string(c.fake_dirs()[0].join("pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(pid),
        nix::sys::signal::Signal::SIGSTOP,
    )
    .unwrap();
    let removed = c.until(m["id"].as_str().unwrap(), "removed").await;
    assert!(
        removed["reason"]
            .as_str()
            .unwrap()
            .starts_with("its link was down"),
        "{removed}"
    );
}

#[tokio::test]
async fn two_cloud_up_calls_at_once_never_pass_the_limit() {
    let c = cloud().await;
    c.ready().await;
    let (mut x, mut y) = (c.d.app().await, c.d.app().await);
    let (a, b) = tokio::join!(
        x.request::<_, Value>("cloud.up", json!({ "project": c.project })),
        y.request::<_, Value>("cloud.up", json!({ "project": c.project }))
    );
    let mut errors: Vec<String> = [&a, &b]
        .iter()
        .filter_map(|r| r.as_ref().err().map(|e| e.to_string()))
        .collect();
    errors.sort();
    assert_eq!(
        errors,
        ["cloud_limit: Cloud limit reached: 2 of 2 machines"],
        "{a:?} {b:?}"
    );
}

#[tokio::test]
async fn a_creating_machine_counts_against_the_limit() {
    let c = cloud().await;
    let _: Value = c.d.call("cloud.set", json!({ "max_machines": 1 })).await;
    c.steer("slow-create", "3000");
    let m = c.up().await;
    assert_eq!(m["state"], json!("creating"));
    assert_eq!(
        c.d.fails("cloud.up", json!({ "project": c.project })).await,
        "cloud_limit: Cloud limit reached: 1 of 1 machines"
    );
}

#[tokio::test]
async fn a_limit_refuses_cloud_up_with_the_message() {
    let mut c = cloud().await;
    let month = String::from_utf8(
        Command::new("date")
            .args(["-u", "+%Y-%m"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    std::fs::create_dir_all(c.d.home.path().join("cloud")).unwrap();
    std::fs::write(
        c.d.home.path().join("cloud/usage.json"),
        json!({ month.trim(): 40 * 3600 }).to_string(),
    )
    .unwrap();
    c.d.restart().await;
    assert_eq!(
        c.d.fails("cloud.up", json!({ "project": c.project })).await,
        "cloud_limit: Cloud limit reached: 40 of 40 machine-hours this month"
    );
    let all = c.machines().await;
    assert_eq!(
        (
            all["hours_this_month"].clone(),
            all["max_hours_month"].clone()
        ),
        (json!(40.0), json!(40))
    );
}

#[tokio::test]
async fn a_machine_is_recorded_before_the_create_call() {
    let c = cloud().await;
    c.steer("slow-create", "3000");
    let m = c.up().await;
    let recorded: Value = serde_json::from_slice(
        &std::fs::read(c.d.home.path().join("cloud/machines.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(recorded[0]["id"], m["id"]);
    assert_eq!(recorded[0]["state"], json!("creating"));
    assert_eq!(recorded[0]["provider_id"], Value::Null);
}

impl Cloud {
    fn repo(&self) -> PathBuf {
        self.d.home.path().join("src/shop")
    }
}

#[tokio::test]
async fn machine_setup_without_a_session_comes_from_the_projects_folder() {
    let c = cloud_with(SHOP_CONFIG, &[]).await;
    // The project's folder, not what was committed.
    std::fs::write(c.repo().join("ci.sh"), "echo from-folder > marker\n").unwrap();
    c.ready().await;
    assert_eq!(
        std::fs::read_to_string(c.fake_dirs()[0].join("marker")).unwrap(),
        "from-folder\n"
    );
}

#[tokio::test]
async fn machine_setup_comes_from_the_sessions_worktree() {
    let c = cloud().await;
    let session: Value =
        c.d.call(
            "session.create",
            json!({ "project_id": c.project, "name": "big-refactor", "agent": "none" }),
        )
        .await;
    let worktree = PathBuf::from(session["path"].as_str().unwrap());
    std::fs::write(worktree.join("ci.sh"), "echo from-session > marker\n").unwrap();
    let m: Value =
        c.d.call(
            "cloud.up",
            json!({ "project": c.project, "session": session["id"] }),
        )
        .await;
    assert_eq!(m["for_session"], session["id"]);
    c.until(m["id"].as_str().unwrap(), "starting").await;
    for _ in 0..100 {
        if let Ok(text) = std::fs::read_to_string(c.fake_dirs()[0].join("marker")) {
            assert_eq!(text, "from-session\n");
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the machine setup never ran");
}

#[tokio::test]
async fn a_machine_setup_over_16_kib_makes_no_machine() {
    let c = cloud().await;
    std::fs::write(c.repo().join("ci.sh"), "#".repeat(16 * 1024 + 1)).unwrap();
    assert_eq!(
        c.d.fails("cloud.up", json!({ "project": c.project })).await,
        "machine_setup: ci.sh is over 16 KiB"
    );
    assert_eq!(c.machines().await["machines"], json!([]));
}

#[tokio::test]
async fn a_machine_setup_outside_the_folder_makes_no_machine() {
    let c = cloud().await;
    let outside = c.d.home.path().join("secret.sh");
    std::fs::write(&outside, "echo secret\n").unwrap();
    std::fs::remove_file(c.repo().join("ci.sh")).unwrap();
    std::os::unix::fs::symlink(&outside, c.repo().join("ci.sh")).unwrap();
    assert_eq!(
        c.d.fails("cloud.up", json!({ "project": c.project })).await,
        "machine_setup: ci.sh is outside the repository"
    );
    assert!(c.fake_dirs().is_empty());
}

#[tokio::test]
async fn a_missing_machine_setup_makes_no_machine() {
    let c = cloud().await;
    std::fs::remove_file(c.repo().join("ci.sh")).unwrap();
    assert_eq!(
        c.d.fails("cloud.up", json!({ "project": c.project })).await,
        "machine_setup: ci.sh is missing"
    );
}

#[tokio::test]
async fn a_machine_without_machine_setup_skips_that_step() {
    let c = cloud_with("[heavy]\ncommands = [\"sh run.sh\"]\n", &[]).await;
    let ready = c.ready().await;
    let steps: Vec<&str> = ready["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["step"].as_str().unwrap())
        .collect();
    assert_eq!(steps, ["created", "tailnet", "installed", "paired"]);
}

#[tokio::test]
async fn a_failing_machine_setup_fails_and_removes_the_machine() {
    let c = cloud().await;
    std::fs::write(c.repo().join("ci.sh"), "echo nope; exit 3\n").unwrap();
    let m = c.up().await;
    let removed = c.until(m["id"].as_str().unwrap(), "removed").await;
    assert_eq!(
        removed["reason"],
        json!(
            "Machine setup ci.sh failed: exit 3; its output is in /var/log/moonlet/machine-setup.log"
        )
    );
    let step = removed["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["step"] == "machine_setup")
        .cloned()
        .unwrap();
    assert_eq!(step["state"], json!("failed"));
}

#[tokio::test]
async fn the_sweep_destroys_a_machine_moonlet_lost_track_of() {
    let c = cloud_with(SHOP_CONFIG, &[("MOONLET_TEST_CLOUD_SWEEP_MS", "300")]).await;
    let info: Value = c.d.call("cloud.get", json!({})).await;
    let host = info["host_id"].as_str().unwrap();
    // Labelled for this central host, with no record: left by a crash.
    let ghost = c.fake.path().join("f9");
    std::fs::create_dir_all(&ghost).unwrap();
    let meta = json!({
        "name": "moonlet-shop-gh05",
        "labels": { "moonlet-host": host, "moonlet-machine": "mgh05", "moonlet-project": "x" },
        "created_at": 1
    });
    std::fs::write(ghost.join("meta.json"), meta.to_string()).unwrap();
    // Another central host's machine is left alone.
    let other = c.fake.path().join("f8");
    std::fs::create_dir_all(&other).unwrap();
    let meta =
        json!({ "name": "theirs", "labels": { "moonlet-host": "someone-else" }, "created_at": 1 });
    std::fs::write(other.join("meta.json"), meta.to_string()).unwrap();
    for _ in 0..50 {
        if !ghost.exists() {
            assert!(other.exists());
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the sweep left the machine");
}

#[tokio::test]
async fn cloud_up_needs_the_central_host_to_take_tailnet_connections() {
    // Without a listener the machine could never pair, and would be billed
    // until its deadline.
    let c = cloud().await;
    let _: Value =
        c.d.call("mobile.set_enabled", json!({ "enabled": false }))
            .await;
    let e = c.d.fails("cloud.up", json!({ "project": c.project })).await;
    assert_eq!(
        e,
        "no_listener: studio-mini takes no connections from your tailnet, so a cloud machine cannot pair with it. Turn on Allow connections from my tailnet in Hosts."
    );
    assert!(c.fake_dirs().is_empty());
}

#[tokio::test]
async fn running_machines_count_toward_the_monthly_limit() {
    let mut c = cloud().await;
    let month = String::from_utf8(
        Command::new("date")
            .args(["-u", "+%Y-%m"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let month = month.trim();
    // One second short of the limit.
    std::fs::create_dir_all(c.d.home.path().join("cloud")).unwrap();
    std::fs::write(
        c.d.home.path().join("cloud/usage.json"),
        json!({ month: 40 * 3600 - 1 }).to_string(),
    )
    .unwrap();
    c.d.restart().await;
    c.ready().await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let e = c.d.fails("cloud.up", json!({ "project": c.project })).await;
    assert_eq!(
        e,
        "cloud_limit: Cloud limit reached: 40 of 40 machine-hours this month"
    );
}

#[tokio::test]
async fn a_machine_removed_during_its_create_call_is_destroyed_when_it_returns() {
    let c = cloud().await;
    c.steer("slow-create", "1000");
    let m = c.up().await;
    let _: Value = c.d.call("cloud.down", json!({ "machine": m["id"] })).await;
    c.until(m["id"].as_str().unwrap(), "removed").await;
    // The create call answers after the removal: what it made goes too.
    for _ in 0..60 {
        if !c.fake_dirs().is_empty() && c.fake_dirs().iter().all(|d| !d.join("meta.json").exists())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        c.fake_dirs().iter().all(|d| !d.join("meta.json").exists()),
        "{:?}",
        c.fake_dirs()
    );
}

#[tokio::test]
async fn the_sweep_books_the_time_of_a_machine_the_provider_lost() {
    let c = cloud_with(SHOP_CONFIG, &[("MOONLET_TEST_CLOUD_SWEEP_MS", "300")]).await;
    let m = c.ready().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Gone at the provider without moonlet removing it.
    let dir = c.fake_dirs()[0].clone();
    std::fs::remove_dir_all(&dir).unwrap();
    for _ in 0..100 {
        let all = c.machines().await;
        if all["machines"].as_array().unwrap().is_empty() {
            assert!(all["hours_this_month"].as_f64().unwrap() > 0.0, "{all}");
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("{} was never dropped: {}", m["name"], c.machines().await);
}

#[tokio::test]
async fn retry_tries_only_its_own_machine_again() {
    let c = cloud_with(SHOP_CONFIG, &[("MOONLET_TEST_CLOUD_BACKOFF_MS", "1000")]).await;
    let _: Value = c.d.call("cloud.set", json!({ "max_machines": 3 })).await;
    let a = c.ready().await;
    let b = c.ready().await;
    c.steer("fail-destroy", "6");
    for m in [&a, &b] {
        let _: Value = c.d.call("cloud.down", json!({ "machine": m["id"] })).await;
    }
    for _ in 0..100 {
        let all = c.machines().await;
        if all["machines"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["error"].is_string())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    std::fs::remove_file(c.fake.path().join("fail-destroy")).unwrap();
    let _: Value = c.d.call("cloud.down", json!({ "machine": a["id"] })).await;
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let all = c.machines().await;
    assert_eq!(all["removed"][0]["id"], a["id"], "{all}");
    assert_eq!(all["machines"][0]["id"], b["id"], "{all}");
}

#[tokio::test]
async fn a_machine_left_creating_by_a_restart_is_destroyed() {
    let mut c = cloud_with(SHOP_CONFIG, &[("MOONLET_TEST_CLOUD_SWEEP_MS", "300")]).await;
    c.steer("slow-create", "60000");
    let m = c.up().await;
    for _ in 0..50 {
        if !c.fake_dirs().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(c.fake_dirs().len(), 1);
    // The daemon restarts during the create call.
    c.d.restart().await;
    for _ in 0..100 {
        let all = c.machines().await;
        let recorded = all["machines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["id"] == m["id"]);
        if c.fake_dirs().is_empty() && !recorded {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("left: {:?} {}", c.fake_dirs(), c.machines().await);
}

#[tokio::test]
async fn cloud_types_lists_the_providers_machine_types() {
    let c = cloud().await;
    let types: Value =
        c.d.call(
            "cloud.types",
            json!({ "provider": "fake", "location": "here" }),
        )
        .await;
    assert_eq!(types[0]["name"], json!("small"));
    assert_eq!(types[0]["cores"], json!(2));
}

const ROUTE_CONFIG: &str =
    "[heavy]\ncommands = [\"sh run.sh\", \"sh -c\"]\nmachine_setup = \"ci.sh\"\n";

/// What a run sent back: its stdout, its stderr and its exit status.
#[derive(Debug)]
struct Ran {
    stdout: String,
    stderr: String,
    status: i32,
}

fn ran_on(r: &Ran) -> String {
    r.stderr
        .lines()
        .filter_map(|l| l.strip_prefix("moonlet: running on "))
        .last()
        .unwrap_or("")
        .to_string()
}

impl Cloud {
    /// Approves the project's heavy commands on the central host.
    async fn approve(&self) {
        let info: Value = self
            .d
            .call("heavy.get", json!({ "project": self.project }))
            .await;
        let _: Value = self
            .d
            .call(
                "heavy.approve",
                json!({ "project": self.project, "commands": info["config"]["commands"], "env": info["config"]["env"] }),
            )
            .await;
    }

    async fn set_project(&self, patch: Value) {
        let mut p = json!({ "overflow": false, "provider": "fake", "type": "small", "location": "here", "image": "none" });
        for (k, v) in patch.as_object().unwrap() {
            p[k] = v.clone();
        }
        let _: Value = self
            .d
            .call("cloud.set", json!({ "projects": { self.key.clone(): p } }))
            .await;
    }

    async fn session(&self, name: &str, cloud: bool) -> Value {
        self.d
            .call(
                "session.create",
                json!({ "project_id": self.project, "name": name, "agent": "none", "cloud": cloud }),
            )
            .await
    }

    /// Starts `argv` routed for `session`; gives the client and the run.
    async fn start(&self, session: &Value, argv: &[&str]) -> (Client, u32) {
        let mut c = self.d.app().await;
        let started: Value = c
            .request(
                "exec.run",
                json!({ "session": session["id"], "argv": argv, "cwd": session["path"], "env": {} }),
            )
            .await
            .unwrap();
        (c, started["run"].as_u64().unwrap() as u32)
    }

    async fn run(&self, session: &Value, argv: &[&str]) -> Ran {
        let (c, run) = self.start(session, argv).await;
        collect(c, run).await
    }
}

async fn collect(mut c: Client, run: u32) -> Ran {
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(30), c.next_frame())
            .await
            .expect("the run never ended")
            .unwrap()
            .expect("the daemon closed the connection");
        match frame {
            Frame::RunOutput {
                run: r,
                stream,
                data,
            } if r == run => {
                if stream == 1 {
                    stdout.extend(data)
                } else {
                    stderr.extend(data)
                }
            }
            Frame::Json(Message::Event { name, data })
                if name == "exec.exited" && data["run"] == json!(run) =>
            {
                return Ran {
                    stdout: String::from_utf8_lossy(&stdout).into(),
                    stderr: String::from_utf8_lossy(&stderr).into(),
                    status: data["status"].as_i64().unwrap() as i32,
                };
            }
            _ => {}
        }
    }
}

/// A central host whose project routes `sh run.sh` and `sh -c`, approved.
async fn routing(env: &[(&str, &str)]) -> Cloud {
    let c = cloud_with(ROUTE_CONFIG, env).await;
    c.approve().await;
    c
}

#[tokio::test]
async fn overflow_starts_a_machine_and_the_next_command_runs_there() {
    // The central host is busy.
    let c = routing(&[("MOONLET_TEST_LOAD", "100")]).await;
    c.set_project(json!({ "overflow": true })).await;
    let s = c.session("fix-cart", false).await;
    // No worker is free: it runs here, and a machine starts.
    let first = c.run(&s, &["sh", "run.sh"]).await;
    assert_eq!(ran_on(&first), "studio-mini");
    assert_eq!(first.stdout, "out\n");
    let machines = c.machines().await;
    let m = machines["machines"][0].clone();
    assert_eq!(m["project"], json!("shop"));
    let ready = c.until(m["id"].as_str().unwrap(), "ready").await;
    let next = c.run(&s, &["sh", "run.sh"]).await;
    assert_eq!(ran_on(&next), ready["name"].as_str().unwrap(), "{next:?}");
    assert_eq!((next.stdout.as_str(), next.status), ("out\n", 0));
}

#[tokio::test]
async fn overflow_starts_no_second_machine_while_one_is_starting() {
    let c = routing(&[]).await;
    c.set_project(json!({ "overflow": true })).await;
    c.steer("slow-create", "5000");
    let s = c.session("fix-cart", false).await;
    c.run(&s, &["sh", "run.sh"]).await;
    c.run(&s, &["sh", "run.sh"]).await;
    assert_eq!(c.machines().await["machines"].as_array().unwrap().len(), 1);
}

impl Cloud {
    async fn jobs(&self, session: &Value) -> Vec<Value> {
        self.d
            .call("job.list", json!({ "session": session["id"] }))
            .await
    }
}

#[tokio::test]
async fn a_cloud_session_waits_for_its_machine_and_runs_there() {
    let c = routing(&[]).await;
    let s = c.session("big-refactor", true).await;
    let ran = c.run(&s, &["sh", "run.sh"]).await;
    let m = c.machines().await["machines"][0].clone();
    let name = m["name"].as_str().unwrap();
    assert!(
        ran.stderr
            .starts_with(&format!("moonlet: waiting for {name} to start (0:00)\n")),
        "{ran:?}"
    );
    assert_eq!(ran_on(&ran), name, "{ran:?}");
    assert_eq!((ran.stdout.as_str(), ran.status), ("out\n", 0));
    assert_eq!(m["for_session"], s["id"]);
}

#[tokio::test]
async fn a_cloud_session_runs_on_the_central_host_when_no_machine_can_start() {
    let c = routing(&[("MOONLET_TEST_CLOUD_DEADLINE_MS", "1500")]).await;
    c.steer("no-join", "");
    let s = c.session("big-refactor", true).await;
    let ran = c.run(&s, &["sh", "run.sh"]).await;
    let line = ran
        .stderr
        .lines()
        .find(|l| l.starts_with("moonlet: no cloud machine ("))
        .unwrap_or_default()
        .to_string();
    assert!(line.ends_with(". Running on studio-mini."), "{ran:?}");
    assert!(line.contains("did not come up in "), "{line}");
    assert_eq!(ran_on(&ran), "studio-mini");
    assert_eq!(ran.status, 0);
    // At a limit, at once.
    let month = String::from_utf8(
        Command::new("date")
            .args(["-u", "+%Y-%m"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    std::fs::write(
        c.d.home.path().join("cloud/usage.json"),
        json!({ month.trim(): 40 * 3600 }).to_string(),
    )
    .unwrap();
    let mut c = c;
    c.d.restart().await;
    let ran = c.run(&s, &["sh", "run.sh"]).await;
    assert!(
        ran.stderr.starts_with(
            "moonlet: no cloud machine (Cloud limit reached: 40 of 40 machine-hours this month). Running on studio-mini.\n"
        ),
        "{ran:?}"
    );
    assert_eq!(ran.status, 0);
}

#[tokio::test]
async fn run_here_runs_a_job_waiting_for_a_cloud_machine_on_the_central_host() {
    let c = routing(&[]).await;
    c.steer("slow-create", "60000");
    let s = c.session("big-refactor", true).await;
    let (client, run) = c.start(&s, &["sh", "run.sh"]).await;
    let mut job = Value::Null;
    for _ in 0..100 {
        job = c.jobs(&s).await[0].clone();
        if job["state"]["kind"] == "waiting" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(job["state"]["kind"], json!("waiting"), "{job}");
    let here: Value = c.d.call("job.run_here", json!({ "job": job["id"] })).await;
    assert_eq!(here, json!(true));
    let ran = collect(client, run).await;
    assert!(
        ran.stderr
            .contains("moonlet: running on studio-mini instead, as asked from the Jobs panel\n"),
        "{ran:?}"
    );
    assert_eq!((ran.stdout.as_str(), ran.status), ("out\n", 0));
    // The machine keeps starting, for the next command.
    let m = &c.machines().await["machines"][0];
    assert_eq!(m["state"], json!("creating"));
}

#[tokio::test]
async fn stop_ends_a_job_waiting_for_a_cloud_machine() {
    let c = routing(&[]).await;
    c.steer("slow-create", "60000");
    let s = c.session("big-refactor", true).await;
    let (client, run) = c.start(&s, &["sh", "run.sh"]).await;
    let mut job = Value::Null;
    for _ in 0..100 {
        job = c.jobs(&s).await[0].clone();
        if job["state"]["kind"] == "waiting" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(job["state"]["kind"], json!("waiting"), "{job}");
    let stopped: Value = c.d.call("job.stop", json!({ "job": job["id"] })).await;
    assert_eq!(stopped, json!(true));
    let ran = tokio::time::timeout(Duration::from_secs(5), collect(client, run))
        .await
        .expect("the waiting command never ended");
    assert!(
        ran.stderr
            .ends_with("moonlet: stopped from the Jobs panel\n"),
        "{ran:?}"
    );
    assert_eq!(ran.stdout, "");
    assert_ne!(ran.status, 0);
}

/// The routing copies on the first fake machine.
fn copies_on(c: &Cloud) -> Vec<PathBuf> {
    let runs = c.fake_dirs()[0].join("home/runs");
    let mut out = Vec::new();
    for host in std::fs::read_dir(&runs).into_iter().flatten().flatten() {
        // `repos` holds the routing copies' repositories, not copies.
        if host.file_name() == "repos" {
            continue;
        }
        for project in std::fs::read_dir(host.path())
            .into_iter()
            .flatten()
            .flatten()
        {
            for copy in std::fs::read_dir(project.path())
                .into_iter()
                .flatten()
                .flatten()
            {
                out.push(copy.path());
            }
        }
    }
    out
}

#[tokio::test]
async fn a_machine_made_for_a_session_is_ready_with_its_copy_and_setup() {
    let config = format!("setup = \"echo set > setup-ran\"\n\n{ROUTE_CONFIG}");
    let c = cloud_with(&config, &[]).await;
    c.approve().await;
    let s = c.session("big-refactor", false).await;
    let m: Value =
        c.d.call(
            "cloud.up",
            json!({ "project": c.project, "session": s["id"] }),
        )
        .await;
    let ready = c.until(m["id"].as_str().unwrap(), "ready").await;
    let last = ready["steps"].as_array().unwrap().last().cloned().unwrap();
    assert_eq!(
        last["label"],
        json!("Copied big-refactor and ran echo set > setup-ran")
    );
    assert_eq!(last["state"], json!("done"));
    let copies = copies_on(&c);
    assert_eq!(copies.len(), 1, "{copies:?}");
    assert!(
        copies[0].join("setup-ran").exists(),
        "setup did not run in {copies:?}"
    );
}

#[tokio::test]
async fn a_machine_made_without_a_session_copies_on_its_first_command() {
    let c = routing(&[]).await;
    c.ready().await;
    assert!(copies_on(&c).is_empty());
    let s = c.session("fix-cart", true).await;
    let ran = c.run(&s, &["sh", "run.sh"]).await;
    let name = c.machines().await["machines"][0]["name"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        ran.stderr
            .starts_with(&format!("moonlet: Copying fix-cart to {name}…\n")),
        "{ran:?}"
    );
    assert_eq!(ran_on(&ran), name);
    assert_eq!(copies_on(&c).len(), 1);
}

#[tokio::test]
async fn an_idle_machine_is_removed_after_the_idle_time() {
    // A minute lasts 200 ms here.
    let c = routing(&[("MOONLET_TEST_CLOUD_MINUTE_MS", "200")]).await;
    let _: Value = c.d.call("cloud.set", json!({ "idle_minutes": 5 })).await;
    let s = c.session("fix-cart", true).await;
    let ran = c.run(&s, &["sh", "-c", "sleep 1.5; echo done"]).await;
    let m = c.machines().await["machines"][0].clone();
    assert_eq!(ran_on(&ran), m["name"].as_str().unwrap());
    // Idle from the command's end: removed 1 s later, not before.
    assert!(m["idle_until"].is_u64(), "{m}");
    let removed = c.until(m["id"].as_str().unwrap(), "removed").await;
    assert_eq!(removed["reason"], json!("removed after 5 min idle"));
}

#[tokio::test]
async fn with_idle_zero_a_machine_goes_when_its_command_ends() {
    let c = routing(&[]).await;
    let _: Value = c.d.call("cloud.set", json!({ "idle_minutes": 0 })).await;
    let s = c.session("fix-cart", true).await;
    let (client, run) = c.start(&s, &["sh", "-c", "sleep 1; echo done"]).await;
    // While it runs, it stays.
    let mut m = Value::Null;
    for _ in 0..100 {
        m = c.machines().await["machines"][0].clone();
        if m["running"] == json!(1) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(m["state"], json!("ready"), "{m}");
    collect(client, run).await;
    let removed = c.until(m["id"].as_str().unwrap(), "removed").await;
    assert_eq!(removed["reason"], json!("removed after 0 min idle"));
}

#[tokio::test]
async fn cloud_down_waits_for_running_commands() {
    let c = routing(&[]).await;
    let s = c.session("fix-cart", true).await;
    let (client, run) = c.start(&s, &["sh", "-c", "sleep 1.5; echo done"]).await;
    let mut m = Value::Null;
    for _ in 0..100 {
        m = c.machines().await["machines"][0].clone();
        if m["running"] == json!(1) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let _: Value =
        c.d.call("cloud.down", json!({ "machine": m["name"] }))
            .await;
    let ran = collect(client, run).await;
    assert_eq!((ran.stdout.as_str(), ran.status), ("done\n", 0), "{ran:?}");
    // It ran to its end there, not again here.
    assert_eq!(ran_on(&ran), m["name"].as_str().unwrap(), "{ran:?}");
    let removed = c.until(m["id"].as_str().unwrap(), "removed").await;
    assert_eq!(removed["reason"], json!("removed on request"));
}

#[tokio::test]
async fn turning_a_projects_cloud_off_removes_its_machines_after_their_commands() {
    let c = routing(&[]).await;
    let m = c.ready().await;
    let _: Value =
        c.d.call("cloud.set", json!({ "projects": { c.key.clone(): null } }))
            .await;
    let removed = c.until(m["id"].as_str().unwrap(), "removed").await;
    assert_eq!(
        removed["reason"],
        json!("shop no longer uses cloud machines")
    );
}

#[tokio::test]
async fn removing_a_provider_removes_its_machines_first() {
    let c = routing(&[("MOONLET_TEST_CLOUD_BACKOFF_MS", "300")]).await;
    let m = c.ready().await;
    c.steer("fail-destroy", "2");
    let info: Value =
        c.d.call("cloud.set", json!({ "providers": { "fake": null } }))
            .await;
    // The setting stays until its machines are gone.
    assert_eq!(info["providers"]["fake"], json!({}));
    let removed = c.until(m["id"].as_str().unwrap(), "removed").await;
    assert_eq!(removed["reason"], json!("its provider was removed"));
    for _ in 0..50 {
        let info: Value = c.d.call("cloud.get", json!({})).await;
        if info["providers"].get("fake").is_none() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the provider stayed");
}

#[tokio::test]
async fn archiving_a_session_leaves_its_machine_to_the_idle_time() {
    let c = routing(&[]).await;
    let s = c.session("big-refactor", true).await;
    c.run(&s, &["sh", "run.sh"]).await;
    let _: Value =
        c.d.call("session.archive", json!({ "id": s["id"], "force": true }))
            .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(c.machines().await["machines"][0]["state"], json!("ready"));
}

fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A project whose first commit held a secret, removed and ignored since.
async fn with_old_secret() -> (Cloud, String) {
    let c = routing(&[]).await;
    let repo = c.repo();
    std::fs::write(repo.join("secret.txt"), "sk-live-123\n").unwrap();
    git(&repo, &["add", "secret.txt"]);
    git(&repo, &["commit", "-q", "-m", "add the key"]);
    let blob = git_out(&repo, &["rev-parse", "HEAD:secret.txt"]);
    git(&repo, &["rm", "-q", "--cached", "secret.txt"]);
    std::fs::write(repo.join(".gitignore"), "secret.txt\n").unwrap();
    git(&repo, &["add", ".gitignore"]);
    git(&repo, &["commit", "-q", "-m", "drop the key"]);
    (c, blob)
}

#[tokio::test]
async fn a_cloud_machine_gets_no_older_history() {
    let (c, _) = with_old_secret().await;
    let s = c.session("big-refactor", true).await;
    let ran = c.run(&s, &["sh", "-c", "git log --format=%s"]).await;
    let name = c.machines().await["machines"][0]["name"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(ran_on(&ran), name, "{ran:?}");
    assert_eq!(
        (ran.stdout.as_str(), ran.status),
        ("drop the key\n", 0),
        "{ran:?}"
    );
}

#[tokio::test]
async fn a_secret_removed_from_the_files_never_reaches_a_cloud_machine() {
    let (c, blob) = with_old_secret().await;
    let s = c.session("big-refactor", true).await;
    let ran = c.run(&s, &["sh", "-c", "ls"]).await;
    let name = c.machines().await["machines"][0]["name"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(ran_on(&ran), name, "{ran:?}");
    assert!(!ran.stdout.contains("secret.txt"), "{ran:?}");
    // Not in the machine's repository either.
    let repos = c.fake_dirs()[0].join("home/runs/repos");
    let mut found = false;
    for host in std::fs::read_dir(&repos).unwrap().flatten() {
        for repo in std::fs::read_dir(host.path()).unwrap().flatten() {
            let out = Command::new("git")
                .args(["cat-file", "-e", &blob])
                .current_dir(repo.path())
                .output()
                .unwrap();
            found |= out.status.success();
        }
    }
    assert!(!found, "the old secret reached the machine");
}

#[tokio::test]
async fn a_cloud_machine_never_contacts_origin() {
    let c = routing(&[]).await;
    // An origin no one can reach: the machine never asks it.
    git(
        &c.repo(),
        &[
            "remote",
            "add",
            "origin",
            "https://git.invalid/acme/shop.git",
        ],
    );
    let s = c.session("big-refactor", true).await;
    let ran = c.run(&s, &["sh", "run.sh"]).await;
    let name = c.machines().await["machines"][0]["name"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(ran_on(&ran), name, "{ran:?}");
    assert_eq!((ran.stdout.as_str(), ran.status), ("out\n", 0));
}
