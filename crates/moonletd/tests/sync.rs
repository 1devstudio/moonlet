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

/// The central host `studio-mini`, its project `shop` (a clone of the bare
/// origin, whose origin URL is [`ORIGIN_URL`]) and a session `Fix cart`.
struct Central {
    daemon: Daemon,
    addr: String,
    origin: PathBuf,
    session: Value,
    _scratch: tempfile::TempDir,
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
    let home = tempfile::tempdir().unwrap();
    let config = home.path().join("gitconfig");
    write(
        &config,
        &origin.map_or(String::new(), |o| {
            format!("[url \"{}\"]\n\tinsteadOf = {ORIGIN_URL}\n", o.display())
        }),
    );
    write(
        &home.path().join("link.json"),
        &json!({ "central": null, "worker": { "id": "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37", "name": "Alex's MacBook Pro", "enabled": false } })
            .to_string(),
    );
    Daemon::start(
        home,
        &[
            ("MOONLET_MOBILE_ADDRS", "127.0.0.2"),
            ("GIT_CONFIG_GLOBAL", config.to_str().unwrap()),
        ],
    )
    .await
}

/// Pairs `worker` with `central` and sets it as the central host, without
/// turning on heavy commands: keeping a session in sync opens the link.
async fn link(central: &Central, worker: &Daemon) {
    let p: MobilePairing = central.daemon.call("mobile.pair_start", json!({})).await;
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
            .join("clones/git.invalid/acme/shop/.git")
            .is_dir()
    );
}

