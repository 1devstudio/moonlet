//! X72: every session of a member is listed on the central host, with the
//! member that owns it. A central host listens on 127.0.0.1
//! (`MOONLET_MOBILE_ADDRS`) instead of a Tailscale address, and a Mac pairs
//! with it and links, as the desktop app makes it do.

mod common;

use std::time::Duration;

use common::*;
use moonlet_proto::methods::{DeviceKind, MobilePairing};
use serde_json::{Value, json};

const BOOK: &str = "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37";

/// The central host `studio-mini`, with tailnet access on.
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
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("link.json"),
        json!({ "central": null, "worker": { "id": id, "name": name, "enabled": false } })
            .to_string(),
    )
    .unwrap();
    Daemon::start(home, &[("MOONLET_MOBILE_ADDRS", "127.0.0.2")]).await
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
