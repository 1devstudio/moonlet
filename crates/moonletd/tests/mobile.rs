//! X39: phones pair with a code, come back with a device token, lose access
//! when removed, and reach the Mac's SSH hosts through it. The daemon listens
//! on 127.0.0.1 here (`MOONLET_MOBILE_ADDRS`) instead of a Tailscale address.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
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
    assert_eq!(p.code.len(), 10);

    // Typed by hand, in lowercase with a space (X57).
    let typed = format!("{} {}", &p.code[..5], &p.code[5..]).to_lowercase();
    let (_, reply) = auth(&addr, json!({ "pair": typed, "device": "Alex's iPhone" })).await;
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
async fn authed_says_which_daemon_answered_before_hello() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let mut app = mac.app().await;
    let info: DaemonInfo = app.request("daemon.info", json!({})).await.unwrap();
    let st: MobileStatus = app.request("mobile.status", json!({})).await.unwrap();

    let (_, reply) = auth(&addr, json!({ "token": token })).await;
    let Some(Message::Authed {
        protocol,
        daemon_version,
        host,
        os,
        ..
    }) = reply
    else {
        panic!("{reply:?}")
    };
    assert_eq!(protocol, Some(info.protocol));
    assert_eq!(daemon_version.as_deref(), Some(info.version.as_str()));
    assert_eq!(host.as_deref(), Some(st.host.as_str()));
    let this_os = if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    assert_eq!(os.as_deref(), Some(this_os));
}

#[tokio::test]
async fn a_mac_pairs_as_a_desktop() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let mut app = mac.app().await;
    let p: MobilePairing = app.request("mobile.pair_start", json!({ "kind": "desktop" })).await.unwrap();
    let (_, reply) = auth(
        &addr,
        json!({ "pair": p.code, "device": "Alex's MacBook Pro", "kind": "desktop" }),
    )
    .await;
    assert!(
        matches!(reply, Some(Message::Authed { token: Some(_), .. })),
        "{reply:?}"
    );
    assert!(!token.is_empty());

    let st: Value = app.request("mobile.status", json!({})).await.unwrap();
    let kinds: Vec<(&str, &str)> = st["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (d["name"].as_str().unwrap(), d["kind"].as_str().unwrap()))
        .collect();
    assert_eq!(
        kinds,
        [
            ("Alex's iPhone", "phone"),
            ("Alex's MacBook Pro", "desktop")
        ]
    );
}

#[tokio::test]
async fn a_device_pairs_only_as_the_kind_its_code_was_made_for() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let mut app = mac.app().await;

    // A code from Settings › Phones, used by something that says it is a Mac.
    let p: MobilePairing = app.request("mobile.pair_start", json!({})).await.unwrap();
    let (_, reply) = auth(
        &addr,
        json!({ "pair": p.code, "device": "Not a MacBook", "kind": "desktop" }),
    )
    .await;
    assert!(unauthorized(&reply), "{reply:?}");

    // A code for a Mac, used by a phone, which says no kind.
    let p: MobilePairing = app
        .request("mobile.pair_start", json!({ "kind": "desktop" }))
        .await
        .unwrap();
    let (_, reply) = auth(&addr, json!({ "pair": p.code, "device": "Alex's iPhone" })).await;
    assert!(unauthorized(&reply), "{reply:?}");
    // The code still pairs the Mac it was made for.
    let (_, reply) = auth(
        &addr,
        json!({ "pair": p.code, "device": "Alex's MacBook Pro", "kind": "desktop" }),
    )
    .await;
    assert!(
        matches!(reply, Some(Message::Authed { token: Some(_), .. })),
        "{reply:?}"
    );

    let st: Value = app.request("mobile.status", json!({})).await.unwrap();
    let kinds: Vec<(&str, &str)> = st["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (d["name"].as_str().unwrap(), d["kind"].as_str().unwrap()))
        .collect();
    assert_eq!(kinds, [("Alex's MacBook Pro", "desktop")]);
}

#[tokio::test]
async fn no_pairing_code_is_made_for_a_cloud_machine() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let mut app = mac.app().await;
    let e = app
        .request::<_, MobilePairing>("mobile.pair_start", json!({ "kind": "cloud" }))
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "invalid_params: a cloud machine pairs only with its join code"
    );
    // Nor does a phone's code pair something that says it is one.
    let p: MobilePairing = app.request("mobile.pair_start", json!({})).await.unwrap();
    let (_, reply) = auth(
        &addr,
        json!({ "pair": p.code, "device": "moonlet-shop-1", "kind": "cloud" }),
    )
    .await;
    assert!(unauthorized(&reply), "{reply:?}");
}

