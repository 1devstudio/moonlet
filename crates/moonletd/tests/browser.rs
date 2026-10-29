//! X75: a browser opened by a terminal or agent moonlet starts opens where
//! the user is.

mod common;

use std::time::Duration;

use common::*;
use moonlet_core::client::Client;
use moonlet_proto::methods::{DeviceKind, MobilePairing};
use moonlet_proto::{Frame, Message};
use serde_json::{Value, json};

async fn daemon() -> Daemon {
    Daemon::start(tempfile::tempdir().unwrap(), &[]).await
}

/// Runs `script` in a new terminal of `d`.
async fn in_terminal(d: &Daemon, script: &str) {
    let _: Value = d
        .call(
            "terminal.create",
            json!({ "cwd": d.home.path(), "command": ["sh", "-c", script] }),
        )
        .await;
}

/// The next `browser.show` `c` gets, if one comes within `limit`.
async fn next_show(c: &mut Client, limit: Duration) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        let f = tokio::time::timeout_at(deadline, c.next_frame())
            .await
            .ok()?
            .unwrap()
            .unwrap();
        if let Frame::Json(Message::Event { name, data }) = f
            && name == "browser.show"
        {
            return Some(data);
        }
    }
}

#[tokio::test]
async fn browser_and_gh_browser_are_set_for_terminals_and_agents() {
    let d = daemon().await;
    let out = d.home.path().join("env.txt");
    in_terminal(
        &d,
        &format!(
            "printf '%s\\n%s\\n' \"$BROWSER\" \"$GH_BROWSER\" > '{0}'; command -v {1} >> '{0}'",
            out.display(),
            if cfg!(target_os = "macos") {
                "open"
            } else {
                "xdg-open"
            }
        ),
    )
    .await;
    let bin = d.home.path().join("bin");
    let want = format!(
        "{0}/moonlet-open\n{0}/moonlet-open\n{0}/shims/{1}\n",
        bin.display(),
        if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        }
    );
    within(
        Duration::from_secs(10),
        "the terminal's environment",
        || async { std::fs::read_to_string(&out).is_ok_and(|t| t == want) },
    )
    .await;
}

#[tokio::test]
async fn a_terminals_browser_url_reaches_this_macs_app() {
    let d = daemon().await;
    let mut app = d.app().await;
    in_terminal(
        &d,
        "\"$BROWSER\" 'https://accounts.example.test/o/oauth2/auth?client_id=1'",
    )
    .await;
    let shown = next_show(&mut app, Duration::from_secs(10))
        .await
        .expect("a browser.show");
    assert_eq!(
        shown["url"],
        json!("https://accounts.example.test/o/oauth2/auth?client_id=1")
    );
    assert!(shown.get("forward").is_none(), "{shown}");
    // The system's opener keeps everything but a URL.
    in_terminal(&d, "\"$BROWSER\" 'file:///etc/passwd'").await;
    assert_eq!(next_show(&mut app, Duration::from_secs(2)).await, None);
}

#[tokio::test]
async fn an_agents_cli_never_hears_a_url_to_open() {
    let d = daemon().await;
    let mut cli = Client::connect(&d.socket, "moonlet-cli").await.unwrap();
    in_terminal(&d, "\"$BROWSER\" 'https://example.test/'").await;
    assert_eq!(next_show(&mut cli, Duration::from_secs(3)).await, None);
}

const BOOK: &str = "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37";
const MINI: &str = "3c9a5e71-0d2b-4f86-a1c4-9e7b2d5f8a03";

