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
    path: Option<String>,
    /// More environment it starts with, such as a test's seam.
    env: Vec<(String, String)>,
    child: Child,
}

impl HomeDaemon {
    async fn start(home: tempfile::TempDir, path: Option<&str>) -> HomeDaemon {
        Self::start_with(home, path, Vec::new()).await
    }

    async fn start_with(home: tempfile::TempDir, path: Option<&str>, env: Vec<(String, String)>) -> HomeDaemon {
        let socket = home.path().join(".moonlet/run/moonletd.sock");
        let child = Self::spawn(home.path(), &socket, path, &env).await;
        HomeDaemon { home, socket, path: path.map(String::from), env, child }
    }

    /// Kills the daemon and starts it again on the same home, as after a
    /// crash: what it restores comes from what it saved as it went.
    async fn restart(&mut self) {
        self.stop();
        self.start_again().await;
    }

    /// Kills the daemon; `start_again` brings it back.
    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }

    async fn start_again(&mut self) {
        self.child = Self::spawn(self.home.path(), &self.socket, self.path.as_deref(), &self.env).await;
    }

    async fn spawn(home: &std::path::Path, socket: &std::path::Path, path: Option<&str>, env: &[(String, String)]) -> Child {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_moonletd"));
        cmd.envs(env.iter().map(|(k, v)| (k, v)));
        cmd.arg("daemon")
            .env("HOME", home)
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
        wait_for_socket(&socket.to_path_buf(), Duration::from_secs(15)).await.unwrap();
        child
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
    fake_claude_daemon_with(script, Vec::new()).await
}

/// As [`fake_claude_daemon`], the daemon started with `env` too.
async fn fake_claude_daemon_with(script: &str, env: Vec<(String, String)>) -> HomeDaemon {
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
    HomeDaemon::start_with(home, Some(&path), env).await
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

/// A bare repository with one commit, its root commit, and a daemon whose
/// git reads `example.test/acme/<name>`'s SSH address as that repository,
/// as a real host's git config can map one (X70).
async fn origin_daemon(name: &str) -> (TestDaemon, Vec<tempfile::TempDir>, String) {
    let origin = tempfile::tempdir().unwrap();
    let src = origin.path().join("src");
    std::fs::create_dir(&src).unwrap();
    git_in(&src, &["init", "-q", "-b", "main"]).unwrap();
    git_in(&src, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]).unwrap();
    let root = git_in(&src, &["rev-list", "--max-parents=0", "HEAD"]).unwrap().trim().to_string();
    git_in(origin.path(), &["clone", "-q", "--bare", "src", &format!("{name}.git")]).unwrap();
    let bare = origin.path().join(format!("{name}.git"));
    let (d, mut dirs) = fake_gh_daemon("#!/bin/sh\nexit 1\n").await;
    std::fs::write(
        dirs[1].path().join(".gitconfig"),
        format!("[url \"file://{}\"]\n\tinsteadOf = git@example.test:acme/{name}.git\n", bare.display()),
    )
    .unwrap();
    dirs.push(origin);
    (d, dirs, root)
}

#[tokio::test]
async fn a_project_from_another_member_is_cloned_from_its_origin_into_its_section() {
    let (d, dirs, root) = origin_daemon("ledger").await;
    let mut c = d.client().await;
    let mut watcher = d.client().await;
    let info: serde_json::Value = c.request(methods::REPO_LOOKUP, serde_json::json!({"origin": "example.test/acme/ledger"})).await.unwrap();
    assert_eq!((info["url"].as_str(), info["default_branch"].as_str()), (Some("git@example.test:acme/ledger.git"), Some("main")));

    let sections: Vec<moonlet_proto::types::Section> = c.request(methods::SECTION_LIST, ()).await.unwrap();
    let parent = dirs[1].path().join("moonlet");
    let job: serde_json::Value = c
        .request(
            methods::REPO_CLONE,
            serde_json::json!({"id": "c-1", "origin": "example.test/acme/ledger", "root": root, "url": "git@example.test:acme/ledger.git", "parent": parent, "name": "ledger", "section_id": sections[0].id}),
        )
        .await
        .unwrap();
    assert_eq!(job["repo"], "example.test/acme/ledger");
    let (_, done) = clone_events(&mut watcher).await;
    assert_eq!(done["error"], serde_json::Value::Null);
    // The test's git reads the address as the bare repository's path, so
    // the project's origin is that path here; the remote keeps the address.
    assert_eq!(done["project"]["identity"]["root"], root);
    let folder = parent.join("ledger");
    assert_eq!(git_in(&folder, &["config", "remote.origin.url"]).unwrap().trim(), "git@example.test:acme/ledger.git");
    let sections: Vec<moonlet_proto::types::Section> = c.request(methods::SECTION_LIST, ()).await.unwrap();
    assert!(sections[0].project_ids.contains(&done["project"]["id"].as_str().unwrap().to_string()));

}

#[tokio::test]
async fn a_clone_whose_address_holds_another_repository_is_not_added() {
    let (d, dirs, _root) = origin_daemon("ledger").await;
    let mut c = d.client().await;
    let mut watcher = d.client().await;
    let parent = dirs[1].path().join("moonlet");
    let other_root = "4171b03ff0d2bd434751f17bc9d34da784f97e72";
    let _: serde_json::Value = c
        .request(
            methods::REPO_CLONE,
            serde_json::json!({"id": "c-1", "origin": "example.test/acme/ledger", "root": other_root, "url": "git@example.test:acme/ledger.git", "parent": parent, "name": "ledger"}),
        )
        .await
        .unwrap();
    let (_, done) = clone_events(&mut watcher).await;
    assert_eq!(
        done["error"],
        "git@example.test:acme/ledger.git holds another repository: its first commit is not the one ledger starts with on the other Macs."
    );
    assert!(!parent.join("ledger").exists());
    let projects: Vec<moonlet_proto::types::Project> = c.request(methods::PROJECT_LIST, ()).await.unwrap();
    assert!(projects.is_empty(), "{projects:?}");
}

#[tokio::test]
async fn an_origin_clones_only_from_its_own_addresses() {
    let (d, dirs, root) = origin_daemon("ledger").await;
    let mut c = d.client().await;
    let parent = dirs[1].path().join("moonlet");
    let clone = |origin: &str, url: &str| serde_json::json!({"id": "c-1", "origin": origin, "root": root, "url": url, "parent": parent, "name": "x"});
    let elsewhere = c
        .request::<_, serde_json::Value>(methods::REPO_CLONE, clone("example.test/acme/ledger", "file:///tmp/evil.git"))
        .await
        .unwrap_err();
    assert!(elsewhere.to_string().contains("file:///tmp/evil.git is not an address of example.test/acme/ledger"), "{elsewhere}");
    let bad = c
        .request::<_, serde_json::Value>(methods::REPO_CLONE, clone("-oProxyCommand=x/a", "git@-oProxyCommand=x:a.git"))
        .await
        .unwrap_err();
    assert!(bad.to_string().contains("not a project origin: -oProxyCommand=x/a"), "{bad}");
    let lookup = c
        .request::<_, serde_json::Value>(methods::REPO_LOOKUP, serde_json::json!({"origin": "example.test/../etc"}))
        .await
        .unwrap_err();
    assert!(lookup.to_string().contains("not a project origin: example.test/../etc"), "{lookup}");
}

#[tokio::test]
async fn a_located_folder_joins_a_section_only_as_a_copy_of_the_project() {
    let (d, dirs, root) = origin_daemon("ledger").await;
    let mut c = d.client().await;
    let repo = dirs[1].path().join("work").join("other");
    std::fs::create_dir_all(&repo).unwrap();
    git_in(&repo, &["init", "-q", "-b", "main"]).unwrap();
    git_in(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "another project"]).unwrap();
    let repo = repo.display().to_string();
    let sections: Vec<moonlet_proto::types::Section> = c.request(methods::SECTION_LIST, ()).await.unwrap();
    let want = serde_json::json!({"origin": "example.test/acme/ledger", "root": root});
    let refused = c
        .request::<_, serde_json::Value>(methods::SECTION_ADD_PROJECT, serde_json::json!({"id": sections[0].id, "path": repo, "identity": want}))
        .await
        .unwrap_err();
    assert!(refused.to_string().contains(&format!("{repo} holds another repository.")), "{refused}");
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
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
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
    let tag = moonlet_proto::types::DesignAgent {
        kind: moonlet_proto::types::DesignAgentKind::Sync,
        workspace: ws.id.clone(),
        slug: "moonlet-desktop".into(),
        name: "moonlet desktop".into(),
    };
    assert_eq!((t.title.as_str(), t.session_id.as_deref(), t.chat, t.design.clone()), ("Design · moonlet desktop", None, true, Some(tag)));

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

/// X65: a sync agent saved before its design tag said which agent it is
/// (`design: true`) comes back after a restart as a sync agent, so the app
/// still never alerts for it like a session.
#[tokio::test]
async fn a_sync_agent_saved_as_design_true_comes_back_as_a_sync_agent() {
    use moonlet_proto::types::{DesignAgentKind, Workspace};
    let mut d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let ws: Workspace = c.request(methods::WORKSPACE_CREATE, serde_json::json!({"name": "1devstudio", "color": "clay"})).await.unwrap();
    let created: serde_json::Value = c
        .request(methods::DESIGN_SYSTEM_CREATE, serde_json::json!({"workspace": ws.id, "name": "storefront", "sources": []}))
        .await
        .unwrap();
    let agent = created["agent"].as_u64().expect("an agent") as u32;
    let kind = |terminals: &[TerminalInfo]| terminals.iter().find(|t| t.id == agent).and_then(|t| t.design.as_ref()).map(|tag| tag.kind);
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    assert_eq!(kind(&terminals), Some(DesignAgentKind::Sync));
    // Saved as a daemon before X65 entry 7a saved it.
    let saved = d.home.path().join(format!(".moonlet/chats/{agent}.json"));
    let mut chat: serde_json::Value = serde_json::from_slice(&std::fs::read(&saved).unwrap()).unwrap();
    chat["info"]["design"] = serde_json::json!(true);
    d.stop();
    std::fs::write(&saved, serde_json::to_vec(&chat).unwrap()).unwrap();
    d.start_again().await;
    let mut c = d.client().await;
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    assert!(terminals.iter().any(|t| t.id == agent), "the chat was not restored");
    assert_eq!(kind(&terminals), Some(DesignAgentKind::Sync));
}

/// A workspace with the design system `moonlet-desktop`, its README written,
/// and no sync agent; returns the workspace's id.
async fn workspace_with_system(d: &HomeDaemon, c: &mut Client) -> String {
    let ws: moonlet_proto::types::Workspace =
        c.request(methods::WORKSPACE_CREATE, serde_json::json!({"name": "1devstudio", "color": "clay"})).await.unwrap();
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_SYSTEM_CREATE,
            serde_json::json!({"workspace": ws.id, "name": "moonlet desktop", "sources": [], "agent": false}),
        )
        .await
        .unwrap();
    let system = d.home.path().join(".moonlet/design").join(&ws.id).join("systems/moonlet-desktop");
    std::fs::write(system.join("README.md"), "# moonlet desktop\n\nLink styles.css; buttons are .btn.\n").unwrap();
    ws.id
}

/// Waits until `read` gives text that contains `needle`, for up to 10 s.
async fn until_contains(read: impl Fn() -> String, needle: &str) -> String {
    for _ in 0..100 {
        if read().contains(needle) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    read()
}

/// X65: a new workspace design starts its agent: Claude Code in the design's
/// folder, its design system's folder added read only and denied to every
/// editing tool, with the brief, the README and the design rules as its first
/// message. The list reports it, and removing the design stops it.
#[tokio::test]
async fn a_new_design_starts_its_agent_in_its_folder_on_its_design_system() {
    use moonlet_proto::types::{DesignAgent, DesignAgentKind};
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "A settings page with General and Git sections"}),
        )
        .await
        .unwrap();
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    let real_dir = dir.canonicalize().unwrap().display().to_string();
    let real_system = d.home.path().join(".moonlet/design").join(&ws).join("systems/moonlet-desktop").canonicalize().unwrap().display().to_string();
    assert_eq!(
        (&created["slug"], &created["name"], &created["kind"], &created["system"], &created["agent_error"]),
        (&serde_json::json!("settings-page"), &serde_json::json!("Settings page"), &serde_json::json!("workspace"), &serde_json::json!("moonlet-desktop"), &serde_json::Value::Null)
    );
    let agent = created["agent"].as_u64().expect("an agent") as u32;

    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    let t = terminals.iter().find(|t| t.id == agent).expect("the agent's chat");
    let tag = DesignAgent { kind: DesignAgentKind::Design, workspace: ws.clone(), slug: "settings-page".into(), name: "Settings page".into() };
    assert_eq!(
        (t.title.as_str(), t.cwd.as_str(), t.session_id.as_deref(), t.chat, t.design.clone()),
        ("Design · Settings page", real_dir.as_str(), None, true, Some(tag))
    );

    let file = |name: &str| {
        let p = dir.join(name);
        move || std::fs::read_to_string(&p).unwrap_or_default()
    };
    let user = until_contains(file("claude-user"), "A settings page with General and Git sections").await;
    let args = file("claude-args")();
    assert!(args.contains("--permission-mode acceptEdits"), "{args}");
    assert!(args.contains(&format!("--add-dir {real_system}")), "{args}");
    assert!(args.contains(&format!("\"deny\":[\"Edit(/{real_system}/**)\"]")), "{args}");
    assert!(args.contains("design check)"), "{args}");
    // The brief went with the design system's README and the design rules.
    assert!(user.contains("Link styles.css; buttons are .btn."), "{user}");
    assert!(user.contains("Keep `data-mid` on every element"), "{user}");

    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    assert_eq!(
        (&list[0]["slug"], &list[0]["kind"], &list[0]["path"], list[0]["agent"].as_u64()),
        (&serde_json::json!("settings-page"), &serde_json::json!("workspace"), &serde_json::json!(dir), Some(agent as u64))
    );
    assert!(list[0]["agent_state"].is_string(), "{list}");
    assert_eq!(list[0]["open_comments"], 0);

    let _: bool = c.request(methods::DESIGN_REMOVE, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    assert!(!dir.exists());
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    assert!(!terminals.iter().any(|t| t.id == agent), "the agent of a removed design still runs");
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    assert_eq!(list, serde_json::json!([]));
}

/// The next event `event` that `c` gets and `wanted` takes, within 15 s.
async fn next_event(c: &mut Client, event: &str, wanted: impl Fn(&serde_json::Value) -> bool) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let f = tokio::time::timeout_at(deadline, c.next_frame()).await.unwrap_or_else(|_| panic!("no {event}")).unwrap().unwrap();
        if let Frame::Json(Message::Event { name, data }) = f
            && name == event
            && wanted(&data)
        {
            return data;
        }
    }
}

