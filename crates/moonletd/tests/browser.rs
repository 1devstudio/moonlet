//! X75: a browser opened by a terminal or agent moonlet starts opens where
//! the user is.

mod common;

use std::time::Duration;

use common::*;
use moonlet_core::client::Client;
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
