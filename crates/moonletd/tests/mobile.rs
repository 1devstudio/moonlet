//! X39: phones pair with a code, come back with a device token, lose access
//! when removed, and reach the Mac's SSH hosts through it. The daemon listens
//! on 127.0.0.1 here (`MOONLET_MOBILE_ADDRS`) instead of a Tailscale address.

mod common;
use common::logs::KeepLogs;

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
    env: Vec<(String, String)>,
    child: Child,
}

impl Mac {
    /// A daemon with phone access configured on an ephemeral port, and
    /// `path` first on its login shell's PATH (for a fake `ssh`).
    async fn start(path: Option<&Path>) -> Mac {
        Mac::start_with(path, &[]).await
    }

    /// [`Self::start`] with more of the daemon's environment; an empty value
    /// leaves that variable out.
    async fn start_with(path: Option<&Path>, env: &[(&str, &str)]) -> Mac {
        let env: Vec<(String, String)> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("mobile.json"),
            r#"{ "enabled": false, "port": 0 }"#,
        )
        .unwrap();
        let socket = home.path().join("run").join("d.sock");
        let child = Mac::spawn(home.path(), &socket, path, &env).await;
        Mac {
            home,
            socket,
            path: path.map(Path::to_path_buf),
            env,
            child,
        }
    }

    async fn spawn(home: &Path, socket: &Path, path: Option<&Path>, env: &[(String, String)]) -> Child {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_moonletd"));
        cmd.arg("daemon")
            .env("MOONLET_TEST_APP_EXE", std::env::current_exe().unwrap())
            .env("MOONLET_EXIT_WITH", std::process::id().to_string())
            .env("MOONLET_HOME", home)
            .env("MOONLET_SOCK", socket)
            .env("MOONLET_MOBILE_ADDRS", "127.0.0.1")
            // A task request no app answers fails within the test (X76).
            .env("MOONLET_TASKS_REQUEST_TIMEOUT_MS", "1500")
            // Never the real `tailscale` (X39).
            .env("MOONLET_TAILSCALE", "/nonexistent/tailscale")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .keep_logs(home);
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
        for (k, v) in env {
            if v.is_empty() {
                cmd.env_remove(k);
            } else {
                cmd.env(k, v);
            }
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
        self.child = Mac::spawn(self.home.path(), &self.socket, self.path.as_deref(), &self.env).await;
    }

    async fn app(&self) -> Client {
        Client::connect_app(&self.socket, self.home.path()).await.unwrap()
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
            app_token: None,
        }),
    )
    .await
    .unwrap();
    next_json(s).await
}

async fn call(s: &mut TcpStream, id: u64, method: &str) -> Message {
    call_with(s, id, method, json!({})).await
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

/// Only the host itself may stop or swap its daemon: a paired phone or Mac
/// over the tailnet could otherwise end every session there, or make it run
/// any program on that machine.
#[tokio::test]
async fn paired_devices_cannot_stop_or_upgrade_the_daemon() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let mut app = mac.app().await;
    let phone_token = mac.pair(&addr).await;
    let p: MobilePairing = app.request("mobile.pair_start", json!({ "kind": "desktop" })).await.unwrap();
    let (_, reply) = auth(
        &addr,
        json!({ "pair": p.code, "device": "Alex's MacBook Pro", "kind": "desktop" }),
    )
    .await;
    let Some(Message::Authed {
        token: Some(desktop_token),
        ..
    }) = reply
    else {
        panic!("{reply:?}")
    };
    let before: DaemonInfo = app.request("daemon.info", json!({})).await.unwrap();

    // A phone is refused both as it is everything the phone app does not
    // send (X40); a paired Mac, by the methods themselves.
    for (token, client, upgrading, stopping) in [
        (&phone_token, "moonlet-mobile", "a phone does not do that", "a phone does not do that"),
        (&desktop_token, "moonlet-app", "upgrade moonletd on its own machine", "stop moonletd on its own machine"),
    ] {
        let (mut device, _) = auth(&addr, json!({ "token": token })).await;
        hello(&mut device, client).await;
        let upgrade = call_with(&mut device, 1, "daemon.upgrade", json!({ "binary": "/nonexistent/moonletd" })).await;
        let Message::Response { error: Some(e), .. } = upgrade else {
            panic!("daemon.upgrade worked from {client}: {upgrade:?}")
        };
        assert_eq!((e.code.as_str(), e.message.as_str()), ("forbidden", upgrading));
        let shutdown = call(&mut device, 2, "daemon.shutdown").await;
        let Message::Response { error: Some(e), .. } = shutdown else {
            panic!("daemon.shutdown worked from {client}: {shutdown:?}")
        };
        assert_eq!((e.code.as_str(), e.message.as_str()), ("forbidden", stopping));
    }

    // The same daemon still serves.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let after: DaemonInfo = app.request("daemon.info", json!({})).await.unwrap();
    assert_eq!(after.pid, before.pid);
}

