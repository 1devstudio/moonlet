//! X68: members linked to one central host share their workspaces and
//! sections. Three daemons run here: the central host listens on 127.0.0.1
//! (`MOONLET_MOBILE_ADDRS`) instead of a Tailscale address, and two Macs
//! pair with it and link, as the desktop app makes them do.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::methods::{DeviceKind, MobilePairing};
use moonlet_proto::types::{Section, Workspace};
use moonlet_proto::{Frame, Message};
use serde_json::{Value, json};

const BOOK: &str = "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37";
const AIR: &str = "0b9e4f61-2a7c-4d3e-8f15-6c2a9d0e7b48";

struct Daemon {
    _home: tempfile::TempDir,
    socket: PathBuf,
    child: Child,
}

impl Daemon {
    async fn start(home: tempfile::TempDir, env: &[(&str, &str)]) -> Daemon {
        let socket = home.path().join("run").join("d.sock");
        let child = Command::new(env!("CARGO_BIN_EXE_moonletd"))
            .arg("daemon")
            .env("MOONLET_HOME", home.path())
            .env("MOONLET_SOCK", &socket)
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        wait_for_socket(&socket, Duration::from_secs(15))
            .await
            .unwrap();
        Daemon {
            _home: home,
            socket,
            child,
        }
    }

    async fn call<T: serde::de::DeserializeOwned>(&self, method: &str, params: Value) -> T {
        let mut app = Client::connect(&self.socket, "moonlet-app").await.unwrap();
        app.request(method, params).await.unwrap()
    }

    async fn workspaces(&self) -> Vec<Workspace> {
        self.call("workspace.list", json!({})).await
    }

    async fn names(&self) -> Vec<String> {
        let mut n: Vec<String> = self
            .workspaces()
            .await
            .into_iter()
            .map(|w| w.name)
            .collect();
        n.sort();
        n
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

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

/// A Mac with a fixed worker id, not linked yet. Its own "Tailscale
/// address" is 127.0.0.2, so linking to 127.0.0.1 is not linking to itself.
async fn mac(id: &str, name: &str) -> Daemon {
    mac_with(id, name, &[]).await
}

/// [`mac`], with more of the daemon's environment.
async fn mac_with(id: &str, name: &str, env: &[(&str, &str)]) -> Daemon {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("link.json"),
        json!({ "central": null, "worker": { "id": id, "name": name, "enabled": false } })
            .to_string(),
    )
    .unwrap();
    let mut all = vec![("MOONLET_MOBILE_ADDRS", "127.0.0.2")];
    all.extend_from_slice(env);
    Daemon::start(home, &all).await
}

async fn pair(central: &Daemon, addr: &str, device: &str, kind: DeviceKind) -> String {
    let start = match kind {
        DeviceKind::Desktop => json!({ "kind": "desktop" }),
        _ => json!({}),
    };
    let p: MobilePairing = central.call("mobile.pair_start", start).await;
    moonlet_link::tailnet::pair(&[addr.to_string()], &p.code, device, kind)
        .await
        .unwrap()
        .token
}

/// Makes `central` the Mac's central host. Heavy commands stay off: the
/// account needs the link by itself.
async fn link(mac: &Daemon, central: &Daemon, addr: &str, name: &str) {
    let token = pair(central, addr, name, DeviceKind::Desktop).await;
    let _: Value = mac
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": token } }),
        )
        .await;
}