/// The next `design.open` event `c` gets.
async fn next_design_open(c: &mut Client) -> serde_json::Value {
    next_event(c, methods::EV_DESIGN_OPEN, |_| true).await
}

/// The next `design.changed` that names `path`.
async fn next_change_of(c: &mut Client, path: &str) -> serde_json::Value {
    next_event(c, methods::EV_DESIGN_CHANGED, |data| data["paths"].as_array().is_some_and(|p| p.iter().any(|x| x == path))).await
}

/// X65: `design.open` reaches every client as the event `design.open`, and
/// a design an agent started (`spawned_by`) is announced the same way with
/// that agent's terminal and session, so the app shows a toast instead.
#[tokio::test]
async fn design_open_and_a_design_an_agent_starts_reach_the_app() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let mut app = d.client().await;
    let refused = c
        .request::<_, serde_json::Value>(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b", "spawned_by": 99}),
        )
        .await;
    assert_eq!(refused.unwrap_err().to_string(), "invalid_params: no terminal 99");
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let agent = created["agent"].as_u64().unwrap();
    // The design's own agent stands in for an agent in a session here.
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "name": "Onboarding", "system": "moonlet-desktop", "brief": "b", "spawned_by": agent}),
        )
        .await
        .unwrap();
    assert_eq!(
        next_design_open(&mut app).await,
        serde_json::json!({"workspace": ws, "slug": "onboarding", "name": "Onboarding", "spawned_by": agent})
    );
    let _: bool = c.request(methods::DESIGN_OPEN, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    assert_eq!(
        next_design_open(&mut app).await,
        serde_json::json!({"workspace": ws, "slug": "settings-page", "name": "Settings page"})
    );
    let missing = c.request::<_, bool>(methods::DESIGN_OPEN, serde_json::json!({"workspace": ws, "slug": "nope"})).await;
    assert!(missing.is_err());
}

/// X65 entry 7: the design screen saves the viewport it shows a design at,
/// and design.list gives it back with the brief.
#[tokio::test]
async fn the_viewport_a_design_was_last_shown_at_is_saved_and_listed() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let _: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "A left nav"}))
        .await
        .unwrap();
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    assert_eq!((&list[0]["brief"], &list[0]["viewport"]), (&serde_json::json!("A left nav"), &serde_json::json!("1440x900")));
    let _: bool = c
        .request(methods::DESIGN_VIEWPORT, serde_json::json!({"workspace": ws, "slug": "settings-page", "viewport": "390x844"}))
        .await
        .unwrap();
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    assert_eq!(list[0]["viewport"], "390x844");
    let toml = std::fs::read_to_string(d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page/design.toml")).unwrap();
    assert!(toml.contains("viewport = \"390x844\"\n"), "{toml}");
    let bad = c
        .request::<_, bool>(methods::DESIGN_VIEWPORT, serde_json::json!({"workspace": ws, "slug": "settings-page", "viewport": "phone"}))
        .await;
    assert_eq!(bad.unwrap_err().to_string(), "invalid_params: bad viewport \"phone\": give a width and a height in px, such as 390x844");
}

/// X65 entry 8: a design's comments are kept, sent and resolved over the
/// socket, each change announced as the design's, and its listing counts the
/// open ones.
#[tokio::test]
async fn a_designs_comments_are_put_sent_resolved_and_counted_in_its_listing() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let _: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let mut listener = d.client().await;
    let pin: serde_json::Value = c
        .request(
            methods::DESIGN_COMMENT_PUT,
            serde_json::json!({"workspace": ws, "slug": "settings-page", "new": {"page": "index", "mid": "m12", "tag": "nav", "text": "General Appearance", "comment": "Collapse into a menu on phone"}}),
        )
        .await
        .unwrap();
    assert_eq!(
        pin,
        serde_json::json!([{"n": 1, "page": "index", "mid": "m12", "tag": "nav", "text": "General Appearance", "comment": "Collapse into a menu on phone", "sent_at": null, "state": "open"}])
    );
    let data = next_change_of(&mut listener, "comments.json").await;
    assert_eq!(data["design"], "settings-page");
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    assert_eq!(list[0]["open_comments"], 1);
    let sent: serde_json::Value = c
        .request(
            methods::DESIGN_COMMENT_PUT,
            serde_json::json!({"workspace": ws, "slug": "settings-page", "sent": {"pins": [{"n": 1, "comment": "Collapse into a menu on phone"}]}}),
        )
        .await
        .unwrap();
    assert!(sent[0]["sent_at"].as_u64().is_some(), "{sent}");
    let resolved: serde_json::Value = c
        .request(methods::DESIGN_COMMENT_RESOLVE, serde_json::json!({"workspace": ws, "slug": "settings-page", "n": 1}))
        .await
        .unwrap();
    assert_eq!(resolved["state"], "resolved");
    let pins: serde_json::Value = c.request(methods::DESIGN_COMMENTS, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    assert_eq!((pins.as_array().map(Vec::len), &pins[0]["state"]), (Some(1), &serde_json::json!("resolved")));
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    assert_eq!(list[0]["open_comments"], 0);
    let bad = c
        .request::<_, serde_json::Value>(
            methods::DESIGN_COMMENT_PUT,
            serde_json::json!({"workspace": ws, "slug": "settings-page", "new": {"page": "index", "mid": "x\"]", "tag": "nav", "text": "", "comment": "c"}}),
        )
        .await;
    assert_eq!(bad.unwrap_err().to_string(), "invalid_params: bad data-mid \"x\"]\"");
}

/// X65: comment changes that overlap, here the first pins of a design
/// without a `comments.json` and then edits to them, each from its own
/// client, keep every pin, numbered once each.
#[tokio::test]
async fn overlapping_comment_changes_keep_every_pin() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let _: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    const PINS: u64 = 12;
    let mut clients = Vec::new();
    for _ in 0..PINS {
        clients.push(d.client().await);
    }
    // Each change on its own client, all at once.
    let put_all = |clients: Vec<Client>, change: fn(u64) -> serde_json::Value| {
        let runs: Vec<_> = clients
            .into_iter()
            .zip(1..)
            .map(|(mut c, i)| {
                let mut params = serde_json::json!({"workspace": ws, "slug": "settings-page"});
                params.as_object_mut().unwrap().extend(change(i).as_object().unwrap().clone());
                tokio::spawn(async move {
                    c.request::<_, serde_json::Value>(methods::DESIGN_COMMENT_PUT, params).await.unwrap();
                    c
                })
            })
            .collect();
        async move {
            let mut back = Vec::new();
            for run in runs {
                back.push(run.await.unwrap());
            }
            back
        }
    };
    let clients = put_all(clients, |i| serde_json::json!({"new": {"page": "index", "mid": format!("m{i}"), "tag": "p", "text": "", "comment": format!("comment {i}")}})).await;
    let mut pins: serde_json::Value = c.request(methods::DESIGN_COMMENTS, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    let mut mids: Vec<String> = pins.as_array().unwrap().iter().map(|p| p["mid"].as_str().unwrap().to_string()).collect();
    mids.sort();
    let mut want: Vec<String> = (1..=PINS).map(|i| format!("m{i}")).collect();
    want.sort();
    assert_eq!(mids, want);
    put_all(clients, |n| serde_json::json!({"edit": {"n": n, "comment": format!("edited {n}")}})).await;
    pins = c.request(methods::DESIGN_COMMENTS, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    let got: Vec<(u64, &str)> = pins.as_array().unwrap().iter().map(|p| (p["n"].as_u64().unwrap(), p["comment"].as_str().unwrap())).collect();
    let edited: Vec<String> = (1..=PINS).map(|n| format!("edited {n}")).collect();
    assert_eq!(got, (1..=PINS).zip(edited.iter().map(String::as_str)).collect::<Vec<_>>());
}

/// X65 entry 9: the visual editor reads a page with its version and saves it
/// over that version, exactly as sent; a save over a page that changed on
/// disk since is refused as `stale` and leaves the change.
#[tokio::test]
async fn a_page_is_read_with_its_version_saved_as_sent_and_a_stale_save_is_refused() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let _: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let file = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page/pages/index.html");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "<!doctype html>\r\n<body data-mid=\"m1\">\r\n<h1 data-mid=m2>Settings</h1>\r\n</body>\r\n").unwrap();
    let page: serde_json::Value = c
        .request(methods::DESIGN_PAGE, serde_json::json!({"workspace": ws, "slug": "settings-page", "page": "index"}))
        .await
        .unwrap();
    assert_eq!(
        page,
        serde_json::json!({"html": "<!doctype html>\r\n<body data-mid=\"m1\">\r\n<h1 data-mid=m2>Settings</h1>\r\n</body>\r\n", "version": "481faada599299fe4a62df14441b3ede9a8a2d0a53b1c90e93902910d05ec0e4", "parse_error": null})
    );
    let mut listener = d.client().await;
    let edited = "<!doctype html>\r\n<body data-mid=\"m1\">\r\n<h1 data-mid=m2>Settings &amp; more</h1>\r\n</body>\r\n";
    let saved: serde_json::Value = c
        .request(
            methods::DESIGN_WRITE_PAGE,
            serde_json::json!({"workspace": ws, "slug": "settings-page", "page": "index", "html": edited, "base_version": page["version"]}),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), edited);
    let again: serde_json::Value = c
        .request(methods::DESIGN_PAGE, serde_json::json!({"workspace": ws, "slug": "settings-page", "page": "index"}))
        .await
        .unwrap();
    assert_eq!(again["version"], saved["version"]);
    let data = next_change_of(&mut listener, "pages/index.html").await;
    assert_eq!(data["design"], "settings-page");
    std::fs::write(&file, "<p data-mid=\"m1\">The agent's</p>\n").unwrap();
    let stale = c
        .request::<_, serde_json::Value>(
            methods::DESIGN_WRITE_PAGE,
            serde_json::json!({"workspace": ws, "slug": "settings-page", "page": "index", "html": "<p>mine</p>", "base_version": saved["version"]}),
        )
        .await;
    assert_eq!(stale.unwrap_err().to_string(), "stale: pages/index.html changed since it was read");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "<p data-mid=\"m1\">The agent's</p>\n");
    let bad = c
        .request::<_, serde_json::Value>(
            methods::DESIGN_WRITE_PAGE,
            serde_json::json!({"workspace": ws, "slug": "settings-page", "page": "../design", "html": "x", "base_version": "0"}),
        )
        .await;
    assert_eq!(bad.unwrap_err().to_string(), "invalid_params: bad page \"../design\"");
}

/// X65: saves of one page that overlap, each from its own client and all
/// over the version read, are taken one at a time: one is saved, every
/// other is refused as `stale`, and the file is the one saved.
#[tokio::test]
async fn overlapping_saves_of_a_page_over_one_version_save_one_and_refuse_the_others_as_stale() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let _: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let file = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page/pages/index.html");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    const SAVES: usize = 12;
    for round in 0..5 {
        std::fs::write(&file, format!("<!doctype html>\n<body data-mid=\"m1\"><h1 data-mid=\"m2\">Round {round}</h1></body>\n")).unwrap();
        let page: serde_json::Value = c
            .request(methods::DESIGN_PAGE, serde_json::json!({"workspace": ws, "slug": "settings-page", "page": "index"}))
            .await
            .unwrap();
        let mut runs = Vec::new();
        for i in 0..SAVES {
            let mut client = d.client().await;
            let html = format!("<!doctype html>\n<body data-mid=\"m1\"><h1 data-mid=\"m2\">Round {round}, save {i}</h1></body>\n");
            let params = serde_json::json!({"workspace": ws, "slug": "settings-page", "page": "index", "html": html, "base_version": page["version"]});
            runs.push(tokio::spawn(async move { (html, client.request::<_, serde_json::Value>(methods::DESIGN_WRITE_PAGE, params).await.map_err(|e| e.to_string())) }));
        }
        let mut saved = Vec::new();
        for run in runs {
            match run.await.unwrap() {
                (html, Ok(_)) => saved.push(html),
                (_, Err(e)) => assert_eq!(e, "stale: pages/index.html changed since it was read"),
            }
        }
        assert_eq!(saved.len(), 1, "round {round}: saved {saved:?}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), saved[0]);
    }
}

/// X65 entry 10: the visual editor's tokens and snippets come from the
/// design's own design system.
#[tokio::test]
async fn a_designs_kit_gives_its_systems_tokens_and_snippet_cards() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let _: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let system = d.home.path().join(".moonlet/design").join(&ws).join("systems/moonlet-desktop");
    std::fs::create_dir_all(system.join("tokens")).unwrap();
    std::fs::write(system.join("styles.css"), "@import \"tokens/scale.css\";\n").unwrap();
    std::fs::write(system.join("tokens/scale.css"), ":root { --space-4: 16px; }\n").unwrap();
    let card = "<!-- @dsCard group=\"Forms\" name=\"Switch\" -->\n<section class=\"ds-cell\" data-snippet=\"forms/switch/on\"><h4>on</h4><div class=\"ds-mount\"><span class=\"switch is-on\"></span></div></section>\n";
    let file = system.join("components/forms/Switch/Switch.html");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, card).unwrap();
    let kit: serde_json::Value = c
        .request(methods::DESIGN_KIT, serde_json::json!({"workspace": ws, "slug": "settings-page"}))
        .await
        .unwrap();
    assert_eq!(
        kit,
        serde_json::json!({
            "system": "moonlet-desktop",
            "tokens": [{"name": "--space-4", "value": "16px", "family": "spacing"}],
            "cards": [{"path": "components/forms/Switch/Switch.html", "group": "Forms", "name": "Switch", "html": card}],
        })
    );
}

/// X65: a design needs a design system its workspace has, and a session
/// design a session moonlet has.
#[tokio::test]
async fn a_design_on_an_unknown_system_or_in_an_unknown_session_is_refused() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let unknown = c
        .request::<_, serde_json::Value>(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "x", "system": "storefront", "brief": "b"}))
        .await;
    assert_eq!(unknown.unwrap_err().to_string(), "invalid_params: no design system \"storefront\"");
    let session = c
        .request::<_, serde_json::Value>(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "name": "x", "system": "moonlet-desktop", "brief": "b", "session": "s1"}),
        )
        .await;
    assert_eq!(session.unwrap_err().to_string(), "invalid_params: no session \"s1\"");
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    assert_eq!(list, serde_json::json!([]));
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    assert!(!terminals.iter().any(|t| t.chat), "an agent started for a design that was refused");
}

/// X64, X65: a Design mode agent whose first message cannot reach Claude Code
/// (here a `claude` whose interpreter is missing, so it never starts) leaves
/// no chat behind: the design or system is made, with why its agent did not start.
#[tokio::test]
async fn a_design_mode_agent_that_cannot_take_its_first_message_leaves_no_chat_behind() {
    let d = fake_claude_daemon("#!/nonexistent/interpreter\n").await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    assert_eq!(created["agent"], serde_json::Value::Null);
    assert!(created["agent_error"].is_string(), "{created}");
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    assert!(!terminals.iter().any(|t| t.chat), "a design's agent that never started is left behind");

    let system: serde_json::Value = c
        .request(methods::DESIGN_SYSTEM_CREATE, serde_json::json!({"workspace": ws, "name": "storefront", "sources": []}))
        .await
        .unwrap();
    assert_eq!((&system["slug"], &system["agent"]), (&serde_json::json!("storefront"), &serde_json::Value::Null));
    assert!(system["agent_error"].is_string(), "{system}");
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    assert!(!terminals.iter().any(|t| t.chat), "a sync agent that never started is left behind");
}

