//! R3: `jauntd proxy` (what `ssh host jauntd proxy` runs) starts the daemon
//! if needed, bridges the protocol over stdio, and sessions outlive the link.

use std::process::Stdio;
use std::time::Duration;

use jaunt_proto::methods::{self, AttachResult, SessionAttach, SessionCreate};
use jaunt_proto::types::SessionInfo;
use jaunt_proto::{Frame, Message, PROTOCOL_VERSION, read_frame, write_frame};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

struct Link {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    next: u64,
}

impl Link {
    async fn open(home: &std::path::Path) -> Link {
        let mut child = Command::new(env!("CARGO_BIN_EXE_jauntd"))
            .arg("proxy")
            .env("JAUNT_HOME", home)
            .env_remove("JAUNT_SOCK")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        write_frame(&mut stdin, &Frame::Json(Message::Hello { protocol: PROTOCOL_VERSION, client: "proxy-test".into() })).await.unwrap();
        let welcome = tokio::time::timeout(Duration::from_secs(20), read_frame(&mut stdout)).await.unwrap().unwrap();
        assert!(matches!(welcome, Some(Frame::Json(Message::Welcome { .. }))), "{welcome:?}");
        Link { child, stdin, stdout, next: 1 }
    }

    async fn call<T: serde::de::DeserializeOwned>(&mut self, method: &str, params: serde_json::Value) -> T {
        let id = self.next;
        self.next += 1;
        write_frame(&mut self.stdin, &Frame::Json(Message::Request { id, method: method.into(), params })).await.unwrap();
        loop {
            match read_frame(&mut self.stdout).await.unwrap() {
                Some(Frame::Json(Message::Response { id: rid, result, error })) if rid == id => {
                    assert!(error.is_none(), "{error:?}");
                    return serde_json::from_value(result.unwrap()).unwrap();
                }
                Some(_) => {}
                None => panic!("proxy closed"),
            }
        }
    }

    async fn output_until(&mut self, needle: &str) {
        let mut seen = String::new();
        while !seen.contains(needle) {
            let f = tokio::time::timeout(Duration::from_secs(10), read_frame(&mut self.stdout)).await.unwrap().unwrap();
            if let Some(Frame::Output { data, .. }) = f {
                seen.push_str(&String::from_utf8_lossy(&data));
            }
        }
    }
}

#[tokio::test]
async fn proxy_autostarts_daemon_and_sessions_survive_link_loss() {
    let home = tempfile::tempdir().unwrap();
    let mut link = Link::open(home.path()).await;
    let s: SessionInfo = link
        .call(methods::SESSION_CREATE, serde_json::to_value(SessionCreate { cwd: home.path().display().to_string(), command: vec!["/bin/sh".into()], ..Default::default() }).unwrap())
        .await;
    let _: AttachResult = link.call(methods::SESSION_ATTACH, serde_json::to_value(SessionAttach { id: s.id, cols: None, rows: None }).unwrap()).await;
    write_frame(&mut link.stdin, &Frame::Input { session: s.id, data: b"echo over-ssh-$((2*21))\n".to_vec() }).await.unwrap();
    link.output_until("over-ssh-42").await;

    // The network drops: the proxy process dies.
    link.child.kill().await.unwrap();
    drop(link);
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut link = Link::open(home.path()).await;
    let attach: AttachResult = link.call(methods::SESSION_ATTACH, serde_json::to_value(SessionAttach { id: s.id, cols: None, rows: None }).unwrap()).await;
    assert!(attach.snapshot.contains("over-ssh-42"), "screen resynced after reconnect");
    let _: bool = link.call(methods::DAEMON_SHUTDOWN, serde_json::json!({})).await;
}
