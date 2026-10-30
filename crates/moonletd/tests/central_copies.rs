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
const MINI: &str = "3c9a5e71-0d2b-4f86-a1c4-9e7b2d5f8a03";

/// The central host `studio-mini`, with tailnet access on.
async fn central() -> (Daemon, String) {
    central_with(&[]).await
}

/// [`central`], with more of the daemon's environment.
async fn central_with(extra: &[(&str, &str)]) -> (Daemon, String) {
    for _ in 0..5 {
        let home = tempfile::tempdir().unwrap();
        let port = free_port();
        // A fixed name, as members call it, never this Mac's.
        std::fs::write(
            home.path().join("link.json"),
            json!({ "central": null, "worker": { "id": MINI, "name": "studio-mini", "enabled": false } })
                .to_string(),
        )
        .unwrap();
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

/// Milliseconds since the epoch, as the daemon stamps them.
fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[tokio::test]
async fn a_session_whose_member_is_gone_says_since_when() {
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
    // A reachable owner has no time it went away.
    assert!(listed["owner"].get("unreachable_since").is_none(), "{listed}");

    let before = epoch_ms();
    drop(book);
    let owner = within_value(Duration::from_secs(5), "MacBook unreachable", || async {
        with_copies(&mini)
            .await
            .into_iter()
            .find(|s| s["id"] == made["id"] && s["owner"]["reachable"] == json!(false))
            .map(|s| s["owner"].clone())
    })
    .await;
    // The phone waits 30 s from this before it offers Continue.
    let since = owner["unreachable_since"].as_u64().unwrap_or_else(|| panic!("{owner}"));
    assert!(since >= before && since <= epoch_ms(), "{since} not after {before}");
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
    within_value(Duration::from_secs(30), "a copy on studio-mini", || async {
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
        Duration::from_secs(30),
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
        Duration::from_secs(30),
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
    within(Duration::from_secs(30), "the copy removed", || async {
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
        Duration::from_secs(30),
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
        Duration::from_secs(30),
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

// --- The chat, the transcript and checkpoints ---------------------------

/// A fake `claude` speaking stream-json: its conversation id is fixed, and
/// for each message it runs one tool, which writes `src/cart.ts`, and
/// answers. It keeps its transcript where Claude Code does, in
/// `$CLAUDE_CONFIG_DIR/projects/<folder>/<id>.jsonl`.
const TOOL_CLAUDE: &str = r#"#!/bin/sh
ID=0d6e2a4c-1b3f-4a5e-9c7d-8e1f2a3b4c5d
DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$DIR/$ID/tool-results"
T="$DIR/$ID.jsonl"
echo "$@" >> "$HOME/claude-args"
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"'$ID'","model":"fake"}' ;;
    *'"type":"user"'*HOLD*)
      echo "$line" >> "$HOME/claude-user"
      USE='{"type":"assistant","message":{"id":"m9","role":"assistant","content":[{"type":"tool_use","id":"toolu_09","name":"Bash","input":{"command":"sleep 600"}}]},"session_id":"'$ID'"}'
      echo "$USE"; echo "$USE" >> "$T" ;;
    *'"type":"user"'*)
      echo "$line" >> "$HOME/claude-user"
      echo '{"type":"user","message":{"role":"user","content":"Fix the cart"},"sessionId":"'$ID'"}' >> "$T"
      USE='{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"printf b > src/cart.ts"}}]},"session_id":"'$ID'"}'
      echo "$USE"; echo "$USE" >> "$T"
      printf 'b\n' > src/cart.ts
      printf 'full output\n' > "$DIR/$ID/tool-results/toolu_01.txt"
      RESULT='{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01","type":"tool_result","content":"done"}]},"session_id":"'$ID'"}'
      echo "$RESULT"; echo "$RESULT" >> "$T"
      SAID='{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"Fixed."}]},"session_id":"'$ID'"}'
      echo "$SAID"; echo "$SAID" >> "$T"
      echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}' ;;
  esac
done
"#;

/// The conversation id [`TOOL_CLAUDE`] gives.
const CONVERSATION: &str = "0d6e2a4c-1b3f-4a5e-9c7d-8e1f2a3b4c5d";

/// The environment of a daemon whose agents are [`TOOL_CLAUDE`]: its HOME
/// and shell are its own scratch ones, so its agents' Claude Code folder is
/// that HOME's `.claude`, never the user's.
fn agent_env(home: &Path, origin: Option<&Origin>) -> Vec<(String, String)> {
    use std::os::unix::fs::PermissionsExt;
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("claude"), TOOL_CLAUDE).unwrap();
    std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let first = format!("PATH=\"{}:$PATH\"; export PATH\n", bin.display());
    for rc in [
        ".profile",
        ".zshenv",
        ".zprofile",
        ".zshrc",
        ".bash_profile",
    ] {
        std::fs::write(home.join(rc), &first).unwrap();
    }
    let mut env = vec![
        ("HOME".to_string(), home.display().to_string()),
        ("SHELL".to_string(), "/bin/sh".to_string()),
        // `power.simulate` stands in for the Mac's sleep (X73).
        ("MOONLET_TEST_POWER".to_string(), "1".to_string()),
        // Continue here and Take over anyway after 1 s offline instead of
        // 30 (X73).
        (
            "MOONLET_TEST_UNREACHABLE_MS".to_string(),
            "1000".to_string(),
        ),
        (
            "PATH".to_string(),
            format!("{}:/usr/bin:/bin", bin.display()),
        ),
    ];
    if let Some(o) = origin {
        env.extend(env_for(o));
    }
    env
}

/// [`pair_of`], both daemons with [`TOOL_CLAUDE`] for an agent.
async fn pair_with_agents(origin: &Origin) -> (Daemon, Daemon) {
    pair_with_agents_as(origin, true).await
}

/// [`pair_with_agents`]; without `clone_rule`, studio-mini has no git rule
/// that leads the origin to a local folder, so its own project of `shop`
/// has the identity the MacBook's has, as on real Macs.
async fn pair_with_agents_as(origin: &Origin, clone_rule: bool) -> (Daemon, Daemon) {
    let scratch = tempfile::tempdir().unwrap();
    let mini_home = scratch.path().join("mini");
    let book_home = scratch.path().join("book");
    std::fs::create_dir_all(&mini_home).unwrap();
    std::fs::create_dir_all(&book_home).unwrap();
    let mini_env = agent_env(&mini_home, clone_rule.then_some(origin));
    let book_env = agent_env(&book_home, None);
    let m: Vec<(&str, &str)> = mini_env
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let b: Vec<(&str, &str)> = book_env
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let (mini, addr) = central_with(&m).await;
    let book = mac_with(BOOK, "MacBook", &b).await;
    link(&book, &mini, &addr).await;
    std::mem::forget(scratch);
    (mini, book)
}

/// A session of `shop` on `book` with a chat agent, after one message.
async fn session_with_a_turn(book: &Daemon, project: &str) -> Value {
    let made: Value = book
        .call(
            "session.create",
            json!({ "project_id": project, "name": "fix-cart", "agent": "claude" }),
        )
        .await;
    let agent = made["terminals"][0].clone();
    let _: Value = book
        .call("chat.send", json!({ "id": agent, "text": "Fix the cart" }))
        .await;
    within(Duration::from_secs(30), "the turn to end", || async {
        let st: Value = book.call("chat.state", json!({ "id": agent })).await;
        st["status"] == json!("done")
    })
    .await;
    made
}

fn claude_home(d: &Daemon) -> PathBuf {
    let env: std::collections::HashMap<_, _> = d.env.iter().cloned().collect();
    PathBuf::from(&env["HOME"]).join(".claude")
}

#[tokio::test]
async fn a_members_chat_reaches_the_central_hosts_copy() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;

    let chat = within_value(
        Duration::from_secs(30),
        "the chat on studio-mini",
        || async {
            let info: Value = mini
                .try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .ok()?;
            let chat = info["chats"][0]["state"].clone();
            (chat["status"] == json!("done")).then_some(chat)
        },
    )
    .await;
    let kinds: Vec<&str> = chat["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["user", "tool", "assistant"]);
    assert_eq!(chat["items"][0]["text"], json!("Fix the cart"));
    assert_eq!(chat["agent_session"], json!(CONVERSATION));
}

#[tokio::test]
async fn the_agents_transcript_reaches_the_central_host_where_claude_code_reads_it() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let copy = copy_of(&mini, &made).await;

    // Where Claude Code would look on studio-mini for the copy's folder.
    let folder = |home: PathBuf, path: &Path| {
        home.join("projects").join(
            path.canonicalize()
                .unwrap()
                .display()
                .to_string()
                .replace(|c: char| !c.is_ascii_alphanumeric(), "-"),
        )
    };
    let theirs = folder(claude_home(&book), &path_of(&made));
    let ours = folder(claude_home(&mini), &copy);
    let original = std::fs::read_to_string(theirs.join(format!("{CONVERSATION}.jsonl"))).unwrap();
    assert_eq!(original.lines().count(), 4);
    reads(&ours.join(format!("{CONVERSATION}.jsonl")), &original).await;
    reads(
        &ours.join(format!("{CONVERSATION}/tool-results/toolu_01.txt")),
        "full output\n",
    )
    .await;
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(ours.join(format!("{CONVERSATION}.jsonl")))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[tokio::test]
async fn a_checkpoint_after_the_turn_names_its_files_and_its_whole_transcript() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let path = path_of(&made);
    let transcript = std::fs::read(
        claude_home(&book)
            .join("projects")
            .join(
                path.canonicalize()
                    .unwrap()
                    .display()
                    .to_string()
                    .replace(|c: char| !c.is_ascii_alphanumeric(), "-"),
            )
            .join(format!("{CONVERSATION}.jsonl")),
    )
    .unwrap();

    let point = within_value(
        Duration::from_secs(30),
        "a checkpoint at the end of the turn",
        || async {
            let info = mini
                .try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .ok()?;
            let p: Value = info["checkpoint"].clone();
            (p["len"] == json!(transcript.len())).then_some((info, p))
        },
    )
    .await;
    let (info, p) = point;
    assert_eq!(p["agent_session"], json!(CONVERSATION));
    assert_eq!(p["head"], json!(head(&path)));
    assert_eq!(p["tree"], info["tree"]);
    let copy = PathBuf::from(info["path"].as_str().unwrap());
    assert_eq!(
        std::fs::read_to_string(copy.join("src/cart.ts")).unwrap(),
        "b\n"
    );
}

// --- Requests through the central host ----------------------------------

async fn forward(
    mini: &Daemon,
    session: &Value,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    mini.try_call(
        "session.forward",
        json!({ "session": session["id"], "method": method, "params": params }),
    )
    .await
}

#[tokio::test]
async fn a_message_through_the_central_host_reaches_the_owners_agent() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let agent = made["terminals"][0].clone();

    forward(
        &mini,
        &made,
        "chat.send",
        json!({ "id": agent, "text": "Again" }),
    )
    .await
    .unwrap();
    within(
        Duration::from_secs(30),
        "the second message on the MacBook",
        || async {
            let st: Value = book.call("chat.state", json!({ "id": agent })).await;
            st["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|i| i["kind"] == "user" && i["text"] == "Again")
        },
    )
    .await;
}

#[tokio::test]
async fn git_status_through_the_central_host_comes_from_the_owner() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    copy_of(&mini, &made).await;

    // Whatever path the client names, the owner's worktree answers: its
    // branch is the session's, where the copy's is a branch of its own.
    let status = forward(&mini, &made, "git.status", json!({ "path": "/" }))
        .await
        .unwrap();
    assert_eq!(status["branch"], made["branch"]);
}