/// X65: a design's agent whose ownership record cannot be saved leaves no
/// chat behind that no design owns.
#[tokio::test]
async fn a_designs_agent_whose_record_cannot_be_saved_leaves_no_chat_behind() {
    use std::os::unix::fs::PermissionsExt;
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let records = d.home.path().join(".moonlet/design").join(&ws).join(".records/designs");
    std::fs::create_dir_all(&records).unwrap();
    std::fs::set_permissions(&records, std::fs::Permissions::from_mode(0o555)).unwrap();
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    std::fs::set_permissions(&records, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(created["agent"], serde_json::Value::Null);
    assert!(created["agent_error"].is_string(), "{created}");
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    assert!(!terminals.iter().any(|t| t.chat), "a chat no design owns is left behind");
}

/// X65: a design's agent is owned by moonletd and comes back after a restart,
/// still its design's, with its tag.
#[tokio::test]
async fn a_designs_agent_comes_back_after_a_restart() {
    use moonlet_proto::types::DesignAgentKind;
    let mut d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let agent = created["agent"].as_u64().expect("an agent") as u32;
    d.restart().await;
    let mut c = d.client().await;
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    let t = terminals.iter().find(|t| t.id == agent).expect("the restored chat");
    assert_eq!(
        (t.chat, t.design.as_ref().map(|tag| (tag.kind, tag.slug.as_str()))),
        (true, Some((DesignAgentKind::Design, "settings-page")))
    );
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    assert_eq!(list[0]["agent"].as_u64(), Some(agent as u64), "{list}");
}

/// A `claude` for Design mode's agents: it records its arguments
/// (`claude-args`) and every message (`claude-user`) in its folder, and
/// answers each message at once.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
echo "$@" >> claude-args
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}' ;;
    *'"type":"user"'*) echo "$line" >> claude-user
      echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}' ;;
  esac
done
"#;

/// X64: a design source's sub-folder is a folder inside its project: one that
/// is absolute, climbs out with `..`, links out or is missing is refused, and a
/// record that names one anyway never gets it granted to the sync agent.
#[tokio::test]
async fn a_design_source_never_reaches_outside_its_project() {
    use moonlet_proto::types::{Project, Workspace};
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
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
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
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
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
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
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
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
    let data = next_change_of(&mut listener, "components/buttons/button/button.html").await;
    assert_eq!((data["workspace"].as_str(), data["system"].as_str()), (Some(ws.id.as_str()), Some("storefront")));
}

/// X65: a page written in a workspace design reaches every client as
/// design.changed, naming the design, so its canvas reloads.
#[tokio::test]
async fn a_page_written_in_a_design_is_announced() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let _: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let mut listener = d.client().await;
    let page = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page/pages/index.html");
    std::fs::write(&page, "<body data-mid=\"m1\"></body>\n").unwrap();
    let data = next_change_of(&mut listener, "pages/index.html").await;
    assert_eq!(
        (data["workspace"].as_str(), &data["system"], data["design"].as_str()),
        (Some(ws.as_str()), &serde_json::Value::Null, Some("settings-page"))
    );
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

/// A design's agent that writes `pages/index.html` on each turn, "turn <n>",
/// and holds a turn whose message says `HOLD-NOW`, working, until a file
/// `release` is in its folder.
const WRITING_CLAUDE: &str = r#"#!/bin/sh
n=0
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}' ;;
    *'"type":"user"'*) case "$line" in *'HOLD-NOW'*) while [ ! -f release ]; do sleep 0.05; done; rm -f release ;; esac
      n=$((n+1)); mkdir -p pages
      printf '<body data-mid="m1"><p data-mid="m2">turn %s</p></body>\n' "$n" > pages/index.html
      echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}' ;;
  esac
done
"#;

/// `design.history` once it lists `n` snapshots, within 10 s.
async fn history_of(c: &mut Client, ws: &str, n: usize) -> serde_json::Value {
    for _ in 0..100 {
        let listed: serde_json::Value = c.request(methods::DESIGN_HISTORY, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
        if listed.as_array().is_some_and(|a| a.len() >= n) {
            return listed;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no {n} snapshots");
}

/// X65: when a design's agent ends a turn that changed its pages, the
/// daemon takes a snapshot, which `design.history` lists with what the turn
/// wrote, and `design.changed` announces.
#[tokio::test]
async fn an_agent_turn_that_changed_the_design_takes_a_snapshot() {
    let d = fake_claude_daemon(WRITING_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let mut listener = d.client().await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let listed = history_of(&mut c, &ws, 1).await;
    let first = &listed[0];
    assert_eq!(
        (&first["n"], &first["type"], &first["summary"], &first["pages"]),
        (&serde_json::json!(1), &serde_json::json!("agent_turn"), &serde_json::json!("Wrote index.html · 1 page"), &serde_json::json!(["index"]))
    );
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    assert_eq!(std::fs::read_to_string(dir.join("history/1/pages/index.html")).unwrap(), "<body data-mid=\"m1\"><p data-mid=\"m2\">turn 1</p></body>\n");
    next_change_of(&mut listener, "history/1/snapshot.json").await;

    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": created["agent"], "text": "Again"})).await.unwrap();
    let listed = history_of(&mut c, &ws, 2).await;
    assert_eq!((&listed[0]["n"], &listed[0]["type"]), (&serde_json::json!(2), &serde_json::json!("agent_turn")));
    assert_eq!(std::fs::read_to_string(dir.join("history/2/pages/index.html")).unwrap(), "<body data-mid=\"m1\"><p data-mid=\"m2\">turn 2</p></body>\n");
}

/// X65: edits by hand, `design.write_page`'s saves, are kept in a snapshot
/// once they stop for a while (10 s; 1 s here, through the daemon's
/// `MOONLET_DESIGN_QUIET_MS`), summed up from what each save said its
/// edits did.
#[tokio::test]
async fn edits_by_hand_take_a_snapshot_once_they_stop_for_a_while() {
    let d = fake_claude_daemon_with(FAKE_CLAUDE, vec![("MOONLET_DESIGN_QUIET_MS".into(), "1000".into())]).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    // Its first turn over: edits made during a turn go with the turn's snapshot.
    turn_over(&mut c, created["agent"].as_u64().unwrap()).await;
    let file = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page/pages/index.html");
    std::fs::write(&file, "<body data-mid=\"m1\"></body>\n").unwrap();
    let mut version: serde_json::Value = c.request(methods::DESIGN_PAGE, serde_json::json!({"workspace": ws, "slug": "settings-page", "page": "index"})).await.unwrap();
    let mut save = async |html: &str, edits: &[&str]| {
        let saved: serde_json::Value = c
            .request(
                methods::DESIGN_WRITE_PAGE,
                serde_json::json!({"workspace": ws, "slug": "settings-page", "page": "index", "html": html, "base_version": version["version"], "edits": edits}),
            )
            .await
            .unwrap();
        version = saved;
    };
    save("<body data-mid=\"m1\"><p>1</p></body>\n", &["moved section m24", "restyled h2 m25"]).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let last = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    save("<body data-mid=\"m1\"><p>2</p></body>\n", &["restyled h2 m25", "text of m30"]).await;
    let edits = |listed: &serde_json::Value| listed.as_array().unwrap().iter().filter(|s| s["type"] == "edits_by_hand").cloned().collect::<Vec<_>>();
    // Not while the edits go on.
    let now: serde_json::Value = c.request(methods::DESIGN_HISTORY, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    assert_eq!(edits(&now), Vec::<serde_json::Value>::new());
    let mut taken = Vec::new();
    for _ in 0..100 {
        let listed: serde_json::Value = c.request(methods::DESIGN_HISTORY, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
        taken = edits(&listed);
        if !taken.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(taken.len(), 1, "one snapshot for the burst");
    assert_eq!(taken[0]["summary"], "Moved section m24, restyled h2 m25, text of m30");
    assert!(taken[0]["time"].as_u64().unwrap() >= last + 1000, "taken {} after the last save at {last}", taken[0]["time"]);
    let n = taken[0]["n"].as_u64().unwrap();
    let kept = d.home.path().join(".moonlet/design").join(&ws).join(format!("designs/settings-page/history/{n}/pages/index.html"));
    assert_eq!(std::fs::read_to_string(kept).unwrap(), "<body data-mid=\"m1\"><p>2</p></body>\n");
}

/// X65: `design.snapshot.restore` makes a snapshot the design's pages, after
/// keeping what was not kept yet, and records a Restored snapshot entry;
/// an unknown snapshot is a bad parameter, and it waits for the agent:
/// refused as `busy` while it works.
#[tokio::test]
async fn a_snapshot_is_restored_over_rpc_but_never_while_the_agent_works() {
    let d = fake_claude_daemon(WRITING_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    history_of(&mut c, &ws, 1).await;
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": created["agent"], "text": "Again"})).await.unwrap();
    let listed = history_of(&mut c, &ws, 2).await;
    let file = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page/pages/index.html");
    // Changed by hand outside the editor, and not kept yet.
    std::fs::write(&file, "<p>by hand</p>\n").unwrap();
    let restore = |n: u32| serde_json::json!({"workspace": ws, "slug": "settings-page", "n": n});
    let restored: serde_json::Value = c.request(methods::DESIGN_SNAPSHOT_RESTORE, restore(1)).await.unwrap();
    assert_eq!(
        (&restored["n"], &restored["type"], &restored["from"], &restored["summary"]),
        (&serde_json::json!(4), &serde_json::json!("restored"), &serde_json::json!({"n": 1, "time": listed[1]["time"]}), &serde_json::json!(""))
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "<body data-mid=\"m1\"><p data-mid=\"m2\">turn 1</p></body>\n");
    let listed: serde_json::Value = c.request(methods::DESIGN_HISTORY, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    let kinds: Vec<(u64, &str, &str)> = listed.as_array().unwrap().iter().map(|s| (s["n"].as_u64().unwrap(), s["type"].as_str().unwrap(), s["summary"].as_str().unwrap())).collect();
    assert_eq!(
        kinds,
        [(4, "restored", ""), (3, "edits_by_hand", "Wrote index.html · 1 page"), (2, "agent_turn", "Wrote index.html · 1 page"), (1, "agent_turn", "Wrote index.html · 1 page")]
    );
    let unknown = c.request::<_, serde_json::Value>(methods::DESIGN_SNAPSHOT_RESTORE, restore(9)).await;
    assert_eq!(unknown.unwrap_err().to_string(), "invalid_params: no snapshot 9");

    // The agent at work, held there: the first restore is refused.
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": created["agent"], "text": "HOLD-NOW"})).await.unwrap();
    working(&mut c, created["agent"].as_u64().unwrap()).await;
    let busy = c.request::<_, serde_json::Value>(methods::DESIGN_SNAPSHOT_RESTORE, restore(2)).await;
    assert_eq!(busy.unwrap_err().to_string(), "busy: Claude is changing the design; restore once it stops");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "<body data-mid=\"m1\"><p data-mid=\"m2\">turn 1</p></body>\n");
    std::fs::write(file.parent().unwrap().parent().unwrap().join("release"), "").unwrap();
}

/// Waits until chat `id`'s agent has ended its turn, within 10 s.
async fn turn_over(c: &mut Client, id: u64) {
    for _ in 0..100 {
        let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
        if terminals.iter().any(|t| u64::from(t.id) == id && t.agent_state == moonlet_proto::types::AgentState::Done) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("chat {id} never ended its turn");
}

/// Waits until chat `id`'s agent works, within 10 s.
async fn working(c: &mut Client, id: u64) {
    for _ in 0..100 {
        let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
        if terminals.iter().any(|t| u64::from(t.id) == id && t.agent_state == moonlet_proto::types::AgentState::Working) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("chat {id} never worked");
}

/// The design `settings-page`'s page, saved by hand over the version on disk
/// with what its edits did.
async fn save_by_hand(c: &mut Client, ws: &str, html: &str, edits: &[&str]) {
    let read: serde_json::Value = c.request(methods::DESIGN_PAGE, serde_json::json!({"workspace": ws, "slug": "settings-page", "page": "index"})).await.unwrap();
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_WRITE_PAGE,
            serde_json::json!({"workspace": ws, "slug": "settings-page", "page": "index", "html": html, "base_version": read["version"], "edits": edits}),
        )
        .await
        .unwrap();
}

/// X65: edits by hand not kept yet when the design's agent starts a turn
/// are kept at once as their own snapshot, so the turn's snapshot holds
/// only the agent's work.
#[tokio::test]
async fn edits_by_hand_are_kept_on_their_own_when_the_agent_starts_a_turn() {
    let d = fake_claude_daemon_with(WRITING_CLAUDE, vec![("MOONLET_DESIGN_QUIET_MS".into(), "60000".into())]).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    history_of(&mut c, &ws, 1).await;
    save_by_hand(&mut c, &ws, "<p>by hand</p>\n", &["text of m2"]).await;
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": created["agent"], "text": "HOLD-NOW"})).await.unwrap();
    let listed = history_of(&mut c, &ws, 2).await;
    assert_eq!((&listed[0]["n"], &listed[0]["type"], &listed[0]["summary"]), (&serde_json::json!(2), &serde_json::json!("edits_by_hand"), &serde_json::json!("Text of m2")));
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    assert_eq!(std::fs::read_to_string(dir.join("history/2/pages/index.html")).unwrap(), "<p>by hand</p>\n");
    std::fs::write(dir.join("release"), "").unwrap();
    let listed = history_of(&mut c, &ws, 3).await;
    assert_eq!((&listed[0]["n"], &listed[0]["type"]), (&serde_json::json!(3), &serde_json::json!("agent_turn")));
    assert_eq!(std::fs::read_to_string(dir.join("history/3/pages/index.html")).unwrap(), "<body data-mid=\"m1\"><p data-mid=\"m2\">turn 2</p></body>\n");
}

/// X65: while the design's agent works, the wait for edits by hand to stop
/// takes no snapshot, which could hold the agent's half-written pages:
/// edits saved during the turn go with the turn's snapshot.
#[tokio::test]
async fn edits_by_hand_saved_while_the_agent_works_go_with_its_turn() {
    let d = fake_claude_daemon_with(WRITING_CLAUDE, vec![("MOONLET_DESIGN_QUIET_MS".into(), "300".into())]).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    history_of(&mut c, &ws, 1).await;
    let agent = created["agent"].as_u64().unwrap();
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "HOLD-NOW"})).await.unwrap();
    working(&mut c, agent).await;
    save_by_hand(&mut c, &ws, "<p>by hand, while the agent works</p>\n", &["text of m2"]).await;
    // Well past the quiet: still only the first turn's snapshot.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let listed: serde_json::Value = c.request(methods::DESIGN_HISTORY, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1, "{listed}");
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    std::fs::write(dir.join("release"), "").unwrap();
    let listed = history_of(&mut c, &ws, 2).await;
    assert_eq!((&listed[0]["n"], &listed[0]["type"]), (&serde_json::json!(2), &serde_json::json!("agent_turn")));
    tokio::time::sleep(Duration::from_millis(800)).await;
    let listed: serde_json::Value = c.request(methods::DESIGN_HISTORY, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 2, "{listed}");
}

/// X65: edits by hand saved once the design's agent works go with its
/// turn even when the daemon hears late that it works: here its start
/// waits in line behind another design's turn, whose snapshot waits for a
/// `check --fix` of a long page. They are never kept on their own in the
/// middle of the turn.
#[tokio::test]
async fn edits_by_hand_saved_once_the_agent_works_go_with_its_turn_though_its_start_is_heard_late() {
    let d = fake_claude_daemon_with(WRITING_CLAUDE, vec![("MOONLET_DESIGN_QUIET_MS".into(), "60000".into())]).await;
    let mut c = d.client().await;
    let mut checker = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let create = |name: &str| serde_json::json!({"workspace": ws, "name": name, "system": "moonlet-desktop", "brief": "b"});
    let created: serde_json::Value = c.request(methods::DESIGN_CREATE, create("Settings page")).await.unwrap();
    let other: serde_json::Value = c.request(methods::DESIGN_CREATE, create("Other page")).await.unwrap();
    let (agent, other_agent) = (created["agent"].as_u64().unwrap(), other["agent"].as_u64().unwrap());
    history_of(&mut c, &ws, 1).await;
    turn_over(&mut c, agent).await;
    turn_over(&mut c, other_agent).await;
    let designs = d.home.path().join(".moonlet/design").join(&ws).join("designs");
    // The other design's agent holds its turn; a check numbers a long page
    // of that design, holding its pages, when the turn ends.
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": other_agent, "text": "HOLD-NOW"})).await.unwrap();
    working(&mut c, other_agent).await;
    std::fs::write(designs.join("other-page/pages/long.html"), format!("<body>{}</body>\n", "<p>row</p>".repeat(60_000))).unwrap();
    let fix = serde_json::json!({"design": {"workspace": ws, "slug": "other-page"}, "fix": true});
    let check = tokio::spawn(async move { checker.request::<_, serde_json::Value>(methods::DESIGN_CHECK, fix).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(500)).await;
    std::fs::write(designs.join("other-page/release"), "").unwrap();
    turn_over(&mut c, other_agent).await;
    // This design's agent starts working, heard only after that snapshot.
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "HOLD-NOW"})).await.unwrap();
    working(&mut c, agent).await;
    save_by_hand(&mut c, &ws, "<p>by hand, while the agent works</p>\n", &["text of m2"]).await;
    assert!(!check.is_finished(), "the check still holds the other design's pages");
    assert!(check.await.unwrap().is_array());
    std::fs::write(designs.join("settings-page/release"), "").unwrap();
    let listed = history_of(&mut c, &ws, 2).await;
    let kinds: Vec<(u64, &str)> = listed.as_array().unwrap().iter().map(|s| (s["n"].as_u64().unwrap(), s["type"].as_str().unwrap())).collect();
    assert_eq!(kinds, [(2, "agent_turn"), (1, "agent_turn")], "{listed}");
}

/// A design's agent like [`WRITING_CLAUDE`] that reads a message sent
/// during its turn, `QUEUED`, only once a `go` file is in its folder, says
/// it started it, which starts the next turn with no `chat.send`, and holds
/// that turn until `release`.
const QUEUEING_CLAUDE: &str = r#"#!/bin/sh
n=0
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}' ;;
    *'"type":"user"'*) case "$line" in
        *'QUEUED'*) while [ ! -f go ]; do sleep 0.05; done; rm -f go
          uuid=${line#*'"uuid":"'}; uuid=${uuid%%'"'*}
          echo "{\"type\":\"command_lifecycle\",\"command_uuid\":\"$uuid\",\"state\":\"started\",\"session_id\":\"s1\"}"
          while [ ! -f release ]; do sleep 0.05; done; rm -f release ;;
        *'HOLD-NOW'*) while [ ! -f release ]; do sleep 0.05; done; rm -f release ;;
      esac
      n=$((n+1)); mkdir -p pages
      printf '<body data-mid="m1"><p data-mid="m2">turn %s</p></body>\n' "$n" > pages/index.html
      echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}' ;;
  esac
