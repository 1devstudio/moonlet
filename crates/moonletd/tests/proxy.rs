//! R3: `moonletd proxy` (what `ssh host moonletd proxy` runs) starts the daemon
//! if needed, bridges the protocol over stdio, and sessions outlive the link.

use std::process::Stdio;
use std::time::Duration;

use moonlet_proto::methods::{self, AttachResult, TerminalAttach, TerminalCreate};
use moonlet_proto::types::TerminalInfo;
use moonlet_proto::{Frame, Message, PROTOCOL_VERSION, RpcError, read_frame, write_frame};
use tokio::io::AsyncRead;
use tokio::process::{Child, ChildStdin, Command};

/// An SSH host for the tests: its moonlet home, and a fake sshd. The
/// daemon a proxy starts takes the fake for sshd (`MOONLET_TEST_SSHD_EXE`).
struct Host {
    home: tempfile::TempDir,
    bin: tempfile::TempDir,
}

impl Host {
    fn new() -> Host {
        // A copy of this test binary named sshd, which runs moonletd as
        // `as_sshd_runs_moonletd`.
        let bin = tempfile::tempdir().unwrap();
        std::fs::copy(std::env::current_exe().unwrap(), bin.path().join("sshd")).unwrap();
        Host {
            home: tempfile::tempdir().unwrap(),
            bin,
        }
    }

    fn sshd(&self) -> std::path::PathBuf {
        self.bin.path().join("sshd")
    }

    /// `moonletd <args>` on this host, run as `run` says.
    fn command(&self, args: &[&str], run: Run) -> Command {
        let mut c = match run {
            Run::Direct => {
                let mut c = Command::new(env!("CARGO_BIN_EXE_moonletd"));
                c.args(args)
                    .env_remove("SSH_CONNECTION")
                    .env_remove("MOONLET_SOCK");
                c
            }
            Run::Ssh { env } => {
                let mut c = Command::new(self.sshd());
                c.args(["--exact", "as_sshd_runs_moonletd", "--nocapture", "--test-threads=1"])
                    .env_remove("MOONLET_SOCK")
                    .env("PROXY_TEST_AS_SSHD", args.join(" "))
                    .env("SSH_CONNECTION", "100.64.0.7 52814 100.64.0.9 22")
                    .envs(env);
                c
            }
        };
        c.env("MOONLET_HOME", self.home.path())
            .env("MOONLET_TEST_SSHD_EXE", self.sshd());
        c
    }
}

/// What a copy of this test binary named `sshd` does (see [`Run::Ssh`]):
/// runs `moonletd` with the arguments in PROXY_TEST_AS_SSHD as sshd runs
/// an SSH session's command, on this process's stdin and, since the test
/// harness writes to stdout, its stderr; then exits as moonletd did. In a
/// plain run it does nothing.
#[test]
fn as_sshd_runs_moonletd() {
    let Some(args) = std::env::var("PROXY_TEST_AS_SSHD").ok() else {
        return;
    };
    let out = std::os::fd::AsFd::as_fd(&std::io::stderr())
        .try_clone_to_owned()
        .unwrap();
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_moonletd"))
        .args(args.split(' '))
        .env_remove("PROXY_TEST_AS_SSHD")
        .stdout(out)
        .stderr(Stdio::null())
        .status()
        .unwrap();
    std::process::exit(status.code().unwrap_or(1));
}

struct Link {
    child: Child,
    stdin: ChildStdin,
    stdout: Box<dyn AsyncRead + Unpin + Send>,
    next: u64,
}

/// How a test starts `moonletd`.
enum Run {
    /// As a child of the test, as another process of the user's would.
    Direct,
    /// As the command of an SSH session: started by the host's fake sshd,
    /// with SSH_CONNECTION set. `env` is set on top.
    Ssh { env: Vec<(String, String)> },
}

impl Link {
    async fn open(host: &Host) -> Link {
        Link::open_as(host, "proxy-test").await
    }

    async fn open_as(host: &Host, client: &str) -> Link {
        Link::spawn(host, client, None, Run::Direct).await
    }

    /// The app's link to an SSH host.
    async fn over_ssh(host: &Host, client: &str) -> Link {
        Link::spawn(host, client, None, Run::Ssh { env: Vec::new() }).await
    }

