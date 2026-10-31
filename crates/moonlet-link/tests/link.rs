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
    messages: Mutex<Vec<Option<String>>>,
    events: Mutex<Vec<(String, String, Value)>>,
}

impl Events for Seen {
    fn status(&self, info: &HostInfo) {
        self.statuses.lock().unwrap().push(info.status.clone());
        self.messages.lock().unwrap().push(info.message.clone());
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
async fn another_members_sign_in_snapshot_comes_on_the_output_stream_under_its_relay() {
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
            let params = json!({ "member": "w-build", "terminal": 3, "cols": 80, "rows": 24 });
            loop {
                match host.request("signins.attach", params.clone()).await {
                    Err(e) if e.code == "disconnected" => {
                        tokio::time::sleep(Duration::from_millis(5)).await
                    }
                    other => return other,
                }
            }
        }
    });
    let (id, method, _) = daemon.next_request().await;
    assert_eq!(method, "signins.attach");
    // The central host's relay id for build-box's terminal, not the
    // terminal's own id there.
    daemon
        .send(Frame::Json(Message::ok(
            id,
            json!({ "info": { "id": 42 }, "snapshot": "code: 1A2B" }),
        )))
        .await;
    daemon
        .send(Frame::Output {
            terminal: 42,
            data: b"ok".to_vec(),
        })
        .await;
    assert_eq!(
        attach.await.unwrap().unwrap(),
        json!({ "info": { "id": 42 } })
    );

    let mut want = Vec::new();
    want.extend_from_slice(&(42u32 | 0x8000_0000).to_be_bytes());
    want.extend_from_slice(&10u32.to_be_bytes());
    want.extend_from_slice(b"code: 1A2B");
    want.extend_from_slice(&42u32.to_be_bytes());
    want.extend_from_slice(&2u32.to_be_bytes());
    want.extend_from_slice(b"ok");
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

#[tokio::test]
async fn an_error_the_daemon_sends_unasked_becomes_the_hosts_message() {
    // What the Mac sends a phone when the route's ssh fails (X39).
    let (_host, seen, mut rx) = start();
    let mut daemon = FakeDaemon::accept(&mut rx).await;
    daemon
        .send(Frame::Json(Message::err(
            0,
            RpcError::new("route_failed", "ssh: Could not resolve hostname devbox"),
        )))
        .await;
    drop(daemon);
    eventually("the message", || {
        seen.messages
            .lock()
            .unwrap()
            .iter()
            .any(|m| m.as_deref() == Some("ssh: Could not resolve hostname devbox"))
    })
    .await;
}

/// Answers `worker.ping` with the params it got, and nothing else (X41).
struct Pong;

impl moonlet_link::Requests for Pong {
    fn request(&self, method: String, params: Value) -> BoxFuture<'static, Result<Value, RpcError>> {
        Box::pin(async move {
            match method.as_str() {
                "worker.ping" => Ok(json!({ "pong": params })),
                _ => Err(RpcError::new("unknown_method", format!("unknown method {method}"))),
            }
        })
    }
}

/// The next reply the app sent, skipping its own requests.
async fn next_reply(daemon: &mut FakeDaemon) -> Message {
    loop {
        match daemon.next().await {
            Frame::Json(m @ Message::Response { .. }) => return m,
            Frame::Json(Message::Request { id, method, .. }) if method == "daemon.info" => {
                daemon.send(Frame::Json(Message::ok(id, json!({})))).await;
            }
            _ => {}
        }
    }
}

#[tokio::test]
async fn a_request_from_the_daemon_gets_the_handlers_answer_with_the_same_id() {
    let (host, _seen, mut rx) = start();
    host.set_requests(Arc::new(Pong));
    let mut daemon = FakeDaemon::accept(&mut rx).await;
    daemon
        .send(Frame::Json(Message::Request {
            id: 1,
            method: "worker.ping".into(),
            params: json!({ "n": 7 }),
        }))
        .await;
    match next_reply(&mut daemon).await {
        Message::Response { id, result, error } => {
            assert_eq!(id, 1);
            assert_eq!(error, None);
            assert_eq!(result, Some(json!({ "pong": { "n": 7 } })));
        }
        other => panic!("expected a response, got {other:?}"),
    }
    daemon
        .send(Frame::Json(Message::Request {
            id: 2,
            method: "sync.nothing".into(),
            params: json!({}),
        }))
        .await;
    match next_reply(&mut daemon).await {
        Message::Response { id, error: Some(e), .. } => {
            assert_eq!((id, e.code.as_str()), (2, "unknown_method"));
        }
        other => panic!("expected an error, got {other:?}"),
    }
}

