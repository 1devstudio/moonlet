//! X60: a session on the central host gets a live copy on this Mac. Two
//! daemons run here, linked as in `tests/link.rs`. The project's origin is
//! a bare repository beside them, which the worker reaches through a
//! `url.insteadOf` rule for `https://git.invalid/acme/shop.git`; the
//! central host keeps that URL, so the project has an origin identity.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::methods::{Copy, CopyState, DeviceKind, MobilePairing};
use serde_json::{Value, json};

const ORIGIN_URL: &str = "https://git.invalid/acme/shop.git";

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
        self.stop();
        self.child = spawn(self.home.path(), &self.socket, &self.env).await;
    }

    /// Kills the daemon; `restart` brings it back.
    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    async fn app(&self) -> Client {
        Client::connect_app(&self.socket, self.home.path()).await.unwrap()
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

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn git(dir: &Path, args: &[&str]) -> String {
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
        .env("GIT_AUTHOR_DATE", "2026-10-21T12:00:00Z")
        .env("GIT_COMMITTER_DATE", "2026-10-21T12:00:00Z")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

async fn eventually<F, Fut>(what: &str, mut ok: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(30) {
        if ok().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{what} never happened");
}

/// The tests that time a sync run alone: the others share this gate, and
/// a timing test holds it whole. Two daemons per test, all at once, can
/// otherwise slow a busy machine past the one second they measure.
static GATE: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

enum Gate {
    Shared(#[allow(dead_code)] tokio::sync::RwLockReadGuard<'static, ()>),
    Alone(#[allow(dead_code)] tokio::sync::RwLockWriteGuard<'static, ()>),
}

/// The central host `studio-mini`, its project `shop` (a clone of the bare
/// origin, whose origin URL is [`ORIGIN_URL`]) and a session `Fix cart`.
struct Central {
    daemon: Daemon,
    addr: String,
    origin: PathBuf,
    session: Value,
    _scratch: tempfile::TempDir,
    _gate: Gate,
}

impl Central {
    fn session_path(&self) -> PathBuf {
        PathBuf::from(self.session["path"].as_str().unwrap())
    }

    fn session_id(&self) -> &str {
        self.session["id"].as_str().unwrap()
    }
}

/// A bare origin with one commit: `.gitignore` (node_modules) and
/// `src/cart.ts`.
fn origin(scratch: &Path) -> PathBuf {
    let origin = scratch.join("origin.git");
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "-q", "--bare", "-b", "main"]);
    let seed = scratch.join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    write(&seed.join(".gitignore"), "node_modules/\n");
    write(&seed.join("src/cart.ts"), "a\n");
    git(&seed, &["add", "-A"]);
    git(&seed, &["commit", "-qm", "init"]);
    git(&seed, &["push", "-q", origin.to_str().unwrap(), "main"]);
    origin
}

async fn central() -> Central {
    central_with(Some(ORIGIN_URL)).await
}

/// [`central`], with the project's origin at `origin_url`, or none.
async fn central_with(origin_url: Option<&str>) -> Central {
    central_gated(origin_url, Gate::Shared(GATE.read().await)).await
}

/// [`central`], with no other test of this file running meanwhile.
async fn central_alone() -> Central {
    central_gated(Some(ORIGIN_URL), Gate::Alone(GATE.write().await)).await
}

async fn central_gated(origin_url: Option<&str>, gate: Gate) -> Central {
    let scratch = tempfile::tempdir().unwrap();
    let origin = origin(scratch.path());
    let empty = scratch.path().join("gitconfig");
    write(&empty, "");
    for _ in 0..5 {
        let home = tempfile::tempdir().unwrap();
        let port = free_port();
        write(
            &home.path().join("mobile.json"),
            &format!(r#"{{ "enabled": true, "port": {port} }}"#),
        );
        let d = Daemon::start(
            home,
            &[
                ("MOONLET_MOBILE_ADDRS", "127.0.0.1"),
                ("MOONLET_WORKER_PING_MS", "200"),
                ("GIT_CONFIG_GLOBAL", empty.to_str().unwrap()),
            ],
        )
        .await;
        let addr = format!("127.0.0.1:{port}");
        let mut listening = false;
        for _ in 0..40 {
            let st: Value = d.call("mobile.status", json!({})).await;
            if st["listening"]
                .as_array()
                .is_some_and(|l| l.contains(&json!(addr)))
            {
                listening = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !listening {
            continue;
        }
        let repo = d.home.path().join("src").join("shop");
        std::fs::create_dir_all(repo.parent().unwrap()).unwrap();
        git(
            repo.parent().unwrap(),
            &["clone", "-q", origin.to_str().unwrap(), "shop"],
        );
        match origin_url {
            Some(url) => git(&repo, &["remote", "set-url", "origin", url]),
            None => git(&repo, &["remote", "remove", "origin"]),
        };
        let project: Value = d.call("project.add", json!({ "path": repo })).await;
        let session: Value = d
            .call(
                "session.create",
                json!({ "project_id": project["id"], "name": "Fix cart" }),
            )
            .await;
        return Central {
            daemon: d,
            addr,
            origin,
            session,
            _scratch: scratch,
            _gate: gate,
        };
    }
    panic!("the central host never listened");
}

fn paused(s: &CopyState) -> bool {
    matches!(s, CopyState::Paused { .. })
}

fn reason(c: &Copy) -> &str {
    match &c.state {
        CopyState::Paused { reason } => reason,
        _ => "",
    }
}

/// This Mac: its git turns [`ORIGIN_URL`] into the bare origin.
async fn worker(origin: &Path) -> Daemon {
    worker_with(Some(origin)).await
}

/// [`worker`]; with no `origin`, [`ORIGIN_URL`] stays unreachable.
async fn worker_with(origin: Option<&Path>) -> Daemon {
    worker_as(
        origin,
        "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37",
        "Alex's MacBook Pro",
    )
    .await
}

/// [`worker_with`], as the worker `id` named `name`.
async fn worker_as(origin: Option<&Path>, id: &str, name: &str) -> Daemon {
    worker_env(origin, id, name, &[]).await
}

/// [`worker_as`], with more of the daemon's environment.
async fn worker_env(origin: Option<&Path>, id: &str, name: &str, extra: &[(&str, &str)]) -> Daemon {
    worker_env_with(origin, id, name, extra, None).await
}

/// [`worker_env`], with `mobile.json` when given.
async fn worker_env_with(origin: Option<&Path>, id: &str, name: &str, extra: &[(&str, &str)], mobile: Option<&str>) -> Daemon {
    let home = tempfile::tempdir().unwrap();
    if let Some(m) = mobile {
        write(&home.path().join("mobile.json"), m);
    }
    let config = home.path().join("gitconfig");
    write(
        &config,
        &origin.map_or(String::new(), |o| {
            format!("[url \"{}\"]\n\tinsteadOf = {ORIGIN_URL}\n", o.display())
        }),
    );
    write(
        &home.path().join("link.json"),
        &json!({ "central": null, "worker": { "id": id, "name": name, "enabled": false } })
            .to_string(),
    );
    let mut env = vec![
        ("MOONLET_MOBILE_ADDRS", "127.0.0.2"),
        ("GIT_CONFIG_GLOBAL", config.to_str().unwrap()),
        // ORIGIN_URL leads to a local folder through `insteadOf`.
        ("MOONLET_SYNC_LOCAL_ORIGINS", "1"),
        // Setups run in a login shell: not the user's own, with its rc
        // files.
        ("SHELL", "/bin/sh"),
        // A token in the daemon's own environment, which no setup gets.
        ("AGENT_TOKEN", "sk-leak"),
    ];
    env.extend_from_slice(extra);
    Daemon::start(home, &env).await
}

/// [`worker`], letting paired phones in on `::1`, with that address: the
/// central host has 127.0.0.1, and a Mac that listens there takes itself
/// for its central host.
async fn worker_with_phones(origin: &Path) -> (Daemon, String) {
    for _ in 0..5 {
        let port = free_port();
        let mobile = format!(r#"{{ "enabled": true, "port": {port} }}"#);
        let d = worker_env_with(
            Some(origin),
            "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37",
            "Alex's MacBook Pro",
            &[("MOONLET_MOBILE_ADDRS", "::1")],
            Some(&mobile),
        )
        .await;
        let addr = format!("[::1]:{port}");
        for _ in 0..40 {
            let st: Value = d.call("mobile.status", json!({})).await;
            if st["listening"]
                .as_array()
                .is_some_and(|l| l.contains(&json!(addr)))
            {
                return (d, addr);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    panic!("the worker never listened for phones");
}

/// Pairs `worker` with `central` and sets it as the central host, without
/// turning on heavy commands: keeping a session in sync opens the link.
async fn link(central: &Central, worker: &Daemon) {
    let p: MobilePairing = central.daemon.call("mobile.pair_start", json!({ "kind": "desktop" })).await;
    let token = moonlet_link::tailnet::pair(
        &[central.addr.clone()],
        &p.code,
        "Alex's MacBook Pro",
        DeviceKind::Desktop,
    )
    .await
    .unwrap()
    .token;
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [central.addr], "token": token } }),
        )
        .await;
}

async fn copies(worker: &Daemon) -> Vec<Copy> {
    worker.call("sync.list", json!({})).await
}

/// Waits for the only copy to be in `state`, and returns it.
async fn copy_in(worker: &Daemon, want: fn(&CopyState) -> bool, what: &str) -> Copy {
    let mut last = None;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(30) {
        let list = copies(worker).await;
        if let Some(c) = list.first()
            && want(&c.state)
        {
            return c.clone();
        }
        last = list.first().cloned();
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the copy never got {what}: {last:?}");
}

async fn in_sync(worker: &Daemon) -> Copy {
    copy_in(worker, |s| *s == CopyState::InSync, "in sync").await
}

#[tokio::test]
async fn a_copy_has_the_sessions_files_and_commit_under_copies_when_its_path_is_taken() {
    let central = central().await;
    let s = central.session_path();
    // An unpushed commit, an untracked file and an ignored one.
    write(&s.join("src/cart.ts"), "b\n");
    git(&s, &["commit", "-qam", "cart"]);
    write(&s.join("src/new.ts"), "new\n");
    write(&s.join("node_modules/left-pad/index.js"), "ignored\n");
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;

    let started: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    assert_eq!(started.host, "studio-mini");
    assert_eq!(started.session, central.session_id());
    let copy = in_sync(&worker).await;

    // Both daemons share this machine, so the session's own path is taken.
    let want = worker.home.path().join("copies/studio-mini/shop/fix-cart");
    assert_eq!(
        std::fs::canonicalize(&copy.path).unwrap(),
        std::fs::canonicalize(&want).unwrap()
    );
    let c = PathBuf::from(&copy.path);
    assert_eq!(read(&c.join("src/cart.ts")).as_deref(), Some("b\n"));
    assert_eq!(read(&c.join("src/new.ts")).as_deref(), Some("new\n"));
    assert!(!c.join("node_modules").exists(), "an ignored file synced");
    assert_eq!(
        git(&c, &["rev-parse", "HEAD"]),
        git(&s, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        git(&c, &["branch", "--show-current"]),
        central.session["branch"].as_str().unwrap()
    );
    assert!(copy.differs.is_empty(), "{copy:?}");
    // The copy opened the link; heavy commands stay off.
    let link: Value = worker.call("link.get", json!({})).await;
    assert_eq!(link["state"]["kind"], "connected", "{link}");
    assert_eq!(link["worker"]["enabled"], false, "{link}");
    // Not in the clone's project list: moonlet made it for this copy.
    let projects: Vec<Value> = worker.call("project.list", json!({})).await;
    assert!(projects.is_empty(), "{projects:?}");
    assert!(
        worker
            .home
            .path()
            .join("clones/git.invalid/4d1d250ce91ee1c7/.git")
            .is_dir()
    );
}

/// A central host with a session, and a worker with an in-sync copy of it.
async fn synced() -> (Central, Daemon, PathBuf) {
    synced_to(central().await).await
}

/// [`synced`], with no other test of this file running meanwhile.
async fn synced_alone() -> (Central, Daemon, PathBuf) {
    synced_to(central_alone().await).await
}

#[tokio::test]
async fn a_copy_started_before_this_mac_is_registered_waits_for_it() {
    let central = central().await;
    // Linked, this Mac takes two seconds to register (X68 opens the link
    // before any copy starts, so a copy can start in that gap).
    let worker = worker_env(Some(&central.origin), "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37", "Alex's MacBook Pro", &[("MOONLET_TEST_REGISTER_DELAY_MS", "2000")]).await;
    link(&central, &worker).await;
    let start = Instant::now();
    loop {
        let info: Value = worker.call("link.get", json!({})).await;
        if info["state"]["kind"] == "connected" {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(15), "never connected: {info}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let _: Copy = worker.call("sync.start", json!({ "session": central.session_id() })).await;
    in_sync(&worker).await;
}

async fn synced_to(central: Central) -> (Central, Daemon, PathBuf) {
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let copy = in_sync(&worker).await;
    (central, worker, PathBuf::from(copy.path))
}

/// Waits until `path` reads `want`; returns how long that took.
async fn reads(path: &Path, want: &str) -> Duration {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(30) {
        if read(path).as_deref() == Some(want) {
            return start.elapsed();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{} never read {want:?}: {:?}", path.display(), read(path));
}

/// How long an edit may take to reach the other side: 1 s, or 1.5 s on a
/// CI runner, whose shared machines run a few tenths of a second behind.
fn budget() -> Duration {
    if std::env::var_os("CI").is_some() {
        Duration::from_millis(1500)
    } else {
        Duration::from_secs(1)
    }
}

/// X62: a Mac linked for a live copy that turns on heavy commands is told
/// to the central host at once, not at its next link.
#[tokio::test]
async fn turning_on_heavy_commands_while_linked_for_a_copy_tells_the_central_host() {
    let (central, worker, _) = synced().await;
    let heavy = || async {
        let list: Value = central.daemon.call("worker.list", json!({})).await;
        list[0]["heavy"].clone()
    };
    assert_eq!(heavy().await, json!(false));
    let _: Value = worker
        .call("link.set", json!({ "worker": { "enabled": true } }))
        .await;
    eventually("the central host sees heavy commands on", || async {
        heavy().await == json!(true)
    })
    .await;
}

#[tokio::test]
async fn an_edit_on_the_central_host_shows_in_the_copy_within_a_second() {
    let (central, _worker, c) = synced_alone().await;
    let s = central.session_path();
    write(&s.join("node_modules/left-pad/index.js"), "ignored\n");
    write(&s.join("src/cart.ts"), "c\n");
    let took = reads(&c.join("src/cart.ts"), "c\n").await;
    assert!(took < budget(), "took {took:?}");
    assert!(!c.join("node_modules").exists(), "an ignored file synced");

    // A new file and a deleted one.
    write(&s.join("docs/notes.md"), "notes\n");
    std::fs::remove_file(s.join("src/cart.ts")).unwrap();
    reads(&c.join("docs/notes.md"), "notes\n").await;
    eventually("the deletion reaches the copy", || async {
        !c.join("src/cart.ts").exists()
    })
    .await;
}

#[tokio::test]
async fn an_edit_in_the_copy_reaches_the_central_host_within_a_second() {
    let (central, worker, c) = synced_alone().await;
    let s = central.session_path();
    write(&c.join("node_modules/left-pad/index.js"), "ignored\n");
    write(&c.join("src/cart.ts"), "from the mac\n");
    let took = reads(&s.join("src/cart.ts"), "from the mac\n").await;
    assert!(took < budget(), "took {took:?}");
    assert!(!s.join("node_modules").exists(), "an ignored file synced");

    // A new file and a deleted one.
    write(&c.join("docs/notes.md"), "notes\n");
    std::fs::remove_file(c.join("src/cart.ts")).unwrap();
    reads(&s.join("docs/notes.md"), "notes\n").await;
    eventually("the deletion reaches the central host", || async {
        !s.join("src/cart.ts").exists()
    })
    .await;
    eventually("nothing differs", || async {
        let c = copies(&worker).await;
        c[0].differs.is_empty() && c[0].state == CopyState::InSync
    })
    .await;
}

/// The next `sync.changed` on `events` within `wait`.
async fn next_change(events: &mut Client, wait: Duration) -> Option<Value> {
    use moonlet_proto::{Frame, Message};
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let f = tokio::time::timeout_at(deadline, events.next_frame())
            .await
            .ok()?
            .unwrap()?;
        if let Frame::Json(Message::Event { name, data }) = f
            && name == "sync.changed"
        {
            return Some(data);
        }
    }
}

#[tokio::test]
async fn a_change_applied_on_one_side_is_not_sent_back() {
    let (central, worker, c) = synced().await;
    let s = central.session_path();
    let mut events = worker.app().await;
    let _: Value = events.request("daemon.info", json!({})).await.unwrap();

    write(&c.join("src/cart.ts"), "from the mac\n");
    reads(&s.join("src/cart.ts"), "from the mac\n").await;
    write(&s.join("docs/notes.md"), "from studio-mini\n");
    reads(&c.join("docs/notes.md"), "from studio-mini\n").await;
    // The rounds those made settle, within 10 s.
    let start = Instant::now();
    while next_change(&mut events, Duration::from_secs(1))
        .await
        .is_some()
    {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "the copy never settled"
        );
    }
    // Then nothing goes back and forth.
    let echo = next_change(&mut events, Duration::from_secs(2)).await;
    assert_eq!(echo, None, "a round after both sides agreed");
    assert_eq!(copies(&worker).await[0].state, CopyState::InSync);
    assert_eq!(
        read(&s.join("src/cart.ts")).as_deref(),
        Some("from the mac\n")
    );
    assert_eq!(
        read(&c.join("docs/notes.md")).as_deref(),
        Some("from studio-mini\n")
    );
}

#[tokio::test]
async fn a_file_both_sides_change_differs_until_one_version_is_kept() {
    let (mut central, worker, c) = synced().await;
    let s = central.session_path();
    // Both edit src/cart.ts differently; each also changes a file alone.
    central.daemon.stop();
    copy_in(&worker, |s| *s == CopyState::Waiting, "waiting").await;
    write(&c.join("src/cart.ts"), "mine\n");
    write(&c.join("src/local.ts"), "local\n");
    write(&s.join("src/cart.ts"), "theirs\n");
    write(&s.join("docs/new.md"), "new\n");
    central.daemon.restart().await;

    reads(&c.join("docs/new.md"), "new\n").await;
    reads(&s.join("src/local.ts"), "local\n").await;
    let copy = copy_in(&worker, |s| *s == CopyState::InSync, "in sync").await;
    eventually("src/cart.ts differs", || async {
        copies(&worker).await[0].differs == ["src/cart.ts"]
    })
    .await;
    // Neither version was lost.
    assert_eq!(read(&c.join("src/cart.ts")).as_deref(), Some("mine\n"));
    assert_eq!(read(&s.join("src/cart.ts")).as_deref(), Some("theirs\n"));

    // Later edits elsewhere still sync both ways, and the file still differs.
    write(&s.join("docs/new.md"), "newer\n");
    reads(&c.join("docs/new.md"), "newer\n").await;
    assert_eq!(read(&c.join("src/cart.ts")).as_deref(), Some("mine\n"));
    assert_eq!(copies(&worker).await[0].differs, ["src/cart.ts"]);

    // Keep studio-mini's: both have "theirs".
    let kept: Copy = worker
        .call(
            "sync.resolve",
            json!({ "copy": copy.id, "path": "src/cart.ts", "keep": "central" }),
        )
        .await;
    assert!(kept.differs.is_empty(), "{kept:?}");
    reads(&c.join("src/cart.ts"), "theirs\n").await;
    assert_eq!(read(&s.join("src/cart.ts")).as_deref(), Some("theirs\n"));

    // Again, keeping this Mac's.
    central.daemon.stop();
    copy_in(&worker, |s| *s == CopyState::Waiting, "waiting").await;
    write(&c.join("src/cart.ts"), "mine again\n");
    write(&s.join("src/cart.ts"), "theirs again\n");
    central.daemon.restart().await;
    eventually("src/cart.ts differs again", || async {
        copies(&worker).await[0].differs == ["src/cart.ts"]
    })
    .await;
    let kept: Copy = worker
        .call(
            "sync.resolve",
            json!({ "copy": copy.id, "path": "src/cart.ts", "keep": "worker" }),
        )
        .await;
    assert!(kept.differs.is_empty(), "{kept:?}");
    reads(&s.join("src/cart.ts"), "mine again\n").await;
    assert_eq!(
        read(&c.join("src/cart.ts")).as_deref(),
        Some("mine again\n")
    );
}

/// The copy offers an edit to one file while the central host's daemon is
/// frozen; before the central host answers, both sides edit another file.
/// The answer brings the central host's version of that file, which the
/// copy's newer edit was not made on: both edits must count, and differ.
#[tokio::test]
async fn an_edit_kept_through_an_answer_still_differs_from_the_central_hosts() {
    let (central, worker, c) = synced().await;
    let s = central.session_path();
    let pid = nix::unistd::Pid::from_raw(central.daemon.child.id() as i32);
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGSTOP).unwrap();
    // The copy's offer of notes.md waits on the frozen central host.
    write(&c.join("notes.md"), "notes\n");
    copy_in(
        &worker,
        |s| matches!(s, CopyState::Syncing { .. }),
        "offering",
    )
    .await;
    write(&s.join("src/cart.ts"), "the agent's\n");
    write(&c.join("src/cart.ts"), "mine\n");
    tokio::time::sleep(Duration::from_millis(300)).await;
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGCONT).unwrap();

    reads(&s.join("notes.md"), "notes\n").await;
    eventually("src/cart.ts differs", || async {
        copies(&worker).await[0].differs == ["src/cart.ts"]
    })
    .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(copies(&worker).await[0].differs, ["src/cart.ts"]);
    assert_eq!(read(&c.join("src/cart.ts")).as_deref(), Some("mine\n"));
    assert_eq!(
        read(&s.join("src/cart.ts")).as_deref(),
        Some("the agent's\n")
    );
}

#[tokio::test]
async fn while_the_link_is_down_the_copy_waits_and_then_catches_up() {
    let (mut central, worker, c) = synced().await;
    let s = central.session_path();
    central.daemon.stop();
    copy_in(&worker, |s| *s == CopyState::Waiting, "waiting").await;
    // The agent keeps working while the link is down.
    write(&s.join("src/cart.ts"), "while away\n");
    central.daemon.restart().await;
    reads(&c.join("src/cart.ts"), "while away\n").await;
    in_sync(&worker).await;
}

#[tokio::test]
async fn edits_on_both_sides_while_the_link_is_down_reach_both_sides() {
    let (mut central, worker, c) = synced().await;
    let s = central.session_path();
    central.daemon.stop();
    copy_in(&worker, |s| *s == CopyState::Waiting, "waiting").await;
    write(&c.join("docs/train.md"), "written offline\n");
    std::fs::remove_file(c.join(".gitignore")).unwrap();
    write(&s.join("src/cart.ts"), "the agent's\n");
    central.daemon.restart().await;

    reads(&s.join("docs/train.md"), "written offline\n").await;
    reads(&c.join("src/cart.ts"), "the agent's\n").await;
    eventually("the deletion reaches the central host", || async {
        !s.join(".gitignore").exists()
    })
    .await;
    let copy = in_sync(&worker).await;
    assert!(copy.differs.is_empty(), "{copy:?}");
}

#[tokio::test]
async fn two_macs_keeping_one_session_in_sync_each_get_the_others_edits() {
    let (central, pro, c1) = synced().await;
    let air = worker_as(
        Some(&central.origin),
        "5b0c7a3e-0d7e-4a51-8f1e-6c2b9a4d3e10",
        "Alex's MacBook Air",
    )
    .await;
    link(&central, &air).await;
    let _: Copy = air
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let c2 = PathBuf::from(in_sync(&air).await.path);
    assert_ne!(c1, c2);
    let s = central.session_path();

    // An edit on studio-mini reaches both Macs.
    write(&s.join("src/cart.ts"), "the agent's\n");
    reads(&c1.join("src/cart.ts"), "the agent's\n").await;
    reads(&c2.join("src/cart.ts"), "the agent's\n").await;

    // An edit on one Mac reaches the other, through studio-mini.
    write(&c1.join("docs/pro.md"), "from the Pro\n");
    reads(&s.join("docs/pro.md"), "from the Pro\n").await;
    reads(&c2.join("docs/pro.md"), "from the Pro\n").await;
    write(&c2.join("docs/air.md"), "from the Air\n");
    reads(&c1.join("docs/air.md"), "from the Air\n").await;
    assert!(copies(&pro).await[0].differs.is_empty());
    assert!(copies(&air).await[0].differs.is_empty());
}

#[tokio::test]
async fn a_live_upgrade_of_the_central_host_loses_no_edit() {
    let (central, worker, c) = synced().await;
    let s = central.session_path();
    write(&c.join("docs/before.md"), "before the upgrade\n");
    reads(&s.join("docs/before.md"), "before the upgrade\n").await;

    write(&c.join("docs/during.md"), "during the upgrade\n");
    let status = Command::new(env!("CARGO_BIN_EXE_moonletd"))
        .arg("upgrade")
        .env("MOONLET_HOME", central.daemon.home.path())
        .env("MOONLET_SOCK", &central.daemon.socket)
        .envs(
            central
                .daemon
                .env
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str())),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "moonletd upgrade failed");
    write(&s.join("src/cart.ts"), "after the upgrade\n");

    reads(&s.join("docs/during.md"), "during the upgrade\n").await;
    reads(&c.join("src/cart.ts"), "after the upgrade\n").await;
    write(&c.join("docs/after.md"), "after it too\n");
    reads(&s.join("docs/after.md"), "after it too\n").await;
    assert!(in_sync(&worker).await.differs.is_empty());

    // The upgraded daemon is not the test's child.
    let mut app = central.daemon.app().await;
    let info: Value = app.request("daemon.info", json!({})).await.unwrap();
    let _: Value = app
        .request("daemon.shutdown", json!({}))
        .await
        .unwrap_or(Value::Null);
    std::thread::sleep(Duration::from_millis(300));
    let _ = Command::new("kill").arg(info["pid"].to_string()).status();
}

#[tokio::test]
async fn a_restarted_worker_resumes_its_copy() {
    let (central, mut worker, c) = synced().await;
    let s = central.session_path();
    worker.restart().await;
    in_sync(&worker).await;
    write(&s.join("src/cart.ts"), "after the restart\n");
    reads(&c.join("src/cart.ts"), "after the restart\n").await;
    assert_eq!(copies(&worker).await.len(), 1);
}

#[tokio::test]
async fn a_copy_not_made_yet_waits_after_a_restart_while_its_host_is_away() {
    let scratch = tempfile::tempdir().unwrap();
    let mut worker = worker(&origin(scratch.path())).await;
    // A central host nobody answers for.
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": ["127.0.0.1:9"], "token": "ab".repeat(32) } }),
        )
        .await;
    let _: Copy = worker.call("sync.start", json!({ "session": "s1" })).await;
    worker.restart().await;
    let list = copies(&worker).await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].state, CopyState::Waiting, "{list:?}");
}

#[tokio::test]
async fn a_copy_never_reads_in_sync_once_its_link_is_closed() {
    let (_central, worker, _c) = synced().await;
    let _: Value = worker.call("link.set", json!({ "central": null })).await;
    let list = copies(&worker).await;
    assert_ne!(list[0].state, CopyState::InSync, "{list:?}");
}

#[tokio::test]
async fn a_clone_that_fails_pauses_the_copy_with_gits_message() {
    let central = central().await;
    let missing = central.origin.with_file_name("missing.git");
    let worker = worker(&missing).await;
    link(&central, &worker).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let copy = copy_in(&worker, paused, "paused").await;
    assert_eq!(
        reason(&copy),
        format!(
            "cannot clone git.invalid/acme/shop: '{}' does not appear to be a git repository",
            missing.display()
        )
    );
    assert!(
        !worker
            .home
            .path()
            .join("clones/git.invalid/4d1d250ce91ee1c7")
            .exists()
    );

    // Retrying tries again, and says why again.
    let again: Copy = worker.call("sync.retry", json!({ "copy": copy.id })).await;
    assert_eq!(again.state, CopyState::Copying);
    let copy = copy_in(&worker, paused, "paused again").await;
    assert!(
        reason(&copy).starts_with("cannot clone git.invalid/acme/shop: "),
        "{copy:?}"
    );
}

#[tokio::test]
async fn an_origin_this_mac_does_not_clone_from_pauses_the_copy() {
    // Only https and ssh: the URL comes from the central host.
    let central = central_with(Some("git://git.example.com/acme/shop.git")).await;
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let copy = copy_in(&worker, paused, "paused").await;
    assert_eq!(
        reason(&copy),
        "cannot clone git.example.com/acme/shop: only https and ssh origins are cloned: git://git.example.com/acme/shop.git"
    );
}

#[tokio::test]
async fn a_project_without_an_origin_must_be_added_on_this_mac_first() {
    let central = central_with(None).await;
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let copy = copy_in(&worker, paused, "paused").await;
    assert_eq!(
        reason(&copy),
        "add shop on this Mac first. studio-mini's shop has no origin to clone from."
    );
}

#[tokio::test]
async fn a_mac_with_the_project_keeps_the_copy_in_its_own_clone_out_of_its_worktree_list() {
    let central = central().await;
    // This Mac cannot reach origin, but has its own clone of the project.
    let worker = worker_with(None).await;
    let repo = worker.home.path().join("src/shop");
    std::fs::create_dir_all(repo.parent().unwrap()).unwrap();
    git(
        repo.parent().unwrap(),
        &["clone", "-q", central.origin.to_str().unwrap(), "shop"],
    );
    git(&repo, &["remote", "set-url", "origin", ORIGIN_URL]);
    let project: Value = worker.call("project.add", json!({ "path": repo })).await;
    let s = central.session_path();
    write(&s.join("src/cart.ts"), "b\n");
    git(&s, &["commit", "-qam", "cart"]);
    link(&central, &worker).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let copy = in_sync(&worker).await;
    let c = PathBuf::from(&copy.path);
    assert_eq!(read(&c.join("src/cart.ts")).as_deref(), Some("b\n"));
    assert_eq!(
        git(&c, &["rev-parse", "HEAD"]),
        git(&s, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        std::fs::canonicalize(git(
            &c,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"]
        ))
        .unwrap(),
        std::fs::canonicalize(repo.join(".git")).unwrap()
    );
    assert!(!worker.home.path().join("clones").exists());
    let worktrees: Vec<Value> = worker
        .call("project.worktrees", json!({ "id": project["id"] }))
        .await;
    assert!(worktrees.is_empty(), "{worktrees:?}");
}

#[tokio::test]
async fn a_branch_checked_out_on_this_mac_pauses_the_copy() {
    let central = central().await;
    let worker = worker_with(None).await;
    let repo = worker.home.path().join("src/shop");
    std::fs::create_dir_all(repo.parent().unwrap()).unwrap();
    git(
        repo.parent().unwrap(),
        &["clone", "-q", central.origin.to_str().unwrap(), "shop"],
    );
    git(&repo, &["remote", "set-url", "origin", ORIGIN_URL]);
    let branch = central.session["branch"].as_str().unwrap();
    git(&repo, &["checkout", "-q", "-b", branch]);
    let _: Value = worker.call("project.add", json!({ "path": repo })).await;
    link(&central, &worker).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let copy = copy_in(&worker, paused, "paused").await;
    // The scratch folder is outside the home folder, so no `~` here.
    let there = std::fs::canonicalize(&repo).unwrap();
    assert_eq!(
        reason(&copy),
        format!(
            "moonlet/fix-cart is checked out in {} on this Mac.",
            there.display()
        )
    );
}

/// This Mac's own clone of `shop`, with the session's branch,
/// `moonlet/fix-cart`, made by `setup` and not checked out.
async fn own_clone(central: &Central, worker: &Daemon, setup: &[&[&str]]) -> PathBuf {
    let repo = worker.home.path().join("src/shop");
    std::fs::create_dir_all(repo.parent().unwrap()).unwrap();
    git(
        repo.parent().unwrap(),
        &["clone", "-q", central.origin.to_str().unwrap(), "shop"],
    );
    git(&repo, &["remote", "set-url", "origin", ORIGIN_URL]);
    for args in setup {
        git(&repo, args);
    }
    let _: Value = worker.call("project.add", json!({ "path": repo })).await;
    repo
}

#[tokio::test]
async fn a_branch_on_this_mac_with_commits_of_its_own_pauses_the_copy_and_stays() {
    let central = central().await;
    let worker = worker_with(None).await;
    let s = central.session_path();
    write(&s.join("src/cart.ts"), "b\n");
    git(&s, &["commit", "-qam", "cart"]);
    let repo = own_clone(
        &central,
        &worker,
        &[
            &["checkout", "-q", "-b", "moonlet/fix-cart"],
            &["commit", "-q", "--allow-empty", "-m", "mine"],
            &["checkout", "-q", "main"],
        ],
    )
    .await;
    let mine = git(&repo, &["rev-parse", "moonlet/fix-cart"]);
    link(&central, &worker).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let copy = copy_in(&worker, paused, "paused").await;
    assert_eq!(
        reason(&copy),
        "moonlet/fix-cart on this Mac has commits studio-mini's doesn't."
    );
    assert_eq!(git(&repo, &["rev-parse", "moonlet/fix-cart"]), mine);
}

#[tokio::test]
async fn a_branch_on_this_mac_behind_the_sessions_moves_up_to_it() {
    let central = central().await;
    let worker = worker_with(None).await;
    let s = central.session_path();
    write(&s.join("src/cart.ts"), "b\n");
    git(&s, &["commit", "-qam", "cart"]);
    let repo = own_clone(
        &central,
        &worker,
        &[&["branch", "moonlet/fix-cart", "main"]],
    )
    .await;
    link(&central, &worker).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let copy = in_sync(&worker).await;
    let head = git(&s, &["rev-parse", "HEAD"]);
    assert_eq!(
        git(&PathBuf::from(&copy.path), &["rev-parse", "HEAD"]),
        head
    );
    assert_eq!(git(&repo, &["rev-parse", "moonlet/fix-cart"]), head);
}

fn mktree(repo: &Path, listing: &str) -> String {
    use std::io::Write;
    let mut child = Command::new("git")
        .args(["mktree"])
        .current_dir(repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(listing.as_bytes())
        .unwrap();
    String::from_utf8(child.wait_with_output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_string()
}

/// What a central host with no changes of its own answers an offer: the
/// worker's files as they are, now the base.
fn took_offer(offer: &Value) -> Value {
    json!({
        "from": "", "tree": offer["tree"], "base": offer["tree"], "head": offer["head"],
        "differs": [], "too_big": [], "pack": null,
    })
}

/// A fake central host serving one session (the clone `repo`, on branch
/// `fix-cart`) that, once the copy is made, sends an update whose tree
/// holds `..`: a path outside the copy.
async fn hostile_central(repo: PathBuf, go: std::sync::Arc<tokio::sync::Notify>) -> String {
    fake_central(repo, Update::Outside, Default::default(), go).await
}

/// What [`fake_central`] sends once the copy is made.
enum Update {
    /// A tree with `../escaped.txt`.
    Outside,
    /// `src/cart.ts` as `c`, against a base the worker never had, as when
    /// the central host missed the worker's last reply.
    StaleBase,
    /// `src/cart.ts` as `c`.
    Edit,
    /// A tree id that is no object id at all.
    BadId,
    /// No update; the first offers are turned away as `busy`, as many as
    /// the count, and the one taken lands in `seen`.
    OffersBusy(std::sync::Arc<std::sync::atomic::AtomicUsize>),
    /// Offers are turned away until `src/cart.ts` as `c` is sent; the
    /// worker's first reply lands in `seen`, and no update follows it.
    EditWhileOffersWait,
}

/// A fake central host serving one session (the clone `repo`, on branch
/// `fix-cart`). It sends its update once `go` is notified, and the worker's
/// reply to it goes in `seen`.
async fn fake_central(
    repo: PathBuf,
    update: Update,
    seen: std::sync::Arc<std::sync::Mutex<Option<Value>>>,
    go: std::sync::Arc<tokio::sync::Notify>,
) -> String {
    use moonlet_proto::{Frame, Message, read_frame, write_frame};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        let _auth = read_frame(&mut s).await.unwrap();
        let authed = Message::Authed {
            device_id: "d1".into(),
            token: None,
            protocol: Some(moonlet_proto::PROTOCOL_VERSION),
            daemon_version: Some(env!("CARGO_PKG_VERSION").into()),
            host: Some("studio-mini".into()),
            os: Some("macos".into()),
        };
        write_frame(&mut s, &Frame::Json(authed)).await.unwrap();
        let _hello = read_frame(&mut s).await.unwrap();
        let welcome = Message::Welcome {
            protocol: moonlet_proto::PROTOCOL_VERSION,
            daemon_version: env!("CARGO_PKG_VERSION").into(),
            host: "studio-mini".into(),
            pid: 1,
        };
        write_frame(&mut s, &Frame::Json(welcome)).await.unwrap();
        let head = git(&repo, &["rev-parse", "HEAD"]);
        let tree = git(&repo, &["rev-parse", "HEAD^{tree}"]);
        let root = git(&repo, &["rev-list", "--max-parents=0", "HEAD"]);
        let mut copy_id = String::new();
        let mut updated = false;
        let busy = || moonlet_proto::RpcError::new("busy", "not now");
        while let Ok(Some(frame)) = read_frame(&mut s).await {
            let Frame::Json(Message::Request { id, method, params }) = frame else {
                continue;
            };
            if let Some(c) = params["copy"].as_str() {
                copy_id = c.to_string();
            }
            let reply = match method.as_str() {
                "sync.open" => Ok(json!({
                    "path": repo.join("fix-cart"), "branch": "fix-cart", "head": head,
                    "name": "Fix cart", "project": "shop",
                    "identity": { "origin": "git.invalid/acme/shop", "root": root },
                    "origin_url": ORIGIN_URL,
                })),
                "sync.fetch" => {
                    Ok(json!({ "tree": tree, "head": head, "too_big": [], "pack": null }))
                }
                "sync.offer" => match &update {
                    Update::OffersBusy(left)
                        if left.load(std::sync::atomic::Ordering::SeqCst) > 0 =>
                    {
                        left.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                        Err(busy())
                    }
                    Update::OffersBusy(_) => {
                        *seen.lock().unwrap() = Some(params.clone());
                        Ok(took_offer(&params))
                    }
                    Update::EditWhileOffersWait if !updated => Err(busy()),
                    _ => Ok(took_offer(&params)),
                },
                _ => Ok(json!({})),
            };
            let reply = match reply {
                Ok(v) => Message::ok(id, v),
                Err(e) => Message::err(id, e),
            };
            write_frame(&mut s, &Frame::Json(reply)).await.unwrap();
            if method != "sync.fetch" || updated || matches!(update, Update::OffersBusy(_)) {
                continue;
            }
            let listing = git(&repo, &["ls-tree", "HEAD"]);
            let (bad, sub, base) = match update {
                Update::Outside => {
                    // `../escaped.txt` next to the session's own files.
                    let blob = git(&repo, &["rev-parse", "HEAD:src/cart.ts"]);
                    let sub = mktree(&repo, &format!("100644 blob {blob}\tescaped.txt\n"));
                    let bad = mktree(&repo, &format!("{listing}\n040000 tree {sub}\t..\n"));
                    (bad, sub, tree.clone())
                }
                Update::OffersBusy(_) => unreachable!("no update"),
                Update::StaleBase | Update::Edit | Update::BadId | Update::EditWhileOffersWait => {
                    write(&repo.join("c.txt"), "c\n");
                    let blob = git(&repo, &["hash-object", "-w", "c.txt"]);
                    let src = mktree(&repo, &format!("100644 blob {blob}\tcart.ts\n"));
                    let others: String = listing
                        .lines()
                        .filter(|l| !l.ends_with("\tsrc"))
                        .map(|l| format!("{l}\n"))
                        .collect();
                    let new = mktree(&repo, &format!("{others}040000 tree {src}\tsrc\n"));
                    match update {
                        // The empty tree: a base this copy never had.
                        Update::StaleBase => (
                            new,
                            format!("{src}\n{blob}"),
                            "4b825dc642cb6eb9a060e54bf8d69288fbee4904".to_string(),
                        ),
                        Update::Edit | Update::EditWhileOffersWait => {
                            (new, format!("{src}\n{blob}"), tree.clone())
                        }
                        _ => ("--output=/tmp/x".to_string(), src, tree.clone()),
                    }
                }
            };
            let pack = {
                let mut child = Command::new("git")
                    .args(["pack-objects", "--stdout", "-q"])
                    .current_dir(&repo)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .spawn()
                    .unwrap();
                use std::io::Write;
                child
                    .stdin
                    .take()
                    .unwrap()
                    .write_all(format!("{bad}\n{sub}\n").as_bytes())
                    .unwrap();
                child.wait_with_output().unwrap().stdout
            };
            // The test opens the gate once it has seen the copy made.
            go.notified().await;
            // The first reply is the one asked about: no update follows it.
            let once = matches!(update, Update::EditWhileOffersWait);
            // Until the copy is made, the worker answers `copying`, or that
            // it didn't apply the update while it is busy making it.
            for try_id in 1u64..200 {
                for f in moonlet_proto::pack_frames(try_id as u32, &pack) {
                    write_frame(&mut s, &f).await.unwrap();
                }
                let update = json!({ "copy": copy_id, "base": base, "tree": bad, "head": head, "too_big": [], "pack": try_id });
                write_frame(
                    &mut s,
                    &Frame::Json(Message::Request {
                        id: try_id,
                        method: "sync.update".into(),
                        params: update,
                    }),
                )
                .await
                .unwrap();
                let (result, error) = loop {
                    match read_frame(&mut s).await {
                        Ok(Some(Frame::Json(Message::Response { id, result, error })))
                            if id == try_id =>
                        {
                            break (result, error);
                        }
                        // An offer the worker makes meanwhile. A real central
                        // host would answer it with its own change; this one
                        // turns it away until its update is in, unless the
                        // first reply is all it asks about.
                        Ok(Some(Frame::Json(Message::Request { id, method, params }))) => {
                            let reply = if method == "sync.offer" && once {
                                Message::ok(id, took_offer(&params))
                            } else {
                                Message::err(id, moonlet_proto::RpcError::new("busy", "not now"))
                            };
                            write_frame(&mut s, &Frame::Json(reply)).await.unwrap();
                        }
                        Ok(Some(_)) => {}
                        _ => return,
                    }
                };
                let not_yet = error.as_ref().is_some_and(|e| e.code == "copying")
                    || result
                        .as_ref()
                        .is_some_and(|r| r["applied"] == json!(false));
                if not_yet && !once {
                    // Turn the worker's offers away (it backs off and lets go
                    // of the copy), and send again once it has been quiet a
                    // while.
                    loop {
                        let next =
                            tokio::time::timeout(Duration::from_millis(300), read_frame(&mut s))
                                .await;
                        match next {
                            Err(_) => break,
                            Ok(Ok(Some(Frame::Json(Message::Request { id, .. })))) => {
                                let reply = Message::err(
                                    id,
                                    moonlet_proto::RpcError::new("busy", "not now"),
                                );
                                write_frame(&mut s, &Frame::Json(reply)).await.unwrap();
                            }
                            Ok(Ok(Some(_))) => {}
                            Ok(_) => return,
                        }
                    }
                    continue;
                }
                *seen.lock().unwrap() = Some(json!({ "result": result, "error": error }));
                updated = true;
                break;
            }
        }
    });
    addr
}

#[tokio::test]
async fn an_update_reaching_outside_the_copy_pauses_it_and_writes_nothing() {
    let _gate = GATE.read().await;
    let scratch = tempfile::tempdir().unwrap();
    let origin = origin(scratch.path());
    let repo = scratch.path().join("studio-mini-shop");
    git(
        scratch.path(),
        &["clone", "-q", origin.to_str().unwrap(), "studio-mini-shop"],
    );
    let go = std::sync::Arc::new(tokio::sync::Notify::new());
    let addr = hostile_central(repo.clone(), go.clone()).await;
    let worker = worker(&origin).await;
    let token = "ab".repeat(32);
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": token } }),
        )
        .await;
    let _: Copy = worker.call("sync.start", json!({ "session": "s1" })).await;
    in_sync(&worker).await;
    go.notify_one();
    let copy = copy_in(&worker, paused, "paused").await;
    assert_eq!(reason(&copy), "studio-mini sent a path outside the copy.");
    let c = PathBuf::from(&copy.path);
    assert!(!c.parent().unwrap().join("escaped.txt").exists());
    assert_eq!(read(&c.join("src/cart.ts")).as_deref(), Some("a\n"));
}

#[tokio::test]
async fn an_update_against_a_base_the_copy_never_had_applies_while_the_copy_is_unchanged() {
    let _gate = GATE.read().await;
    let scratch = tempfile::tempdir().unwrap();
    let origin = origin(scratch.path());
    let repo = scratch.path().join("studio-mini-shop");
    git(
        scratch.path(),
        &["clone", "-q", origin.to_str().unwrap(), "studio-mini-shop"],
    );
    let reply = std::sync::Arc::new(std::sync::Mutex::new(None));
    let go = std::sync::Arc::new(tokio::sync::Notify::new());
    let addr = fake_central(repo.clone(), Update::StaleBase, reply.clone(), go.clone()).await;
    let worker = worker(&origin).await;
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": "ab".repeat(32) } }),
        )
        .await;
    let _: Copy = worker.call("sync.start", json!({ "session": "s1" })).await;
    let copy = in_sync(&worker).await;
    go.notify_one();
    let c = PathBuf::from(&copy.path);
    reads(&c.join("src/cart.ts"), "c\n").await;
    eventually("the worker replies", || async {
        reply.lock().unwrap().is_some()
    })
    .await;
    let got = reply.lock().unwrap().clone().unwrap();
    assert_eq!(got["error"], Value::Null, "{got}");
    // The copy's own files were its base, so it took the update.
    assert_eq!(got["result"]["applied"], json!(true), "{got}");
    assert_eq!(copies(&worker).await[0].differs, Vec::<String>::new());
}

/// A worker linked to `fake_central` serving a clone of `origin`, with a
/// copy started; the worker's reply to the central host's update lands in
/// the returned slot.
async fn worker_of_fake(
    scratch: &Path,
    update: Update,
) -> (Daemon, std::sync::Arc<std::sync::Mutex<Option<Value>>>) {
    let origin = origin(scratch);
    let repo = scratch.join("studio-mini-shop");
    git(
        scratch,
        &["clone", "-q", origin.to_str().unwrap(), "studio-mini-shop"],
    );
    let reply = std::sync::Arc::new(std::sync::Mutex::new(None));
    let go = std::sync::Arc::new(tokio::sync::Notify::new());
    let addr = fake_central(repo, update, reply.clone(), go.clone()).await;
    let worker = worker(&origin).await;
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": "ab".repeat(32) } }),
        )
        .await;
    let _: Copy = worker.call("sync.start", json!({ "session": "s1" })).await;
    in_sync(&worker).await;
    go.notify_one();
    eventually("the worker replies", || async {
        reply.lock().unwrap().is_some()
    })
    .await;
    (worker, reply)
}

#[tokio::test]
async fn an_update_that_fails_leaves_the_copy_as_it_was_not_syncing() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = tempfile::tempdir().unwrap();
    let gate = std::sync::Arc::new(tokio::sync::Notify::new());
    let origin = origin(scratch.path());
    let repo = scratch.path().join("studio-mini-shop");
    git(
        scratch.path(),
        &["clone", "-q", origin.to_str().unwrap(), "studio-mini-shop"],
    );
    let reply = std::sync::Arc::new(std::sync::Mutex::new(None));
    let addr = fake_central(repo, Update::Edit, reply.clone(), gate.clone()).await;
    let worker = worker(&origin).await;
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": "ab".repeat(32) } }),
        )
        .await;
    let _: Copy = worker.call("sync.start", json!({ "session": "s1" })).await;
    let copy = in_sync(&worker).await;
    // git cannot replace src/cart.ts in a folder it may not write.
    let src = PathBuf::from(&copy.path).join("src");
    std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o555)).unwrap();
    gate.notify_one();
    eventually("the worker replies", || async {
        reply.lock().unwrap().is_some()
    })
    .await;
    std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o755)).unwrap();
    let got = reply.lock().unwrap().clone().unwrap();
    assert_ne!(got["error"], Value::Null, "{got}");
    let copies: Vec<Copy> = worker.call("sync.list", json!({})).await;
    assert!(
        matches!(copies[0].state, CopyState::InSync),
        "{:?}",
        copies[0].state
    );
    assert_eq!(read(&src.join("cart.ts")).as_deref(), Some("a\n"));
}

