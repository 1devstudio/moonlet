//! End-to-end tests against a real `moonletd` process.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::methods::{self, AttachResult, TerminalAttach, TerminalCreate, TerminalKill};
use moonlet_proto::types::{DaemonInfo, TerminalInfo};
use moonlet_proto::{Frame, Message, PROTOCOL_VERSION, read_frame, write_frame};

pub struct TestDaemon {
    pub home: tempfile::TempDir,
    pub socket: PathBuf,
    child: Child,
}

impl TestDaemon {
    pub async fn start() -> TestDaemon {
        Self::start_with(&[]).await
    }

    /// A daemon with extra environment, such as a PATH with a fake `gh` first.
    pub async fn start_with(env: &[(&str, String)]) -> TestDaemon {
        let home = tempfile::tempdir().unwrap();
        let socket = home.path().join("run").join("d.sock");
        let child = Command::new(env!("CARGO_BIN_EXE_moonletd"))
            .arg("daemon")
            .envs(env.iter().map(|(k, v)| (*k, v.as_str())))
            .env("MOONLET_HOME", home.path())
            .env("MOONLET_SOCK", &socket)
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
    use moonlet_proto::types::{GitStatus, Project, Session};
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
    assert_eq!(st.branch.as_deref(), Some("moonlet/add-docs"));
    let shell: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            serde_json::json!({"cwd": "", "session_id": ws.id}),
        )
        .await
        .unwrap();
    assert_eq!(shell.cwd, ws.path);
    let _: moonlet_proto::types::SessionArchived = c
        .request(methods::SESSION_ARCHIVE, serde_json::json!({"id": ws.id}))
        .await
        .unwrap();
    assert!(!std::path::Path::new(&ws.path).exists());
}

#[tokio::test]
async fn a_project_can_be_removed_from_a_section_over_rpc() {
    use moonlet_proto::types::{Project, Section, Workspace};
    let d = TestDaemon::start().await;
    let repo = d.home.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    assert!(
        Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(&repo)
            .status()
            .unwrap()
            .success()
    );

    let mut c = d.client().await;
    let all: Vec<Workspace> = c.request(methods::WORKSPACE_LIST, ()).await.unwrap();
    let sec: Section = c
        .request(
            methods::SECTION_CREATE,
            serde_json::json!({"workspace_id": all[0].id, "name": "Acme"}),
        )
        .await
        .unwrap();
    let p: Project = c
        .request(
            methods::SECTION_ADD_PROJECT,
            serde_json::json!({"id": sec.id, "path": repo}),
        )
        .await
        .unwrap();
    let _: bool = c
        .request(
            "section.remove_project",
            serde_json::json!({"id": sec.id, "project_id": p.id}),
        )
        .await
        .unwrap();
    let left: Vec<Project> = c.request(methods::PROJECT_LIST, ()).await.unwrap();
    assert!(left.is_empty());
}

/// X32: a new workspace takes a section from "Personal" with its sessions;
/// the emptied workspace can then be deleted only once it has no sections.
#[tokio::test]
async fn a_workspace_takes_sections_over_rpc() {
    use moonlet_proto::types::{Project, Section, Session, Workspace};
    let d = TestDaemon::start().await;
    let repo = d.home.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"],
    ] {
        assert!(Command::new("git").args(&args).current_dir(&repo).status().unwrap().success());
    }
    let mut c = d.client().await;
    let p: Project = c
        .request(methods::PROJECT_ADD, serde_json::json!({"path": repo}))
        .await
        .unwrap();
    let personal: Vec<Workspace> = c.request(methods::WORKSPACE_LIST, ()).await.unwrap();
    assert_eq!(personal.len(), 1);
    assert_eq!(personal[0].name, "Personal");
    let sections: Vec<Section> = c.request(methods::SECTION_LIST, ()).await.unwrap();
    let s: Session = c
        .request(
            methods::SESSION_CREATE,
            serde_json::json!({"project_id": p.id, "name": "Deploy", "agent": "none"}),
        )
        .await
        .unwrap();
    assert_eq!(s.workspace_id.as_deref(), Some(personal[0].id.as_str()));

    let work: Workspace = c
        .request(
            methods::WORKSPACE_CREATE,
            serde_json::json!({"name": "Acme", "color": "blue", "move_sections": [sections[0].id]}),
        )
        .await
        .unwrap();
    assert_eq!(work.section_ids, vec![sections[0].id.clone()]);
    // Only the design's five colours are accepted.
    let err = c
        .request::<_, Workspace>(methods::WORKSPACE_CREATE, serde_json::json!({"name": "Lab", "color": "#ff0000"}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("unknown variant `#ff0000`"), "{err}");
    let sessions: Vec<Session> = c.request(methods::SESSION_LIST, ()).await.unwrap();
    assert_eq!(sessions[0].workspace_id.as_deref(), Some(work.id.as_str()));

    let err = c
        .request::<_, bool>(methods::WORKSPACE_DELETE, serde_json::json!({"id": work.id}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("move or delete this workspace's sections first"), "{err}");
    let _: bool = c
        .request(methods::SECTION_MOVE, serde_json::json!({"id": sections[0].id, "workspace_id": personal[0].id}))
        .await
        .unwrap();
    let _: bool = c
        .request(methods::WORKSPACE_DELETE, serde_json::json!({"id": work.id}))
        .await
        .unwrap();
    let left: Vec<Workspace> = c.request(methods::WORKSPACE_LIST, ()).await.unwrap();
    assert_eq!(left.len(), 1);
}

#[tokio::test]
async fn terminals_do_not_inherit_the_daemon_starters_environment() {
    let home = tempfile::tempdir().unwrap();
    let socket = home.path().join("run").join("d.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_moonletd"))
        .arg("daemon")
        .env("MOONLET_HOME", home.path())
        .env("MOONLET_SOCK", &socket)
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
    use moonlet_proto::types::{BasePull, BaseStatus, Project, Session};
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

#[tokio::test]
async fn git_settings_are_kept_by_the_daemon_in_git_toml() {
    use moonlet_proto::types::GitSettings;
    let d = TestDaemon::start().await;
    let mut c = d.client().await;
    let s: GitSettings = c.request(methods::GIT_SETTINGS, serde_json::json!({})).await.unwrap();
    assert!(s.stage_all);
    assert!(!s.draft_prs);
    // Where its worktrees folder is, for the page.
    let info: DaemonInfo = c.request(methods::DAEMON_INFO, ()).await.unwrap();
    assert_eq!(std::path::Path::new(&info.data_dir), d.home.path());

    let s: GitSettings = c
        .request(methods::GIT_SET_SETTINGS, serde_json::json!({"draft_prs": true}))
        .await
        .unwrap();
    assert!(s.draft_prs);
    let text = std::fs::read_to_string(d.home.path().join("git.toml")).unwrap();
    assert!(text.contains("draft_prs = true"), "{text}");

    let mut other = d.client().await;
    let s: GitSettings = other.request(methods::GIT_SETTINGS, serde_json::json!({})).await.unwrap();
    assert!(s.draft_prs);
    assert!(s.stage_all);

    // Every client hears of a change, such as the app of one made with the CLI.
    let _: GitSettings = c
        .request(methods::GIT_SET_SETTINGS, serde_json::json!({"stage_all": false}))
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let f = tokio::time::timeout_at(deadline, other.next_frame()).await.expect("timeout").unwrap().unwrap();
        let Frame::Json(Message::Event { name, data }) = f else { continue };
        if name == methods::EV_GIT_SETTINGS_CHANGED {
            assert_eq!(data["stage_all"], false);
            assert_eq!(data["draft_prs"], true);
            break;
        }
    }
}