#[tokio::test]
async fn a_host_without_a_handler_refuses_the_daemons_requests() {
    let (_host, _seen, mut rx) = start();
    let mut daemon = FakeDaemon::accept(&mut rx).await;
    daemon
        .send(Frame::Json(Message::Request {
            id: 1,
            method: "worker.ping".into(),
            params: json!({}),
        }))
        .await;
    match next_reply(&mut daemon).await {
        Message::Response { id, error: Some(e), .. } => {
            assert_eq!((id, e.code.as_str()), (1, "unknown_method"));
        }
        other => panic!("expected an error, got {other:?}"),
    }
}

/// Answers `worker.slow` only once the test lets it.
struct Gate(Arc<tokio::sync::Notify>);

impl moonlet_link::Requests for Gate {
    fn request(&self, _method: String, _params: Value) -> BoxFuture<'static, Result<Value, RpcError>> {
        let gate = self.0.clone();
        Box::pin(async move {
            gate.notified().await;
            Ok(json!({ "late": true }))
        })
    }
}

#[tokio::test]
async fn a_reply_goes_only_on_the_link_its_request_came_on() {
    let (host, _seen, mut rx) = start();
    let gate = Arc::new(tokio::sync::Notify::new());
    host.set_requests(Arc::new(Gate(gate.clone())));
    let mut first = FakeDaemon::accept(&mut rx).await;
    first
        .send(Frame::Json(Message::Request {
            id: 1,
            method: "worker.slow".into(),
            params: json!({}),
        }))
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(first);
    let mut second = FakeDaemon::accept(&mut rx).await;
    // The new link numbers its requests from 1 again.
    second
        .send(Frame::Json(Message::Request {
            id: 1,
            method: "worker.slow".into(),
            params: json!({}),
        }))
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    // Only the first request's handler wakes: its answer belongs to a
    // link that is gone.
    gate.notify_one();
    let late = tokio::time::timeout(Duration::from_millis(500), next_reply(&mut second)).await;
    assert!(late.is_err(), "the old link's answer reached the new one: {late:?}");
}

/// Hands out connections that fail as refused, after the test lets them.
struct SlowRefusal(Arc<tokio::sync::Notify>);

impl Connector for SlowRefusal {
    fn connect(&self) -> BoxFuture<'_, Result<(Reader, Writer)>> {
        let gate = self.0.clone();
        Box::pin(async move {
            gate.notified().await;
            Err(moonlet_link::Refused("studio-mini no longer accepts this Mac".into()).into())
        })
    }
}

#[tokio::test]
async fn a_stopped_host_reports_nothing_more() {
    let seen = Arc::new(Seen::default());
    let gate = Arc::new(tokio::sync::Notify::new());
    let host = Host::start(
        HostOptions {
            id: "studio-mini".into(),
            label: "Studio".into(),
            remote: true,
            client: "moonlet-test".into(),
        },
        Arc::new(SlowRefusal(gate.clone())),
        seen.clone(),
        tokio::runtime::Handle::current(),
    );
    eventually("connecting", || {
        seen.statuses.lock().unwrap().contains(&HostStatus::Connecting)
    })
    .await;
    host.stop();
    gate.notify_one();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(*seen.statuses.lock().unwrap(), [HostStatus::Connecting]);
}

/// Answers with the size of the pack its request names, taken from the
/// host (X60).
struct PackSize(Mutex<std::sync::Weak<Host>>);

