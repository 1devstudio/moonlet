//! The phone's connections against a fake Mac on loopback: pairing, the
//! token on every later connection, and the SSH hosts routed through it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use moonlet_link::HostStatus;
use moonlet_mobile_lib::macs::{self, HostEntry, MemoryTokens, Phone, SavedMac, Sink, Tokens};
use moonlet_proto::{Frame, Message, RpcError, read_frame, write_frame};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};

/// What the fake Mac saw: each connection's `auth`.
type Seen = Arc<Mutex<Vec<Message>>>;

/// A daemon that pairs code "c0de" as device "d1" with token "tok", accepts
/// that token (with or without a route), and answers a few methods.
async fn fake_mac() -> (String, Seen) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap().to_string();
    let seen: Seen = Arc::default();
    let s2 = seen.clone();
    tokio::spawn(async move {
        loop {
            let (stream, _) = l.accept().await.unwrap();
            tokio::spawn(serve(stream, s2.clone()));
        }
    });
    (addr, seen)
}

async fn serve(mut s: TcpStream, seen: Seen) {
    let Ok(Some(Frame::Json(auth))) = read_frame(&mut s).await else {
        return;
    };
    seen.lock().unwrap().push(auth.clone());
    let reply = match &auth {
        Message::Auth { pair: Some(c), .. } if c == "c0de" => Message::Authed {
            device_id: "d1".into(),
            token: Some("tok".into()),
            // A daemon from before X57.
            protocol: None,
            daemon_version: None,
            host: None,
        },
        Message::Auth { token: Some(t), .. } if t == "tok" => Message::Authed {
            device_id: "d1".into(),
            token: None,
            // A daemon from before X57.
            protocol: None,
            daemon_version: None,
            host: None,
        },
        _ => Message::err(
            0,
            RpcError::new("unauthorized", "this phone is not paired with this Mac"),
        ),
    };
    let ok = matches!(reply, Message::Authed { .. });
    write_frame(&mut s, &Frame::Json(reply)).await.unwrap();
    if !ok {
        return;
    }
    let routed = matches!(&auth, Message::Auth { route: Some(_), .. });
    while let Ok(Some(frame)) = read_frame(&mut s).await {
        let reply = match frame {
            Frame::Json(Message::Hello { protocol, .. }) => Message::Welcome {
                protocol,
                daemon_version: "0.1.16".into(),
                host: if routed {
                    "devbox".into()
                } else {
                    "studio-mac".into()
                },
                pid: 1,
            },
            Frame::Json(Message::Request { id, method, .. }) => match method.as_str() {
                "daemon.info" => Message::ok(id, json!({ "home": "/Users/alex" })),
                "mobile.hosts" if !routed => {
                    Message::ok(id, json!([{ "id": "devbox", "label": "devbox" }]))
                }
                _ => Message::ok(id, Value::Null),
            },
            _ => continue,
        };
        if write_frame(&mut s, &Frame::Json(reply)).await.is_err() {
            return;
        }
    }
}

#[derive(Default)]
struct Statuses(Mutex<Vec<(String, HostStatus)>>);

struct Rec(Arc<Statuses>);

impl Sink for Rec {
    fn status(&self, e: &HostEntry) {
        self.0
            .0
            .lock()
            .unwrap()
            .push((e.info.id.clone(), e.info.status.clone()));
    }
    fn event(&self, _: &str, _: String, _: Value) {}
}

async fn eventually(what: &str, mut ok: impl FnMut() -> bool) {
    for _ in 0..300 {
        if ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{what} never happened");
}

#[tokio::test]
async fn pairing_keeps_the_token_and_skips_a_dead_address() {
    let (addr, seen) = fake_mac().await;
    // Nothing listens on port 9 of loopback: the next address is tried.
    let mac = macs::pair(
        "studio-mac",
        vec!["127.0.0.1:9".into(), addr.clone()],
        "c0de",
        "Alex's iPhone",
    )
    .await
    .unwrap();
    assert_eq!(
        mac,
        SavedMac {
            id: "d1".into(),
            name: "studio-mac".into(),
            addrs: vec!["127.0.0.1:9".into(), addr],
            token: "tok".into()
        }
    );
    let auth = seen.lock().unwrap()[0].clone();
    assert_eq!(
        auth,
        Message::Auth {
            token: None,
            pair: Some("c0de".into()),
            device: Some("Alex's iPhone".into()),
            route: None,
            // Says what pairs (X57).
            kind: Some(moonlet_proto::methods::DeviceKind::Phone)
        }
    );
}

#[tokio::test]
async fn a_wrong_code_fails_with_the_macs_message() {
    let (addr, _) = fake_mac().await;
    let e = macs::pair("studio-mac", vec![addr], "nope", "iPhone")
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), "this phone is not paired with this Mac");
}