/// Waits up to `limit` for `ok`; returns how long it took.
async fn within<F, Fut>(limit: Duration, what: &str, mut ok: F) -> Duration
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let start = Instant::now();
    while start.elapsed() < limit {
        if ok().await {
            return start.elapsed();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{what} did not happen within {limit:?}");
}

async fn rename(d: &Daemon, id: &str, name: &str) {
    let _: Workspace = d
        .call("workspace.update", json!({ "id": id, "name": name }))
        .await;
}

#[tokio::test]
async fn a_rename_on_one_member_reaches_the_others_within_three_seconds() {
    let (mini, addr) = central().await;
    let book = mac(BOOK, "Alex's MacBook Pro").await;
    let air = mac(AIR, "Alex's MacBook Air").await;
    link(&book, &mini, &addr, "Alex's MacBook Pro").await;
    link(&air, &mini, &addr, "Alex's MacBook Air").await;
    // Each member's "Personal" reaches the others.
    for d in [&mini, &book, &air] {
        within(
            Duration::from_secs(10),
            "every Personal on every member",
            || async { d.names().await == ["Personal", "Personal", "Personal"] },
        )
        .await;
    }
    let books = book.workspaces().await[0].clone();
    rename(&book, &books.id, "Home").await;
    within(
        Duration::from_secs(3),
        "the rename on the other Mac",
        || async { air.names().await == ["Home", "Personal", "Personal"] },
    )
    .await;
    assert_eq!(mini.names().await, ["Home", "Personal", "Personal"]);
}

#[tokio::test]
async fn changes_made_apart_meet_when_a_member_links_again() {
    let (mini, addr) = central().await;
    let book = mac(BOOK, "Alex's MacBook Pro").await;
    // On the train: the MacBook is not linked yet when it adds a section.
    let books = book.workspaces().await[0].clone();
    let _: Section = book
        .call(
            "section.create",
            json!({ "workspace_id": books.id, "name": "Train notes" }),
        )
        .await;
    let minis = mini.workspaces().await[0].clone();
    rename(&mini, &minis.id, "Studio").await;

    link(&book, &mini, &addr, "Alex's MacBook Pro").await;
    for d in [&mini, &book] {
        within(
            Duration::from_secs(10),
            "both members' changes on both",
            || async {
                let names: Vec<String> = d
                    .call::<Vec<Section>>("section.list", json!({}))
                    .await
                    .into_iter()
                    .map(|s| s.name)
                    .collect();
                d.names().await == ["Personal", "Studio"]
                    && names.contains(&"Train notes".to_string())
            },
        )
        .await;
    }
}

#[tokio::test]
async fn another_members_change_says_workspaces_changed_to_this_macs_app() {
    let (mini, addr) = central().await;
    let book = mac(BOOK, "Alex's MacBook Pro").await;
    let air = mac(AIR, "Alex's MacBook Air").await;
    link(&book, &mini, &addr, "Alex's MacBook Pro").await;
    link(&air, &mini, &addr, "Alex's MacBook Air").await;
    within(
        Duration::from_secs(10),
        "every Personal on the Air",
        || async { air.names().await.len() == 3 },
    )
    .await;
    let mut app = Client::connect(&air.socket, "moonlet-app").await.unwrap();
    let books = book.workspaces().await[0].clone();
    rename(&book, &books.id, "Home").await;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let frame = tokio::time::timeout_at(deadline.into(), app.next_frame())
            .await
            .expect("no workspaces.changed with Home")
            .unwrap()
            .unwrap();
        if let Frame::Json(Message::Event { name, data }) = frame
            && name == "workspaces.changed"
            && data.as_array().unwrap().iter().any(|w| w["name"] == "Home")
        {
            break;
        }
    }
}

#[tokio::test]
async fn a_member_that_missed_a_change_has_it_at_its_next_exchange() {
    let (mini, addr) = central().await;
    let book = mac(BOOK, "Alex's MacBook Pro").await;
    // The Air hears no account.changed, and exchanges every half second.
    let air = mac_with(
        AIR,
        "Alex's MacBook Air",
        &[
            ("MOONLET_TEST_IGNORE_ACCOUNT_EVENTS", "1"),
            ("MOONLET_ACCOUNT_RESYNC_MS", "500"),
        ],
    )
    .await;
    link(&book, &mini, &addr, "Alex's MacBook Pro").await;
    link(&air, &mini, &addr, "Alex's MacBook Air").await;
    within(
        Duration::from_secs(10),
        "every Personal on the Air",
        || async { air.names().await.len() == 3 },
    )
    .await;
    let books = book.workspaces().await[0].clone();
    rename(&book, &books.id, "Home").await;
    within(Duration::from_secs(3), "the rename on the Air", || async {
        air.names().await.contains(&"Home".to_string())
    })
    .await;
}