#[tokio::test]
async fn an_update_naming_no_object_id_is_refused() {
    let scratch = tempfile::tempdir().unwrap();
    let (_worker, reply) = worker_of_fake(scratch.path(), Update::BadId).await;
    let got = reply.lock().unwrap().clone().unwrap();
    assert_eq!(got["error"]["code"], "invalid_params", "{got}");
    assert_eq!(
        got["error"]["message"], "not an object id: --output=/tmp/x",
        "{got}"
    );
}

#[tokio::test]
async fn two_starts_at_once_make_one_copy() {
    let central = central().await;
    let worker = worker_with(None).await;
    link(&central, &worker).await;
    let session = central.session_id();
    let (mut a, mut b) = (worker.app().await, worker.app().await);
    let (x, y) = tokio::join!(
        a.request::<_, Copy>("sync.start", json!({ "session": session })),
        b.request::<_, Copy>("sync.start", json!({ "session": session })),
    );
    assert_eq!(x.unwrap().id, y.unwrap().id);
    let copies: Vec<Copy> = worker.call("sync.list", json!({})).await;
    assert_eq!(copies.len(), 1);
}

/// A worker linked to a `fake_central` that sends no update and turns its
/// first `busy` offers away; the offer it takes lands in the returned slot.
async fn worker_turned_away(
    scratch: &Path,
    busy: usize,
) -> (
    Daemon,
    Copy,
    std::sync::Arc<std::sync::Mutex<Option<Value>>>,
) {
    let origin = origin(scratch);
    git(
        scratch,
        &["clone", "-q", origin.to_str().unwrap(), "studio-mini-shop"],
    );
    let taken = std::sync::Arc::new(std::sync::Mutex::new(None));
    let left = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(busy));
    let go = std::sync::Arc::new(tokio::sync::Notify::new());
    let addr = fake_central(
        scratch.join("studio-mini-shop"),
        Update::OffersBusy(left),
        taken.clone(),
        go,
    )
    .await;
    let worker = worker(&origin).await;
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": "ab".repeat(32) } }),
        )
        .await;
    let _: Copy = worker.call("sync.start", json!({ "session": "s1" })).await;
    let copy = in_sync(&worker).await;
    (worker, copy, taken)
}

