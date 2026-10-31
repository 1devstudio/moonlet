//! X72: every session of a member is listed on the central host, with the
//! member that owns it, and the central host keeps a copy of its worktree. A central host listens on 127.0.0.1
//! (`MOONLET_MOBILE_ADDRS`) instead of a Tailscale address, and a Mac pairs
//! with it and links, as the desktop app makes it do.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::*;
use moonlet_proto::methods::{DeviceKind, MobilePairing};
use serde_json::{Value, json};

const BOOK: &str = "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37";

/// The central host `studio-mini`, with tailnet access on.
async fn central() -> (Daemon, String) {
    central_with(&[]).await
}

/// [`central`], with more of the daemon's environment.
async fn central_with(extra: &[(&str, &str)]) -> (Daemon, String) {
    for _ in 0..5 {
        let home = tempfile::tempdir().unwrap();
        let port = free_port();
        std::fs::write(
            home.path().join("mobile.json"),
            format!(r#"{{ "enabled": true, "port": {port} }}"#),
        )
        .unwrap();
        let mut env = vec![
            ("MOONLET_MOBILE_ADDRS", "127.0.0.1"),
            ("MOONLET_WORKER_PING_MS", "200"),
        ];
        env.extend_from_slice(extra);
        let d = Daemon::start(home, &env).await;
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
    panic!("the central host never listened");
}

/// A Mac with a fixed worker id and name, not linked yet. Its own
/// "Tailscale address" is 127.0.0.2, so linking to 127.0.0.1 is not
/// linking to itself.
async fn mac(id: &str, name: &str) -> Daemon {
    mac_with(id, name, &[]).await
}

/// [`mac`], with more of the daemon's environment.
async fn mac_with(id: &str, name: &str, extra: &[(&str, &str)]) -> Daemon {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("link.json"),
        json!({ "central": null, "worker": { "id": id, "name": name, "enabled": false } })
            .to_string(),
    )
    .unwrap();
    let mut env = vec![("MOONLET_MOBILE_ADDRS", "127.0.0.2")];
    env.extend_from_slice(extra);
    Daemon::start(home, &env).await
}

/// Makes `central` the Mac's central host.
async fn link(mac: &Daemon, central: &Daemon, addr: &str) {
    let p: MobilePairing = central
        .call("mobile.pair_start", json!({ "kind": "desktop" }))
        .await;
    let token =
        moonlet_link::tailnet::pair(&[addr.to_string()], &p.code, "MacBook", DeviceKind::Desktop)
            .await
            .unwrap()
            .token;
    let _: Value = mac
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": token } }),
        )
        .await;
}

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
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

/// A project `shop` with one commit and an origin, added to `d`; gives its
/// id. Its origin names it the same on every member (X41's identity).
async fn shop(d: &Daemon) -> String {
    let repo = d.home.path().join("src/shop");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/shop.git",
        ],
    );
    std::fs::write(repo.join("README.md"), "shop\n").unwrap();
    git(&repo, &["add", "."]);
    git(
        &repo,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "-m",
            "shop",
        ],
    );
    let project: Value = d.call("project.add", json!({ "path": repo })).await;
    project["id"].as_str().unwrap().to_string()
}

async fn new_session(d: &Daemon, project: &str, name: &str) -> Value {
    d.call(
        "session.create",
        json!({ "project_id": project, "name": name, "agent": "none" }),
    )
    .await
}

/// The central host's list with other members' sessions in it.
async fn with_copies(d: &Daemon) -> Vec<Value> {
    d.call("session.list", json!({ "copies": true })).await
}