    async fn spawn(host: &Host, client: &str, app_token: Option<String>, run: Run) -> Link {
        let ssh = matches!(run, Run::Ssh { .. });
        let mut child = host
            .command(&["proxy"], run)
            .stdin(Stdio::piped())
            .stdout(if ssh { Stdio::null() } else { Stdio::piped() })
            .stderr(if ssh { Stdio::piped() } else { Stdio::null() })
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout: Box<dyn AsyncRead + Unpin + Send> = match child.stdout.take() {
            Some(out) => Box::new(out),
            None => Box::new(child.stderr.take().unwrap()),
        };
        write_frame(
            &mut stdin,
            &Frame::Json(Message::Hello {
                protocol: PROTOCOL_VERSION,
                client: client.into(),
                app_token,
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
    let host = Host::new();
    let home = &host.home;
    let mut link = Link::open(&host).await;
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

    let mut link = Link::open(&host).await;
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

fn entries() -> serde_json::Value {
    serde_json::json!({ "entries": [
        { "id": "t", "name": "test-cli", "login": "true", "check": "true" }
    ] })
}

async fn refused(link: &mut Link) -> bool {
    match link.try_call(methods::SIGNINS_SET, entries()).await {
        Err(e) => {
            assert_eq!(e.message, "only the moonlet app manages sign-ins");
            true
        }
        Ok(_) => false,
    }
}

#[tokio::test]
async fn the_app_over_ssh_counts_as_the_app_and_the_cli_does_not() {
    // The app cannot read a remote host's credential; `moonletd proxy` runs
    // as the user on that host, so the SSH login already proved who it is.
    let host = Host::new();
    let mut cli = Link::over_ssh(&host, "moonlet-cli").await;
    let e = cli
        .try_call(methods::SIGNINS_SET, entries())
        .await
        .unwrap_err();
    assert_eq!(e.code, "forbidden");
    assert_eq!(e.message, "only the moonlet app manages sign-ins");

    let mut app = Link::over_ssh(&host, "moonlet-app").await;
    let _: bool = app.call(methods::SIGNINS_SET, entries()).await;
    let list: Vec<serde_json::Value> = cli.call(methods::SIGNINS_LIST, serde_json::json!({})).await;
    assert_eq!(list[0]["id"], serde_json::json!("t"));
    let _: bool = app
        .call(methods::DAEMON_SHUTDOWN, serde_json::json!({}))
        .await;
}

#[tokio::test]
async fn the_proxy_vouches_for_the_app_only_as_an_ssh_session_s_command() {
    let host = Host::new();
    // Run by another process of the user's.
    let mut direct = Link::open_as(&host, "moonlet-app").await;
    assert!(refused(&mut direct).await, "a proxy the test started vouched");
    // In a moonlet terminal, where an agent runs as the user, even under sshd.
    let socket = host.home.path().join("run").join("moonletd.sock");
    assert!(socket.exists(), "the daemon listens elsewhere");
    for env in [
        ("MOONLET_TERMINAL_ID", "7".to_string()),
        ("MOONLET_SOCK", socket.display().to_string()),
    ] {
        let env = vec![(env.0.to_string(), env.1)];
        let run = Run::Ssh { env: env.clone() };
        let mut link = Link::spawn(&host, "moonlet-app", None, run).await;
        assert!(refused(&mut link).await, "a proxy with {env:?} vouched");
    }
    // A credential the client sent never passes through.
    let token = moonlet_core::app_token::read(&moonlet_core::app_token::file_in(host.home.path()));
    assert!(token.is_some());
    let mut sent = Link::spawn(&host, "moonlet-app", token, Run::Direct).await;
    assert!(refused(&mut sent).await, "a credential went through the proxy");

    let mut ssh = Link::over_ssh(&host, "moonlet-app").await;
    assert!(!refused(&mut ssh).await, "the app over SSH was refused");
    let _: bool = direct
        .call(methods::DAEMON_SHUTDOWN, serde_json::json!({}))
        .await;
}

#[tokio::test]
async fn moonletd_with_the_credential_is_the_app_only_within_an_ssh_session() {
    // `moonletd tailnet` sends the credential itself, as a proxy that did
    // not strip it would: the daemon checks where it runs.
    let host = Host::new();
    let mut link = Link::open(&host).await;
    let out = host
        .command(&["tailnet", "status"], Run::Direct)
        .output()
        .await
        .unwrap();
    assert!(!out.status.success());
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(
        said.starts_with(
            "Only the moonlet app, or you over SSH or at the console, manages tailnet access and pairing.\n"
        ),
        "{said}"
    );

    let out = host
        .command(&["tailnet", "status"], Run::Ssh { env: Vec::new() })
        .output()
        .await
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "Tailnet access is off\n");
    let _: bool = link
        .call(methods::DAEMON_SHUTDOWN, serde_json::json!({}))
        .await;
}