/// A central host with a session, and a worker with an in-sync copy of it.
async fn synced() -> (Central, Daemon, PathBuf) {
    let central = central().await;
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

#[tokio::test]
async fn an_edit_on_the_central_host_shows_in_the_copy_within_a_second() {
    let (central, _worker, c) = synced().await;
    let s = central.session_path();
    write(&s.join("node_modules/left-pad/index.js"), "ignored\n");
    write(&s.join("src/cart.ts"), "c\n");
    let took = reads(&c.join("src/cart.ts"), "c\n").await;
    assert!(took < Duration::from_secs(1), "took {took:?}");
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
async fn an_edit_made_in_the_copy_is_never_overwritten_and_differs() {
    let (central, worker, c) = synced().await;
    let s = central.session_path();
    write(&c.join("src/cart.ts"), "mine\n");
    write(&c.join("src/local.ts"), "local\n");
    write(&s.join("src/cart.ts"), "theirs\n");
    write(&s.join("docs/new.md"), "new\n");
    reads(&c.join("docs/new.md"), "new\n").await;
    eventually("the copy lists what differs", || async {
        copies(&worker).await[0].differs == ["src/cart.ts", "src/local.ts"]
    })
    .await;
    assert_eq!(read(&c.join("src/cart.ts")).as_deref(), Some("mine\n"));
    assert_eq!(read(&c.join("src/local.ts")).as_deref(), Some("local\n"));
    assert_eq!(read(&s.join("src/cart.ts")).as_deref(), Some("theirs\n"));
    assert!(!s.join("src/local.ts").exists());

    // Later edits on the central host still arrive, and the files that
    // differ still keep this Mac's version.
    write(&s.join("src/cart.ts"), "theirs again\n");
    write(&s.join("docs/new.md"), "newer\n");
    reads(&c.join("docs/new.md"), "newer\n").await;
    assert_eq!(read(&c.join("src/cart.ts")).as_deref(), Some("mine\n"));
    assert_eq!(
        copies(&worker).await[0].differs,
        ["src/cart.ts", "src/local.ts"]
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
            .join("clones/git.invalid/acme/shop")
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
            "{branch} is checked out in {} on this Mac.",
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
    let repo = own_clone(&central, &worker, &[&["branch", "moonlet/fix-cart", "main"]]).await;
    link(&central, &worker).await;
    let _: Copy = worker
        .call("sync.start", json!({ "session": central.session_id() }))
        .await;
    let copy = in_sync(&worker).await;
    let head = git(&s, &["rev-parse", "HEAD"]);
    assert_eq!(git(&PathBuf::from(&copy.path), &["rev-parse", "HEAD"]), head);
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

/// A fake central host serving one session (the clone `repo`, on branch
/// `fix-cart`) that, once the copy is made, sends an update whose tree
/// holds `..`: a path outside the copy.
async fn hostile_central(repo: PathBuf) -> String {
    fake_central(repo, Update::Outside, Default::default()).await
}

/// What [`fake_central`] sends once the copy is made.
enum Update {
    /// A tree with `../escaped.txt`.
    Outside,
    /// `src/cart.ts` as `c`, against a base the worker never had, as when
    /// the central host missed the worker's last reply.
    StaleBase,
}

/// A fake central host serving one session (the clone `repo`, on branch
/// `fix-cart`); the worker's reply to its update goes in `seen`.
async fn fake_central(
    repo: PathBuf,
    update: Update,
    seen: std::sync::Arc<std::sync::Mutex<Option<Value>>>,
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
        while let Ok(Some(frame)) = read_frame(&mut s).await {
            let Frame::Json(Message::Request { id, method, .. }) = frame else {
                continue;
            };
            let reply = match method.as_str() {
                "sync.open" => json!({
                    "path": repo.join("fix-cart"), "branch": "fix-cart", "head": head,
                    "name": "Fix cart", "project": "shop",
                    "identity": { "origin": "git.invalid/acme/shop", "root": root },
                    "origin_url": ORIGIN_URL,
                }),
                "sync.fetch" => json!({ "tree": tree, "head": head, "too_big": [], "pack": null }),
                _ => json!({}),
            };
            write_frame(&mut s, &Frame::Json(Message::ok(id, reply)))
                .await
                .unwrap();
            if method != "sync.fetch" {
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
                Update::StaleBase => {
                    write(&repo.join("c.txt"), "c\n");
                    let blob = git(&repo, &["hash-object", "-w", "c.txt"]);
                    let src = mktree(&repo, &format!("100644 blob {blob}\tcart.ts\n"));
                    let others: String = listing
                        .lines()
                        .filter(|l| !l.ends_with("\tsrc"))
                        .map(|l| format!("{l}\n"))
                        .collect();
                    let new = mktree(&repo, &format!("{others}040000 tree {src}\tsrc\n"));
                    // The empty tree: a base this copy never had.
                    (
                        new,
                        format!("{src}\n{blob}"),
                        "4b825dc642cb6eb9a060e54bf8d69288fbee4904".to_string(),
                    )
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
            tokio::time::sleep(Duration::from_millis(500)).await;
            for f in moonlet_proto::pack_frames(1, &pack) {
                write_frame(&mut s, &f).await.unwrap();
            }
            let update = json!({ "copy": "", "base": base, "tree": bad, "head": head, "too_big": [], "pack": 1 });
            let copy_id = std::fs::read_to_string(repo.join("copy-id")).unwrap_or_default();
            let mut update = update;
            update["copy"] = json!(copy_id.trim());
            write_frame(
                &mut s,
                &Frame::Json(Message::Request {
                    id: 1,
                    method: "sync.update".into(),
                    params: update,
                }),
            )
            .await
            .unwrap();
            while let Ok(Some(frame)) = read_frame(&mut s).await {
                if let Frame::Json(Message::Response {
                    id: 1,
                    result,
                    error,
                }) = frame
                {
                    *seen.lock().unwrap() = Some(json!({ "result": result, "error": error }));
                    break;
                }
            }
        }
    });
    addr
}

#[tokio::test]
async fn an_update_reaching_outside_the_copy_pauses_it_and_writes_nothing() {
    let scratch = tempfile::tempdir().unwrap();
    let origin = origin(scratch.path());
    let repo = scratch.path().join("studio-mini-shop");
    git(
        scratch.path(),
        &["clone", "-q", origin.to_str().unwrap(), "studio-mini-shop"],
    );
    let addr = hostile_central(repo.clone()).await;
    let worker = worker(&origin).await;
    let token = "ab".repeat(32);
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": token } }),
        )
        .await;
    let started: Copy = worker.call("sync.start", json!({ "session": "s1" })).await;
    std::fs::write(repo.join("copy-id"), &started.id).unwrap();
    in_sync(&worker).await;
    let copy = copy_in(&worker, paused, "paused").await;
    assert_eq!(reason(&copy), "studio-mini sent a path outside the copy.");
    let c = PathBuf::from(&copy.path);
    assert!(!c.parent().unwrap().join("escaped.txt").exists());
    assert_eq!(read(&c.join("src/cart.ts")).as_deref(), Some("a\n"));
}

#[tokio::test]
async fn an_update_against_a_base_the_copy_moved_past_applies_and_gives_the_copys_base() {
    let scratch = tempfile::tempdir().unwrap();
    let origin = origin(scratch.path());
    let repo = scratch.path().join("studio-mini-shop");
    git(
        scratch.path(),
        &["clone", "-q", origin.to_str().unwrap(), "studio-mini-shop"],
    );
    let reply = std::sync::Arc::new(std::sync::Mutex::new(None));
    let addr = fake_central(repo.clone(), Update::StaleBase, reply.clone()).await;
    let worker = worker(&origin).await;
    let _: Value = worker
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": "ab".repeat(32) } }),
        )
        .await;
    let started: Copy = worker.call("sync.start", json!({ "session": "s1" })).await;
    std::fs::write(repo.join("copy-id"), &started.id).unwrap();
    let copy = in_sync(&worker).await;
    let c = PathBuf::from(&copy.path);
    reads(&c.join("src/cart.ts"), "c\n").await;
    eventually("the worker replies", || async {
        reply.lock().unwrap().is_some()
    })
    .await;
    let got = reply.lock().unwrap().clone().unwrap();
    assert_eq!(got["error"], Value::Null, "{got}");
    // Nothing differs, so the new base is the update's tree.
    assert_eq!(got["result"]["base"], got["result"]["tree"], "{got}");
    assert_eq!(got["result"]["differs"], json!([]));
}
