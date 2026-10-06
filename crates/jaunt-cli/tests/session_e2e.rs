//! `jaunt project` and `jaunt session` against a real daemon (X22).
//! Needs `jauntd` built next to this test binary (`cargo test --workspace`).

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use jaunt_core::client::{Client, wait_for_socket};
use jaunt_proto::methods;
use jaunt_proto::types::{Project, Session};

fn target_bin(name: &str) -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let p = exe.parent().unwrap().parent().unwrap().join(name);
    assert!(p.exists(), "{} missing: run `cargo test --workspace`", p.display());
    p
}

struct Daemon {
    home: tempfile::TempDir,
    socket: PathBuf,
    child: std::process::Child,
}

impl Daemon {
    async fn start() -> Daemon {
        let home = tempfile::tempdir().unwrap();
        let socket = home.path().join("run/d.sock");
        let child = Command::new(target_bin("jauntd"))
            .arg("daemon")
            .env("JAUNT_HOME", home.path())
            .env("JAUNT_SOCK", &socket)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        wait_for_socket(&socket, Duration::from_secs(15)).await.unwrap();
        Daemon { home, socket, child }
    }

    /// Runs `jaunt` as an agent in `terminal` would.
    fn jaunt(&self, terminal: Option<u32>, args: &[&str]) -> Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_jaunt"));
        cmd.args(args).env("JAUNT_SOCK", &self.socket).env_remove("JAUNT_TERMINAL_ID");
        if let Some(t) = terminal {
            cmd.env("JAUNT_TERMINAL_ID", t.to_string());
        }
        cmd.stdin(Stdio::null()).output().unwrap()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn git_repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"],
    ] {
        assert!(Command::new("git").args(args).current_dir(dir).status().unwrap().success());
    }
}

fn stdout(out: &Output) -> String {
    assert!(out.status.success(), "jaunt failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout.clone()).unwrap()
}

#[tokio::test]
async fn an_agent_opens_a_session_in_another_project() {
    let d = Daemon::start().await;
    let (api, web) = (d.home.path().join("code/api"), d.home.path().join("code/web"));
    git_repo(&api);
    git_repo(&web);
    let mut c = Client::connect(&d.socket, "test").await.unwrap();
    let api_p: Project = c.request(methods::PROJECT_ADD, serde_json::json!({"path": api})).await.unwrap();
    let web_p: Project = c.request(methods::PROJECT_ADD, serde_json::json!({"path": web})).await.unwrap();
    let parent: Session = c
        .request(
            methods::SESSION_CREATE,
            serde_json::json!({"project_id": api_p.id, "name": "Billing export", "agent": "none"}),
        )
        .await
        .unwrap();

    let out = d.jaunt(None, &["project", "ls"]);
    assert_eq!(
        stdout(&out),
        format!(
            "NAME                 BASE         PATH\napi                  main         {}\nweb                  main         {}\n",
            api_p.path, web_p.path
        )
    );

    let out = d.jaunt(
        Some(parent.terminals[0]),
        &["session", "new", "web", "--agent", "none", "Add a download button"],
    );
    let child: Session = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!(child.project_id, web_p.id);
    assert_eq!(child.name, "Add a download button");
    assert_eq!(child.branch, "jaunt/add-a-download-button");
    assert_eq!(child.spawned_by.as_deref(), Some(parent.id.as_str()));
    assert_eq!(child.mode.as_deref(), Some("manual"));
    assert!(Path::new(&child.path).join(".git").exists());

    let out = d.jaunt(Some(parent.terminals[0]), &["session", "new", "mobile", "Nope"]);
    assert!(!out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "jaunt: no project \"mobile\"; known projects: api, web\n"
    );
}

/// The skill calls `"$JAUNT_BIN"`, so every terminal must have it.
#[tokio::test]
async fn terminals_know_where_the_jaunt_cli_is() {
    use jaunt_proto::methods::TerminalCreate;
    use jaunt_proto::types::TerminalInfo;
    let d = Daemon::start().await;
    let out = d.home.path().join("env.txt");
    let mut c = Client::connect(&d.socket, "test").await.unwrap();
    let _: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            TerminalCreate {
                cwd: d.home.path().display().to_string(),
                command: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    format!("printf '%s\\n' \"$JAUNT_BIN\" \"$JAUNT_SOCK\" > '{}'", out.display()),
                ],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    for _ in 0..250 {
        if std::fs::read_to_string(&out).is_ok_and(|s| s.lines().count() == 2) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let jaunt = Path::new(env!("CARGO_BIN_EXE_jaunt")).canonicalize().unwrap();
    assert_eq!(
        std::fs::read_to_string(&out).unwrap(),
        format!("{}\n{}\n", jaunt.display(), d.socket.display())
    );
}
