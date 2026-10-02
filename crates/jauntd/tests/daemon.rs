//! End-to-end tests against a real `jauntd` process.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use jaunt_core::client::{Client, wait_for_socket};
use jaunt_proto::methods::{self, AttachResult, SessionAttach, SessionCreate, SessionKill};
use jaunt_proto::types::{DaemonInfo, SessionInfo};
use jaunt_proto::{Frame, Message, PROTOCOL_VERSION, read_frame, write_frame};

pub struct TestDaemon {
    pub home: tempfile::TempDir,
    pub socket: PathBuf,
    child: Child,
}

impl TestDaemon {
    pub async fn start() -> TestDaemon {
        let home = tempfile::tempdir().unwrap();
        let socket = home.path().join("run").join("d.sock");
        let child = Command::new(env!("CARGO_BIN_EXE_jauntd"))
            .arg("daemon")
            .env("JAUNT_HOME", home.path())
            .env("JAUNT_SOCK", &socket)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        wait_for_socket(&socket, Duration::from_secs(15))
            .await
            .unwrap();
        TestDaemon {
            home,
            socket,
            child,
        }
    }

    pub async fn client(&self) -> Client {
        Client::connect(&self.socket, "test").await.unwrap()
    }
}

impl Drop for TestDaemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn output_until(c: &mut Client, needle: &str) -> String {
    let mut seen = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !seen.contains(needle) {
        let f = tokio::time::timeout_at(deadline, c.next_frame())
            .await
            .expect("timeout")
            .unwrap()
            .unwrap();
        if let Frame::Output { data, .. } = f {
            seen.push_str(&String::from_utf8_lossy(&data));
        }
    }
    seen
}

#[tokio::test]
async fn socket_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let d = TestDaemon::start().await;
    let mode = std::fs::metadata(&d.socket).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let dir_mode = std::fs::metadata(d.socket.parent().unwrap())
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(dir_mode, 0o700);
}

#[tokio::test]
async fn rejects_protocol_mismatch() {
    let d = TestDaemon::start().await;
    let mut s = tokio::net::UnixStream::connect(&d.socket).await.unwrap();
    write_frame(
        &mut s,
        &Frame::Json(Message::Hello {
            protocol: PROTOCOL_VERSION + 1,
            client: "old".into(),
        }),
    )
    .await
    .unwrap();
    match read_frame(&mut s).await.unwrap() {
        Some(Frame::Json(Message::Response { error: Some(e), .. })) => {
            assert_eq!(e.code, "protocol_mismatch")
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn session_survives_client_disconnect_and_replays_on_reattach() {
    let d = TestDaemon::start().await;
    let mut c = d.client().await;
    let info: DaemonInfo = c.request(methods::DAEMON_INFO, ()).await.unwrap();
    assert_eq!(info.protocol, PROTOCOL_VERSION);

    let s: SessionInfo = c
        .request(
            methods::SESSION_CREATE,
            SessionCreate {
                cwd: d.home.path().display().to_string(),
                command: vec!["/bin/sh".into()],
                cols: 60,
                rows: 15,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let _: AttachResult = c
        .request(
            methods::SESSION_ATTACH,
            SessionAttach {
                id: s.id,
                cols: None,
                rows: None,
            },
        )
        .await
        .unwrap();
    c.send(&Frame::Input {
        session: s.id,
        data: b"echo marker-$((40+2))\n".to_vec(),
    })
    .await
    .unwrap();
    output_until(&mut c, "marker-42").await;
    drop(c); // the "app" quits

    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut c2 = d.client().await;
    let list: Vec<SessionInfo> = c2.request(methods::SESSION_LIST, ()).await.unwrap();
    assert!(
        list.iter().any(|x| x.id == s.id && x.exit.is_none()),
        "session still running"
    );
    let attach: AttachResult = c2
        .request(
            methods::SESSION_ATTACH,
            SessionAttach {
                id: s.id,
                cols: None,
                rows: None,
            },
        )
        .await
        .unwrap();
    assert!(
        attach.snapshot.contains("marker-42"),
        "snapshot restores the screen"
    );

    // Live output keeps flowing after reattach.
    c2.send(&Frame::Input {
        session: s.id,
        data: b"echo again-$((1+1))\n".to_vec(),
    })
    .await
    .unwrap();
    output_until(&mut c2, "again-2").await;
    let _: bool = c2
        .request(
            methods::SESSION_KILL,
            SessionKill {
                id: s.id,
                remove: true,
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn unknown_method_is_an_error_not_a_disconnect() {
    let d = TestDaemon::start().await;
    let mut c = d.client().await;
    let err = c
        .request::<_, serde_json::Value>("nope.nope", ())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("unknown_method"));
    let _: DaemonInfo = c.request(methods::DAEMON_INFO, ()).await.unwrap();
}