done
"#;

/// X65: when the daemon hears a design's agent start only after edits by
/// hand saved before it worked and others saved once it works, the edits
/// from before still get their own Edits by hand snapshot as it starts;
/// only those saved during the turn go with it. That snapshot holds the
/// pages as they are when the start is heard, the later save's too, and is
/// labelled with the edits from before only. Here the turn starts from a
/// message queued during the last one, with no `chat.send` to keep the
/// edits first, and its start is held in line (`MOONLET_DESIGN_TURNS_HELD`)
/// until both are saved.
#[tokio::test]
async fn edits_by_hand_saved_before_a_start_heard_late_keep_their_own_snapshot() {
    let held = tempfile::tempdir().unwrap();
    let hold = held.path().join("hold");
    let env = vec![("MOONLET_DESIGN_QUIET_MS".into(), "60000".into()), ("MOONLET_DESIGN_TURNS_HELD".into(), hold.display().to_string())];
    let d = fake_claude_daemon_with(QUEUEING_CLAUDE, env).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let agent = created["agent"].as_u64().unwrap();
    history_of(&mut c, &ws, 1).await;
    turn_over(&mut c, agent).await;
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    // The agent holds a turn, and a message is queued during it.
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "HOLD-NOW"})).await.unwrap();
    working(&mut c, agent).await;
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "QUEUED"})).await.unwrap();
    std::fs::write(dir.join("release"), "").unwrap();
    turn_over(&mut c, agent).await;
    history_of(&mut c, &ws, 2).await;
    // Saved before the agent works; then the queued message starts its
    // turn, whose start waits in line, and a save during it.
    std::fs::write(&hold, "").unwrap();
    save_by_hand(&mut c, &ws, "<p>by hand, before the agent works</p>\n", &["text of m2"]).await;
    std::fs::write(dir.join("go"), "").unwrap();
    working(&mut c, agent).await;
    save_by_hand(&mut c, &ws, "<p>by hand, while the agent works</p>\n", &["style of m1"]).await;
    let listed: serde_json::Value = c.request(methods::DESIGN_HISTORY, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 2, "nothing kept while the start waits: {listed}");
    // The start is heard: what it keeps is kept before the turn ends.
    std::fs::remove_file(&hold).unwrap();
    let listed = history_of(&mut c, &ws, 3).await;
    assert_eq!((&listed[0]["n"], &listed[0]["type"], &listed[0]["summary"]), (&serde_json::json!(3), &serde_json::json!("edits_by_hand"), &serde_json::json!("Text of m2")), "{listed}");
    assert_eq!(std::fs::read_to_string(dir.join("history/3/pages/index.html")).unwrap(), "<p>by hand, while the agent works</p>\n");
    std::fs::write(dir.join("release"), "").unwrap();
    let listed = history_of(&mut c, &ws, 4).await;
    let kinds: Vec<(u64, &str)> = listed.as_array().unwrap().iter().map(|s| (s["n"].as_u64().unwrap(), s["type"].as_str().unwrap())).collect();
    assert_eq!(kinds, [(4, "agent_turn"), (3, "edits_by_hand"), (2, "agent_turn"), (1, "agent_turn")], "{listed}");
}

/// X65: edits by hand kept before a restore are listed in the order they
/// were saved, one saved during the agent's turn before one saved after
/// it, though the turn's end waits in line (`MOONLET_DESIGN_TURNS_HELD`).
#[tokio::test]
async fn edits_by_hand_kept_before_a_restore_are_listed_in_the_order_they_were_saved() {
    let held = tempfile::tempdir().unwrap();
    let hold = held.path().join("hold");
    let env = vec![("MOONLET_DESIGN_QUIET_MS".into(), "60000".into()), ("MOONLET_DESIGN_TURNS_HELD".into(), hold.display().to_string())];
    let d = fake_claude_daemon_with(WRITING_CLAUDE, env).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let agent = created["agent"].as_u64().unwrap();
    history_of(&mut c, &ws, 1).await;
    turn_over(&mut c, agent).await;
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "HOLD-NOW"})).await.unwrap();
    working(&mut c, agent).await;
    // The turn's end waits in line from here.
    std::fs::write(&hold, "").unwrap();
    save_by_hand(&mut c, &ws, "<p>by hand, while the agent works</p>\n", &["text of m2"]).await;
    std::fs::write(dir.join("release"), "").unwrap();
    turn_over(&mut c, agent).await;
    save_by_hand(&mut c, &ws, "<p>by hand, after the turn</p>\n", &["style of m1"]).await;
    let _: serde_json::Value = c.request(methods::DESIGN_SNAPSHOT_RESTORE, serde_json::json!({"workspace": ws, "slug": "settings-page", "n": 1})).await.unwrap();
    std::fs::remove_file(&hold).unwrap();
    let listed = history_of(&mut c, &ws, 3).await;
    let kept = listed.as_array().unwrap().iter().find(|s| s["type"] == "edits_by_hand").unwrap_or_else(|| panic!("{listed}"));
    assert_eq!(kept["summary"], "Text of m2, style of m1", "{listed}");
}

/// X65: a restore that fails, of a snapshot the design does not have,
/// leaves the edits by hand not kept yet waiting: they are kept once they
/// stop, as without the restore.
#[tokio::test]
async fn a_failed_restore_leaves_the_edits_by_hand_waiting_to_be_kept() {
    let d = fake_claude_daemon_with(WRITING_CLAUDE, vec![("MOONLET_DESIGN_QUIET_MS".into(), "1000".into())]).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    history_of(&mut c, &ws, 1).await;
    turn_over(&mut c, created["agent"].as_u64().unwrap()).await;
    save_by_hand(&mut c, &ws, "<p>by hand</p>\n", &["text of m2"]).await;
    let failed = c.request::<_, serde_json::Value>(methods::DESIGN_SNAPSHOT_RESTORE, serde_json::json!({"workspace": ws, "slug": "settings-page", "n": 9})).await;
    assert_eq!(failed.unwrap_err().to_string(), "invalid_params: no snapshot 9");
    let listed = history_of(&mut c, &ws, 2).await;
    assert_eq!((&listed[0]["n"], &listed[0]["type"], &listed[0]["summary"]), (&serde_json::json!(2), &serde_json::json!("edits_by_hand"), &serde_json::json!("Text of m2")));
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    assert_eq!(std::fs::read_to_string(dir.join("history/2/pages/index.html")).unwrap(), "<p>by hand</p>\n");
}

/// X65: the wait for edits by hand to stop takes its snapshot under the
/// lock of the design's pages, as a save does: one that ends during a save
/// (here `design.check --fix` adding data-mids to a long page) waits for
/// it, and keeps what it wrote.
#[tokio::test]
async fn a_snapshot_of_edits_by_hand_waits_for_a_save_in_progress() {
    let d = fake_claude_daemon_with(WRITING_CLAUDE, vec![("MOONLET_DESIGN_QUIET_MS".into(), "500".into())]).await;
    let mut c = d.client().await;
    let mut checker = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    history_of(&mut c, &ws, 1).await;
    turn_over(&mut c, created["agent"].as_u64().unwrap()).await;
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    // A long page with no data-mids, which the check, started at once
    // after the save, numbers and writes after the wait has ended.
    let long = format!("<body>{}</body>\n", "<p>row</p>".repeat(80_000));
    std::fs::write(dir.join("pages/long.html"), &long).unwrap();
    save_by_hand(&mut c, &ws, "<p>by hand</p>\n", &["text of m2"]).await;
    let fixed: serde_json::Value = checker.request(methods::DESIGN_CHECK, serde_json::json!({"design": {"workspace": ws, "slug": "settings-page"}, "fix": true})).await.unwrap();
    assert!(fixed.is_array(), "{fixed}");
    let now = std::fs::read_to_string(dir.join("pages/long.html")).unwrap();
    assert!(now.contains("data-mid"), "the check numbered the page");
    let listed = history_of(&mut c, &ws, 2).await;
    assert_eq!((&listed[0]["n"], &listed[0]["type"], &listed[0]["summary"]), (&serde_json::json!(2), &serde_json::json!("edits_by_hand"), &serde_json::json!("Text of m2")));
    let kept = std::fs::read_to_string(dir.join("history/2/pages/long.html")).unwrap();
    assert!(kept == now, "snapshot 2 has the page as the check left it, not {} bytes with {} data-mids", kept.len(), kept.matches("data-mid").count());
}

/// A design's agent that writes `pages/index.html`, "turn <n>", the moment
/// each message reaches it, with the shell's own commands only.
const QUICK_CLAUDE: &str = r#"#!/bin/sh
n=0
mkdir -p pages
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}' ;;
    *'"type":"user"'*) n=$((n+1)); printf '<p data-mid="m2">turn %s</p>\n' "$n" > pages/index.html
      echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}' ;;
  esac
done
"#;

/// X65: edits by hand not kept yet are kept before a message reaches the
/// design's agent, so their snapshot never holds what the agent writes,
/// even one that writes the moment the message reaches it, and its turn's
/// snapshot holds only its own work.
#[tokio::test]
async fn edits_by_hand_are_kept_before_the_message_reaches_the_agent() {
    let d = fake_claude_daemon_with(QUICK_CLAUDE, vec![("MOONLET_DESIGN_QUIET_MS".into(), "60000".into())]).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let agent = created["agent"].as_u64().unwrap();
    history_of(&mut c, &ws, 1).await;
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    for k in 1..=10u64 {
        turn_over(&mut c, agent).await;
        save_by_hand(&mut c, &ws, &format!("<p>by hand {k}</p>\n"), &[&format!("text of m{k}")]).await;
        let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "Again"})).await.unwrap();
        let (hand, turn) = (2 * k, 2 * k + 1);
        let listed = history_of(&mut c, &ws, turn as usize).await;
        let kinds: Vec<(u64, &str)> = listed.as_array().unwrap()[..2].iter().map(|s| (s["n"].as_u64().unwrap(), s["type"].as_str().unwrap())).collect();
        assert_eq!(kinds, [(turn, "agent_turn"), (hand, "edits_by_hand")], "turn {k}");
        assert_eq!(std::fs::read_to_string(dir.join(format!("history/{hand}/pages/index.html"))).unwrap(), format!("<p>by hand {k}</p>\n"), "turn {k}");
        assert_eq!(std::fs::read_to_string(dir.join(format!("history/{turn}/pages/index.html"))).unwrap(), format!("<p data-mid=\"m2\">turn {}</p>\n", k + 1), "turn {k}");
    }
}

