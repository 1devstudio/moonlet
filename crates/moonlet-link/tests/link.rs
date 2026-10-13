//! A `Host` against a fake daemon on an in-memory pipe: what an app sees
//! through the link (requests, events, PTY output, statuses).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use moonlet_link::{
    BoxFuture, Connector, Events, Host, HostInfo, HostOptions, HostStatus, Reader, Writer,
};
use moonlet_proto::{Frame, Message, RpcError, read_frame, write_frame};
use serde_json::{Value, json};
use tokio::io::{DuplexStream, ReadHalf, WriteHalf};
use tokio::sync::mpsc;

/// Hands out one end of a pipe per connection; the test drives the other.
struct Pipe(mpsc::UnboundedSender<DuplexStream>);

impl Connector for Pipe {
    fn connect(&self) -> BoxFuture<'_, Result<(Reader, Writer)>> {
        let (app, daemon) = tokio::io::duplex(1 << 20);
        let sent = self.0.send(daemon);
        Box::pin(async move {
            sent.map_err(|_| anyhow::anyhow!("test over"))?;
            let (r, w) = tokio::io::split(app);
            Ok((Box::new(r) as Reader, Box::new(w) as Writer))
        })
    }
}

#[derive(Default)]
struct Seen {
    statuses: Mutex<Vec<HostStatus>>,
    events: Mutex<Vec<(String, String, Value)>>,
}

impl Events for Seen {
    fn status(&self, info: &HostInfo) {
        self.statuses.lock().unwrap().push(info.status.clone());
    }
    fn event(&self, host: &str, name: String, data: Value) {
        self.events.lock().unwrap().push((host.into(), name, data));
    }
}

struct FakeDaemon {
    r: ReadHalf<DuplexStream>,
    w: WriteHalf<DuplexStream>,
}

impl FakeDaemon {
    async fn accept(rx: &mut mpsc::UnboundedReceiver<DuplexStream>) -> FakeDaemon {
        let (r, w) = tokio::io::split(rx.recv().await.unwrap());
        let mut d = FakeDaemon { r, w };
        match d.next().await {
            Frame::Json(Message::Hello { client, .. }) => assert_eq!(client, "moonlet-test"),
            other => panic!("expected hello, got {other:?}"),
        }
        d.send(Frame::Json(Message::Welcome {
            protocol: moonlet_proto::PROTOCOL_VERSION,
            daemon_version: "9.9.9".into(),
            host: "studio-mini".into(),
            pid: 1,
        }))
        .await;
        d
    }

    async fn next(&mut self) -> Frame {
        tokio::time::timeout(Duration::from_secs(5), read_frame(&mut self.r))
            .await
            .expect("app sent nothing")
            .unwrap()
            .expect("app closed the link")
    }

    async fn next_request(&mut self) -> (u64, String, Value) {
        loop {
            if let Frame::Json(Message::Request { id, method, params }) = self.next().await {
                if method == "daemon.info" {
                    self.send(Frame::Json(Message::ok(
                        id,
                        json!({ "home": "/Users/alex" }),
                    )))
                    .await;
                    continue;
                }
                return (id, method, params);
            }
        }
    }

    async fn send(&mut self, frame: Frame) {
        write_frame(&mut self.w, &frame).await.unwrap();
    }
}

fn start() -> (Arc<Host>, Arc<Seen>, mpsc::UnboundedReceiver<DuplexStream>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let seen = Arc::new(Seen::default());
    let host = Host::start(
        HostOptions {
            id: "studio-mini".into(),
            label: "Studio".into(),
            remote: false,
            client: "moonlet-test".into(),
        },
        Arc::new(Pipe(tx)),
        seen.clone(),
        tokio::runtime::Handle::current(),
    );
    (host, seen, rx)
}