/// The central host `studio-mini`, listening for members on 127.0.0.1.
async fn central() -> (Daemon, String) {
    for _ in 0..5 {
        let home = tempfile::tempdir().unwrap();
        let port = free_port();
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

async fn pair(central: &Daemon, addr: &str, name: &str, kind: DeviceKind) -> String {
    let p: MobilePairing = central
        .call(
            "mobile.pair_start",
            json!({ "kind": if kind == DeviceKind::Phone { "phone" } else { "desktop" } }),
        )
        .await;
    moonlet_link::tailnet::pair(&[addr.to_string()], &p.code, name, kind)
        .await
        .unwrap()
        .token
}

/// The MacBook, linked to `central`.
async fn linked_book(central: &Daemon, addr: &str) -> Daemon {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("link.json"),
        json!({ "central": null, "worker": { "id": BOOK, "name": "MacBook", "enabled": false } })
            .to_string(),
    )
    .unwrap();
    let book = Daemon::start(home, &[("MOONLET_MOBILE_ADDRS", "127.0.0.2")]).await;
    let token = pair(central, addr, "MacBook", DeviceKind::Desktop).await;
    let _: Value = book
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": token } }),
        )
        .await;
    within(Duration::from_secs(15), "the MacBook linked", || async {
        let workers: Value = central.call("worker.list", json!({})).await;
        workers
            .as_array()
            .is_some_and(|l| l.iter().any(|w| w["id"] == json!(BOOK)))
    })
    .await;
    book
}

#[tokio::test]
async fn a_url_on_the_central_host_reaches_the_app_of_the_member_where_the_user_is() {
    let (mini, addr) = central().await;
    let book = linked_book(&mini, &addr).await;
    let mut book_app = book.app().await;
    let mut mini_app = mini.app().await;
    let _: bool = book_app
        .request("presence.active", json!({}))
        .await
        .unwrap();
    // studio-mini hears of it.
    tokio::time::sleep(Duration::from_millis(500)).await;
    in_terminal(&mini, "\"$BROWSER\" 'https://accounts.example.test/auth'").await;
    let shown = next_show(&mut book_app, Duration::from_secs(10))
        .await
        .expect("a browser.show on the MacBook");
    assert_eq!(shown["url"], json!("https://accounts.example.test/auth"));
    assert_eq!(shown["from"], json!("studio-mini"));
    assert!(shown.get("waiting").is_none(), "{shown}");
    assert_eq!(next_show(&mut mini_app, Duration::from_secs(1)).await, None);
}

#[tokio::test]
async fn a_url_from_the_member_where_the_user_is_opens_there_without_the_central_host() {
    let (mut mini, addr) = central().await;
    let book = linked_book(&mini, &addr).await;
    let mut app = book.app().await;
    let _: bool = app.request("presence.active", json!({})).await.unwrap();
    mini.stop();
    in_terminal(&book, "\"$BROWSER\" 'https://github.com/login/device'").await;
    let shown = next_show(&mut app, Duration::from_secs(10))
        .await
        .expect("a browser.show");
    assert_eq!(shown["url"], json!("https://github.com/login/device"));
    assert!(shown.get("waiting").is_none(), "{shown}");
}

#[tokio::test]
async fn with_the_central_host_away_and_the_user_elsewhere_the_url_waits_here() {
    let (mut mini, addr) = central().await;
    let book = linked_book(&mini, &addr).await;
    let mut app = book.app().await;
    mini.stop();
    in_terminal(&book, "\"$BROWSER\" 'https://github.com/login/device'").await;
    let shown = next_show(&mut app, Duration::from_secs(10))
        .await
        .expect("a browser.show");
    assert_eq!(shown["waiting"], json!(true));
}

#[tokio::test]
async fn a_phone_where_the_user_is_gets_the_url_and_the_macs_app_leaves_it() {
    use moonlet_proto::{read_frame, write_frame};
    let (mini, addr) = central().await;
    let token = pair(&mini, &addr, "iPhone", DeviceKind::Phone).await;
    let mut phone = raw(&addr, &token, "moonlet-mobile").await;
    let req = Message::Request {
        id: 1,
        method: "presence.active".into(),
        params: json!({}),
    };
    write_frame(&mut phone, &Frame::Json(req)).await.unwrap();
    in_terminal(&mini, "\"$BROWSER\" 'https://github.com/login/device'").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let shown = loop {
        let f = tokio::time::timeout_at(deadline, read_frame(&mut phone))
            .await
            .expect("no browser.show")
            .unwrap()
            .unwrap();
        if let Frame::Json(Message::Event { name, data }) = f
            && name == "browser.show"
        {
            break data;
        }
    };
    assert_eq!(shown["to"], json!("phone"));
    assert_eq!(shown["url"], json!("https://github.com/login/device"));
}