/// A design's agent that, told `ASK-ME`, writes half of `pages/other.html`
/// and asks to run a command, and ends its turn on any other message.
const ASKING_CLAUDE: &str = r#"#!/bin/sh
mkdir -p pages
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}' ;;
    *'ASK-ME'*) printf '<p data-mid="m3">half</p>\n' > pages/other.html
      echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}'
      echo '{"type":"control_request","request_id":"b1","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"t1","input":{"command":"ls"}}}' ;;
    *'"type":"user"'*) printf '<p data-mid="m3">whole</p>\n' > pages/other.html
      echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}' ;;
  esac
done
"#;

/// X65: a message sent while the design's agent asks the user is within
/// its turn: the edits by hand not kept yet then go with the turn's
/// snapshot, never on their own with its half-written pages. Edits saved
/// while it asks are within the turn too, also when the daemon hears it
/// start only after them: here its start is held in line
/// (`MOONLET_DESIGN_TURNS_HELD`) until the turn ends.
#[tokio::test]
async fn edits_by_hand_go_with_the_turn_when_a_message_comes_while_the_agent_asks() {
    let held = tempfile::tempdir().unwrap();
    let hold = held.path().join("hold");
    let env = vec![("MOONLET_DESIGN_QUIET_MS".into(), "60000".into()), ("MOONLET_DESIGN_TURNS_HELD".into(), hold.display().to_string())];
    let d = fake_claude_daemon_with(ASKING_CLAUDE, env).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let agent = created["agent"].as_u64().unwrap();
    history_of(&mut c, &ws, 1).await;
    turn_over(&mut c, agent).await;
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    std::fs::write(dir.join("pages/index.html"), "<p data-mid=\"m2\">first</p>\n").unwrap();
    std::fs::write(&hold, "").unwrap();
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "ASK-ME"})).await.unwrap();
    let mut asks = false;
    for _ in 0..100 {
        let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
        if terminals.iter().any(|t| u64::from(t.id) == agent && t.agent_state == moonlet_proto::types::AgentState::Blocked) {
            asks = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(asks, "the agent never asked");
    save_by_hand(&mut c, &ws, "<p>by hand</p>\n", &["text of m2"]).await;
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "Go on"})).await.unwrap();
    turn_over(&mut c, agent).await;
    // Its start and its end are heard now, in that order: snapshot 2 is
    // what the start keeps, if anything, else the end's.
    std::fs::remove_file(&hold).unwrap();
    let listed = history_of(&mut c, &ws, 2).await;
    let kinds: Vec<(u64, &str)> = listed.as_array().unwrap().iter().map(|s| (s["n"].as_u64().unwrap(), s["type"].as_str().unwrap())).collect();
    assert_eq!(kinds, [(2, "agent_turn"), (1, "agent_turn")]);
    assert_eq!(std::fs::read_to_string(dir.join("history/2/pages/index.html")).unwrap(), "<p>by hand</p>\n");
    assert_eq!(std::fs::read_to_string(dir.join("history/2/pages/other.html")).unwrap(), "<p data-mid=\"m3\">whole</p>\n");
}

/// X65: while the design's agent asks the user it is within its turn: the
/// wait for edits by hand saved meanwhile to stop takes nothing, however
/// long it asks, and a restore is refused; the edits go with the turn's
/// snapshot once it ends.
#[tokio::test]
async fn edits_by_hand_saved_while_the_agent_asks_wait_for_its_turn_however_long_it_asks() {
    let d = fake_claude_daemon_with(ASKING_CLAUDE, vec![("MOONLET_DESIGN_QUIET_MS".into(), "300".into())]).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let agent = created["agent"].as_u64().unwrap();
    history_of(&mut c, &ws, 1).await;
    turn_over(&mut c, agent).await;
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    std::fs::write(dir.join("pages/index.html"), "<p data-mid=\"m2\">first</p>\n").unwrap();
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "ASK-ME"})).await.unwrap();
    let mut asks = false;
    for _ in 0..100 {
        let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
        if terminals.iter().any(|t| u64::from(t.id) == agent && t.agent_state == moonlet_proto::types::AgentState::Blocked) {
            asks = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(asks, "the agent never asked");
    save_by_hand(&mut c, &ws, "<p>by hand, while the agent asks</p>\n", &["text of m2"]).await;
    let refused = c.request::<_, serde_json::Value>(methods::DESIGN_SNAPSHOT_RESTORE, serde_json::json!({"workspace": ws, "slug": "settings-page", "n": 1})).await;
    assert_eq!(refused.map_err(|e| e.to_string()).err().as_deref(), Some("busy: Claude is changing the design; restore once it stops"));
    // Well past the quiet, the agent still asking: still only the first turn's snapshot.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let listed: serde_json::Value = c.request(methods::DESIGN_HISTORY, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1, "{listed}");
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "Go on"})).await.unwrap();
    let listed = history_of(&mut c, &ws, 2).await;
    let kinds: Vec<(u64, &str)> = listed.as_array().unwrap().iter().map(|s| (s["n"].as_u64().unwrap(), s["type"].as_str().unwrap())).collect();
    assert_eq!(kinds, [(2, "agent_turn"), (1, "agent_turn")], "{listed}");
    assert_eq!(std::fs::read_to_string(dir.join("history/2/pages/index.html")).unwrap(), "<p>by hand, while the agent asks</p>\n");
}

/// A design's agent that, told `ASK-ME`, writes half of `pages/other.html`
/// and asks the user a question, which waits through a daemon restart, and
/// ends its turn on any other message.
const QUESTION_CLAUDE: &str = r#"#!/bin/sh
mkdir -p pages
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}' ;;
    *'ASK-ME'*) printf '<p data-mid="m3">half</p>\n' > pages/other.html
      echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"AskUserQuestion","input":{"questions":[{"question":"Which layout?","header":"Layout","multiSelect":false,"options":[{"label":"rows","description":"a list"},{"label":"cards","description":"a grid"}]}]}}]}}'
      echo '{"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"t1","input":{"questions":[{"question":"Which layout?","header":"Layout","multiSelect":false,"options":[{"label":"rows","description":"a list"},{"label":"cards","description":"a grid"}]}]}}}' ;;
    *'"type":"user"'*) echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}' ;;
  esac
done
"#;

/// Waits until chat `id`'s agent asks the user, within 10 s.
async fn asking(c: &mut Client, id: u64) {
    for _ in 0..100 {
        let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
        if terminals.iter().any(|t| u64::from(t.id) == id && t.agent_state == moonlet_proto::types::AgentState::Blocked) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("chat {id} never asked");
}

/// X65: a design's agent still asking the user when the daemon restarts is
/// within its turn after it: an edit by hand saved meanwhile waits for the
/// turn, and Stop, which ends the turn, takes its Agent turn snapshot with
/// the edit.
#[tokio::test]
async fn a_turn_still_asking_after_a_restart_takes_its_snapshot_when_stopped() {
    let mut d = fake_claude_daemon_with(QUESTION_CLAUDE, vec![("MOONLET_DESIGN_QUIET_MS".into(), "300".into())]).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let agent = created["agent"].as_u64().unwrap();
    turn_over(&mut c, agent).await;
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    std::fs::write(dir.join("pages/index.html"), "<p data-mid=\"m2\">first</p>\n").unwrap();
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "ASK-ME"})).await.unwrap();
    asking(&mut c, agent).await;
    drop(c);
    d.restart().await;
    let mut c = d.client().await;
    asking(&mut c, agent).await;
    let before: serde_json::Value = c.request(methods::DESIGN_HISTORY, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    let n = before.as_array().unwrap().len();
    save_by_hand(&mut c, &ws, "<p>by hand, while it asks</p>\n", &["text of m2"]).await;
    let _: serde_json::Value = c.request(methods::CHAT_INTERRUPT, serde_json::json!({"id": agent})).await.unwrap();
    let listed = history_of(&mut c, &ws, n + 1).await;
    assert_eq!((&listed[0]["type"], &listed[0]["n"]), (&serde_json::json!("agent_turn"), &serde_json::json!(n + 1)), "{listed}");
    let kept = dir.join(format!("history/{}/pages/index.html", n + 1));
    assert_eq!(std::fs::read_to_string(kept).unwrap(), "<p>by hand, while it asks</p>\n");
}

/// A design's agent that writes `pages/index.html`, "turn <n>", on each
/// message, then ends the turn: a message saying `STOP-ME` waits for the
/// chat's Stop (an interrupt), and one saying `FAIL-NOW` fails.
const STOPPED_CLAUDE: &str = r#"#!/bin/sh
n=0
mkdir -p pages
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}' ;;
    *'"subtype":"interrupt"'*) echo '{"type":"result","subtype":"error_during_execution","is_error":true,"usage":{}}' ;;
    *'"type":"user"'*) n=$((n+1)); printf '<p data-mid="m2">turn %s</p>\n' "$n" > pages/index.html
      case "$line" in
        *'STOP-ME'*) ;;
        *'FAIL-NOW'*) echo '{"type":"result","subtype":"error_during_execution","is_error":true,"usage":{}}' ;;
        *) echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}' ;;
      esac ;;
  esac
done
"#;

/// X65: a turn of the design's agent ends also when it is stopped (the
/// chat's Stop leaves it idle) or fails (error): either takes the turn's
/// snapshot, labelled Agent turn, as one it ends itself does.
#[tokio::test]
async fn an_agent_turn_stopped_or_failed_takes_its_snapshot_too() {
    let d = fake_claude_daemon(STOPPED_CLAUDE).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let agent = created["agent"].as_u64().unwrap();
    history_of(&mut c, &ws, 1).await;
    turn_over(&mut c, agent).await;
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    let kept = |n: u64| std::fs::read_to_string(dir.join(format!("history/{n}/pages/index.html"))).unwrap();

    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "STOP-ME"})).await.unwrap();
    working(&mut c, agent).await;
    let _: serde_json::Value = c.request(methods::CHAT_INTERRUPT, serde_json::json!({"id": agent})).await.unwrap();
    let listed = history_of(&mut c, &ws, 2).await;
    assert_eq!((&listed[0]["n"], &listed[0]["type"]), (&serde_json::json!(2), &serde_json::json!("agent_turn")));
    assert_eq!(kept(2), "<p data-mid=\"m2\">turn 2</p>\n");

    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "FAIL-NOW"})).await.unwrap();
    let listed = history_of(&mut c, &ws, 3).await;
    assert_eq!((&listed[0]["n"], &listed[0]["type"]), (&serde_json::json!(3), &serde_json::json!("agent_turn")));
    assert_eq!(kept(3), "<p data-mid=\"m2\">turn 3</p>\n");
}

/// X65: a design removed while its edits by hand wait for quiet stays
/// removed: its snapshot is never taken, and nothing of its folder comes
/// back.
#[tokio::test]
async fn a_design_removed_while_its_edits_by_hand_wait_for_quiet_does_not_come_back() {
    let d = fake_claude_daemon_with(FAKE_CLAUDE, vec![("MOONLET_DESIGN_QUIET_MS".into(), "500".into())]).await;
    let mut c = d.client().await;
    let ws = workspace_with_system(&d, &mut c).await;
    let created: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    turn_over(&mut c, created["agent"].as_u64().unwrap()).await;
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    std::fs::write(dir.join("pages/index.html"), "<p>first</p>\n").unwrap();
    save_by_hand(&mut c, &ws, "<p>by hand</p>\n", &["text of m2"]).await;
    let _: bool = c.request(methods::DESIGN_REMOVE, serde_json::json!({"workspace": ws, "slug": "settings-page"})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(!dir.exists(), "{:?}", std::fs::read_dir(&dir).map(|r| r.flatten().map(|e| e.file_name()).collect::<Vec<_>>()));
    let listed: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    assert_eq!(listed, serde_json::json!([]));
}

/// A workspace with the design system `moonlet-desktop`, its styles synced,
/// and the project `repo` in one of its sections, whose base branch has
/// `files` committed; then a session of it without an agent.
async fn workspace_with_session(d: &HomeDaemon, c: &mut Client, files: &[(&str, &str)]) -> (String, moonlet_proto::types::Project, moonlet_proto::types::Session) {
    use moonlet_proto::types::{Project, Section, Session};
    let ws = workspace_with_system(d, c).await;
    let system = d.home.path().join(".moonlet/design").join(&ws).join("systems/moonlet-desktop");
    for (path, text) in [
        ("styles.css", "@import \"tokens/colors.css\";\n"),
        ("tokens/colors.css", ":root { --color-accent: #3b82f6; }\n"),
        ("components/buttons/button/button.html", "<!-- @dsCard group=\"Buttons\" -->\n<button class=\"btn\">Run</button>\n"),
        ("_ds_sync.json", "{\"cards\":{}}\n"),
    ] {
        std::fs::create_dir_all(system.join(path).parent().unwrap()).unwrap();
        std::fs::write(system.join(path), text).unwrap();
    }
    let repo = d.home.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::write(repo.join("README.md"), "# shop\n").unwrap();
    for (path, text) in files {
        std::fs::create_dir_all(repo.join(path).parent().unwrap()).unwrap();
        std::fs::write(repo.join(path), text).unwrap();
    }
    for args in [vec!["init", "-q", "-b", "main"], vec!["add", "-A"], vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]] {
        assert!(Command::new("git").args(&args).current_dir(&repo).output().unwrap().status.success(), "git {args:?}");
    }
    let sec: Section = c.request(methods::SECTION_CREATE, serde_json::json!({"workspace_id": ws, "name": "Shop"})).await.unwrap();
    let project: Project = c.request(methods::SECTION_ADD_PROJECT, serde_json::json!({"id": sec.id, "path": repo})).await.unwrap();
    let session: Session = c
        .request(methods::SESSION_CREATE, serde_json::json!({"project_id": project.id, "name": "Settings", "agent": "none", "workspace_id": ws}))
        .await
        .unwrap();
    (ws, project, session)
}