#[tokio::test]
async fn a_session_made_on_a_member_is_listed_on_the_central_host_with_its_owner() {
    let (mini, addr) = central().await;
    let book = mac(BOOK, "MacBook").await;
    link(&book, &mini, &addr).await;
    let project = shop(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;

    let listed = within_value(
        Duration::from_secs(5),
        "fix-cart on studio-mini",
        || async {
            with_copies(&mini)
                .await
                .into_iter()
                .find(|s| s["id"] == made["id"])
        },
    )
    .await;
    assert_eq!(listed["name"], json!("fix-cart"));
    assert_eq!(listed["branch"], made["branch"]);
    assert_eq!(
        listed["owner"],
        json!({ "worker": BOOK, "name": "MacBook", "reachable": true })
    );

    // Without `copies`, the list is the central host's own, as before, so
    // an app that lists every member itself never shows one twice.
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(own.iter().all(|s| s["id"] != made["id"]));
}

#[tokio::test]
async fn an_archived_session_leaves_the_central_hosts_list() {
    let (mini, addr) = central().await;
    let book = mac(BOOK, "MacBook").await;
    link(&book, &mini, &addr).await;
    let project = shop(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    within(
        Duration::from_secs(5),
        "fix-cart on studio-mini",
        || async {
            with_copies(&mini)
                .await
                .iter()
                .any(|s| s["id"] == made["id"])
        },
    )
    .await;

    let _: Value = book
        .call("session.archive", json!({ "id": made["id"] }))
        .await;
    within(
        Duration::from_secs(5),
        "fix-cart gone from studio-mini",
        || async {
            with_copies(&mini)
                .await
                .iter()
                .all(|s| s["id"] != made["id"])
        },
    )
    .await;
}

#[tokio::test]
async fn a_session_whose_member_is_gone_is_listed_as_unreachable() {
    let (mini, addr) = central().await;
    let book = mac(BOOK, "MacBook").await;
    link(&book, &mini, &addr).await;
    let project = shop(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    within(
        Duration::from_secs(5),
        "fix-cart on studio-mini",
        || async {
            with_copies(&mini)
                .await
                .iter()
                .any(|s| s["id"] == made["id"])
        },
    )
    .await;

    drop(book);
    within(Duration::from_secs(5), "MacBook unreachable", || async {
        with_copies(&mini)
            .await
            .iter()
            .any(|s| s["id"] == made["id"] && s["owner"]["reachable"] == json!(false))
    })
    .await;
}

#[tokio::test]
async fn sessions_made_before_the_member_shared_its_account_reach_the_central_host() {
    let (mini, addr) = central().await;
    let book = mac(BOOK, "MacBook").await;
    let project = shop(&book).await;
    let made = new_session(&book, &project, "older").await;

    link(&book, &mini, &addr).await;
    within(Duration::from_secs(5), "older on studio-mini", || async {
        with_copies(&mini)
            .await
            .iter()
            .any(|s| s["id"] == made["id"])
    })
    .await;
}

// --- The copy of the worktree ------------------------------------------

/// The origin URL every clone of `shop` names, so the project's identity
/// is the same on every member. A `url.insteadOf` rule in each daemon's git
/// config leads it to a local bare repository.
const ORIGIN_URL: &str = "https://github.com/acme/shop.git";

/// A bare origin of `shop` with one commit, and a git config that leads
/// [`ORIGIN_URL`] to it.
struct Origin {
    dir: tempfile::TempDir,
}

impl Origin {
    fn new() -> Origin {
        let dir = tempfile::tempdir().unwrap();
        let bare = dir.path().join("shop.git");
        std::fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "-q", "--bare", "-b", "main"]);
        let seed = dir.path().join("seed");
        std::fs::create_dir_all(seed.join("src")).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        std::fs::write(seed.join("src/cart.ts"), "a\n").unwrap();
        git(&seed, &["add", "-A"]);
        git(
            &seed,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-qm",
                "init",
            ],
        );
        git(&seed, &["push", "-q", bare.to_str().unwrap(), "main"]);
        std::fs::write(
            dir.path().join("gitconfig"),
            format!(
                "[url \"{}\"]\n\tinsteadOf = {ORIGIN_URL}\n[user]\n\tname = t\n\temail = t@t\n",
                bare.display()
            ),
        )
        .unwrap();
        Origin { dir }
    }

    fn config(&self) -> String {
        self.dir.path().join("gitconfig").display().to_string()
    }

    /// Clones `shop` into `d`'s home and adds it as a project; gives its id.
    async fn add_to(&self, d: &Daemon) -> String {
        let repo = d.home.path().join("src/shop");
        std::fs::create_dir_all(repo.parent().unwrap()).unwrap();
        let out = std::process::Command::new("git")
            .args(["clone", "-q", ORIGIN_URL, repo.to_str().unwrap()])
            .env("GIT_CONFIG_GLOBAL", self.config())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let project: Value = d.call("project.add", json!({ "path": repo })).await;
        project["id"].as_str().unwrap().to_string()
    }
}