/// X109: the Mac's app updates Claude Code on a host over the tailnet, as
/// X36 does on its own daemon, and sees the run's lines and end; a phone
/// may do neither.
#[tokio::test]
async fn a_paired_mac_updates_claude_code_on_its_host_but_a_phone_may_not() {
    use std::os::unix::fs::PermissionsExt;
    let bin = tempfile::tempdir().unwrap();
    let fake = bin.path().join("claude");
    // The lines `claude update` 2.1.292 prints for a native install.
    std::fs::write(
        &fake,
        r#"#!/bin/sh
case "$1" in
  --version) echo "2.1.292 (Claude Code)" ;;
  update)
    echo "Current version: 2.1.292"
    echo "Checking for updates to latest version..."
    echo "Updating to 2.1.296..."
    echo "Successfully updated from 2.1.292 to version 2.1.296"
    ;;
esac
"#,
    )
    .unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mac = Mac::start(Some(bin.path())).await;
    let addr = mac.allow_phones().await;
    let phone_token = mac.pair(&addr).await;
    let mut app = mac.app().await;
    let p: MobilePairing = app.request("mobile.pair_start", json!({ "kind": "desktop" })).await.unwrap();
    let (_, reply) = auth(&addr, json!({ "pair": p.code, "device": "Alex's MacBook Pro", "kind": "desktop" })).await;
    let Some(Message::Authed { token: Some(desktop_token), .. }) = reply else { panic!("{reply:?}") };

    let (mut phone, _) = auth(&addr, json!({ "token": phone_token })).await;
    hello(&mut phone, "moonlet-mobile").await;
    for (id, method) in [(1, "claude.version"), (2, "claude.update")] {
        let Message::Response { error: Some(e), .. } = call(&mut phone, id, method).await else {
            panic!("{method} worked from a phone")
        };
        assert_eq!((e.code.as_str(), e.message.as_str()), ("forbidden", "a phone does not do that"), "{method}");
    }

    let (mut other, _) = auth(&addr, json!({ "token": desktop_token })).await;
    hello(&mut other, "moonlet-app").await;
    let Message::Response { result: Some(version), error: None, .. } = call(&mut other, 1, "claude.version").await else {
        panic!("claude.version failed from a Mac")
    };
    assert_eq!(version, json!({ "version": "2.1.292", "updating": false }));

    // A second window of the same Mac watches the run it did not start.
    let (mut watcher, _) = auth(&addr, json!({ "token": desktop_token })).await;
    hello(&mut watcher, "moonlet-app").await;
    let expected = json!({
        "ok": true,
        "output": "Current version: 2.1.292\nChecking for updates to latest version...\nUpdating to 2.1.296...\nSuccessfully updated from 2.1.292 to version 2.1.296\n"
    });
    let Message::Response { result: Some(run), error: None, .. } = call(&mut other, 2, "claude.update").await else {
        panic!("claude.update failed from a Mac")
    };
    assert_eq!(run, expected);
    assert_eq!(phone_event(&mut watcher, "claude.update_output").await, json!({ "line": "Current version: 2.1.292" }));
    assert_eq!(phone_event(&mut watcher, "claude.update_done").await, expected);
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

/// A fake `tailscale` in `dir` whose `status --json` prints `dir/status.json`,
/// which starts as `status`. Returns its path.
fn fake_tailscale(dir: &Path, status: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(dir.join("status.json"), status).unwrap();
    let path = dir.join("tailscale");
    // The status file sits beside the stub, so no path needs quoting.
    std::fs::write(
        &path,
        "#!/bin/sh\n[ \"$1 $2\" = \"status --json\" ] || exit 2\ncat \"$(dirname \"$0\")/status.json\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.display().to_string()
}

/// `tailscale status --json` while Tailscale runs, cut down to what the
/// daemon reads. The field names are Tailscale's (`ipnstate.Status`); the
/// names and addresses are made up.
fn running(own: &str, peers: &[&str]) -> String {
    let peers: Vec<String> = peers
        .iter()
        .enumerate()
        .map(|(i, ip)| format!(r#""nodekey:{i:04x}": {{ "HostName": "device-{i}", "TailscaleIPs": ["{ip}"], "Online": true }}"#))
        .collect();
    format!(
        r#"{{ "BackendState": "Running", "TailscaleIPs": ["{own}"],
             "Self": {{ "HostName": "studio-mini", "TailscaleIPs": ["{own}"] }},
             "Peer": {{ {} }} }}"#,
        peers.join(", ")
    )
}

/// Whether the daemon closes `s` within `limit` without sending anything.
async fn closed_within(s: &mut TcpStream, limit: Duration) -> bool {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 64];
    match tokio::time::timeout(limit, s.read(&mut buf)).await {
        Ok(Ok(0)) | Ok(Err(_)) => true,
        Ok(Ok(_)) | Err(_) => false,
    }
}

