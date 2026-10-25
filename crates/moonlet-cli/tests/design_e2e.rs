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

    /// A daemon whose agents find a fake `claude` that answers every message
    /// at once: its HOME is the scratch folder, whose rc files put the fake
    /// first on the login shell's PATH, so no real Claude Code ever starts.
    async fn with_fake_claude() -> Daemon {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(
            bin.join("claude"),
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}' ;;
    *'"type":"user"'*) echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}' ;;
  esac
done
"#,
        )
        .unwrap();
        std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let first = format!("PATH=\"{}:$PATH\"; export PATH\n", bin.display());
        for rc in [".profile", ".zshenv", ".zprofile", ".zshrc", ".bash_profile"] {
            std::fs::write(home.path().join(rc), &first).unwrap();
        }
        let socket = home.path().join("run/d.sock");
        let child = Command::new(target_bin("moonletd"))
            .arg("daemon")
            .env("HOME", home.path())
            .env("MOONLET_HOME", home.path())
            .env("MOONLET_SOCK", &socket)
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env_remove("CLAUDE_CONFIG_DIR")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        wait_for_socket(&socket, Duration::from_secs(15)).await.unwrap();
        Daemon { home, socket, child }
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

/// A design system with a button card of two variants and a field card
/// whose mount is empty, for `--render` and `snap` (X64).
async fn render_system(d: &Daemon) -> PathBuf {
    let mut c = Client::connect(&d.socket, "test").await.unwrap();
    let ws: Workspace = c
        .request(
            methods::WORKSPACE_CREATE,
            serde_json::json!({"name": "1devstudio", "color": "clay"}),
        )
        .await
        .unwrap();
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_SYSTEM_CREATE,
            serde_json::json!({"workspace": ws.id, "name": "storefront", "sources": [], "agent": false}),
        )
        .await
        .unwrap();
    let dir = d
        .home
        .path()
        .join("design")
        .join(&ws.id)
        .join("systems/storefront");
    for (path, body) in [
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
        std::fs::write(dir.join(path), body).unwrap();
    }
    dir
}

/// A stand-in for the moonlet app: it renders cards for the daemon, finds
/// the field's empty mount bad, and snaps a 6 KB PNG.
async fn fake_app(d: &Daemon) {
    use moonlet_proto::{Frame, Message};
    let mut app = Client::connect(&d.socket, "moonlet-app").await.unwrap();
    let _: serde_json::Value = app
        .request(methods::DESIGN_RENDER_READY, serde_json::json!({}))
        .await
        .unwrap();
    tokio::spawn(async move {
        while let Ok(Some(f)) = app.next_frame().await {
            let Frame::Json(Message::Event { name, data }) = f else {
                continue;
            };
            if name != methods::EV_DESIGN_RENDER {
                continue;
            }
            let mut done = serde_json::json!({"id": data["id"]});
            if data["want"] == "png" {
                // The PNG signature, then 6 KB of zeros.
                done["png_base64"] = format!("iVBORw0KGgo{}", "A".repeat(8181)).into();
            } else if data["path"]
                .as_str()
                .is_some_and(|p| p.ends_with("field.html"))
            {
                done["metrics"] = serde_json::json!({"flags": ["rootEmpty", "bad"]});
            } else {
                done["metrics"] = serde_json::json!({"flags": []});
            }
            let _: serde_json::Value = app
                .request(methods::DESIGN_RENDER_DONE, done)
                .await
                .unwrap();
        }
    });
}