#[tokio::test]
async fn a_chat_that_is_not_the_sessions_cannot_be_reached_through_it() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    let other = session_with_a_turn(&book, &project).await;
    copy_of(&mini, &made).await;

    let refused = forward(
        &mini,
        &made,
        "chat.send",
        json!({ "id": other["terminals"][0], "text": "x" }),
    )
    .await
    .unwrap_err();
    assert!(refused.starts_with("forbidden"), "{refused}");
    let refused = forward(&mini, &made, "terminal.create", json!({}))
        .await
        .unwrap_err();
    assert!(refused.starts_with("forbidden"), "{refused}");
}

#[tokio::test]
async fn with_the_owner_away_reads_come_from_the_copy_and_the_rest_waits_for_it() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let agent = made["terminals"][0].clone();
    within(
        Duration::from_secs(30),
        "the chat on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| i["chats"][0]["state"]["status"] == json!("done"))
        },
    )
    .await;
    copy_of(&mini, &made).await;

    drop(book);
    within(Duration::from_secs(5), "MacBook unreachable", || async {
        with_copies(&mini)
            .await
            .iter()
            .any(|s| s["id"] == made["id"] && s["owner"]["reachable"] == json!(false))
    })
    .await;
    let state = forward(&mini, &made, "chat.state", json!({ "id": agent }))
        .await
        .unwrap();
    assert_eq!(state["items"][0]["text"], json!("Fix the cart"));
    let status = forward(&mini, &made, "git.status", json!({}))
        .await
        .unwrap();
    assert_eq!(
        status["branch"],
        json!(format!("moonlet-copy/{}", made["id"].as_str().unwrap()))
    );
    let waits = forward(
        &mini,
        &made,
        "chat.send",
        json!({ "id": agent, "text": "Again" }),
    )
    .await
    .unwrap_err();
    assert!(waits.starts_with("owner_offline"), "{waits}");
    assert!(waits.contains("MacBook"), "{waits}");
}

#[tokio::test]
async fn the_owners_chat_events_reach_the_central_hosts_clients() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let agent = made["terminals"][0].clone();
    copy_of(&mini, &made).await;
    let mut listener = mini.app().await;

    forward(
        &mini,
        &made,
        "chat.send",
        json!({ "id": agent, "text": "Again" }),
    )
    .await
    .unwrap();
    let event = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            match listener.next_frame().await.unwrap() {
                Some(moonlet_proto::Frame::Json(moonlet_proto::Message::Event { name, data }))
                    if name == "session.event" && data["event"]["name"] == json!("chat.item") =>
                {
                    return data;
                }
                Some(_) => {}
                None => panic!("the connection ended"),
            }
        }
    })
    .await
    .expect("no session.event");
    assert_eq!(event["session"], made["id"]);
    assert_eq!(event["event"]["data"]["id"], agent);
}

// --- Terminals through the central host ----------------------------------

/// A shell in `session`'s worktree on `d`; gives its terminal id.
async fn shell(d: &Daemon, session: &Value) -> Value {
    let info: Value = d
        .call(
            "terminal.create",
            json!({ "cwd": session["path"], "command": ["/bin/sh"], "session_id": session["id"] }),
        )
        .await;
    info["id"].clone()
}

#[tokio::test]
async fn a_terminal_of_the_owners_session_is_followed_and_typed_into_through_the_central_host() {
    use moonlet_proto::{Frame, Message};
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    let term = shell(&book, &made).await;
    within(
        Duration::from_secs(10),
        "the shell on studio-mini's list",
        || async {
            mini.try_call("session.list", json!({ "copies": true }))
                .await
                .is_ok()
                && with_copies(&mini)
                    .await
                    .iter()
                    .any(|s| s["id"] == made["id"])
        },
    )
    .await;

    let mut phone = mini.app().await;
    let attached: Value = phone
        .request(
            "session.attach",
            json!({ "session": made["id"], "terminal": term }),
        )
        .await
        .unwrap();
    let relay = attached["info"]["id"].as_u64().unwrap();
    // Not one of studio-mini's own terminals, nor the MacBook's id.
    assert!(relay >= 0x4000_0000, "{relay}");
    assert!(attached["snapshot"].is_string());

    phone
        .send(&Frame::Input {
            terminal: relay as u32,
            data: b"echo relayed-$((40+2))\n".to_vec(),
        })
        .await
        .unwrap();
    let seen = tokio::time::timeout(Duration::from_secs(30), async {
        let mut out = String::new();
        loop {
            match phone.next_frame().await.unwrap() {
                Some(Frame::Output { terminal, data }) if u64::from(terminal) == relay => {
                    out.push_str(&String::from_utf8_lossy(&data));
                    if out.contains("relayed-42") {
                        return out;
                    }
                }
                Some(Frame::Json(Message::Event { .. })) | Some(_) => {}
                None => panic!("the connection ended"),
            }
        }
    })
    .await
    .expect("no relayed output");
    assert!(seen.contains("relayed-42"));
}

#[tokio::test]
async fn a_terminal_that_is_not_the_sessions_is_not_followed_through_it() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    let other = new_session(&book, &project, "other").await;
    let theirs = shell(&book, &other).await;
    within(
        Duration::from_secs(10),
        "fix-cart on studio-mini",
        || async {
            with_copies(&mini)
                .await
                .iter()
                .any(|s| s["id"] == made["id"])
        },
    )
    .await;

    let refused = mini
        .try_call(
            "session.attach",
            json!({ "session": made["id"], "terminal": theirs }),
        )
        .await
        .unwrap_err();
    assert!(refused.starts_with("forbidden"), "{refused}");
}

#[tokio::test]
async fn a_client_cannot_pick_a_relay_through_a_forwarded_request() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    let term = shell(&book, &made).await;
    within(
        Duration::from_secs(10),
        "fix-cart on studio-mini",
        || async {
            with_copies(&mini)
                .await
                .iter()
                .any(|s| s["id"] == made["id"])
        },
    )
    .await;

    for (method, params) in [
        (
            "terminal.attach",
            json!({ "id": term, "relay": 0x4000_0001u32 }),
        ),
        ("terminal.detach", json!({ "relay": 0x4000_0001u32 })),
    ] {
        let refused = forward(&mini, &made, method, params).await.unwrap_err();
        assert!(refused.starts_with("forbidden"), "{method}: {refused}");
    }
}

#[tokio::test]
async fn a_terminal_can_be_followed_as_soon_as_its_member_links() {
    use moonlet_proto::{Frame, Message};
    let origin = Origin::new();
    let scratch = tempfile::tempdir().unwrap();
    let (mini_home, book_home) = (scratch.path().join("mini"), scratch.path().join("book"));
    std::fs::create_dir_all(&mini_home).unwrap();
    std::fs::create_dir_all(&book_home).unwrap();
    let m = agent_env(&mini_home, Some(&origin));
    let b = agent_env(&book_home, None);
    let m: Vec<(&str, &str)> = m.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let b: Vec<(&str, &str)> = b.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let (mini, addr) = central_with(&m).await;
    let book = mac_with(BOOK, "MacBook", &b).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    // Made before the Mac links, so the session is listed on studio-mini
    // as soon as the link is up.
    let made = new_session(&book, &project, "fix-cart").await;
    let term = shell(&book, &made).await;
    link(&book, &mini, &addr).await;
    within(
        Duration::from_secs(30),
        "fix-cart on studio-mini",
        || async {
            with_copies(&mini)
                .await
                .iter()
                .any(|s| s["id"] == made["id"] && s["owner"]["reachable"] == json!(true))
        },
    )
    .await;

    let mut phone = mini.app().await;
    let attached: Value = phone
        .request(
            "session.attach",
            json!({ "session": made["id"], "terminal": term }),
        )
        .await
        .unwrap();
    let relay = attached["info"]["id"].as_u64().unwrap() as u32;
    phone
        .send(&Frame::Input {
            terminal: relay,
            data: b"echo early-$((6*7))\n".to_vec(),
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut out = String::new();
        loop {
            match phone.next_frame().await.unwrap() {
                Some(Frame::Output { terminal, data }) if terminal == relay => {
                    out.push_str(&String::from_utf8_lossy(&data));
                    if out.contains("early-42") {
                        return;
                    }
                }
                Some(Frame::Json(Message::Event { .. })) | Some(_) => {}
                None => panic!("the connection ended"),
            }
        }
    })
    .await
    .expect("no relayed output right after linking");
    drop(scratch);
}

/// Claude Code's project folder on `d` for worktree `path`.
fn project_folder(d: &Daemon, path: &Path) -> PathBuf {
    claude_home(d).join("projects").join(
        path.canonicalize()
            .unwrap()
            .display()
            .to_string()
            .replace(|c: char| !c.is_ascii_alphanumeric(), "-"),
    )
}

#[tokio::test]
async fn a_transcript_made_again_shorter_replaces_the_central_hosts() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let copy = copy_of(&mini, &made).await;
    let ours = project_folder(&mini, &copy).join(format!("{CONVERSATION}.jsonl"));
    let theirs = project_folder(&book, &path_of(&made)).join(format!("{CONVERSATION}.jsonl"));
    reads(&ours, &std::fs::read_to_string(&theirs).unwrap()).await;

    std::fs::write(&theirs, "{\"type\":\"user\"}\n").unwrap();
    // A chat change makes the member look at its transcript again.
    let agent = made["terminals"][0].clone();
    let _: Value = book
        .call("chat.send", json!({ "id": agent, "text": "Again" }))
        .await;
    within(Duration::from_secs(30), "the turn to end", || async {
        let st: Value = book.call("chat.state", json!({ "id": agent })).await;
        st["status"] == json!("done")
    })
    .await;
    let now = std::fs::read_to_string(&theirs).unwrap();
    assert!(now.starts_with("{\"type\":\"user\"}\n"), "{now}");
    reads(&ours, &now).await;
}

