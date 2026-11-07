//! X89: every member of an account runs heavy commands for the others. Its
//! worker settings, the switch and the slots, are kept in the account, so
//! any member's app changes any member's. The central host `studio-mini`
//! listens on 127.0.0.1 (`MOONLET_MOBILE_ADDRS`) instead of a Tailscale
//! address, and two Macs pair with it and link, as the app makes them do.

mod common;

use std::time::Duration;

use common::*;
use moonlet_core::client::Client;
use moonlet_proto::methods::{DeviceKind, MobilePairing};
use serde_json::{Value, json};

const BOOK: &str = "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37";
const AIR: &str = "0b9e4f61-2a7c-4d3e-8f15-6c2a9d0e7b48";

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
        std::fs::write(
            home.path().join("link.json"),
            r#"{ "central": null, "worker": { "id": "0f6c2a9e-9d2b-4f5e-8f1a-2b3c4d5e6f70", "name": "studio-mini", "enabled": false } }"#,
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

const MINI: &str = "0f6c2a9e-9d2b-4f5e-8f1a-2b3c4d5e6f70";

/// A Mac with a fixed worker id and `worker` settings in its `link.json`,
/// not linked yet. Its own "Tailscale address" is 127.0.0.2, so linking to
/// 127.0.0.1 is not linking to itself.
async fn mac_with(id: &str, name: &str, worker: Value) -> Daemon {
    let home = tempfile::tempdir().unwrap();
    let mut w = json!({ "id": id, "name": name, "enabled": false });
    for (k, v) in worker.as_object().unwrap() {
        w[k] = v.clone();
    }
    std::fs::write(
        home.path().join("link.json"),
        json!({ "central": null, "worker": w }).to_string(),
    )
    .unwrap();
    Daemon::start(home, &[("MOONLET_MOBILE_ADDRS", "127.0.0.2")]).await
}

async fn mac(id: &str, name: &str) -> Daemon {
    mac_with(id, name, json!({})).await
}

/// Makes `central` the Mac's central host, as **Make central host** does.
async fn link(mac: &Daemon, central: &Daemon, addr: &str, name: &str) {
    let p: MobilePairing = central
        .call("mobile.pair_start", json!({ "kind": "desktop" }))
        .await;
    let token =
        moonlet_link::tailnet::pair(&[addr.to_string()], &p.code, name, DeviceKind::Desktop)
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

/// `worker.settings` on `d`: each member's `[worker, name, heavy, slots]`,
/// sorted by name.
async fn settings(d: &Daemon) -> Vec<(String, String, bool, u64)> {
    let list: Vec<Value> = d.call("worker.settings", json!({})).await;
    let mut out: Vec<_> = list
        .iter()
        .map(|e| {
            (
                e["worker"].as_str().unwrap().to_string(),
                e["name"].as_str().unwrap().to_string(),
                e["heavy"].as_bool().unwrap(),
                e["slots"].as_u64().unwrap(),
            )
        })
        .collect();
    out.sort_by(|a, b| a.1.cmp(&b.1));
    out
}

fn row(id: &str, name: &str, heavy: bool, slots: u64) -> (String, String, bool, u64) {
    (id.into(), name.into(), heavy, slots)
}

/// Three members that know each other: the central host and two Macs.
async fn account() -> (Daemon, String, Daemon, Daemon) {
    let (mini, addr) = central().await;
    let book = mac(BOOK, "Alex's MacBook Pro").await;
    let air = mac(AIR, "Alex's MacBook Air").await;
    link(&book, &mini, &addr, "Alex's MacBook Pro").await;
    link(&air, &mini, &addr, "Alex's MacBook Air").await;
    for d in [&mini, &book, &air] {
        within(Duration::from_secs(10), "every member known", || async {
            settings(d).await.len() == 3
        })
        .await;
    }
    (mini, addr, book, air)
}

/// `link.get`'s `worker` on `d`: whether it takes heavy commands, and its
/// slots.
async fn own(d: &Daemon) -> (bool, u64) {
    let info: Value = d.call("link.get", json!({})).await;
    (
        info["worker"]["enabled"].as_bool().unwrap(),
        info["worker"]["slots"].as_u64().unwrap(),
    )
}

#[tokio::test]
async fn a_new_member_takes_no_other_hosts_commands_and_has_two_slots() {
    let (mini, _addr, book, _air) = account().await;
    let expected = vec![
        row(AIR, "Alex's MacBook Air", false, 2),
        row(BOOK, "Alex's MacBook Pro", false, 2),
        row(MINI, "studio-mini", false, 2),
    ];
    assert_eq!(settings(&book).await, expected);
    assert_eq!(settings(&mini).await, expected);
}

#[tokio::test]
async fn worker_settings_set_on_one_member_reach_the_host_they_name() {
    let (mini, _addr, book, air) = account().await;
    // From the MacBook's app, for the Air and for the central host.
    let _: bool = book
        .call(
            "worker.settings.set",
            json!({ "worker": AIR, "heavy": true, "slots": 4 }),
        )
        .await;
    let _: bool = book
        .call(
            "worker.settings.set",
            json!({ "worker": MINI, "heavy": true }),
        )
        .await;
    within(
        Duration::from_secs(3),
        "the Air takes the settings",
        || async { own(&air).await == (true, 4) },
    )
    .await;
    within(
        Duration::from_secs(3),
        "studio-mini takes the switch",
        || async { own(&mini).await == (true, 2) },
    )
    .await;
    assert_eq!(
        settings(&air).await,
        vec![
            row(AIR, "Alex's MacBook Air", true, 4),
            row(BOOK, "Alex's MacBook Pro", false, 2),
            row(MINI, "studio-mini", true, 2),
        ]
    );
}

#[tokio::test]
async fn settings_set_for_an_offline_member_apply_when_it_links() {
    let (_mini, _addr, book, mut air) = account().await;
    air.stop();
    let _: bool = book
        .call("worker.settings.set", json!({ "worker": AIR, "slots": 1 }))
        .await;
    air.restart().await;
    within(
        Duration::from_secs(10),
        "the Air takes its slots",
        || async { own(&air).await == (false, 1) },
    )
    .await;
}

#[tokio::test]
async fn only_an_app_or_a_paired_mac_changes_worker_settings() {
    let (_mini, _addr, book, _air) = account().await;
    // An agent's CLI on the MacBook.
    let mut cli = Client::connect(&book.socket, "moonlet-cli").await.unwrap();
    let e = cli
        .request::<_, Value>(
            "worker.settings.set",
            json!({ "worker": AIR, "heavy": true }),
        )
        .await
        .unwrap_err()
        .to_string();
    assert!(e.starts_with("forbidden: "), "{e}");
    assert_eq!(
        settings(&book).await[0],
        row(AIR, "Alex's MacBook Air", false, 2)
    );
}

#[tokio::test]
async fn slots_outside_one_to_sixty_four_are_refused() {
    let (_mini, _addr, book, _air) = account().await;
    for slots in [0, 65] {
        assert_eq!(
            book.try_call(
                "worker.settings.set",
                json!({ "worker": AIR, "slots": slots })
            )
            .await,
            Err("invalid_params: slots must be from 1 to 64".to_string())
        );
    }
    assert_eq!(
        book.try_call(
            "worker.settings.set",
            json!({ "worker": "no-such-host", "heavy": true })
        )
        .await,
        Err("not_found: no member no-such-host".to_string())
    );
    assert_eq!(
        settings(&book).await[0],
        row(AIR, "Alex's MacBook Air", false, 2)
    );
}

#[tokio::test]
async fn link_set_writes_the_hosts_own_worker_settings() {
    let (mini, _addr, book, air) = account().await;
    // The Air's own Hosts page switch.
    let _: Value = air
        .call(
            "link.set",
            json!({ "worker": { "enabled": true, "slots": 3 } }),
        )
        .await;
    for d in [&mini, &book] {
        within(Duration::from_secs(3), "the Air's settings", || async {
            settings(d).await[0] == row(AIR, "Alex's MacBook Air", true, 3)
        })
        .await;
    }
}

#[tokio::test]
async fn link_json_settings_become_the_accounts_at_first_start() {
    let (mini, addr) = central().await;
    // A Mac that took heavy commands, with 3 slots, before X89.
    let book = mac_with(
        BOOK,
        "Alex's MacBook Pro",
        json!({ "enabled": true, "slots": 3 }),
    )
    .await;
    link(&book, &mini, &addr, "Alex's MacBook Pro").await;
    within(
        Duration::from_secs(10),
        "the MacBook's settings",
        || async {
            settings(&mini)
                .await
                .contains(&row(BOOK, "Alex's MacBook Pro", true, 3))
        },
    )
    .await;
    assert_eq!(own(&book).await, (true, 3));
}

fn git(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
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
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

const HEAVY: &str = "[heavy]\ncommands = [\"pnpm check\"]\nenv = [\"CI\"]\n";

/// Project `shop` on `d`: a checkout of one repository, whatever the
/// member, listing `pnpm check` as its heavy command. Gives its id.
async fn shop_on(d: &Daemon, origin_repo: &std::path::Path) -> String {
    let checkout = d.home.path().join("src/shop");
    if !origin_repo.join(".git").exists() {
        std::fs::create_dir_all(origin_repo).unwrap();
        git(origin_repo, &["init", "-q", "-b", "main"]);
        std::fs::write(origin_repo.join("package.json"), "{}\n").unwrap();
        git(origin_repo, &["add", "."]);
        git(origin_repo, &["commit", "-q", "-m", "shop"]);
    }
    std::fs::create_dir_all(checkout.parent().unwrap()).unwrap();
    git(
        checkout.parent().unwrap(),
        &["clone", "-q", origin_repo.to_str().unwrap(), "shop"],
    );
    git(
        &checkout,
        &[
            "remote",
            "set-url",
            "origin",
            "https://git.invalid/acme/shop.git",
        ],
    );
    // Kept out of git, as many projects keep it (X90).
    std::fs::create_dir_all(checkout.join(".moonlet")).unwrap();
    std::fs::write(checkout.join(".moonlet/config.toml"), HEAVY).unwrap();
    let p: Value = d.call("project.add", json!({ "path": checkout })).await;
    p["id"].as_str().unwrap().to_string()
}

async fn approved(d: &Daemon, project: &str) -> Value {
    let info: Value = d.call("heavy.get", json!({ "project": project })).await;
    info["approved"].clone()
}

#[tokio::test]
async fn an_approval_on_one_member_lets_every_member_route_and_run_the_list() {
    let (mini, _addr, book, _air) = account().await;
    let repo = tempfile::tempdir().unwrap();
    let on_mini = shop_on(&mini, repo.path()).await;
    let on_book = shop_on(&book, repo.path()).await;
    let session: Value = mini
        .call(
            "session.create",
            json!({ "project_id": on_mini, "name": "Fix cart" }),
        )
        .await;
    let route = || async {
        let r: Value = mini
            .call(
                "exec.route",
                json!({ "session": session["id"], "command": "pnpm check", "cwd": session["path"] }),
            )
            .await;
        r
    };
    assert_eq!(
        route().await,
        json!({ "route": false, "reason": "not_approved" })
    );
    // Approved once, on the MacBook.
    let _: Value = book
        .call(
            "heavy.approve",
            json!({ "project": on_book, "commands": ["pnpm check"], "env": ["CI"] }),
        )
        .await;
    within(
        Duration::from_secs(3),
        "the approval on studio-mini",
        || async {
            approved(&mini, &on_mini).await == json!({ "commands": ["pnpm check"], "env": ["CI"] })
        },
    )
    .await;
    assert_eq!(route().await, json!({ "route": true, "reason": null }));
    let info: Value = mini.call("heavy.get", json!({ "project": on_mini })).await;
    assert_eq!(info["account"], json!(true));
}

#[tokio::test]
async fn approvals_from_heavy_json_reach_the_account_at_first_start() {
    let (mini, addr) = central().await;
    let repo = tempfile::tempdir().unwrap();
    let on_mini = shop_on(&mini, repo.path()).await;
    let mut book = mac(BOOK, "Alex's MacBook Pro").await;
    let _ = shop_on(&book, repo.path()).await;
    let projects: Value = book.call("project.list", json!({})).await;
    let id = &projects[0]["identity"];
    let key = format!(
        "{} {}",
        id["origin"].as_str().unwrap_or(""),
        id["root"].as_str().unwrap()
    );
    // What the MacBook approved before X89, kept in its heavy.json.
    book.stop();
    std::fs::write(
        book.home.path().join("heavy.json"),
        json!({ key: { "commands": ["pnpm check"], "env": ["CI"] } }).to_string(),
    )
    .unwrap();
    book.restart().await;
    link(&book, &mini, &addr, "Alex's MacBook Pro").await;
    within(
        Duration::from_secs(10),
        "the approval on studio-mini",
        || async {
            approved(&mini, &on_mini).await == json!({ "commands": ["pnpm check"], "env": ["CI"] })
        },
    )
    .await;
}

#[tokio::test]
async fn approving_on_a_member_with_another_list_replaces_the_accounts() {
    let (mini, _addr, book, _air) = account().await;
    let repo = tempfile::tempdir().unwrap();
    let on_mini = shop_on(&mini, repo.path()).await;
    let on_book = shop_on(&book, repo.path()).await;
    let _: Value = book
        .call(
            "heavy.approve",
            json!({ "project": on_book, "commands": ["pnpm check"], "env": ["CI"] }),
        )
        .await;
    // studio-mini's checkout lists one more command.
    std::fs::write(
        mini.home.path().join("src/shop/.moonlet/config.toml"),
        "[heavy]\ncommands = [\"pnpm check\", \"pnpm lint\"]\nenv = [\"CI\"]\n",
    )
    .unwrap();
    within(
        Duration::from_secs(3),
        "the MacBook's approval on studio-mini",
        || async {
            approved(&mini, &on_mini).await == json!({ "commands": ["pnpm check"], "env": ["CI"] })
        },
    )
    .await;
    // The MacBook's app hears when another member approves.
    let mut app = book.app().await;
    let _: Value = app.request("daemon.info", json!({})).await.unwrap();
    let _: Value = mini
        .call(
            "heavy.approve",
            json!({ "project": on_mini, "commands": ["pnpm check", "pnpm lint"], "env": ["CI"] }),
        )
        .await;
    let heard = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(Some(moonlet_proto::Frame::Json(moonlet_proto::Message::Event {
                name, ..
            }))) = app.next_frame().await
                && name == "heavy.approval_changed"
            {
                return;
            }
        }
    })
    .await;
    assert!(
        heard.is_ok(),
        "the MacBook's app never heard of the approval"
    );
    assert_eq!(
        approved(&book, &on_book).await,
        json!({ "commands": ["pnpm check", "pnpm lint"], "env": ["CI"] })
    );
}
