//! X39: phones pair with a code, come back with a device token, lose access
//! when removed, and reach the Mac's SSH hosts through it. The daemon listens
//! on 127.0.0.1 here (`MOONLET_MOBILE_ADDRS`) instead of a Tailscale address.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::methods::{MobilePairing, MobileStatus};
use moonlet_proto::types::DaemonInfo;
use moonlet_proto::{Frame, Message, PROTOCOL_VERSION, read_frame, write_frame};
use serde_json::{Value, json};
use tokio::net::TcpStream;

struct Mac {
    home: tempfile::TempDir,
    socket: PathBuf,
    path: Option<PathBuf>,
    child: Child,
}

impl Mac {
    /// A daemon with phone access configured on an ephemeral port, and
    /// `path` first on its login shell's PATH (for a fake `ssh`).
    async fn start(path: Option<&Path>) -> Mac {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("mobile.json"),
            r#"{ "enabled": false, "port": 0 }"#,
        )
        .unwrap();
        let socket = home.path().join("run").join("d.sock");
        let child = Mac::spawn(home.path(), &socket, path).await;
        Mac {
            home,
            socket,
            path: path.map(Path::to_path_buf),
            child,
        }
    }

    async fn spawn(home: &Path, socket: &Path, path: Option<&Path>) -> Child {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_moonletd"));
        cmd.arg("daemon")
            .env("MOONLET_HOME", home)
            .env("MOONLET_SOCK", socket)
            .env("MOONLET_MOBILE_ADDRS", "127.0.0.1")
            // A task request no app answers fails within the test (X57).
            .env("MOONLET_TASKS_REQUEST_TIMEOUT_MS", "1500")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(p) = path {
            // The daemon takes PATH from the login shell, which reads these.
            let first = format!("PATH=\"{}:$PATH\"; export PATH\n", p.display());
            for rc in [
                ".profile",
                ".zshenv",
                ".zprofile",
                ".zshrc",
                ".bash_profile",
            ] {
                std::fs::write(home.join(rc), &first).unwrap();
            }
            cmd.env("HOME", home);
        }
        let child = cmd.spawn().unwrap();
        wait_for_socket(&socket.to_path_buf(), Duration::from_secs(15))
            .await
            .unwrap();
        child
    }

    /// Stops the daemon and starts a new one on the same home.
    async fn restart(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.child = Mac::spawn(self.home.path(), &self.socket, self.path.as_deref()).await;
    }

    async fn app(&self) -> Client {
        Client::connect(&self.socket, "moonlet-app").await.unwrap()
    }

    /// Turns phone access on and waits for the listener.
    async fn allow_phones(&self) -> String {
        let mut app = self.app().await;
        let _: MobileStatus = app
            .request("mobile.set_enabled", json!({ "enabled": true }))
            .await
            .unwrap();
        self.listening().await
    }

    /// Waits for the phone listener, without turning phone access on.
    async fn listening(&self) -> String {
        let mut app = self.app().await;
        for _ in 0..100 {
            let st: MobileStatus = app.request("mobile.status", json!({})).await.unwrap();
            if let Some(a) = st.listening.first() {
                return a.clone();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the daemon never listened for phones");
    }

    async fn pair(&self, addr: &str) -> String {
        let mut app = self.app().await;
        let p: MobilePairing = app.request("mobile.pair_start", json!({})).await.unwrap();
        match auth(addr, json!({ "pair": p.code, "device": "Alex's iPhone" }))
            .await
            .1
        {
            Some(Message::Authed { token: Some(t), .. }) => t,
            other => panic!("pairing failed: {other:?}"),
        }
    }
}

impl Drop for Mac {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn next_json(s: &mut TcpStream) -> Option<Message> {
    match tokio::time::timeout(Duration::from_secs(10), read_frame(s))
        .await
        .expect("no reply in time")
    {
        Ok(Some(Frame::Json(m))) => Some(m),
        Ok(Some(other)) => panic!("unexpected frame {other:?}"),
        Ok(None) | Err(_) => None,
    }
}

/// Opens a phone connection and sends `auth`.
async fn auth(addr: &str, fields: Value) -> (TcpStream, Option<Message>) {
    let mut s = TcpStream::connect(addr).await.unwrap();
    let mut frame = json!({ "t": "auth" });
    frame
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    let msg: Message = serde_json::from_value(frame).unwrap();
    write_frame(&mut s, &Frame::Json(msg)).await.unwrap();
    let reply = next_json(&mut s).await;
    (s, reply)
}

async fn hello(s: &mut TcpStream, client: &str) -> Option<Message> {
    write_frame(
        s,
        &Frame::Json(Message::Hello {
            protocol: PROTOCOL_VERSION,
            client: client.into(),
        }),
    )
    .await
    .unwrap();
    next_json(s).await
}

async fn call(s: &mut TcpStream, id: u64, method: &str) -> Message {
    write_frame(
        s,
        &Frame::Json(Message::Request {
            id,
            method: method.into(),
            params: json!({}),
        }),
    )
    .await
    .unwrap();
    loop {
        match next_json(s).await.expect("connection closed") {
            m @ Message::Response { id: rid, .. } if rid == id => return m,
            _ => {}
        }
    }
}

fn unauthorized(reply: &Option<Message>) -> bool {
    matches!(reply, Some(Message::Response { id: 0, error: Some(e), .. }) if e.code == "unauthorized")
}

#[tokio::test]
async fn phone_access_is_off_until_the_user_allows_it() {
    let mut mac = Mac::start(None).await;
    let mut app = mac.app().await;
    let st: MobileStatus = app.request("mobile.status", json!({})).await.unwrap();
    assert!(!st.enabled);
    assert!(st.listening.is_empty());
    let e = app
        .request::<_, MobilePairing>("mobile.pair_start", json!({}))
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), "mobile_off: phone access is off");

    mac.allow_phones().await;

    // A new daemon keeps the choice and listens again.
    mac.restart().await;
    let addr = mac.listening().await;
    let mut app = mac.app().await;
    let st: MobileStatus = app.request("mobile.status", json!({})).await.unwrap();
    assert!(st.enabled);

    // Off again: the port closes.
    let _: MobileStatus = app
        .request("mobile.set_enabled", json!({ "enabled": false }))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(TcpStream::connect(&addr).await.is_err());
}

