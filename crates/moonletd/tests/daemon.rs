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
    let _: bool = c
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

#[tokio::test]
async fn task_updates_reach_github_through_gh() {
    use std::os::unix::fs::PermissionsExt;
    // A fake gh that records what it was asked to do.
    let bin = tempfile::tempdir().unwrap();
    let log = bin.path().join("gh.log");
    let gh = bin.path().join("gh");
    std::fs::write(&gh, "#!/bin/sh\necho \"$@\" >> \"$GH_LOG\"\n").unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    // moonletd takes PATH from a login shell, so the fake goes first in every
    // startup file of a scratch HOME (as the e2e world does).
    let home = tempfile::tempdir().unwrap();
    let first = format!("PATH=\"{}:$PATH\"; export PATH\n", bin.path().display());
    for rc in [".profile", ".zshenv", ".zprofile", ".zshrc"] {
        std::fs::write(home.path().join(rc), &first).unwrap();
    }
    let d = TestDaemon::start_with(&[
        ("HOME", home.path().display().to_string()),
        ("SHELL", "/bin/zsh".into()),
        ("GH_LOG", log.display().to_string()),
    ])
    .await;
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
    assert_eq!(
        std::fs::read_to_string(&log).unwrap(),
        "issue edit 15 --add-assignee @me\nissue close 15 --reason completed\n"
    );
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