#[tokio::test]
async fn a_transcript_is_never_written_through_a_link_on_the_central_host() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made: Value = book
        .call(
            "session.create",
            json!({ "project_id": project, "name": "fix-cart", "agent": "claude" }),
        )
        .await;
    let copy = copy_of(&mini, &made).await;
    // Something on studio-mini put a link where the transcript goes.
    let folder = project_folder(&mini, &copy);
    std::fs::create_dir_all(&folder).unwrap();
    let elsewhere = tempfile::NamedTempFile::new().unwrap();
    std::os::unix::fs::symlink(
        elsewhere.path(),
        folder.join(format!("{CONVERSATION}.jsonl")),
    )
    .unwrap();

    let agent = made["terminals"][0].clone();
    let _: Value = book
        .call("chat.send", json!({ "id": agent, "text": "Fix the cart" }))
        .await;
    within(
        Duration::from_secs(30),
        "the chat on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| i["chats"][0]["state"]["status"] == json!("done"))
        },
    )
    .await;
    tokio::time::sleep(Duration::from_secs(6)).await;
    assert_eq!(std::fs::read_to_string(elsewhere.path()).unwrap(), "");
}

#[tokio::test]
async fn a_chat_closed_on_the_member_leaves_the_central_hosts_copy() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let agent = made["terminals"][0].clone();
    within(
        Duration::from_secs(30),
        "the chat on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| i["chats"].as_array().is_some_and(|c| c.len() == 1))
        },
    )
    .await;

    let _: Value = book
        .call("terminal.kill", json!({ "id": agent, "remove": true }))
        .await;
    within(
        Duration::from_secs(30),
        "no chat on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| i["chats"].as_array().is_some_and(|c| c.is_empty()))
        },
    )
    .await;
}

#[tokio::test]
async fn with_the_owner_away_the_prs_status_is_asked_of_the_copy() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    copy_of(&mini, &made).await;
    drop(book);
    within(Duration::from_secs(10), "MacBook unreachable", || async {
        with_copies(&mini)
            .await
            .iter()
            .any(|s| s["id"] == made["id"] && s["owner"]["reachable"] == json!(false))
    })
    .await;

    // Answered by the copy, as the copy can: no gh here, so gh's own
    // error, never owner_offline.
    let answer = forward(&mini, &made, "gh.pr_status", json!({ "path": "/" })).await;
    assert!(
        answer
            .as_ref()
            .err()
            .is_none_or(|e| !e.starts_with("owner_offline")),
        "{answer:?}"
    );
}

// --- X73: continuing a session on the central host ----------------------

/// What the fake agent on `d` was started with, and the messages it got.
fn agent_log(d: &Daemon, file: &str) -> String {
    let env: std::collections::HashMap<_, _> = d.env.iter().cloned().collect();
    std::fs::read_to_string(PathBuf::from(&env["HOME"]).join(file)).unwrap_or_default()
}

/// Waits until `book` is gone from `mini`'s point of view, and for the
/// 1 s a daemon with [`agent_env`] waits before it continues a session.
async fn unreachable(mini: &Daemon, session: &Value) {
    within(Duration::from_secs(10), "MacBook unreachable", || async {
        with_copies(mini)
            .await
            .iter()
            .any(|s| s["id"] == session["id"] && s["owner"]["reachable"] == json!(false))
    })
    .await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
}

#[tokio::test]
async fn a_session_whose_member_is_away_goes_on_on_the_central_host_from_its_copy() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let copy = copy_of(&mini, &made).await;
    within(
        Duration::from_secs(30),
        "the checkpoint on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| !i["checkpoint"].is_null())
        },
    )
    .await;
    drop(book);
    unreachable(&mini, &made).await;

    let continued: Value = mini
        .call("session.continue_here", json!({ "session": made["id"] }))
        .await;
    assert_eq!(continued["id"], made["id"]);
    assert_eq!(continued["branch"], made["branch"]);
    assert_eq!(PathBuf::from(continued["path"].as_str().unwrap()), copy);
    // studio-mini's own now, no longer a copy of another member's.
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(own.iter().any(|s| s["id"] == made["id"]));
    assert!(
        with_copies(&mini)
            .await
            .iter()
            .all(|s| s["id"] != made["id"] || s["owner"].is_null())
    );
    // Its agent resumes the same conversation, with the chat so far.
    let chat = continued["terminals"][0].clone();
    within(
        Duration::from_secs(30),
        "the agent resumed on studio-mini",
        || async { agent_log(&mini, "claude-args").contains(&format!("--resume {CONVERSATION}")) },
    )
    .await;
    let st: Value = mini.call("chat.state", json!({ "id": chat })).await;
    assert_eq!(st["items"][0]["text"], json!("Fix the cart"));
    let _: Value = mini
        .call("chat.send", json!({ "id": chat, "text": "Again" }))
        .await;
    within(Duration::from_secs(30), "a turn on studio-mini", || async {
        agent_log(&mini, "claude-user").contains("Again")
    })
    .await;
}

#[tokio::test]
async fn a_turn_cut_off_on_the_member_goes_on_with_a_note_to_the_agent() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let agent = made["terminals"][0].clone();
    copy_of(&mini, &made).await;
    let _: Value = book
        .call("chat.send", json!({ "id": agent, "text": "HOLD on" }))
        .await;
    within(
        Duration::from_secs(30),
        "the running turn on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| i["chats"][0]["state"]["status"] == json!("working"))
        },
    )
    .await;
    drop(book);
    unreachable(&mini, &made).await;

    let _: Value = mini
        .call("session.continue_here", json!({ "session": made["id"] }))
        .await;
    within(Duration::from_secs(30), "the note on studio-mini", || async {
        agent_log(&mini, "claude-user").contains(
            "This session moved from MacBook to studio-mini because MacBook could not be reached, and your last turn was cut off.",
        )
    })
    .await;
}

#[tokio::test]
async fn a_session_whose_member_is_reachable_is_not_continued_elsewhere() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    copy_of(&mini, &made).await;

    let refused = mini
        .try_call("session.continue_here", json!({ "session": made["id"] }))
        .await
        .unwrap_err();
    assert!(refused.starts_with("reachable"), "{refused}");
}

#[tokio::test]
async fn a_session_whose_member_went_away_less_than_30_s_ago_is_not_continued_yet() {
    let origin = Origin::new();
    // No shorter wait for tests here: the real 30 s.
    let (mini, _addr, book) = pair_of(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    copy_of(&mini, &made).await;
    drop(book);
    unreachable(&mini, &made).await;

    let refused = mini
        .try_call("session.continue_here", json!({ "session": made["id"] }))
        .await
        .unwrap_err();
    assert!(refused.starts_with("not_yet"), "{refused}");
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(own.iter().all(|s| s["id"] != made["id"]));
}

#[tokio::test]
async fn a_continued_chat_never_takes_bypass_permissions_from_the_member() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made: Value = book
        .call(
            "session.create",
            json!({ "project_id": project, "name": "fix-cart", "agent": "claude", "mode": "bypassPermissions" }),
        )
        .await;
    let agent = made["terminals"][0].clone();
    let _: Value = book
        .call("chat.send", json!({ "id": agent, "text": "Fix the cart" }))
        .await;
    within(
        Duration::from_secs(30),
        "the chat on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| {
                    i["chats"][0]["state"]["status"] == json!("done")
                        && !i["path"].as_str().unwrap_or("").is_empty()
                })
        },
    )
    .await;
    // The MacBook's own agent did run that way.
    assert!(agent_log(&book, "claude-args").contains("bypassPermissions"));
    drop(book);
    unreachable(&mini, &made).await;

    let continued: Value = mini
        .call("session.continue_here", json!({ "session": made["id"] }))
        .await;
    let st: Value = mini
        .call("chat.state", json!({ "id": continued["terminals"][0] }))
        .await;
    assert_ne!(st["mode"], json!("bypassPermissions"));
    within(
        Duration::from_secs(30),
        "the agent on studio-mini",
        || async { agent_log(&mini, "claude-args").contains("--resume") },
    )
    .await;
    assert!(!agent_log(&mini, "claude-args").contains("bypassPermissions"));
}

#[tokio::test]
async fn a_continued_chat_keeps_its_folders_inside_the_worktree_in_the_copy() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let agent = made["terminals"][0].clone();
    let elsewhere = tempfile::tempdir().unwrap();
    for dir in [path_of(&made).join("src"), elsewhere.path().to_path_buf()] {
        let _: Value = book
            .call("chat.add_dir", json!({ "id": agent, "path": dir }))
            .await;
    }
    within(
        Duration::from_secs(30),
        "the folders in studio-mini's copy",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| {
                    i["chats"][0]["state"]["add_dirs"]
                        .as_array()
                        .is_some_and(|d| d.len() == 2)
                        && !i["path"].as_str().unwrap_or("").is_empty()
                })
        },
    )
    .await;
    drop(book);
    unreachable(&mini, &made).await;

    let continued: Value = mini
        .call("session.continue_here", json!({ "session": made["id"] }))
        .await;
    let src = path_of(&continued).join("src").display().to_string();
    let st: Value = mini
        .call("chat.state", json!({ "id": continued["terminals"][0] }))
        .await;
    assert_eq!(st["add_dirs"], json!([src]));
    within(
        Duration::from_secs(30),
        "the agent on studio-mini",
        || async { agent_log(&mini, "claude-args").contains(&format!("--add-dir {src}")) },
    )
    .await;
}

#[tokio::test]
async fn a_continued_session_keeps_its_model_and_effort_for_new_chats() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made: Value = book
        .call(
            "session.create",
            json!({ "project_id": project, "name": "fix-cart", "agent": "none", "model": "opus", "effort": "high" }),
        )
        .await;
    copy_of(&mini, &made).await;
    drop(book);
    unreachable(&mini, &made).await;

    let continued: Value = mini
        .call("session.continue_here", json!({ "session": made["id"] }))
        .await;
    assert_eq!(continued["model"], json!("opus"));
    assert_eq!(continued["effort"], json!("high"));
    let _: Value = mini
        .call(
            "terminal.create",
            json!({
                "session_id": made["id"],
                "cwd": continued["path"],
                "kind": "agent",
                "agent": "claude",
                "chat": true,
            }),
        )
        .await;
    within(Duration::from_secs(30), "a new chat on studio-mini", || async {
        agent_log(&mini, "claude-args").contains("--model opus --effort high")
    })
    .await;
}