#[tokio::test]
async fn a_paired_phone_comes_back_with_its_token_and_uses_the_daemon() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let mut app = mac.app().await;
    let p: MobilePairing = app.request("mobile.pair_start", json!({})).await.unwrap();
    assert!(p.url.starts_with("moonlet://pair?v=1&host="), "{}", p.url);
    assert!(p.url.ends_with(&format!("&code={}", p.code)), "{}", p.url);
    assert_eq!(p.addresses, vec![addr.clone()]);
    assert_eq!(p.code.len(), 32);

    let (_, reply) = auth(&addr, json!({ "pair": p.code, "device": "Alex's iPhone" })).await;
    let token = match reply {
        Some(Message::Authed { token: Some(t), .. }) => t,
        other => panic!("{other:?}"),
    };
    assert_eq!(token.len(), 64);
    // The app hears about it.
    loop {
        match app.next_frame().await.unwrap() {
            Some(Frame::Json(Message::Event { name, data })) if name == "mobile.paired" => {
                assert_eq!(data["device"]["name"], "Alex's iPhone");
                break;
            }
            Some(_) => {}
            None => panic!("app connection closed"),
        }
    }
    // The file keeps the token's hash, not the token.
    let file = std::fs::read_to_string(mac.home.path().join("mobile.json")).unwrap();
    assert!(!file.contains(&token));

    // The same code does not work twice.
    let (_, again) = auth(&addr, json!({ "pair": p.code, "device": "Other" })).await;
    assert!(unauthorized(&again), "{again:?}");

    let (mut phone, reply) = auth(&addr, json!({ "token": token })).await;
    assert!(
        matches!(reply, Some(Message::Authed { token: None, .. })),
        "{reply:?}"
    );
    assert!(matches!(
        hello(&mut phone, "moonlet-mobile").await,
        Some(Message::Welcome { .. })
    ));
    let info = call(&mut phone, 1, "daemon.info").await;
    assert!(
        matches!(
            info,
            Message::Response {
                error: None,
                result: Some(_),
                ..
            }
        ),
        "{info:?}"
    );

    let st: MobileStatus = app.request("mobile.status", json!({})).await.unwrap();
    assert_eq!(st.devices.len(), 1);
    assert_eq!(st.devices[0].name, "Alex's iPhone");
    assert!(st.devices[0].connected);
}