#[tokio::test]
async fn a_peer_tailscale_does_not_list_is_closed_before_its_first_frame() {
    let dir = tempfile::tempdir().unwrap();
    let tailscale = fake_tailscale(dir.path(), &running("100.101.102.103", &["100.88.1.20"]));
    // The daemon takes every connection as coming from 100.100.20.30: in
    // 100.64.0.0/10, as a phone tether's or a carrier's address can be, but
    // no device of this tailnet.
    let mac = Mac::start_with(None, &[("MOONLET_TAILSCALE", &tailscale), ("MOONLET_TEST_PEER_ADDR", "100.100.20.30")]).await;
    let addr = mac.allow_phones().await;
    let mut app = mac.app().await;
    let p: MobilePairing = app.request("mobile.pair_start", json!({})).await.unwrap();

    let mut s = TcpStream::connect(&addr).await.unwrap();
    let auth = Message::Auth { token: None, pair: Some(p.code.clone()), device: Some("Tether".into()), route: None, kind: None };
    let _ = write_frame(&mut s, &Frame::Json(auth)).await;
    assert!(closed_within(&mut s, Duration::from_secs(3)).await, "a peer off the tailnet was answered");
    // Its code was never read: nothing paired.
    let st: MobileStatus = app.request("mobile.status", json!({})).await.unwrap();
    assert!(st.devices.is_empty(), "{:?}", st.devices);
}

#[tokio::test]
async fn a_peer_tailscale_lists_pairs() {
    let dir = tempfile::tempdir().unwrap();
    let tailscale = fake_tailscale(dir.path(), &running("100.101.102.103", &["100.88.1.20"]));
    let mac = Mac::start_with(None, &[("MOONLET_TAILSCALE", &tailscale), ("MOONLET_TEST_PEER_ADDR", "100.88.1.20")]).await;
    let addr = mac.allow_phones().await;
    assert_eq!(mac.pair(&addr).await.len(), 64);
}

#[tokio::test]
async fn a_device_that_joins_the_tailnet_later_is_let_in_without_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let tailscale = fake_tailscale(dir.path(), &running("100.101.102.103", &[]));
    let mac = Mac::start_with(None, &[("MOONLET_TAILSCALE", &tailscale), ("MOONLET_TEST_PEER_ADDR", "100.88.1.20")]).await;
    let addr = mac.allow_phones().await;
    let mut s = TcpStream::connect(&addr).await.unwrap();
    assert!(closed_within(&mut s, Duration::from_secs(3)).await, "a peer not yet on the tailnet was let in");
    // The phone joins the tailnet. The daemon asks Tailscale again for a
    // peer it does not know, at most every 2 seconds.
    std::fs::write(dir.path().join("status.json"), running("100.101.102.103", &["100.88.1.20"])).unwrap();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(mac.pair(&addr).await.len(), 64);
}

/// Turns access on and returns the status once Tailscale was asked (it
/// says "Starting…" until then), within 10 seconds.
async fn status_once_asked(mac: &Mac) -> MobileStatus {
    let mut app = mac.app().await;
    let _: MobileStatus = app.request("mobile.set_enabled", json!({ "enabled": true })).await.unwrap();
    let mut st: MobileStatus = app.request("mobile.status", json!({})).await.unwrap();
    for _ in 0..200 {
        if !st.tailscale || !st.listening.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        st = app.request("mobile.status", json!({})).await.unwrap();
    }
    // Nothing binds later either.
    tokio::time::sleep(Duration::from_millis(500)).await;
    app.request("mobile.status", json!({})).await.unwrap()
}