#[tokio::test]
async fn an_archived_session_is_not_continued_on_the_central_host() {
    let origin = Origin::new();
    let (mini, _addr, book) = pair_of(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = new_session(&book, &project, "fix-cart").await;
    let other = new_session(&book, &project, "other").await;
    copy_of(&mini, &made).await;
    copy_of(&mini, &other).await;
    let _: Value = book
        .call("session.archive", json!({ "id": made["id"] }))
        .await;
    within(
        Duration::from_secs(10),
        "fix-cart gone from studio-mini",
        || async {
            with_copies(&mini)
                .await
                .iter()
                .all(|s| s["id"] != made["id"])
        },
    )
    .await;
    drop(book);
    unreachable(&mini, &other).await;

    let refused = mini
        .try_call("session.continue_here", json!({ "session": made["id"] }))
        .await
        .unwrap_err();
    assert!(refused.starts_with("archived"), "{refused}");
}

#[tokio::test]
async fn a_continue_that_cannot_record_the_new_owner_keeps_the_copy_to_try_again() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let copy = copy_of(&mini, &made).await;
    within(
        Duration::from_secs(30),
        "the chat on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| i["chats"][0]["state"]["status"] == json!("done"))
        },
    )
    .await;
    drop(book);
    unreachable(&mini, &made).await;
    // studio-mini cannot write its account log for now.
    let log = mini.home.path().join("account.json");
    let aside = mini.home.path().join("account.json.aside");
    std::fs::rename(&log, &aside).unwrap();
    std::fs::create_dir(&log).unwrap();

    let refused = mini
        .try_call("session.continue_here", json!({ "session": made["id"] }))
        .await
        .unwrap_err();
    assert!(refused.starts_with("internal"), "{refused}");
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(own.iter().all(|s| s["id"] != made["id"]));

    std::fs::remove_dir(&log).unwrap();
    std::fs::rename(&aside, &log).unwrap();
    let continued: Value = mini
        .call("session.continue_here", json!({ "session": made["id"] }))
        .await;
    assert_eq!(continued["branch"], made["branch"]);
    assert_eq!(PathBuf::from(continued["path"].as_str().unwrap()), copy);
    let st: Value = mini
        .call("chat.state", json!({ "id": continued["terminals"][0] }))
        .await;
    assert_eq!(st["items"][0]["text"], json!("Fix the cart"));
}

#[tokio::test]
async fn a_member_that_lost_its_session_keeps_its_gap_and_follows_the_new_owner() {
    let origin = Origin::new();
    let (mini, mut book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let agent = made["terminals"][0].clone();
    let copy = copy_of(&mini, &made).await;
    reads(&copy.join("src/cart.ts"), "b\n").await;
    within(
        Duration::from_secs(30),
        "the checkpoint on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| !i["checkpoint"].is_null())
        },
    )
    .await;

    // The MacBook goes away; meanwhile its worktree changes on its own.
    book.stop();
    std::fs::write(path_of(&made).join("src/cart.ts"), "while away\n").unwrap();
    unreachable(&mini, &made).await;
    let _: Value = mini
        .call("session.continue_here", json!({ "session": made["id"] }))
        .await;

    book.restart().await;
    within(
        Duration::from_secs(30),
        "fix-cart no longer the MacBook's own",
        || async {
            let own: Vec<Value> = book.call("session.list", json!({})).await;
            own.iter().all(|s| s["id"] != made["id"])
        },
    )
    .await;
    // Its agent stopped, and what it did meanwhile is kept.
    let terminals: Vec<Value> = book.call("terminal.list", json!({})).await;
    assert!(terminals.iter().all(|t| t["id"] != agent));
    let kept: Vec<PathBuf> = std::fs::read_dir(book.home.path().join("sync-leftovers"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    // The changed file on its own, and the whole worktree beside it.
    let files: Vec<&PathBuf> = kept
        .iter()
        .filter(|p| !p.display().to_string().contains("-worktree-"))
        .collect();
    assert_eq!(files.len(), 1, "{kept:?}");
    assert_eq!(
        std::fs::read_to_string(files[0].join("src/cart.ts")).unwrap(),
        "while away\n"
    );
    let whole: Vec<&PathBuf> = kept
        .iter()
        .filter(|p| p.display().to_string().contains("-worktree-"))
        .collect();
    assert_eq!(whole.len(), 1, "{kept:?}");
    assert_eq!(
        std::fs::read_to_string(whole[0].join("src/cart.ts")).unwrap(),
        "while away\n"
    );
    // It keeps a live copy of the session studio-mini runs now (X60).
    within(
        Duration::from_secs(30),
        "a live copy on the MacBook",
        || async {
            let copies: Vec<Value> = book.call("sync.list", json!({})).await;
            copies.iter().any(|c| c["session"] == made["id"])
        },
    )
    .await;
}

/// The session continued on `mini` while `book` was away, with `book`
/// back and keeping a live copy of it.
async fn continued_and_back(origin: &Origin) -> (Daemon, Daemon, Value) {
    let (mini, mut book) = pair_with_agents_as(origin, false).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    copy_of(&mini, &made).await;
    within(
        Duration::from_secs(30),
        "the checkpoint on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| !i["checkpoint"].is_null())
        },
    )
    .await;
    book.stop();
    unreachable(&mini, &made).await;
    let _: Value = mini
        .call("session.continue_here", json!({ "session": made["id"] }))
        .await;
    book.restart().await;
    within(
        Duration::from_secs(30),
        "a live copy on the MacBook",
        || async {
            let copies: Vec<Value> = book.call("sync.list", json!({})).await;
            copies
                .iter()
                .any(|c| c["session"] == made["id"] && !c["path"].as_str().unwrap_or("").is_empty())
        },
    )
    .await;
    (mini, book, made)
}

#[tokio::test]
async fn typing_on_the_member_brings_the_session_back_from_the_central_host() {
    let origin = Origin::new();
    let (mini, book, made) = continued_and_back(&origin).await;

    let back: Value = book
        .call(
            "session.bring",
            json!({ "session": made["id"], "message": "Back here" }),
        )
        .await;
    assert_eq!(back["id"], made["id"]);
    assert_eq!(back["branch"], made["branch"]);
    // Git agrees: its worktree here is on the session's own branch.
    let on = std::process::Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(back["path"].as_str().unwrap())
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&on.stdout).trim(), "moonlet/fix-cart");
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    assert!(own.iter().any(|s| s["id"] == made["id"]));
    // The agent resumes the conversation here and gets the message.
    within(
        Duration::from_secs(30),
        "the message on the MacBook",
        || async { agent_log(&book, "claude-user").contains("Back here") },
    )
    .await;
    assert!(agent_log(&book, "claude-args").contains(&format!("--resume {CONVERSATION}")));
    // studio-mini keeps a copy of it again, the MacBook's.
    within(
        Duration::from_secs(30),
        "a copy on studio-mini again",
        || async {
            let own: Vec<Value> = mini.call("session.list", json!({})).await;
            own.iter().all(|s| s["id"] != made["id"])
                && with_copies(&mini)
                    .await
                    .iter()
                    .any(|s| s["id"] == made["id"] && s["owner"]["worker"] == json!(BOOK))
        },
    )
    .await;
}

#[tokio::test]
async fn a_session_in_the_middle_of_a_turn_comes_back_only_when_asked_now() {
    let origin = Origin::new();
    let (mini, book, made) = continued_and_back(&origin).await;
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    let chat = own.iter().find(|s| s["id"] == made["id"]).unwrap()["terminals"][0].clone();
    let _: Value = mini
        .call("chat.send", json!({ "id": chat, "text": "HOLD there" }))
        .await;
    within(
        Duration::from_secs(30),
        "a turn running on studio-mini",
        || async {
            let st: Value = mini.call("chat.state", json!({ "id": chat })).await;
            st["status"] == json!("working")
        },
    )
    .await;

    let busy = book
        .try_call("session.bring", json!({ "session": made["id"] }))
        .await
        .unwrap_err();
    assert!(busy.starts_with("busy"), "{busy}");
    let back: Value = book
        .call(
            "session.bring",
            json!({ "session": made["id"], "now": true }),
        )
        .await;
    assert_eq!(back["id"], made["id"]);
}

#[tokio::test]
async fn a_message_typed_while_the_session_moves_keeps_it_on_the_central_host() {
    let origin = Origin::new();
    let (mini, book, made) = continued_and_back(&origin).await;
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    let there = own.iter().find(|s| s["id"] == made["id"]).unwrap().clone();
    let chat = there["terminals"][0].clone();
    // studio-mini's git waits, as the move renames the session's branch,
    // until the test says go: a message comes in just then. The hook waits
    // on the rename deleting the old name, the one step every git runs as
    // a transaction; git before 2.46 writes the new name and HEAD outside one.
    let worktree = PathBuf::from(there["path"].as_str().unwrap());
    let common = std::process::Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(&worktree)
        .output()
        .unwrap();
    let hooks = PathBuf::from(String::from_utf8_lossy(&common.stdout).trim()).join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let gate = tempfile::tempdir().unwrap();
    let (started, go) = (gate.path().join("started"), gate.path().join("go"));
    let hook = hooks.join("reference-transaction");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\n[ \"$1\" = prepared ] || exit 0\ngrep -qE ' 0{{40}} refs/heads/moonlet/fix-cart$' || exit 0\n[ -e '{s}' ] && exit 0\ntouch '{s}'\nn=0\nwhile [ ! -e '{g}' ] && [ $n -lt 300 ]; do sleep 0.1; n=$((n+1)); done\n",
            s = started.display(),
            g = go.display()
        ),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let (brought, ()) = tokio::join!(
        book.try_call("session.bring", json!({ "session": made["id"] })),
        async {
            within(Duration::from_secs(30), "the move under way", || async {
                started.exists()
            })
            .await;
            let _: Value = mini
                .call("chat.send", json!({ "id": chat, "text": "Typed meanwhile" }))
                .await;
            std::fs::write(&go, "").unwrap();
        }
    );
    let busy = brought.unwrap_err();
    assert!(busy.starts_with("busy"), "{busy}");
    // It still runs on studio-mini, on its own branch, with the message.
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(own.iter().any(|s| s["id"] == made["id"]), "{own:?}");
    let on = std::process::Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(&worktree)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&on.stdout).trim(), "moonlet/fix-cart");
    let st: Value = mini.call("chat.state", json!({ "id": chat })).await;
    assert!(
        st["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["kind"] == json!("user") && i["text"] == json!("Typed meanwhile")),
        "{st}"
    );
}