// Multi-threaded: the stand-in app answers while the CLI blocks this thread.
#[tokio::test(flavor = "multi_thread")]
async fn the_sync_agent_renders_its_cards_and_snaps_one_from_its_folder() {
    let d = Daemon::start().await;
    let dir = render_system(&d).await;
    fake_app(&d).await;

    let check = d.moonlet(&dir, &["design", "check", "--render"]);
    // A bad card fails the check, as a problem does.
    assert_eq!(check.status.code(), Some(1));
    let out: serde_json::Value = serde_json::from_str(&text(&check)).unwrap();
    assert_eq!(
        out["render"],
        serde_json::json!({"total": 2, "bad": 1, "thin": 0, "variants_identical": 0})
    );
    assert!(dir.join(".cache/render-check.json").is_file());

    let card_dir = dir.join("components/buttons/button");
    let snap = d.moonlet(
        &card_dir,
        &[
            "design",
            "snap",
            "button.html",
            "--variant",
            "ghost",
            "--viewport",
            "600x400",
        ],
    );
    assert!(
        snap.status.success(),
        "{}",
        String::from_utf8_lossy(&snap.stderr)
    );
    let shot: serde_json::Value = serde_json::from_str(&text(&snap)).unwrap();
    assert_eq!(shot["blank"], false);
    let path = PathBuf::from(shot["path"].as_str().unwrap());
    assert!(
        path.ends_with(".cache/screenshots/components/buttons/button/button--ghost-600x400.png"),
        "{path:?}"
    );
    assert!(path.is_file());

    // Only a card of the system the command runs in.
    let other = d.moonlet(&dir, &["design", "snap", "../../../../README.md"]);
    assert!(!other.status.success());
    let bad = d.moonlet(&dir, &["design", "snap", "x.html", "--viewport", "wide"]);
    assert!(!bad.status.success());
}

#[tokio::test]
async fn without_the_app_render_and_snap_say_to_open_moonlet() {
    let d = Daemon::start().await;
    let dir = render_system(&d).await;
    // The check prints its problems, then fails with why nothing rendered.
    let check = d.moonlet(&dir, &["design", "check", "--render"]);
    assert_eq!(check.status.code(), Some(1));
    let out: serde_json::Value = serde_json::from_str(&text(&check)).unwrap();
    assert_eq!(out["problems"], serde_json::json!([]));
    assert_eq!(out["render"], serde_json::Value::Null);
    assert_eq!(
        String::from_utf8_lossy(&check.stderr),
        "moonlet: Open moonlet to render cards\n"
    );
    for args in [vec!["design", "snap", "components/buttons/button/button.html"]] {
        let out = d.moonlet(&dir, &args);
        assert!(!out.status.success(), "{args:?}");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("Open moonlet to render cards"),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    // The check without --render needs no app.
    let plain = d.moonlet(&dir, &["design", "check"]);
    assert_eq!(plain.status.code(), Some(0), "{}", text(&plain));
}

/// A workspace with the design system `moonlet-desktop` (no sync agent);
/// returns the workspace's id.
async fn workspace_with_system(d: &Daemon) -> String {
    let mut c = Client::connect(&d.socket, "test").await.unwrap();
    let ws: Workspace = c
        .request(
            methods::WORKSPACE_CREATE,
            serde_json::json!({"name": "1devstudio", "color": "clay"}),
        )
        .await
        .unwrap();
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_SYSTEM_CREATE,
            serde_json::json!({"workspace": ws.id, "name": "moonlet desktop", "sources": [], "agent": false}),
        )
        .await
        .unwrap();
    ws.id
}