#[tokio::test]
async fn a_paired_mac_connects_with_its_token_and_brings_its_ssh_hosts() {
    let (addr, seen) = fake_mac().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("macs.json");
    let statuses = Arc::new(Statuses::default());
    let tokens = Arc::new(MemoryTokens::default());
    let phone = Phone::start(
        file.clone(),
        tokens.clone(),
        Rec(statuses.clone()),
        tokio::runtime::Handle::current(),
    );
    phone
        .add(SavedMac {
            id: "d1".into(),
            name: "studio-mac".into(),
            addrs: vec![addr],
            token: "tok".into(),
        })
        .unwrap();

    eventually("both hosts connected", || {
        let l = phone.list();
        l.len() == 2 && l.iter().all(|h| h.info.status == HostStatus::Connected)
    })
    .await;
    let list = phone.list();
    assert_eq!(
        (
            list[0].info.id.as_str(),
            list[0].info.label.as_str(),
            list[0].via.as_deref()
        ),
        ("d1", "studio-mac", None)
    );
    assert_eq!(
        (
            list[1].info.id.as_str(),
            list[1].info.label.as_str(),
            list[1].via.as_deref()
        ),
        ("d1/devbox", "devbox", Some("studio-mac"))
    );
    assert!(list[1].info.remote);
    assert_eq!(list[1].mac, "d1");

    // Every connection used the token; the routed one named its host.
    let auths = seen.lock().unwrap().clone();
    assert!(auths.contains(&Message::Auth {
        token: Some("tok".into()),
        pair: None,
        device: None,
        route: None,
        kind: None
    }));
    assert!(auths.contains(&Message::Auth {
        token: Some("tok".into()),
        pair: None,
        device: None,
        route: Some("devbox".into()),
        kind: None
    }));
    assert!(
        statuses
            .0
            .lock()
            .unwrap()
            .contains(&("d1/devbox".to_string(), HostStatus::Connected))
    );

    // The Mac is kept for the next start: its name and addresses in the
    // app's file, which only this user can read, and the token apart.
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(!text.contains("tok"), "the token is not in {text}");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(tokens.get("d1").as_deref(), Some("tok"));

    // A new start connects with the stored token.
    let again = Phone::start(
        file.clone(),
        tokens.clone(),
        Rec(Arc::default()),
        tokio::runtime::Handle::current(),
    );
    eventually("the Mac again", || {
        again
            .entry("d1")
            .is_some_and(|e| e.info.status == HostStatus::Connected)
    })
    .await;
    again.forget("d1");

    phone.forget("d1");
    assert!(phone.list().is_empty());
    let saved: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert!(saved.is_empty());
    assert_eq!(tokens.get("d1"), None);
}

#[tokio::test]
async fn requests_reach_the_mac_through_the_host() {
    let (addr, _) = fake_mac().await;
    let dir = tempfile::tempdir().unwrap();
    let phone = Phone::start(
        dir.path().join("macs.json"),
        Arc::new(MemoryTokens::default()),
        Rec(Arc::default()),
        tokio::runtime::Handle::current(),
    );
    phone
        .add(SavedMac {
            id: "d1".into(),
            name: "studio-mac".into(),
            addrs: vec![addr],
            token: "tok".into(),
        })
        .unwrap();
    eventually("connected", || {
        phone
            .entry("d1")
            .is_some_and(|e| e.info.status == HostStatus::Connected)
    })
    .await;
    let info = phone
        .get("d1")
        .unwrap()
        .request("daemon.info", Value::Null)
        .await
        .unwrap();
    assert_eq!(info, json!({ "home": "/Users/alex" }));
}

/// Against the real Keychain, under a throwaway service; run by hand with
/// `cargo test -p moonlet-mobile -- --ignored`.
#[cfg(target_os = "macos")]
#[test]
#[ignore]
fn the_keychain_keeps_and_forgets_a_token() {
    let k = macs::Keychain {
        service: format!(
            "dev.onedevstudio.moonlet.mobile.test-{}",
            std::process::id()
        ),
    };
    assert_eq!(k.get("d1"), None);
    k.set("d1", "tok").unwrap();
    k.set("d1", "tok2").unwrap();
    assert_eq!(k.get("d1").as_deref(), Some("tok2"));
    k.delete("d1");
    assert_eq!(k.get("d1"), None);
}