fn git_in(dir: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    if out.status.success() {
        Ok(String::from_utf8(out.stdout).unwrap().trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

async fn new_session(c: &mut Client, project: &str, name: &str) -> moonlet_proto::types::Session {
    c.request(
        methods::SESSION_CREATE,
        serde_json::json!({"project_id": project, "name": name, "agent": "none"}),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_new_sessions_branch_takes_the_hosts_prefix_unless_its_project_has_one() {
    let d = TestDaemon::start().await;
    let mut c = d.client().await;
    let (repo, p) = project_with_repo(&d, &mut c).await;
    assert_eq!(new_session(&mut c, &p.id, "Add search").await.branch, "moonlet/add-search");

    let _: serde_json::Value = c
        .request(methods::GIT_SET_SETTINGS, serde_json::json!({"branch_prefix": "marcin/"}))
        .await
        .unwrap();
    assert_eq!(new_session(&mut c, &p.id, "Add filters").await.branch, "marcin/add-filters");

    let _: serde_json::Value = c
        .request(methods::GIT_SET_SETTINGS, serde_json::json!({"branch_prefix": ""}))
        .await
        .unwrap();
    assert_eq!(new_session(&mut c, &p.id, "Add sorting").await.branch, "add-sorting");

    std::fs::create_dir_all(repo.join(".moonlet")).unwrap();
    std::fs::write(repo.join(".moonlet/config.toml"), "branch_prefix = \"team/\"\n").unwrap();
    assert_eq!(new_session(&mut c, &p.id, "Add paging").await.branch, "team/add-paging");

    let refused = c
        .request::<_, serde_json::Value>(methods::GIT_SET_SETTINGS, serde_json::json!({"branch_prefix": "my prefix/"}))
        .await;
    assert!(refused.is_err());
}

#[tokio::test]
async fn starting_from_origin_fetches_and_does_not_track_the_base() {
    use moonlet_proto::types::Project;
    let d = TestDaemon::start().await;
    let root = d.home.path();
    let git = |dir: &std::path::Path, args: &[&str]| git_in(dir, args).unwrap();
    let (origin, repo, other) = (root.join("origin.git"), root.join("repo"), root.join("other"));
    git(root, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    git(root, &["clone", "-q", origin.to_str().unwrap(), repo.to_str().unwrap()]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(&repo, &["push", "-q", "origin", "main"]);
    let local = git(&repo, &["rev-parse", "HEAD"]);
    git(root, &["clone", "-q", origin.to_str().unwrap(), other.to_str().unwrap()]);
    git(&other, &["commit", "-q", "--allow-empty", "-m", "Merge pull request #7"]);
    git(&other, &["push", "-q", "origin", "main"]);
    let merged = git(&other, &["rev-parse", "HEAD"]);

    let mut c = d.client().await;
    let p: Project = c
        .request(methods::PROJECT_ADD, serde_json::json!({"path": repo}))
        .await
        .unwrap();
    let local_session = new_session(&mut c, &p.id, "Before").await;
    assert_eq!(git(std::path::Path::new(&local_session.path), &["rev-parse", "HEAD"]), local);

    let _: serde_json::Value = c
        .request(methods::GIT_SET_SETTINGS, serde_json::json!({"start_from": "origin"}))
        .await
        .unwrap();
    let s = new_session(&mut c, &p.id, "After").await;
    let dir = std::path::Path::new(&s.path);
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), merged);
    assert_eq!(s.base, "main");
    assert!(git_in(dir, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_err(), "the branch tracks origin/main");
    assert_eq!(git(&repo, &["rev-parse", "main"]), local, "the local main moved");
}

#[tokio::test]
async fn starting_from_origin_without_one_starts_from_the_local_base() {
    let d = TestDaemon::start().await;
    let mut c = d.client().await;
    let (repo, p) = project_with_repo(&d, &mut c).await;
    let _: serde_json::Value = c
        .request(methods::GIT_SET_SETTINGS, serde_json::json!({"start_from": "origin"}))
        .await
        .unwrap();
    let s = new_session(&mut c, &p.id, "Offline").await;
    assert_eq!(
        git_in(std::path::Path::new(&s.path), &["rev-parse", "HEAD"]).unwrap(),
        git_in(&repo, &["rev-parse", "main"]).unwrap()
    );
}

#[tokio::test]
async fn archiving_can_delete_the_branch_on_origin_too() {
    use moonlet_proto::types::{Project, SessionArchived};
    let d = TestDaemon::start().await;
    let root = d.home.path();
    let git = |dir: &std::path::Path, args: &[&str]| git_in(dir, args).unwrap();
    let (origin, repo) = (root.join("origin.git"), root.join("repo"));
    git(root, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    git(root, &["clone", "-q", origin.to_str().unwrap(), repo.to_str().unwrap()]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(&repo, &["push", "-q", "origin", "main"]);
    let mut c = d.client().await;
    let p: Project = c
        .request(methods::PROJECT_ADD, serde_json::json!({"path": repo}))
        .await
        .unwrap();
    let s = new_session(&mut c, &p.id, "Merged work").await;
    git(std::path::Path::new(&s.path), &["push", "-q", "-u", "origin", "HEAD"]);
    assert_eq!(git(&origin, &["branch", "--list", &s.branch]).trim_start_matches(['*', ' ']), s.branch);

    let done: SessionArchived = c
        .request(
            methods::SESSION_ARCHIVE,
            serde_json::json!({"id": s.id, "delete_branch": true, "delete_remote": true}),
        )
        .await
        .unwrap();
    assert_eq!(done.remote_error, None);
    assert_eq!(git(&origin, &["branch", "--list", &s.branch]), "");
    assert_eq!(git(&repo, &["branch", "--list", &s.branch]), "");
}

#[tokio::test]
async fn archiving_never_deletes_the_projects_base_branch() {
    use moonlet_proto::types::{Project, Session, SessionArchived};
    let d = TestDaemon::start().await;
    let repo = d.home.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let git = |args: &[&str]| git_in(&repo, args).unwrap();
    git(&["init", "-q", "-b", "work"]);
    git(&["commit", "-q", "--allow-empty", "-m", "init"]);
    git(&["branch", "develop"]);
    let mut c = d.client().await;
    let p: Project = c
        .request(methods::PROJECT_ADD, serde_json::json!({"path": repo}))
        .await
        .unwrap();
    assert_eq!(p.base_branch, "develop");
    let s: Session = c
        .request(
            methods::SESSION_CREATE,
            serde_json::json!({"project_id": p.id, "name": "On develop", "agent": "none", "branch": "develop", "existing_branch": true}),
        )
        .await
        .unwrap();
    let _: SessionArchived = c
        .request(methods::SESSION_ARCHIVE, serde_json::json!({"id": s.id, "delete_branch": true}))
        .await
        .unwrap();
    assert_eq!(git(&["branch", "--list", "develop"]).trim_start_matches(['*', ' ', '+']), "develop");
}

#[tokio::test]
async fn unpushed_work_is_read_and_pushed_over_rpc() {
    use moonlet_proto::types::{Project, UnpushedWork};
    let d = TestDaemon::start().await;
    let root = d.home.path();
    let git = |dir: &std::path::Path, args: &[&str]| git_in(dir, args).unwrap();
    let (origin, repo) = (root.join("origin.git"), root.join("repo"));
    git(root, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    git(root, &["clone", "-q", origin.to_str().unwrap(), repo.to_str().unwrap()]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(&repo, &["push", "-q", "origin", "main"]);
    let mut c = d.client().await;
    let p: Project = c
        .request(methods::PROJECT_ADD, serde_json::json!({"path": repo}))
        .await
        .unwrap();
    let s = new_session(&mut c, &p.id, "Search").await;
    let dir = std::path::Path::new(&s.path);
    git(dir, &["commit", "-q", "--allow-empty", "-m", "ranking"]);
    std::fs::write(dir.join("index.ts"), "x\n").unwrap();

    let w: UnpushedWork = c
        .request(methods::GIT_UNPUSHED, serde_json::json!({"path": s.path}))
        .await
        .unwrap();
    assert_eq!((w.commits, w.upstream.as_deref(), w.files.len()), (1, None, 1));
    assert_eq!((w.files[0].status.as_str(), w.files[0].path.as_str()), ("?", "index.ts"));

    let _: bool = c.request(methods::GIT_PUSH, serde_json::json!({"path": s.path})).await.unwrap();
    let w: UnpushedWork = c
        .request(methods::GIT_UNPUSHED, serde_json::json!({"path": s.path}))
        .await
        .unwrap();
    assert_eq!(w.commits, 0);
    assert_eq!(w.upstream, Some(format!("origin/{}", s.branch)));
}

#[tokio::test]
async fn unpushed_work_is_read_from_the_session_branch_over_rpc() {
    use moonlet_proto::types::{Project, UnpushedWork};
    let d = TestDaemon::start().await;
    let root = d.home.path();
    let git = |dir: &std::path::Path, args: &[&str]| git_in(dir, args).unwrap();
    let (origin, repo) = (root.join("origin.git"), root.join("repo"));
    git(root, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    git(root, &["clone", "-q", origin.to_str().unwrap(), repo.to_str().unwrap()]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(&repo, &["push", "-q", "origin", "main"]);
    let mut c = d.client().await;
    let p: Project = c
        .request(methods::PROJECT_ADD, serde_json::json!({"path": repo}))
        .await
        .unwrap();
    let s = new_session(&mut c, &p.id, "Search").await;
    let dir = std::path::Path::new(&s.path);
    git(dir, &["commit", "-q", "--allow-empty", "-m", "ranking"]);
    let ranking = git(dir, &["rev-parse", "HEAD"]);
    // An agent moved the worktree to a branch of its own.
    git(dir, &["checkout", "-q", "-b", "refactor/lint", "main"]);
    git(dir, &["commit", "-q", "--allow-empty", "-m", "lint"]);

    let w: UnpushedWork = c
        .request(methods::GIT_UNPUSHED, serde_json::json!({"path": s.path, "branch": s.branch}))
        .await
        .unwrap();
    assert_eq!((w.commits, w.upstream), (1, None));
    let w: UnpushedWork = c
        .request(methods::GIT_UNPUSHED, serde_json::json!({"path": s.path, "branch": s.branch, "merged_head": ranking}))
        .await
        .unwrap();
    assert_eq!(w.commits, 0);

    let _: bool = c
        .request(methods::GIT_PUSH, serde_json::json!({"path": s.path, "branch": s.branch}))
        .await
        .unwrap();
    assert_eq!(git(&origin, &["log", "-1", "--format=%s", &s.branch]).trim(), "ranking");
    let w: UnpushedWork = c
        .request(methods::GIT_UNPUSHED, serde_json::json!({"path": s.path, "branch": s.branch}))
        .await
        .unwrap();
    assert_eq!((w.commits, w.upstream), (0, Some(format!("origin/{}", s.branch))));
}

#[tokio::test]
async fn archiving_still_archives_when_origin_refuses_the_delete() {
    use moonlet_proto::types::{Session, SessionArchived};
    let d = TestDaemon::start().await;
    let mut c = d.client().await;
    let (_repo, p) = project_with_repo(&d, &mut c).await;
    let s = new_session(&mut c, &p.id, "No origin").await;
    let done: SessionArchived = c
        .request(
            methods::SESSION_ARCHIVE,
            serde_json::json!({"id": s.id, "delete_branch": true, "delete_remote": true}),
        )
        .await
        .unwrap();
    assert!(done.remote_error.is_some());
    let list: Vec<Session> = c.request(methods::SESSION_LIST, ()).await.unwrap();
    assert!(list.iter().find(|x| x.id == s.id).unwrap().archived);
}

#[tokio::test]
async fn origin_url_over_rpc() {
    let d = TestDaemon::start().await;
    let repo = d.home.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let git = |args: &[&str]| {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(&repo)
                .status()
                .unwrap()
                .success(),
            "git {args:?}"
        );
    };
    git(&["init", "-q", "-b", "main"]);

    let mut c = d.client().await;
    let none: Option<String> = c
        .request(methods::GIT_ORIGIN_URL, serde_json::json!({"path": repo}))
        .await
        .unwrap();
    assert_eq!(none, None);

    git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/1devstudio/jaunt.git",
    ]);
    let url: Option<String> = c
        .request(methods::GIT_ORIGIN_URL, serde_json::json!({"path": repo}))
        .await
        .unwrap();
    assert_eq!(
        url.as_deref(),
        Some("https://github.com/1devstudio/jaunt.git")
    );
}

/// `shell.commands` (T8): the input editor's known commands, from the PATH
/// terminals get plus the shell's builtins.
#[tokio::test]
async fn lists_known_shell_commands() {
    let d = TestDaemon::start().await;
    let mut c = d.client().await;
    let names: Vec<String> = c
        .request(methods::SHELL_COMMANDS, serde_json::json!({ "shell": "zsh" }))
        .await
        .unwrap();
    for name in ["ls", "cd", "setopt"] {
        assert!(names.iter().any(|n| n == name), "{name} missing");
    }
}

/// X31: a daemon started from the user's install brings the moonlet skill
/// it installed up to date, so agents learn the new commands.
#[tokio::test]
async fn starting_refreshes_an_outdated_moonlet_skill() {
    let home = tempfile::tempdir().unwrap();
    let skill = home.path().join(".claude/skills/moonlet/SKILL.md");
    std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
    std::fs::write(&skill, "---\nname: moonlet\n---\n<!-- Installed by moonlet -->\nold\n").unwrap();
    // No MOONLET_HOME, as when the app starts it: the home is $HOME/.moonlet.
    let socket = home.path().join(".moonlet/run/moonletd.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_moonletd"))
        .arg("daemon")
        .env("HOME", home.path())
        .env_remove("MOONLET_SOCK")
        .env_remove("MOONLET_HOME")
        .env_remove("JAUNT_HOME")
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("CODEX_HOME")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    wait_for_socket(&socket, Duration::from_secs(15)).await.unwrap();
    // The socket listens before the daemon has finished starting.
    let mut text = String::new();
    for _ in 0..100 {
        text = std::fs::read_to_string(&skill).unwrap();
        if text.contains("term read") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = child.kill();
    let _ = child.wait();
    assert!(text.contains(r#""$MOONLET_BIN" term read <id>"#), "{text}");
    assert!(!home.path().join(".codex/skills/moonlet/SKILL.md").exists());
}

/// A daemon whose HOME is a scratch folder, so hook installs and skill
/// refreshes can never reach the user's ~/.claude. `path`: the PATH it starts
/// with; its terminals get a login shell's PATH built from it.
struct HomeDaemon {
    home: tempfile::TempDir,
    socket: PathBuf,
    child: Child,
}

impl HomeDaemon {
    async fn start(home: tempfile::TempDir, path: Option<&str>) -> HomeDaemon {
        let socket = home.path().join(".moonlet/run/moonletd.sock");
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_moonletd"));
        cmd.arg("daemon")
            .env("HOME", home.path())
            .env_remove("MOONLET_SOCK")
            .env_remove("MOONLET_HOME")
            .env_remove("JAUNT_HOME")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("CODEX_HOME")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(p) = path {
            cmd.env("PATH", p);
        }
        let child = cmd.spawn().unwrap();
        wait_for_socket(&socket, Duration::from_secs(15)).await.unwrap();
        HomeDaemon { home, socket, child }
    }

    async fn client(&self) -> Client {
        Client::connect(&self.socket, "test").await.unwrap()
    }
}

impl Drop for HomeDaemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A daemon whose terminals and agents find `script` as `claude`: it is
/// first on the login shell's PATH, which the rc files set.
async fn fake_claude_daemon(script: &str) -> HomeDaemon {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let bin = home.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let fake = bin.join("claude");
    std::fs::write(&fake, script).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let first = format!("PATH=\"{}:$PATH\"; export PATH\n", bin.display());
    for rc in [".profile", ".zshenv", ".zprofile", ".zshrc", ".bash_profile"] {
        std::fs::write(home.path().join(rc), &first).unwrap();
    }
    let path = format!("{}:/usr/bin:/bin", bin.display());
    HomeDaemon::start(home, Some(&path)).await
}

const OLD_SKILL: &str = "---\nname: moonlet\n---\n<!-- Installed by moonlet -->\nold\n";

/// X33: a profile gets moonlet's hooks in its own folder; it can be renamed;
/// a workspace can be created with it or switched to it and back; deleting
/// it keeps the folder and puts the workspace back on the default.
#[tokio::test]
async fn claude_profiles_over_rpc() {
    use moonlet_proto::types::{ClaudeProfile, ProfileInfo, Workspace};
    let d = HomeDaemon::start(tempfile::tempdir().unwrap(), None).await;
    let mut c = d.client().await;
    let dir = d.home.path().join("claude-work");
    let p: ClaudeProfile = c
        .request(methods::PROFILE_CREATE, serde_json::json!({"name": "Work profile", "path": dir}))
        .await
        .unwrap();
    assert_eq!(p.name, "Work profile");
    let settings = std::fs::read_to_string(dir.join("settings.json")).unwrap();
    assert!(settings.contains("hook claude"), "{settings}");
    assert!(dir.join("skills/moonlet/SKILL.md").exists());
    let renamed: ClaudeProfile = c
        .request(methods::PROFILE_UPDATE, serde_json::json!({"id": p.id, "name": "Client"}))
        .await
        .unwrap();
    assert_eq!(renamed.name, "Client");
    let list: Vec<ProfileInfo> = c.request(methods::PROFILE_LIST, ()).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].profile.name, "Client");
    assert!(list[0].hooks_installed);
    assert_eq!(list[0].account, None, "unknown until profile.status runs");

    let created: Workspace = c
        .request(methods::WORKSPACE_CREATE, serde_json::json!({"name": "Acme", "color": "blue", "claude_profile": p.id}))
        .await
        .unwrap();
    assert_eq!(created.claude_profile.as_deref(), Some(p.id.as_str()));
    let back: Workspace = c
        .request(methods::WORKSPACE_UPDATE, serde_json::json!({"id": created.id, "claude_profile": null}))
        .await
        .unwrap();
    assert_eq!(back.claude_profile, None);
    let unchanged: Workspace = c
        .request(methods::WORKSPACE_UPDATE, serde_json::json!({"id": created.id, "claude_profile": p.id}))
        .await
        .unwrap();
    let kept: Workspace = c
        .request(methods::WORKSPACE_UPDATE, serde_json::json!({"id": created.id, "name": "Acme Corp"}))
        .await
        .unwrap();
    assert_eq!(kept.claude_profile, unchanged.claude_profile, "absent leaves it as it is");
    let err = c
        .request::<_, Workspace>(methods::WORKSPACE_UPDATE, serde_json::json!({"id": created.id, "claude_profile": "nope"}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no such Claude profile"), "{err}");

    let _: bool = c.request(methods::PROFILE_DELETE, serde_json::json!({"id": p.id})).await.unwrap();
    assert!(dir.join("settings.json").exists(), "the folder stays");
    let ws: Vec<Workspace> = c.request(methods::WORKSPACE_LIST, ()).await.unwrap();
    assert!(ws.iter().all(|w| w.claude_profile.is_none()));
}

/// X33: a profile whose hooks cannot be installed is not kept.
#[tokio::test]
async fn a_profile_whose_hooks_fail_is_not_created() {
    use moonlet_proto::types::ProfileInfo;
    let d = HomeDaemon::start(tempfile::tempdir().unwrap(), None).await;
    let mut c = d.client().await;
    let dir = d.home.path().join("claude-broken");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("settings.json"), "[]").unwrap();
    let err = c
        .request::<_, serde_json::Value>(methods::PROFILE_CREATE, serde_json::json!({"name": "Broken", "path": dir}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("is not a JSON object"), "{err}");
    let list: Vec<ProfileInfo> = c.request(methods::PROFILE_LIST, ()).await.unwrap();
    assert!(list.is_empty());
}

/// X33: hooks.install and hooks.uninstall cover every profile's folder.
#[tokio::test]
async fn hooks_install_and_uninstall_cover_profile_folders() {
    let d = HomeDaemon::start(tempfile::tempdir().unwrap(), None).await;
    let mut c = d.client().await;
    let dir = d.home.path().join("claude-work");
    let _: serde_json::Value = c.request(methods::PROFILE_CREATE, serde_json::json!({"name": "Work", "path": dir})).await.unwrap();
    // Take the profile's hooks out by hand, as an older moonlet would have left them.
    std::fs::write(dir.join("settings.json"), "{}").unwrap();
    let _: serde_json::Value = c.request(methods::HOOKS_INSTALL, serde_json::json!({"claude": true, "codex": false})).await.unwrap();
    assert!(std::fs::read_to_string(dir.join("settings.json")).unwrap().contains("hook claude"));
    assert!(std::fs::read_to_string(d.home.path().join(".claude/settings.json")).unwrap().contains("hook claude"));
    let _: serde_json::Value = c.request(methods::HOOKS_UNINSTALL, ()).await.unwrap();
    assert!(!std::fs::read_to_string(dir.join("settings.json")).unwrap().contains("hook claude"));
    assert!(!dir.join("skills/moonlet/SKILL.md").exists());
}

/// X33: profile.status asks `claude auth status` with the profile's folder,
/// and profile.list remembers the account. A fake `claude` answers.
#[tokio::test]
async fn profile_status_reads_who_a_profile_is_signed_in_as() {
    use moonlet_proto::types::{ClaudeProfile, ProfileAccount, ProfileInfo};
    let d = fake_claude_daemon(
        r#"#!/bin/sh
if [ "$1 $2" = "auth status" ] && [ -n "$CLAUDE_CONFIG_DIR" ]; then
  echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "jane@acme.example", "orgName": "Acme", "subscriptionType": "team"}'
else
  echo '{"loggedIn": false, "authMethod": "none"}'
fi
"#,
    )
    .await;
    let mut c = d.client().await;
    let p: ClaudeProfile = c
        .request(methods::PROFILE_CREATE, serde_json::json!({"name": "Work", "path": d.home.path().join("claude-work")}))
        .await
        .unwrap();
    let account: ProfileAccount = c.request(methods::PROFILE_STATUS, serde_json::json!({"id": p.id})).await.unwrap();
    assert_eq!(account, ProfileAccount { logged_in: true, email: Some("jane@acme.example".into()), org_name: Some("Acme".into()) });
    let list: Vec<ProfileInfo> = c.request(methods::PROFILE_LIST, ()).await.unwrap();
    assert_eq!(list[0].account.as_ref().map(|a| a.logged_in), Some(true));
    let default: ProfileAccount = c.request(methods::PROFILE_STATUS, serde_json::json!({})).await.unwrap();
    assert!(!default.logged_in);
}

/// X33: starting refreshes the moonlet skill in every profile's folder too.
#[tokio::test]
async fn starting_refreshes_the_skill_of_every_profile() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("claude-work");
    let skill = dir.join("skills/moonlet/SKILL.md");
    std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
    std::fs::write(&skill, OLD_SKILL).unwrap();
    std::fs::create_dir_all(home.path().join(".moonlet")).unwrap();
    let state = serde_json::json!({"version": 3, "profiles": [{"id": "p1", "name": "Work", "path": dir, "created_at": 0}]});
    std::fs::write(home.path().join(".moonlet/state.json"), state.to_string()).unwrap();
    let d = HomeDaemon::start(home, None).await;
    let mut text = String::new();
    for _ in 0..100 {
        text = std::fs::read_to_string(&skill).unwrap();
        if text != OLD_SKILL {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    drop(d);
    assert!(text.contains("term read"), "{text}");
}

/// X36: claude.version asks the `claude` agents run for its version, and
/// claude.update runs `claude update`, streaming its lines to every client
/// and refusing a second run meanwhile. A fake `claude` answers.
#[tokio::test]
async fn claude_update_streams_the_lines_of_claude_update() {
    // The lines `claude update` 2.1.292 prints for a native install.
    let d = fake_claude_daemon(
        r#"#!/bin/sh
case "$1" in
  --version) echo "2.1.292 (Claude Code)" ;;
  update)
    echo "Current version: 2.1.292"
    echo "Checking for updates to latest version..."
    echo "Updating to 2.1.296..."
    sleep 1
    echo "Successfully updated from 2.1.292 to version 2.1.296"
    ;;
esac
"#,
    )
    .await;
    let mut c = d.client().await;
    let version: serde_json::Value = c.request(methods::CLAUDE_VERSION, ()).await.unwrap();
    assert_eq!(version, serde_json::json!({"version": "2.1.292", "updating": false}));

    let mut watcher = d.client().await;
    let mut second = d.client().await;
    let run = tokio::spawn(async move { c.request::<_, serde_json::Value>(methods::CLAUDE_UPDATE, ()).await.unwrap() });
    let mut lines = Vec::new();
    let mut done = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while done.is_none() {
        let f = tokio::time::timeout_at(deadline, watcher.next_frame()).await.expect("timeout").unwrap().unwrap();
        let Frame::Json(Message::Event { name, data }) = f else { continue };
        if name == methods::EV_CLAUDE_UPDATE_OUTPUT {
            let line = data["line"].as_str().unwrap().to_string();
            // Mid-run, with the fake asleep: a second client sees the run
            // and cannot start another.
            if line == "Updating to 2.1.296..." {
                let version: serde_json::Value = second.request(methods::CLAUDE_VERSION, ()).await.unwrap();
                assert_eq!(version, serde_json::json!({"version": "2.1.292", "updating": true}));
                let busy = second.request::<_, serde_json::Value>(methods::CLAUDE_UPDATE, ()).await.unwrap_err();
                assert!(busy.to_string().contains("Claude Code is already updating"), "{busy}");
            }
            lines.push(line);
        } else if name == methods::EV_CLAUDE_UPDATE_DONE {
            done = Some(data);
        }
    }
    assert_eq!(
        lines,
        [
            "Current version: 2.1.292",
            "Checking for updates to latest version...",
            "Updating to 2.1.296...",
            "Successfully updated from 2.1.292 to version 2.1.296"
        ]
    );
    let result = serde_json::json!({
        "ok": true,
        "output": "Current version: 2.1.292\nChecking for updates to latest version...\nUpdating to 2.1.296...\nSuccessfully updated from 2.1.292 to version 2.1.296\n"
    });
    // Every window learns how it ended, not only the one that asked.
    assert_eq!(done, Some(result.clone()));
    assert_eq!(run.await.unwrap(), result);
    let version: serde_json::Value = second.request(methods::CLAUDE_VERSION, ()).await.unwrap();
    assert_eq!(version["updating"], false);
}

/// A git repository with one commit, added as a project.
async fn project_with_repo(
    d: &TestDaemon,
    c: &mut Client,
) -> (PathBuf, moonlet_proto::types::Project) {
    let repo = d.home.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ],
    ] {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(&repo)
                .status()
                .unwrap()
                .success(),
            "git {args:?}"
        );
    }
    let p = c
        .request(methods::PROJECT_ADD, serde_json::json!({"path": repo}))
        .await
        .unwrap();
    (repo, p)
}

#[tokio::test]
async fn a_session_started_from_a_task_keeps_its_link() {
    use moonlet_proto::types::Session;
    let d = TestDaemon::start().await;
    let mut c = d.client().await;
    let (_, p) = project_with_repo(&d, &mut c).await;
    let task = serde_json::json!({
        "connection": "linear:acme",
        "key": "MOON-151",
        "url": "https://linear.app/acme/issue/MOON-151/drag-sessions"
    });
    let s: Session = c
        .request(
            methods::SESSION_CREATE,
            serde_json::json!({
                "project_id": p.id,
                "name": "Drag sessions between sections",
                "branch": "moon-151-drag-sessions-between-sections",
                "task": task,
            }),
        )
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(&s.task).unwrap(), task);
    let all: Vec<Session> = c.request(methods::SESSION_LIST, ()).await.unwrap();
    assert_eq!(serde_json::to_value(&all[0].task).unwrap(), task);
}

#[tokio::test]
async fn a_session_can_be_linked_to_a_task_and_unlinked() {
    use moonlet_proto::types::Session;
    let d = TestDaemon::start().await;
    let mut c = d.client().await;
    let (_, p) = project_with_repo(&d, &mut c).await;
    let s: Session = c
        .request(
            methods::SESSION_CREATE,
            serde_json::json!({"project_id": p.id, "name": "Changelog themes", "branch": "themes"}),
        )
        .await
        .unwrap();
    assert_eq!(s.task, None);
    let task = serde_json::json!({
        "connection": "linear:acme",
        "key": "CDK-41",
        "url": "https://linear.app/acme/issue/CDK-41/changelog-themes"
    });
    let linked: Session = c
        .request(
            methods::SESSION_UPDATE,
            serde_json::json!({"id": s.id, "task": task}),
        )
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(&linked.task).unwrap(), task);
    assert!(!linked.task_unlinked);

    // A rename leaves the link alone.
    let renamed: Session = c
        .request(
            methods::SESSION_UPDATE,
            serde_json::json!({"id": s.id, "name": "Themes"}),
        )
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(&renamed.task).unwrap(), task);

    let unlinked: Session = c
        .request(
            methods::SESSION_UPDATE,
            serde_json::json!({"id": s.id, "task": null}),
        )
        .await
        .unwrap();
    assert_eq!(unlinked.task, None);
    assert!(unlinked.task_unlinked);

    // Linking again ends the unlinked state.
    let relinked: Session = c
        .request(
            methods::SESSION_UPDATE,
            serde_json::json!({"id": s.id, "task": task}),
        )
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(&relinked.task).unwrap(), task);
    assert!(!relinked.task_unlinked);
}

/// `git worktree add -q <args> <dir>` in `repo`, returning `dir` as git
/// reports it.
fn add_worktree(repo: &std::path::Path, args: &[&str], dir: &std::path::Path) -> String {
    assert!(
        Command::new("git")
            .args(["worktree", "add", "-q"])
            .args(args)
            .arg(dir)
            .current_dir(repo)
            .status()
            .unwrap()
            .success()
    );
    std::fs::canonicalize(dir).unwrap().display().to_string()
}

#[tokio::test]
async fn worktrees_made_outside_moonlet_are_listed_and_can_be_adopted() {
    use moonlet_proto::types::Session;
    let d = TestDaemon::start().await;
    let mut c = d.client().await;
    let (repo, p) = project_with_repo(&d, &mut c).await;
    let wt = add_worktree(&repo, &["-b", "moon-149-host-health"], &d.home.path().join("moon-149-host-health"));
    // The same worktree reached through a symlink, as `/var` is on macOS. The
    // link sits outside home, so nothing walking home loops through it.
    let links = tempfile::tempdir().unwrap();
    let link = links.path().join("home");
    std::os::unix::fs::symlink(d.home.path(), &link).unwrap();
    let wt_as_given = link.join("moon-149-host-health");

    let list: serde_json::Value = c
        .request(methods::PROJECT_WORKTREES, serde_json::json!({"id": p.id}))
        .await
        .unwrap();
    let list = list.as_array().unwrap();
    // The project's own checkout is not one of its worktrees.
    assert_eq!(list.len(), 1, "{list:?}");
    assert_eq!(list[0]["path"], wt);
    assert_eq!(list[0]["branch"], "moon-149-host-health");
    assert!(list[0]["last_commit_ms"].as_u64().unwrap() > 1_600_000_000_000);

    let s: Session = c
        .request(
            methods::SESSION_CREATE,
            serde_json::json!({
                "project_id": p.id,
                "name": "Show remote host health in the sidebar footer",
                // The path as the user's temp dir spells it, not as git does.
                "worktree": wt_as_given.display().to_string(),
            }),
        )
        .await
        .unwrap();
    assert_eq!(s.path, wt);
    assert_eq!(s.branch, "moon-149-host-health");

    // Only a worktree of the project, on a branch, can be adopted.
    let adopt = |dir: String| serde_json::json!({"project_id": p.id, "name": "Adopt", "worktree": dir});
    let err = c
        .request::<_, Session>(methods::SESSION_CREATE, adopt(repo.display().to_string()))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("is not a worktree of this project"), "{err}");
    let detached = add_worktree(&repo, &["--detach"], &d.home.path().join("detached"));
    let err = c
        .request::<_, Session>(methods::SESSION_CREATE, adopt(detached))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("is on a detached HEAD"), "{err}");

    // A worktree a session already uses cannot be adopted twice.
    let err = c
        .request::<_, Session>(
            methods::SESSION_CREATE,
            serde_json::json!({"project_id": p.id, "name": "Again", "worktree": wt}),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("is used by session"), "{err}");
    let err = c
        .request::<_, Session>(
            methods::SESSION_CREATE,
            serde_json::json!({"project_id": p.id, "name": "Again", "worktree": wt_as_given}),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("is used by session"), "{err}");
}

