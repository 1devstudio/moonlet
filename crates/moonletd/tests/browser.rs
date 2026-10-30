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
    let bin = d.home.path().join("opener");
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
async fn a_url_for_this_mac_while_its_app_is_not_connected_waits_for_the_app() {
    let d = daemon().await;
    // From a terminal's `moonlet-open`, with no app connected.
    let mut cli = Client::connect(&d.socket, "moonlet-cli").await.unwrap();
    let _: bool = cli
        .request(
            "browser.open",
            json!({ "url": "https://accounts.example.test/auth" }),
        )
        .await
        .unwrap();
    // Not for an agent's CLI to take.
    let refused = cli
        .request::<Value, Value>("browser.pending", json!({}))
        .await;
    assert!(refused.unwrap_err().to_string().contains("forbidden"));
    let mut app = d.app().await;
    let waiting: Vec<Value> = app.request("browser.pending", json!({})).await.unwrap();
    let urls: Vec<(&Value, &Value)> = waiting.iter().map(|s| (&s["url"], &s["waiting"])).collect();
    assert_eq!(
        urls,
        [(&json!("https://accounts.example.test/auth"), &json!(true))]
    );
    // Handed over once.
    let again: Vec<Value> = app.request("browser.pending", json!({})).await.unwrap();
    assert_eq!(again, Vec::<Value>::new());
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
async fn a_url_for_a_member_whose_app_quit_waits_there_until_the_app_connects() {
    let (mini, addr) = central().await;
    let book = linked_book(&mini, &addr).await;
    {
        let mut book_app = book.app().await;
        let _: bool = book_app
            .request("presence.active", json!({}))
            .await
            .unwrap();
    }
    // studio-mini hears of it, and the MacBook's app has quit.
    tokio::time::sleep(Duration::from_millis(500)).await;
    in_terminal(&mini, "\"$BROWSER\" 'https://accounts.example.test/auth'").await;
    // An app that connected meanwhile would have heard it at once.
    tokio::time::sleep(Duration::from_secs(4)).await;
    let waiting: Vec<Value> = book
        .app()
        .await
        .request("browser.pending", json!({}))
        .await
        .unwrap();
    let got: Vec<(&Value, &Value, &Value)> = waiting
        .iter()
        .map(|s| (&s["url"], &s["from"], &s["waiting"]))
        .collect();
    assert_eq!(
        got,
        [(
            &json!("https://accounts.example.test/auth"),
            &json!("studio-mini"),
            &json!(true)
        )]
    );
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

/// A command that listens on `port` like gcloud's redirect server, opens
/// its sign-in with `$BROWSER`, answers one request and exits.
fn sign_in_command(port: u16) -> String {
    format!(
        r#"python3 -c '
import http.server, os, subprocess
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"You are now authenticated"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
srv = http.server.HTTPServer(("127.0.0.1", {port}), H)
subprocess.Popen([os.environ["BROWSER"], "https://accounts.example.test/auth?redirect_uri=http%3A%2F%2Flocalhost%3A{port}%2F"])
srv.handle_request()
'"#
    )
}

/// A plain HTTP GET of `path` on `127.0.0.1:port`; the whole answer.
async fn get(port: u16, path: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let Ok(mut s) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await else {
        return String::new();
    };
    let req = format!("GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(20), s.read_to_end(&mut out)).await;
    String::from_utf8_lossy(&out).to_string()
}

/// [`linked_book`], whose forwards listen one port along, as the central
/// host's command holds the port itself on this one machine.
async fn linked_book_one_along(central: &Daemon, addr: &str) -> Daemon {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("link.json"),
        json!({ "central": null, "worker": { "id": BOOK, "name": "MacBook", "enabled": false } })
            .to_string(),
    )
    .unwrap();
    let book = Daemon::start(
        home,
        &[
            ("MOONLET_MOBILE_ADDRS", "127.0.0.2"),
            ("MOONLET_TEST_FORWARD_OFFSET", "1"),
        ],
    )
    .await;
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

/// Two free ports in a row, below the range the system hands out to
/// other tests' listeners, so none of those takes the second meanwhile.
fn two_free_ports() -> u16 {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    for n in 0..5000u32 {
        let port = 20_000 + ((seed / 7 + n * 2) % 9_998) as u16;
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
            && std::net::TcpListener::bind(("127.0.0.1", port + 1)).is_ok()
        {
            return port;
        }
    }
    panic!("no two free ports in a row");
}

#[tokio::test]
async fn a_forward_carries_the_callback_and_ends_when_its_listener_closes() {
    let (mini, addr) = central().await;
    let book = linked_book_one_along(&mini, &addr).await;
    let mut app = book.app().await;
    let _: bool = app.request("presence.active", json!({})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let port = two_free_ports();
    in_terminal(&mini, &sign_in_command(port)).await;
    let shown = next_show(&mut app, Duration::from_secs(15))
        .await
        .expect("a browser.show");
    assert_eq!(shown["forward"], json!(port));
    assert!(shown.get("port_taken").is_none(), "{shown}");
    let answer = get(port + 1, "/?code=4").await;
    assert!(answer.ends_with("You are now authenticated"), "{answer:?}");
    // The command answered once and exited: the forward ends.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after = get(port + 1, "/?code=5").await;
    assert!(!after.contains("authenticated"), "{after:?}");
}

#[tokio::test]
async fn a_second_sign_in_on_the_same_port_comes_back_through_the_mac_s_forward() {
    let (mini, addr) = central().await;
    let book = linked_book_one_along(&mini, &addr).await;
    let mut app = book.app().await;
    let _: bool = app.request("presence.active", json!({})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let port = two_free_ports();
    in_terminal(&mini, &sign_in_command(port)).await;
    let shown = next_show(&mut app, Duration::from_secs(15))
        .await
        .expect("a browser.show");
    assert_eq!(shown["forward"], json!(port));
    assert!(
        get(port + 1, "/?code=4")
            .await
            .ends_with("You are now authenticated")
    );
    // Another sign-in on the same port right after, as `gcloud auth
    // application-default login` after `gcloud auth login`.
    within(
        Duration::from_secs(10),
        "the first command exited",
        || async { std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() },
    )
    .await;
    in_terminal(&mini, &sign_in_command(port)).await;
    let again = next_show(&mut app, Duration::from_secs(15))
        .await
        .expect("the second browser.show");
    assert_eq!(again["forward"], json!(port));
    assert!(again.get("port_taken").is_none(), "{again}");
    let answer = get(port + 1, "/?code=5").await;
    assert!(answer.ends_with("You are now authenticated"), "{answer:?}");
}

#[tokio::test]
async fn another_member_s_sign_in_on_a_forwarded_port_waits_for_retry_and_never_gets_its_callback()
{
    let (mini, addr) = central().await;
    let book = linked_book_one_along(&mini, &addr).await;
    let mut app = book.app().await;
    let _: bool = app.request("presence.active", json!({})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let port = two_free_ports();
    in_terminal(&mini, &sign_in_command(port)).await;
    let shown = next_show(&mut app, Duration::from_secs(15))
        .await
        .expect("studio-mini's browser.show");
    assert!(shown.get("port_taken").is_none(), "{shown}");
    // Another member opens a sign-in that comes back to the same port while
    // studio-mini's command still waits on it.
    let token = pair(&mini, &addr, "Another Mac", DeviceKind::Desktop).await;
    let mut s = raw(&addr, &token, "moonletd-worker").await;
    use moonlet_proto::{read_frame, write_frame};
    let mut call = async |id: u64, method: &str, params: Value| {
        let req = Message::Request {
            id,
            method: method.into(),
            params,
        };
        write_frame(&mut s, &Frame::Json(req)).await.unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let f = tokio::time::timeout_at(deadline, read_frame(&mut s))
                .await
                .expect("no reply")
                .unwrap()
                .unwrap();
            if let Frame::Json(Message::Response { id: got, error, .. }) = f
                && got == id
            {
                assert!(error.is_none(), "{error:?}");
                return;
            }
        }
    };
    call(
        1,
        "worker.register",
        registration("0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d", "Another Mac"),
    )
    .await;
    let url = format!(
        "https://accounts.example.test/auth?redirect_uri=http%3A%2F%2Flocalhost%3A{port}%2F&state=OTHER"
    );
    call(2, "browser.route", json!({ "url": url, "forward": port })).await;
    let other = next_show(&mut app, Duration::from_secs(15))
        .await
        .expect("Another Mac's browser.show");
    assert_eq!(other["url"], json!(url));
    assert_eq!(other["port_taken"], json!(true));
    // The browser's callback still reaches studio-mini's command.
    let answer = get(port + 1, "/?code=4").await;
    assert!(answer.ends_with("You are now authenticated"), "{answer:?}");
}

#[tokio::test]
async fn a_port_taken_on_the_mac_waits_for_retry() {
    let (mini, addr) = central().await;
    let book = linked_book_one_along(&mini, &addr).await;
    let mut app = book.app().await;
    let _: bool = app.request("presence.active", json!({})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let port = two_free_ports();
    let holder = std::net::TcpListener::bind(("127.0.0.1", port + 1)).unwrap();
    in_terminal(&mini, &sign_in_command(port)).await;
    let shown = next_show(&mut app, Duration::from_secs(15))
        .await
        .expect("a browser.show");
    assert_eq!(shown["port_taken"], json!(true));
    drop(holder);
    let _: bool = app
        .request("browser.retry", json!({ "url": shown["url"] }))
        .await
        .unwrap();
    let again = next_show(&mut app, Duration::from_secs(10))
        .await
        .expect("the browser.show again");
    assert!(again.get("port_taken").is_none(), "{again}");
    assert!(
        get(port + 1, "/?code=4")
            .await
            .ends_with("You are now authenticated")
    );
}

#[tokio::test]
async fn a_tunnel_without_a_matching_callback_is_forbidden() {
    let (mini, addr) = central().await;
    let _book = linked_book(&mini, &addr).await;
    // A member's request for a port nothing of the central host's waits on.
    let token = pair(&mini, &addr, "Another Mac", DeviceKind::Desktop).await;
    let mut s = raw(&addr, &token, "moonletd-worker").await;
    use moonlet_proto::{read_frame, write_frame};
    let reg = Message::Request {
        id: 1,
        method: "worker.register".into(),
        params: registration("0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d", "Another Mac"),
    };
    write_frame(&mut s, &Frame::Json(reg)).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let f = tokio::time::timeout_at(deadline, read_frame(&mut s))
            .await
            .expect("no reply")
            .unwrap()
            .unwrap();
        if let Frame::Json(Message::Response { id: 1, error, .. }) = f {
            assert!(error.is_none(), "{error:?}");
            break;
        }
    }
    let req = Message::Request {
        id: 2,
        method: "tunnel.open".into(),
        params: json!({ "member": MINI, "port": 5432, "data": "R0VUIC8gSFRUUC8xLjENCg0K" }),
    };
    write_frame(&mut s, &Frame::Json(req)).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let error = loop {
        let f = tokio::time::timeout_at(deadline, read_frame(&mut s))
            .await
            .expect("no reply")
            .unwrap()
            .unwrap();
        if let Frame::Json(Message::Response { id: 2, error, .. }) = f {
            break error.expect("an error");
        }
    };
    assert_eq!(
        (error.code.as_str(), error.message.as_str()),
        ("forbidden", "no sign-in waits on that port")
    );
}

/// `method` with `params` as request `id` on a raw link connection: the
/// error it answered, if any.
async fn raw_call(
    s: &mut tokio::net::TcpStream,
    id: u64,
    method: &str,
    params: Value,
) -> Option<moonlet_proto::RpcError> {
    use moonlet_proto::{read_frame, write_frame};
    let req = Message::Request {
        id,
        method: method.into(),
        params,
    };
    write_frame(s, &Frame::Json(req)).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let f = tokio::time::timeout_at(deadline, read_frame(s))
            .await
            .expect("no reply")
            .unwrap()
            .unwrap();
        if let Frame::Json(Message::Response { id: got, error, .. }) = f
            && got == id
        {
            return error;
        }
    }
}

#[tokio::test]
async fn a_tunnel_without_the_key_shown_to_the_mac_never_reaches_the_callback() {
    let (mini, addr) = central().await;
    let book = linked_book_one_along(&mini, &addr).await;
    let mut app = book.app().await;
    let _: bool = app.request("presence.active", json!({})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let port = two_free_ports();
    in_terminal(&mini, &sign_in_command(port)).await;
    let shown = next_show(&mut app, Duration::from_secs(15))
        .await
        .expect("a browser.show");
    assert_eq!(shown["forward"], json!(port));
    // The key stays with the MacBook's daemon: its app never hears it.
    assert!(shown.get("forward_key").is_none(), "{shown}");
    // Another member asks for the port studio-mini's command waits on,
    // with no key and then with one it made up.
    let token = pair(&mini, &addr, "Another Mac", DeviceKind::Desktop).await;
    let mut s = raw(&addr, &token, "moonletd-worker").await;
    let registered = raw_call(
        &mut s,
        1,
        "worker.register",
        registration("0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d", "Another Mac"),
    )
    .await;
    assert!(registered.is_none(), "{registered:?}");
    // `GET / HTTP/1.1`, in base64.
    let data = "R0VUIC8gSFRUUC8xLjENCg0K";
    let guessed = "5f".repeat(32);
    for (id, params) in [
        (2, json!({ "member": MINI, "port": port, "data": data })),
        (
            3,
            json!({ "member": MINI, "port": port, "data": data, "key": guessed }),
        ),
    ] {
        let error = raw_call(&mut s, id, "tunnel.open", params)
            .await
            .expect("an error");
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("forbidden", "no sign-in waits on that port")
        );
    }
    // The MacBook's forward, with the key it was shown, still reaches the
    // command.
    let answer = get(port + 1, "/?code=4").await;
    assert!(answer.ends_with("You are now authenticated"), "{answer:?}");
}

#[tokio::test]
async fn a_url_from_a_member_waits_on_a_central_host_that_never_saw_the_user() {
    let (mini, addr) = central().await;
    let book = linked_book(&mini, &addr).await;
    let mut mini_app = mini.app().await;
    // Nobody said where they are: not the MacBook's app, nor a phone.
    in_terminal(&book, "\"$BROWSER\" 'https://accounts.example.test/auth'").await;
    let shown = next_show(&mut mini_app, Duration::from_secs(10))
        .await
        .expect("a browser.show on studio-mini");
    assert_eq!(shown["from"], json!("MacBook"));
    assert_eq!(shown["waiting"], json!(true));
}

/// The next `browser.show` a raw connection gets, if one comes within
/// `limit`.
async fn next_raw_show(s: &mut tokio::net::TcpStream, limit: Duration) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        let f = tokio::time::timeout_at(deadline, moonlet_proto::read_frame(s))
            .await
            .ok()?
            .unwrap()?;
        if let Frame::Json(Message::Event { name, data }) = f
            && name == "browser.show"
        {
            return Some(data);
        }
    }
}

#[tokio::test]
async fn only_the_phone_where_the_user_is_gets_the_url() {
    use moonlet_proto::write_frame;
    let (mini, addr) = central().await;
    let iphone = pair(&mini, &addr, "iPhone", DeviceKind::Phone).await;
    let ipad = pair(&mini, &addr, "iPad", DeviceKind::Phone).await;
    let mut iphone = raw(&addr, &iphone, "moonlet-mobile").await;
    let mut ipad = raw(&addr, &ipad, "moonlet-mobile").await;
    let req = Message::Request {
        id: 1,
        method: "presence.active".into(),
        params: json!({}),
    };
    write_frame(&mut iphone, &Frame::Json(req)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    in_terminal(&mini, "\"$BROWSER\" 'https://github.com/login/device'").await;
    let shown = next_raw_show(&mut iphone, Duration::from_secs(10))
        .await
        .expect("a browser.show on the iPhone");
    assert_eq!(shown["url"], json!("https://github.com/login/device"));
    assert_eq!(next_raw_show(&mut ipad, Duration::from_secs(2)).await, None);
}

/// Opens `url` from a terminal of `d`, as `moonlet-open` does; on a central
/// host, the answer comes once the URL went where the user is.
async fn open_url(d: &Daemon, url: &str) {
    let mut cli = Client::connect(&d.socket, "moonlet-cli").await.unwrap();
    let _: bool = cli
        .request("browser.open", json!({ "url": url }))
        .await
        .unwrap();
}

#[tokio::test]
async fn a_url_for_a_phone_that_is_not_connected_waits_for_that_phone() {
    use moonlet_proto::write_frame;
    let (mini, addr) = central().await;
    let iphone = pair(&mini, &addr, "iPhone", DeviceKind::Phone).await;
    let ipad = pair(&mini, &addr, "iPad", DeviceKind::Phone).await;
    {
        let mut phone = raw(&addr, &iphone, "moonlet-mobile").await;
        let req = Message::Request {
            id: 1,
            method: "presence.active".into(),
            params: json!({}),
        };
        write_frame(&mut phone, &Frame::Json(req)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    // The iPhone went away, as iOS closes its socket in the background.
    tokio::time::sleep(Duration::from_secs(1)).await;
    open_url(&mini, "https://github.com/login/device").await;
    // Not for another phone.
    let mut other = raw(&addr, &ipad, "moonlet-mobile").await;
    assert_eq!(
        next_raw_show(&mut other, Duration::from_secs(1)).await,
        None
    );
    let mut phone = raw(&addr, &iphone, "moonlet-mobile").await;
    let shown = next_raw_show(&mut phone, Duration::from_secs(5))
        .await
        .expect("the URL that waited for the iPhone");
    assert_eq!(shown["url"], json!("https://github.com/login/device"));
    assert_eq!(shown["to"], json!("phone"));
    assert_eq!(shown["waiting"], json!(true));
    // Handed over once.
    drop(phone);
    let mut phone = raw(&addr, &iphone, "moonlet-mobile").await;
    assert_eq!(
        next_raw_show(&mut phone, Duration::from_secs(1)).await,
        None
    );
}

#[tokio::test]
async fn a_url_kept_for_a_macs_app_that_quit_leaves_the_next_waiting_until_the_user_is_back() {
    let (mini, addr) = central().await;
    let book = linked_book(&mini, &addr).await;
    {
        let mut book_app = book.app().await;
        let _: bool = book_app
            .request("presence.active", json!({}))
            .await
            .unwrap();
        // studio-mini hears of it.
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    // The MacBook's app quit: the first URL waits there for it.
    tokio::time::sleep(Duration::from_millis(500)).await;
    open_url(&mini, "https://accounts.example.test/first").await;
    let mut book_app = book.app().await;
    let waiting: Vec<Value> = book_app
        .request("browser.pending", json!({}))
        .await
        .unwrap();
    let urls: Vec<&Value> = waiting.iter().map(|s| &s["url"]).collect();
    assert_eq!(urls, [&json!("https://accounts.example.test/first")]);
    // The app is back, but the user was not seen there since: the next one
    // waits with Open rather than opening by itself.
    open_url(&mini, "https://accounts.example.test/second").await;
    let shown = next_show(&mut book_app, Duration::from_secs(5))
        .await
        .expect("a browser.show on the MacBook");
    assert_eq!(shown["url"], json!("https://accounts.example.test/second"));
    assert_eq!(shown["waiting"], json!(true));
    // The user is back at the MacBook: studio-mini hears it at once.
    let _: bool = book_app
        .request("presence.active", json!({}))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    open_url(&mini, "https://accounts.example.test/third").await;
    let shown = next_show(&mut book_app, Duration::from_secs(5))
        .await
        .expect("a browser.show on the MacBook");
    assert_eq!(shown["url"], json!("https://accounts.example.test/third"));
    assert!(shown.get("waiting").is_none(), "{shown}");
}

fn entry(check: &str, login: &str) -> Value {
    json!({ "id": "t", "name": "test-cli", "login": login, "check": check })
}

async fn states(d: &Daemon) -> Vec<(String, String)> {
    let list: Vec<Value> = d.call("signins.check", json!({ "entry": "t" })).await;
    let mut out: Vec<(String, String)> = list
        .iter()
        .map(|s| {
            (
                s["name"].as_str().unwrap().to_string(),
                s["state"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    out.sort();
    out
}

#[tokio::test]
async fn only_the_macs_app_changes_or_runs_sign_ins() {
    let d = daemon().await;
    let mut cli = Client::connect(&d.socket, "moonlet-cli").await.unwrap();
    for (method, params) in [
        ("signins.set", json!({ "entries": [entry("true", "true")] })),
        ("signins.check", json!({ "entry": "gh" })),
        (
            "signins.approve",
            json!({ "entry": "gh", "login": "gh auth login --web", "check": "gh auth status" }),
        ),
        ("signins.run", json!({ "entry": "gh", "members": [] })),
    ] {
        let e = cli.request::<_, Value>(method, params).await.unwrap_err();
        assert!(e.to_string().contains("forbidden"), "{method}: {e}");
    }
    // Anyone reads the list.
    let list: Vec<Value> = cli.request("signins.list", json!({})).await.unwrap();
    assert_eq!(list[0]["id"], json!("gh"));
}

#[tokio::test]
async fn a_sign_in_changed_on_another_member_asks_again_before_it_runs_here() {
    let (mini, addr) = central().await;
    let book = linked_book(&mini, &addr).await;
    let _: bool = book
        .call("signins.set", json!({ "entries": [entry("true", "true")] }))
        .await;
    within(
        Duration::from_secs(10),
        "the entry on studio-mini",
        || async {
            let list: Vec<Value> = mini.call("signins.list", json!({})).await;
            list.first().is_some_and(|e| e["id"] == json!("t"))
        },
    )
    .await;
    // An approval names the commands the user saw: others approve nothing.
    let e = book
        .try_call(
            "signins.approve",
            json!({ "entry": "t", "login": "true", "check": "curl evil.test" }),
        )
        .await
        .unwrap_err();
    assert!(e.contains("changed"), "{e}");
    let _: bool = book
        .call(
            "signins.approve",
            json!({ "entry": "t", "login": "true", "check": "true" }),
        )
        .await;
    assert_eq!(
        states(&book).await,
        [
            ("MacBook".to_string(), "signed_in".to_string()),
            ("studio-mini".to_string(), "needs_approval".to_string())
        ]
    );
    // studio-mini's app changes the check: the MacBook asks again.
    let _: bool = mini
        .call(
            "signins.set",
            json!({ "entries": [entry("exit 1", "true")] }),
        )
        .await;
    within(
        Duration::from_secs(10),
        "the MacBook asking again",
        || async {
            states(&book)
                .await
                .contains(&("MacBook".to_string(), "needs_approval".to_string()))
        },
    )
    .await;
}

#[tokio::test]
async fn sign_in_on_every_member_opens_one_browser_at_a_time() {
    let (mini, addr) = central().await;
    let book = linked_book(&mini, &addr).await;
    let mut app = book.app().await;
    let _: bool = app.request("presence.active", json!({})).await.unwrap();
    let login = "\"$BROWSER\" \"https://example.test/$(hostname)-$$\"; sleep 2";
    let _: bool = book
        .call(
            "signins.set",
            json!({ "entries": [entry("exit 1", login)] }),
        )
        .await;
    within(
        Duration::from_secs(10),
        "the entry on studio-mini",
        || async {
            let list: Vec<Value> = mini.call("signins.list", json!({})).await;
            list.first().is_some_and(|e| e["id"] == json!("t"))
        },
    )
    .await;
    let seen = json!({ "entry": "t", "login": login, "check": "exit 1" });
    let _: bool = book.call("signins.approve", seen.clone()).await;
    let _: bool = mini.call("signins.approve", seen).await;
    let _: bool = app
        .request(
            "signins.run",
            json!({ "entry": "t", "members": [MINI, BOOK] }),
        )
        .await
        .unwrap();
    let first = next_show(&mut app, Duration::from_secs(15))
        .await
        .expect("the first sign-in");
    assert_eq!(first["from"], json!("studio-mini"));
    // The MacBook's opens only once studio-mini's sign-in ended.
    assert_eq!(next_show(&mut app, Duration::from_millis(1500)).await, None);
    let second = next_show(&mut app, Duration::from_secs(10))
        .await
        .expect("the second sign-in");
    assert_eq!(second["from"], json!("MacBook"));
}