#[tokio::test]
async fn without_tailscale_running_nothing_listens() {
    let dir = tempfile::tempdir().unwrap();
    let stopped = running("100.101.102.103", &["100.88.1.20"]).replace(r#""Running""#, r#""Stopped""#);
    let tailscale = fake_tailscale(dir.path(), &stopped);
    let mac = Mac::start_with(None, &[("MOONLET_MOBILE_ADDRS", ""), ("MOONLET_TAILSCALE", &tailscale)]).await;
    let st = status_once_asked(&mac).await;
    assert_eq!((st.tailscale, st.tailscale_missing, st.listening.len()), (false, false, 0), "{st:?}");
}

#[tokio::test]
async fn without_the_tailscale_command_nothing_listens_and_settings_says_so() {
    let mac = Mac::start_with(None, &[("MOONLET_MOBILE_ADDRS", ""), ("MOONLET_TAILSCALE", "/nonexistent/tailscale")]).await;
    let st = status_once_asked(&mac).await;
    assert_eq!((st.tailscale, st.tailscale_missing, st.listening.len()), (false, true, 0), "{st:?}");
}

#[tokio::test]
async fn only_an_address_tailscale_reports_is_listened_on() {
    // Tailscale reports an address no interface here has, so nothing
    // listens. On a machine with an interface in 100.64.0.0/10, the range
    // alone would have listened there; the unit test
    // `an_address_tailscale_does_not_report_is_not_listened_on` covers that
    // case on every machine.
    let dir = tempfile::tempdir().unwrap();
    let tailscale = fake_tailscale(dir.path(), &running("100.100.99.1", &[]));
    let mac = Mac::start_with(None, &[("MOONLET_MOBILE_ADDRS", ""), ("MOONLET_TAILSCALE", &tailscale)]).await;
    let st = status_once_asked(&mac).await;
    assert_eq!((st.tailscale, st.listening.len()), (false, 0), "{st:?}");
}

#[tokio::test]
async fn a_large_frame_before_auth_is_refused_at_once() {
    use tokio::io::AsyncWriteExt;
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let mut s = TcpStream::connect(&addr).await.unwrap();
    // A header announcing one byte over 64 KiB, and no body.
    s.write_all(&[0, 1, 0, 1]).await.unwrap();
    assert!(closed_within(&mut s, Duration::from_secs(3)).await, "the daemon waited for a 65 537-byte auth frame");
    // An auth of a normal size still works.
    assert_eq!(mac.pair(&addr).await.len(), 64);
}

#[tokio::test]
async fn only_32_connections_wait_for_auth_at_once() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let mut waiting = Vec::new();
    for _ in 0..32 {
        waiting.push(TcpStream::connect(&addr).await.unwrap());
    }
    // Let the daemon take all 32 before the next one.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut extra = TcpStream::connect(&addr).await.unwrap();
    assert!(closed_within(&mut extra, Duration::from_secs(3)).await, "a 33rd connection waited for auth");
    // The first 32 still wait.
    for (i, s) in waiting.iter_mut().enumerate() {
        assert!(!closed_within(s, Duration::from_millis(20)).await, "connection {i} was closed");
    }
    drop(waiting);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(mac.pair(&addr).await.len(), 64);
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
        assert_eq!(e.message, "a phone does not do that", "{method}");
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
        "forbidden: only the moonlet app does that"
    );

    // Nor can a phone say it is the CLI.
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    let r = hello(&mut phone, "moonlet-cli").await;
    assert!(
        matches!(&r, Some(Message::Response { error: Some(e), .. }) if e.code == "forbidden"),
        "{r:?}"
    );
}

/// Every method the phone app sends (X40, "What a phone may call"), but
/// `gh.whoami`, which runs the real `gh`.
const PHONE_APP_SENDS: &[&str] = &[
    "daemon.info", "mobile.hosts", "account.get", "workspace.list", "workspace.merge", "profile.list",
    "project.list", "project.config", "section.list", "session.list", "sync.list", "git.settings",
    "claude.models", "presence.active", "session.create", "session.update", "session.archive",
    "session.continue_here", "session.forward", "session.attach", "session.detach", "chat.summaries",
    "chat.state", "chat.send", "chat.send_now", "chat.unqueue", "chat.interrupt", "chat.permission",
    "chat.aside", "chat.stop_agent", "chat.settings", "terminal.list", "terminal.create",
    "terminal.attach", "terminal.detach", "terminal.read_requests", "terminal.read_answer",
    "git.status", "git.base_status", "git.diff", "git.log", "git.stage", "git.unstage", "git.revert",
    "git.apply_patch", "git.commit", "git.branches", "git.pull_base", "git.unpushed", "git.push",
    "gh.prs", "gh.pr_context", "gh.pr_status", "gh.pr_stack", "gh.pr_create", "job.list",
    "job.stayed", "job.output", "job.stop", "job.stop_all", "job.run_here", "exec.setups",
    "sync.run_setup", "sync.skip_setup", "tasks.app", "tasks.snapshot", "tasks.request", "session.fork",
    "section.update",
];

#[tokio::test]
async fn a_phone_reaches_only_what_the_phone_app_sends() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone, "moonlet-mobile").await;

    // What the app sends gets through to the method itself, which may
    // still refuse params given as null.
    for (id, method) in (1..).zip(PHONE_APP_SENDS) {
        let reply = call_with(&mut phone, id, method, Value::Null).await;
        if let Message::Response { error: Some(e), .. } = &reply {
            assert_ne!(e.message, "a phone does not do that", "{method}");
            assert_ne!(e.code, "unknown_method", "{method}");
        }
    }
    // Anything else is refused before it runs, a method the daemon does not
    // know yet included: one added later is a phone's only once listed.
    let heavy = json!({ "project": mac.home.path(), "heavy": ["sh"] });
    for (id, method, params) in [
        (100, "heavy.set", heavy),
        (101, "git.set_settings", json!({ "push_on_commit": true })),
        (102, "link.join", json!({ "central": { "name": "elsewhere", "addrs": ["100.64.0.99:7655"], "token": "t" } })),
        (103, "session.move", json!({ "session": "s", "to": "w" })),
        (104, "worker.settings.set", json!({ "worker": "w", "heavy": true })),
        (105, "phone.added_later", json!({})),
    ] {
        let Message::Response { error: Some(e), .. } = call_with(&mut phone, id, method, params).await else {
            panic!("{method} worked from a phone")
        };
        assert_eq!((e.code.as_str(), e.message.as_str()), ("forbidden", "a phone does not do that"), "{method}");
    }
    // The app on the same Mac still may.
    let mut app = mac.app().await;
    let e = app.request::<_, Value>("phone.added_later", json!({})).await.unwrap_err();
    assert!(e.to_string().starts_with("unknown_method"), "{e}");
}

