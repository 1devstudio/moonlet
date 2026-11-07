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
                // A light load, whatever this machine's is: a busy host is
                // skipped (X62).
                ("MOONLET_TEST_LOAD", "0.5"),
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
    Daemon::start(
        home,
        &[
            ("MOONLET_MOBILE_ADDRS", "127.0.0.2"),
            ("MOONLET_TEST_LOAD", "0.5"),
        ],
    )
    .await
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
        std::fs::write(origin_repo.join(".gitignore"), "node_modules/\n").unwrap();
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

/// What a routed run sent back: stdout, stderr and the exit status.
#[derive(Debug)]
struct Ran {
    stdout: String,
    stderr: String,
    status: i32,
}

/// `exec.run` of `argv` in `session` on `d`, as `moonlet exec` sends it.
async fn run(d: &Daemon, session: &Value, argv: &[&str]) -> Ran {
    let mut c = d.app().await;
    let started: Value = c
        .request(
            "exec.run",
            json!({ "session": session["id"], "argv": argv, "cwd": session["path"], "env": {} }),
        )
        .await
        .unwrap();
    let run = started["run"].as_u64().unwrap();
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(60), c.next_frame())
            .await
            .expect("the run never ended")
            .unwrap()
            .expect("the daemon closed the connection");
        match frame {
            moonlet_proto::Frame::RunOutput {
                run: r,
                stream,
                data,
            } if u64::from(r) == run => {
                if stream == 1 {
                    stdout.extend(data)
                } else {
                    stderr.extend(data)
                }
            }
            moonlet_proto::Frame::Json(moonlet_proto::Message::Event { name, data })
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

const RUN_HEAVY: &str = "[heavy]\ncommands = [\"sh -c\", \"pnpm check\"]\n";

/// The account, with project `shop` on the MacBook and its session
/// `Fix cart` there, its heavy commands approved. Gives the session.
async fn book_session(book: &Daemon, repo: &std::path::Path) -> Value {
    let project = shop_on(book, repo).await;
    std::fs::write(
        book.home.path().join("src/shop/.moonlet/config.toml"),
        RUN_HEAVY,
    )
    .unwrap();
    let _: Value = book
        .call(
            "heavy.approve",
            json!({ "project": project, "commands": ["sh -c", "pnpm check"], "env": [] }),
        )
        .await;
    book.call(
        "session.create",
        json!({ "project_id": project, "name": "Fix cart" }),
    )
    .await
}

#[tokio::test]
async fn a_members_session_runs_its_heavy_command_on_the_central_host() {
    let (mini, _addr, book, _air) = account().await;
    let repo = tempfile::tempdir().unwrap();
    let session = book_session(&book, repo.path()).await;
    let _: bool = book
        .call(
            "worker.settings.set",
            json!({ "worker": MINI, "heavy": true }),
        )
        .await;
    within(
        Duration::from_secs(3),
        "studio-mini takes heavy commands",
        || async { own(&mini).await.0 },
    )
    .await;
    let ran = run(
        &book,
        &session,
        &["sh", "-c", "echo hi > out.txt; echo done"],
    )
    .await;
    assert_eq!(ran.status, 0, "{ran:?}");
    assert_eq!(ran.stdout, "done\n");
    assert!(
        ran.stderr.starts_with("moonlet: running on studio-mini\n"),
        "{}",
        ran.stderr
    );
    // The run's change is in the MacBook's worktree before the exit status.
    let worktree = std::path::PathBuf::from(session["path"].as_str().unwrap());
    assert_eq!(
        std::fs::read_to_string(worktree.join("out.txt")).unwrap(),
        "hi\n"
    );
}

/// Turns studio-mini's switch on or off from the MacBook, and waits until
/// studio-mini has it.
async fn mini_takes(mini: &Daemon, book: &Daemon, heavy: bool) {
    let _: bool = book
        .call(
            "worker.settings.set",
            json!({ "worker": MINI, "heavy": heavy }),
        )
        .await;
    within(Duration::from_secs(3), "studio-mini's switch", || async {
        own(mini).await.0 == heavy
    })
    .await;
}

#[tokio::test]
async fn a_host_with_heavy_commands_off_takes_none_from_other_hosts() {
    let (mini, _addr, book, _air) = account().await;
    let repo = tempfile::tempdir().unwrap();
    let session = book_session(&book, repo.path()).await;
    mini_takes(&mini, &book, true).await;
    mini_takes(&mini, &book, false).await;
    let ran = run(&book, &session, &["sh", "-c", "echo done"]).await;
    assert_eq!(ran.stderr, "moonlet: running on Alex's MacBook Pro\n");
    assert_eq!((ran.stdout.as_str(), ran.status), ("done\n", 0));
}

#[tokio::test]
async fn a_member_without_its_central_host_runs_its_own_commands() {
    let (mut mini, _addr, book, _air) = account().await;
    let repo = tempfile::tempdir().unwrap();
    let session = book_session(&book, repo.path()).await;
    mini_takes(&mini, &book, true).await;
    mini.stop();
    let started = std::time::Instant::now();
    let ran = run(&book, &session, &["sh", "-c", "echo done"]).await;
    assert_eq!(ran.stderr, "moonlet: running on Alex's MacBook Pro\n");
    assert_eq!(ran.status, 0);
    // It never waits for the central host to answer.
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_runner_that_goes_away_mid_run_makes_the_command_run_again_on_the_sessions_host() {
    let (mut mini, _addr, book, _air) = account().await;
    let repo = tempfile::tempdir().unwrap();
    let session = book_session(&book, repo.path()).await;
    mini_takes(&mini, &book, true).await;
    // The command says where it runs, by the daemon's home it inherits
    // (both daemons share this machine), then takes a while.
    let marker = format!(
        "case \"$MOONLET_HOME\" in {}) echo here;; *) echo there;; esac; sleep 3",
        book.home.path().display()
    );
    let mut c = book.app().await;
    let started: Value = c
        .request(
            "exec.run",
            json!({ "session": session["id"], "argv": ["sh", "-c", marker], "cwd": session["path"], "env": {} }),
        )
        .await
        .unwrap();
    let run_id = started["run"].as_u64().unwrap();
    let (mut stdout, mut stderr) = (String::new(), String::new());
    let mut stopped = false;
    let status = loop {
        let frame = tokio::time::timeout(Duration::from_secs(90), c.next_frame())
            .await
            .expect("the run never ended")
            .unwrap()
            .unwrap();
        match frame {
            moonlet_proto::Frame::RunOutput { run, stream, data } if u64::from(run) == run_id => {
                let text = String::from_utf8_lossy(&data).to_string();
                if stream == 1 {
                    stdout.push_str(&text);
                    // Running on studio-mini: it goes away.
                    if text.contains("there") && !stopped {
                        stopped = true;
                        mini.stop();
                    }
                } else {
                    stderr.push_str(&text);
                }
            }
            moonlet_proto::Frame::Json(moonlet_proto::Message::Event { name, data })
                if name == "exec.exited" && data["run"] == json!(run_id) =>
            {
                break data["status"].as_i64().unwrap();
            }
            _ => {}
        }
    };
    assert!(stopped, "it never ran on studio-mini: {stdout} {stderr}");
    assert_eq!(status, 0);
    assert_eq!(stdout, "there\nhere\n");
    assert!(
        stderr.starts_with("moonlet: running on studio-mini\n")
            && stderr
                .contains("moonlet: studio-mini went away. Running again on Alex's MacBook Pro.\n"),
        "{stderr}"
    );
}

#[tokio::test]
async fn a_stopped_members_command_stops_on_the_central_host() {
    let (mini, _addr, book, _air) = account().await;
    let repo = tempfile::tempdir().unwrap();
    let session = book_session(&book, repo.path()).await;
    mini_takes(&mini, &book, true).await;
    let mut c = book.app().await;
    let started: Value = c
        .request(
            "exec.run",
            json!({ "session": session["id"], "argv": ["sh", "-c", "echo x > before.txt; echo started; sleep 30; touch after.txt"], "cwd": session["path"], "env": {} }),
        )
        .await
        .unwrap();
    let run_id = started["run"].as_u64().unwrap();
    loop {
        let f = tokio::time::timeout(Duration::from_secs(30), c.next_frame())
            .await
            .expect("the run never started")
            .unwrap()
            .unwrap();
        if matches!(&f, moonlet_proto::Frame::RunOutput { stream: 1, data, .. } if data.starts_with(b"started"))
        {
            break;
        }
    }
    let _: bool = c
        .request("exec.cancel", json!({ "run": run_id }))
        .await
        .unwrap();
    let began = std::time::Instant::now();
    loop {
        let f = tokio::time::timeout(Duration::from_secs(30), c.next_frame())
            .await
            .expect("the run never ended")
            .unwrap()
            .unwrap();
        if let moonlet_proto::Frame::Json(moonlet_proto::Message::Event { name, data }) = f
            && name == "exec.exited"
            && data["run"] == json!(run_id)
        {
            assert_eq!(data["status"], json!(143));
            break;
        }
    }
    assert!(
        began.elapsed() < Duration::from_secs(10),
        "{:?}",
        began.elapsed()
    );
    let worktree = std::path::PathBuf::from(session["path"].as_str().unwrap());
    assert_eq!(
        std::fs::read_to_string(worktree.join("before.txt")).unwrap(),
        "x\n"
    );
    assert!(!worktree.join("after.txt").exists());
    let jobs: Vec<Value> = book
        .call("job.list", json!({ "session": session["id"] }))
        .await;
    assert_eq!(jobs[0]["worker"]["name"], json!("studio-mini"));
}

#[tokio::test]
async fn a_routing_copy_runs_the_setup_of_the_sessions_main_checkout() {
    let (mini, _addr, book, _air) = account().await;
    let repo = tempfile::tempdir().unwrap();
    let session = book_session(&book, repo.path()).await;
    // Kept out of git, in the MacBook's main checkout only (X90).
    std::fs::write(
        book.home.path().join("src/shop/.moonlet/config.toml"),
        format!("setup = \"mkdir -p node_modules && touch node_modules/.set-up\"\n{RUN_HEAVY}"),
    )
    .unwrap();
    mini_takes(&mini, &book, true).await;
    // studio-mini asks first, so this run stays on the MacBook.
    let ran = run(&book, &session, &["sh", "-c", "echo done"]).await;
    assert_eq!(ran.stderr, "moonlet: running on Alex's MacBook Pro\n");
    let setups: Vec<Value> = within_value(Duration::from_secs(10), "studio-mini asks", || async {
        let s: Vec<Value> = mini.call("exec.setups", json!({})).await;
        (!s.is_empty()).then_some(s)
    })
    .await;
    assert_eq!(
        setups[0]["command"],
        json!("mkdir -p node_modules && touch node_modules/.set-up")
    );
    let _: Value = mini
        .call(
            "sync.run_setup",
            json!({ "copy": setups[0]["copy"], "command": setups[0]["command"] }),
        )
        .await;
    // Once the setup has run, the command runs on studio-mini, where the
    // setup's ignored files are.
    let ran = within_value(Duration::from_secs(20), "a run on studio-mini", || async {
        let ran = run(
            &book,
            &session,
            &["sh", "-c", "test -e node_modules/.set-up && echo set"],
        )
        .await;
        ran.stderr
            .starts_with("moonlet: running on studio-mini\n")
            .then_some(ran)
    })
    .await;
    assert_eq!((ran.stdout.as_str(), ran.status), ("set\n", 0), "{ran:?}");
}

/// studio-mini's routing copies, the folders under its `runs/`.
fn mini_copies(mini: &Daemon) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut dirs = vec![mini.home.path().join("runs")];
    while let Some(d) = dirs.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.join(".git").exists() {
                out.push(p);
            } else if p.is_dir() && p.file_name().is_some_and(|n| n != "repos") {
                dirs.push(p);
            }
        }
    }
    out
}