/// A daemon whose `gh` is `script`. moonletd takes PATH from a login shell, so
/// the fake goes first in every startup file of a scratch HOME (as the e2e
/// world does). The temp dirs live as long as the daemon is used.
async fn fake_gh_daemon(script: &str) -> (TestDaemon, Vec<tempfile::TempDir>) {
    use std::os::unix::fs::PermissionsExt;
    let bin = tempfile::tempdir().unwrap();
    let gh = bin.path().join("gh");
    std::fs::write(&gh, script).unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let home = tempfile::tempdir().unwrap();
    let first = format!("PATH=\"{}:$PATH\"; export PATH\n", bin.path().display());
    for rc in [".profile", ".zshenv", ".zprofile", ".zshrc"] {
        std::fs::write(home.path().join(rc), &first).unwrap();
    }
    let d = TestDaemon::start_with(&[
        ("HOME", home.path().display().to_string()),
        ("SHELL", "/bin/zsh".into()),
        ("GH_LOG", bin.path().join("gh.log").display().to_string()),
    ])
    .await;
    (d, vec![bin, home])
}

#[tokio::test]
async fn one_github_issue_by_its_number_through_gh() {
    // A fake gh that prints one issue as `gh issue view --json` does.
    let (d, dirs) = fake_gh_daemon(
        "#!/bin/sh\necho \"$@\" >> \"$GH_LOG\"\ncat <<'JSON'\n{\"number\":7,\"title\":\"Gift cards\",\"body\":\"\",\"url\":\"https://github.com/acme/web/issues/7\",\"state\":\"OPEN\",\"stateReason\":\"\",\"assignees\":[],\"labels\":[],\"updatedAt\":\"2026-10-14T09:00:00Z\",\"closedByPullRequestsReferences\":[]}\nJSON\n",
    )
    .await;
    let mut c = d.client().await;
    let (repo, _) = project_with_repo(&d, &mut c).await;
    let task: serde_json::Value = c
        .request(methods::GH_TASK, serde_json::json!({"path": repo, "repo": "acme/web", "number": 7}))
        .await
        .unwrap();
    assert_eq!((task["repo"].as_str(), task["number"].as_u64(), task["title"].as_str()), (Some("acme/web"), Some(7), Some("Gift cards")));
    let asked = std::fs::read_to_string(dirs[0].path().join("gh.log")).unwrap();
    assert!(asked.starts_with("issue view 7 --repo acme/web --json "), "{asked}");
    // Only an owner/name repository reaches gh.
    let err = c
        .request::<_, serde_json::Value>(methods::GH_TASK, serde_json::json!({"path": repo, "repo": "--help", "number": 7}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not a GitHub repository"), "{err}");
}

#[tokio::test]
async fn a_pr_context_holds_its_reviews_and_comments() {
    // A fake gh that answers `pr view` and the line comments' `api` call
    // with one each, and fails the line comments of #215, as for a fork.
    let (d, dirs) = fake_gh_daemon(
        "#!/bin/sh\necho \"$@\" >> \"$GH_LOG\"\n\
         case \"$1 $2\" in\n\
         \"pr view\") cat <<'JSON'\n{\"author\":{\"login\":\"sam-rivera\"},\"body\":\"Fixes #279.\",\"reviews\":[{\"author\":{\"login\":\"jo-park\"},\"authorAssociation\":\"MEMBER\",\"state\":\"CHANGES_REQUESTED\",\"body\":\"Keep Security for admins.\"}],\"comments\":[]}\nJSON\n;;\n\
         \"api repos/{owner}/{repo}/pulls/215/comments?per_page=100\") echo 'HTTP 404: Not Found' >&2; exit 1;;\n\
         \"api \"*) cat <<'JSON'\n[{\"user\":{\"login\":\"lee-moreno\"},\"author_association\":\"COLLABORATOR\",\"path\":\"src/nav/SideNav.tsx\",\"line\":12,\"original_line\":12,\"body\":\"Drop the footer link too.\"}]\nJSON\n;;\n\
         esac\n",
    )
    .await;
    let mut c = d.client().await;
    let (repo, _) = project_with_repo(&d, &mut c).await;
    let text: String = c.request(methods::GH_PR_CONTEXT, serde_json::json!({"path": repo, "number": 214})).await.unwrap();
    assert_eq!(
        text,
        "Fixes #279.\n\nReviews:\n- @jo-park, changes requested: Keep Security for admins.\n\nReview comments:\n- @lee-moreno on src/nav/SideNav.tsx:12: Drop the footer link too."
    );
    let asked = std::fs::read_to_string(dirs[0].path().join("gh.log")).unwrap();
    assert!(asked.contains("pr view 214 --json author,body,reviews,comments\napi repos/{owner}/{repo}/pulls/214/comments?per_page=100\n"), "{asked}");
    // Without its line comments, the rest still comes.
    let text: String = c.request(methods::GH_PR_CONTEXT, serde_json::json!({"path": repo, "number": 215})).await.unwrap();
    assert_eq!(text, "Fixes #279.\n\nReviews:\n- @jo-park, changes requested: Keep Security for admins.");
}

#[tokio::test]
async fn an_issues_comments_are_read_and_a_new_one_posted_through_gh() {
    // A fake gh that prints the captured comments for `issue view`, and
    // keeps what `issue comment` reads on stdin.
    let fixture = format!("{}/../moonlet-core/tests/fixtures/gh-issue-comments.json", env!("CARGO_MANIFEST_DIR"));
    let (d, dirs) = fake_gh_daemon(&format!(
        "#!/bin/sh\necho \"$@\" >> \"$GH_LOG\"\n\
         case \"$1 $2\" in\n\
         \"issue view\") cat '{fixture}';;\n\
         \"issue comment\") cat > \"$GH_LOG.body\";;\n\
         esac\n"
    ))
    .await;
    let log = dirs[0].path().join("gh.log");
    let mut c = d.client().await;
    let (repo, _) = project_with_repo(&d, &mut c).await;

    let got: serde_json::Value = c.request(methods::GH_ISSUE_COMMENTS, serde_json::json!({"path": repo, "number": 12})).await.unwrap();
    assert_eq!(
        got,
        serde_json::json!({"comments": [
            {"id": "IC_e2e0001", "author": "@sam-rivera", "body": "Looks good. Can we **also** cover `ClickUp`?\n\n- [ ] one\n- [x] two\n", "created_ms": 1_792_767_974_000u64},
            {"id": "IC_e2e0003", "author": "@lee-moreno", "body": "Done in #13.", "created_ms": 1_792_771_200_000u64}
        ], "more": false})
    );
    let _: bool = c
        .request(methods::GH_ISSUE_COMMENT, serde_json::json!({"path": repo, "number": 12, "body": "--help; picked this up"}))
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(&log).unwrap(), "issue view 12 --json comments\nissue comment 12 --body-file -\n");
    assert_eq!(std::fs::read_to_string(dirs[0].path().join("gh.log.body")).unwrap(), "--help; picked this up");
}

#[tokio::test]
async fn task_updates_reach_github_through_gh() {
    // A fake gh that records what it was asked to do.
    let (d, dirs) = fake_gh_daemon("#!/bin/sh\necho \"$@\" >> \"$GH_LOG\"\n").await;
    let log = dirs[0].path().join("gh.log");
    let mut c = d.client().await;
    let (repo, _) = project_with_repo(&d, &mut c).await;

    let _: bool = c
        .request(methods::GH_TASK_UPDATE, serde_json::json!({"path": repo, "number": 15, "assign_me": true}))
        .await
        .unwrap();
    let _: bool = c
        .request(methods::GH_TASK_UPDATE, serde_json::json!({"path": repo, "number": 15, "close": true}))
        .await
        .unwrap();
    let _: bool = c
        .request(methods::GH_TASK_UPDATE, serde_json::json!({"path": repo, "number": 15, "reopen": true}))
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&log).unwrap(),
        "issue edit 15 --add-assignee @me\nissue close 15 --reason completed\nissue reopen 15\n"
    );
}