#[tokio::test]
async fn a_member_that_lost_its_session_lists_the_files_it_deleted_meanwhile() {
    let origin = Origin::new();
    let (mini, mut book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let copy = copy_of(&mini, &made).await;
    reads(&copy.join("src/cart.ts"), "b\n").await;
    within(
        Duration::from_secs(30),
        "the checkpoint on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| !i["checkpoint"].is_null())
        },
    )
    .await;

    // The MacBook goes away; meanwhile a file goes from its worktree.
    book.stop();
    std::fs::remove_file(path_of(&made).join("src/cart.ts")).unwrap();
    unreachable(&mini, &made).await;
    let _: Value = mini
        .call("session.continue_here", json!({ "session": made["id"] }))
        .await;

    book.restart().await;
    within(
        Duration::from_secs(30),
        "fix-cart no longer the MacBook's own",
        || async {
            let own: Vec<Value> = book.call("session.list", json!({})).await;
            own.iter().all(|s| s["id"] != made["id"])
        },
    )
    .await;
    // The gap's folder names the file it deleted.
    let gap: Vec<PathBuf> = std::fs::read_dir(book.home.path().join("sync-leftovers"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| !p.display().to_string().contains("-worktree-"))
        .collect();
    assert_eq!(gap.len(), 1, "{gap:?}");
    assert_eq!(
        std::fs::read_to_string(gap[0].join("moonlet-deleted.txt")).unwrap(),
        "src/cart.ts\n"
    );
}

#[tokio::test]
async fn a_session_whose_new_owner_cannot_be_recorded_stays_on_the_central_host() {
    let origin = Origin::new();
    let (mini, book, made) = continued_and_back(&origin).await;
    // studio-mini cannot save its account log: a folder is where it writes
    // the log first.
    let blocked = mini.home.path().join("account.tmp");
    std::fs::create_dir_all(blocked.join("in-the-way")).unwrap();

    let refused = book
        .try_call("session.bring", json!({ "session": made["id"] }))
        .await
        .unwrap_err();
    assert!(refused.starts_with("internal"), "{refused}");
    // It still runs on studio-mini, on its own branch.
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    let kept = own.iter().find(|s| s["id"] == made["id"]).expect("still studio-mini's");
    let on = std::process::Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(kept["path"].as_str().unwrap())
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&on.stdout).trim(), made["branch"].as_str().unwrap());
    std::fs::remove_dir_all(&blocked).unwrap();
}

#[tokio::test]
async fn a_member_without_a_copy_of_the_session_leaves_it_on_the_central_host() {
    let origin = Origin::new();
    let (mini, book, made) = continued_and_back(&origin).await;
    let copies: Vec<Value> = book.call("sync.list", json!({})).await;
    let copy = copies.iter().find(|c| c["session"] == made["id"]).unwrap()["id"].clone();
    let _: Value = book.call("sync.stop", json!({ "copy": copy })).await;

    let refused = book
        .try_call("session.bring", json!({ "session": made["id"] }))
        .await
        .unwrap_err();
    assert!(refused.starts_with("no_copy"), "{refused}");
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(own.iter().any(|s| s["id"] == made["id"]), "still studio-mini's");
}

#[tokio::test]
async fn a_bring_that_cannot_take_the_session_in_keeps_its_copy() {
    let origin = Origin::new();
    let (_mini, book, made) = continued_and_back(&origin).await;
    let copies: Vec<Value> = book.call("sync.list", json!({})).await;
    let copy = copies.iter().find(|c| c["session"] == made["id"]).unwrap().clone();
    // The MacBook cannot save its sessions: a folder is where it writes
    // them first.
    let blocked = book.home.path().join("state.json.tmp");
    std::fs::create_dir_all(blocked.join("in-the-way")).unwrap();

    let refused = book
        .try_call("session.bring", json!({ "session": made["id"] }))
        .await
        .unwrap_err();
    assert!(refused.starts_with("failed"), "{refused}");
    // Its copy is still kept, in the same folder.
    let copies: Vec<Value> = book.call("sync.list", json!({})).await;
    let kept = copies.iter().find(|c| c["id"] == copy["id"]).expect("the copy is kept");
    assert_eq!(kept["path"], copy["path"]);
    std::fs::remove_dir_all(&blocked).unwrap();
}

#[tokio::test]
async fn a_bring_whose_mac_fails_after_the_hand_over_leaves_the_session_running_on_the_central_host() {
    let origin = Origin::new();
    let (mini, book, made) = continued_and_back(&origin).await;
    // The MacBook cannot save its sessions, so it fails to take the
    // session in once studio-mini has already given it up.
    let blocked = book.home.path().join("state.json.tmp");
    std::fs::create_dir_all(blocked.join("in-the-way")).unwrap();

    let refused = book
        .try_call("session.bring", json!({ "session": made["id"] }))
        .await
        .unwrap_err();
    assert!(refused.starts_with("failed"), "{refused}");
    std::fs::remove_dir_all(&blocked).unwrap();

    // studio-mini runs it again, on its own branch.
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    let back = own
        .iter()
        .find(|s| s["id"] == made["id"])
        .unwrap_or_else(|| panic!("studio-mini's again: {own:?}"));
    assert_eq!(back["branch"], json!("moonlet/fix-cart"));
    let on = std::process::Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(back["path"].as_str().unwrap())
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&on.stdout).trim(), "moonlet/fix-cart");
    // Its chat is not paused: a message reaches the agent there.
    let chat = back["terminals"][0].clone();
    let _: Value = mini
        .call("chat.send", json!({ "id": chat, "text": "Still on studio-mini" }))
        .await;
    within(
        Duration::from_secs(30),
        "the message on studio-mini",
        || async { agent_log(&mini, "claude-user").contains("Still on studio-mini") },
    )
    .await;
    // The account names studio-mini its owner, as the MacBook sees it.
    within(
        Duration::from_secs(10),
        "studio-mini's on the MacBook",
        || async {
            with_copies(&book)
                .await
                .iter()
                .any(|s| s["id"] == made["id"] && s["owner"]["worker"] == json!(MINI))
        },
    )
    .await;
}

#[tokio::test]
async fn a_transcript_that_cannot_be_fetched_leaves_the_members_as_it_is() {
    let origin = Origin::new();
    let (mini, book, made) = continued_and_back(&origin).await;
    // studio-mini's transcript is a link, which it never reads through.
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    let there = own.iter().find(|s| s["id"] == made["id"]).unwrap()["path"].clone();
    let theirs = project_folder(&mini, Path::new(there.as_str().unwrap())).join(format!("{CONVERSATION}.jsonl"));
    let aside = theirs.with_extension("aside");
    std::fs::rename(&theirs, &aside).unwrap();
    std::os::unix::fs::symlink(&aside, &theirs).unwrap();
    // The MacBook already has some of the conversation where it goes.
    let copies: Vec<Value> = book.call("sync.list", json!({})).await;
    let here = PathBuf::from(copies.iter().find(|c| c["session"] == made["id"]).unwrap()["path"].as_str().unwrap());
    within(Duration::from_secs(30), "the copy's folder", || async { here.join(".git").exists() }).await;
    let ours = project_folder(&book, &here);
    std::fs::create_dir_all(&ours).unwrap();
    std::fs::write(ours.join(format!("{CONVERSATION}.jsonl")), "{\"type\":\"user\"}\n").unwrap();

    let _: Value = book
        .call("session.bring", json!({ "session": made["id"] }))
        .await;
    assert_eq!(
        std::fs::read_to_string(ours.join(format!("{CONVERSATION}.jsonl"))).unwrap(),
        "{\"type\":\"user\"}\n"
    );
}

#[tokio::test]
async fn a_brought_back_transcript_is_never_written_through_a_link_on_the_member() {
    let origin = Origin::new();
    let (_mini, book, made) = continued_and_back(&origin).await;
    // Something on the MacBook put a link where the conversation's folder goes.
    let copies: Vec<Value> = book.call("sync.list", json!({})).await;
    let here = PathBuf::from(copies.iter().find(|c| c["session"] == made["id"]).unwrap()["path"].as_str().unwrap());
    within(Duration::from_secs(30), "the copy's folder", || async { here.join(".git").exists() }).await;
    let ours = project_folder(&book, &here);
    std::fs::create_dir_all(&ours).unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(elsewhere.path(), ours.join(CONVERSATION)).unwrap();

    let _: Value = book
        .call("session.bring", json!({ "session": made["id"] }))
        .await;
    assert!(!elsewhere.path().join("tool-results/toolu_01.txt").exists());
    // The resumed agent may make its own empty folders there as it starts;
    // the daemon writes files, and none may go through the link.
    let mut files = Vec::new();
    let mut folders = vec![elsewhere.path().to_path_buf()];
    while let Some(dir) = folders.pop() {
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = e.path();
            if path.is_dir() {
                folders.push(path);
            } else {
                files.push(path);
            }
        }
    }
    assert_eq!(files, Vec::<PathBuf>::new(), "nothing written through the link");
}

#[tokio::test]
async fn a_member_going_to_sleep_hands_its_running_session_to_the_central_host() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents_as(&origin, false).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let agent = made["terminals"][0].clone();
    copy_of(&mini, &made).await;
    let _: Value = book
        .call("chat.send", json!({ "id": agent, "text": "HOLD on" }))
        .await;
    within(
        Duration::from_secs(30),
        "the running turn on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| i["chats"][0]["state"]["status"] == json!("working"))
        },
    )
    .await;

    // The lid closes.
    let _: Value = book
        .call("power.simulate", json!({ "event": "sleep" }))
        .await;
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(
        own.iter().any(|s| s["id"] == made["id"]),
        "studio-mini runs it now"
    );
    within(Duration::from_secs(30), "the note on studio-mini", || async {
        agent_log(&mini, "claude-user").contains(
            "This session moved from MacBook to studio-mini because MacBook went to sleep, and your last turn was cut off.",
        )
    })
    .await;
    // The MacBook lets go of it and keeps a live copy instead.
    within(
        Duration::from_secs(30),
        "the MacBook following it",
        || async {
            let own: Vec<Value> = book.call("session.list", json!({})).await;
            let copies: Vec<Value> = book.call("sync.list", json!({})).await;
            own.iter().all(|s| s["id"] != made["id"])
                && copies.iter().any(|c| c["session"] == made["id"])
        },
    )
    .await;
    let _: Value = book
        .call("power.simulate", json!({ "event": "wake" }))
        .await;
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    assert!(own.iter().all(|s| s["id"] != made["id"]));
}

#[tokio::test]
async fn a_session_whose_last_copy_cannot_be_sent_stays_on_the_mac_at_sleep() {
    use std::os::unix::fs::PermissionsExt;
    let origin = Origin::new();
    let (mini, book) = pair_with_agents_as(&origin, false).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    copy_of(&mini, &made).await;
    // A file git cannot read: the session's last copy cannot be made.
    let locked = path_of(&made).join("locked.txt");
    std::fs::write(&locked, "new work").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

    let _: Value = book
        .call("power.simulate", json!({ "event": "sleep" }))
        .await;
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
    let theirs: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(
        theirs.iter().all(|s| s["id"] != made["id"]),
        "studio-mini does not continue from an older copy"
    );
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    assert!(own.iter().any(|s| s["id"] == made["id"]), "the MacBook keeps it");
}