impl moonlet_link::Requests for PackSize {
    fn request(&self, _method: String, params: Value) -> BoxFuture<'static, Result<Value, RpcError>> {
        let host = self.0.lock().unwrap().upgrade();
        Box::pin(async move {
            let transfer = params["pack"].as_u64().unwrap() as u32;
            let pack = host.and_then(|h| h.take_pack(transfer));
            Ok(json!({ "bytes": pack.map(|p| p.len()) }))
        })
    }
}

#[tokio::test]
async fn a_pack_sent_before_a_request_is_there_for_its_handler() {
    let (host, _seen, mut rx) = start();
    host.set_requests(Arc::new(PackSize(Mutex::new(Arc::downgrade(&host)))));
    let mut daemon = FakeDaemon::accept(&mut rx).await;
    let pack = vec![7u8; 1_500_000];
    for f in moonlet_proto::pack_frames(3, &pack) {
        daemon.send(f).await;
    }
    daemon
        .send(Frame::Json(Message::Request {
            id: 1,
            method: "sync.update".into(),
            params: json!({ "pack": 3 }),
        }))
        .await;
    match next_reply(&mut daemon).await {
        Message::Response { id, result, error } => {
            assert_eq!((id, error), (1, None));
            assert_eq!(result, Some(json!({ "bytes": 1_500_000 })));
        }
        other => panic!("expected a response, got {other:?}"),
    }
}

#[tokio::test]
async fn a_pack_the_host_sends_arrives_whole_under_its_transfer_id() {
    let (host, _seen, mut rx) = start();
    let mut daemon = FakeDaemon::accept(&mut rx).await;
    let pack: Vec<u8> = (0..2_100_000).map(|i| (i % 253) as u8).collect();
    let mut transfer = None;
    eventually("the link", || {
        transfer = host.send_pack(&pack).ok();
        transfer.is_some()
    })
    .await;
    let mut got = moonlet_proto::PackAssembler::default();
    let id = transfer.unwrap();
    loop {
        if let Frame::Pack { transfer, data } = daemon.next().await {
            got.push(transfer, data).unwrap();
            if let Some(p) = got.take(id) {
                assert_eq!(p, pack);
                break;
            }
        }
    }
}

/// [`Pipe`] to this Mac's own daemon, whose app credential it read (X75).
struct OwnDaemon(Pipe);

impl Connector for OwnDaemon {
    fn connect(&self) -> BoxFuture<'_, Result<(Reader, Writer)>> {
        self.0.connect()
    }

    fn app_token(&self) -> Option<String> {
        Some("5e".repeat(32))
    }
}

/// The `hello` the app sends on the next connection.
async fn hello_on(rx: &mut mpsc::UnboundedReceiver<DuplexStream>) -> Message {
    let (mut r, _w) = tokio::io::split(rx.recv().await.unwrap());
    match tokio::time::timeout(Duration::from_secs(5), read_frame(&mut r))
        .await
        .unwrap()
        .unwrap()
    {
        Some(Frame::Json(m)) => m,
        other => panic!("expected hello, got {other:?}"),
    }
}

#[tokio::test]
async fn only_the_link_to_this_macs_own_daemon_sends_the_app_credential() {
    let opts = || HostOptions {
        id: "local".into(),
        label: "This Mac".into(),
        remote: false,
        client: "moonlet-app".into(),
    };
    let (tx, mut rx) = mpsc::unbounded_channel();
    let _own = Host::start(
        opts(),
        Arc::new(OwnDaemon(Pipe(tx))),
        Arc::new(Seen::default()),
        tokio::runtime::Handle::current(),
    );
    assert_eq!(
        hello_on(&mut rx).await,
        Message::Hello {
            protocol: moonlet_proto::PROTOCOL_VERSION,
            client: "moonlet-app".into(),
            app_token: Some("5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e".into()),
        }
    );
    let (tx, mut rx) = mpsc::unbounded_channel();
    let _other = Host::start(
        opts(),
        Arc::new(Pipe(tx)),
        Arc::new(Seen::default()),
        tokio::runtime::Handle::current(),
    );
    assert_eq!(
        hello_on(&mut rx).await,
        Message::Hello {
            protocol: moonlet_proto::PROTOCOL_VERSION,
            client: "moonlet-app".into(),
            app_token: None,
        }
    );
}
