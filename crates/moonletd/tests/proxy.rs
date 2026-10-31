//! R3: `moonletd proxy` (what `ssh host moonletd proxy` runs) starts the daemon
//! if needed, bridges the protocol over stdio, and sessions outlive the link.

use std::process::Stdio;
use std::time::Duration;

use moonlet_proto::methods::{self, AttachResult, TerminalAttach, TerminalCreate};
use moonlet_proto::types::TerminalInfo;
use moonlet_proto::{Frame, Message, PROTOCOL_VERSION, RpcError, read_frame, write_frame};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

struct Link {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    next: u64,
}

impl Link {
    async fn open(home: &std::path::Path) -> Link {
        Link::open_as(home, "proxy-test").await
    }

    async fn open_as(home: &std::path::Path, client: &str) -> Link {
        let mut child = Command::new(env!("CARGO_BIN_EXE_moonletd"))
            .arg("proxy")
            .env("MOONLET_HOME", home)
            .env_remove("MOONLET_SOCK")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        write_frame(
            &mut stdin,
            &Frame::Json(Message::Hello {
                protocol: PROTOCOL_VERSION,
                client: client.into(),
                app_token: None,
            }),
        )
        .await
        .unwrap();
        let welcome = tokio::time::timeout(Duration::from_secs(20), read_frame(&mut stdout))
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(welcome, Some(Frame::Json(Message::Welcome { .. }))),
            "{welcome:?}"
        );
        Link {
            child,
            stdin,
            stdout,
            next: 1,
        }
    }

    async fn call<T: serde::de::DeserializeOwned>(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> T {
        let result = self.try_call(method, params).await;
        serde_json::from_value(result.unwrap_or_else(|e| panic!("{e:?}"))).unwrap()
    }

    async fn try_call(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, RpcError> {
        let id = self.next;
        self.next += 1;
        write_frame(
            &mut self.stdin,
            &Frame::Json(Message::Request {
                id,
                method: method.into(),
                params,
            }),
        )
        .await
        .unwrap();
        // One deadline for the whole wait, so unrelated frames cannot extend it.
        let wait = async {
            loop {
                match read_frame(&mut self.stdout).await.unwrap() {
                    Some(Frame::Json(Message::Response {
                        id: rid,
                        result,
                        error,
                    })) if rid == id => {
                        return match error {
                            Some(e) => Err(e),
                            None => Ok(result.unwrap_or_default()),
                        };
                    }
                    Some(_) => {}
                    None => panic!("proxy closed"),
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(20), wait)
            .await
            .unwrap_or_else(|_| panic!("no reply to {method} within 20 s"))
    }

    async fn output_until(&mut self, needle: &str) {
        let mut seen = String::new();
        while !seen.contains(needle) {
            let f = tokio::time::timeout(Duration::from_secs(10), read_frame(&mut self.stdout))
                .await
                .unwrap()
                .unwrap();
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
    let s: TerminalInfo = link
        .call(
            methods::TERMINAL_CREATE,
            serde_json::to_value(TerminalCreate {
                cwd: home.path().display().to_string(),
                command: vec!["/bin/sh".into()],
                ..Default::default()
            })
            .unwrap(),
        )
        .await;
    let _: AttachResult = link
        .call(
            methods::TERMINAL_ATTACH,
            serde_json::to_value(TerminalAttach {
                id: s.id,
                cols: None,
                rows: None,
            })
            .unwrap(),
        )
        .await;
    write_frame(
        &mut link.stdin,
        &Frame::Input {
            terminal: s.id,
            data: b"echo over-ssh-$((2*21))\n".to_vec(),
        },
    )
    .await
    .unwrap();
    link.output_until("over-ssh-42").await;

    // The network drops: the proxy process dies.
    link.child.kill().await.unwrap();
    drop(link);
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut link = Link::open(home.path()).await;
    let attach: AttachResult = link
        .call(
            methods::TERMINAL_ATTACH,
            serde_json::to_value(TerminalAttach {
                id: s.id,
                cols: None,
                rows: None,
            })
            .unwrap(),
        )
        .await;
    assert!(
        attach.snapshot.contains("over-ssh-42"),
        "screen resynced after reconnect"
    );
    let _: bool = link
        .call(methods::DAEMON_SHUTDOWN, serde_json::json!({}))
        .await;
}

#[tokio::test]
async fn the_app_over_ssh_counts_as_the_app_and_the_cli_does_not() {
    // The app cannot read a remote host's credential; `moonletd proxy` runs
    // as the user on that host, so the SSH login already proved who it is.
    let home = tempfile::tempdir().unwrap();
    let entries = serde_json::json!({ "entries": [
        { "id": "t", "name": "test-cli", "login": "true", "check": "true" }
    ] });
    let mut cli = Link::open_as(home.path(), "moonlet-cli").await;
    let e = cli
        .try_call(methods::SIGNINS_SET, entries.clone())
        .await
        .unwrap_err();
    assert_eq!(e.code, "forbidden");
    assert_eq!(e.message, "only the moonlet app manages sign-ins");

    let mut app = Link::open_as(home.path(), "moonlet-app").await;
    let _: bool = app.call(methods::SIGNINS_SET, entries).await;
    let list: Vec<serde_json::Value> = cli.call(methods::SIGNINS_LIST, serde_json::json!({})).await;
    assert_eq!(list[0]["id"], serde_json::json!("t"));
    let _: bool = app
        .call(methods::DAEMON_SHUTDOWN, serde_json::json!({}))
        .await;
}