#[tokio::test]
async fn bad_auth_is_refused_without_saying_why() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    for fields in [
        json!({ "token": "00".repeat(32) }),
        json!({ "pair": "00".repeat(16) }),
        json!({}),
        json!({ "token": "a", "pair": "b" }),
    ] {
        let (_, reply) = auth(&addr, fields.clone()).await;
        assert!(unauthorized(&reply), "{fields}: {reply:?}");
        let Some(Message::Response { error: Some(e), .. }) = reply else {
            unreachable!()
        };
        assert_eq!(e.message, "this phone is not paired with this Mac");
    }
    // A first frame that is not `auth` gets nothing.
    let mut s = TcpStream::connect(&addr).await.unwrap();
    let r = hello(&mut s, "moonlet-mobile").await;
    assert!(unauthorized(&r), "{r:?}");
}

#[tokio::test]
async fn five_wrong_codes_end_the_pairing() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let mut app = mac.app().await;
    let p: MobilePairing = app.request("mobile.pair_start", json!({})).await.unwrap();
    for _ in 0..5 {
        let (_, r) = auth(&addr, json!({ "pair": "00".repeat(16) })).await;
        assert!(unauthorized(&r));
    }
    let (_, r) = auth(&addr, json!({ "pair": p.code })).await;
    assert!(
        unauthorized(&r),
        "the right code after five wrong ones: {r:?}"
    );
    loop {
        match app.next_frame().await.unwrap() {
            Some(Frame::Json(Message::Event { name, data })) if name == "mobile.pair_ended" => {
                assert_eq!(data["reason"], "too_many_attempts");
                break;
            }
            Some(_) => {}
            None => panic!("app connection closed"),
        }
    }
}

#[tokio::test]
async fn removing_a_phone_cuts_its_connection_and_its_token() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    assert!(matches!(
        hello(&mut phone, "moonlet-mobile").await,
        Some(Message::Welcome { .. })
    ));

    let mut app = mac.app().await;
    let st: MobileStatus = app.request("mobile.status", json!({})).await.unwrap();
    let _: bool = app
        .request("mobile.revoke", json!({ "id": st.devices[0].id }))
        .await
        .unwrap();
    // The open connection ends.
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match read_frame(&mut phone).await {
                Ok(Some(_)) => {}
                _ => return,
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "the phone's connection stayed open");
    let (_, r) = auth(&addr, json!({ "token": token })).await;
    assert!(unauthorized(&r), "{r:?}");
}

#[tokio::test]
async fn phones_and_agents_cannot_manage_phones() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;

    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone, "moonlet-mobile").await;
    for (id, method) in [
        (1, "mobile.pair_start"),
        (2, "mobile.status"),
        (3, "mobile.revoke"),
    ] {
        let Message::Response { error: Some(e), .. } = call(&mut phone, id, method).await else {
            panic!("{method} worked from a phone")
        };
        assert_eq!(e.message, "manage phones from the Mac", "{method}");
    }
    // A phone may list the hosts it can reach.
    let hosts = call(&mut phone, 4, "mobile.hosts").await;
    assert!(
        matches!(hosts, Message::Response { error: None, .. }),
        "{hosts:?}"
    );

    let mut cli = Client::connect(&mac.socket, "moonlet-cli").await.unwrap();
    let e = cli
        .request::<_, MobilePairing>("mobile.pair_start", json!({}))
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "forbidden: only the moonlet app manages phones"
    );

    // Nor can a phone say it is the CLI.
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    let r = hello(&mut phone, "moonlet-cli").await;
    assert!(
        matches!(&r, Some(Message::Response { error: Some(e), .. }) if e.code == "forbidden"),
        "{r:?}"
    );
}