/// A fake `ssh` that records its arguments and runs the host's `moonletd proxy` as an SSH session's
/// command: under a copy of this test binary named sshd, with
/// `SSH_CONNECTION` set, so the proxy vouches for the phone it carries
/// (X40, A6) as a real SSH login does.
fn fake_ssh(dir: &Path, remote_home: &Path, args_file: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let sshd = dir.join("sshd");
    std::fs::copy(std::env::current_exe().unwrap(), &sshd).unwrap();
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nunset MOONLET_SOCK\nSSH_CONNECTION='100.64.0.7 52814 100.64.0.9 22' MOONLET_EXIT_WITH='{}' MOONLET_HOME='{}' MOONLET_TEST_SSHD_EXE='{sshd}' MOBILE_TEST_AS_SSHD='--socket {} proxy' exec '{sshd}' --exact as_sshd_runs_moonletd --nocapture --test-threads=1 2>&1 1>/dev/null\n",
        args_file.display(),
        std::process::id(),
        remote_home.display(),
        remote_home.join("run").join("d.sock").display(),
        sshd = sshd.display(),
    );
    let ssh = dir.join("ssh");
    std::fs::write(&ssh, script).unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// What the copy of this test binary named sshd does (see [`fake_ssh`]):
/// runs `moonletd` with the arguments in `MOBILE_TEST_AS_SSHD` as sshd runs
/// an SSH session's command, its stdout on this process's stderr, since
/// the test harness writes to stdout. In a plain run it does nothing.
#[test]
fn as_sshd_runs_moonletd() {
    let Some(args) = std::env::var("MOBILE_TEST_AS_SSHD").ok() else {
        return;
    };
    let out = std::os::fd::AsFd::as_fd(&std::io::stderr()).try_clone_to_owned().unwrap();
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_moonletd"))
        .args(args.split(' '))
        .env_remove("MOBILE_TEST_AS_SSHD")
        .stdout(out)
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    std::process::exit(status.code().unwrap_or(1));
}

/// A fake `ssh` whose host is one from before hosts checked a routed
/// phone's requests: a copy of this test binary that plays it (see
/// [`as_an_older_host`]), writing down in `seen` every method it gets.
fn older_host_ssh(dir: &Path, seen: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let script = format!(
        "#!/bin/sh\nMOBILE_TEST_OLDER_HOST='{}' exec '{}' --exact as_an_older_host --nocapture --test-threads=1 2>&1 1>/dev/null\n",
        seen.display(),
        std::env::current_exe().unwrap().display(),
    );
    let ssh = dir.join("ssh");
    std::fs::write(&ssh, script).unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// What this test binary does as [`older_host_ssh`]'s host: it answers
/// `hello`, and takes every request, answering `true` and writing its
/// method down, frames in on stdin and out on stderr. In a plain run it
/// does nothing.
#[test]
fn as_an_older_host() {
    use std::io::Write;
    let Some(seen) = std::env::var_os("MOBILE_TEST_OLDER_HOST") else {
        return;
    };
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async move {
        let (mut input, mut out) = (tokio::io::stdin(), tokio::io::stderr());
        while let Ok(Some(Frame::Json(m))) = read_frame(&mut input).await {
            let reply = match m {
                Message::Hello { .. } => Message::Welcome { protocol: PROTOCOL_VERSION, daemon_version: "0.1.44".into(), host: "devbox".into(), pid: 1 },
                Message::Request { id, method, .. } => {
                    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&seen).unwrap();
                    writeln!(f, "{method}").unwrap();
                    Message::ok(id, true)
                }
                _ => continue,
            };
            if write_frame(&mut out, &Frame::Json(reply)).await.is_err() {
                break;
            }
        }
    });
    std::process::exit(0);
}