/// X65 entry 12: `design.create` with a session makes a session design in
/// that session's worktree, under `docs/design/`, and starts no agent of its
/// own; the design RPCs reach it by `{session, slug}`, its comments in the
/// worktree's `.moonlet/design/`, and `design.list` gives it as a session
/// design of its session and project.
#[tokio::test]
async fn a_session_design_is_made_in_its_worktree_and_reached_by_its_session_and_slug() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, project, _) = workspace_with_session(&d, &mut c, &[]).await;
    let session: moonlet_proto::types::Session = c
        .request(methods::SESSION_CREATE, serde_json::json!({"project_id": project.id, "name": "Settings page", "agent": "claude", "workspace_id": ws}))
        .await
        .unwrap();
    let agent = session.terminals[0];
    let worktree = std::path::PathBuf::from(&session.path);
    let created: serde_json::Value = c
        .request(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "session": session.id, "name": "Settings page", "system": "moonlet-desktop", "brief": "From the agreed requirements"}),
        )
        .await
        .unwrap();
    let dir = worktree.join("docs/design/settings-page");
    assert_eq!(
        (&created["slug"], &created["kind"], &created["session"], &created["project"], &created["path"], &created["agent"], &created["agent_error"]),
        (
            &serde_json::json!("settings-page"),
            &serde_json::json!("session"),
            &serde_json::json!(session.id),
            &serde_json::json!(project.id),
            &serde_json::json!(dir),
            &serde_json::json!(agent),
            &serde_json::Value::Null
        )
    );
    assert_eq!(std::fs::read_to_string(dir.join("system/styles.css")).unwrap(), "@import \"tokens/colors.css\";\n");
    assert_eq!(std::fs::read_to_string(worktree.join(".moonlet/design/.gitignore")).unwrap(), "*\n");
    // The session's agent writes it: no agent of its own.
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    let chats: Vec<u32> = terminals.iter().filter(|t| t.chat).map(|t| t.id).collect();
    assert_eq!(chats, [agent], "{terminals:?}");

    let at = |more: serde_json::Value| {
        let mut v = serde_json::json!({"session": session.id, "slug": "settings-page"});
        v.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
        v
    };
    std::fs::write(dir.join("pages/index.html"), "<body data-mid=\"m1\"></body>\n").unwrap();
    let read: serde_json::Value = c.request(methods::DESIGN_PAGE, at(serde_json::json!({"page": "index"}))).await.unwrap();
    assert_eq!(read["html"], "<body data-mid=\"m1\"></body>\n");
    let page = "<body data-mid=\"m1\"><h1 data-mid=\"m2\">Settings</h1></body>\n";
    let _: serde_json::Value = c
        .request(methods::DESIGN_WRITE_PAGE, at(serde_json::json!({"page": "index", "html": page, "base_version": read["version"]})))
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("pages/index.html")).unwrap(), page);
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_COMMENT_PUT,
            at(serde_json::json!({"new": {"page": "index", "mid": "m2", "tag": "h1", "text": "Settings", "comment": "Smaller"}})),
        )
        .await
        .unwrap();
    let pins: serde_json::Value = c.request(methods::DESIGN_COMMENTS, at(serde_json::json!({}))).await.unwrap();
    assert_eq!((&pins[0]["n"], &pins[0]["comment"]), (&serde_json::json!(1), &serde_json::json!("Smaller")));
    let kept = std::fs::read_to_string(worktree.join(".moonlet/design/settings-page/comments.json")).unwrap();
    assert!(kept.contains("\"comment\": \"Smaller\""), "{kept}");
    let history: serde_json::Value = c.request(methods::DESIGN_HISTORY, at(serde_json::json!({}))).await.unwrap();
    assert_eq!(history, serde_json::json!([]));
    let _: bool = c.request(methods::DESIGN_VIEWPORT, at(serde_json::json!({"viewport": "390x844"}))).await.unwrap();

    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    let found = list.as_array().unwrap().iter().find(|d| d["kind"] == "session").expect("the session design");
    assert_eq!(
        (&found["slug"], &found["session"], &found["project"], &found["viewport"], &found["open_comments"], &found["agent"]),
        (&serde_json::json!("settings-page"), &serde_json::json!(session.id), &serde_json::json!(project.id), &serde_json::json!("390x844"), &serde_json::json!(1), &serde_json::json!(agent))
    );
    // A session of no workspace's, or of another, makes nothing.
    let unknown = c
        .request::<_, serde_json::Value>(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "session": "nope", "name": "x", "system": "moonlet-desktop", "brief": "b"}),
        )
        .await;
    assert_eq!(unknown.unwrap_err().to_string(), "invalid_params: no session \"nope\"");
    let missing = c.request::<_, serde_json::Value>(methods::DESIGN_PAGE, serde_json::json!({"session": session.id, "slug": "nope", "page": "index"})).await;
    assert!(missing.is_err());
}

/// A session design as merged: what `docs/design/settings-page/` holds on a
/// project's base branch.
const MERGED_DESIGN: [(&str, &str); 5] = [
    ("docs/design/settings-page/design.toml", "name = \"Settings page\"\nsystem = \"moonlet-desktop\"\nbrief = \"A left nav\"\nviewport = \"390x844\"\n\n[pages.git-a]\nlabel = \"cards\"\n"),
    ("docs/design/settings-page/pages/index.html", "<link rel=\"stylesheet\" href=\"../system/styles.css\">\n<body data-mid=\"m1\">rows</body>\n"),
    ("docs/design/settings-page/pages/git-a.html", "<link rel=\"stylesheet\" href=\"../system/styles.css\">\n<body data-mid=\"m1\">cards</body>\n"),
    ("docs/design/settings-page/assets/logo.svg", "<svg></svg>\n"),
    ("docs/design/settings-page/system/styles.css", "@import \"tokens/colors.css\";\n"),
];

/// X65 entry 12c: the Designs index frames a project design's first page
/// from its base branch, with no checkout: `design.file {project, path}`
/// gives the file's bytes from git's objects, by its path in the project's
/// design folder, and nothing outside its designs.
#[tokio::test]
async fn a_project_designs_file_is_read_from_its_base_branch_for_the_designs_index() {
    use base64::Engine;
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, project, _) = workspace_with_session(&d, &mut c, &MERGED_DESIGN).await;
    std::fs::remove_dir_all(d.home.path().join("repo/docs")).unwrap();
    let found: serde_json::Value = c
        .request(methods::DESIGN_FILE, serde_json::json!({"project": project.id, "path": "settings-page/pages/index.html"}))
        .await
        .unwrap();
    assert_eq!(found["content_type"], "text/html; charset=utf-8");
    let bytes = base64::engine::general_purpose::STANDARD.decode(found["content"].as_str().unwrap()).unwrap();
    assert_eq!(String::from_utf8(bytes).unwrap(), "<link rel=\"stylesheet\" href=\"../system/styles.css\">\n<body data-mid=\"m1\">rows</body>\n");
    for (call, refusal) in [
        (serde_json::json!({"project": project.id, "path": "settings-page/../../README.md"}), "invalid_params: settings-page/../../README.md is no file of a project design on main".to_string()),
        (serde_json::json!({"project": project.id, "path": "settings-page/pages/nope.html"}), "invalid_params: settings-page/pages/nope.html is no file of a project design on main".to_string()),
        (serde_json::json!({"project": "nope", "path": "settings-page/pages/index.html"}), "invalid_params: no project \"nope\"".to_string()),
        (serde_json::json!({"project": project.id, "workspace": ws, "path": "settings-page/pages/index.html"}), "invalid_params: name a design file by its project alone".to_string()),
    ] {
        let refused = c.request::<_, serde_json::Value>(methods::DESIGN_FILE, call.clone()).await;
        assert_eq!(refused.map_err(|e| e.to_string()), Err(refusal), "{call}");
    }
}

/// X65 entry 12: a session design merged into a project's base branch is
/// listed as a project design, read from git without checking anything
/// out, and `design.copy` starts a new workspace design from it: its pages
/// linking the live design system, its assets and labels, its agent told
/// it is a copy.
#[tokio::test]
async fn a_project_design_on_the_base_branch_is_listed_and_copied_into_a_new_workspace_design() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, project, _) = workspace_with_session(&d, &mut c, &MERGED_DESIGN).await;
    // Not checked out: the base branch's files only, whatever the folder has.
    std::fs::remove_dir_all(d.home.path().join("repo/docs")).unwrap();
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    let found = list.as_array().unwrap().iter().find(|d| d["kind"] == "project").expect("the project design");
    assert_eq!(
        (&found["slug"], &found["name"], &found["project"], &found["path"], &found["system"], &found["pages"]),
        (
            &serde_json::json!("settings-page"),
            &serde_json::json!("Settings page"),
            &serde_json::json!(project.id),
            &serde_json::json!("docs/design/settings-page"),
            &serde_json::json!("moonlet-desktop"),
            &serde_json::json!([{"name": "index", "label": null}, {"name": "git-a", "label": "cards"}])
        )
    );

    let copied: serde_json::Value = c
        .request(
            methods::DESIGN_COPY,
            serde_json::json!({"workspace": ws, "from": {"project": project.id, "path": "docs/design/settings-page"}, "name": "Settings page v2"}),
        )
        .await
        .unwrap();
    assert_eq!(
        (&copied["slug"], &copied["kind"], &copied["agent_error"]),
        (&serde_json::json!("settings-page-v2"), &serde_json::json!("workspace"), &serde_json::Value::Null)
    );
    let dir = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page-v2");
    assert_eq!(
        std::fs::read_to_string(dir.join("pages/index.html")).unwrap(),
        "<link rel=\"stylesheet\" href=\"../../../systems/moonlet-desktop/styles.css\">\n<body data-mid=\"m1\">rows</body>\n"
    );
    assert_eq!(std::fs::read_to_string(dir.join("assets/logo.svg")).unwrap(), "<svg></svg>\n");
    let toml = std::fs::read_to_string(dir.join("design.toml")).unwrap();
    assert!(toml.contains("viewport = \"390x844\"\n") && toml.contains("[pages.git-a]\nlabel = \"cards\"\n"), "{toml}");
    let user = until_contains(
        {
            let p = dir.join("claude-user");
            move || std::fs::read_to_string(&p).unwrap_or_default()
        },
        "docs/design/settings-page",
    )
    .await;
    assert!(user.contains("its pages are written already"), "{user}");

    let missing = c
        .request::<_, serde_json::Value>(
            methods::DESIGN_COPY,
            serde_json::json!({"workspace": ws, "from": {"project": project.id, "path": "docs/design/nope"}, "name": "x"}),
        )
        .await;
    assert_eq!(missing.unwrap_err().to_string(), "invalid_params: no design at docs/design/nope on main");
}

/// X65 entry 12: a session made from a base branch with a design merged on
/// it has that design checked out in its worktree, but it is not the
/// session's: `design.list` gives it as a project design only, and the
/// session reaches no design by its slug, nor a file of it.
#[tokio::test]
async fn a_design_merged_on_the_base_branch_is_no_session_design_of_a_session_made_from_it() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, _, session) = workspace_with_session(&d, &mut c, &MERGED_DESIGN).await;
    let checked_out = std::path::PathBuf::from(&session.path).join("docs/design/settings-page/design.toml");
    assert!(checked_out.is_file(), "the merged design is not in the session's worktree");
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    let listed: Vec<(&str, &str)> = list.as_array().unwrap().iter().map(|d| (d["kind"].as_str().unwrap(), d["slug"].as_str().unwrap())).collect();
    assert_eq!(listed, [("project", "settings-page")]);
    let page = c.request::<_, serde_json::Value>(methods::DESIGN_PAGE, serde_json::json!({"session": session.id, "slug": "settings-page", "page": "index"})).await;
    assert!(page.is_err(), "{page:?}");
    let file = c
        .request::<_, serde_json::Value>(methods::DESIGN_FILE, serde_json::json!({"session": session.id, "path": "settings-page/pages/index.html"}))
        .await;
    assert_eq!(file.unwrap_err().to_string(), "invalid_params: settings-page/pages/index.html is no file of a session design");
}

/// X65 entry 12, Build it: a session whose state cannot be saved is not
/// made, and the workspace design it was to build records no session, so
/// `design.list` gives it no `built_in`; the worktree made for it goes too.
#[tokio::test]
async fn a_session_that_cannot_be_saved_leaves_the_design_it_was_to_build_with_no_link_to_it() {
    use moonlet_proto::types::Session;
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, project, _) = workspace_with_session(&d, &mut c, &[]).await;
    let _: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let design = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    std::fs::write(design.join("pages/index.html"), "<body data-mid=\"m1\">rows</body>\n").unwrap();
    // The sessions' state cannot be written: its temporary file is a folder.
    let blocker = d.home.path().join(".moonlet/state.json.tmp");
    std::fs::create_dir(&blocker).unwrap();
    let refused = c
        .request::<_, Session>(
            methods::SESSION_CREATE,
            serde_json::json!({
                "project_id": project.id, "name": "Implement settings page", "workspace_id": ws, "agent": "none",
                "design": {"workspace": ws, "slug": "settings-page", "pages": ["index"]}
            }),
        )
        .await;
    std::fs::remove_dir(&blocker).unwrap();
    assert!(refused.is_err(), "{refused:?}");
    let toml = std::fs::read_to_string(design.join("design.toml")).unwrap();
    assert!(!toml.contains("session"), "{toml}");
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    let found = list.as_array().unwrap().iter().find(|d| d["kind"] == "workspace" && d["slug"] == "settings-page").expect("the design");
    assert_eq!(found["built_in"], serde_json::Value::Null);
    assert!(!d.home.path().join(".moonlet/worktrees/repo/implement-settings-page").exists(), "its worktree is left");
}

/// X65 entry 12, Build it: a session saved whose agent then cannot start
/// (here a folder it is to add that is not there) is still the session the
/// design was copied into, so the workspace design records it and
/// `design.list` gives it `built_in`.
#[tokio::test]
async fn a_saved_session_whose_agent_cannot_start_is_recorded_in_the_design_it_builds() {
    use moonlet_proto::types::Session;
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, project, _) = workspace_with_session(&d, &mut c, &[]).await;
    let _: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let design = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    std::fs::write(design.join("pages/index.html"), "<body data-mid=\"m1\">rows</body>\n").unwrap();
    let made = c
        .request::<_, Session>(
            methods::SESSION_CREATE,
            serde_json::json!({
                "project_id": project.id, "name": "Implement settings page", "workspace_id": ws, "agent": "claude",
                "add_dirs": [d.home.path().join("gone").display().to_string()],
                "design": {"workspace": ws, "slug": "settings-page", "pages": ["index"]}
            }),
        )
        .await;
    assert!(made.is_err(), "the agent started: {made:?}");
    let sessions: Vec<Session> = c.request(methods::SESSION_LIST, ()).await.unwrap();
    let saved = sessions.iter().find(|s| s.name == "Implement settings page").unwrap_or_else(|| panic!("no session saved: {made:?}"));
    assert!(std::path::Path::new(&saved.path).join("docs/design/settings-page/design.toml").is_file());
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    let found = list.as_array().unwrap().iter().find(|d| d["kind"] == "workspace" && d["slug"] == "settings-page").expect("the design");
    assert_eq!(found["built_in"], serde_json::json!({"session": saved.id, "project": project.id}), "{made:?}");
}