/// A fake `ssh` that records its arguments and runs `moonletd proxy` against
/// a second daemon, as the real one would on the SSH host.
fn fake_ssh(dir: &Path, remote_home: &Path, args_file: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nMOONLET_HOME='{}' MOONLET_SOCK='{}' exec '{}' proxy\n",
        args_file.display(),
        remote_home.display(),
        remote_home.join("run").join("d.sock").display(),
        env!("CARGO_BIN_EXE_moonletd"),
    );
    let ssh = dir.join("ssh");
    std::fs::write(&ssh, script).unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[tokio::test]
async fn a_phone_reaches_an_ssh_host_through_the_mac() {
    let bin = tempfile::tempdir().unwrap();
    let remote_home = tempfile::tempdir().unwrap();
    let args_file = bin.path().join("ssh-args");
    fake_ssh(bin.path(), remote_home.path(), &args_file);
    let mac = Mac::start(Some(bin.path())).await;
    std::fs::write(
        mac.home.path().join("app-hosts.json"),
        r#"{ "remotes": ["devbox"] }"#,
    )
    .unwrap();
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;

    let (mut phone, reply) = auth(&addr, json!({ "token": token, "route": "devbox" })).await;
    assert!(matches!(reply, Some(Message::Authed { .. })), "{reply:?}");
    let welcome = hello(&mut phone, "moonlet-mobile").await;
    let Some(Message::Welcome { pid, .. }) = welcome else {
        panic!("no welcome through the route: {welcome:?}")
    };
    let mut mac_app = mac.app().await;
    let here: DaemonInfo = mac_app.request("daemon.info", json!({})).await.unwrap();
    assert_ne!(
        pid, here.pid,
        "the phone reached the Mac's daemon, not the host's"
    );

    let args: Vec<String> = std::fs::read_to_string(&args_file)
        .unwrap()
        .lines()
        .map(String::from)
        .collect();
    assert!(args.contains(&"BatchMode=yes".to_string()), "{args:?}");
    assert_eq!(
        &args[args.len() - 2..],
        ["devbox", "~/.moonlet/bin/moonletd proxy"]
    );

    // Nor can it manage phones on the host: it could pair itself there and
    // keep access after the Mac removes it.
    for (id, method) in [
        (1, "mobile.set_enabled"),
        (2, "mobile.pair_start"),
        (3, "mobile.status"),
    ] {
        let Message::Response { error: Some(e), .. } = call(&mut phone, id, method).await else {
            panic!("{method} worked through a route")
        };
        assert_eq!(e.message, "manage phones from the Mac", "{method}");
    }
    let hosts = call(&mut phone, 4, "mobile.hosts").await;
    assert!(
        matches!(hosts, Message::Response { error: None, .. }),
        "{hosts:?}"
    );

    // Only the desktop's hosts can be reached.
    let (_, r) = auth(
        &addr,
        json!({ "token": token, "route": "-oProxyCommand=evil" }),
    )
    .await;
    assert!(unauthorized(&r), "{r:?}");

    // Stop the host's daemon the fake ssh started.
    let mut remote = Client::connect(&remote_home.path().join("run").join("d.sock"), "test")
        .await
        .unwrap();
    let _: Value = remote.request("daemon.shutdown", json!({})).await.unwrap();
}

async fn call_with(s: &mut TcpStream, id: u64, method: &str, params: Value) -> Message {
    write_frame(s, &Frame::Json(Message::Request { id, method: method.into(), params })).await.unwrap();
    loop {
        match next_json(s).await.expect("connection closed") {
            m @ Message::Response { id: rid, .. } if rid == id => return m,
            _ => {}
        }
    }
}

