//! End-to-end tests against a real `jauntd` process.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use jaunt_core::client::{Client, wait_for_socket};
use jaunt_proto::methods::{self, AttachResult, TerminalAttach, TerminalCreate, TerminalKill};
use jaunt_proto::types::{DaemonInfo, TerminalInfo};
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

    let s: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            TerminalCreate {
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
            methods::TERMINAL_ATTACH,
            TerminalAttach {
                id: s.id,
                cols: None,
                rows: None,
            },
        )
        .await
        .unwrap();
    c.send(&Frame::Input {
        terminal: s.id,
        data: b"echo marker-$((40+2))\n".to_vec(),
    })
    .await
    .unwrap();
    output_until(&mut c, "marker-42").await;
    drop(c); // the "app" quits

    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut c2 = d.client().await;
    let list: Vec<TerminalInfo> = c2.request(methods::TERMINAL_LIST, ()).await.unwrap();
    assert!(
        list.iter().any(|x| x.id == s.id && x.exit.is_none()),
        "session still running"
    );
    let attach: AttachResult = c2
        .request(
            methods::TERMINAL_ATTACH,
            TerminalAttach {
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
        terminal: s.id,
        data: b"echo again-$((1+1))\n".to_vec(),
    })
    .await
    .unwrap();
    output_until(&mut c2, "again-2").await;
    let _: bool = c2
        .request(
            methods::TERMINAL_KILL,
            TerminalKill {
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

#[tokio::test]
async fn workspace_lifecycle_over_rpc() {
    use jaunt_proto::types::{GitStatus, Project, Session};
    let d = TestDaemon::start().await;
    let repo = d.home.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let git = |args: &[&str]| {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap()
                .status
                .success(),
            "git {args:?}"
        );
    };
    git(&["init", "-q", "-b", "main"]);
    git(&[
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
    ]);

    let mut c = d.client().await;
    let r: Project = c
        .request(methods::PROJECT_ADD, serde_json::json!({"path": repo}))
        .await
        .unwrap();
    let ws: Session = c
        .request(
            methods::SESSION_CREATE,
            serde_json::json!({"project_id": r.id, "name": "Add docs"}),
        )
        .await
        .unwrap();
    std::fs::write(std::path::Path::new(&ws.path).join("NOTES.md"), "# hi\n").unwrap();
    let st: GitStatus = c
        .request(
            methods::GIT_STATUS,
            serde_json::json!({"path": ws.path, "base": ws.base}),
        )
        .await
        .unwrap();
    assert_eq!(st.files.len(), 1);
    assert_eq!(st.branch.as_deref(), Some("jaunt/add-docs"));
    let shell: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            serde_json::json!({"cwd": "", "session_id": ws.id}),
        )
        .await
        .unwrap();
    assert_eq!(shell.cwd, ws.path);
    let _: bool = c
        .request(methods::SESSION_ARCHIVE, serde_json::json!({"id": ws.id}))
        .await
        .unwrap();
    assert!(!std::path::Path::new(&ws.path).exists());
}

#[tokio::test]
async fn terminals_do_not_inherit_the_daemon_starters_environment() {
    let home = tempfile::tempdir().unwrap();
    let socket = home.path().join("run").join("d.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_jauntd"))
        .arg("daemon")
        .env("JAUNT_HOME", home.path())
        .env("JAUNT_SOCK", &socket)
        .env("CLAUDE_CODE_MESSAGING_TOKEN", "leaked-secret")
        .env("CLAUDECODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    wait_for_socket(&socket, Duration::from_secs(15))
        .await
        .unwrap();
    let mut c = Client::connect(&socket, "test").await.unwrap();
    let t: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            TerminalCreate {
                cwd: home.path().display().to_string(),
                command: vec!["/bin/sh".into(), "-c".into(), "echo tok=[$CLAUDE_CODE_MESSAGING_TOKEN] cc=[$CLAUDECODE] home=[$HOME]; sleep 5".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let _: AttachResult = c
        .request(
            methods::TERMINAL_ATTACH,
            TerminalAttach {
                id: t.id,
                cols: None,
                rows: None,
            },
        )
        .await
        .unwrap();
    output_until(&mut c, "home=[").await;
    let screen: AttachResult = c
        .request(
            methods::TERMINAL_ATTACH,
            TerminalAttach {
                id: t.id,
                cols: None,
                rows: None,
            },
        )
        .await
        .unwrap();
    assert!(
        screen.snapshot.contains("tok=[] cc=[]"),
        "{}",
        screen.snapshot
    );
    let _ = child.kill();
    let _ = child.wait();
}

#[tokio::test]
async fn pulled_base_branch_is_where_new_sessions_start() {
    use jaunt_proto::types::{BasePull, BaseStatus, Project, Session};
    let d = TestDaemon::start().await;
    let root = d.home.path();
    let git = |dir: &std::path::Path, args: &[&str]| {
        let out = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    };
    let (origin, repo, other) = (
        root.join("origin.git"),
        root.join("repo"),
        root.join("other"),
    );
    git(
        root,
        &[
            "init",
            "-q",
            "--bare",
            "-b",
            "main",
            origin.to_str().unwrap(),
        ],
    );
    git(
        root,
        &[
            "clone",
            "-q",
            origin.to_str().unwrap(),
            repo.to_str().unwrap(),
        ],
    );
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(&repo, &["push", "-q", "origin", "main"]);
    git(
        root,
        &[
            "clone",
            "-q",
            origin.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    git(
        &other,
        &[
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "Merge pull request #128",
        ],
    );
    git(&other, &["push", "-q", "origin", "main"]);
    let merged = git(&other, &["rev-parse", "HEAD"]);

    let mut c = d.client().await;
    let p: Project = c
        .request(methods::PROJECT_ADD, serde_json::json!({"path": repo}))
        .await
        .unwrap();
    let st: BaseStatus = c
        .request(
            methods::GIT_BASE_STATUS,
            serde_json::json!({"path": p.path, "branch": p.base_branch, "fetch": true}),
        )
        .await
        .unwrap();
    assert_eq!((st.ahead, st.behind), (0, 1));
    assert_eq!(st.commits[0].subject, "Merge pull request #128");

    let pulled: BasePull = c
        .request(
            methods::GIT_PULL_BASE,
            serde_json::json!({"path": p.path, "branch": p.base_branch}),
        )
        .await
        .unwrap();
    assert_eq!(pulled.pulled, 1);
    assert_eq!(pulled.head, merged);

    let ws: Session = c
        .request(
            methods::SESSION_CREATE,
            serde_json::json!({"project_id": p.id, "name": "After merge", "agent": "none"}),
        )
        .await
        .unwrap();
    assert_eq!(
        git(std::path::Path::new(&ws.path), &["rev-parse", "HEAD"]),
        merged
    );
}