#[tokio::test]
async fn an_offer_the_central_host_turns_away_is_made_again_until_it_is_taken() {
    let scratch = tempfile::tempdir().unwrap();
    let (worker, copy, taken) = worker_turned_away(scratch.path(), 2).await;
    let c = PathBuf::from(&copy.path);
    // One edit, and no other change after it.
    write(&c.join("src/cart.ts"), "mine\n");
    eventually("the third offer is taken", || async {
        taken.lock().unwrap().is_some()
    })
    .await;
    let offer = taken.lock().unwrap().clone().unwrap();
    let tree = offer["tree"].as_str().unwrap();
    assert_eq!(
        git(&c, &["cat-file", "-p", &format!("{tree}:src/cart.ts")]),
        "mine"
    );
    eventually("the copy is in sync", || async {
        copies(&worker).await[0].state == CopyState::InSync
    })
    .await;
}

#[tokio::test]
async fn an_edit_made_while_an_update_waits_is_offered_not_overwritten() {
    let scratch = tempfile::tempdir().unwrap();
    let origin = origin(scratch.path());
    git(
        scratch.path(),
        &["clone", "-q", origin.to_str().unwrap(), "studio-mini-shop"],
    );
    let reply = std::sync::Arc::new(std::sync::Mutex::new(None));
    let go = std::sync::Arc::new(tokio::sync::Notify::new());
    let addr = fake_central(
        scratch.path().join("studio-mini-shop"),
        Update::EditWhileOffersWait,
        reply.clone(),
        go.clone(),
    )
    .await;
    let worker = worker(&origin).await;
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": "ab".repeat(32) } }),
        )
        .await;
    let _: Copy = worker.call("sync.start", json!({ "session": "s1" })).await;
    let copy = in_sync(&worker).await;
    let c = PathBuf::from(&copy.path);
    // This Mac's edit is not taken yet when studio-mini's change to the
    // same file arrives.
    write(&c.join("src/cart.ts"), "mine\n");
    tokio::time::sleep(Duration::from_millis(500)).await;
    go.notify_one();
    eventually("the worker replies", || async {
        reply.lock().unwrap().is_some()
    })
    .await;
    let got = reply.lock().unwrap().clone().unwrap();
    assert_eq!(got["result"]["applied"], json!(false), "{got}");
    eventually("the copy's offer is taken", || async {
        copies(&worker).await[0].state == CopyState::InSync
    })
    .await;
    assert_eq!(read(&c.join("src/cart.ts")).as_deref(), Some("mine\n"));
}