/// Waits for event `name` on a phone connection.
async fn phone_event(s: &mut TcpStream, name: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let m = tokio::time::timeout_at(deadline, next_json(s)).await.expect("no event").expect("connection closed");
        if let Message::Event { name: n, data } = m
            && n == name
        {
            return data;
        }
    }
}

async fn personal_workspace(app: &mut Client) -> String {
    let list: Vec<moonlet_proto::types::Workspace> = app.request("workspace.list", json!({})).await.unwrap();
    list[0].id.clone()
}

/// A board snapshot as the app shares it (X57): the daemon keeps it whole.
fn board_snapshot() -> Value {
    json!({
        "version": 1,
        "synced_at": 1_791_970_430_000u64,
        "from": "studio",
        "boards": [{ "config": { "id": "linear:acme/team:MOON@local/personal", "name": "Moonlet" }, "tasks": [{ "key": "MOON-142", "title": "Remote hosts sidebar" }] }]
    })
}

#[tokio::test]
async fn the_apps_board_snapshot_reaches_the_phone_and_outlives_a_restart() {
    let mut mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone, "moonlet-mobile").await;

    let mut app = mac.app().await;
    let ws = personal_workspace(&mut app).await;
    let saved: bool = app.request("tasks.set_snapshot", json!({ "workspace": ws, "snapshot": board_snapshot() })).await.unwrap();
    assert!(saved);
    let changed = phone_event(&mut phone, "tasks.changed").await;
    assert_eq!(changed, json!({ "workspace": ws, "snapshot": board_snapshot() }));

    let Message::Response { result: Some(r), .. } = call_with(&mut phone, 1, "tasks.snapshot", json!({})).await else { panic!("no snapshots") };
    assert_eq!(r, json!([{ "workspace": ws, "snapshot": board_snapshot() }]));

    let file = mac.home.path().join("tasks").join(format!("{ws}.json"));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);

    mac.restart().await;
    let mut app = mac.app().await;
    let r: Value = app.request("tasks.snapshot", json!({ "workspace": ws })).await.unwrap();
    assert_eq!(r, json!([{ "workspace": ws, "snapshot": board_snapshot() }]));
}

#[tokio::test]
async fn only_the_app_shares_boards_and_a_workspace_takes_its_boards_along() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone, "moonlet-mobile").await;
    let mut app = mac.app().await;
    let ws = personal_workspace(&mut app).await;

    let Message::Response { error: Some(e), .. } = call_with(&mut phone, 1, "tasks.set_snapshot", json!({ "workspace": ws, "snapshot": board_snapshot() })).await else {
        panic!("a phone shared boards")
    };
    assert_eq!(e.message, "only the moonlet app shares boards");
    let mut cli = Client::connect(&mac.socket, "moonlet-cli").await.unwrap();
    let e = cli.request::<_, bool>("tasks.set_snapshot", json!({ "workspace": ws, "snapshot": board_snapshot() })).await.unwrap_err();
    assert_eq!(e.to_string(), "forbidden: only the moonlet app shares boards");

    let e = app.request::<_, bool>("tasks.set_snapshot", json!({ "workspace": "nope", "snapshot": {} })).await.unwrap_err();
    assert_eq!(e.to_string(), "not_found: no workspace nope");
    let big = json!({ "version": 1, "boards": [], "pad": "x".repeat(5 * 1024 * 1024) });
    let e = app.request::<_, bool>("tasks.set_snapshot", json!({ "workspace": ws, "snapshot": big })).await.unwrap_err();
    assert!(e.to_string().contains("over the 4 MB a daemon keeps"), "{e}");

    // A second workspace's boards go when it is deleted.
    let other: moonlet_proto::types::Workspace = app.request("workspace.create", json!({ "name": "Acme", "color": "clay" })).await.unwrap();
    let _: bool = app.request("tasks.set_snapshot", json!({ "workspace": other.id, "snapshot": board_snapshot() })).await.unwrap();
    let _: bool = app.request("workspace.delete", json!({ "id": other.id })).await.unwrap();
    let gone = loop {
        let ev = phone_event(&mut phone, "tasks.changed").await;
        if ev["snapshot"].is_null() {
            break ev;
        }
    };
    assert_eq!(gone, json!({ "workspace": other.id, "snapshot": null }));
    let left: Value = app.request("tasks.snapshot", json!({})).await.unwrap();
    assert_eq!(left, json!([]));
    assert!(!mac.home.path().join("tasks").join(format!("{}.json", other.id)).exists());
}

