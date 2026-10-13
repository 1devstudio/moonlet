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
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_moonletd"));
        cmd.arg("daemon")
            .env("MOONLET_HOME", home.path())
            .env("MOONLET_SOCK", &socket)
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
                std::fs::write(home.path().join(rc), &first).unwrap();
            }
            cmd.env("HOME", home.path());
        }
        let child = cmd.spawn().unwrap();
        wait_for_socket(&socket, Duration::from_secs(15))
            .await
            .unwrap();
        Mac {
            home,
            socket,
            child,
        }
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
    let mac = Mac::start(None).await;
    let mut app = mac.app().await;
    let st: MobileStatus = app.request("mobile.status", json!({})).await.unwrap();
    assert!(!st.enabled);
    assert!(st.listening.is_empty());
    let e = app
        .request::<_, MobilePairing>("mobile.pair_start", json!({}))
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), "mobile_off: phone access is off");

    let addr = mac.allow_phones().await;
    let saved: Value = serde_json::from_str(
        &std::fs::read_to_string(mac.home.path().join("mobile.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(saved["enabled"], true);

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