#[tokio::test]
async fn archiving_a_members_session_removes_its_routing_copies_on_other_hosts() {
    let (mini, _addr, book, _air) = account().await;
    let repo = tempfile::tempdir().unwrap();
    let session = book_session(&book, repo.path()).await;
    mini_takes(&mini, &book, true).await;
    let ran = run(&book, &session, &["sh", "-c", "echo done"]).await;
    assert!(
        ran.stderr.starts_with("moonlet: running on studio-mini\n"),
        "{ran:?}"
    );
    assert_eq!(mini_copies(&mini).len(), 1);
    let _: Value = book
        .call(
            "session.archive",
            json!({ "id": session["id"], "force": true }),
        )
        .await;
    within(
        Duration::from_secs(10),
        "studio-mini's copy gone",
        || async { mini_copies(&mini).is_empty() },
    )
    .await;
}

#[tokio::test]
async fn a_host_with_no_free_slot_refuses_busy_and_the_next_one_runs_it() {
    let (mini, _addr, book, _air) = account().await;
    let repo = tempfile::tempdir().unwrap();
    let session = book_session(&book, repo.path()).await;
    let _: bool = book
        .call(
            "worker.settings.set",
            json!({ "worker": MINI, "heavy": true, "slots": 1 }),
        )
        .await;
    within(Duration::from_secs(3), "studio-mini's one slot", || async {
        own(&mini).await == (true, 1)
    })
    .await;
    // studio-mini runs a command of its own session: its one slot is taken.
    let on_mini = shop_on(&mini, repo.path()).await;
    std::fs::write(
        mini.home.path().join("src/shop/.moonlet/config.toml"),
        RUN_HEAVY,
    )
    .unwrap();
    let _: Value = mini
        .call(
            "heavy.approve",
            json!({ "project": on_mini, "commands": ["sh -c", "pnpm check"], "env": [] }),
        )
        .await;
    let own_session: Value = mini
        .call(
            "session.create",
            json!({ "project_id": on_mini, "name": "Own" }),
        )
        .await;
    let mut c = mini.app().await;
    let _: Value = c
        .request(
            "exec.run",
            json!({ "session": own_session["id"], "argv": ["sh", "-c", "sleep 5"], "cwd": own_session["path"], "env": {} }),
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let ran = run(&book, &session, &["sh", "-c", "echo done"]).await;
    assert_eq!(ran.stderr, "moonlet: running on Alex's MacBook Pro\n");
    // Not asked at all: worker.status said its one slot was taken.
    let st: Value = book.call("exec.status", json!({})).await;
    assert_eq!(st["skips"], json!([]), "{st}");
}