#[tokio::test]
async fn a_phone_never_hears_the_accounts_changes() {
    use moonlet_proto::read_frame;
    let (mini, addr) = central().await;
    let book = mac(BOOK, "Alex's MacBook Pro").await;
    let phone = pair(&mini, &addr, "iPhone", DeviceKind::Phone).await;
    let mut s = raw(&addr, &phone, "moonlet-mobile").await;
    link(&book, &mini, &addr, "Alex's MacBook Pro").await;
    let books = book.workspaces().await[0].clone();
    within(
        Duration::from_secs(10),
        "the MacBook's Personal on studio-mini",
        || async { mini.workspaces().await.iter().any(|w| w.id == books.id) },
    )
    .await;
    rename(&book, &books.id, "Home").await;
    // The phone hears that the workspaces changed, never the changes.
    let mut heard = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !heard
        .iter()
        .any(|(n, d): &(String, Value)| n == "workspaces.changed" && d.to_string().contains("Home"))
    {
        let Ok(frame) = tokio::time::timeout_at(deadline.into(), read_frame(&mut s)).await else {
            break;
        };
        if let Some(Frame::Json(Message::Event { name, data })) = frame.unwrap() {
            heard.push((name, data));
        }
    }
    let names: Vec<&str> = heard.iter().map(|(n, _)| n.as_str()).collect();
    assert!(names.contains(&"workspaces.changed"), "{names:?}");
    assert!(!names.contains(&"account.changed"), "{names:?}");
}

/// A connection by hand: authenticated with `token`, hello as `client`.
async fn raw(addr: &str, token: &str, client: &str) -> tokio::net::TcpStream {
    use moonlet_proto::{read_frame, write_frame};
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let auth = Message::Auth {
        token: Some(token.into()),
        pair: None,
        device: None,
        route: None,
        kind: None,
    };
    write_frame(&mut s, &Frame::Json(auth)).await.unwrap();
    assert!(matches!(
        read_frame(&mut s).await.unwrap(),
        Some(Frame::Json(Message::Authed { .. }))
    ));
    let hello = Message::Hello {
        protocol: moonlet_proto::PROTOCOL_VERSION,
        client: client.into(),
    };
    write_frame(&mut s, &Frame::Json(hello)).await.unwrap();
    assert!(matches!(
        read_frame(&mut s).await.unwrap(),
        Some(Frame::Json(Message::Welcome { .. }))
    ));
    s
}

/// The error code of request `account.sync` sent on `s`.
async fn sync_refused(s: &mut tokio::net::TcpStream) -> Option<String> {
    use moonlet_proto::{read_frame, write_frame};
    let req = Message::Request {
        id: 1,
        method: "account.sync".into(),
        params: json!({ "version": {}, "changes": [] }),
    };
    write_frame(s, &Frame::Json(req)).await.unwrap();
    loop {
        match tokio::time::timeout(Duration::from_secs(10), read_frame(s))
            .await
            .expect("no reply")
        {
            Ok(Some(Frame::Json(Message::Response { id: 1, error, .. }))) => {
                return error.map(|e| e.code);
            }
            Ok(Some(_)) => {}
            other => panic!("the connection ended: {other:?}"),
        }
    }
}

#[tokio::test]
async fn only_a_linked_mac_syncs_the_account() {
    let (mini, addr) = central().await;
    let phone = pair(&mini, &addr, "iPhone", DeviceKind::Phone).await;
    let mut s = raw(&addr, &phone, "moonlet-mobile").await;
    assert_eq!(sync_refused(&mut s).await.as_deref(), Some("forbidden"));
    let mut cli = Client::connect(&mini.socket, "moonlet-cli").await.unwrap();
    let e = cli
        .request::<_, Value>("account.sync", json!({ "version": {}, "changes": [] }))
        .await
        .unwrap_err();
    assert!(e.to_string().contains("forbidden"), "{e}");
}
