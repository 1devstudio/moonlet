//! The tailnet connector (X57) against a fake daemon on 127.0.0.1: pairing,
//! a daemon that speaks another protocol, and a token the daemon refuses.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use moonlet_link::tailnet::{TailnetConnector, pair};
use moonlet_link::{Events, Host, HostInfo, HostOptions, HostStatus};
use moonlet_proto::methods::DeviceKind;
use moonlet_proto::{Frame, Message, PROTOCOL_VERSION, RpcError, read_frame, write_frame};
use serde_json::Value;
use tokio::net::TcpListener;

/// How the fake daemon answers each `auth`.
#[derive(Clone, Copy)]
enum Answer {
    /// `authed` with this protocol and version 9.9.9, then a welcome.
    Authed(u32),
    Unauthorized,
}

/// A fake daemon; returns its address and every `auth` it got.
async fn fake_daemon(answer: Answer) -> (String, Arc<Mutex<Vec<Message>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = listener.accept().await.unwrap();
            let log = log.clone();
            tokio::spawn(async move {
                let Ok(Some(Frame::Json(auth))) = read_frame(&mut s).await else {
                    return;
                };
                let token = match &auth {
                    Message::Auth { pair: Some(_), .. } => Some("tok".to_string()),
                    _ => None,
                };
                log.lock().unwrap().push(auth);
                let reply = match answer {
                    Answer::Authed(protocol) => Message::Authed {
                        device_id: "d1".into(),
                        token,
                        protocol: Some(protocol),
                        daemon_version: Some("9.9.9".into()),
                        host: Some("studio-mini".into()),
                    },
                    Answer::Unauthorized => Message::err(
                        0,
                        RpcError::new("unauthorized", "this phone is not paired with this Mac"),
                    ),
                };
                write_frame(&mut s, &Frame::Json(reply)).await.unwrap();
                if let Ok(Some(Frame::Json(Message::Hello { .. }))) = read_frame(&mut s).await {
                    let welcome = Message::Welcome {
                        protocol: PROTOCOL_VERSION,
                        daemon_version: "9.9.9".into(),
                        host: "studio-mini".into(),
                        pid: 1,
                    };
                    write_frame(&mut s, &Frame::Json(welcome)).await.unwrap();
                    // Answer requests (the app asks for `daemon.info`) until
                    // the app goes.
                    while let Ok(Some(frame)) = read_frame(&mut s).await {
                        if let Frame::Json(Message::Request { id, .. }) = frame {
                            let reply =
                                Message::ok(id, serde_json::json!({ "home": "/home/alex" }));
                            write_frame(&mut s, &Frame::Json(reply)).await.unwrap();
                        }
                    }
                }
            });
        }
    });
    (addr, seen)
}

#[derive(Default)]
struct Seen(Mutex<Vec<HostInfo>>);

impl Events for Seen {
    fn status(&self, info: &HostInfo) {
        self.0.lock().unwrap().push(info.clone());
    }
    fn event(&self, _: &str, _: String, _: Value) {}
}

impl Seen {
    fn last(&self) -> Option<HostInfo> {
        self.0.lock().unwrap().last().cloned()
    }
}

fn connect(addr: &str) -> (Arc<Host>, Arc<Seen>) {
    let seen = Arc::new(Seen::default());
    let host = Host::start(
        HostOptions {
            id: "studio-mini".into(),
            label: "studio-mini".into(),
            remote: true,
            client: "moonlet-app".into(),
        },
        Arc::new(TailnetConnector {
            addrs: vec![addr.to_string()],
            token: "tok".into(),
            route: None,
        }),
        seen.clone(),
        tokio::runtime::Handle::current(),
    );
    (host, seen)
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
async fn pairing_returns_the_token_and_says_who_answered() {
    let (addr, seen) = fake_daemon(Answer::Authed(PROTOCOL_VERSION)).await;
    let paired = pair(
        &[addr],
        "7KQ2MX9PDA",
        "Alex's MacBook Pro",
        DeviceKind::Desktop,
    )
    .await
    .unwrap();
    assert_eq!(paired.device_id, "d1");
    assert_eq!(paired.token, "tok");
    assert_eq!(paired.daemon_version.as_deref(), Some("9.9.9"));
    assert_eq!(paired.host.as_deref(), Some("studio-mini"));
    assert_eq!(
        seen.lock().unwrap()[0],
        Message::Auth {
            token: None,
            pair: Some("7KQ2MX9PDA".into()),
            device: Some("Alex's MacBook Pro".into()),
            route: None,
            kind: Some(DeviceKind::Desktop),
        }
    );
}

#[tokio::test]
async fn a_token_connects() {
    let (addr, _) = fake_daemon(Answer::Authed(PROTOCOL_VERSION)).await;
    let (_host, seen) = connect(&addr);
    eventually("connected", || {
        seen.last()
            .is_some_and(|i| i.status == HostStatus::Connected)
    })
    .await;
}

#[tokio::test]
async fn a_daemon_with_another_protocol_needs_an_update_and_waits_for_a_retry() {
    let (addr, auths) = fake_daemon(Answer::Authed(99)).await;
    let (host, seen) = connect(&addr);
    eventually("needs_update", || {
        seen.last()
            .is_some_and(|i| i.status == HostStatus::NeedsUpdate)
    })
    .await;
    assert_eq!(
        seen.last().unwrap().daemon_version.as_deref(),
        Some("9.9.9")
    );
    // Backoff would have retried within 1.5 s.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(auths.lock().unwrap().len(), 1);
    host.reconnect();
    eventually("a second try after the retry", || {
        auths.lock().unwrap().len() == 2
    })
    .await;
}

#[tokio::test]
async fn a_refused_token_stops_retrying_until_asked() {
    let (addr, auths) = fake_daemon(Answer::Unauthorized).await;
    let (host, seen) = connect(&addr);
    eventually("error", || {
        seen.last().is_some_and(|i| i.status == HostStatus::Error)
    })
    .await;
    assert_eq!(
        seen.last().unwrap().message.as_deref(),
        Some("this phone is not paired with this Mac")
    );
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(auths.lock().unwrap().len(), 1);
    host.reconnect();
    eventually("a second try after the retry", || {
        auths.lock().unwrap().len() == 2
    })
    .await;
}