/// X40: the Mac answers itself a routed phone's requests that are not a
/// phone's, so a host from before that checks none still never gets them.
#[tokio::test]
async fn a_host_from_before_gets_only_a_phones_requests_through_the_mac() {
    let bin = tempfile::tempdir().unwrap();
    let seen = bin.path().join("seen");
    older_host_ssh(bin.path(), &seen);
    let mac = Mac::start(Some(bin.path())).await;
    std::fs::write(mac.home.path().join("app-hosts.json"), r#"{ "remotes": ["devbox"] }"#).unwrap();
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token, "route": "devbox" })).await;
    let welcome = hello(&mut phone, "moonlet-mobile").await;
    assert!(matches!(welcome, Some(Message::Welcome { .. })), "{welcome:?}");

    for (id, method) in [(1, "link.join"), (2, "signins.set"), (3, "session.move"), (4, "phone.added_later")] {
        let Message::Response { error: Some(e), .. } = call(&mut phone, id, method).await else {
            panic!("{method} reached the host")
        };
        assert_eq!((e.code.as_str(), e.message.as_str()), ("forbidden", "a phone does not do that"), "{method}");
    }
    let info = call(&mut phone, 5, "daemon.info").await;
    assert!(matches!(info, Message::Response { error: None, .. }), "{info:?}");
    assert_eq!(std::fs::read_to_string(&seen).unwrap(), "daemon.info\n");
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
    // Nor stop or swap the host's daemon.
    let Message::Response { error: Some(e), .. } =
        call_with(&mut phone, 10, "daemon.upgrade", json!({ "binary": "/nonexistent/moonletd" })).await
    else {
        panic!("daemon.upgrade worked through a route")
    };
    assert_eq!(e.message, "upgrade moonletd on its own machine");
    let Message::Response { error: Some(e), .. } = call(&mut phone, 11, "daemon.shutdown").await else {
        panic!("daemon.shutdown worked through a route")
    };
    assert_eq!(e.message, "stop moonletd on its own machine");
    // Nor anything else that is not a phone's (X40): joining the host to
    // another central host, its sign-ins, moving its sessions, its worker
    // settings, answering for it whether an agent may read a terminal, or
    // a method added later.
    for (id, method) in [
        (13, "link.join"),
        (14, "signins.approve"),
        (15, "signins.run"),
        (16, "session.move"),
        (17, "worker.settings.set"),
        (18, "phone.added_later"),
    ] {
        let Message::Response { error: Some(e), .. } = call(&mut phone, id, method).await else {
            panic!("{method} worked through a route")
        };
        assert_eq!((e.code.as_str(), e.message.as_str()), ("forbidden", "a phone does not do that"), "{method}");
    }
    let Message::Response { error: Some(e), .. } = call(&mut phone, 19, "terminal.read_answer").await else {
        panic!("terminal.read_answer worked through a route")
    };
    assert_eq!((e.code.as_str(), e.message.as_str()), ("forbidden", "only the moonlet app answers read requests"));

    // A phone that names itself the app on the host is still a phone there:
    // the Mac sends its hello as the phone's.
    let (mut posing, _) = auth(&addr, json!({ "token": token, "route": "devbox" })).await;
    hello(&mut posing, "moonlet-app").await;
    let entries = json!({ "entries": [{ "id": "t", "name": "t", "login": "true", "check": "true" }] });
    let Message::Response { error: Some(e), .. } = call_with(&mut posing, 1, "signins.set", entries).await else {
        panic!("a routed phone that said it was the app changed the host's sign-ins")
    };
    assert_eq!((e.code.as_str(), e.message.as_str()), ("forbidden", "a phone does not do that"));

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
        assert_eq!((e.code.as_str(), e.message.as_str()), ("forbidden", "a phone does not do that"), "{method}");
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
    let mut app = mac.app().await;

    let card = mac.home.path().join("design/library/systems/storefront/components/buttons/button/button.html");
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
    let mut app = mac.app().await;
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

/// A board snapshot as the app shares it (X76): the daemon keeps it whole.
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
    assert_eq!(e.message, "a phone does not do that");
    let mut cli = Client::connect(&mac.socket, "moonlet-cli").await.unwrap();
    let e = cli.request::<_, bool>("tasks.set_snapshot", json!({ "workspace": ws, "snapshot": board_snapshot() })).await.unwrap_err();
    assert_eq!(e.to_string(), "forbidden: only the moonlet app does that");

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
    assert_eq!(e.message, "a phone does not do that");

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

    // Only a paired phone asks: not an agent's CLI, nor a local client under another name, nor the app itself.
    for name in ["moonlet-cli", "anything-else", "moonlet-app"] {
        let mut c = Client::connect(&mac.socket, name).await.unwrap();
        let e = c.request::<_, Value>("tasks.request", json!({ "workspace": "personal", "action": {} })).await.unwrap_err();
        assert_eq!(e.to_string(), "forbidden: only the moonlet app does that", "{name}");
    }
}