#[tokio::test]
async fn the_github_login_comes_from_gh() {
    let (d, _dirs) = fake_gh_daemon("#!/bin/sh\n[ \"$*\" = \"api user --jq .login\" ] && echo sam-rivera && exit 0\nexit 1\n").await;
    let mut c = d.client().await;
    let login: String = c.request(methods::GH_WHOAMI, serde_json::json!({})).await.unwrap();
    assert_eq!(login, "sam-rivera");
}

#[tokio::test]
async fn a_gh_without_a_login_says_so() {
    let (d, _dirs) = fake_gh_daemon("#!/bin/sh\necho 'To get started with GitHub CLI, please run:  gh auth login' >&2\nexit 4\n").await;
    let mut c = d.client().await;
    let err = c.request::<_, String>(methods::GH_WHOAMI, serde_json::json!({})).await.unwrap_err();
    assert!(err.to_string().contains("gh auth login"), "{err}");
}

#[tokio::test]
async fn a_worktree_without_a_session_can_be_removed() {
    use moonlet_proto::types::{Session, Worktree};
    let d = TestDaemon::start().await;
    let mut c = d.client().await;
    let (repo, p) = project_with_repo(&d, &mut c).await;
    let wt = add_worktree(&repo, &["-b", "moon-131-old"], &d.home.path().join("moon-131-old"));
    let s: Session = c
        .request(methods::SESSION_CREATE, serde_json::json!({"project_id": p.id, "name": "Codex hooks", "agent": "none"}))
        .await
        .unwrap();

    // Neither the project's own checkout nor a session's worktree.
    for (dir, why) in [(repo.display().to_string(), "is not a worktree of this project"), (s.path.clone(), "is used by session Codex hooks")] {
        let err = c
            .request::<_, bool>(methods::PROJECT_WORKTREE_REMOVE, serde_json::json!({"id": p.id, "path": dir}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains(why), "{err}");
    }

    let _: bool = c
        .request(methods::PROJECT_WORKTREE_REMOVE, serde_json::json!({"id": p.id, "path": wt}))
        .await
        .unwrap();
    assert!(!std::path::Path::new(&wt).exists());
    let left: Vec<Worktree> = c.request(methods::PROJECT_WORKTREES, serde_json::json!({"id": p.id})).await.unwrap();
    assert_eq!(left.iter().map(|w| w.path.as_str()).collect::<Vec<_>>(), [s.path.as_str()]);
}

/// A login item or launchd job that starts a second daemon while one is
/// serving gets exit code 0, so launchd does not restart it (S1b, X56).
#[tokio::test]
async fn a_second_daemon_exits_with_0_while_one_is_listening() {
    let d = TestDaemon::start().await;
    let mut second = Command::new(env!("CARGO_BIN_EXE_moonletd"))
        .arg("daemon")
        .env("MOONLET_HOME", d.home.path())
        .env("MOONLET_SOCK", &d.socket)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = second.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() > deadline {
            let _ = second.kill();
            panic!("the second daemon kept running");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(status.code(), Some(0));
    // The first one still serves.
    d.client().await;
}

/// A fake gh signed in as sam-rivera, whose `repo clone` runs `clone`
/// with the folder as `$4` (X59).
fn fake_clone_gh(clone: &str) -> String {
    format!(
        "#!/bin/sh\necho \"$@\" >> \"$GH_LOG\"\ncase \"$1 $2\" in\n  \"auth status\") printf 'github.com\\n  ✓ Logged in to github.com account sam-rivera (keyring)\\n  - Active account: true\\n' ;;\n  \"repo clone\") {clone} ;;\nesac\n"
    )
}

/// Events until `repo.clone_done`: the progress steps seen, and the done.
async fn clone_events(c: &mut Client) -> (Vec<String>, serde_json::Value) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut steps = Vec::new();
    loop {
        let f = tokio::time::timeout_at(deadline, c.next_frame()).await.expect("timeout").unwrap().unwrap();
        let Frame::Json(Message::Event { name, data }) = f else { continue };
        if name == methods::EV_REPO_CLONE_PROGRESS {
            steps.push(data["step"].as_str().unwrap().to_string());
        } else if name == methods::EV_REPO_CLONE_DONE {
            return (steps, data);
        }
    }
}

#[tokio::test]
async fn a_clone_from_github_becomes_a_project_and_reports_its_progress() {
    let origin = tempfile::tempdir().unwrap();
    let src = origin.path().join("src");
    std::fs::create_dir(&src).unwrap();
    git_in(&src, &["init", "-q", "-b", "main"]).unwrap();
    git_in(&src, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]).unwrap();
    git_in(origin.path(), &["clone", "-q", "--bare", "src", "storefront.git"]).unwrap();
    let bare = origin.path().join("storefront.git");
    let (d, dirs) = fake_gh_daemon(&fake_clone_gh(&format!("exec git clone --progress \"file://{}\" \"$4\"", bare.display()))).await;
    let mut c = d.client().await;
    let mut watcher = d.client().await;
    let parent = dirs[1].path().join("moonlet");
    let job: serde_json::Value = c
        .request(methods::REPO_CLONE, serde_json::json!({"id": "c-7f3a", "repo": "acme/storefront", "parent": parent, "name": "storefront"}))
        .await
        .unwrap();
    let path = parent.join("storefront").display().to_string();
    // The app names the clone, so it knows the clone's events before the reply.
    assert_eq!(job, serde_json::json!({"id": "c-7f3a", "repo": "acme/storefront", "path": path}));

    let (steps, done) = clone_events(&mut watcher).await;
    assert!(steps.contains(&"counting".to_string()), "{steps:?}");
    assert_eq!(done["id"], "c-7f3a");
    assert_eq!((done["error"].clone(), done["cancelled"].clone()), (serde_json::Value::Null, serde_json::json!(false)));
    // Projects keep the folder's real path (/private/var for /var on macOS).
    let real = std::fs::canonicalize(&path).unwrap().display().to_string();
    assert_eq!((done["project"]["name"].as_str(), done["project"]["path"].as_str()), (Some("storefront"), Some(real.as_str())));
    let projects: Vec<moonlet_proto::types::Project> = c.request(methods::PROJECT_LIST, ()).await.unwrap();
    assert!(projects.iter().any(|p| p.path == real), "{projects:?}");
    let asked = std::fs::read_to_string(dirs[0].path().join("gh.log")).unwrap();
    assert!(asked.contains(&format!("repo clone acme/storefront {path} -- --progress")), "{asked}");

    // The folder is there now: a second clone into it is refused.
    let again = c
        .request::<_, serde_json::Value>(methods::REPO_CLONE, serde_json::json!({"id": "c-2", "repo": "acme/storefront", "parent": parent, "name": "storefront"}))
        .await
        .unwrap_err();
    assert!(again.to_string().contains(&format!("{path} already exists")), "{again}");
    let bad_id = c
        .request::<_, serde_json::Value>(methods::REPO_CLONE, serde_json::json!({"id": "--x y", "repo": "acme/storefront", "parent": parent, "name": "other"}))
        .await
        .unwrap_err();
    assert!(bad_id.to_string().contains("not a clone id: --x y"), "{bad_id}");
    // Only an owner/name repository reaches gh.
    let bad = c
        .request::<_, serde_json::Value>(methods::REPO_CLONE, serde_json::json!({"id": "c-3", "repo": "--upload-pack=x/y", "parent": parent, "name": "y"}))
        .await
        .unwrap_err();
    assert!(bad.to_string().contains("not a GitHub repository"), "{bad}");
}