/// X65 entry 12: `design.copy` copies only a design the project's listing
/// gives, a folder of its design folder, `<design dir>/<slug>`: a folder
/// elsewhere on the base branch that holds a `design.toml` is none, and no
/// workspace design is made from it.
#[tokio::test]
async fn design_copy_takes_only_a_folder_of_the_projects_design_folder() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let mut files = MERGED_DESIGN.to_vec();
    files.push(("prototypes/old-settings/design.toml", "name = \"Old settings\"\nsystem = \"moonlet-desktop\"\n"));
    files.push(("prototypes/old-settings/pages/index.html", "<body data-mid=\"m1\">old</body>\n"));
    let (ws, project, _) = workspace_with_session(&d, &mut c, &files).await;
    let refused = c
        .request::<_, serde_json::Value>(
            methods::DESIGN_COPY,
            serde_json::json!({"workspace": ws, "from": {"project": project.id, "path": "prototypes/old-settings"}, "name": "Old settings"}),
        )
        .await;
    assert_eq!(refused.unwrap_err().to_string(), "invalid_params: no design at prototypes/old-settings on main");
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    let workspace_designs: Vec<&serde_json::Value> = list.as_array().unwrap().iter().filter(|d| d["kind"] == "workspace").collect();
    assert_eq!(workspace_designs, Vec::<&serde_json::Value>::new());
}

/// A Claude Code that first records every file of the session designs its
/// worktree has as it starts, in `claude-saw`, then answers as FAKE_CLAUDE.
const SEEING_CLAUDE: &str = r#"#!/bin/sh
find docs/design .moonlet/design -type f 2>/dev/null | LC_ALL=C sort > claude-saw
echo "$@" >> claude-args
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}' ;;
    *'"type":"user"'*) echo "$line" >> claude-user
      echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}' ;;
  esac
done
"#;

/// X65 entry 12, Build it: `session.create` with a design copies that
/// workspace design into the new worktree as a session design before the
/// session's agent starts (the pages kept, its assets, the pinned styles,
/// `design.toml` and the whole design system in `.moonlet/design/`), and
/// the workspace design records the session it is built in. A page the
/// design does not have makes no session.
#[tokio::test]
async fn session_create_with_a_design_copies_it_into_the_worktree_before_the_agent_starts() {
    use moonlet_proto::types::Session;
    let d = fake_claude_daemon(SEEING_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, project, _) = workspace_with_session(&d, &mut c, &[]).await;
    let _: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "A left nav"}))
        .await
        .unwrap();
    let design = d.home.path().join(".moonlet/design").join(&ws).join("designs/settings-page");
    for page in ["index", "git-a", "git-b"] {
        std::fs::write(
            design.join(format!("pages/{page}.html")),
            format!("<link rel=\"stylesheet\" href=\"../../../systems/moonlet-desktop/styles.css\">\n<body data-mid=\"m1\">{page}</body>\n"),
        )
        .unwrap();
    }
    std::fs::write(design.join("assets/logo.svg"), "<svg></svg>\n").unwrap();
    let create = |pages: &[&str]| {
        serde_json::json!({
            "project_id": project.id, "name": "Implement settings page", "workspace_id": ws, "agent": "claude",
            "prompt": "Implement the Settings page design",
            "design": {"workspace": ws, "slug": "settings-page", "pages": pages}
        })
    };
    let repo = d.home.path().join("repo");
    let branches = || String::from_utf8(Command::new("git").args(["branch", "--list"]).current_dir(&repo).output().unwrap().stdout).unwrap();
    let before = branches();
    let refused = c.request::<_, Session>(methods::SESSION_CREATE, create(&["index", "nope"])).await;
    assert_eq!(refused.unwrap_err().to_string(), "invalid_params: bad page \"nope\"");
    let sessions: Vec<Session> = c.request(methods::SESSION_LIST, ()).await.unwrap();
    assert_eq!(sessions.len(), 1, "a session made for a page the design does not have");
    assert!(!d.home.path().join(".moonlet/worktrees/repo/implement-settings-page").exists(), "its worktree is left");
    assert_eq!(branches(), before, "its branch is left");

    let session: Session = c.request(methods::SESSION_CREATE, create(&["index", "git-a"])).await.unwrap();
    let worktree = std::path::PathBuf::from(&session.path);
    let saw = until_contains(
        {
            let p = worktree.join("claude-saw");
            move || std::fs::read_to_string(&p).unwrap_or_default()
        },
        "docs/design",
    )
    .await;
    assert_eq!(
        saw,
        ".moonlet/design/.gitignore
.moonlet/design/settings-page/comments.json
.moonlet/design/settings-page/system/README.md
.moonlet/design/settings-page/system/_ds_sync.json
.moonlet/design/settings-page/system/components/buttons/button/button.html
.moonlet/design/settings-page/system/styles.css
.moonlet/design/settings-page/system/tokens/colors.css
docs/design/settings-page/assets/logo.svg
docs/design/settings-page/design.toml
docs/design/settings-page/pages/git-a.html
docs/design/settings-page/pages/index.html
docs/design/settings-page/system/styles.css
docs/design/settings-page/system/tokens/colors.css
"
    );
    assert_eq!(
        std::fs::read_to_string(worktree.join("docs/design/settings-page/pages/index.html")).unwrap(),
        "<link rel=\"stylesheet\" href=\"../system/styles.css\">\n<body data-mid=\"m1\">index</body>\n"
    );
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    let workspace_design = list.as_array().unwrap().iter().find(|d| d["kind"] == "workspace").unwrap();
    assert_eq!(workspace_design["built_in"], serde_json::json!({"session": session.id, "project": project.id}));
    let in_session = list.as_array().unwrap().iter().find(|d| d["kind"] == "session").unwrap();
    assert_eq!((&in_session["slug"], &in_session["session"]), (&serde_json::json!("settings-page"), &serde_json::json!(session.id)));
}

/// X65 entry 12: once the design system syncs after a session design
/// pinned it, `design.list` marks the design `system_updated`, and
/// `design.system.update` replaces both its copies, records the new anchor
/// and gives the cards that changed, for the chat.
#[tokio::test]
async fn a_session_design_is_marked_when_its_design_system_syncs_and_update_brings_the_new_one() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, _, session) = workspace_with_session(&d, &mut c, &[]).await;
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "session": session.id, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}),
        )
        .await
        .unwrap();
    let session_design = |list: &serde_json::Value| list.as_array().unwrap().iter().find(|d| d["kind"] == "session").unwrap().clone();
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    assert_eq!(session_design(&list).get("system_updated"), None);

    let system = d.home.path().join(".moonlet/design").join(&ws).join("systems/moonlet-desktop");
    std::fs::write(system.join("tokens/colors.css"), ":root { --color-accent: #2563eb; }\n").unwrap();
    std::fs::write(system.join("components/buttons/button/button.html"), "<!-- @dsCard group=\"Buttons\" -->\n<button class=\"btn\">Run tests</button>\n").unwrap();
    std::fs::write(system.join("_ds_sync.json"), "{\"cards\":{\"components/buttons/button/button.html\":{}}}\n").unwrap();
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    assert_eq!(session_design(&list)["system_updated"], true);

    let updated: serde_json::Value = c
        .request(methods::DESIGN_SYSTEM_UPDATE, serde_json::json!({"session": session.id, "slug": "settings-page"}))
        .await
        .unwrap();
    assert_eq!(
        updated,
        serde_json::json!({
            "anchor": "c8927a57a423efa36791952c3c820cb62eccbc94a69cb2f6d8be80b7663e7ba6",
            "cards": [{"path": "components/buttons/button/button.html", "change": "changed"}]
        })
    );
    let worktree = std::path::PathBuf::from(&session.path);
    assert_eq!(
        std::fs::read_to_string(worktree.join("docs/design/settings-page/system/tokens/colors.css")).unwrap(),
        ":root { --color-accent: #2563eb; }\n"
    );
    assert_eq!(
        std::fs::read_to_string(worktree.join(".moonlet/design/settings-page/system/components/buttons/button/button.html")).unwrap(),
        "<!-- @dsCard group=\"Buttons\" -->\n<button class=\"btn\">Run tests</button>\n"
    );
    let list: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    assert_eq!(session_design(&list).get("system_updated"), None);
    // A workspace design reads the live system: it has nothing to update.
    let _: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Onboarding", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let refused = c
        .request::<_, serde_json::Value>(methods::DESIGN_SYSTEM_UPDATE, serde_json::json!({"workspace": ws, "slug": "onboarding"}))
        .await;
    assert_eq!(refused.unwrap_err().to_string(), "invalid_params: only a session design has a copy of its design system to update");
}

/// A session's Claude Code that, on each message, writes turn <n> into the
/// session design `settings-page`'s index page when the worktree has it.
const SESSION_WRITING_CLAUDE: &str = r#"#!/bin/sh
n=0
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}' ;;
    *'"type":"user"'*) n=$((n+1))
      if [ -d docs/design/settings-page/pages ]; then
        printf '<body data-mid="m1"><p data-mid="m2">turn %s</p></body>\n' "$n" > docs/design/settings-page/pages/index.html
      fi
      echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}' ;;
  esac
done
"#;

/// X65 entry 12: a session design's snapshots are kept in the worktree's
/// `.moonlet/design/<slug>/history/`: one when the session's agent ends a
/// turn that changed it, one when edits by hand saved with
/// `design.write_page` stop for a while, and `design.snapshot.restore`
/// makes one current, all by `{session, slug}`.
#[tokio::test]
async fn a_session_designs_snapshots_follow_its_sessions_agent_turns_and_edits_by_hand() {
    use moonlet_proto::types::Session;
    let d = fake_claude_daemon_with(SESSION_WRITING_CLAUDE, vec![("MOONLET_DESIGN_QUIET_MS".into(), "1000".into())]).await;
    let mut c = d.client().await;
    let (ws, project, _) = workspace_with_session(&d, &mut c, &[]).await;
    let session: Session = c
        .request(methods::SESSION_CREATE, serde_json::json!({"project_id": project.id, "name": "Settings", "agent": "claude", "workspace_id": ws}))
        .await
        .unwrap();
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "session": session.id, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}),
        )
        .await
        .unwrap();
    let at = serde_json::json!({"session": session.id, "slug": "settings-page"});
    let history = async |c: &mut Client, n: usize| {
        for _ in 0..100 {
            let listed: serde_json::Value = c.request(methods::DESIGN_HISTORY, at.clone()).await.unwrap();
            if listed.as_array().is_some_and(|a| a.len() >= n) {
                return listed;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("no {n} snapshots");
    };
    let agent = session.terminals[0];
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": agent, "text": "Write the page"})).await.unwrap();
    let listed = history(&mut c, 1).await;
    assert_eq!(
        (&listed[0]["n"], &listed[0]["type"], &listed[0]["summary"]),
        (&serde_json::json!(1), &serde_json::json!("agent_turn"), &serde_json::json!("Wrote index.html · 1 page"))
    );
    let side = std::path::PathBuf::from(&session.path).join(".moonlet/design/settings-page");
    assert_eq!(
        std::fs::read_to_string(side.join("history/1/pages/index.html")).unwrap(),
        "<body data-mid=\"m1\"><p data-mid=\"m2\">turn 1</p></body>\n"
    );

    turn_over(&mut c, agent as u64).await;
    let read: serde_json::Value = c.request(methods::DESIGN_PAGE, serde_json::json!({"session": session.id, "slug": "settings-page", "page": "index"})).await.unwrap();
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_WRITE_PAGE,
            serde_json::json!({"session": session.id, "slug": "settings-page", "page": "index", "html": "<p>by hand</p>\n", "base_version": read["version"], "edits": ["text of m2"]}),
        )
        .await
        .unwrap();
    let listed = history(&mut c, 2).await;
    assert_eq!((&listed[0]["n"], &listed[0]["type"], &listed[0]["summary"]), (&serde_json::json!(2), &serde_json::json!("edits_by_hand"), &serde_json::json!("Text of m2")));

    let restored: serde_json::Value = c
        .request(methods::DESIGN_SNAPSHOT_RESTORE, serde_json::json!({"session": session.id, "slug": "settings-page", "n": 1}))
        .await
        .unwrap();
    assert_eq!((&restored["n"], &restored["type"]), (&serde_json::json!(3), &serde_json::json!("restored")));
    assert_eq!(
        std::fs::read_to_string(std::path::PathBuf::from(&session.path).join("docs/design/settings-page/pages/index.html")).unwrap(),
        "<body data-mid=\"m1\"><p data-mid=\"m2\">turn 1</p></body>\n"
    );
}

/// X65 entry 12: edits by hand on a session design not kept yet are kept on
/// their own before `chat.send` gives the session's agent a message, so the
/// turn's snapshot holds only the agent's work.
#[tokio::test]
async fn edits_by_hand_on_a_session_design_are_kept_on_their_own_before_its_sessions_agent_gets_a_message() {
    use moonlet_proto::types::Session;
    let d = fake_claude_daemon_with(SESSION_WRITING_CLAUDE, vec![("MOONLET_DESIGN_QUIET_MS".into(), "60000".into())]).await;
    let mut c = d.client().await;
    let (ws, project, _) = workspace_with_session(&d, &mut c, &[]).await;
    let session: Session = c
        .request(methods::SESSION_CREATE, serde_json::json!({"project_id": project.id, "name": "Settings", "agent": "claude", "workspace_id": ws}))
        .await
        .unwrap();
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "session": session.id, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}),
        )
        .await
        .unwrap();
    let worktree = std::path::PathBuf::from(&session.path);
    std::fs::write(worktree.join("docs/design/settings-page/pages/index.html"), "<p>first</p>\n").unwrap();
    let at = serde_json::json!({"session": session.id, "slug": "settings-page"});
    let mut page = at.clone();
    page["page"] = "index".into();
    let read: serde_json::Value = c.request(methods::DESIGN_PAGE, page.clone()).await.unwrap();
    let mut save = page.clone();
    save["html"] = "<p>by hand</p>\n".into();
    save["base_version"] = read["version"].clone();
    save["edits"] = serde_json::json!(["text of m2"]);
    let _: serde_json::Value = c.request(methods::DESIGN_WRITE_PAGE, save).await.unwrap();
    let _: serde_json::Value = c.request(methods::CHAT_SEND, serde_json::json!({"id": session.terminals[0], "text": "Write the page"})).await.unwrap();
    let mut listed = serde_json::json!([]);
    for _ in 0..100 {
        listed = c.request(methods::DESIGN_HISTORY, at.clone()).await.unwrap();
        if listed.as_array().is_some_and(|a| a.len() >= 2) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let kinds: Vec<(u64, &str, &str)> = listed.as_array().unwrap().iter().map(|s| (s["n"].as_u64().unwrap(), s["type"].as_str().unwrap(), s["summary"].as_str().unwrap())).collect();
    assert_eq!(kinds, [(2, "agent_turn", "Wrote index.html · 1 page"), (1, "edits_by_hand", "Text of m2")]);
    let side = worktree.join(".moonlet/design/settings-page/history");
    assert_eq!(std::fs::read_to_string(side.join("1/pages/index.html")).unwrap(), "<p>by hand</p>\n");
    assert_eq!(std::fs::read_to_string(side.join("2/pages/index.html")).unwrap(), "<body data-mid=\"m1\"><p data-mid=\"m2\">turn 1</p></body>\n");
}