#[tokio::test]
async fn a_session_not_handed_over_before_sleep_goes_on_here_after_waking() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents_as(&origin, false).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let agent = made["terminals"][0].clone();
    // studio-mini is gone: nothing to hand the session to.
    drop(mini);

    let _: Value = book
        .call("power.simulate", json!({ "event": "sleep" }))
        .await;
    let _: Value = book
        .call("power.simulate", json!({ "event": "wake" }))
        .await;
    let _: Value = book
        .call("chat.send", json!({ "id": agent, "text": "Again" }))
        .await;
    within(Duration::from_secs(30), "a turn after waking", || async {
        let st: Value = book.call("chat.state", json!({ "id": agent })).await;
        st["status"] == json!("done") && agent_log(&book, "claude-user").contains("Again")
    })
    .await;
}

// --- Move to…, pins and Take over anyway (X73) ---------------------------

#[allow(dead_code)]
fn owner_of_copy<'a>(copies: &'a [Value], session: &Value) -> Option<&'a Value> {
    copies
        .iter()
        .find(|s| s["id"] == session["id"])
        .map(|s| &s["owner"])
}

#[tokio::test]
async fn a_session_moved_to_the_central_host_stays_there() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents_as(&origin, false).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    copy_of(&mini, &made).await;
    within(
        Duration::from_secs(30),
        "the checkpoint on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| !i["checkpoint"].is_null())
        },
    )
    .await;

    let _: Value = book
        .call("session.move", json!({ "session": made["id"], "to": MINI }))
        .await;
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(own.iter().any(|s| s["id"] == made["id"]));
    // Pinned there: typing on the MacBook does not bring it back.
    within(
        Duration::from_secs(30),
        "a live copy on the MacBook",
        || async {
            let copies: Vec<Value> = book.call("sync.list", json!({})).await;
            copies
                .iter()
                .any(|c| c["session"] == made["id"] && !c["path"].as_str().unwrap_or("").is_empty())
        },
    )
    .await;
    let refused = book
        .try_call("session.bring", json!({ "session": made["id"] }))
        .await
        .unwrap_err();
    assert!(refused.starts_with("pinned"), "{refused}");
}

#[tokio::test]
async fn a_session_moved_to_this_mac_stays_through_sleep_until_unpinned() {
    let origin = Origin::new();
    let (mini, book, made) = continued_and_back(&origin).await;
    let _: Value = book
        .call("session.move", json!({ "session": made["id"], "to": BOOK }))
        .await;
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    assert!(own.iter().any(|s| s["id"] == made["id"]));
    // Listed as kept here, once the central host's pin arrives.
    within(Duration::from_secs(30), "kept on the MacBook", || async {
        let own: Vec<Value> = book.call("session.list", json!({})).await;
        own.iter()
            .any(|s| s["id"] == made["id"] && s["pinned"] == json!(BOOK))
    })
    .await;

    // Pinned here: going to sleep keeps it.
    let _: Value = book
        .call("power.simulate", json!({ "event": "sleep" }))
        .await;
    let mini_own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(mini_own.iter().all(|s| s["id"] != made["id"]));
    let _: Value = book
        .call("power.simulate", json!({ "event": "wake" }))
        .await;

    // Unpinned, the next sleep hands it over.
    let _: Value = book
        .call("session.unpin", json!({ "session": made["id"] }))
        .await;
    // The central host's unpin reaches the MacBook with its next news.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let _: Value = book
        .call("power.simulate", json!({ "event": "sleep" }))
        .await;
    let mini_own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(mini_own.iter().any(|s| s["id"] == made["id"]));
}

#[tokio::test]
async fn a_session_whose_last_copy_cannot_be_sent_is_not_moved_to_the_central_host() {
    use std::os::unix::fs::PermissionsExt;
    let origin = Origin::new();
    let (mini, book) = pair_with_agents_as(&origin, false).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    copy_of(&mini, &made).await;
    // A file git cannot read: the session's last copy cannot be made.
    let locked = path_of(&made).join("locked.txt");
    std::fs::write(&locked, "new work").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

    let moved = book
        .try_call("session.move", json!({ "session": made["id"], "to": MINI }))
        .await;
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
    let refused = moved.unwrap_err();
    assert!(refused.starts_with("unsent"), "{refused}");
    let theirs: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(
        theirs.iter().all(|s| s["id"] != made["id"]),
        "studio-mini does not continue from an older copy"
    );
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    assert!(own.iter().any(|s| s["id"] == made["id"]), "the MacBook keeps it");
}

#[tokio::test]
async fn a_session_kept_on_this_mac_moves_to_the_central_host_when_asked() {
    let origin = Origin::new();
    let (mini, book, made) = continued_and_back(&origin).await;
    let _: Value = book
        .call("session.move", json!({ "session": made["id"], "to": BOOK }))
        .await;

    let _: Value = book
        .call("session.move", json!({ "session": made["id"], "to": MINI }))
        .await;
    let mini_own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(
        mini_own.iter().any(|s| s["id"] == made["id"]),
        "studio-mini runs it now"
    );
}

/// The state letters `ps` gives each agent process `d` runs ([`TOOL_CLAUDE`]).
fn agent_processes(d: &Daemon) -> Vec<(String, String)> {
    let script = claude_home(d).parent().unwrap().join("bin").join("claude");
    let out = std::process::Command::new("ps")
        .args(["-axo", "pid=,stat=,command="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains(&*script.to_string_lossy()))
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            Some((f.next()?.to_string(), f.next()?.to_string()))
        })
        .collect()
}

#[tokio::test]
async fn moving_a_running_session_now_stops_its_agent_on_this_mac() {
    let origin = Origin::new();
    let (mini, mut book) = pair_with_agents_as(&origin, false).await;
    // The MacBook hears no account news as it happens, so it does not
    // let go of the session at once: what its agent does then shows.
    book.env.push((
        "MOONLET_TEST_IGNORE_ACCOUNT_EVENTS".to_string(),
        "1".to_string(),
    ));
    book.restart().await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let agent = made["terminals"][0].clone();
    copy_of(&mini, &made).await;
    let _: Value = book
        .call("chat.send", json!({ "id": agent, "text": "HOLD on" }))
        .await;
    within(
        Duration::from_secs(30),
        "the running turn on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| i["chats"][0]["state"]["status"] == json!("working"))
        },
    )
    .await;

    let _: Value = book
        .call(
            "session.move",
            json!({ "session": made["id"], "to": MINI, "now": true }),
        )
        .await;
    let theirs: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(theirs.iter().any(|s| s["id"] == made["id"]), "studio-mini runs it now");
    let agents = agent_processes(&book);
    for (pid, _) in &agents {
        let _ = std::process::Command::new("kill").args(["-KILL", pid]).status();
    }
    assert!(!agents.is_empty());
    assert!(
        agents.iter().all(|(_, stat)| stat.starts_with('T')),
        "the MacBook's agent goes on: {agents:?}"
    );
}

#[tokio::test]
async fn a_session_kept_on_the_central_host_is_unpinned_from_the_mac() {
    let origin = Origin::new();
    let (_mini, book, made) = continued_and_back(&origin).await;
    let _: Value = book
        .call("session.move", json!({ "session": made["id"], "to": BOOK }))
        .await;
    let _: Value = book
        .call("session.move", json!({ "session": made["id"], "to": MINI }))
        .await;
    within(
        Duration::from_secs(30),
        "the MacBook to hear studio-mini runs it",
        || async {
            let copies = with_copies(&book).await;
            owner_of_copy(&copies, &made).is_some_and(|o| o["worker"] == json!(MINI))
        },
    )
    .await;
    // Choosing where it runs already keeps it there.
    let kept: Value = book
        .call("session.move", json!({ "session": made["id"], "to": MINI }))
        .await;
    assert_eq!(kept["id"], made["id"]);

    let _: Value = book
        .call("session.unpin", json!({ "session": made["id"] }))
        .await;
    // Unpinned, it follows the user again: the MacBook brings it back.
    within(Duration::from_secs(30), "the session brought back", || async {
        book.try_call("session.bring", json!({ "session": made["id"] }))
            .await
            .is_ok()
    })
    .await;
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    assert!(own.iter().any(|s| s["id"] == made["id"]));
}

#[tokio::test]
async fn a_session_kept_on_the_central_host_moves_back_to_the_mac_when_asked() {
    let origin = Origin::new();
    let (_mini, book, made) = continued_and_back(&origin).await;
    let _: Value = book
        .call("session.move", json!({ "session": made["id"], "to": MINI }))
        .await;
    within(
        Duration::from_secs(30),
        "the MacBook to hear studio-mini keeps it",
        || async {
            let copies = with_copies(&book).await;
            owner_of_copy(&copies, &made).is_some_and(|o| o["worker"] == json!(MINI))
        },
    )
    .await;
    within(
        Duration::from_secs(30),
        "a live copy on the MacBook",
        || async {
            let copies: Vec<Value> = book.call("sync.list", json!({})).await;
            copies
                .iter()
                .any(|c| c["session"] == made["id"] && !c["path"].as_str().unwrap_or("").is_empty())
        },
    )
    .await;

    // Move to… another member changes where it is kept.
    let moved: Value = book
        .call("session.move", json!({ "session": made["id"], "to": BOOK }))
        .await;
    assert_eq!(moved["id"], made["id"]);
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    assert!(own.iter().any(|s| s["id"] == made["id"]));
}