#[tokio::test]
async fn one_app_takes_a_task_request_and_agents_cannot_answer_one() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone, "moonlet-mobile").await;
    let mut first = mac.app().await;
    let mut second = mac.app().await;
    // A client that only says it is something else is not the app.
    let mut other = Client::connect(&mac.socket, "moonletd-status").await.unwrap();

    let asking = tokio::spawn(async move { call_with(&mut phone, 1, "tasks.request", json!({ "workspace": "personal", "action": { "kind": "started" } })).await });
    let ev = app_event(&mut first, "tasks.request").await;
    // Only one app does it: two would create two issues.
    for c in [&mut second, &mut other] {
        let none = tokio::time::timeout(Duration::from_millis(500), app_event(c, "tasks.request")).await;
        assert!(none.is_err(), "another client got the request");
    }
    let mut cli = Client::connect(&mac.socket, "moonlet-cli").await.unwrap();
    let e = cli.request::<_, bool>("tasks.answer", json!({ "request_id": ev["request_id"], "ok": true })).await.unwrap_err();
    assert_eq!(e.to_string(), "forbidden: only the moonlet app does that");
    let e = other.request::<_, bool>("tasks.answer", json!({ "request_id": ev["request_id"], "ok": true })).await.unwrap_err();
    assert_eq!(e.to_string(), "forbidden: only the moonlet app does that");
    let _: bool = first.request("tasks.answer", json!({ "request_id": ev["request_id"], "ok": true, "result": {} })).await.unwrap();
    let Message::Response { error: None, .. } = asking.await.unwrap() else { panic!("not answered") };
}

/// A local process that only says it is moonlet-app, without the app's
/// credential (X75), is not the app for a phone's tasks (X76).
#[tokio::test]
async fn a_process_that_only_says_it_is_the_app_does_not_act_on_tasks() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone, "moonlet-mobile").await;
    let ws = personal_workspace(&mut mac.app().await).await;

    let mut forged = Client::connect(&mac.socket, "moonlet-app").await.unwrap();
    let e = forged.request::<_, bool>("tasks.set_snapshot", json!({ "workspace": ws, "snapshot": board_snapshot() })).await.unwrap_err();
    assert_eq!(e.to_string(), "forbidden: only the moonlet app does that");
    let e = forged.request::<_, bool>("tasks.answer", json!({ "request_id": 1, "ok": true })).await.unwrap_err();
    assert_eq!(e.to_string(), "forbidden: only the moonlet app does that");

    // Nor does it count as moonlet being open for the phone.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let Message::Response { result: Some(r), .. } = call_with(&mut phone, 1, "tasks.app", json!({})).await else { panic!("no answer") };
        if r == json!({ "open": false }) {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "moonlet counts as open with only the forged app: {r}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    drop(forged);
}

/// A phone hears whether moonlet is open on the Mac (X76): moves wait for it.
#[tokio::test]
async fn a_phone_hears_when_the_app_opens_and_closes() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone, "moonlet-mobile").await;

    // allow_phones' app connection has gone.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let Message::Response { result: Some(r), .. } = call_with(&mut phone, 1, "tasks.app", json!({})).await else { panic!("no answer") };
        if r == json!({ "open": false }) {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "the app never closed: {r}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let app = mac.app().await;
    assert_eq!(phone_event(&mut phone, "tasks.app").await, json!({ "open": true }));
    let Message::Response { result: Some(r), .. } = call_with(&mut phone, 2, "tasks.app", json!({})).await else { panic!("no answer") };
    assert_eq!(r, json!({ "open": true }));

    // A second app changes nothing; the last one leaving closes it.
    let second = mac.app().await;
    drop(app);
    drop(second);
    assert_eq!(phone_event(&mut phone, "tasks.app").await, json!({ "open": false }));
}

/// The desktop app reaching this daemon over the tailnet, paired as a Mac,
/// is an app too (X76): it shares boards and answers a phone's requests.
#[tokio::test]
async fn the_app_on_a_paired_mac_shares_boards_and_answers_over_the_tailnet() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone, "moonlet-mobile").await;
    let mut local = mac.app().await;
    let ws = personal_workspace(&mut local).await;
    let p: MobilePairing = local.request("mobile.pair_start", json!({ "kind": "desktop" })).await.unwrap();
    drop(local);
    let Some(Message::Authed { token: Some(desk), .. }) = auth(&addr, json!({ "pair": p.code, "device": "Alex's MacBook Pro", "kind": "desktop" })).await.1 else {
        panic!("no desktop pairing")
    };
    let (mut desktop, _) = auth(&addr, json!({ "token": desk })).await;
    hello(&mut desktop, "moonlet-app").await;

    let Message::Response { result: Some(r), error: None, .. } = call_with(&mut desktop, 1, "tasks.set_snapshot", json!({ "workspace": ws, "snapshot": board_snapshot() })).await else {
        panic!("the paired Mac's app could not share boards")
    };
    assert_eq!(r, json!(true));
    let Message::Response { result: Some(r), .. } = call_with(&mut phone, 2, "tasks.app", json!({})).await else { panic!("no answer") };
    assert_eq!(r, json!({ "open": true }));
}