/// X65 entry 12: a design is named by its workspace or by its session,
/// never both, so a call can never pass as one workspace's and act on a
/// session design of another; either missing, or both given, is refused
/// with a message that says so.
#[tokio::test]
async fn a_design_is_named_by_its_workspace_or_its_session_never_both() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, _, session) = workspace_with_session(&d, &mut c, &[]).await;
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "session": session.id, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}),
        )
        .await
        .unwrap();
    let other: moonlet_proto::types::Workspace =
        c.request(methods::WORKSPACE_CREATE, serde_json::json!({"name": "Acme", "color": "clay"})).await.unwrap();
    let both = "invalid_params: name a design by its workspace or by its session, not both";
    for (method, more) in [
        (methods::DESIGN_PAGE, serde_json::json!({"page": "index"})),
        (methods::DESIGN_COMMENTS, serde_json::json!({})),
        (methods::DESIGN_OPEN, serde_json::json!({})),
        (methods::DESIGN_SYSTEM_UPDATE, serde_json::json!({})),
        (methods::DESIGN_VIEWPORT, serde_json::json!({"viewport": "390x844"})),
    ] {
        let mut call = serde_json::json!({"workspace": other.id, "session": session.id, "slug": "settings-page"});
        call.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
        let refused = c.request::<_, serde_json::Value>(method, call).await;
        assert_eq!(refused.unwrap_err().to_string(), both, "{method}");
    }
    let neither = c.request::<_, serde_json::Value>(methods::DESIGN_COMMENTS, serde_json::json!({"slug": "settings-page"})).await;
    assert_eq!(neither.unwrap_err().to_string(), "invalid_params: name a design by its workspace or by its session");
    // The viewport was never saved through the other workspace's call.
    let toml = std::fs::read_to_string(std::path::PathBuf::from(&session.path).join("docs/design/settings-page/design.toml")).unwrap();
    assert!(toml.contains("viewport = \"1440x900\""), "{toml}");
}

/// X65 entry 12: Build it's session design keeps the workspace design's
/// slug, which its attachments name before the session is made; when the
/// project's base branch has a design of that slug already, `session.create`
/// is refused and leaves nothing: the worktree and branch it made are
/// removed, and a worktree it adopted is left as it was.
#[tokio::test]
async fn building_a_design_whose_slug_the_base_branch_has_makes_no_session_and_leaves_nothing() {
    use moonlet_proto::types::Session;
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, project, _) = workspace_with_session(&d, &mut c, &MERGED_DESIGN).await;
    let _: serde_json::Value = c
        .request(methods::DESIGN_CREATE, serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}))
        .await
        .unwrap();
    let repo = d.home.path().join("repo");
    let branches = || String::from_utf8(Command::new("git").args(["branch", "--list"]).current_dir(&repo).output().unwrap().stdout).unwrap();
    let before = branches();
    let worktrees = d.home.path().join(".moonlet/worktrees/repo");
    let listed = || std::fs::read_dir(&worktrees).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>();
    let made_before = listed();
    let create = serde_json::json!({
        "project_id": project.id, "name": "Implement settings page", "workspace_id": ws, "agent": "none",
        "design": {"workspace": ws, "slug": "settings-page", "pages": []}
    });
    let refused = c.request::<_, Session>(methods::SESSION_CREATE, create.clone()).await;
    assert_eq!(
        refused.unwrap_err().to_string(),
        "invalid_params: docs/design/settings-page is in the worktree already: rename the design before building it"
    );
    assert_eq!(listed(), made_before, "the worktree made for it is still there");
    assert_eq!(branches(), before, "the branch made for it is still there");

    // A worktree made outside moonlet, adopted for it, stays as it was.
    let outside = d.home.path().join("outside");
    let adopted = add_worktree(&repo, &["-b", "outside"], &outside);
    let mut adopt = create.clone();
    adopt["worktree"] = adopted.clone().into();
    let refused = c.request::<_, Session>(methods::SESSION_CREATE, adopt).await;
    assert!(refused.is_err());
    assert_eq!(
        std::fs::read_to_string(outside.join("docs/design/settings-page/pages/index.html")).unwrap(),
        "<link rel=\"stylesheet\" href=\"../system/styles.css\">\n<body data-mid=\"m1\">rows</body>\n"
    );
    assert!(!outside.join(".moonlet").exists(), "the copy wrote into the adopted worktree");
    let sessions: Vec<Session> = c.request(methods::SESSION_LIST, ()).await.unwrap();
    assert_eq!(sessions.len(), 1);
}

/// X65 entry 12: `design.file` finds a session design's file for the
/// canvas by its session and its path in the worktree's design folder, a
/// snapshot's at the design's depth, and gives its bytes, never one outside
/// it.
#[tokio::test]
async fn a_session_designs_files_are_found_for_the_canvas_by_its_session() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, _, session) = workspace_with_session(&d, &mut c, &[]).await;
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "session": session.id, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}),
        )
        .await
        .unwrap();
    let dir = std::path::PathBuf::from(&session.path).canonicalize().unwrap().join("docs/design/settings-page");
    std::fs::write(dir.join("pages/index.html"), "<body data-mid=\"m1\"></body>\n").unwrap();
    let found: serde_json::Value = c
        .request(methods::DESIGN_FILE, serde_json::json!({"session": session.id, "path": "settings-page/pages/index.html"}))
        .await
        .unwrap();
    // Its bytes, `<body data-mid="m1"></body>\n` in base64: the app reads
    // no path of the worktree.
    assert_eq!(found, serde_json::json!({"content": "PGJvZHkgZGF0YS1taWQ9Im0xIj48L2JvZHk+Cg==", "content_type": "text/html; charset=utf-8"}));
    let outside = c
        .request::<_, serde_json::Value>(methods::DESIGN_FILE, serde_json::json!({"session": session.id, "path": "settings-page/../../../../README.md"}))
        .await;
    assert_eq!(outside.unwrap_err().to_string(), "invalid_params: settings-page/../../../../README.md is no file of a session design");
    let both = c
        .request::<_, serde_json::Value>(methods::DESIGN_FILE, serde_json::json!({"workspace": ws, "session": session.id, "path": "settings-page/pages/index.html"}))
        .await;
    assert_eq!(both.unwrap_err().to_string(), "invalid_params: name a design file by its workspace or by its session, not both");
}

/// X65 entry 12: `design.file` is let through only by a workspace or a
/// session moonlet has, read from its parsed params: a call naming a
/// workspace that is gone (whose design folder is still on disk) is refused
/// whatever its `session` key holds, null, empty or a real session, and no
/// file comes back.
#[tokio::test]
async fn a_design_file_is_found_only_through_a_workspace_or_a_session_moonlet_has() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (_, _, session) = workspace_with_session(&d, &mut c, &[]).await;
    let gone = workspace_with_system(&d, &mut c).await;
    let _: bool = c.request(methods::WORKSPACE_DELETE, serde_json::json!({"id": gone})).await.unwrap();
    let left = d.home.path().join(".moonlet/design").join(&gone).join("systems/moonlet-desktop/README.md");
    assert!(left.is_file(), "the gone workspace's design folder is still there");
    let path = "systems/moonlet-desktop/README.md";
    for (call, refusal) in [
        (serde_json::json!({"workspace": gone, "session": null, "path": path}), format!("invalid_params: no workspace \"{gone}\"")),
        (serde_json::json!({"workspace": gone, "path": path}), format!("invalid_params: no workspace \"{gone}\"")),
        (
            serde_json::json!({"workspace": gone, "session": "", "path": path}),
            "invalid_params: name a design file by its workspace or by its session, not both".to_string(),
        ),
        (
            serde_json::json!({"workspace": gone, "session": session.id, "path": path}),
            "invalid_params: name a design file by its workspace or by its session, not both".to_string(),
        ),
        (serde_json::json!({"session": "", "path": path}), "invalid_params: no session \"\"".to_string()),
    ] {
        let refused = c.request::<_, serde_json::Value>(methods::DESIGN_FILE, call.clone()).await;
        assert_eq!(refused.map_err(|e| e.to_string()), Err(refusal), "{call}");
    }
}

/// X65 entry 12: an archived session's designs are no longer watched, so
/// a file written in one is never announced, while another session's still
/// are; unarchived, its designs are watched again from the next call that
/// reaches them.
#[tokio::test]
async fn an_archived_sessions_designs_are_no_longer_watched_and_are_again_once_it_is_unarchived() {
    use moonlet_proto::types::Session;
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, project, archived) = workspace_with_session(&d, &mut c, &[]).await;
    let live: Session = c
        .request(methods::SESSION_CREATE, serde_json::json!({"project_id": project.id, "name": "Onboarding", "agent": "none", "workspace_id": ws}))
        .await
        .unwrap();
    for (session, name) in [(&archived, "Settings page"), (&live, "Onboarding")] {
        let _: serde_json::Value = c
            .request(
                methods::DESIGN_CREATE,
                serde_json::json!({"workspace": ws, "session": session.id, "name": name, "system": "moonlet-desktop", "brief": "b"}),
            )
            .await
            .unwrap();
    }
    // A new page of the session's design: each write its own file, so no
    // two are taken for one change.
    let write = |s: &Session, page: &str| {
        let slug = if s.id == archived.id { "settings-page" } else { "onboarding" };
        std::fs::write(std::path::PathBuf::from(&s.path).join("docs/design").join(slug).join(format!("pages/{page}.html")), "<p>x</p>\n").unwrap();
    };
    let names = |s: &Session, page: &str| {
        let (id, path) = (s.id.clone(), format!("pages/{page}.html"));
        move |e: &serde_json::Value| e["session"] == id.as_str() && e["paths"].as_array().is_some_and(|p| p.iter().any(|x| x == path.as_str()))
    };
    let mut listener = d.client().await;
    // Both watched while open; each one's making is delivered before its write.
    write(&archived, "open");
    next_event(&mut listener, methods::EV_DESIGN_CHANGED, names(&archived, "open")).await;
    write(&live, "open");
    next_event(&mut listener, methods::EV_DESIGN_CHANGED, names(&live, "open")).await;

    let _: serde_json::Value = c
        .request(methods::SESSION_ARCHIVE, serde_json::json!({"id": archived.id, "remove_worktree": false}))
        .await
        .unwrap();
    write(&archived, "archived");
    tokio::time::sleep(Duration::from_millis(800)).await;
    write(&live, "live");
    // Every announcement of the archived session's new page up to the live
    // session's write. FSEvents may deliver an earlier batch again (the open
    // session's page), so only the archived session's page counts.
    let archived_page = names(&archived, "archived");
    let mut heard = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let f = tokio::time::timeout_at(deadline, listener.next_frame()).await.expect("the live session's write").unwrap().unwrap();
        if let Frame::Json(Message::Event { name, data }) = f
            && name == methods::EV_DESIGN_CHANGED
        {
            if names(&live, "live")(&data) {
                break;
            }
            if archived_page(&data) {
                heard.push(data);
            }
        }
    }
    assert_eq!(heard, Vec::<serde_json::Value>::new(), "an archived session's design was announced");

    let _: Session = c.request(methods::SESSION_UNARCHIVE, serde_json::json!({"id": archived.id})).await.unwrap();
    let _: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    write(&archived, "unarchived");
    next_event(&mut listener, methods::EV_DESIGN_CHANGED, names(&archived, "unarchived")).await;
}

/// X65 entry 12: after a restart the daemon watches the designs of every
/// open session that has session designs as it starts, so an edit of one
/// is announced with no design call in between.
#[tokio::test]
async fn a_session_designs_edits_are_announced_after_a_restart_with_no_design_call() {
    let mut d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, _, session) = workspace_with_session(&d, &mut c, &[]).await;
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "session": session.id, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}),
        )
        .await
        .unwrap();
    drop(c);
    d.restart().await;
    let mut listener = d.client().await;
    std::fs::write(std::path::PathBuf::from(&session.path).join("docs/design/settings-page/pages/index.html"), "<p>after a restart</p>\n").unwrap();
    let mut changed = next_change_of(&mut listener, "pages/index.html").await;
    changed.as_object_mut().unwrap().remove("paths");
    assert_eq!(changed, serde_json::json!({"workspace": ws, "system": null, "design": "settings-page", "session": session.id}));
}

/// X65 entry 12: a session whose worktree has no design folder yet when a
/// design call first reaches it is watched all the same, from the nearest
/// folder above, so a session design another tool makes there later, with
/// no design call since, is announced with its session.
#[tokio::test]
async fn a_session_design_made_where_there_was_no_design_folder_is_announced() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, _, session) = workspace_with_session(&d, &mut c, &[]).await;
    let worktree = std::path::PathBuf::from(&session.path);
    assert!(!worktree.join("docs/design").exists());
    let listed: serde_json::Value = c.request(methods::DESIGN_LIST, serde_json::json!({"workspace": ws})).await.unwrap();
    assert!(listed.is_array(), "{listed}");
    let mut listener = d.client().await;
    std::fs::create_dir_all(worktree.join(".moonlet/design/settings-page")).unwrap();
    std::fs::create_dir_all(worktree.join("docs/design/settings-page/pages")).unwrap();
    std::fs::write(worktree.join("docs/design/settings-page/pages/index.html"), "<p>made by another tool</p>\n").unwrap();
    let changed = next_event(&mut listener, methods::EV_DESIGN_CHANGED, |e| e["session"] == session.id.as_str()).await;
    assert_eq!((&changed["design"], &changed["workspace"]), (&serde_json::json!("settings-page"), &serde_json::json!(ws)));
}

/// X65 entry 12: a file written in a session design, in the worktree's
/// design folder or its `.moonlet/design/`, is announced as `design.changed`
/// with the design, its session and its workspace.
#[tokio::test]
async fn a_file_written_in_a_session_design_is_announced_with_its_session() {
    let d = fake_claude_daemon(FAKE_CLAUDE).await;
    let mut c = d.client().await;
    let (ws, _, session) = workspace_with_session(&d, &mut c, &[]).await;
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "session": session.id, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}),
        )
        .await
        .unwrap();
    let mut listener = d.client().await;
    std::fs::write(std::path::PathBuf::from(&session.path).join("docs/design/settings-page/pages/index.html"), "<p>agent</p>\n").unwrap();
    // The watch may deliver the design's own making in the same batch.
    let mut changed = next_change_of(&mut listener, "pages/index.html").await;
    changed.as_object_mut().unwrap().remove("paths");
    assert_eq!(changed, serde_json::json!({"workspace": ws, "system": null, "design": "settings-page", "session": session.id}));
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_COMMENT_PUT,
            serde_json::json!({"session": session.id, "slug": "settings-page", "new": {"page": "index", "mid": "m1", "tag": "p", "comment": "Bigger"}}),
        )
        .await
        .unwrap();
    let changed = next_change_of(&mut listener, "comments.json").await;
    assert_eq!((&changed["design"], &changed["session"]), (&serde_json::json!("settings-page"), &serde_json::json!(session.id)));
}
