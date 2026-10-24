//! `moonlet design` against a real daemon (X64): what the sync agent runs in
//! its design system's folder. Needs `moonletd` built next to this test
//! binary (`cargo test --workspace`).

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::methods;
use moonlet_proto::types::{Project, Workspace};

fn target_bin(name: &str) -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let p = exe.parent().unwrap().parent().unwrap().join(name);
    assert!(
        p.exists(),
        "{} missing: run `cargo test --workspace`",
        p.display()
    );
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
        let child = Command::new(target_bin("moonletd"))
            .arg("daemon")
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
        Daemon {
            home,
            socket,
            child,
        }
    }

    /// `moonlet <args>` in folder `cwd`, outside any moonlet terminal.
    fn moonlet(&self, cwd: &Path, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_moonlet"))
            .args(args)
            .current_dir(cwd)
            .env("MOONLET_HOME", self.home.path())
            .env("MOONLET_SOCK", &self.socket)
            .env_remove("MOONLET_TERMINAL_ID")
            .output()
            .unwrap()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn text(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

#[tokio::test]
async fn the_sync_agent_reports_checks_and_records_from_its_folder() {
    let d = Daemon::start().await;
    let repo = d.home.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(
        repo.join("src/ui.tsx"),
        "export const Button = () => null;\n",
    )
    .unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["add", "-A"],
        vec![
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "-m",
            "init",
        ],
    ] {
        assert!(
            Command::new("git")
                .args(&args)
                .current_dir(&repo)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    let mut c = Client::connect(&d.socket, "test").await.unwrap();
    let ws: Workspace = c
        .request(
            methods::WORKSPACE_CREATE,
            serde_json::json!({"name": "1devstudio", "color": "clay"}),
        )
        .await
        .unwrap();
    let _: Project = c
        .request(methods::PROJECT_ADD, serde_json::json!({"path": repo}))
        .await
        .unwrap();

    let new = d.moonlet(
        d.home.path(),
        &[
            "design",
            "system",
            "new",
            "moonlet desktop",
            "--from",
            "repo",
            "--workspace",
            &ws.id,
        ],
    );
    assert!(
        new.status.success(),
        "{}",
        String::from_utf8_lossy(&new.stderr)
    );
    assert_eq!(text(&new), "moonlet-desktop\n");

    let dir = d
        .home
        .path()
        .join("design")
        .join(&ws.id)
        .join("systems/moonlet-desktop");
    for (path, body) in [
        ("styles.css", "@import \"components.css\";\n"),
        ("components.css", ".btn { color: var(--color-fg); }\n"),
        (
            "components/buttons/button/button.html",
            "<!-- @dsCard group=\"Buttons\" source=\"src/ui.tsx\" -->\n<button class=\"btn\">Run</button>\n",
        ),
    ] {
        std::fs::create_dir_all(dir.join(path).parent().unwrap()).unwrap();
        std::fs::write(dir.join(path), body).unwrap();
    }
    let card_dir = dir.join("components/buttons/button");

    // In its folder, the agent's commands need no --workspace or --system.
    assert!(
        d.moonlet(
            &card_dir,
            &["design", "system", "progress", "cards", "1", "of", "1"]
        )
        .status
        .success()
    );
    let list: serde_json::Value =
        serde_json::from_str(&text(&d.moonlet(&dir, &["design", "system", "ls"]))).unwrap();
    assert_eq!(
        (list[0]["step"].as_str(), list[0]["step_summary"].as_str()),
        (Some("cards"), Some("1 of 1"))
    );

    let check = d.moonlet(&dir, &["design", "check"]);
    assert_eq!(check.status.code(), Some(1));
    let problems: serde_json::Value = serde_json::from_str(&text(&check)).unwrap();
    assert_eq!(problems[0]["kind"], "unknown_token");
    assert_eq!(
        problems[0]["message"],
        "var(--color-fg) is not defined in styles.css or the files it imports"
    );

    assert!(
        d.moonlet(&dir, &["design", "system", "synced"])
            .status
            .success()
    );
    let list: serde_json::Value = serde_json::from_str(&text(&d.moonlet(
        d.home.path(),
        &["design", "system", "ls", "--workspace", &ws.id],
    )))
    .unwrap();
    assert_eq!(list[0]["step"], serde_json::Value::Null);
    assert!(
        list[0]["synced_commit"]
            .as_str()
            .is_some_and(|c| !c.is_empty())
    );

    // Outside any design folder or session, it says what it needs.
    let lost = d.moonlet(d.home.path(), &["design", "check"]);
    assert!(!lost.status.success());
    assert!(String::from_utf8_lossy(&lost.stderr).contains("no workspace"));
}

/// The agent's commands act only on the system of the folder they run in:
/// they take no `--system` or `--workspace`, so an agent cannot report a
/// step or record a sync of another system.
#[tokio::test]
async fn the_sync_agents_commands_act_only_on_the_system_of_their_folder() {
    let d = Daemon::start().await;
    let mut c = Client::connect(&d.socket, "test").await.unwrap();
    let ws: Workspace = c
        .request(
            methods::WORKSPACE_CREATE,
            serde_json::json!({"name": "1devstudio", "color": "clay"}),
        )
        .await
        .unwrap();
    for name in ["alpha", "beta"] {
        let _: serde_json::Value = c
            .request(
                methods::DESIGN_SYSTEM_CREATE,
                serde_json::json!({"workspace": ws.id, "name": name, "sources": [], "agent": false}),
            )
            .await
            .unwrap();
    }
    let alpha = d
        .home
        .path()
        .join("design")
        .join(&ws.id)
        .join("systems/alpha");
    for args in [
        vec!["design", "system", "progress", "cards", "--system", "beta"],
        vec![
            "design",
            "system",
            "progress",
            "cards",
            "--workspace",
            &ws.id,
        ],
        vec!["design", "system", "synced", "--system", "beta"],
        vec!["design", "system", "synced", "--workspace", &ws.id],
    ] {
        let out = d.moonlet(&alpha, &args);
        assert!(!out.status.success(), "{args:?} was accepted");
    }
    let list: serde_json::Value =
        serde_json::from_str(&text(&d.moonlet(&alpha, &["design", "system", "ls"]))).unwrap();
    let state: Vec<(&str, &serde_json::Value, &serde_json::Value)> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["slug"].as_str().unwrap(), &s["step"], &s["synced_at"]))
        .collect();
    assert_eq!(
        state,
        vec![
            ("alpha", &serde_json::Value::Null, &serde_json::Value::Null),
            ("beta", &serde_json::Value::Null, &serde_json::Value::Null),
        ]
    );
    // Outside a system's folder, they say where to run them.
    let lost = d.moonlet(d.home.path(), &["design", "system", "progress", "cards"]);
    assert!(!lost.status.success());
}