#[tokio::test]
async fn a_session_taken_over_while_the_central_host_was_offline_is_kept_when_it_is_back() {
    let origin = Origin::new();
    let (mut mini, book, made) = continued_and_back(&origin).await;
    mini.stop();
    within(Duration::from_secs(30), "studio-mini offline", || async {
        let link: Value = book.call("link.get", json!({})).await;
        link["unreachable_since"].is_u64()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(1200)).await;

    let taken: Value = book
        .call("session.take_anyway", json!({ "session": made["id"] }))
        .await;
    assert_eq!(taken["id"], made["id"]);
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    assert!(own.iter().any(|s| s["id"] == made["id"]));

    mini.restart().await;
    // studio-mini keeps the takeover: the MacBook owns it, studio-mini
    // keeps a copy of it.
    within(
        Duration::from_secs(30),
        "the takeover kept on studio-mini",
        || async {
            let mini_own: Vec<Value> = mini.call("session.list", json!({})).await;
            let copies = with_copies(&mini).await;
            mini_own.iter().all(|s| s["id"] != made["id"])
                && owner_of_copy(&copies, &made).is_some_and(|o| o["worker"] == json!(BOOK))
        },
    )
    .await;
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    assert!(own.iter().any(|s| s["id"] == made["id"]));
}

#[tokio::test]
async fn a_takeover_that_cannot_take_the_session_in_keeps_its_copy_and_is_never_sent() {
    let origin = Origin::new();
    let (mut mini, book, made) = continued_and_back(&origin).await;
    let copies: Vec<Value> = book.call("sync.list", json!({})).await;
    let copy = copies.iter().find(|c| c["session"] == made["id"]).unwrap().clone();
    mini.stop();
    within(Duration::from_secs(30), "studio-mini offline", || async {
        let link: Value = book.call("link.get", json!({})).await;
        link["unreachable_since"].is_u64()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    // The MacBook cannot save its sessions: a folder is where it writes
    // them first.
    let blocked = book.home.path().join("state.json.tmp");
    std::fs::create_dir_all(blocked.join("in-the-way")).unwrap();

    let refused = book
        .try_call("session.take_anyway", json!({ "session": made["id"] }))
        .await
        .unwrap_err();
    assert!(refused.starts_with("failed"), "{refused}");
    // Its copy is still kept, in the same folder.
    let copies: Vec<Value> = book.call("sync.list", json!({})).await;
    let kept = copies.iter().find(|c| c["id"] == copy["id"]).expect("the copy is kept");
    assert_eq!(kept["path"], copy["path"]);
    std::fs::remove_dir_all(&blocked).unwrap();

    // Back, studio-mini still runs it: no takeover was sent.
    mini.restart().await;
    within(Duration::from_secs(30), "the copy in sync again", || async {
        let copies: Vec<Value> = book.call("sync.list", json!({})).await;
        copies
            .iter()
            .any(|c| c["id"] == copy["id"] && c["state"]["kind"] == json!("in_sync"))
    })
    .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mini_own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(mini_own.iter().any(|s| s["id"] == made["id"]), "{mini_own:?}");
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    assert!(own.iter().all(|s| s["id"] != made["id"]), "{own:?}");
}

#[tokio::test]
async fn a_kept_takeover_stays_on_the_mac_before_the_account_names_it_the_owner() {
    let origin = Origin::new();
    let (mut mini, mut book, made) = continued_and_back(&origin).await;
    mini.stop();
    within(Duration::from_secs(30), "studio-mini offline", || async {
        let link: Value = book.call("link.get", json!({})).await;
        link["unreachable_since"].is_u64()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let _: Value = book
        .call("session.take_anyway", json!({ "session": made["id"] }))
        .await;
    // From now on the MacBook hears no account news as it happens: it
    // learns that it owns the session only at its next exchange.
    book.env.push((
        "MOONLET_TEST_IGNORE_ACCOUNT_EVENTS".to_string(),
        "1".to_string(),
    ));
    book.restart().await;

    mini.restart().await;
    within(
        Duration::from_secs(30),
        "the takeover kept on studio-mini",
        || async {
            let copies = with_copies(&mini).await;
            owner_of_copy(&copies, &made).is_some_and(|o| o["worker"] == json!(BOOK))
        },
    )
    .await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    let kept = own
        .iter()
        .find(|s| s["id"] == made["id"])
        .expect("the MacBook goes on running it");
    assert!(path_of(kept).is_dir());
}

#[tokio::test]
async fn a_session_kept_on_the_central_host_can_be_taken_over_anyway_and_is_kept_here_then() {
    let origin = Origin::new();
    let (mut mini, book, made) = continued_and_back(&origin).await;
    // Kept on studio-mini, where it runs.
    let _: Value = book
        .call("session.move", json!({ "session": made["id"], "to": MINI }))
        .await;
    mini.stop();
    within(Duration::from_secs(30), "studio-mini offline", || async {
        let link: Value = book.call("link.get", json!({})).await;
        link["unreachable_since"].is_u64()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let _: Value = book
        .call("session.take_anyway", json!({ "session": made["id"] }))
        .await;

    mini.restart().await;
    within(
        Duration::from_secs(30),
        "the takeover kept on studio-mini",
        || async {
            let copies = with_copies(&mini).await;
            owner_of_copy(&copies, &made).is_some_and(|o| o["worker"] == json!(BOOK))
        },
    )
    .await;
    within(
        Duration::from_secs(30),
        "the MacBook to hear it runs it",
        || async {
            let copies = with_copies(&book).await;
            copies
                .iter()
                .filter(|s| s["id"] == made["id"])
                .all(|s| s["owner"].is_null())
        },
    )
    .await;
    // Kept on the MacBook now: going to sleep keeps it.
    let _: Value = book
        .call("power.simulate", json!({ "event": "sleep" }))
        .await;
    let mini_own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(mini_own.iter().all(|s| s["id"] != made["id"]));
}

const AIR: &str = "9e2b4d6f-1a3c-4e5f-8b7d-0c2e4a6b8d1f";

/// The replies a [`HandLink`] waits for, by request id.
type Waiting = std::sync::Arc<
    std::sync::Mutex<std::collections::HashMap<u64, tokio::sync::oneshot::Sender<Result<Value, String>>>>,
>;

/// A member's link to the central host made by hand, as another Mac's
/// daemon would make it: it answers the central host's pings, so it stays
/// linked, and asks what a test sends.
struct HandLink {
    out: tokio::sync::mpsc::UnboundedSender<moonlet_proto::Frame>,
    waiting: Waiting,
    next: std::sync::atomic::AtomicU64,
}

impl HandLink {
    /// Pairs as the Mac `name` with the central host `mini` and links as
    /// worker `id`.
    async fn to(mini: &Daemon, id: &str, name: &str) -> HandLink {
        use moonlet_proto::{Frame, Message, read_frame, write_frame};
        let status: Value = mini.call("mobile.status", json!({})).await;
        let addr = status["listening"][0].as_str().unwrap().to_string();
        let p: MobilePairing = mini
            .call("mobile.pair_start", json!({ "kind": "desktop" }))
            .await;
        let token = moonlet_link::tailnet::pair(&[addr.clone()], &p.code, name, DeviceKind::Desktop)
            .await
            .unwrap()
            .token;
        let (mut rd, mut wr) = raw(&addr, &token, "moonletd-worker").await.into_split();
        let (out, mut outgoing) = tokio::sync::mpsc::unbounded_channel::<Frame>();
        tokio::spawn(async move {
            while let Some(f) = outgoing.recv().await {
                if write_frame(&mut wr, &f).await.is_err() {
                    return;
                }
            }
        });
        let waiting: Waiting = Default::default();
        let (pongs, replies) = (out.clone(), waiting.clone());
        tokio::spawn(async move {
            loop {
                match read_frame(&mut rd).await {
                    Ok(Some(Frame::Json(Message::Request { id, .. }))) => {
                        let _ = pongs.send(Frame::Json(Message::ok(id, json!({}))));
                    }
                    Ok(Some(Frame::Json(Message::Response { id, result, error }))) => {
                        if let Some(reply) = replies.lock().unwrap().remove(&id) {
                            let _ = reply.send(match error {
                                Some(e) => Err(format!("{}: {}", e.code, e.message)),
                                None => Ok(result.unwrap_or(Value::Null)),
                            });
                        }
                    }
                    Ok(Some(_)) => {}
                    _ => return,
                }
            }
        });
        let link = HandLink { out, waiting, next: 1.into() };
        link.ask("worker.register", registration(id, name)).await.unwrap();
        link
    }

    async fn ask(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.waiting.lock().unwrap().insert(id, tx);
        let req = moonlet_proto::Message::Request { id, method: method.to_string(), params };
        self.out.send(moonlet_proto::Frame::Json(req)).unwrap();
        tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .expect("no reply")
            .unwrap_or_else(|_| Err("the link closed".to_string()))
    }
}

#[tokio::test]
async fn a_takeover_from_a_member_that_never_lost_the_central_host_is_not_forced() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents_as(&origin, false).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    copy_of(&mini, &made).await;
    within(
        Duration::from_secs(30),
        "the checkpoint on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| !i["checkpoint"].is_null())
        },
    )
    .await;
    // The MacBook Air is linked before the session reaches studio-mini, and
    // stays linked.
    let air = HandLink::to(&mini, AIR, "MacBook Air").await;
    let _: Value = book
        .call("session.move", json!({ "session": made["id"], "to": MINI }))
        .await;

    // Made at ownership number 1, moved once: 2. Kept on studio-mini, it
    // is not taken, whatever the Air says.
    let take = json!({ "session": made["id"], "epoch": 2, "now": false, "forced": true });
    let refused = air.ask("session.take", take.clone()).await.unwrap_err();
    assert!(refused.starts_with("pinned"), "{refused}");

    // Unpinned, with a turn running there, it waits for the turn.
    let _: Value = book
        .call("session.unpin", json!({ "session": made["id"] }))
        .await;
    let own: Vec<Value> = mini.call("session.list", json!({})).await;
    let chat = own.iter().find(|s| s["id"] == made["id"]).unwrap()["terminals"][0].clone();
    let _: Value = mini
        .call("chat.send", json!({ "id": chat, "text": "HOLD there" }))
        .await;
    within(
        Duration::from_secs(30),
        "a turn running on studio-mini",
        || async {
            let st: Value = mini.call("chat.state", json!({ "id": chat })).await;
            st["status"] == json!("working")
        },
    )
    .await;
    let busy = air.ask("session.take", take).await.unwrap_err();
    assert!(busy.starts_with("busy"), "{busy}");
    let mini_own: Vec<Value> = mini.call("session.list", json!({})).await;
    assert!(mini_own.iter().any(|s| s["id"] == made["id"]), "studio-mini still runs it");
}

#[tokio::test]
async fn a_wake_cut_short_by_another_sleep_leaves_the_agents_stopped() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents_as(&origin, false).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let agent = made["terminals"][0].clone();
    // studio-mini is gone, so a wake waits a while for it.
    drop(mini);
    within(Duration::from_secs(60), "the MacBook missing studio-mini", || async {
        let info: Value = book.call("link.get", json!({})).await;
        info["state"]["kind"] != json!("connected")
    })
    .await;
    let _: Value = book
        .call("power.simulate", json!({ "event": "sleep" }))
        .await;

    // The lid opens, and closes again before the wake is done.
    let (_, _): (Value, Value) = tokio::join!(
        book.call("power.simulate", json!({ "event": "wake" })),
        async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            book.call("power.simulate", json!({ "event": "sleep" }))
                .await
        },
    );
    let _: Value = book
        .call("chat.send", json!({ "id": agent, "text": "Again" }))
        .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(
        !agent_log(&book, "claude-user").contains("Again"),
        "the agent stays stopped while the MacBook sleeps"
    );
    let _: Value = book
        .call("power.simulate", json!({ "event": "wake" }))
        .await;
    within(Duration::from_secs(30), "a turn after the last wake", || async {
        agent_log(&book, "claude-user").contains("Again")
    })
    .await;
}

#[tokio::test]
async fn an_agent_started_while_the_mac_sleeps_waits_for_the_wake() {
    let origin = Origin::new();
    let (mini, mut book) = pair_with_agents_as(&origin, false).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let agent = made["terminals"][0].clone();
    drop(mini);
    // After a restart the chat runs no agent until its next message.
    book.restart().await;

    let _: Value = book
        .call("power.simulate", json!({ "event": "sleep" }))
        .await;
    let _: Value = book
        .call("chat.send", json!({ "id": agent, "text": "Again" }))
        .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(
        !agent_log(&book, "claude-user").contains("Again"),
        "the agent waits while the MacBook sleeps"
    );
    let _: Value = book
        .call("power.simulate", json!({ "event": "wake" }))
        .await;
    within(Duration::from_secs(30), "a turn after waking", || async {
        agent_log(&book, "claude-user").contains("Again")
    })
    .await;
}

#[tokio::test]
async fn the_central_host_says_whether_it_could_continue_each_copy() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents_as(&origin, false).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    // A session with no conversation yet, and one after a turn.
    let quiet = new_session(&book, &project, "quiet").await;
    let talked = session_with_a_turn(&book, &project).await;
    copy_of(&mini, &quiet).await;
    copy_of(&mini, &talked).await;

    let ready = within_value(
        Duration::from_secs(30),
        "both copies ready or not",
        || async {
            let all: Vec<Value> = mini.call("session.ready", json!({})).await;
            let of = |s: &Value| all.iter().find(|r| r["session"] == s["id"]).cloned();
            match (of(&quiet), of(&talked)) {
                (Some(q), Some(t)) if t["ready"] == json!(true) => Some((q, t)),
                _ => None,
            }
        },
    )
    .await;
    assert_eq!(
        ready.0,
        json!({ "session": quiet["id"], "ready": false, "reason": "its conversation has not reached here yet" })
    );
    assert_eq!(ready.1, json!({ "session": talked["id"], "ready": true }));
}

#[tokio::test]
async fn a_closed_chats_conversation_does_not_make_a_new_chat_ready() {
    let origin = Origin::new();
    let (mini, book) = pair_with_agents_as(&origin, false).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    copy_of(&mini, &made).await;
    let ready_of = |all: Vec<Value>| all.into_iter().find(|r| r["session"] == made["id"]);
    within(Duration::from_secs(30), "the copy ready", || async {
        ready_of(mini.call("session.ready", json!({})).await)
            .is_some_and(|r| r["ready"] == json!(true))
    })
    .await;

    // The chat that talked closes, and a new one opens.
    let _: Value = book
        .call(
            "terminal.kill",
            json!({ "id": made["terminals"][0], "remove": true }),
        )
        .await;
    let fresh: Value = book
        .call(
            "terminal.create",
            json!({ "cwd": made["path"], "session_id": made["id"], "kind": "agent", "agent": "claude", "chat": true }),
        )
        .await;
    within(
        Duration::from_secs(30),
        "only the new chat on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| {
                    i["chats"]
                        .as_array()
                        .is_some_and(|c| c.len() == 1 && c[0]["terminal"] == fresh["id"])
                })
        },
    )
    .await;

    assert_eq!(
        ready_of(mini.call("session.ready", json!({})).await),
        Some(
            json!({ "session": made["id"], "ready": false, "reason": "its conversation has not reached here yet" })
        )
    );
}