#[tokio::test]
async fn a_failed_clone_says_why_and_leaves_no_folder() {
    let (d, dirs) = fake_gh_daemon(&fake_clone_gh(
        "mkdir \"$4\"; echo \"Cloning into '$4'...\" >&2; echo 'remote: Repository not found.' >&2; echo \"fatal: repository 'https://github.com/acme/nope.git/' not found\" >&2; exit 128",
    ))
    .await;
    let mut c = d.client().await;
    let mut watcher = d.client().await;
    let parent = dirs[1].path().join("moonlet");
    let _: serde_json::Value = c.request(methods::REPO_CLONE, serde_json::json!({"id": "c-1", "repo": "acme/nope", "parent": parent, "name": "nope"})).await.unwrap();
    let (_, done) = clone_events(&mut watcher).await;
    assert_eq!(done["error"], "repository 'https://github.com/acme/nope.git/' not found");
    assert_eq!(done["project"], serde_json::Value::Null);
    assert!(!parent.join("nope").exists());
}

#[tokio::test]
async fn a_cancelled_clone_stops_and_leaves_no_folder() {
    let (d, dirs) = fake_gh_daemon(&fake_clone_gh("mkdir \"$4\"; touch \"$4/partial\"; sleep 30")).await;
    let mut c = d.client().await;
    let mut watcher = d.client().await;
    let parent = dirs[1].path().join("moonlet");
    let job: serde_json::Value = c.request(methods::REPO_CLONE, serde_json::json!({"id": "c-1", "repo": "acme/big", "parent": parent, "name": "big"})).await.unwrap();
    let folder = parent.join("big");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !folder.join("partial").exists() {
        assert!(tokio::time::Instant::now() < deadline, "the clone never started");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // While it runs, a second clone into the same folder is refused.
    let twice = c
        .request::<_, serde_json::Value>(methods::REPO_CLONE, serde_json::json!({"id": "c-2", "repo": "acme/big", "parent": parent, "name": "big"}))
        .await
        .unwrap_err();
    assert!(twice.to_string().contains(&format!("{} is being cloned already", folder.display())), "{twice}");
    let cancelled: bool = c.request(methods::REPO_CLONE_CANCEL, serde_json::json!({"id": job["id"]})).await.unwrap();
    assert!(cancelled);
    let (_, done) = clone_events(&mut watcher).await;
    assert_eq!((done["cancelled"].clone(), done["error"].clone()), (serde_json::json!(true), serde_json::Value::Null));
    assert!(!folder.exists());
    let projects: Vec<moonlet_proto::types::Project> = c.request(methods::PROJECT_LIST, ()).await.unwrap();
    assert!(projects.is_empty(), "{projects:?}");
}

#[tokio::test]
async fn looks_repositories_up_and_lists_them_through_gh() {
    let fixtures = concat!(env!("CARGO_MANIFEST_DIR"), "/../moonlet-core/tests/fixtures");
    let (d, _dirs) = fake_gh_daemon(&format!(
        "#!/bin/sh\ncase \"$1 $2\" in\n  \"auth status\") cat '{fixtures}/gh-auth-status.txt' ;;\n  \"repo view\") cat '{fixtures}/gh-repo-view.json' ;;\n  \"api user/repos\"*) cat '{fixtures}/gh-user-repos.json' ;;\nesac\n"
    ))
    .await;
    let mut c = d.client().await;
    let status: serde_json::Value = c.request(methods::REPO_GH_STATUS, ()).await.unwrap();
    assert_eq!(status, serde_json::json!({"installed": true, "login": "sam-rivera"}));
    let info: serde_json::Value = c.request(methods::REPO_LOOKUP, serde_json::json!({"repo": "acme/storefront"})).await.unwrap();
    assert_eq!((info["repo"].as_str(), info["default_branch"].as_str(), info["disk_kb"].as_u64()), (Some("acme/storefront"), Some("main"), Some(4911)));

    // A project whose origin is acme/payments-api is already added.
    let (repo, _) = project_with_repo(&d, &mut c).await;
    git_in(&repo, &["remote", "add", "origin", "git@github.com:acme/payments-api.git"]).unwrap();
    let list: Vec<serde_json::Value> = c.request(methods::REPO_LIST, ()).await.unwrap();
    let added: Vec<(&str, bool)> = list.iter().map(|r| (r["repo"].as_str().unwrap(), r["added"].as_bool().unwrap())).collect();
    assert_eq!(added, [("acme/storefront", false), ("acme/storefront-admin", false), ("acme/payments-api", true), ("sam-rivera/store-locator", false)]);
}

/// A repository whose one commit has a fixed hash, `5af9891b…`, so tests can
/// expect its root as a literal; its origin carries a token.
fn shop_repo(dir: &std::path::Path) {
    std::fs::create_dir_all(dir).unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"],
        &["remote", "add", "origin", "https://user:token@github.com/acme/shop.git"],
    ] {
        let ok = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_DATE", "2026-10-21T12:00:00Z")
            .env("GIT_COMMITTER_DATE", "2026-10-21T12:00:00Z")
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }
}

/// X41: a project's identity is its normalized origin, without the token in
/// the remote URL, and its root commit.
#[tokio::test]
async fn a_project_has_an_identity_without_credentials() {
    use moonlet_proto::types::{Project, ProjectIdentity};
    let d = TestDaemon::start().await;
    let repo = d.home.path().join("shop");
    shop_repo(&repo);
    let mut c = d.client().await;
    let _: Project = c.request(methods::PROJECT_ADD, serde_json::json!({"path": repo})).await.unwrap();
    let want = ProjectIdentity {
        origin: Some("github.com/acme/shop".into()),
        root: Some("5af9891b3892ce4e1d3fd498c75b6aaf1b27d96a".into()),
    };
    let list: serde_json::Value = c.request(methods::PROJECT_LIST, ()).await.unwrap();
    let listed: Vec<Project> = serde_json::from_value(list.clone()).unwrap();
    assert_eq!(listed[0].identity, want);
    let one: serde_json::Value = c.request(methods::PROJECT_IDENTITY, serde_json::json!({"path": repo})).await.unwrap();
    assert_eq!(serde_json::from_value::<ProjectIdentity>(one.clone()).unwrap(), want);
    for text in [list.to_string(), one.to_string()] {
        assert!(!text.contains("token"), "{text}");
    }
}

/// X41: projects saved before identities existed get one when the daemon starts.
#[tokio::test]
async fn projects_saved_without_an_identity_get_one_on_start() {
    use moonlet_proto::types::Project;
    let home = tempfile::tempdir().unwrap();
    let repo = home.path().join("shop");
    shop_repo(&repo);
    // Saved with only half an identity, as when the root could not be read.
    let half = home.path().join("shop-half");
    shop_repo(&half);
    std::fs::create_dir_all(home.path().join(".moonlet")).unwrap();
    let state = serde_json::json!({"version": 3, "projects": [
        {"id": "p1", "name": "shop", "path": repo, "base_branch": "main"},
        {"id": "p2", "name": "gone", "path": home.path().join("gone"), "base_branch": "main"},
        {"id": "p3", "name": "shop-half", "path": half, "base_branch": "main",
         "identity": {"origin": "github.com/acme/shop", "root": null}},
    ]});
    std::fs::write(home.path().join(".moonlet/state.json"), state.to_string()).unwrap();
    let d = HomeDaemon::start(home, None).await;
    let mut c = d.client().await;
    let list: Vec<Project> = c.request(methods::PROJECT_LIST, ()).await.unwrap();
    let ids: Vec<_> = list.iter().map(|p| (p.id.as_str(), p.identity.origin.as_deref(), p.identity.root.as_deref())).collect();
    assert_eq!(
        ids,
        [
            ("p1", Some("github.com/acme/shop"), Some("5af9891b3892ce4e1d3fd498c75b6aaf1b27d96a")),
            ("p2", None, None),
            ("p3", Some("github.com/acme/shop"), Some("5af9891b3892ce4e1d3fd498c75b6aaf1b27d96a")),
        ]
    );
}

#[tokio::test]
async fn a_projects_origin_is_read_again_on_start() {
    use moonlet_proto::types::Project;
    let home = tempfile::tempdir().unwrap();
    // Its origin moved since it was saved.
    let moved = home.path().join("shop");
    shop_repo(&moved);
    // Its origin remote was removed since.
    let local = home.path().join("local");
    shop_repo(&local);
    git_in(&local, &["remote", "remove", "origin"]).unwrap();
    std::fs::create_dir_all(home.path().join(".moonlet")).unwrap();
    let root = "5af9891b3892ce4e1d3fd498c75b6aaf1b27d96a";
    let state = serde_json::json!({"version": 3, "projects": [
        {"id": "p1", "name": "shop", "path": moved, "base_branch": "main",
         "identity": {"origin": "github.com/acme/old-shop", "root": root}},
        {"id": "p2", "name": "local", "path": local, "base_branch": "main",
         "identity": {"origin": "github.com/acme/shop", "root": root}},
        // A folder that cannot be read keeps what was known.
        {"id": "p3", "name": "gone", "path": home.path().join("gone"), "base_branch": "main",
         "identity": {"origin": "github.com/acme/gone", "root": root}},
    ]});
    std::fs::write(home.path().join(".moonlet/state.json"), state.to_string()).unwrap();
    let d = HomeDaemon::start(home, None).await;
    let mut c = d.client().await;
    let list: Vec<Project> = c.request(methods::PROJECT_LIST, ()).await.unwrap();
    let ids: Vec<_> = list.iter().map(|p| (p.id.as_str(), p.identity.origin.as_deref(), p.identity.root.as_deref())).collect();
    assert_eq!(
        ids,
        [
            ("p1", Some("github.com/acme/shop"), Some(root)),
            ("p2", None, Some(root)),
            ("p3", Some("github.com/acme/gone"), Some(root)),
        ]
    );
}

