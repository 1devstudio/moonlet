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
    home: tempfile::TempDir,
    env: Vec<(String, String)>,
    socket: PathBuf,
    child: Child,
}

fn spawn(home: &std::path::Path, socket: &std::path::Path, env: &[(String, String)]) -> Child {
    Command::new(env!("CARGO_BIN_EXE_moonletd"))
        .arg("daemon")
        .env("MOONLET_HOME", home)
        .env("MOONLET_SOCK", socket)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

impl Daemon {
    async fn start(home: tempfile::TempDir, env: &[(&str, &str)]) -> Daemon {
        let socket = home.path().join("run").join("d.sock");
        let env: Vec<(String, String)> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let child = spawn(home.path(), &socket, &env);
        wait_for_socket(&socket, Duration::from_secs(15))
            .await
            .unwrap();
        Daemon {
            home,
            env,
            socket,
            child,
        }
    }

    /// Stops the daemon and starts it again on the same home.
    async fn restart(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
        self.child = spawn(self.home.path(), &self.socket, &self.env);
        wait_for_socket(&self.socket, Duration::from_secs(15))
            .await
            .unwrap();
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
    central_with(|_| {}).await
}

/// [`central`], with `prepare` filling its home first.
async fn central_with(prepare: impl Fn(&std::path::Path)) -> (Daemon, String) {
    for _ in 0..5 {
        let home = tempfile::tempdir().unwrap();
        prepare(home.path());
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

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// What a worker's daemon sends to register as `id`.
fn registration(id: &str, name: &str) -> Value {
    json!({ "id": id, "name": name, "os": "macos", "arch": "arm64", "cores": 10, "version": "0.1.32", "projects": [] })
}

/// A change by log `member` that names workspace `id` `name`, stamped now.
fn renamed(member: &str, seq: u64, id: &str, name: &str) -> Value {
    json!({ "stamp": { "ms": now_ms(), "n": 0, "member": member }, "seq": seq, "kind": "workspace", "id": id, "op": { "set": { "field": "name", "value": name } } })
}

/// Waits until `d` listens on its tailnet address again.
async fn listening_again(d: &Daemon, addr: &str) {
    within(Duration::from_secs(10), "listening again", || async {
        let st: Value = d.call("mobile.status", json!({})).await;
        st["listening"]
            .as_array()
            .is_some_and(|l| l.contains(&json!(addr)))
    })
    .await;
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
async fn workspaces_merged_on_one_member_are_one_on_the_others() {
    let (mini, addr) = central().await;
    let book = mac(BOOK, "Alex's MacBook Pro").await;
    link(&book, &mini, &addr, "Alex's MacBook Pro").await;
    within(
        Duration::from_secs(10),
        "both Personal on the MacBook",
        || async { book.names().await.len() == 2 },
    )
    .await;
    let books = book.workspaces().await;
    let _: Value = book
        .call(
            "workspace.merge",
            json!({ "id": books[1].id, "into": books[0].id }),
        )
        .await;
    within(
        Duration::from_secs(3),
        "one Personal on studio-mini",
        || async {
            let ws = mini.workspaces().await;
            ws.len() == 1 && ws[0].id == books[0].id && ws[0].section_ids.len() == 2
        },
    )
    .await;
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

/// Sends request `id` on `s` and returns its reply.
async fn ask(s: &mut tokio::net::TcpStream, id: u64, method: &str, params: Value) -> Message {
    use moonlet_proto::{read_frame, write_frame};
    let req = Message::Request {
        id,
        method: method.into(),
        params,
    };
    write_frame(s, &Frame::Json(req)).await.unwrap();
    loop {
        match tokio::time::timeout(Duration::from_secs(10), read_frame(s))
            .await
            .expect("no reply")
        {
            Ok(Some(Frame::Json(m @ Message::Response { id: rid, .. }))) if rid == id => return m,
            Ok(Some(_)) => {}
            other => panic!("the connection ended: {other:?}"),
        }
    }
}

#[tokio::test]
async fn a_member_sends_only_its_own_changes() {
    let (mini, addr) = central().await;
    let token = pair(&mini, &addr, "Alex's MacBook Pro", DeviceKind::Desktop).await;
    let mut s = raw(&addr, &token, "moonletd-worker").await;
    let reg = registration(BOOK, "Alex's MacBook Pro");
    assert!(matches!(
        ask(&mut s, 1, "worker.register", reg).await,
        Message::Response { error: None, .. }
    ));
    let w = mini.workspaces().await[0].clone();
    // Stamped now, so it is the latest change to the name.
    let now = now_ms();
    let rename = |member: &str, name: &str| json!({ "stamp": { "ms": now, "n": 0, "member": member }, "seq": 1, "kind": "workspace", "id": w.id, "op": { "set": { "field": "name", "value": name } } });
    // Stamped as another member: dropped, so it cannot take that member's
    // numbers before it does.
    let other = format!("{AIR}.a1b2c3");
    ask(
        &mut s,
        2,
        "account.sync",
        json!({ "version": {}, "changes": [rename(&other, "Forged")] }),
    )
    .await;
    assert_eq!(mini.names().await, ["Personal"]);
    // Nor under a name that only starts like its own.
    for name in [
        format!("{BOOK}.toolongsuffix"),
        format!("{BOOK}."),
        format!("{BOOK}.k3x9q2.extra"),
    ] {
        ask(
            &mut s,
            9,
            "account.sync",
            json!({ "version": {}, "changes": [renamed(&name, 1, &w.id, "Forged")] }),
        )
        .await;
    }
    assert_eq!(mini.names().await, ["Personal"]);
    // Its own change is taken.
    let own = format!("{BOOK}.k3x9q2");
    ask(
        &mut s,
        3,
        "account.sync",
        json!({ "version": {}, "changes": [rename(&own, "Home")] }),
    )
    .await;
    assert_eq!(mini.names().await, ["Home"]);
}

/// A raw connection of a Mac paired with `central` that registered as
/// worker `id`, as a member's daemon does.
async fn member(central: &Daemon, addr: &str, id: &str, name: &str) -> tokio::net::TcpStream {
    let token = pair(central, addr, name, DeviceKind::Desktop).await;
    let mut s = raw(addr, &token, "moonletd-worker").await;
    let reg = registration(id, name);
    assert!(matches!(
        ask(&mut s, 1, "worker.register", reg).await,
        Message::Response { error: None, .. }
    ));
    s
}

/// The changes of the next `account.changed` that `s` hears.
async fn next_account_changed(s: &mut tokio::net::TcpStream) -> Vec<Value> {
    use moonlet_proto::read_frame;
    loop {
        match tokio::time::timeout(Duration::from_secs(10), read_frame(s))
            .await
            .expect("no account.changed")
        {
            Ok(Some(Frame::Json(Message::Event { name, data }))) if name == "account.changed" => {
                return data["changes"].as_array().unwrap().clone();
            }
            Ok(Some(_)) => {}
            other => panic!("the connection ended: {other:?}"),
        }
    }
}

#[tokio::test]
async fn two_changes_sent_under_one_number_reach_the_others_as_the_first_only() {
    let (mini, addr) = central().await;
    let mut book = member(&mini, &addr, BOOK, "Alex's MacBook Pro").await;
    let mut air = member(&mini, &addr, AIR, "Alex's MacBook Air").await;
    let w = mini.workspaces().await[0].clone();
    let log = format!("{BOOK}.k3x9q2");
    ask(
        &mut book,
        2,
        "account.sync",
        json!({ "version": {}, "changes": [renamed(&log, 1, &w.id, "Home"), renamed(&log, 1, &w.id, "Away")] }),
    )
    .await;
    let heard = next_account_changed(&mut air).await;
    let names: Vec<&Value> = heard.iter().map(|c| &c["op"]["set"]["value"]).collect();
    assert_eq!(names, [&json!("Home")]);
    assert_eq!(mini.names().await, ["Home"]);
}

#[tokio::test]
async fn a_change_the_central_host_already_holds_is_not_passed_on_again() {
    let (mini, addr) = central().await;
    let mut book = member(&mini, &addr, BOOK, "Alex's MacBook Pro").await;
    let mut air = member(&mini, &addr, AIR, "Alex's MacBook Air").await;
    let w = mini.workspaces().await[0].clone();
    let log = format!("{BOOK}.k3x9q2");
    let home = renamed(&log, 1, &w.id, "Home");
    for id in [2, 3] {
        ask(
            &mut book,
            id,
            "account.sync",
            json!({ "version": {}, "changes": [home] }),
        )
        .await;
    }
    ask(
        &mut book,
        4,
        "account.sync",
        json!({ "version": {}, "changes": [renamed(&log, 2, &w.id, "Away")] }),
    )
    .await;
    // The MacBook Air hears the first and the third, never the second.
    let seqs = |changes: Vec<Value>| -> Vec<u64> {
        changes.iter().map(|c| c["seq"].as_u64().unwrap()).collect()
    };
    assert_eq!(seqs(next_account_changed(&mut air).await), [1]);
    assert_eq!(seqs(next_account_changed(&mut air).await), [2]);
}

#[tokio::test]
async fn a_central_host_whose_account_cannot_be_read_answers_no_account() {
    // A folder where the log should be cannot be read, nor moved aside.
    let (mini, addr) =
        central_with(|home| std::fs::create_dir(home.join("account.json")).unwrap()).await;
    let mut book = member(&mini, &addr, BOOK, "Alex's MacBook Pro").await;
    let reply = ask(
        &mut book,
        2,
        "account.sync",
        json!({ "version": {}, "changes": [] }),
    )
    .await;
    assert_eq!(refused(&reply), Some("no_account"));
}

#[tokio::test]
async fn no_member_sends_changes_as_the_central_host() {
    let (mini, addr) = central().await;
    // The central host's worker id is no secret: its log is named after it.
    let info: Value = mini.call("link.get", json!({})).await;
    let central_id = info["worker"]["id"].as_str().unwrap().to_string();
    let token = pair(&mini, &addr, "Alex's MacBook Pro", DeviceKind::Desktop).await;
    let mut s = raw(&addr, &token, "moonletd-worker").await;
    let reg = registration(&central_id, "studio-mini");
    ask(&mut s, 1, "worker.register", reg).await;
    let w = mini.workspaces().await[0].clone();
    let now = now_ms();
    let change = json!({ "stamp": { "ms": now, "n": 0, "member": format!("{central_id}.k3x9q2") }, "seq": 1, "kind": "workspace", "id": w.id, "op": { "set": { "field": "name", "value": "Forged" } } });
    ask(
        &mut s,
        2,
        "account.sync",
        json!({ "version": {}, "changes": [change] }),
    )
    .await;
    assert_eq!(mini.names().await, ["Personal"]);
}

#[tokio::test]
async fn a_central_host_whose_worker_id_changed_goes_on_under_the_new_one_and_keeps_its_history() {
    // The central host's log was made before its link.json was lost, so it
    // is named after a worker id it no longer has.
    let old = "5e0c2b7d-91a4-4f3e-b6d8-2a7f0c9e1d35";
    let named = |seq: u64, field: &str, value: Value| json!({ "stamp": { "ms": 1_793_000_000_000u64 + seq, "n": 0, "member": format!("{old}.k3x9q2") }, "seq": seq, "kind": "workspace", "id": "w1", "op": { "set": { "field": field, "value": value } } });
    let history = vec![
        named(1, "name", json!("Studio")),
        named(2, "created_at", json!(1)),
    ];
    let (mini, addr) = central_with(|home| {
        std::fs::write(
            home.join("account.json"),
            json!({ "member": format!("{old}.k3x9q2"), "changes": history }).to_string(),
        )
        .unwrap();
    })
    .await;
    assert_eq!(mini.names().await, ["Studio"]);
    // Its new changes go under its current worker id.
    let info: Value = mini.call("link.get", json!({})).await;
    let id = info["worker"]["id"].as_str().unwrap().to_string();
    let w = mini.workspaces().await[0].clone();
    rename(&mini, &w.id, "Studio mini").await;
    let token = pair(&mini, &addr, "Alex's MacBook Pro", DeviceKind::Desktop).await;
    let mut s = raw(&addr, &token, "moonletd-worker").await;
    let reg = registration(&old, "studio-mini");
    ask(&mut s, 1, "worker.register", reg).await;
    let got = ask(
        &mut s,
        2,
        "account.sync",
        json!({ "version": {}, "changes": [] }),
    )
    .await;
    let Message::Response {
        result: Some(r), ..
    } = got
    else {
        panic!("{got:?}")
    };
    let version: std::collections::BTreeMap<String, u64> =
        serde_json::from_value(r["version"].clone()).unwrap();
    assert!(
        version.keys().any(|k| k.starts_with(&format!("{id}."))),
        "{version:?}"
    );
    // A Mac under the old id cannot rewrite what the old log said.
    let now = now_ms();
    let mut forged = named(1, "name", json!("Forged"));
    forged["stamp"]["ms"] = json!(now);
    ask(
        &mut s,
        3,
        "account.sync",
        json!({ "version": {}, "changes": [forged] }),
    )
    .await;
    assert_eq!(mini.names().await, ["Studio mini"]);
    // Nor add new changes under it: the name stays this host's.
    let more = renamed(&format!("{old}.k3x9q2"), 3, &w.id, "Forged again");
    ask(
        &mut s,
        4,
        "account.sync",
        json!({ "version": {}, "changes": [more] }),
    )
    .await;
    assert_eq!(mini.names().await, ["Studio mini"]);
}

fn refused(reply: &Message) -> Option<&str> {
    match reply {
        Message::Response { error: Some(e), .. } => Some(e.code.as_str()),
        _ => None,
    }
}

#[tokio::test]
async fn a_worker_id_stays_with_its_mac_across_a_restart_of_the_central_host() {
    let (mut mini, addr) = central().await;
    let book = pair(&mini, &addr, "Alex's MacBook Pro", DeviceKind::Desktop).await;
    let mut s = raw(&addr, &book, "moonletd-worker").await;
    assert_eq!(
        refused(
            &ask(
                &mut s,
                1,
                "worker.register",
                registration(BOOK, "Alex's MacBook Pro")
            )
            .await
        ),
        None
    );
    drop(s);
    mini.restart().await;
    listening_again(&mini, &addr).await;
    // Another paired Mac that knows the MacBook's worker id cannot take it,
    // and with it the MacBook's account changes.
    let other = pair(&mini, &addr, "Another Mac", DeviceKind::Desktop).await;
    let mut t = raw(&addr, &other, "moonletd-worker").await;
    assert_eq!(
        refused(
            &ask(
                &mut t,
                1,
                "worker.register",
                registration(BOOK, "Another Mac")
            )
            .await
        ),
        Some("forbidden")
    );
    let mut s = raw(&addr, &book, "moonletd-worker").await;
    assert_eq!(
        refused(
            &ask(
                &mut s,
                1,
                "worker.register",
                registration(BOOK, "Alex's MacBook Pro")
            )
            .await
        ),
        None
    );
}

#[tokio::test]
async fn a_phone_never_registers_as_a_worker() {
    let (mini, addr) = central().await;
    let phone = pair(&mini, &addr, "iPhone", DeviceKind::Phone).await;
    let mut s = raw(&addr, &phone, "moonletd-worker").await;
    assert_eq!(
        refused(&ask(&mut s, 1, "worker.register", registration(BOOK, "iPhone")).await),
        Some("forbidden")
    );
}

#[tokio::test]
async fn edits_made_before_a_macs_worker_id_changed_reach_the_central_host() {
    let (mini, addr) = central().await;
    let mut book = mac(BOOK, "Alex's MacBook Pro").await;
    let w = book.workspaces().await[0].clone();
    rename(&book, &w.id, "Train").await;
    // link.json is made again, with a new worker id, before it ever links.
    std::fs::write(book.home.path().join("link.json"), json!({ "central": null, "worker": { "id": AIR, "name": "Alex's MacBook Pro", "enabled": false } }).to_string()).unwrap();
    book.restart().await;
    link(&book, &mini, &addr, "Alex's MacBook Pro").await;
    within(
        Duration::from_secs(10),
        "the rename on studio-mini",
        || async { mini.names().await.contains(&"Train".to_string()) },
    )
    .await;
}

#[tokio::test]
async fn only_a_linked_mac_syncs_the_account() {
    let (mini, addr) = central().await;
    let phone = pair(&mini, &addr, "iPhone", DeviceKind::Phone).await;
    let mut s = raw(&addr, &phone, "moonlet-mobile").await;
    assert_eq!(sync_refused(&mut s).await.as_deref(), Some("forbidden"));
    // Saying it is a worker's daemon is not enough: a phone is no member.
    let mut s = raw(&addr, &phone, "moonletd-worker").await;
    assert_eq!(sync_refused(&mut s).await.as_deref(), Some("forbidden"));
    // Nor a Mac's connection that never registered as a worker.
    let mac = pair(&mini, &addr, "Alex's MacBook Pro", DeviceKind::Desktop).await;
    let mut s = raw(&addr, &mac, "moonletd-worker").await;
    assert_eq!(sync_refused(&mut s).await.as_deref(), Some("forbidden"));
    let mut cli = Client::connect(&mini.socket, "moonlet-cli").await.unwrap();
    let e = cli
        .request::<_, Value>("account.sync", json!({ "version": {}, "changes": [] }))
        .await
        .unwrap_err();
    assert!(e.to_string().contains("forbidden"), "{e}");
}