#[tokio::test]
async fn a_path_that_starts_to_differ_is_named_once() {
    let (mut central, worker, c) = synced().await;
    let s = central.session_path();
    let mut events = worker.app().await;
    let _: Value = events.request("daemon.info", json!({})).await.unwrap();
    central.daemon.stop();
    copy_in(&worker, |s| *s == CopyState::Waiting, "waiting").await;
    write(&c.join("src/cart.ts"), "mine\n");
    write(&s.join("src/cart.ts"), "theirs\n");
    central.daemon.restart().await;
    eventually("src/cart.ts differs", || async {
        copies(&worker).await[0].differs == ["src/cart.ts"]
    })
    .await;
    // Another round, in which it still differs.
    write(&s.join("docs/new.md"), "new\n");
    reads(&c.join("docs/new.md"), "new\n").await;
    let mut named = Vec::new();
    while let Some(ev) = next_change(&mut events, Duration::from_secs(2)).await {
        for p in ev["newly_differing"].as_array().unwrap() {
            named.push(p.as_str().unwrap().to_string());
        }
    }
    assert_eq!(named, ["src/cart.ts"]);
}

#[tokio::test]
async fn resolving_says_why_it_could_not() {
    let (mut central, worker, c) = synced().await;
    let s = central.session_path();
    let id = copies(&worker).await[0].id.clone();
    let resolve = |path: &str| json!({ "copy": id, "path": path, "keep": "worker" });
    let code = |r: Result<Copy, anyhow::Error>| {
        r.unwrap_err()
            .to_string()
            .split(':')
            .next()
            .unwrap()
            .to_string()
    };

    let mut app = worker.app().await;
    assert_eq!(
        code(app.request("sync.resolve", resolve("src/cart.ts")).await),
        "invalid_params"
    );

    central.daemon.stop();
    copy_in(&worker, |s| *s == CopyState::Waiting, "waiting").await;
    write(&c.join("src/cart.ts"), "mine\n");
    write(&s.join("src/cart.ts"), "theirs\n");
    central.daemon.restart().await;
    eventually("src/cart.ts differs", || async {
        copies(&worker).await[0].differs == ["src/cart.ts"]
    })
    .await;
    central.daemon.stop();
    copy_in(&worker, |s| *s == CopyState::Waiting, "waiting").await;
    assert_eq!(
        code(app.request("sync.resolve", resolve("src/cart.ts")).await),
        "disconnected"
    );
}

#[tokio::test]
async fn resolving_a_paused_copy_says_it_is_paused() {
    let central = central_with(None).await;
    let worker = worker_with(None).await;
    link(&central, &worker).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let copy = copy_in(&worker, paused, "paused").await;
    let mut app = worker.app().await;
    let e = app
        .request::<_, Copy>(
            "sync.resolve",
            json!({ "copy": copy.id, "path": "src/cart.ts", "keep": "worker" }),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().starts_with("paused:"), "{e}");
}

/// The commit `HEAD` is at in `dir`, and its subject.
fn last_commit(dir: &Path) -> (String, String) {
    (
        git(dir, &["rev-parse", "HEAD"]),
        git(dir, &["log", "-1", "--format=%s"]),
    )
}

#[tokio::test]
async fn a_commit_on_the_central_host_moves_the_copys_branch_and_unstages_it() {
    let (central, _worker, c) = synced().await;
    let s = central.session_path();
    // Staged in the copy only; the file itself syncs, untracked there.
    write(&c.join("staged.txt"), "staged\n");
    git(&c, &["add", "staged.txt"]);
    reads(&s.join("staged.txt"), "staged\n").await;

    write(&s.join("src/cart.ts"), "committed\n");
    git(&s, &["commit", "-qam", "cart from the agent"]);
    let want = last_commit(&s);
    eventually("the copy's branch moves to the agent's commit", || async {
        last_commit(&c) == want
    })
    .await;
    assert_eq!(want.1, "cart from the agent");
    assert_eq!(
        git(&c, &["rev-parse", "--abbrev-ref", "HEAD"]),
        git(&s, &["rev-parse", "--abbrev-ref", "HEAD"])
    );
    // The staging area follows HEAD: nothing staged, nothing modified once
    // the files are there too.
    reads(&c.join("src/cart.ts"), "committed\n").await;
    eventually("the copy has nothing staged", || async {
        git(&c, &["status", "--porcelain"]) == "?? staged.txt"
    })
    .await;
}

#[tokio::test]
async fn a_commit_in_the_copy_moves_the_sessions_branch() {
    let (central, worker, c) = synced().await;
    let s = central.session_path();
    // Staged in the session only (the agent's `git add`).
    write(&s.join("agent.txt"), "agent\n");
    git(&s, &["add", "agent.txt"]);
    reads(&c.join("agent.txt"), "agent\n").await;
    write(&c.join("src/cart.ts"), "from the mac\n");
    git(&c, &["commit", "-qam", "cart from the mac"]);
    let want = last_commit(&c);
    eventually(
        "the session's branch moves to the copy's commit",
        || async { last_commit(&s) == want },
    )
    .await;
    assert_eq!(want.1, "cart from the mac");
    // The session's staging area follows its new commit: unstaged.
    eventually("the session has nothing staged or changed", || async {
        git(&s, &["status", "--porcelain"]) == "?? agent.txt"
    })
    .await;
    let copy = in_sync(&worker).await;
    assert_eq!(copy.diverged, None);
}

#[tokio::test]
async fn commits_on_both_sides_diverge_while_files_still_sync_until_the_central_branch_is_used() {
    let (mut central, worker, c) = synced().await;
    let s = central.session_path();
    let branch = "moonlet/fix-cart";
    let id = copies(&worker).await[0].id.clone();
    let mut app = worker.app().await;
    let e = app
        .request::<_, Copy>("sync.use_central_branch", json!({ "copy": id }))
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), "invalid_params: the branch has not diverged");
    central.daemon.stop();
    copy_in(&worker, |s| *s == CopyState::Waiting, "waiting").await;
    write(&c.join("mac.txt"), "mac\n");
    git(&c, &["add", "mac.txt"]);
    git(&c, &["commit", "-qm", "one on the mac"]);
    let mac = last_commit(&c).0;
    for n in ["1", "2"] {
        write(&s.join(format!("mini{n}.txt")), "mini\n");
        git(&s, &["add", "-A"]);
        git(&s, &["commit", "-qm", &format!("{n} on the mini")]);
    }
    let mini = last_commit(&s).0;
    central.daemon.restart().await;

    eventually("the copy says it diverged", || async {
        copies(&worker).await[0].diverged
            == Some(moonlet_proto::methods::Diverged {
                ahead: 1,
                behind: 2,
            })
    })
    .await;
    // Each branch stays where it was; the files still sync both ways.
    assert_eq!(last_commit(&c).0, mac);
    assert_eq!(last_commit(&s).0, mini);
    reads(&c.join("mini2.txt"), "mini\n").await;
    reads(&s.join("mac.txt"), "mac\n").await;
    write(&s.join("src/cart.ts"), "still syncing\n");
    reads(&c.join("src/cart.ts"), "still syncing\n").await;

    // Use studio-mini's branch: this Mac's commit stays on a branch of its
    // own, the next free name.
    let first = git(&c, &["rev-list", "--max-parents=0", "HEAD"]);
    git(&c, &["branch", "moonlet/fix-cart-this-mac", &first]);
    let copy: Copy = worker
        .call("sync.use_central_branch", json!({ "copy": id }))
        .await;
    assert_eq!(copy.diverged, None);
    assert_eq!(last_commit(&c).0, mini);
    assert_eq!(git(&c, &["rev-parse", "moonlet/fix-cart-this-mac-2"]), mac);
    assert_eq!(git(&c, &["rev-parse", "moonlet/fix-cart-this-mac"]), first);
    assert_eq!(git(&c, &["rev-parse", "--abbrev-ref", "HEAD"]), branch);
    // The files are as they were: this Mac's commit's file is now untracked.
    assert_eq!(read(&c.join("mac.txt")).as_deref(), Some("mac\n"));
    assert_eq!(
        read(&c.join("src/cart.ts")).as_deref(),
        Some("still syncing\n")
    );
    assert_eq!(
        git(&c, &["status", "--porcelain"]),
        "M src/cart.ts\n?? mac.txt"
    );
    // The session keeps its commits and gets no new one.
    assert_eq!(last_commit(&s).0, mini);
    in_sync(&worker).await;
    assert_eq!(copies(&worker).await[0].diverged, None);
}