/// Waits for event `name` on an app connection.
async fn app_event(c: &mut Client, name: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let f = tokio::time::timeout_at(deadline, c.next_frame()).await.expect("no event").unwrap().unwrap();
        if let Frame::Json(Message::Event { name: n, data }) = f
            && n == name
        {
            return data;
        }
    }
}

#[tokio::test]
async fn a_phones_task_request_is_answered_by_the_app() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone, "moonlet-mobile").await;

    // With no app connected, the phone hears so at once.
    let started = std::time::Instant::now();
    let move_it = json!({ "workspace": "personal", "action": { "kind": "move", "board": "b1", "task": "linear:acme MOON-144", "column": "Done" } });
    let Message::Response { error: Some(e), .. } = call_with(&mut phone, 1, "tasks.request", move_it.clone()).await else { panic!("answered without an app") };
    assert_eq!(e.message, "Open moonlet on the Mac to change tasks.");
    assert!(started.elapsed() < Duration::from_secs(1));

    let mut app = mac.app().await;
    let (mut phone2, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone2, "moonlet-mobile").await;
    let asking = tokio::spawn(async move { call_with(&mut phone, 2, "tasks.request", move_it).await });
    let ev = app_event(&mut app, "tasks.request").await;
    assert_eq!(ev["workspace"], "personal");
    assert_eq!(ev["action"], json!({ "kind": "move", "board": "b1", "task": "linear:acme MOON-144", "column": "Done" }));
    let id = ev["request_id"].as_u64().unwrap();

    // Another phone cannot answer it.
    let Message::Response { error: Some(e), .. } = call_with(&mut phone2, 3, "tasks.answer", json!({ "request_id": id, "ok": true })).await else { panic!("a phone answered") };
    assert_eq!(e.message, "only the moonlet app answers task requests");

    let _: bool = app.request("tasks.answer", json!({ "request_id": id, "ok": true, "result": { "moved": "Done" } })).await.unwrap();
    let Message::Response { result: Some(r), error: None, .. } = asking.await.unwrap() else { panic!("no result") };
    assert_eq!(r, json!({ "moved": "Done" }));
    let e = app.request::<_, bool>("tasks.answer", json!({ "request_id": id, "ok": true })).await.unwrap_err();
    assert_eq!(e.to_string(), "failed: already answered");

    // A refusal carries the app's reason; silence ends after the timeout.
    let refuse = json!({ "workspace": "personal", "action": { "kind": "create", "board": "b1", "column": "Todo", "issue": { "title": "" } } });
    let asking = tokio::spawn(async move { call_with(&mut phone2, 4, "tasks.request", refuse).await });
    let ev = app_event(&mut app, "tasks.request").await;
    let _: bool = app.request("tasks.answer", json!({ "request_id": ev["request_id"], "ok": false, "error": "A title is needed." })).await.unwrap();
    let Message::Response { error: Some(e), .. } = asking.await.unwrap() else { panic!("not refused") };
    assert_eq!(e.message, "A title is needed.");

    let (mut phone3, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone3, "moonlet-mobile").await;
    let Message::Response { error: Some(e), .. } = call_with(&mut phone3, 5, "tasks.request", json!({ "workspace": "personal", "action": { "kind": "started" } })).await else { panic!("answered") };
    assert_eq!(e.message, "moonlet on the Mac did not answer.");

    let mut cli = Client::connect(&mac.socket, "moonlet-cli").await.unwrap();
    let e = cli.request::<_, Value>("tasks.request", json!({ "workspace": "personal", "action": {} })).await.unwrap_err();
    assert_eq!(e.to_string(), "forbidden: agents cannot change tasks through moonlet");
}