/// Design systems over RPC (X64): create one from a project, check it, record
/// a sync and list it.
#[tokio::test]
async fn design_systems_over_rpc() {
    use moonlet_proto::types::Project;
    let d = TestDaemon::start().await;
    let repo = d.home.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/ui.tsx"), "export const Button = () => null;\n").unwrap();
    let git = |args: &[&str]| {
        assert!(Command::new("git").args(args).current_dir(&repo).output().unwrap().status.success(), "git {args:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["add", "-A"]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    let head = String::from_utf8(Command::new("git").args(["rev-parse", "--short", "HEAD"]).current_dir(&repo).output().unwrap().stdout).unwrap();

    let mut c = d.client().await;
    // A workspace that does not exist has no design folder.
    let none = c
        .request::<_, serde_json::Value>(methods::DESIGN_SYSTEMS, serde_json::json!({"workspace": "w-none"}))
        .await;
    assert!(none.is_err());
    let ws: moonlet_proto::types::Workspace =
        c.request(methods::WORKSPACE_CREATE, serde_json::json!({"name": "1devstudio", "color": "clay"})).await.unwrap();
    let w = ws.id.as_str();
    let project: Project = c.request(methods::PROJECT_ADD, serde_json::json!({"path": repo})).await.unwrap();
    let created: serde_json::Value = c
        .request(
            methods::DESIGN_SYSTEM_CREATE,
            serde_json::json!({"workspace": w, "name": "moonlet desktop", "sources": [{"project": project.id}], "cover": "all", "agent": false}),
        )
        .await
        .unwrap();
    assert_eq!((created["slug"].as_str(), created["agent"].as_u64()), (Some("moonlet-desktop"), None));
    let config = std::fs::read_to_string(d.home.path().join("design").join(w).join("systems/moonlet-desktop/config.toml")).unwrap();
    assert!(config.contains("cover = \"all\""), "{config}");
    let bad = c
        .request::<_, serde_json::Value>(
            methods::DESIGN_SYSTEM_CREATE,
            serde_json::json!({"workspace": w, "name": "x", "sources": [], "cover": "most", "agent": false}),
        )
        .await;
    assert!(bad.is_err());
    let slug = "moonlet-desktop".to_string();
    let dir = d.home.path().join("design").join(w).join("systems/moonlet-desktop");
    for (path, text) in [
        ("styles.css", "@import \"components.css\";\n"),
        ("components.css", ".btn { color: var(--color-fg); }\n"),
        ("components/buttons/button/button.html", "<!-- @dsCard group=\"Buttons\" source=\"src/ui.tsx\" -->\n<button class=\"btn\">Run</button>\n"),
    ] {
        std::fs::create_dir_all(dir.join(path).parent().unwrap()).unwrap();
        std::fs::write(dir.join(path), text).unwrap();
    }
    let problems: serde_json::Value =
        c.request(methods::DESIGN_CHECK, serde_json::json!({"workspace": w, "slug": slug})).await.unwrap();
    assert_eq!(problems[0]["path"], "components.css");
    assert_eq!(problems[0]["kind"], "unknown_token");
    assert!(dir.join("README.md").is_file());
    // The design system view's cards (X64): each as its marker says.
    let cards: serde_json::Value = c.request(methods::DESIGN_CARDS, serde_json::json!({"workspace": w, "slug": slug})).await.unwrap();
    let button = cards.as_array().unwrap().iter().find(|c| c["path"] == "components/buttons/button/button.html").expect("the button card");
    assert_eq!(
        (&button["group"], &button["name"], &button["viewport"], &button["source"], &button["marker"], &button["changed_sources"]),
        (
            &serde_json::json!("Buttons"),
            &serde_json::json!("button"),
            &serde_json::json!([900, 700]),
            &serde_json::json!(["src/ui.tsx"]),
            &serde_json::json!("<!-- @dsCard group=\"Buttons\" source=\"src/ui.tsx\" -->"),
            &serde_json::json!([])
        )
    );

    assert_eq!(
        (&button["proposals"], &button["edited_by_hand"], &button["orphaned"], &button["kept"]),
        (&serde_json::json!([]), &serde_json::json!(false), &serde_json::json!(false), &serde_json::json!(false))
    );

    // Every step a running sync reported, in step order, each with its summary.
    for (step, summary) in [("inventory", Some("1 new")), ("tokens", None), ("cards", Some("1 of 1"))] {
        let _: bool = c
            .request(methods::DESIGN_SYSTEM_PROGRESS, serde_json::json!({"workspace": w, "slug": slug, "step": step, "summary": summary}))
            .await
            .unwrap();
    }
    let list: serde_json::Value = c.request(methods::DESIGN_SYSTEMS, serde_json::json!({"workspace": w})).await.unwrap();
    assert_eq!(
        list[0]["steps"],
        serde_json::json!([
            {"step": "inventory", "summary": "1 new"},
            {"step": "tokens", "summary": null},
            {"step": "cards", "summary": "1 of 1"}
        ])
    );
    assert_eq!((&list[0]["step"], &list[0]["step_summary"]), (&serde_json::json!("cards"), &serde_json::json!("1 of 1")));
    let _: bool = c.request(methods::DESIGN_SYSTEM_SYNCED, serde_json::json!({"workspace": w, "slug": slug})).await.unwrap();
    let list: serde_json::Value = c.request(methods::DESIGN_SYSTEMS, serde_json::json!({"workspace": w})).await.unwrap();
    assert_eq!(list[0]["name"], "moonlet desktop");
    assert_eq!(list[0]["synced_commit"], head.trim());
    assert_eq!(list[0]["cards"], 1);
    assert_eq!(list[0]["step"], serde_json::Value::Null);
    assert_eq!(list[0]["steps"], serde_json::json!([]));

    // Edited by hand, with the sync's proposal beside it; then orphaned and kept for now.
    let button_path = "components/buttons/button/button.html";
    std::fs::write(dir.join(button_path), "<!-- @dsCard group=\"Buttons\" source=\"src/ui.tsx\" -->\n<button class=\"btn\">Go</button>\n").unwrap();
    std::fs::write(dir.join("components/buttons/button/button.proposed.html"), "<!-- @dsCard group=\"Buttons\" source=\"src/ui.tsx\" -->\n<button class=\"btn\">Run</button>\n").unwrap();
    let keep = serde_json::json!({"workspace": w, "slug": slug, "card": button_path, "choice": "keep"});
    assert!(c.request::<_, bool>(methods::DESIGN_SETTLE, keep.clone()).await.is_err(), "a card that is not orphaned is not kept");
    std::fs::remove_file(repo.join("src/ui.tsx")).unwrap();
    let _: bool = c.request(methods::DESIGN_SETTLE, keep).await.unwrap();
    let cards: serde_json::Value = c.request(methods::DESIGN_CARDS, serde_json::json!({"workspace": w, "slug": slug})).await.unwrap();
    let button = cards.as_array().unwrap().iter().find(|c| c["path"] == button_path).expect("the button card");
    assert_eq!(
        (&button["proposals"], &button["edited_by_hand"], &button["orphaned"], &button["kept"]),
        (
            &serde_json::json!(["components/buttons/button/button.proposed.html"]),
            &serde_json::json!(true),
            &serde_json::json!(true),
            &serde_json::json!(true)
        )
    );
    let list: serde_json::Value = c.request(methods::DESIGN_SYSTEMS, serde_json::json!({"workspace": w})).await.unwrap();
    assert_eq!(list[0]["to_settle"], 1, "its proposal waits; the orphan is kept");

    std::fs::write(repo.join("package.json"), r#"{"dependencies": {"react": "19"}, "devDependencies": {"tailwindcss": "4"}}"#).unwrap();
    let stack: Vec<String> = c.request(methods::DESIGN_DETECT, serde_json::json!({"workspace": w, "path": repo})).await.unwrap();
    assert_eq!(stack, ["React", "Tailwind"]);

    let file: serde_json::Value = c
        .request(methods::DESIGN_FILE, serde_json::json!({"workspace": w, "path": "systems/moonlet-desktop/styles.css"}))
        .await
        .unwrap();
    assert_eq!(file["content_type"], "text/css; charset=utf-8");
    let refused = c
        .request::<_, serde_json::Value>(methods::DESIGN_FILE, serde_json::json!({"workspace": w, "path": "../../git.toml"}))
        .await;
    assert!(refused.is_err());

    let _: bool = c.request(methods::DESIGN_SYSTEM_REMOVE, serde_json::json!({"workspace": w, "slug": slug})).await.unwrap();
    assert!(!dir.exists());
}

/// X64: a new design system starts its sync agent: Claude Code in the system's
/// folder, the source added read only, allowed only its design commands, with
/// a first message to build it. A sync later asks the same agent to sync again.
#[tokio::test]
async fn a_new_design_system_starts_its_sync_agent() {
    use moonlet_proto::types::{Project, Workspace};
    let d = fake_claude_daemon(
        r#"#!/bin/sh
echo "$@" >> claude-args
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}' ;;
    *'"type":"user"'*) echo "$line" >> claude-user
      echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}' ;;
  esac
done
"#,
    )
    .await;
    let repo = d.home.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/ui.tsx"), "export const Button = () => null;\n").unwrap();
    for args in [vec!["init", "-q", "-b", "main"], vec!["add", "-A"], vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]] {
        assert!(Command::new("git").args(&args).current_dir(&repo).output().unwrap().status.success());
    }
    let mut c = d.client().await;
    let ws: Workspace = c.request(methods::WORKSPACE_CREATE, serde_json::json!({"name": "1devstudio", "color": "clay"})).await.unwrap();
    let project: Project = c.request(methods::PROJECT_ADD, serde_json::json!({"path": repo})).await.unwrap();
    let created: serde_json::Value = c
        .request(
            methods::DESIGN_SYSTEM_CREATE,
            serde_json::json!({"workspace": ws.id, "name": "moonlet desktop", "sources": [{"project": project.id}]}),
        )
        .await
        .unwrap();
    assert_eq!(created["slug"], "moonlet-desktop");
    assert_eq!(created["agent_error"], serde_json::Value::Null);
    let agent = created["agent"].as_u64().expect("an agent") as u32;

    let dir = d.home.path().join(".moonlet/design").join(&ws.id).join("systems/moonlet-desktop");
    let real_repo = repo.canonicalize().unwrap().display().to_string();
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    let t = terminals.iter().find(|t| t.id == agent).expect("the agent's chat");
    // Marked as a design system's sync agent: the app notifies for it in
    // Design mode, never as a session (X65); a standalone chat is not one.
    assert_eq!((t.title.as_str(), t.session_id.as_deref(), t.chat, t.design), ("Design · moonlet desktop", None, true, true));

    let file = |name: &str| {
        let p = dir.join(name);
        move || std::fs::read_to_string(&p).unwrap_or_default()
    };
    let (args, user) = (file("claude-args"), file("claude-user"));
    for _ in 0..100 {
        if user().contains("Build the design system") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let args = args();
    assert!(args.contains("--permission-mode acceptEdits"), "{args}");
    assert!(args.contains(&format!("--add-dir {real_repo}")), "{args}");
    assert!(args.contains(&format!("\"deny\":[\"Edit(/{real_repo}/**)\"]")), "{args}");
    assert!(args.contains("design system progress:*)"), "{args}");
    assert!(user().contains("Build the design system \\\"moonlet desktop\\\""), "{}", user());

    let list: serde_json::Value = c.request(methods::DESIGN_SYSTEMS, serde_json::json!({"workspace": ws.id})).await.unwrap();
    assert_eq!(list[0]["agent"].as_u64(), Some(agent as u64));

    // Once a sync is recorded, Sync asks the same agent to sync again.
    let _: bool = c.request(methods::DESIGN_SYSTEM_SYNCED, serde_json::json!({"workspace": ws.id, "slug": "moonlet-desktop"})).await.unwrap();
    let again: serde_json::Value =
        c.request(methods::DESIGN_SYSTEM_SYNC, serde_json::json!({"workspace": ws.id, "slug": "moonlet-desktop"})).await.unwrap();
    assert_eq!(again["agent"].as_u64(), Some(agent as u64));
    for _ in 0..100 {
        if user().contains("Sync the design system") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(user().contains("Sync the design system"), "{}", user());

    // A record pointing at another chat, here another system's agent, never
    // gets that chat this system's prompts: a new agent starts instead.
    let other: serde_json::Value = c
        .request(
            methods::DESIGN_SYSTEM_CREATE,
            serde_json::json!({"workspace": ws.id, "name": "storefront", "sources": [{"project": project.id}]}),
        )
        .await
        .unwrap();
    let other_agent = other["agent"].as_u64().expect("an agent");
    let record = d.home.path().join(".moonlet/design").join(&ws.id).join(".records/moonlet-desktop.toml");
    let text = std::fs::read_to_string(&record).unwrap();
    let text = text.replace(&format!("agent = {agent}"), &format!("agent = {other_agent}"));
    std::fs::write(&record, text).unwrap();
    let third: serde_json::Value =
        c.request(methods::DESIGN_SYSTEM_SYNC, serde_json::json!({"workspace": ws.id, "slug": "moonlet-desktop"})).await.unwrap();
    let third = third["agent"].as_u64().unwrap();
    assert!(third != other_agent && third != agent as u64, "reused chat {third}");

    // Two syncs at once of a system with no agent yet start only one.
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_SYSTEM_CREATE,
            serde_json::json!({"workspace": ws.id, "name": "pricing", "sources": [{"project": project.id}], "agent": false}),
        )
        .await
        .unwrap();
    let mut c2 = d.client().await;
    let sync = serde_json::json!({"workspace": ws.id, "slug": "pricing"});
    let (a, b) = tokio::join!(
        c.request::<_, serde_json::Value>(methods::DESIGN_SYSTEM_SYNC, sync.clone()),
        c2.request::<_, serde_json::Value>(methods::DESIGN_SYSTEM_SYNC, sync.clone())
    );
    assert_eq!(a.unwrap()["agent"], b.unwrap()["agent"]);
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    assert_eq!(terminals.iter().filter(|t| t.title == "Design · pricing").count(), 1);

    // Removing a system stops its agent.
    let _: bool = c.request(methods::DESIGN_SYSTEM_REMOVE, serde_json::json!({"workspace": ws.id, "slug": "pricing"})).await.unwrap();
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    assert!(!terminals.iter().any(|t| t.title == "Design · pricing"), "the agent of a removed system still runs");
}