#[tokio::test]
async fn a_paired_mac_can_remove_itself_but_manage_nothing_else() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let mut app = mac.app().await;
    let p: MobilePairing = app.request("mobile.pair_start", json!({ "kind": "desktop" })).await.unwrap();
    let (_, reply) = auth(
        &addr,
        json!({ "pair": p.code, "device": "Alex's MacBook Pro", "kind": "desktop" }),
    )
    .await;
    let Some(Message::Authed {
        token: Some(token), ..
    }) = reply
    else {
        panic!("{reply:?}")
    };

    let (mut desktop, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut desktop, "moonlet-app").await;
    for (id, method) in [
        (1, "mobile.pair_start"),
        (2, "mobile.status"),
        (3, "mobile.revoke"),
    ] {
        let Message::Response { error: Some(e), .. } = call(&mut desktop, id, method).await else {
            panic!("{method} worked from a paired Mac")
        };
        assert_eq!(e.message, "manage phones from the Mac", "{method}");
    }

    let unpaired = call(&mut desktop, 4, "mobile.unpair").await;
    assert!(
        matches!(unpaired, Message::Response { error: None, .. }),
        "{unpaired:?}"
    );
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match read_frame(&mut desktop).await {
                Ok(Some(_)) => {}
                _ => return,
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "the Mac's connection stayed open");
    let (_, r) = auth(&addr, json!({ "token": token })).await;
    assert!(unauthorized(&r), "{r:?}");
    let st: MobileStatus = app.request("mobile.status", json!({})).await.unwrap();
    assert!(st.devices.is_empty(), "{:?}", st.devices);

    // The app on this Mac is not a paired device.
    let e = app
        .request::<_, bool>("mobile.unpair", json!({}))
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), "invalid_params: not a paired device");
}

/// Where a `moonlet_link::Host`'s statuses go.
#[derive(Default)]
struct Statuses(std::sync::Mutex<Vec<moonlet_link::HostInfo>>);

impl moonlet_link::Events for Statuses {
    fn status(&self, info: &moonlet_link::HostInfo) {
        self.0.lock().unwrap().push(info.clone());
    }
    fn event(&self, _: &str, _: String, _: Value) {}
}

impl Statuses {
    async fn wait_for(&self, status: moonlet_link::HostStatus) -> moonlet_link::HostInfo {
        for _ in 0..500 {
            if let Some(i) = self.0.lock().unwrap().last()
                && i.status == status
            {
                return i.clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("never {status:?}: {:?}", self.0.lock().unwrap().last());
    }
}

#[tokio::test]
async fn a_mac_pairs_and_connects_through_the_shared_tailnet_connector() {
    use moonlet_link::tailnet::{TailnetConnector, pair};
    use moonlet_link::{Host, HostOptions, HostStatus};

    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let mut app = mac.app().await;
    let p: MobilePairing = app.request("mobile.pair_start", json!({ "kind": "desktop" })).await.unwrap();
    let paired = pair(
        std::slice::from_ref(&addr),
        &p.code,
        "Alex's MacBook Pro",
        moonlet_proto::methods::DeviceKind::Desktop,
    )
    .await
    .unwrap();
    assert_eq!(paired.host.as_deref(), Some(p.host.as_str()));

    let statuses = Arc::new(Statuses::default());
    let host = Host::start(
        HostOptions {
            id: "studio-mini".into(),
            label: "studio-mini".into(),
            remote: true,
            client: "moonlet-app".into(),
        },
        Arc::new(TailnetConnector {
            addrs: vec![addr],
            token: paired.token,
            route: None,
        }),
        statuses.clone(),
        tokio::runtime::Handle::current(),
    );
    statuses.wait_for(HostStatus::Connected).await;

    // Removed on the host: the link ends, and the app waits for the user.
    let _: bool = app
        .request("mobile.revoke", json!({ "id": paired.device_id }))
        .await
        .unwrap();
    let refused = statuses.wait_for(HostStatus::Refused).await;
    assert_eq!(
        refused.message.as_deref(),
        Some("this phone is not paired with this Mac")
    );
    let seen = statuses.0.lock().unwrap().len();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(statuses.0.lock().unwrap().len(), seen, "it tried again");
    host.stop();
}

#[tokio::test]
async fn phones_route_only_to_ssh_hosts() {
    let mac = Mac::start(None).await;
    std::fs::write(
        mac.home.path().join("app-hosts.json"),
        json!({
            "remotes": ["devbox"],
            "tailnet": [{ "id": "studio-mini", "device_id": "d1", "addrs": ["100.101.102.103:47428"], "token": "tok" }],
        })
        .to_string(),
    )
    .unwrap();
    let mut app = mac.app().await;
    let hosts: Value = app.request("mobile.hosts", json!({})).await.unwrap();
    assert_eq!(hosts, json!([{ "id": "devbox", "label": "devbox" }]));
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
async fn turning_access_off_ends_the_pairing() {
    let mac = Mac::start(None).await;
    mac.allow_phones().await;
    let mut app = mac.app().await;
    let _: MobilePairing = app.request("mobile.pair_start", json!({})).await.unwrap();
    let _: MobileStatus = app
        .request("mobile.set_enabled", json!({ "enabled": false }))
        .await
        .unwrap();
    let reason = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match app.next_frame().await.unwrap() {
                Some(Frame::Json(Message::Event { name, data })) if name == "mobile.pair_ended" => {
                    return data["reason"].clone();
                }
                Some(_) => {}
                None => panic!("app connection closed"),
            }
        }
    })
    .await
    .expect("no mobile.pair_ended");
    assert_eq!(reason, "cancelled");
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
    // Nor point the host's worker link elsewhere (X41, X61).
    for (id, method) in [(5, "link.set"), (6, "link.retry"), (7, "link.pair")] {
        let Message::Response { error: Some(e), .. } = call(&mut phone, id, method).await else {
            panic!("{method} worked through a route")
        };
        assert_eq!(e.message, "manage the link from the Mac", "{method}");
    }
    // Nor change the host's cloud workers (X63) or approve its heavy commands
    // (X62): the host would take the phone for the Mac's app.
    let Message::Response { error: Some(e), .. } = call(&mut phone, 8, "cloud.set").await else {
        panic!("cloud.set worked through a route")
    };
    assert_eq!(e.message, "change cloud workers from the Mac");
    let Message::Response { error: Some(e), .. } = call(&mut phone, 9, "heavy.approve").await else {
        panic!("heavy.approve worked through a route")
    };
    assert_eq!(e.message, "approve heavy commands from the Mac");
    // Nor update the host (X69): the host would take the phone for the app.
    let Message::Response { error: Some(e), .. } = call(&mut phone, 12, "daemon.update").await else {
        panic!("daemon.update worked through a route")
    };
    assert_eq!(e.message, "update moonlet from a Mac");

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

/// Design systems are the Mac's (X64): a paired phone may not list, change or
/// remove them.
#[tokio::test]
async fn phones_cannot_reach_design_systems() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone, "moonlet-mobile").await;
    // Nor can a phone say it renders cards, and be sent them (X64).
    for (id, method) in [(1, "design.systems"), (2, "design.system.remove"), (3, "design.settle"), (4, "design.render.ready")] {
        let Message::Response { error: Some(e), .. } = call(&mut phone, id, method).await else {
            panic!("{method} worked from a phone")
        };
        assert_eq!((e.code.as_str(), e.message.as_str()), ("forbidden", "manage design systems from the Mac"), "{method}");
    }
}