fn json(o: &Output) -> serde_json::Value {
    assert!(
        o.status.success(),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    serde_json::from_str(&text(o)).unwrap()
}

/// X65: `moonlet design new|ls|open|rm` make, list, show and remove a
/// workspace's designs over the daemon's socket, the workspace coming from
/// the folder the command runs in.
#[tokio::test]
async fn designs_are_made_listed_opened_and_removed_from_the_cli() {
    use moonlet_proto::{Frame, Message};
    let d = Daemon::with_fake_claude().await;
    let ws = workspace_with_system(&d).await;
    let here = d.home.path().join("design").join(&ws);

    let made = json(&d.moonlet(
        &here,
        &[
            "design",
            "new",
            "--system",
            "moonlet-desktop",
            "--name",
            "Settings page",
            "A settings page with General and Git sections",
        ],
    ));
    assert_eq!(
        (&made["slug"], &made["name"], &made["kind"], &made["system"]),
        (
            &serde_json::json!("settings-page"),
            &serde_json::json!("Settings page"),
            &serde_json::json!("workspace"),
            &serde_json::json!("moonlet-desktop")
        )
    );
    assert!(made["agent"].is_u64(), "{made}");
    // Without --name, the brief's first words name it.
    let unnamed = json(&d.moonlet(
        &here,
        &["design", "new", "--system", "moonlet-desktop", "Pricing table for three plans, monthly and yearly"],
    ));
    assert_eq!(unnamed["name"], "Pricing table for three plans");

    let list = json(&d.moonlet(&here, &["design", "ls"]));
    let slugs: Vec<&str> = list.as_array().unwrap().iter().map(|d| d["slug"].as_str().unwrap()).collect();
    assert_eq!(slugs, vec!["pricing-table-for-three-plans", "settings-page"]);

    let mut app = Client::connect(&d.socket, "moonlet-app").await.unwrap();
    let opened = d.moonlet(&here, &["design", "open", "settings-page"]);
    assert!(opened.status.success(), "{}", String::from_utf8_lossy(&opened.stderr));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let f = tokio::time::timeout_at(deadline, app.next_frame()).await.expect("no design.open").unwrap().unwrap();
        if let Frame::Json(Message::Event { name, data }) = f
            && name == methods::EV_DESIGN_OPEN
        {
            assert_eq!(data, serde_json::json!({"workspace": ws, "slug": "settings-page", "name": "Settings page"}));
            break;
        }
    }

    let removed = d.moonlet(&here, &["design", "rm", "settings-page"]);
    assert!(removed.status.success(), "{}", String::from_utf8_lossy(&removed.stderr));
    let list = json(&d.moonlet(d.home.path(), &["design", "ls", "--workspace", &ws]));
    assert_eq!(list.as_array().unwrap().len(), 1, "{list}");
    assert!(!here.join("designs/settings-page").exists());

    // Outside any design folder or session, it says what it needs.
    let lost = d.moonlet(d.home.path(), &["design", "ls"]);
    assert!(!lost.status.success());
    assert!(String::from_utf8_lossy(&lost.stderr).contains("no workspace"));
}

/// X65: in its folder, a design's agent checks its pages with `moonlet design
/// check`, and `--fix` gives the missing ids; from elsewhere the design is
/// named.
#[tokio::test]
async fn a_designs_agent_checks_and_fixes_its_pages_from_its_folder() {
    let d = Daemon::with_fake_claude().await;
    let ws = workspace_with_system(&d).await;
    let mut c = Client::connect(&d.socket, "test").await.unwrap();
    let _: serde_json::Value = c
        .request(
            methods::DESIGN_CREATE,
            serde_json::json!({"workspace": ws, "name": "Settings page", "system": "moonlet-desktop", "brief": "b"}),
        )
        .await
        .unwrap();
    let dir = d.home.path().join("design").join(&ws).join("designs/settings-page");
    std::fs::write(
        dir.join("pages/index.html"),
        "<html><head><link rel=\"stylesheet\" href=\"../../../systems/moonlet-desktop/styles.css\"></head>\n<body data-mid=\"m1\">\n<h1>Settings</h1>\n</body></html>\n",
    )
    .unwrap();

    let check = d.moonlet(&dir.join("pages"), &["design", "check"]);
    assert_eq!(check.status.code(), Some(1), "{}", String::from_utf8_lossy(&check.stderr));
    let problems: serde_json::Value = serde_json::from_str(&text(&check)).unwrap();
    assert_eq!(
        problems,
        serde_json::json!([{"path": "pages/index.html", "line": 3, "kind": "missing_mid", "message": "<h1> has no data-mid"}])
    );
    let fixed = d.moonlet(&dir, &["design", "check", "--fix"]);
    assert_eq!(fixed.status.code(), Some(0), "{}", String::from_utf8_lossy(&fixed.stderr));
    assert_eq!(serde_json::from_str::<serde_json::Value>(&text(&fixed)).unwrap(), serde_json::json!([]));
    assert!(std::fs::read_to_string(dir.join("pages/index.html")).unwrap().contains("<h1 data-mid=\"m2\">Settings</h1>"));
    let named = d.moonlet(d.home.path(), &["design", "check", "settings-page", "--workspace", &ws]);
    assert_eq!(named.status.code(), Some(0), "{}", String::from_utf8_lossy(&named.stderr));
}