/// A `claude` that answers every message at once, for the design sync agent.
const FAKE_SYNC_CLAUDE: &str = r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}' ;;
    *'"type":"user"'*) echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}' ;;
  esac
done
"#;

/// X64: a design source's sub-folder is a folder inside its project: one that
/// is absolute, climbs out with `..`, links out or is missing is refused, and a
/// record that names one anyway never gets it granted to the sync agent.
#[tokio::test]
async fn a_design_source_never_reaches_outside_its_project() {
    use moonlet_proto::types::{Project, Workspace};
    let d = fake_claude_daemon(FAKE_SYNC_CLAUDE).await;
    let repo = d.home.path().join("repo");
    let outside = d.home.path().join("outside");
    std::fs::create_dir_all(repo.join("apps/mobile")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, repo.join("apps/out")).unwrap();
    std::fs::write(repo.join("apps/mobile/ui.tsx"), "export const Button = () => null;\n").unwrap();
    for args in [vec!["init", "-q", "-b", "main"], vec!["add", "-A"], vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]] {
        assert!(Command::new("git").args(&args).current_dir(&repo).output().unwrap().status.success());
    }
    let mut c = d.client().await;
    let ws: Workspace = c.request(methods::WORKSPACE_CREATE, serde_json::json!({"name": "1devstudio", "color": "clay"})).await.unwrap();
    let project: Project = c.request(methods::PROJECT_ADD, serde_json::json!({"path": repo})).await.unwrap();
    let create = |name: &str, subdir: &str| {
        serde_json::json!({"workspace": ws.id, "name": name, "sources": [{"project": project.id, "subdir": subdir}], "agent": false})
    };
    for bad in ["/etc", "../outside", "apps/../..", "apps/out", "apps/missing"] {
        let refused = c.request::<_, serde_json::Value>(methods::DESIGN_SYSTEM_CREATE, create("x", bad)).await;
        assert!(refused.as_ref().is_err_and(|e| e.to_string().starts_with("invalid_params")), "{bad}: {refused:?}");
    }
    let list: serde_json::Value = c.request(methods::DESIGN_SYSTEMS, serde_json::json!({"workspace": ws.id})).await.unwrap();
    assert_eq!(list, serde_json::json!([]));

    let created: serde_json::Value = c.request(methods::DESIGN_SYSTEM_CREATE, create("mobile", "apps/mobile")).await.unwrap();
    assert_eq!(created["slug"], "mobile");
    // A record that names a folder outside the project anyway.
    let record = d.home.path().join(".moonlet/design").join(&ws.id).join(".records/mobile.toml");
    let text = std::fs::read_to_string(&record).unwrap();
    assert!(text.contains("subdir = \"apps/mobile\""), "{text}");
    std::fs::write(&record, text.replace("subdir = \"apps/mobile\"", "subdir = \"apps/out\"")).unwrap();
    let refused = c.request::<_, serde_json::Value>(methods::DESIGN_SYSTEM_SYNC, serde_json::json!({"workspace": ws.id, "slug": "mobile"})).await;
    assert!(refused.as_ref().is_err_and(|e| e.to_string().contains("apps/out is not a folder inside")), "{refused:?}");
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    assert!(!terminals.iter().any(|t| t.title == "Design · mobile"), "an agent started with a folder outside its project");
}

/// X64: a system's agent is the chat its record names, whatever name the
/// agent gives the system in `config.toml`: Sync still asks that chat, and
/// removing the system stops it.
#[tokio::test]
async fn a_renamed_design_system_keeps_its_one_agent_and_removing_it_stops_that_agent() {
    use moonlet_proto::types::{Project, Workspace};
    let d = fake_claude_daemon(FAKE_SYNC_CLAUDE).await;
    let repo = d.home.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/ui.tsx"), "export const Button = () => null;\n").unwrap();
    for args in [vec!["init", "-q", "-b", "main"], vec!["add", "-A"], vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]] {
        assert!(Command::new("git").args(&args).current_dir(&repo).output().unwrap().status.success());
    }
    let mut c = d.client().await;
    let ws: Workspace = c.request(methods::WORKSPACE_CREATE, serde_json::json!({"name": "1devstudio", "color": "clay"})).await.unwrap();
    let project: Project = c.request(methods::PROJECT_ADD, serde_json::json!({"path": repo})).await.unwrap();
    let created: serde_json::Value = c
        .request(methods::DESIGN_SYSTEM_CREATE, serde_json::json!({"workspace": ws.id, "name": "storefront", "sources": [{"project": project.id}]}))
        .await
        .unwrap();
    let agent = created["agent"].as_u64().expect("an agent");
    // The agent renames the system in the file it may edit.
    let config = d.home.path().join(".moonlet/design").join(&ws.id).join("systems/storefront/config.toml");
    let text = std::fs::read_to_string(&config).unwrap();
    std::fs::write(&config, text.replace("name = \"storefront\"", "name = \"shop\"")).unwrap();
    let again: serde_json::Value =
        c.request(methods::DESIGN_SYSTEM_SYNC, serde_json::json!({"workspace": ws.id, "slug": "storefront"})).await.unwrap();
    assert_eq!(again["agent"].as_u64(), Some(agent));
    let _: bool = c.request(methods::DESIGN_SYSTEM_REMOVE, serde_json::json!({"workspace": ws.id, "slug": "storefront"})).await.unwrap();
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    let running: Vec<u32> = terminals.iter().filter(|t| t.chat).map(|t| t.id).collect();
    assert_eq!(running, Vec::<u32>::new(), "the agent of the removed system ({agent}) still runs");
}

/// X64: a sync recorded while Sync starts the system's agent keeps both: the
/// record names the new agent and the sync's time.
#[tokio::test]
async fn a_sync_recorded_while_its_agent_starts_keeps_both() {
    use moonlet_proto::types::{Project, Workspace};
    let d = fake_claude_daemon(FAKE_SYNC_CLAUDE).await;
    let repo = d.home.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/ui.tsx"), "export const Button = () => null;\n").unwrap();
    for args in [vec!["init", "-q", "-b", "main"], vec!["add", "-A"], vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]] {
        assert!(Command::new("git").args(&args).current_dir(&repo).output().unwrap().status.success());
    }
    let mut c = d.client().await;
    let ws: Workspace = c.request(methods::WORKSPACE_CREATE, serde_json::json!({"name": "1devstudio", "color": "clay"})).await.unwrap();
    let project: Project = c.request(methods::PROJECT_ADD, serde_json::json!({"path": repo})).await.unwrap();
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_SYSTEM_CREATE,
            serde_json::json!({"workspace": ws.id, "name": "pricing", "sources": [{"project": project.id}], "agent": false}),
        )
        .await
        .unwrap();
    // Enough files that recording the sync takes a while.
    let assets = d.home.path().join(".moonlet/design").join(&ws.id).join("systems/pricing/assets");
    std::fs::create_dir_all(&assets).unwrap();
    let body = "x".repeat(16 * 1024);
    for i in 0..2000 {
        std::fs::write(assets.join(format!("a{i}.txt")), &body).unwrap();
    }
    let mut c2 = d.client().await;
    let system = serde_json::json!({"workspace": ws.id, "slug": "pricing"});
    let (synced, started) = tokio::join!(c.request::<_, bool>(methods::DESIGN_SYSTEM_SYNCED, system.clone()), async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        c2.request::<_, serde_json::Value>(methods::DESIGN_SYSTEM_SYNC, system.clone()).await
    });
    synced.unwrap();
    let agent = started.unwrap()["agent"].as_u64().expect("an agent");
    let list: serde_json::Value = c.request(methods::DESIGN_SYSTEMS, serde_json::json!({"workspace": ws.id})).await.unwrap();
    assert_eq!(list[0]["agent"].as_u64(), Some(agent), "{list}");
    assert!(list[0]["synced_at"].is_u64(), "{list}");
}

/// X64: Changed by this sync lists what the sync changed, not a card the user
/// edited by hand before Sync started it.
#[tokio::test]
async fn a_card_edited_by_hand_before_sync_is_not_changed_by_that_sync() {
    use moonlet_proto::types::{Project, Workspace};
    let d = fake_claude_daemon(FAKE_SYNC_CLAUDE).await;
    let repo = d.home.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/ui.tsx"), "export const Button = () => null;\n").unwrap();
    for args in [vec!["init", "-q", "-b", "main"], vec!["add", "-A"], vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]] {
        assert!(Command::new("git").args(&args).current_dir(&repo).output().unwrap().status.success());
    }
    let mut c = d.client().await;
    let ws: Workspace = c.request(methods::WORKSPACE_CREATE, serde_json::json!({"name": "1devstudio", "color": "clay"})).await.unwrap();
    let project: Project = c.request(methods::PROJECT_ADD, serde_json::json!({"path": repo})).await.unwrap();
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_SYSTEM_CREATE,
            serde_json::json!({"workspace": ws.id, "name": "pricing", "sources": [{"project": project.id}], "agent": false}),
        )
        .await
        .unwrap();
    let dir = d.home.path().join(".moonlet/design").join(&ws.id).join("systems/pricing");
    let put = |path: &str, body: &str| {
        std::fs::create_dir_all(dir.join(path).parent().unwrap()).unwrap();
        std::fs::write(dir.join(path), format!("<!-- @dsCard group=\"Buttons\" source=\"src/ui.tsx\" -->\n{body}\n")).unwrap();
    };
    put("components/buttons/button/button.html", "<button>Run</button>");
    let system = serde_json::json!({"workspace": ws.id, "slug": "pricing"});
    let _: bool = c.request(methods::DESIGN_SYSTEM_SYNCED, system.clone()).await.unwrap();

    // Edited by hand, then synced: the agent keeps that card and adds another.
    put("components/buttons/button/button.html", "<button>Go</button>");
    let _: serde_json::Value = c.request(methods::DESIGN_SYSTEM_SYNC, system.clone()).await.unwrap();
    put("components/buttons/link/link.html", "<a>Run</a>");
    let _: bool = c.request(methods::DESIGN_SYSTEM_SYNCED, system.clone()).await.unwrap();
    let list: serde_json::Value = c.request(methods::DESIGN_SYSTEMS, serde_json::json!({"workspace": ws.id})).await.unwrap();
    assert_eq!(
        list[0]["last_sync"],
        serde_json::json!([{"path": "components/buttons/link/link.html", "change": "new", "sources": ["src/ui.tsx"]}])
    );
}

/// X64: while a design system's agent waits on a question, design.systems
/// says so, so the sidebar and the step bar can show Needs you.
#[tokio::test]
async fn a_waiting_sync_agent_shows_in_the_design_system_list() {
    use moonlet_proto::types::{Project, Workspace};
    let d = fake_claude_daemon(
        r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}' ;;
    *'"type":"user"'*) echo '{"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"t1","input":{"questions":[{"question":"Which button set is current?","header":"Buttons","multiSelect":false,"options":[{"label":"ui.tsx","description":"the new one"},{"label":"legacy","description":"the old one"}]}]}}}' ;;
  esac
done
"#,
    )
    .await;
    let repo = d.home.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    for args in [vec!["init", "-q", "-b", "main"], vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]] {
        assert!(Command::new("git").args(&args).current_dir(&repo).output().unwrap().status.success());
    }
    let mut c = d.client().await;
    let ws: Workspace = c.request(methods::WORKSPACE_CREATE, serde_json::json!({"name": "1devstudio", "color": "clay"})).await.unwrap();
    let project: Project = c.request(methods::PROJECT_ADD, serde_json::json!({"path": repo})).await.unwrap();
    let created: serde_json::Value = c
        .request(methods::DESIGN_SYSTEM_CREATE, serde_json::json!({"workspace": ws.id, "name": "storefront", "sources": [{"project": project.id}]}))
        .await
        .unwrap();
    assert!(created["agent"].is_u64(), "{created}");
    let mut list = serde_json::Value::Null;
    for _ in 0..100 {
        list = c.request(methods::DESIGN_SYSTEMS, serde_json::json!({"workspace": ws.id})).await.unwrap();
        if !list[0]["needs_you"].is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(list[0]["needs_you"], serde_json::json!({"kind": "question", "text": "Which button set is current?"}));
}

/// X64: a file written in a design system reaches every client as
/// design.changed, so Design mode updates while the agent works.
#[tokio::test]
async fn a_file_written_in_a_design_system_is_announced() {
    use moonlet_proto::types::Workspace;
    let d = TestDaemon::start().await;
    let mut c = d.client().await;
    let ws: Workspace = c.request(methods::WORKSPACE_CREATE, serde_json::json!({"name": "1devstudio", "color": "clay"})).await.unwrap();
    let _: serde_json::Value = c
        .request(methods::DESIGN_SYSTEM_CREATE, serde_json::json!({"workspace": ws.id, "name": "storefront", "sources": [], "agent": false}))
        .await
        .unwrap();
    let mut listener = d.client().await;
    let card = d.home.path().join("design").join(&ws.id).join("systems/storefront/components/buttons/button/button.html");
    std::fs::create_dir_all(card.parent().unwrap()).unwrap();
    std::fs::write(&card, "<!-- @dsCard group=\"Buttons\" -->\n").unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let f = tokio::time::timeout_at(deadline, listener.next_frame()).await.expect("no design.changed").unwrap().unwrap();
        if let Frame::Json(Message::Event { name, data }) = f
            && name == methods::EV_DESIGN_CHANGED
            && data["paths"].as_array().is_some_and(|p| p.iter().any(|x| x == "components/buttons/button/button.html"))
        {
            assert_eq!((data["workspace"].as_str(), data["system"].as_str()), (Some(ws.id.as_str()), Some("storefront")));
            break;
        }
    }
}