#[tokio::test]
async fn a_member_lets_go_of_a_lost_session_once_its_worktree_is_free_again() {
    let origin = Origin::new();
    let (mini, mut book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    copy_of(&mini, &made).await;
    within(
        Duration::from_secs(30),
        "the checkpoint on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| !i["checkpoint"].is_null())
        },
    )
    .await;
    book.stop();
    // Another git holds the worktree's snapshot index as the MacBook comes
    // back, as a round of its own can.
    let git_dir = {
        let out = std::process::Command::new("git")
            .args(["rev-parse", "--absolute-git-dir"])
            .current_dir(path_of(&made))
            .output()
            .unwrap();
        PathBuf::from(String::from_utf8_lossy(&out.stdout).trim())
    };
    let lock = git_dir.join("moonlet-sync-index.lock");
    std::fs::write(&lock, "").unwrap();
    unreachable(&mini, &made).await;
    let _: Value = mini
        .call("session.continue_here", json!({ "session": made["id"] }))
        .await;
    book.restart().await;
    // For longer than the first few tries take.
    tokio::time::sleep(Duration::from_secs(45)).await;
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    assert!(
        own.iter().any(|s| s["id"] == made["id"]),
        "let go of before its gap was kept"
    );
    // Once the worktree is free, the MacBook lets go by itself.
    std::fs::remove_file(&lock).unwrap();
    within(
        Duration::from_secs(30),
        "fix-cart no longer the MacBook's own",
        || async {
            let own: Vec<Value> = book.call("session.list", json!({})).await;
            own.iter().all(|s| s["id"] != made["id"])
        },
    )
    .await;
}

/// Sets `dir` read-only (`0o555`), or writable again.
fn read_only(dir: &Path, yes: bool) {
    use std::os::unix::fs::PermissionsExt;
    let mode = if yes { 0o555 } else { 0o755 };
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// A member whose session was continued on studio-mini while it was away,
/// back again: `made` is the session, its record studio-mini's now.
async fn lost_while_away(mini: &Daemon, book: &mut Daemon, made: &Value, meanwhile: impl FnOnce()) {
    copy_of(mini, made).await;
    within(
        Duration::from_secs(30),
        "the checkpoint on studio-mini",
        || async {
            mini.try_call("session.copy", json!({ "session": made["id"] }))
                .await
                .is_ok_and(|i| !i["checkpoint"].is_null())
        },
    )
    .await;
    book.stop();
    meanwhile();
    unreachable(mini, made).await;
    let _: Value = mini
        .call("session.continue_here", json!({ "session": made["id"] }))
        .await;
    book.restart().await;
}

/// The files in `dir` whose names hold `part`.
fn named(dir: &Path, part: &str) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .map(|e| e.unwrap().path())
                .filter(|p| p.file_name().unwrap().to_string_lossy().contains(part))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn a_member_keeps_a_lost_session_until_its_conversation_is_forked() {
    let origin = Origin::new();
    let (mini, mut book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let folder = project_folder(&book, &path_of(&made));
    let transcript = std::fs::read_to_string(folder.join(format!("{CONVERSATION}.jsonl"))).unwrap();
    // Nothing can be written beside the transcript as the MacBook comes back.
    lost_while_away(&mini, &mut book, &made, || read_only(&folder, true)).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    read_only(&folder, false);
    assert!(
        own.iter().any(|s| s["id"] == made["id"]),
        "let go of before its conversation was forked"
    );
    within(
        Duration::from_secs(30),
        "fix-cart no longer the MacBook's own",
        || async {
            let own: Vec<Value> = book.call("session.list", json!({})).await;
            own.iter().all(|s| s["id"] != made["id"])
        },
    )
    .await;
    let forks = named(&folder, ".fork-");
    let jsonl: Vec<&PathBuf> = forks
        .iter()
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .collect();
    assert_eq!(jsonl.len(), 1, "{forks:?}");
    assert_eq!(std::fs::read_to_string(jsonl[0]).unwrap(), transcript);
    // The conversation's own files go with it, in a folder of the fork's name.
    let files = jsonl[0].with_extension("");
    assert_eq!(
        std::fs::read_to_string(files.join("tool-results/toolu_01.txt")).unwrap(),
        "full output\n"
    );
}

#[tokio::test]
async fn a_lost_session_that_cannot_be_let_go_of_yet_keeps_its_gap_once() {
    let origin = Origin::new();
    let (mini, mut book) = pair_with_agents(&origin).await;
    origin.add_to(&mini).await;
    let project = origin.add_to(&book).await;
    let made = session_with_a_turn(&book, &project).await;
    let worktree = path_of(&made);
    let parent = worktree.parent().unwrap().to_path_buf();
    let folder = project_folder(&book, &worktree);
    // Its worktree cannot move as the MacBook comes back.
    lost_while_away(&mini, &mut book, &made, || {
        std::fs::write(worktree.join("src/cart.ts"), "while away\n").unwrap();
        read_only(&parent, true);
    })
    .await;
    tokio::time::sleep(Duration::from_secs(8)).await;
    let own: Vec<Value> = book.call("session.list", json!({})).await;
    read_only(&parent, false);
    assert!(own.iter().any(|s| s["id"] == made["id"]));
    within(
        Duration::from_secs(30),
        "fix-cart no longer the MacBook's own",
        || async {
            let own: Vec<Value> = book.call("session.list", json!({})).await;
            own.iter().all(|s| s["id"] != made["id"])
        },
    )
    .await;
    let leftovers = book.home.path().join("sync-leftovers");
    let kept: Vec<PathBuf> = named(&leftovers, "")
        .into_iter()
        .filter(|p| !p.display().to_string().contains("-worktree-"))
        .collect();
    assert_eq!(kept.len(), 1, "{kept:?}");
    let forks = named(&folder, ".fork-");
    let jsonl: Vec<&PathBuf> = forks
        .iter()
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .collect();
    assert_eq!(jsonl.len(), 1, "{forks:?}");
}

#[tokio::test]
async fn a_takeover_the_central_host_could_not_take_yet_is_sent_again() {
    let origin = Origin::new();
    let (mut mini, book, made) = continued_and_back(&origin).await;
    let mini_own: Vec<Value> = mini.call("session.list", json!({})).await;
    let on_mini = path_of(mini_own.iter().find(|s| s["id"] == made["id"]).unwrap());
    mini.stop();
    within(Duration::from_secs(30), "studio-mini offline", || async {
        let link: Value = book.call("link.get", json!({})).await;
        link["unreachable_since"].is_u64()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let _: Value = book
        .call("session.take_anyway", json!({ "session": made["id"] }))
        .await;
    // studio-mini comes back while another git holds its worktree's
    // snapshot index, so it cannot keep its own work first yet.
    let git_dir = {
        let out = std::process::Command::new("git")
            .args(["rev-parse", "--absolute-git-dir"])
            .current_dir(&on_mini)
            .output()
            .unwrap();
        PathBuf::from(String::from_utf8_lossy(&out.stdout).trim())
    };
    let lock = git_dir.join("moonlet-sync-index.lock");
    std::fs::write(&lock, "").unwrap();
    mini.restart().await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    std::fs::remove_file(&lock).unwrap();
    // The MacBook sends it again, and studio-mini keeps it then.
    within(
        Duration::from_secs(30),
        "the takeover kept on studio-mini",
        || async {
            let mini_own: Vec<Value> = mini.call("session.list", json!({})).await;
            let copies = with_copies(&mini).await;
            mini_own.iter().all(|s| s["id"] != made["id"])
                && owner_of_copy(&copies, &made).is_some_and(|o| o["worker"] == json!(BOOK))
        },
    )
    .await;
}