/// Design systems stay on the Mac (X64): a paired phone hears nothing of
/// their files changing, while the Mac's own app does.
#[tokio::test]
async fn phones_do_not_hear_design_changes() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone, "moonlet-mobile").await;
    let mut app = Client::connect(&mac.socket, "test").await.unwrap();

    let card = mac.home.path().join("design/w1/systems/storefront/components/buttons/button/button.html");
    std::fs::create_dir_all(card.parent().unwrap()).unwrap();
    std::fs::write(&card, "<!-- @dsCard group=\"Buttons\" -->\n").unwrap();

    // The app hears it.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let f = tokio::time::timeout_at(deadline, app.next_frame()).await.expect("the app heard no design.changed").unwrap().unwrap();
        if let Frame::Json(Message::Event { name, .. }) = f
            && name == "design.changed"
        {
            break;
        }
    }
    // The phone does not, within the next few seconds.
    let until = tokio::time::Instant::now() + Duration::from_secs(3);
    while let Ok(Some(m)) = tokio::time::timeout_at(until, next_json(&mut phone)).await {
        if let Message::Event { name, .. } = &m {
            assert_ne!(name, "design.changed", "a phone heard a design change");
        }
    }
}

/// Designs stay on the Mac (X65): a paired phone does not hear `design.open`,
/// with the design's workspace, name and agent, while the Mac's own app does.
#[tokio::test]
async fn phones_do_not_hear_a_design_opened() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone, "moonlet-mobile").await;
    let mut app = Client::connect(&mac.socket, "test").await.unwrap();
    let ws: Value = app.request("workspace.create", json!({"name": "1devstudio", "color": "clay"})).await.unwrap();
    let ws = ws["id"].as_str().unwrap().to_string();
    let design = mac.home.path().join("design").join(&ws).join("designs/settings-page");
    std::fs::create_dir_all(&design).unwrap();
    std::fs::write(design.join("design.toml"), "name = \"Settings page\"\nsystem = \"moonlet-desktop\"\n").unwrap();

    let _: bool = app.request("design.open", json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    // The app hears it.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let f = tokio::time::timeout_at(deadline, app.next_frame()).await.expect("the app heard no design.open").unwrap().unwrap();
        if let Frame::Json(Message::Event { name, .. }) = f
            && name == "design.open"
        {
            break;
        }
    }
    // The phone does not, within the next few seconds.
    let until = tokio::time::Instant::now() + Duration::from_secs(3);
    while let Ok(Some(m)) = tokio::time::timeout_at(until, next_json(&mut phone)).await {
        if let Message::Event { name, .. } = &m {
            assert_ne!(name, "design.open", "a phone heard a design opened");
        }
    }
}