#[tokio::test]
async fn a_side_on_another_branch_pauses_the_copy_until_it_is_back() {
    let (central, worker, c) = synced().await;
    let s = central.session_path();
    let branch = "moonlet/fix-cart";

    git(&c, &["checkout", "-q", "-b", "other"]);
    let copy = copy_in(&worker, paused, "paused").await;
    assert_eq!(reason(&copy), "the copy is on other, not moonlet/fix-cart.");
    git(&c, &["checkout", "-q", branch]);
    in_sync(&worker).await;
    write(&s.join("src/cart.ts"), "after the copy came back\n");
    reads(&c.join("src/cart.ts"), "after the copy came back\n").await;

    git(&c, &["checkout", "-q", "--detach"]);
    let copy = copy_in(&worker, paused, "paused").await;
    assert_eq!(
        reason(&copy),
        "the copy is on a detached HEAD, not moonlet/fix-cart."
    );
    git(&c, &["checkout", "-q", branch]);
    in_sync(&worker).await;

    git(&s, &["checkout", "-q", "--detach"]);
    let copy = copy_in(&worker, paused, "paused").await;
    assert_eq!(
        reason(&copy),
        "the session on studio-mini is on a detached HEAD, not moonlet/fix-cart."
    );
    git(&s, &["checkout", "-q", branch]);
    in_sync(&worker).await;

    git(&s, &["checkout", "-q", "-b", "elsewhere"]);
    let copy = copy_in(&worker, paused, "paused").await;
    assert_eq!(
        reason(&copy),
        "the session on studio-mini is on elsewhere, not moonlet/fix-cart."
    );
    // Paused, the copy's edits wait.
    write(&c.join("src/cart.ts"), "while the session was away\n");
    git(&s, &["checkout", "-q", branch]);
    in_sync(&worker).await;
    reads(&s.join("src/cart.ts"), "while the session was away\n").await;
}

/// One update [`stepped_central`] sends.
enum Step {
    /// The session is on `main`, not its branch.
    OffBranch,
    /// A tree with `../escaped.txt`.
    Outside,
    /// `src/cart.ts` as `c`.
    Edit,
}

/// A fake central host serving one session (the clone `repo`, on branch
/// `fix-cart`) that sends `steps` in order, one each time `go` is
/// notified, and keeps the worker's replies in `replies`.
async fn stepped_central(
    repo: PathBuf,
    steps: Vec<Step>,
    go: std::sync::Arc<tokio::sync::Notify>,
    replies: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
) -> String {
    use moonlet_proto::{Frame, Message, read_frame, write_frame};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        let (s, _) = listener.accept().await.unwrap();
        let (mut rd, wr) = s.into_split();
        let wr = std::sync::Arc::new(tokio::sync::Mutex::new(wr));
        let _auth = read_frame(&mut rd).await.unwrap();
        let authed = Message::Authed {
            device_id: "d1".into(),
            token: None,
            protocol: Some(moonlet_proto::PROTOCOL_VERSION),
            daemon_version: Some(env!("CARGO_PKG_VERSION").into()),
            host: Some("studio-mini".into()),
            os: Some("macos".into()),
        };
        write_frame(&mut *wr.lock().await, &Frame::Json(authed))
            .await
            .unwrap();
        let _hello = read_frame(&mut rd).await.unwrap();
        let welcome = Message::Welcome {
            protocol: moonlet_proto::PROTOCOL_VERSION,
            daemon_version: env!("CARGO_PKG_VERSION").into(),
            host: "studio-mini".into(),
            pid: 1,
        };
        write_frame(&mut *wr.lock().await, &Frame::Json(welcome))
            .await
            .unwrap();
        let head = git(&repo, &["rev-parse", "HEAD"]);
        let tree = git(&repo, &["rev-parse", "HEAD^{tree}"]);
        let root = git(&repo, &["rev-list", "--max-parents=0", "HEAD"]);
        let copy_id = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        // The steps go out from their own task as `go` allows.
        let (w2, c2, repo2) = (wr.clone(), copy_id.clone(), repo.clone());
        let (head2, tree2) = (head.clone(), tree.clone());
        // Replies to the updates in flight, by request id.
        type Waiters = std::collections::HashMap<u64, tokio::sync::oneshot::Sender<Value>>;
        let waiting = std::sync::Arc::new(std::sync::Mutex::new(Waiters::new()));
        // While a step waits for its answer, offers are answered as a real
        // central host would: `wrong_branch` while the session is off its
        // branch, else turned away until the update is in.
        let answer = std::sync::Arc::new(std::sync::Mutex::new(OfferAnswer::Take));
        let (waits, a2) = (waiting.clone(), answer.clone());
        tokio::spawn(async move {
            for (n, step) in steps.into_iter().enumerate() {
                go.notified().await;
                let listing = git(&repo2, &["ls-tree", "HEAD"]);
                let blob = git(&repo2, &["rev-parse", "HEAD:src/cart.ts"]);
                let (t, objects, off) = match step {
                    Step::OffBranch => (tree2.clone(), String::new(), Some("main")),
                    Step::Outside => {
                        let sub = mktree(&repo2, &format!("100644 blob {blob}\tescaped.txt\n"));
                        let bad = mktree(&repo2, &format!("{listing}\n040000 tree {sub}\t..\n"));
                        (bad.clone(), format!("{bad}\n{sub}\n"), None)
                    }
                    Step::Edit => {
                        write(&repo2.join("c.txt"), "c\n");
                        let blob = git(&repo2, &["hash-object", "-w", "c.txt"]);
                        let src = mktree(&repo2, &format!("100644 blob {blob}\tcart.ts\n"));
                        let others: String = listing
                            .lines()
                            .filter(|l| !l.ends_with("\tsrc"))
                            .map(|l| format!("{l}\n"))
                            .collect();
                        let new = mktree(&repo2, &format!("{others}040000 tree {src}\tsrc\n"));
                        (new.clone(), format!("{new}\n{src}\n{blob}\n"), None)
                    }
                };
                *a2.lock().unwrap() = if off.is_some() {
                    OfferAnswer::WrongBranch
                } else {
                    OfferAnswer::Busy
                };
                let bytes = (!objects.is_empty()).then(|| {
                    use std::io::Write;
                    let mut child = Command::new("git")
                        .args(["pack-objects", "--stdout", "-q"])
                        .current_dir(&repo2)
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .spawn()
                        .unwrap();
                    child
                        .stdin
                        .take()
                        .unwrap()
                        .write_all(objects.as_bytes())
                        .unwrap();
                    child.wait_with_output().unwrap().stdout
                });
                // Sent again while the worker answers that it was busy: an
                // off-branch update's own answer reads the same, so it goes
                // once, and its offers carry the news instead.
                for attempt in 0..150u64 {
                    let id = 1000 + 1000 * n as u64 + attempt;
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    waits.lock().unwrap().insert(id, tx);
                    {
                        let mut w = w2.lock().await;
                        let pack = match &bytes {
                            Some(b) => {
                                for f in moonlet_proto::pack_frames(id as u32, b) {
                                    write_frame(&mut *w, &f).await.unwrap();
                                }
                                Some(id)
                            }
                            None => None,
                        };
                        let copy = c2.lock().unwrap().clone();
                        let update = json!({
                            "copy": copy, "base": tree2, "tree": t, "head": head2, "too_big": [],
                            "pack": pack, "off_branch": off,
                        });
                        write_frame(
                            &mut *w,
                            &Frame::Json(Message::Request {
                                id,
                                method: "sync.update".into(),
                                params: update,
                            }),
                        )
                        .await
                        .unwrap();
                    }
                    let Ok(reply) = rx.await else { return };
                    let busy =
                        reply["error"].is_null() && reply["result"]["applied"] == json!(false);
                    if busy && off.is_none() {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        continue;
                    }
                    replies.lock().unwrap().push(reply);
                    break;
                }
                if off.is_none() {
                    *a2.lock().unwrap() = OfferAnswer::Take;
                }
            }
        });
        while let Ok(Some(frame)) = read_frame(&mut rd).await {
            match frame {
                Frame::Json(Message::Request { id, method, params }) => {
                    if let Some(c) = params["copy"].as_str() {
                        *copy_id.lock().unwrap() = c.to_string();
                    }
                    let reply = match method.as_str() {
                        "sync.open" => Message::ok(
                            id,
                            json!({
                                "path": repo.join("fix-cart"), "branch": "fix-cart", "head": head,
                                "name": "Fix cart", "project": "shop",
                                "identity": { "origin": "git.invalid/acme/shop", "root": root },
                                "origin_url": ORIGIN_URL,
                            }),
                        ),
                        "sync.fetch" => Message::ok(
                            id,
                            json!({ "tree": tree, "head": head, "too_big": [], "pack": null }),
                        ),
                        "sync.offer" => match *answer.lock().unwrap() {
                            OfferAnswer::Take => Message::ok(id, took_offer(&params)),
                            OfferAnswer::Busy => {
                                Message::err(id, moonlet_proto::RpcError::new("busy", "not now"))
                            }
                            OfferAnswer::WrongBranch => Message::err(
                                id,
                                moonlet_proto::RpcError::new("wrong_branch", "main"),
                            ),
                        },
                        _ => Message::ok(id, json!({})),
                    };
                    write_frame(&mut *wr.lock().await, &Frame::Json(reply))
                        .await
                        .unwrap();
                }
                Frame::Json(Message::Response { id, result, error }) => {
                    if let Some(tx) = waiting.lock().unwrap().remove(&id) {
                        let _ = tx.send(json!({ "result": result, "error": error }));
                    }
                }
                _ => {}
            }
        }
    });
    addr
}

/// How [`stepped_central`] answers an offer.
#[derive(Clone, Copy)]
enum OfferAnswer {
    /// As the worker made it.
    Take,
    /// Turned away while an update waits.
    Busy,
    /// The session is off its branch.
    WrongBranch,
}

#[tokio::test]
async fn a_pause_for_another_reason_outlasts_the_session_leaving_its_branch_and_coming_back() {
    let scratch = tempfile::tempdir().unwrap();
    let origin = origin(scratch.path());
    git(
        scratch.path(),
        &["clone", "-q", origin.to_str().unwrap(), "studio-mini-shop"],
    );
    let go = std::sync::Arc::new(tokio::sync::Notify::new());
    let replies = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let addr = stepped_central(
        scratch.path().join("studio-mini-shop"),
        vec![Step::Outside, Step::OffBranch, Step::Edit],
        go.clone(),
        replies.clone(),
    )
    .await;
    let worker = worker(&origin).await;
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": "ab".repeat(32) } }),
        )
        .await;
    let _: Copy = worker.call("sync.start", json!({ "session": "s1" })).await;
    in_sync(&worker).await;
    let replied = |n: usize| {
        let replies = replies.clone();
        move || {
            let replies = replies.clone();
            async move { replies.lock().unwrap().len() >= n }
        }
    };
    let outside = "studio-mini sent a path outside the copy.";

    go.notify_one();
    eventually("the first update is answered", replied(1)).await;
    assert_eq!(reason(&copy_in(&worker, paused, "paused").await), outside);

    // The session leaving its branch and coming back lifts nothing.
    go.notify_one();
    eventually("the second update is answered", replied(2)).await;
    assert_eq!(reason(&copies(&worker).await[0]), outside);
    go.notify_one();
    eventually("the third update is answered", replied(3)).await;
    assert_eq!(reason(&copies(&worker).await[0]), outside);
}

#[tokio::test]
async fn a_pause_for_another_reason_outlasts_the_session_coming_back_to_its_branch() {
    let scratch = tempfile::tempdir().unwrap();
    let origin = origin(scratch.path());
    git(
        scratch.path(),
        &["clone", "-q", origin.to_str().unwrap(), "studio-mini-shop"],
    );
    let go = std::sync::Arc::new(tokio::sync::Notify::new());
    let replies = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let addr = stepped_central(
        scratch.path().join("studio-mini-shop"),
        vec![Step::OffBranch, Step::Outside, Step::Edit],
        go.clone(),
        replies.clone(),
    )
    .await;
    let worker = worker(&origin).await;
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": "ab".repeat(32) } }),
        )
        .await;
    let _: Copy = worker.call("sync.start", json!({ "session": "s1" })).await;
    let copy = in_sync(&worker).await;
    let replied = |n: usize| {
        let replies = replies.clone();
        move || {
            let replies = replies.clone();
            async move { replies.lock().unwrap().len() >= n }
        }
    };

    // The session leaves its branch; the user retries anyway.
    go.notify_one();
    eventually("the first update is answered", replied(1)).await;
    let paused_copy = copy_in(&worker, paused, "paused").await;
    assert_eq!(
        reason(&paused_copy),
        "the session on studio-mini is on main, not fix-cart."
    );
    let _: Copy = worker.call("sync.retry", json!({ "copy": copy.id })).await;

    // Then studio-mini sends a path outside the copy.
    go.notify_one();
    eventually("the second update is answered", replied(2)).await;
    let outside = copy_in(&worker, paused, "paused").await;
    assert_eq!(
        reason(&outside),
        "studio-mini sent a path outside the copy."
    );

    // An ordinary update, on the branch, does not lift that pause.
    go.notify_one();
    eventually("the third update is answered", replied(3)).await;
    let third = replies.lock().unwrap()[2].clone();
    assert_eq!(third["error"]["code"], "paused", "{third}");
    assert_eq!(
        reason(&copies(&worker).await[0]),
        "studio-mini sent a path outside the copy."
    );
    let c = PathBuf::from(&copy.path);
    assert_eq!(read(&c.join("src/cart.ts")).as_deref(), Some("a\n"));
}

/// The `refs/moonlet/sync/…` refs in the repository of worktree `dir`.
fn sync_refs(dir: &Path) -> String {
    git(
        dir,
        &["for-each-ref", "--format=%(refname)", "refs/moonlet/sync"],
    )
}

/// Makes `src/cart.ts` differ: each side edits it while the link is down.
async fn make_cart_differ(central: &mut Central, worker: &Daemon, c: &Path) {
    let s = central.session_path();
    central.daemon.stop();
    copy_in(worker, |s| *s == CopyState::Waiting, "waiting").await;
    write(&c.join("src/cart.ts"), "mine\n");
    write(&s.join("src/cart.ts"), "theirs\n");
    central.daemon.restart().await;
    eventually("src/cart.ts differs", || async {
        copies(worker).await[0].differs == ["src/cart.ts"]
    })
    .await;
}