fn env_for(origin: &Origin) -> Vec<(String, String)> {
    vec![
        ("GIT_CONFIG_GLOBAL".to_string(), origin.config()),
        ("MOONLET_SYNC_LOCAL_ORIGINS".to_string(), "1".to_string()),
    ]
}

/// [`central`], with `origin`'s git config so it can clone `shop`, and a
/// [`mac`] linked to it. The Mac's own git config is left alone: with the
/// rule in it, git would name the origin by its local folder.
async fn pair_of(origin: &Origin) -> (Daemon, String, Daemon) {
    let env = env_for(origin);
    let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let (mini, addr) = central_with(&env).await;
    let book = mac(BOOK, "MacBook").await;
    link(&book, &mini, &addr).await;
    (mini, addr, book)
}

/// Where the central host keeps its copy of `session`, once it has one.
async fn copy_of(mini: &Daemon, session: &Value) -> PathBuf {
    within_value(Duration::from_secs(15), "a copy on studio-mini", || async {
        with_copies(mini)
            .await
            .into_iter()
            .find(|s| s["id"] == session["id"])
            .and_then(|s| {
                s["path"]
                    .as_str()
                    .filter(|p| !p.is_empty())
                    .map(PathBuf::from)
            })
    })
    .await
}

fn path_of(session: &Value) -> PathBuf {
    PathBuf::from(session["path"].as_str().unwrap())
}