/// Only the app a request went to answers it, and its leaving ends the
/// phone's wait at once instead of after the timeout (X76).
#[tokio::test]
async fn only_the_app_asked_answers_and_its_leaving_ends_the_wait() {
    let mac = Mac::start(None).await;
    let addr = mac.allow_phones().await;
    let token = mac.pair(&addr).await;
    let (mut phone, _) = auth(&addr, json!({ "token": token })).await;
    hello(&mut phone, "moonlet-mobile").await;
    let mut first = mac.app().await;
    let mut second = mac.app().await;

    let asking = tokio::spawn(async move {
        let started = std::time::Instant::now();
        let m = call_with(&mut phone, 1, "tasks.request", json!({ "workspace": "personal", "action": { "kind": "started" } })).await;
        (m, started.elapsed())
    });
    let ev = app_event(&mut first, "tasks.request").await;
    let e = second.request::<_, bool>("tasks.answer", json!({ "request_id": ev["request_id"], "ok": true })).await.unwrap_err();
    assert_eq!(e.to_string(), "forbidden: another app was asked");
    drop(first);
    let (m, took) = asking.await.unwrap();
    let Message::Response { error: Some(e), .. } = m else { panic!("answered") };
    assert_eq!(e.message, "moonlet on the Mac closed before it answered.");
    assert!(took < Duration::from_millis(1400), "waited {took:?}");
}

/// A workspace merged into another takes its boards along (X76).
#[tokio::test]
async fn a_merged_workspace_takes_its_boards_along() {
    let mac = Mac::start(None).await;
    let mut app = mac.app().await;
    let ws = personal_workspace(&mut app).await;
    let other: moonlet_proto::types::Workspace = app.request("workspace.create", json!({ "name": "Acme", "color": "clay" })).await.unwrap();
    let _: bool = app.request("tasks.set_snapshot", json!({ "workspace": other.id, "snapshot": board_snapshot() })).await.unwrap();
    let _: bool = app.request("workspace.merge", json!({ "id": other.id, "into": ws })).await.unwrap();
    let left: Value = app.request("tasks.snapshot", json!({})).await.unwrap();
    assert_eq!(left, json!([]));
    assert!(!mac.home.path().join("tasks").join(format!("{}.json", other.id)).exists());
}

/// Boards of a workspace gone by any way, such as another member's merge
/// (X68), are not served, and their file goes (X76).
#[tokio::test]
async fn boards_of_a_workspace_gone_another_way_are_not_served() {
    let mut mac = Mac::start(None).await;
    let dir = mac.home.path().join("tasks");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("gone.json"), board_snapshot().to_string()).unwrap();
    mac.restart().await;
    let mut app = mac.app().await;
    let left: Value = app.request("tasks.snapshot", json!({})).await.unwrap();
    assert_eq!(left, json!([]));
    assert!(!dir.join("gone.json").exists());
}

/// A board file that cannot be removed keeps its own boards, and hides no
/// other workspace's (X76).
#[tokio::test]
async fn an_undeletable_board_file_hides_no_other_boards() {
    use std::os::unix::fs::PermissionsExt;
    let mut mac = Mac::start(None).await;
    let dir = mac.home.path().join("tasks");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("gone.json"), board_snapshot().to_string()).unwrap();
    mac.restart().await;
    let mut app = mac.app().await;
    let ws = personal_workspace(&mut app).await;
    let _: bool = app.request("tasks.set_snapshot", json!({ "workspace": ws, "snapshot": board_snapshot() })).await.unwrap();
    // The folder is read only: gone.json cannot be removed.
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let r: Result<Value, _> = app.request("tasks.snapshot", json!({})).await;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let list = r.expect("tasks.snapshot failed");
    assert!(list.as_array().unwrap().iter().any(|s| s["workspace"] == json!(ws)), "{list}");
}

/// A board file over the 4 MB a daemon keeps, left by anything, is not
/// loaded at start, nor served (X76).
#[tokio::test]
async fn a_board_file_over_the_limit_is_not_loaded() {
    let mut mac = Mac::start(None).await;
    let mut app = mac.app().await;
    let ws = personal_workspace(&mut app).await;
    drop(app);
    let dir = mac.home.path().join("tasks");
    std::fs::create_dir_all(&dir).unwrap();
    let big = json!({ "version": 1, "boards": [], "pad": "x".repeat(5 * 1024 * 1024) });
    std::fs::write(dir.join(format!("{ws}.json")), big.to_string()).unwrap();
    mac.restart().await;
    let mut app = mac.app().await;
    let r: Value = app.request("tasks.snapshot", json!({})).await.unwrap();
    assert_eq!(r, json!([]));
}