#[tokio::test]
async fn turning_sync_off_removes_the_copy_and_keeps_what_would_be_lost() {
    let (mut central, worker, c) = synced().await;
    let s = central.session_path();
    let repo = PathBuf::from(git(
        &c,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ));
    let branch = git(&c, &["rev-parse", "--abbrev-ref", "HEAD"]);
    make_cart_differ(&mut central, &worker, &c).await;
    // An edit studio-mini never got: the link is down.
    central.daemon.stop();
    copy_in(&worker, |s| *s == CopyState::Waiting, "waiting").await;
    write(&c.join("docs/notes.md"), "unsynced\n");

    let id = copies(&worker).await[0].id.clone();
    let stopped: Value = worker.call("sync.stop", json!({ "copy": id })).await;
    let folder = leftovers_folder(&worker, &stopped);
    assert_eq!(
        stopped["leftovers"],
        json!(["docs/notes.md", "src/cart.ts"])
    );
    assert_eq!(read(&folder.join("src/cart.ts")).as_deref(), Some("mine\n"));
    assert_eq!(
        read(&folder.join("docs/notes.md")).as_deref(),
        Some("unsynced\n")
    );
    assert!(!c.exists(), "the copy is still there");
    assert!(copies(&worker).await.is_empty());
    // The branch stays in the Mac's repository; the base's ref goes.
    assert_eq!(
        git(
            &repo,
            &["branch", "--list", "--format=%(refname:short)", &branch]
        ),
        branch
    );
    assert_eq!(sync_refs(&repo), "");

    // studio-mini lets the copy go once it hears of it.
    central.daemon.restart().await;
    eventually("studio-mini drops the copy's base", || async {
        sync_refs(&s).is_empty()
    })
    .await;
}

#[tokio::test]
async fn archiving_the_session_removes_the_copy_and_keeps_what_would_be_lost() {
    let (mut central, worker, c) = synced().await;
    make_cart_differ(&mut central, &worker, &c).await;
    let mut events = worker.app().await;
    let _: Value = events.request("daemon.info", json!({})).await.unwrap();

    let start = Instant::now();
    let _: Value = central
        .daemon
        .call("session.archive", json!({ "id": central.session_id() }))
        .await;
    let took = start.elapsed();
    assert!(took < Duration::from_secs(10), "archiving took {took:?}");
    let removed = loop {
        let ev = next_change(&mut events, Duration::from_secs(30))
            .await
            .expect("no sync.changed");
        if let Some(r) = ev.get("removed") {
            break r.clone();
        }
    };
    let folder = leftovers_folder(&worker, &removed);
    assert_eq!(removed["reason"], json!("archived"));
    assert_eq!(removed["leftovers"], json!(["src/cart.ts"]));
    assert_eq!(read(&folder.join("src/cart.ts")).as_deref(), Some("mine\n"));
    assert!(!c.exists(), "the copy is still there");
    assert!(copies(&worker).await.is_empty());
}

#[tokio::test]
async fn a_session_archived_while_this_mac_was_away_takes_its_copy_when_it_is_back() {
    let (central, mut worker, c) = synced().await;
    worker.stop();
    write(&c.join("docs/notes.md"), "while away\n");
    let _: Value = central
        .daemon
        .call("session.archive", json!({ "id": central.session_id() }))
        .await;
    worker.restart().await;
    eventually("the copy goes", || async {
        copies(&worker).await.is_empty()
    })
    .await;
    let folders = leftovers_folders(&worker);
    assert_eq!(folders.len(), 1, "{folders:?}");
    assert_eq!(
        read(&folders[0].join("docs/notes.md")).as_deref(),
        Some("while away\n")
    );
    assert!(!c.exists(), "the copy is still there");
}

#[tokio::test]
async fn a_central_host_that_lost_its_list_of_copies_gets_the_copy_again_not_removed() {
    let (mut central, worker, c) = synced().await;
    let s = central.session_path();
    write(&c.join("docs/notes.md"), "mine\n");
    reads(&s.join("docs/notes.md"), "mine\n").await;
    // studio-mini forgets the copies it serves, as with a lost or broken
    // copies.json, and comes back.
    central.daemon.stop();
    std::fs::remove_file(central.daemon.home.path().join("sync/copies.json")).unwrap();
    central.daemon.restart().await;

    let again = in_sync(&worker).await;
    assert_eq!(PathBuf::from(&again.path), c);
    assert!(leftovers_folders(&worker).is_empty());
    write(&s.join("src/cart.ts"), "after\n");
    reads(&c.join("src/cart.ts"), "after\n").await;
}

#[tokio::test]
async fn a_copy_whose_folder_was_deleted_pauses_until_it_is_made_again() {
    let (central, worker, c) = synced().await;
    let s = central.session_path();
    std::fs::remove_dir_all(&c).unwrap();
    let copy = copy_in(&worker, paused, "paused").await;
    // Scratch homes sit outside the user's home folder, so no `~`.
    assert!(
        c.starts_with("/var/folders") || c.starts_with("/tmp"),
        "{}",
        c.display()
    );
    assert_eq!(
        reason(&copy),
        format!("the copy at {} is gone.", c.display())
    );

    let _: Copy = worker.call("sync.retry", json!({ "copy": copy.id })).await;
    let again = in_sync(&worker).await;
    let c = PathBuf::from(again.path);
    assert_eq!(read(&c.join("src/cart.ts")).as_deref(), Some("a\n"));
    write(&s.join("src/cart.ts"), "after\n");
    reads(&c.join("src/cart.ts"), "after\n").await;
}

/// The leftovers folder a stop or a removal names: `sync-leftovers/` in
/// the worker's home, then the copy's folder name and when it went, as
/// `fix-cart-20261021-184500`.
fn leftovers_folder(worker: &Daemon, saved: &Value) -> PathBuf {
    let folder = PathBuf::from(saved["folder"].as_str().unwrap());
    assert_eq!(
        folder.parent(),
        Some(worker.home.path().join("sync-leftovers").as_path())
    );
    let name = folder.file_name().unwrap().to_str().unwrap();
    let stamp = name
        .strip_prefix("fix-cart-")
        .unwrap_or_else(|| panic!("{name}"));
    let shape: Vec<usize> = stamp.split('-').map(str::len).collect();
    assert!(
        stamp.chars().all(|c| c.is_ascii_digit() || c == '-')
            && (shape == [8, 6] || (shape.len() == 3 && shape[..2] == [8, 6])),
        "{name}"
    );
    folder
}

/// Every folder under the worker's `sync-leftovers/`.
fn leftovers_folders(worker: &Daemon) -> Vec<PathBuf> {
    let Ok(dir) = std::fs::read_dir(worker.home.path().join("sync-leftovers")) else {
        return Vec::new();
    };
    let mut all: Vec<PathBuf> = dir.flatten().map(|e| e.path()).collect();
    all.sort();
    all
}

#[tokio::test]
async fn turning_sync_off_keeps_secrets_and_files_that_stopped_syncing_but_not_build_output() {
    let (central, worker, c) = synced().await;
    // An untracked file that synced, then stopped when it became ignored.
    write(&c.join("docs/draft.md"), "synced\n");
    reads(&central.session_path().join("docs/draft.md"), "synced\n").await;
    let exclude = PathBuf::from(git(&c, &["rev-parse", "--git-path", "info/exclude"]));
    let exclude = if exclude.is_absolute() {
        exclude
    } else {
        c.join(exclude)
    };
    write(&exclude, "docs/draft.md\n");
    write(&c.join("docs/draft.md"), "kept here\n");
    // Only on this Mac too: secrets, one a link pointing out of the copy,
    // and build output.
    write(&c.join(".env"), "TOKEN=1\n");
    std::os::unix::fs::symlink("/etc/hosts", c.join("docs/id_rsa")).unwrap();
    write(&c.join("node_modules/left-pad/index.js"), "built\n");
    eventually("the link reaches studio-mini", || async {
        copies(&worker).await[0].state == CopyState::InSync
    })
    .await;

    let id = copies(&worker).await[0].id.clone();
    let stopped: Value = worker.call("sync.stop", json!({ "copy": id })).await;
    let folder = leftovers_folder(&worker, &stopped);
    assert_eq!(
        stopped["leftovers"],
        json!([".env", "docs/draft.md", "docs/id_rsa"])
    );
    assert_eq!(read(&folder.join(".env")).as_deref(), Some("TOKEN=1\n"));
    assert_eq!(
        read(&folder.join("docs/draft.md")).as_deref(),
        Some("kept here\n")
    );
    assert_eq!(
        read(&central.session_path().join("docs/draft.md")).as_deref(),
        Some("synced\n")
    );
    let link = folder.join("docs/id_rsa");
    assert!(
        std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        std::fs::read_link(&link).unwrap(),
        PathBuf::from("/etc/hosts")
    );
    assert!(!folder.join("node_modules").exists());
    assert!(!c.exists());
}

#[tokio::test]
async fn a_copy_whose_files_cannot_be_saved_is_kept_and_paused() {
    let (mut central, worker, c) = synced().await;
    // Not synced: studio-mini is away, and the edit waits.
    central.daemon.stop();
    copy_in(&worker, |s| *s == CopyState::Waiting, "waiting").await;
    write(&c.join("docs/notes.md"), "unsynced\n");
    // Nowhere to save it: `sync-leftovers` is a file.
    write(&worker.home.path().join("sync-leftovers"), "");

    let id = copies(&worker).await[0].id.clone();
    let mut app = worker.app().await;
    let e = app
        .request::<_, Value>("sync.stop", json!({ "copy": id }))
        .await
        .unwrap_err()
        .to_string();
    assert!(
        e.starts_with("not_saved: could not save docs/notes.md before removing the copy: "),
        "{e}"
    );
    assert_eq!(
        read(&c.join("docs/notes.md")).as_deref(),
        Some("unsynced\n")
    );
    let copy = copy_in(&worker, paused, "paused").await;
    assert!(
        reason(&copy).starts_with("could not save docs/notes.md before removing the copy: "),
        "{}",
        reason(&copy)
    );
}

#[tokio::test]
async fn stopping_the_same_session_twice_keeps_both_leftovers() {
    let (central, worker, c) = synced().await;
    let mut folders = Vec::new();
    for text in ["first\n", "second\n"] {
        // A secret never syncs, so stopping always saves it.
        write(&c.join(".env"), text);
        let id = copies(&worker).await[0].id.clone();
        let stopped: Value = worker.call("sync.stop", json!({ "copy": id })).await;
        let folder = leftovers_folder(&worker, &stopped);
        assert_eq!(read(&folder.join(".env")).as_deref(), Some(text));
        folders.push(folder);
        let _: Copy = worker
            .call("sync.start", json!({ "session": central.session_id() }))
            .await;
        assert_eq!(PathBuf::from(in_sync(&worker).await.path), c);
    }
    assert_ne!(folders[0], folders[1]);
    assert_eq!(read(&folders[0].join(".env")).as_deref(), Some("first\n"));
    assert_eq!(leftovers_folders(&worker), folders);
}

#[tokio::test]
async fn a_copy_that_cannot_be_removed_is_kept_and_paused() {
    use std::os::unix::fs::PermissionsExt;
    let (_central, worker, c) = synced().await;
    let src = c.join("src");
    std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o555)).unwrap();
    let id = copies(&worker).await[0].id.clone();
    let mut app = worker.app().await;
    let e = app
        .request::<_, Value>("sync.stop", json!({ "copy": id }))
        .await
        .unwrap_err()
        .to_string();
    std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(e.starts_with("failed: could not remove the copy: "), "{e}");
    let copy = copy_in(&worker, paused, "paused").await;
    assert!(
        reason(&copy).starts_with("could not remove the copy: "),
        "{}",
        reason(&copy)
    );
    assert_eq!(read(&c.join("src/cart.ts")).as_deref(), Some("a\n"));
}

#[tokio::test]
async fn archiving_never_waits_for_a_mac_that_does_not_answer() {
    let (central, worker, c) = synced().await;
    let pid = worker.child.id().to_string();
    let signal = |sig: &str| {
        std::process::Command::new("kill")
            .args([sig, &pid])
            .status()
            .unwrap()
    };
    signal("-STOP");
    let start = Instant::now();
    let _: Value = central
        .daemon
        .call("session.archive", json!({ "id": central.session_id() }))
        .await;
    let took = start.elapsed();
    signal("-CONT");
    assert!(took < Duration::from_secs(3), "archiving took {took:?}");
    eventually("the copy goes", || async {
        copies(&worker).await.is_empty()
    })
    .await;
    assert!(!c.exists(), "the copy is still there");
}

#[tokio::test]
async fn a_copy_never_made_whose_session_was_archived_goes() {
    let (mut central, mut worker, _c) = synced().await;
    let first = copies(&worker).await[0].id.clone();
    let _: Value = worker.call("sync.stop", json!({ "copy": first })).await;
    // Kept again while studio-mini is away: the copy waits to be made.
    central.daemon.stop();
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    copy_in(&worker, |s| *s == CopyState::Waiting, "waiting").await;
    worker.stop();
    central.daemon.restart().await;
    let _: Value = central
        .daemon
        .call("session.archive", json!({ "id": central.session_id() }))
        .await;
    worker.restart().await;
    eventually("the copy goes", || async {
        copies(&worker).await.is_empty()
    })
    .await;
}

/// Another machine, `build-box`, with no projects: a daemon this Mac can
/// pair with and make its central host instead of studio-mini.
async fn build_box() -> (Daemon, String) {
    for _ in 0..5 {
        let home = tempfile::tempdir().unwrap();
        let port = free_port();
        write(
            &home.path().join("mobile.json"),
            &format!(r#"{{ "enabled": true, "port": {port} }}"#),
        );
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
            if st["listening"]
                .as_array()
                .is_some_and(|l| l.contains(&json!(addr)))
            {
                return (d, addr);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    panic!("build-box never listened");
}

/// Pairs `worker` with `central` as [`link`] does; returns the token.
async fn pair_with(central: &Central) -> String {
    let p: MobilePairing = central.daemon.call("mobile.pair_start", json!({ "kind": "desktop" })).await;
    moonlet_link::tailnet::pair(
        &[central.addr.clone()],
        &p.code,
        "Alex's MacBook Pro",
        DeviceKind::Desktop,
    )
    .await
    .unwrap()
    .token
}

#[tokio::test]
async fn a_copy_waits_while_another_host_is_the_central_host() {
    let central = central().await;
    let worker = worker(&central.origin).await;
    let token = pair_with(&central).await;
    let studio_mini =
        json!({ "central": { "name": "studio-mini", "addrs": [central.addr], "token": token } });
    let _: Value = worker.call("link.set", studio_mini.clone()).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let path = PathBuf::from(in_sync(&worker).await.path);
    let (other, addr) = build_box().await;
    let p: MobilePairing = other.call("mobile.pair_start", json!({ "kind": "desktop" })).await;
    let token = moonlet_link::tailnet::pair(
        &[addr.clone()],
        &p.code,
        "Alex's MacBook Pro",
        DeviceKind::Desktop,
    )
    .await
    .unwrap()
    .token;
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "build-box", "addrs": [addr], "token": token } }),
        )
        .await;
    let c = copy_in(&worker, paused, "paused while build-box is central").await;
    assert_eq!(
        reason(&c),
        "studio-mini is no longer this Mac's central host."
    );
    // Kept, and not mistaken for a session build-box archived.
    write(&path.join("README.md"), "made while away\n");
    tokio::time::sleep(Duration::from_secs(2)).await;
    let all = copies(&worker).await;
    assert_eq!(all.len(), 1, "{all:?}");
    assert_eq!(
        reason(&all[0]),
        "studio-mini is no longer this Mac's central host."
    );
    assert_eq!(
        read(&path.join("README.md")).as_deref(),
        Some("made while away\n")
    );

    // studio-mini again: the copy goes on, and the edit reaches it.
    let _: Value = worker.call("link.set", studio_mini).await;
    in_sync(&worker).await;
    reads(
        &central.session_path().join("README.md"),
        "made while away\n",
    )
    .await;
}