fn head(dir: &Path) -> String {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(dir)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

async fn reads(path: &Path, text: &str) {
    within(
        Duration::from_secs(15),
        &format!("{} reading {text:?}", path.display()),
        || async { std::fs::read_to_string(path).is_ok_and(|t| t == text) },
    )
    .await;
}

#[tokio::test]
async fn an_edit_on_the_member_reaches_the_central_hosts_copy() {
    let origin = Origin::new();
    let (mini, _addr, book) = pair_of(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    let copy = copy_of(&mini, &made).await;
    assert_eq!(
        std::fs::read_to_string(copy.join("src/cart.ts")).unwrap(),
        "a\n"
    );

    std::fs::write(path_of(&made).join("src/cart.ts"), "b\n").unwrap();
    std::fs::write(path_of(&made).join("notes.md"), "new\n").unwrap();
    reads(&copy.join("src/cart.ts"), "b\n").await;
    reads(&copy.join("notes.md"), "new\n").await;
}

#[tokio::test]
async fn a_commit_on_the_member_moves_the_copys_branch_to_it() {
    let origin = Origin::new();
    let (mini, _addr, book) = pair_of(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    let copy = copy_of(&mini, &made).await;

    let path = path_of(&made);
    std::fs::write(path.join("src/cart.ts"), "c\n").unwrap();
    git(&path, &["add", "-A"]);
    git(
        &path,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "cart",
        ],
    );
    let commit = head(&path);
    within(
        Duration::from_secs(15),
        "the copy at the member's commit",
        || async { head(&copy) == commit },
    )
    .await;
}

#[tokio::test]
async fn a_central_host_without_the_project_clones_it_from_its_origin() {
    let origin = Origin::new();
    let (mini, _addr, book) = pair_of(&origin).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    std::fs::write(path_of(&made).join("src/cart.ts"), "d\n").unwrap();

    let copy = copy_of(&mini, &made).await;
    reads(&copy.join("src/cart.ts"), "d\n").await;
    // The copy's folder says whose session it is (X60's `copies/<host>`).
    assert!(
        copy.starts_with(mini.home.path().join("copies/MacBook/shop")),
        "{}",
        copy.display()
    );
}

#[tokio::test]
async fn an_edit_made_in_the_copy_is_put_back_and_kept_in_leftovers() {
    let origin = Origin::new();
    let (mini, _addr, book) = pair_of(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    let copy = copy_of(&mini, &made).await;
    reads(&copy.join("src/cart.ts"), "a\n").await;

    std::fs::write(copy.join("src/cart.ts"), "by hand\n").unwrap();
    std::fs::write(path_of(&made).join("notes.md"), "next\n").unwrap();
    reads(&copy.join("notes.md"), "next\n").await;
    assert_eq!(
        std::fs::read_to_string(copy.join("src/cart.ts")).unwrap(),
        "a\n"
    );
    let kept: Vec<PathBuf> = std::fs::read_dir(mini.home.path().join("sync-leftovers"))
        .unwrap()
        .map(|e| e.unwrap().path().join("src/cart.ts"))
        .filter(|p| p.exists())
        .collect();
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(std::fs::read_to_string(&kept[0]).unwrap(), "by hand\n");
}

#[tokio::test]
async fn an_archived_sessions_copy_is_removed() {
    let origin = Origin::new();
    let (mini, _addr, book) = pair_of(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    let copy = copy_of(&mini, &made).await;

    let _: Value = book
        .call("session.archive", json!({ "id": made["id"] }))
        .await;
    within(Duration::from_secs(15), "the copy removed", || async {
        !copy.exists()
    })
    .await;
}

#[tokio::test]
async fn a_copy_never_moves_a_branch_of_the_central_hosts_own() {
    let origin = Origin::new();
    let (mini, _addr, book) = pair_of(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    let branch = made["branch"].as_str().unwrap().to_string();
    // studio-mini has a branch of that name of its own, ahead of main.
    let own = mini.home.path().join("src/shop");
    git(&own, &["switch", "-q", "-c", &branch]);
    std::fs::write(own.join("mini.txt"), "mini\n").unwrap();
    git(&own, &["add", "-A"]);
    git(
        &own,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "mini's own",
        ],
    );
    git(&own, &["switch", "-q", "main"]);
    let mine = String::from_utf8(
        std::process::Command::new("git")
            .args(["rev-parse", &branch])
            .current_dir(&own)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();

    let path = path_of(&made);
    std::fs::write(path.join("src/cart.ts"), "e\n").unwrap();
    git(&path, &["add", "-A"]);
    git(
        &path,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "cart",
        ],
    );
    let commit = head(&path);
    let copy = copy_of(&mini, &made).await;
    within(
        Duration::from_secs(15),
        "the copy at the member's commit",
        || async { head(&copy) == commit },
    )
    .await;
    let after = String::from_utf8(
        std::process::Command::new("git")
            .args(["rev-parse", &branch])
            .current_dir(&own)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    assert_eq!(after, mine);
}

#[tokio::test]
async fn a_copy_switched_by_hand_to_another_branch_goes_back_without_moving_it() {
    let origin = Origin::new();
    let (mini, _addr, book) = pair_of(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    let copy = copy_of(&mini, &made).await;
    reads(&copy.join("src/cart.ts"), "a\n").await;
    git(&copy, &["switch", "-q", "-c", "by-hand"]);
    let before = head(&copy);

    let path = path_of(&made);
    std::fs::write(path.join("src/cart.ts"), "f\n").unwrap();
    git(&path, &["add", "-A"]);
    git(
        &path,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "cart",
        ],
    );
    let commit = head(&path);
    within(
        Duration::from_secs(15),
        "the copy at the member's commit",
        || async { head(&copy) == commit },
    )
    .await;
    let after = String::from_utf8(
        std::process::Command::new("git")
            .args(["rev-parse", "by-hand"])
            .current_dir(&copy)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    assert_eq!(after.trim(), before);
}