async fn eventually(what: &str, mut ok: impl FnMut() -> bool) {
    for _ in 0..200 {
        if ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{what} never happened");
}

#[tokio::test]
async fn a_request_gets_the_daemons_reply_and_the_host_reports_connected() {
    let (host, seen, mut rx) = start();
    let mut daemon = FakeDaemon::accept(&mut rx).await;
    let call = tokio::spawn({
        let host = host.clone();
        async move {
            // The link is up once the handshake is done.
            loop {
                match host.request("session.list", json!({})).await {
                    Err(e) if e.code == "disconnected" => {
                        tokio::time::sleep(Duration::from_millis(5)).await
                    }
                    other => return other,
                }
            }
        }
    });
    let (id, method, _) = daemon.next_request().await;
    assert_eq!(method, "session.list");
    daemon
        .send(Frame::Json(Message::ok(id, json!([{ "id": "s1" }]))))
        .await;
    assert_eq!(call.await.unwrap().unwrap(), json!([{ "id": "s1" }]));
    // Keep answering `daemon.info`, which the link sends once it is up.
    tokio::spawn(async move { daemon.next_request().await });

    eventually("connected", || {
        seen.statuses.lock().unwrap().last() == Some(&HostStatus::Connected)
    })
    .await;
    let info = host.info();
    assert_eq!(info.daemon_version.as_deref(), Some("9.9.9"));
    assert_eq!(info.hostname.as_deref(), Some("studio-mini"));
    assert_eq!(info.home.as_deref(), Some("/Users/alex"));
}

#[tokio::test]
async fn an_error_reply_is_returned_as_the_daemons_error() {
    let (host, _seen, mut rx) = start();
    let mut daemon = FakeDaemon::accept(&mut rx).await;
    let call = tokio::spawn({
        let host = host.clone();
        async move {
            loop {
                match host.request("git.commit", json!({})).await {
                    Err(e) if e.code == "disconnected" => {
                        tokio::time::sleep(Duration::from_millis(5)).await
                    }
                    other => return other,
                }
            }
        }
    });
    let (id, _, _) = daemon.next_request().await;
    daemon
        .send(Frame::Json(Message::err(
            id,
            RpcError::new("nothing_staged", "nothing to commit"),
        )))
        .await;
    let e = call.await.unwrap().unwrap_err();
    assert_eq!(
        (e.code.as_str(), e.message.as_str()),
        ("nothing_staged", "nothing to commit")
    );
}

#[tokio::test]
async fn events_reach_the_app_with_the_host_id() {
    let (_host, seen, mut rx) = start();
    let mut daemon = FakeDaemon::accept(&mut rx).await;
    daemon
        .send(Frame::Json(Message::Event {
            name: "sessions.changed".into(),
            data: json!({ "n": 1 }),
        }))
        .await;
    eventually("the event", || !seen.events.lock().unwrap().is_empty()).await;
    assert_eq!(
        seen.events.lock().unwrap()[0],
        (
            "studio-mini".to_string(),
            "sessions.changed".to_string(),
            json!({ "n": 1 })
        )
    );
}

#[tokio::test]
async fn an_attach_snapshot_comes_before_live_output_on_the_output_stream() {
    let (host, _seen, mut rx) = start();
    let out = Arc::new(Mutex::new(Vec::<u8>::new()));
    host.set_output({
        let out = out.clone();
        move |buf| out.lock().unwrap().extend_from_slice(&buf)
    });
    let mut daemon = FakeDaemon::accept(&mut rx).await;
    let attach = tokio::spawn({
        let host = host.clone();
        async move {
            loop {
                match host.request("terminal.attach", json!({ "id": 7 })).await {
                    Err(e) if e.code == "disconnected" => {
                        tokio::time::sleep(Duration::from_millis(5)).await
                    }
                    other => return other,
                }
            }
        }
    });
    let (id, _, _) = daemon.next_request().await;
    daemon
        .send(Frame::Json(Message::ok(
            id,
            json!({ "info": { "id": 7 }, "snapshot": "$ ls" }),
        )))
        .await;
    daemon
        .send(Frame::Output {
            terminal: 7,
            data: b"a.txt".to_vec(),
        })
        .await;
    // The reply keeps everything but the snapshot.
    assert_eq!(
        attach.await.unwrap().unwrap(),
        json!({ "info": { "id": 7 } })
    );

    let mut want = Vec::new();
    want.extend_from_slice(&(7u32 | 0x8000_0000).to_be_bytes());
    want.extend_from_slice(&4u32.to_be_bytes());
    want.extend_from_slice(b"$ ls");
    want.extend_from_slice(&7u32.to_be_bytes());
    want.extend_from_slice(&5u32.to_be_bytes());
    want.extend_from_slice(b"a.txt");
    eventually("the output", || out.lock().unwrap().len() >= want.len()).await;
    assert_eq!(*out.lock().unwrap(), want);
}

#[tokio::test]
async fn input_reaches_the_daemon_as_an_input_frame() {
    let (host, _seen, mut rx) = start();
    let mut daemon = FakeDaemon::accept(&mut rx).await;
    eventually("the link", || host.input(3, b"ls\r".to_vec()).is_ok()).await;
    loop {
        if let Frame::Input { terminal, data } = daemon.next().await {
            assert_eq!((terminal, data), (3, b"ls\r".to_vec()));
            break;
        }
    }
}

#[tokio::test]
async fn a_dropped_link_fails_waiting_requests_and_reconnects() {
    let (host, seen, mut rx) = start();
    let mut daemon = FakeDaemon::accept(&mut rx).await;
    let call = tokio::spawn({
        let host = host.clone();
        async move {
            loop {
                match host.request("chat.state", json!({ "id": 1 })).await {
                    Err(e) if e.code == "disconnected" && e.message.contains("not connected") => {
                        tokio::time::sleep(Duration::from_millis(5)).await
                    }
                    other => return other,
                }
            }
        }
    });
    daemon.next_request().await;
    drop(daemon);
    let e = call.await.unwrap().unwrap_err();
    assert_eq!(e.code, "disconnected");

    // It connects again by itself.
    let _again = FakeDaemon::accept(&mut rx).await;
    eventually("reconnecting", || {
        seen.statuses
            .lock()
            .unwrap()
            .contains(&HostStatus::Reconnecting)
    })
    .await;
}