#[tokio::test]
async fn a_copy_stopped_while_another_host_is_central_tells_its_own_host_later() {
    let central = central().await;
    let worker = worker(&central.origin).await;
    let token = pair_with(&central).await;
    let studio_mini =
        json!({ "central": { "name": "studio-mini", "addrs": [central.addr], "token": token } });
    let _: Value = worker.call("link.set", studio_mini.clone()).await;
    let c: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    in_sync(&worker).await;
    let session = central.session_path();
    assert_eq!(sync_refs(&session), format!("refs/moonlet/sync/{}", c.id));

    let (other, addr) = build_box().await;
    let p: MobilePairing = other.call("mobile.pair_start", json!({ "kind": "desktop" })).await;
    let token = moonlet_link::tailnet::pair(
        &[addr.clone()],
        &p.code,
        "Alex's MacBook Pro",
        DeviceKind::Desktop,
    )
    .await
    .unwrap()
    .token;
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "build-box", "addrs": [addr], "token": token } }),
        )
        .await;
    copy_in(&worker, paused, "paused while build-box is central").await;
    let _: Value = worker.call("sync.stop", json!({ "copy": c.id })).await;
    // build-box never knew the copy; studio-mini still serves it.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(sync_refs(&session), format!("refs/moonlet/sync/{}", c.id));

    // studio-mini again: it hears of the stop and lets the copy go.
    let _: Value = worker.call("link.set", studio_mini).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    while !sync_refs(&session).is_empty() {
        assert!(
            Instant::now() < deadline,
            "studio-mini never let the copy go"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Gives the session a setup script, `command`, whose output files are
/// ignored, before a copy is made.
fn give_setup(central: &Central, command: &str) {
    let s = central.session_path();
    write(
        &s.join(".moonlet/config.toml"),
        &format!("setup = {}\n", toml_string(command)),
    );
    write(&s.join(".gitignore"), "node_modules/\nignored-by-setup\n");
}

fn toml_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Waits for the only copy's setup to be `want` (its `state` as JSON).
async fn setup_is(worker: &Daemon, want: Value) -> Copy {
    let mut last = None;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(30) {
        let list = copies(worker).await;
        if let Some(c) = list.first()
            && c.setup
                .as_ref()
                .map(|s| serde_json::to_value(&s.state).unwrap())
                == Some(want.clone())
        {
            return c.clone();
        }
        last = list.first().cloned();
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the copy's setup never got {want}: {last:?}");
}

#[tokio::test]
async fn a_copy_runs_the_projects_setup_once_the_user_approves_the_command() {
    let central = central().await;
    give_setup(&central, "touch ignored-by-setup");
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;

    let copy = setup_is(&worker, json!({ "kind": "needs_approval" })).await;
    assert_eq!(
        copy.setup.as_ref().unwrap().command,
        "touch ignored-by-setup"
    );
    let c = PathBuf::from(&copy.path);
    assert!(!c.join("ignored-by-setup").exists(), "setup ran unasked");

    // An agent's CLI cannot approve it.
    let mut cli = Client::connect(&worker.socket, "moonlet-cli")
        .await
        .unwrap();
    let e = cli
        .request::<_, Value>(
            "sync.run_setup",
            json!({ "copy": copy.id, "command": "touch ignored-by-setup" }),
        )
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "forbidden: only the moonlet app manages setup"
    );

    let _: Copy = worker
        .call(
            "sync.run_setup",
            json!({ "copy": copy.id, "command": "touch ignored-by-setup" }),
        )
        .await;
    setup_is(&worker, json!({ "kind": "done" })).await;
    assert!(c.join("ignored-by-setup").exists(), "setup did not run");
    // Ignored, so it stays on this Mac.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!central.session_path().join("ignored-by-setup").exists());
}

/// Waits for copy `id`'s setup to be `want` (its `state` as JSON).
async fn copy_setup_is(worker: &Daemon, id: &str, want: Value) -> Copy {
    let mut last = None;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(30) {
        let c = copies(worker).await.into_iter().find(|c| c.id == id);
        if let Some(c) = &c
            && c.setup
                .as_ref()
                .map(|s| serde_json::to_value(&s.state).unwrap())
                == Some(want.clone())
        {
            return c.clone();
        }
        last = c;
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("copy {id}'s setup never got {want}: {last:?}");
}

#[tokio::test]
async fn an_approved_setup_runs_unasked_until_its_command_changes() {
    let central = central().await;
    give_setup(&central, "touch ignored-by-setup");
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let first: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    setup_is(&worker, json!({ "kind": "needs_approval" })).await;
    let _: Copy = worker
        .call(
            "sync.run_setup",
            json!({ "copy": first.id, "command": "touch ignored-by-setup" }),
        )
        .await;
    setup_is(&worker, json!({ "kind": "done" })).await;

    // A second session of the same project, with the same setup.
    let project = central.session["project_id"].clone();
    let second: Value = central
        .daemon
        .call(
            "session.create",
            json!({ "project_id": project, "name": "Second" }),
        )
        .await;
    let s2 = PathBuf::from(second["path"].as_str().unwrap());
    write(
        &s2.join(".moonlet/config.toml"),
        "setup = \"touch ignored-by-setup\"\n",
    );
    write(&s2.join(".gitignore"), "node_modules/\nignored-by-setup\n");
    let copy2: Copy = worker
        .call("sync.start", json!({ "session": second["id"] }))
        .await;
    let done = copy_setup_is(&worker, &copy2.id, json!({ "kind": "done" })).await;
    assert!(PathBuf::from(&done.path).join("ignored-by-setup").exists());

    // A third whose session changed the command asks again.
    let third: Value = central
        .daemon
        .call(
            "session.create",
            json!({ "project_id": project, "name": "Third" }),
        )
        .await;
    let s3 = PathBuf::from(third["path"].as_str().unwrap());
    write(
        &s3.join(".moonlet/config.toml"),
        "setup = \"touch other\"\n",
    );
    write(
        &s3.join(".gitignore"),
        "node_modules/\nignored-by-setup\nother\n",
    );
    let copy3: Copy = worker
        .call("sync.start", json!({ "session": third["id"] }))
        .await;
    let asks = copy_setup_is(&worker, &copy3.id, json!({ "kind": "needs_approval" })).await;
    assert_eq!(asks.setup.unwrap().command, "touch other");
    let e = worker
        .app()
        .await
        .request::<_, Value>(
            "sync.run_setup",
            json!({ "copy": copy3.id, "command": "touch ignored-by-setup" }),
        )
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), "setup_changed: touch other");
    assert!(!PathBuf::from(&asks.path).join("ignored-by-setup").exists());

    // Remembered on this Mac, per central host, project and exact command.
    let projects: Value =
        serde_json::from_str(&read(&worker.home.path().join("sync/projects.json")).unwrap())
            .unwrap();
    assert_eq!(
        projects,
        json!({ "studio-mini git.invalid/acme/shop 1a8cad3285c1b89b9133296af42c8d001c492bfe": { "approved_setup": ["touch ignored-by-setup"] } })
    );
}

#[tokio::test]
async fn an_approval_not_given_for_this_central_host_does_not_count() {
    let central = central().await;
    give_setup(&central, "touch ignored-by-setup");
    let worker = worker(&central.origin).await;
    // Approved for a project of the same identity on another central host,
    // and for the identity alone: another host can claim any identity.
    write(
        &worker.home.path().join("sync/projects.json"),
        &json!({
            "build-box git.invalid/acme/shop 1a8cad3285c1b89b9133296af42c8d001c492bfe": { "approved_setup": ["touch ignored-by-setup"] },
            "git.invalid/acme/shop 1a8cad3285c1b89b9133296af42c8d001c492bfe": { "approved_setup": ["touch ignored-by-setup"] }
        }).to_string(),
    );
    link(&central, &worker).await;
    let copy: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let asks = copy_setup_is(&worker, &copy.id, json!({ "kind": "needs_approval" })).await;
    assert!(!PathBuf::from(&asks.path).join("ignored-by-setup").exists());
}

#[tokio::test]
async fn a_failed_setup_says_how_it_exited_and_keeps_its_output() {
    let central = central().await;
    give_setup(&central, "echo installing; exit 1");
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let copy: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    setup_is(&worker, json!({ "kind": "needs_approval" })).await;
    let _: Copy = worker
        .call(
            "sync.run_setup",
            json!({ "copy": copy.id, "command": "echo installing; exit 1" }),
        )
        .await;
    let failed = setup_is(&worker, json!({ "kind": "failed", "exit": 1 })).await;
    assert_eq!(failed.state, CopyState::InSync, "files still sync");
    let log = read(
        &worker
            .home
            .path()
            .join(format!("sync/logs/{}.log", copy.id)),
    )
    .unwrap();
    assert!(log.contains("installing\n"), "{log:?}");

    // Skipping is for a setup that waits; files sync either way.
    write(&central.session_path().join("src/cart.ts"), "during\n");
    reads(&PathBuf::from(&failed.path).join("src/cart.ts"), "during\n").await;
}

/// A copy whose approved setup sleeps; gives the copy and the sleep's pid.
async fn sleeping_setup(central: &Central, worker: &Daemon, scratch: &Path) -> (Copy, i32) {
    let pid_file = scratch.join("pid");
    let command = format!("sleep 317 & echo $! > '{}'; wait", pid_file.display());
    give_setup(central, &command);
    link(central, worker).await;
    let copy: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    setup_is(worker, json!({ "kind": "needs_approval" })).await;
    let _: Copy = worker
        .call(
            "sync.run_setup",
            json!({ "copy": copy.id, "command": command }),
        )
        .await;
    setup_is(worker, json!({ "kind": "running" })).await;
    eventually("setup started its sleep", || async {
        read(&pid_file).is_some_and(|p| p.trim().parse::<i32>().is_ok())
    })
    .await;
    let pid: i32 = read(&pid_file).unwrap().trim().parse().unwrap();
    assert!(alive(pid));
    (copy, pid)
}

fn alive(pid: i32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
}

async fn ends(pid: i32, what: &str) {
    let start = Instant::now();
    while alive(pid) {
        assert!(start.elapsed() < Duration::from_secs(10), "{what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn turning_sync_off_stops_a_setup_still_running() {
    let central = central().await;
    let scratch = tempfile::tempdir().unwrap();
    let worker = worker(&central.origin).await;
    let (copy, pid) = sleeping_setup(&central, &worker, scratch.path()).await;

    let _: Value = worker.call("sync.stop", json!({ "copy": copy.id })).await;
    ends(pid, "the setup's sleep outlived the copy").await;
}

#[tokio::test]
async fn archiving_the_session_stops_a_setup_still_running() {
    let central = central().await;
    let scratch = tempfile::tempdir().unwrap();
    let worker = worker(&central.origin).await;
    let (_, pid) = sleeping_setup(&central, &worker, scratch.path()).await;

    let _: Value = central
        .daemon
        .call("session.archive", json!({ "id": central.session_id() }))
        .await;
    ends(pid, "the setup's sleep outlived the archived session").await;
}

#[tokio::test]
async fn a_setup_running_when_this_macs_daemon_stops_ends_with_it() {
    let central = central().await;
    let scratch = tempfile::tempdir().unwrap();
    let mut worker = worker(&central.origin).await;
    let (_, pid) = sleeping_setup(&central, &worker, scratch.path()).await;

    worker.restart().await;
    ends(pid, "the setup's sleep outlived the daemon that ran it").await;
    setup_is(&worker, json!({ "kind": "failed", "exit": -1 })).await;
}

#[tokio::test]
async fn a_setup_gets_the_terminals_environment_not_the_daemons() {
    let central = central().await;
    let command = "printf %s \"${AGENT_TOKEN-unset}\" > ignored-by-setup";
    give_setup(&central, command);
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let copy: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    setup_is(&worker, json!({ "kind": "needs_approval" })).await;
    let _: Copy = worker
        .call(
            "sync.run_setup",
            json!({ "copy": copy.id, "command": command }),
        )
        .await;
    let done = setup_is(&worker, json!({ "kind": "done" })).await;
    assert_eq!(
        read(&PathBuf::from(&done.path).join("ignored-by-setup")).as_deref(),
        Some("unset")
    );
}

#[tokio::test]
async fn a_job_a_finished_setup_left_running_ends_with_the_copy() {
    let central = central().await;
    let scratch = tempfile::tempdir().unwrap();
    let pid_file = scratch.path().join("pid");
    // The shell exits at once; its job, in the setup's session, does not.
    let command = format!(
        "sh -c 'echo $$ > \"{}\"; exec sleep 317' & sleep 1",
        pid_file.display()
    );
    give_setup(&central, &command);
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let copy: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    setup_is(&worker, json!({ "kind": "needs_approval" })).await;
    let _: Copy = worker
        .call(
            "sync.run_setup",
            json!({ "copy": copy.id, "command": command }),
        )
        .await;
    setup_is(&worker, json!({ "kind": "done" })).await;
    let pid: i32 = read(&pid_file).unwrap().trim().parse().unwrap();

    let _: Value = worker.call("sync.stop", json!({ "copy": copy.id })).await;
    ends(pid, "the setup's job outlived the copy").await;
}

#[tokio::test]
async fn a_setup_stopped_as_soon_as_it_is_approved_ends() {
    let central = central().await;
    let scratch = tempfile::tempdir().unwrap();
    let pid_file = scratch.path().join("pid");
    let command = format!("echo $$ > '{}'; exec sleep 317", pid_file.display());
    give_setup(&central, &command);
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let copy: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    setup_is(&worker, json!({ "kind": "needs_approval" })).await;
    let mut app = worker.app().await;
    let _: Copy = app
        .request(
            "sync.run_setup",
            json!({ "copy": copy.id, "command": command }),
        )
        .await
        .unwrap();
    let _: Value = app
        .request("sync.stop", json!({ "copy": copy.id }))
        .await
        .unwrap();

    tokio::time::sleep(Duration::from_secs(1)).await;
    if let Some(pid) = read(&pid_file).and_then(|p| p.trim().parse::<i32>().ok()) {
        ends(
            pid,
            "a setup stopped right after it was approved kept running",
        )
        .await;
    }
}

#[tokio::test]
async fn a_copy_without_a_setup_has_none_to_run() {
    let (_central, worker, c) = synced().await;
    let copy = copies(&worker).await.remove(0);
    assert!(copy.setup.is_none());

    let mut app = worker.app().await;
    let e = app
        .request::<_, Value>("sync.run_setup", json!({ "copy": copy.id, "command": "" }))
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), "no_setup: the copy has no setup script");
    assert!(copies(&worker).await[0].setup.is_none());
    let _ = c;
}

#[tokio::test]
async fn the_setup_knows_the_sessions_name() {
    let central = central().await;
    let command = "printf %s \"$MOONLET_SESSION_NAME\" > ignored-by-setup";
    give_setup(&central, command);
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let copy: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    setup_is(&worker, json!({ "kind": "needs_approval" })).await;
    let _: Copy = worker
        .call(
            "sync.run_setup",
            json!({ "copy": copy.id, "command": command }),
        )
        .await;
    let done = setup_is(&worker, json!({ "kind": "done" })).await;
    assert_eq!(
        read(&PathBuf::from(&done.path).join("ignored-by-setup")).as_deref(),
        Some("Fix cart")
    );
}

/// A paired device's connection to `central` over its tailnet listener.
async fn paired_device(central: &Central) -> tokio::net::TcpStream {
    paired_as(&central.daemon, &central.addr, DeviceKind::Phone).await
}

/// A device of `kind` paired with `daemon`, which listens on `addr`, and
/// connected to it.
async fn paired_as(daemon: &Daemon, addr: &str, kind: DeviceKind) -> tokio::net::TcpStream {
    use moonlet_proto::{Frame, Message, read_frame, write_frame};
    let start = match kind {
        DeviceKind::Desktop => json!({ "kind": "desktop" }),
        _ => json!({}),
    };
    let p: MobilePairing = daemon.call("mobile.pair_start", start).await;
    let name = if kind == DeviceKind::Desktop { "Sam's MacBook Air" } else { "Alex's iPhone" };
    let token = moonlet_link::tailnet::pair(&[addr.to_string()], &p.code, name, kind)
        .await
        .unwrap()
        .token;
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let auth = Message::Auth {
        token: Some(token),
        pair: None,
        device: None,
        route: None,
        kind: None,
    };
    write_frame(&mut s, &Frame::Json(auth)).await.unwrap();
    read_frame(&mut s).await.unwrap();
    let hello = Message::Hello {
        protocol: moonlet_proto::PROTOCOL_VERSION,
        client: "moonlet-mobile".into(),
        app_token: None,
    };
    write_frame(&mut s, &Frame::Json(hello)).await.unwrap();
    read_frame(&mut s).await.unwrap();
    s
}

/// Sends `method` on a paired device's connection and returns its reply,
/// skipping events.
async fn device_call(s: &mut tokio::net::TcpStream, id: u64, method: &str, params: Value) -> Result<Value, (String, String)> {
    use moonlet_proto::{Frame, Message, read_frame, write_frame};
    let req = Message::Request { id, method: method.into(), params };
    write_frame(s, &Frame::Json(req)).await.unwrap();
    loop {
        match read_frame(s).await.unwrap() {
            Some(Frame::Json(Message::Response { error: Some(e), .. })) => return Err((e.code, e.message)),
            Some(Frame::Json(Message::Response { result, .. })) => return Ok(result.unwrap_or(Value::Null)),
            Some(_) => {}
            None => panic!("closed"),
        }
    }
}

#[tokio::test]
async fn a_paired_mac_cannot_run_or_skip_a_setup() {
    let central = central().await;
    let mut mac = paired_as(&central.daemon, &central.addr, DeviceKind::Desktop).await;
    for (id, method) in [(1, "exec.setups"), (2, "sync.run_setup"), (3, "sync.skip_setup")] {
        let e = device_call(&mut mac, id, method, json!({ "copy": "any", "command": "touch x" }))
            .await
            .expect_err(method);
        assert_eq!(e, ("forbidden".into(), "manage setup from the Mac".into()), "{method}");
    }
}

#[tokio::test]
async fn a_paired_phone_approves_a_copys_setup() {
    let central = central().await;
    give_setup(&central, "touch ignored-by-setup");
    let (worker, addr) = worker_with_phones(&central.origin).await;
    link(&central, &worker).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let copy = setup_is(&worker, json!({ "kind": "needs_approval" })).await;

    let mut phone = paired_as(&worker, &addr, DeviceKind::Phone).await;
    assert_eq!(device_call(&mut phone, 1, "exec.setups", json!({})).await, Ok(json!([])));
    device_call(
        &mut phone,
        2,
        "sync.run_setup",
        json!({ "copy": copy.id, "command": "touch ignored-by-setup" }),
    )
    .await
    .unwrap();
    setup_is(&worker, json!({ "kind": "done" })).await;
    assert!(PathBuf::from(&copy.path).join("ignored-by-setup").exists(), "setup did not run");
}

#[tokio::test]
async fn a_paired_phone_skips_a_copys_setup() {
    let central = central().await;
    give_setup(&central, "touch ignored-by-setup");
    let (worker, addr) = worker_with_phones(&central.origin).await;
    link(&central, &worker).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let copy = setup_is(&worker, json!({ "kind": "needs_approval" })).await;

    let mut phone = paired_as(&worker, &addr, DeviceKind::Phone).await;
    device_call(&mut phone, 1, "sync.skip_setup", json!({ "copy": copy.id }))
        .await
        .unwrap();
    setup_is(&worker, json!({ "kind": "skipped" })).await;
}

#[tokio::test]
async fn the_setup_shown_is_the_current_command_and_says_whether_it_was_approved() {
    let central = central().await;
    give_setup(&central, "touch ignored-by-setup");
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let copy: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let waiting = setup_is(&worker, json!({ "kind": "needs_approval" })).await;
    assert!(!waiting.setup.unwrap().approved);
    let _: Copy = worker
        .call(
            "sync.run_setup",
            json!({ "copy": copy.id, "command": "touch ignored-by-setup" }),
        )
        .await;
    let done = setup_is(&worker, json!({ "kind": "done" })).await;
    assert!(done.setup.unwrap().approved);

    // The agent changes the setup in the session.
    give_setup(&central, "touch other");
    let mut last = None;
    let start = Instant::now();
    loop {
        let setup = copies(&worker).await.remove(0).setup.unwrap();
        if setup.command == "touch other" {
            assert!(!setup.approved, "{setup:?}");
            assert_eq!(
                serde_json::to_value(&setup.state).unwrap(),
                json!({ "kind": "done" })
            );
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "never shown: {last:?}"
        );
        last = Some(setup);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn skipping_a_setup_leaves_it_unrun() {
    let central = central().await;
    give_setup(&central, "touch ignored-by-setup");
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let copy: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    setup_is(&worker, json!({ "kind": "needs_approval" })).await;
    let skipped: Copy = worker
        .call("sync.skip_setup", json!({ "copy": copy.id }))
        .await;
    assert_eq!(
        serde_json::to_value(&skipped.setup.unwrap().state).unwrap(),
        json!({ "kind": "skipped" })
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !PathBuf::from(&skipped.path)
            .join("ignored-by-setup")
            .exists()
    );
}

/// The identity of the central host's project `shop`.
async fn shop_identity(central: &Central) -> Value {
    let projects: Vec<Value> = central.daemon.call("project.list", json!({})).await;
    projects[0]["identity"].clone()
}

async fn new_session(central: &Central, name: &str) -> String {
    let s: Value = central
        .daemon
        .call(
            "session.create",
            json!({ "project_id": central.session["project_id"], "name": name }),
        )
        .await;
    s["id"].as_str().unwrap().to_string()
}

/// Waits until this Mac keeps exactly the sessions `want`, in any order.
async fn keeps(worker: &Daemon, want: &[&str]) -> Duration {
    let mut want: Vec<String> = want.iter().map(|s| s.to_string()).collect();
    want.sort();
    let start = Instant::now();
    let mut last = Vec::new();
    while start.elapsed() < Duration::from_secs(30) {
        let mut have: Vec<String> = copies(worker)
            .await
            .into_iter()
            .map(|c| c.session)
            .collect();
        have.sort();
        if have == want {
            return start.elapsed();
        }
        last = have;
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("this Mac never kept {want:?}: {last:?}");
}

#[tokio::test]
async fn a_project_set_to_keep_new_sessions_in_sync_gets_a_copy_of_each_new_one() {
    let central = central().await;
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let identity = shop_identity(&central).await;
    let off: Value = worker
        .call("sync.project_get", json!({ "identity": identity }))
        .await;
    assert_eq!(off, json!({ "keep_new": false }));
    // Not from an agent's CLI.
    let mut cli = Client::connect(&worker.socket, "moonlet-cli")
        .await
        .unwrap();
    let e = cli
        .request::<_, Value>(
            "sync.project_set",
            json!({ "identity": identity, "keep_new": true }),
        )
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "forbidden: only the moonlet app manages sync"
    );
    let on: Value = worker
        .call(
            "sync.project_set",
            json!({ "identity": identity, "keep_new": true }),
        )
        .await;
    assert_eq!(on, json!({ "keep_new": true }));

    // A session made now gets a copy; the one from before does not.
    let second = new_session(&central, "Second").await;
    let took = keeps(&worker, &[&second]).await;
    assert!(took < Duration::from_secs(5), "took {took:?}");

    // Starting it again gives the same copy.
    let a: Copy = worker
        .call("sync.start", json!({ "session": second }))
        .await;
    let b: Copy = worker
        .call("sync.start", json!({ "session": second }))
        .await;
    assert_eq!(a.id, b.id);

    // A copy the user stopped stays stopped.
    let _: Value = worker.call("sync.stop", json!({ "copy": a.id })).await;
    let third = new_session(&central, "Third").await;
    keeps(&worker, &[&third]).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    keeps(&worker, &[&third]).await;
}

#[tokio::test]
async fn a_session_made_while_this_mac_was_away_gets_its_copy_when_it_is_back() {
    let central = central().await;
    let mut worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let identity = shop_identity(&central).await;
    let _: Value = worker
        .call(
            "sync.project_set",
            json!({ "identity": identity, "keep_new": true }),
        )
        .await;
    worker.stop();
    let second = new_session(&central, "Second").await;
    worker.restart().await;
    keeps(&worker, &[&second]).await;
    // The setting outlived the restart.
    let still: Value = worker
        .call("sync.project_get", json!({ "identity": identity }))
        .await;
    assert_eq!(still, json!({ "keep_new": true }));
}

#[tokio::test]
async fn turning_keep_new_off_leaves_the_copies_and_makes_no_more() {
    let central = central().await;
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let identity = shop_identity(&central).await;
    let _: Value = worker
        .call(
            "sync.project_set",
            json!({ "identity": identity, "keep_new": true }),
        )
        .await;
    let second = new_session(&central, "Second").await;
    keeps(&worker, &[&second]).await;
    let _: Value = worker
        .call(
            "sync.project_set",
            json!({ "identity": identity, "keep_new": false }),
        )
        .await;
    new_session(&central, "Third").await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    keeps(&worker, &[&second]).await;
}

#[tokio::test]
async fn keeping_new_sessions_in_sync_is_a_choice_per_central_host() {
    let central = central().await;
    let worker = worker(&central.origin).await;
    // Chosen for a project of the same identity on another central host.
    write(
        &worker.home.path().join("sync/projects.json"),
        &json!({ "build-box git.invalid/acme/shop 1a8cad3285c1b89b9133296af42c8d001c492bfe": { "keep_new": true, "keep_new_since": 1 } }).to_string(),
    );
    link(&central, &worker).await;
    let identity = shop_identity(&central).await;
    let got: Value = worker
        .call("sync.project_get", json!({ "identity": identity }))
        .await;
    assert_eq!(got, json!({ "keep_new": false }));
    let _second = new_session(&central, "Second").await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    keeps(&worker, &[]).await;

    let _: Value = worker
        .call(
            "sync.project_set",
            json!({ "identity": identity, "keep_new": true }),
        )
        .await;
    let projects: Value =
        serde_json::from_str(&read(&worker.home.path().join("sync/projects.json")).unwrap())
            .unwrap();
    assert_eq!(
        projects["studio-mini git.invalid/acme/shop 1a8cad3285c1b89b9133296af42c8d001c492bfe"]["keep_new"],
        json!(true),
        "{projects}"
    );
}

/// `worker` linked to `central`, keeping new `shop` sessions in sync.
async fn keeping_new(central: &Central) -> Daemon {
    let worker = worker(&central.origin).await;
    link(central, &worker).await;
    let identity = shop_identity(central).await;
    let _: Value = worker
        .call(
            "sync.project_set",
            json!({ "identity": identity, "keep_new": true }),
        )
        .await;
    worker
}

#[tokio::test]
async fn a_session_the_app_kept_and_the_user_stopped_is_not_made_again() {
    let central = central().await;
    let worker = keeping_new(&central).await;
    let second = new_session(&central, "Second").await;
    let copy: Copy = worker
        .call("sync.start", json!({ "session": second }))
        .await;
    let _: Value = worker.call("sync.stop", json!({ "copy": copy.id })).await;

    let third = new_session(&central, "Third").await;
    keeps(&worker, &[&third]).await;
    tokio::time::sleep(Duration::from_secs(4)).await;
    keeps(&worker, &[&third]).await;
}

#[tokio::test]
async fn a_session_the_composer_declines_gets_no_copy() {
    let central = central().await;
    let worker = keeping_new(&central).await;
    let second = new_session(&central, "Second").await;
    let _: Value = worker
        .call("sync.decline", json!({ "session": second }))
        .await;

    let third = new_session(&central, "Third").await;
    keeps(&worker, &[&third]).await;
    tokio::time::sleep(Duration::from_secs(4)).await;
    keeps(&worker, &[&third]).await;
}

#[tokio::test]
async fn keeping_new_sessions_needs_a_project_known_by_its_first_commit() {
    let central = central().await;
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    let mut app = worker.app().await;
    let e = app
        .request::<_, Value>(
            "sync.project_set",
            json!({ "identity": { "origin": "git.invalid/acme/new", "root": null }, "keep_new": true }),
        )
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "no_identity: the project has no commit to know it by on this Mac"
    );
}

/// Turns the central host's tailnet access off, which drops the link, and
/// gives a closure that turns it back on.
async fn link_off(central: &Central) {
    let _: Value = central
        .daemon
        .call("mobile.set_enabled", json!({ "enabled": false }))
        .await;
}

async fn link_on(central: &Central) {
    let _: Value = central
        .daemon
        .call("mobile.set_enabled", json!({ "enabled": true }))
        .await;
}

async fn link_state(worker: &Daemon) -> String {
    let info: Value = worker.call("link.get", json!({})).await;
    info["state"]["kind"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn sessions_made_while_the_link_was_down_get_copies_once_it_is_back_unless_archived() {
    let central = central().await;
    let worker = keeping_new(&central).await;
    eventually("linked", || async { link_state(&worker).await == "connected" }).await;
    link_off(&central).await;
    eventually("link dropped", || async { link_state(&worker).await != "connected" }).await;
    let second = new_session(&central, "Second").await;
    let gone = new_session(&central, "Gone").await;
    let _: Value = central
        .daemon
        .call("session.archive", json!({ "id": gone }))
        .await;

    link_on(&central).await;
    keeps(&worker, &[&second]).await;
    tokio::time::sleep(Duration::from_secs(4)).await;
    keeps(&worker, &[&second]).await;
}

#[tokio::test]
async fn sessions_made_while_the_link_was_down_get_no_copy_when_keep_new_is_off() {
    let central = central().await;
    let worker = worker(&central.origin).await;
    link(&central, &worker).await;
    // Linked for heavy commands, so the link is up without any copy.
    let _: Value = worker
        .call("link.set", json!({ "worker": { "enabled": true } }))
        .await;
    eventually("linked", || async { link_state(&worker).await == "connected" }).await;
    link_off(&central).await;
    eventually("link dropped", || async { link_state(&worker).await != "connected" }).await;
    let _second = new_session(&central, "Second").await;

    link_on(&central).await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    keeps(&worker, &[]).await;
}