/// A design system with two cards for the render check (X64): a button
/// with two variants, and a field whose mount is empty.
async fn render_fixture(d: &TestDaemon) -> (Client, String, PathBuf) {
    let mut c = d.client().await;
    let ws: moonlet_proto::types::Workspace = c.request(methods::WORKSPACE_CREATE, serde_json::json!({"name": "1devstudio", "color": "clay"})).await.unwrap();
    let _: serde_json::Value = c
        .request(methods::DESIGN_SYSTEM_CREATE, serde_json::json!({"workspace": ws.id, "name": "storefront", "sources": [], "agent": false}))
        .await
        .unwrap();
    let dir = d.home.path().join("design").join(&ws.id).join("systems/storefront");
    for (path, text) in [
        ("styles.css", "@import \"components.css\";\n"),
        ("components.css", ".btn { color: red; }\n"),
        (
            "components/buttons/button/button.html",
            "<!-- @dsCard group=\"Buttons\" name=\"Button\" viewport=\"320x140\" -->\n<!doctype html>\n<html><head><link rel=\"stylesheet\" href=\"../../../styles.css\"></head><body><section class=\"ds-cell\" data-snippet=\"buttons/button/primary\"><h4>primary</h4><div class=\"ds-mount\"><button class=\"btn\">Run</button></div></section><section class=\"ds-cell\" data-snippet=\"buttons/button/ghost\"><h4>ghost</h4><div class=\"ds-mount\"><button class=\"btn\">Cancel</button></div></section></body></html>\n",
        ),
        (
            "components/forms/field/field.html",
            "<!-- @dsCard group=\"Forms\" name=\"Field\" -->\n<!doctype html>\n<html><head><link rel=\"stylesheet\" href=\"../../../styles.css\"></head><body><section class=\"ds-cell\" data-snippet=\"forms/field/default\"><h4>default</h4><div class=\"ds-mount\"></div></section></body></html>\n",
        ),
    ] {
        std::fs::create_dir_all(dir.join(path).parent().unwrap()).unwrap();
        std::fs::write(dir.join(path), text).unwrap();
    }
    (c, ws.id, dir)
}

/// A stand-in for the moonlet app (X64): says it renders cards, then
/// answers each `design.render` it gets, and hands every one to `seen`. A
/// card's flags: the field's empty mount is bad; a screenshot is the PNG
/// signature, padded to `png_bytes`.
async fn fake_app(d: &TestDaemon, png_bytes: usize) -> tokio::sync::mpsc::UnboundedReceiver<serde_json::Value> {
    let mut app = Client::connect(&d.socket, "moonlet-app").await.unwrap();
    let _: serde_json::Value = app.request(methods::DESIGN_RENDER_READY, serde_json::json!({})).await.unwrap();
    let (seen, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok(Some(f)) = app.next_frame().await {
            let Frame::Json(Message::Event { name, data }) = f else { continue };
            if name != methods::EV_DESIGN_RENDER {
                continue;
            }
            let mut done = serde_json::json!({"id": data["id"]});
            if data["want"] == "png" {
                // `iVBORw0KGgo` is the PNG signature; each `AAAA` three zero bytes more.
                done["png_base64"] = format!("iVBORw0KGgo{}", "A".repeat((png_bytes - 8) / 3 * 4 + 1)).into();
            } else if data["path"].as_str().is_some_and(|p| p.ends_with("field.html")) {
                done["metrics"] = serde_json::json!({"flags": ["rootEmpty", "bad"], "errors": []});
            } else {
                done["metrics"] = serde_json::json!({"flags": [], "errors": []});
            }
            let _ = seen.send(data);
            let _: serde_json::Value = app.request(methods::DESIGN_RENDER_DONE, done).await.unwrap();
        }
    });
    rx
}

#[tokio::test]
async fn the_app_renders_each_card_for_the_render_check_and_its_flags_are_kept() {
    let d = TestDaemon::start().await;
    let (mut c, w, dir) = render_fixture(&d).await;
    let mut seen = fake_app(&d, 100).await;
    let out: serde_json::Value = c
        .request(methods::DESIGN_CHECK, serde_json::json!({"workspace": w, "slug": "storefront", "render": true}))
        .await
        .unwrap();
    assert_eq!(out["render"], serde_json::json!({"total": 2, "bad": 1, "thin": 0, "variants_identical": 0}));
    assert!(out["problems"].is_array(), "{out}");
    // Each card was asked of the app, by its system and its path in it.
    let mut asked = Vec::new();
    while let Ok(a) = seen.try_recv() {
        asked.push((a["slug"].clone(), a["path"].as_str().unwrap().to_string(), a["viewport"].clone(), a["want"].clone(), a["workspace"].clone()));
    }
    assert_eq!(
        asked,
        vec![
            (serde_json::json!("storefront"), "components/buttons/button/button.html".into(), serde_json::json!([320, 140]), serde_json::json!("metrics"), serde_json::json!(w)),
            (serde_json::json!("storefront"), "components/forms/field/field.html".into(), serde_json::json!([900, 700]), serde_json::json!("metrics"), serde_json::json!(w)),
        ]
    );
    let report: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".cache/render-check.json")).unwrap()).unwrap();
    assert_eq!(
        report["cards"],
        serde_json::json!([
            {"path": "components/buttons/button/button.html", "flags": []},
            {"path": "components/forms/field/field.html", "flags": ["rootEmpty", "bad"]},
        ])
    );
    // Without `render`, the check is the plain list of problems, as before.
    let plain: serde_json::Value = c.request(methods::DESIGN_CHECK, serde_json::json!({"workspace": w, "slug": "storefront"})).await.unwrap();
    assert!(plain.is_array(), "{plain}");
}

#[tokio::test]
async fn the_app_snaps_a_card_and_the_screenshot_is_saved_in_the_system() {
    let d = TestDaemon::start().await;
    let (mut c, w, dir) = render_fixture(&d).await;
    let mut seen = fake_app(&d, 6 * 1024).await;
    let shot: serde_json::Value = c
        .request(
            methods::DESIGN_SNAP,
            serde_json::json!({"workspace": w, "slug": "storefront", "path": "components/buttons/button/button.html", "variant": "ghost"}),
        )
        .await
        .unwrap();
    let path = dir.join(".cache/screenshots/components/buttons/button/button--ghost-320x140.png");
    assert_eq!(shot, serde_json::json!({"path": path, "blank": false}));
    let png = std::fs::read(&path).unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let asked = seen.recv().await.unwrap();
    assert_eq!(
        (asked["variant"].as_str(), asked["want"].as_str(), asked["viewport"].clone()),
        (Some("buttons/button/ghost"), Some("png"), serde_json::json!([320, 140]))
    );
    // A card that is not one, or a variant it does not have, is refused before the app is asked.
    for (path, variant) in [("components/buttons/button/../button/button.html", None), ("components/buttons/button/button.html", Some("danger"))] {
        let e = c
            .request::<_, serde_json::Value>(methods::DESIGN_SNAP, serde_json::json!({"workspace": w, "slug": "storefront", "path": path, "variant": variant}))
            .await;
        assert!(e.is_err(), "{path} {variant:?}");
    }
}

#[tokio::test]
async fn a_screenshot_under_5_kb_is_blank() {
    let d = TestDaemon::start().await;
    let (mut c, w, _) = render_fixture(&d).await;
    let _seen = fake_app(&d, 100).await;
    let shot: serde_json::Value = c
        .request(methods::DESIGN_SNAP, serde_json::json!({"workspace": w, "slug": "storefront", "path": "components/forms/field/field.html", "viewport": [600, 400]}))
        .await
        .unwrap();
    assert_eq!(shot["blank"], true);
    assert!(shot["path"].as_str().unwrap().ends_with("/.cache/screenshots/components/forms/field/field-600x400.png"), "{shot}");
}

#[tokio::test]
async fn without_the_app_the_render_check_and_snap_say_to_open_moonlet() {
    let d = TestDaemon::start().await;
    let (mut c, w, dir) = render_fixture(&d).await;
    // An agent's CLI cannot stand in for the app.
    let mut cli = Client::connect(&d.socket, "moonlet-cli").await.unwrap();
    let refused = cli.request::<_, serde_json::Value>(methods::DESIGN_RENDER_READY, serde_json::json!({})).await;
    assert!(refused.is_err());
    // The check still runs, and says why it rendered nothing.
    std::fs::write(dir.join("components.css"), ".btn { color: var(--color-nope); }\n").unwrap();
    let out: serde_json::Value = c
        .request(methods::DESIGN_CHECK, serde_json::json!({"workspace": w, "slug": "storefront", "render": true}))
        .await
        .unwrap();
    assert_eq!(out["problems"][0]["kind"], "unknown_token", "{out}");
    assert_eq!((&out["render"], &out["render_error"]), (&serde_json::Value::Null, &serde_json::json!("Open moonlet to render cards")));
    assert!(dir.join("_ds_manifest.json").is_file());
    assert!(!dir.join(".cache/render-check.json").exists());
    // A snapshot cannot be had at all.
    let e = c
        .request::<_, serde_json::Value>(methods::DESIGN_SNAP, serde_json::json!({"workspace": w, "slug": "storefront", "path": "components/buttons/button/button.html"}))
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), "no_app: Open moonlet to render cards");
    // An app that said it renders, then quit, renders no more.
    let mut app = Client::connect(&d.socket, "moonlet-app").await.unwrap();
    let _: serde_json::Value = app.request(methods::DESIGN_RENDER_READY, serde_json::json!({})).await.unwrap();
    drop(app);
    let e = c
        .request::<_, serde_json::Value>(methods::DESIGN_SNAP, serde_json::json!({"workspace": w, "slug": "storefront", "path": "components/buttons/button/button.html"}))
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), "no_app: Open moonlet to render cards");
}

/// The app renders one card at a time, so the daemon sends it one at a
/// time, and a card's time to render starts on its turn (X64): a snap asked
/// during a render check waits without its clock running. Here the app takes
/// 1 s a card and the daemon gives it 1.5 s.
#[tokio::test]
async fn a_render_waits_its_turn_without_its_clock_running() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let d = TestDaemon::start_with(&[("MOONLET_RENDER_TIMEOUT_MS", "1500".into())]).await;
    let (mut c, w, _) = render_fixture(&d).await;
    let mut app = Client::connect(&d.socket, "moonlet-app").await.unwrap();
    let _: serde_json::Value = app.request(methods::DESIGN_RENDER_READY, serde_json::json!({})).await.unwrap();
    let (mut reader, mut writer) = app.into_stream().into_split();
    let (answers, mut to_send) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    tokio::spawn(async move {
        let mut id = 1000;
        while let Some(done) = to_send.recv().await {
            id += 1;
            let frame = Frame::Json(Message::Request { id, method: methods::DESIGN_RENDER_DONE.into(), params: done });
            if write_frame(&mut writer, &frame).await.is_err() {
                break;
            }
        }
    });
    let (in_flight, most) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let one_at_a_time = Arc::new(tokio::sync::Mutex::new(()));
    {
        let (in_flight, most) = (in_flight.clone(), most.clone());
        tokio::spawn(async move {
            while let Ok(Some(f)) = read_frame(&mut reader).await {
                let Frame::Json(Message::Event { name, data }) = f else { continue };
                if name != methods::EV_DESIGN_RENDER {
                    continue;
                }
                let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                most.fetch_max(now, Ordering::SeqCst);
                let (in_flight, answers, turn) = (in_flight.clone(), answers.clone(), one_at_a_time.clone());
                tokio::spawn(async move {
                    let _turn = turn.lock().await;
                    tokio::time::sleep(Duration::from_millis(1000)).await;
                    let mut done = serde_json::json!({"id": data["id"]});
                    if data["want"] == "png" {
                        done["png_base64"] = "iVBORw0KGgo=".into();
                    } else {
                        done["metrics"] = serde_json::json!({"flags": []});
                    }
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    let _ = answers.send(done);
                });
            }
        });
    }
    let socket = d.socket.clone();
    let ws = w.clone();
    let check = tokio::spawn(async move {
        let mut c2 = Client::connect(&socket, "test").await.unwrap();
        c2.request::<_, serde_json::Value>(methods::DESIGN_CHECK, serde_json::json!({"workspace": ws, "slug": "storefront", "render": true})).await
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let shot = c
        .request::<_, serde_json::Value>(methods::DESIGN_SNAP, serde_json::json!({"workspace": w, "slug": "storefront", "path": "components/buttons/button/button.html"}))
        .await;
    assert!(shot.is_ok(), "{shot:?}");
    let checked = check.await.unwrap().unwrap();
    // Neither card ran out of time: both were measured.
    assert_eq!(checked["render"], serde_json::json!({"total": 2, "bad": 0, "thin": 0, "variants_identical": 0}));
    assert_eq!(most.load(Ordering::SeqCst), 1);
}
