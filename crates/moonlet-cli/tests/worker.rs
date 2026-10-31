//! X63 from an agent's side: `moonlet worker up`, `ls` and `down`, with the
//! fake cloud provider. Needs `moonletd` built next to this test binary
//! (`cargo test --workspace`).

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::Duration;

use moonlet_core::client::{Client, wait_for_socket};
use serde_json::{Value, json};

fn target_bin(name: &str) -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().parent().unwrap();
    dir.join(name)
}

struct Host {
    home: tempfile::TempDir,
    fake: tempfile::TempDir,
    socket: PathBuf,
    daemon: Child,
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
        for e in std::fs::read_dir(self.fake.path())
            .into_iter()
            .flatten()
            .flatten()
        {
            if let Some(pid) = std::fs::read_to_string(e.path().join("pid"))
                .ok()
                .and_then(|p| p.trim().parse::<i32>().ok())
            {
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(pid),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
        }
    }
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
}

/// A central host with project `shop` set to use the fake provider.
async fn host() -> (Host, String) {
    let home = tempfile::tempdir().unwrap();
    let fake = tempfile::tempdir().unwrap();
    let socket = home.path().join("run/d.sock");
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    std::fs::write(
        home.path().join("mobile.json"),
        format!(r#"{{ "enabled": true, "port": {port} }}"#),
    )
    .unwrap();
    let daemon = Command::new(target_bin("moonletd"))
        .arg("daemon")
        .env("MOONLET_HOME", home.path())
        .env("MOONLET_SOCK", &socket)
        .env("CLAUDE_CONFIG_DIR", home.path().join("claude"))
        .env("MOONLET_MOBILE_ADDRS", "127.0.0.1")
        .env("MOONLET_CLOUD_FAKE", fake.path())
        .env("MOONLET_TEST_LOAD", "0.5")
        .env("SHELL", "/bin/sh")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    wait_for_socket(&socket, Duration::from_secs(15))
        .await
        .unwrap();
    let h = Host {
        home,
        fake,
        socket,
        daemon,
    };
    let mut app = Client::connect_app(&h.socket, h.home.path()).await.unwrap();
    for _ in 0..100 {
        let st: Value = app.request("mobile.status", json!({})).await.unwrap();
        if st["listening"].as_array().is_some_and(|l| !l.is_empty()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let repo = h.home.path().join("src/shop");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README.md"), "shop\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "shop"]);
    let project: Value = app
        .request("project.add", json!({ "path": repo }))
        .await
        .unwrap();
    let key = format!(" {}", project["identity"]["root"].as_str().unwrap());
    let _: Value = app
        .request(
            "cloud.set",
            json!({
                "providers": { "fake": {} },
                "projects": { key: { "provider": "fake", "type": "small", "location": "here", "image": "none" } }
            }),
        )
        .await
        .unwrap();
    let session: Value = app
        .request(
            "session.create",
            json!({ "project_id": project["id"], "name": "fix-cart", "agent": "none" }),
        )
        .await
        .unwrap();
    (h, session["id"].as_str().unwrap().to_string())
}

fn worker(h: &Host, session: Option<&str>, args: &[&str]) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_moonlet"));
    cmd.arg("worker").args(args).env("MOONLET_SOCK", &h.socket);
    match session {
        Some(s) => cmd.env("MOONLET_SESSION", s),
        None => cmd.env_remove("MOONLET_SESSION"),
    };
    cmd.output().unwrap()
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).to_string()
}

#[tokio::test]
async fn worker_up_ls_and_down() {
    let (h, session) = host().await;
    // The session's project by default; or by name.
    let up = worker(&h, Some(&session), &["up"]);
    assert!(up.status.success(), "{}", text(&up.stderr));
    let name = text(&up.stdout).trim().to_string();
    assert!(name.starts_with("moonlet-shop-"), "{name}");
    // Made for the session it was started in.
    let mut app = Client::connect_app(&h.socket, h.home.path()).await.unwrap();
    let all: Value = app.request("cloud.machines", json!({})).await.unwrap();
    let mine = all["machines"].as_array().unwrap().iter().find(|m| m["name"] == name.as_str()).unwrap().clone();
    assert_eq!(mine["for_session"], json!(session));
    let up = worker(&h, None, &["up", "--project", "shop"]);
    assert!(up.status.success(), "{}", text(&up.stderr));
    // A third passes the limit.
    let over = worker(&h, None, &["up", "--project", "shop"]);
    assert_eq!(over.status.code(), Some(1));
    assert_eq!(
        text(&over.stderr),
        "moonlet: Cloud limit reached: 2 of 2 machines\n"
    );
    let mut listed = String::new();
    for _ in 0..100 {
        listed = text(&worker(&h, None, &["ls"]).stdout);
        if listed.lines().filter(|l| l.contains(" ready ")).count() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mine = listed
        .lines()
        .find(|l| l.starts_with(&name))
        .unwrap_or_default()
        .to_string();
    assert!(
        mine.contains(" ready ") && mine.ends_with(" shop"),
        "{listed}"
    );
    let down = worker(&h, None, &["down", &name]);
    assert!(down.status.success(), "{}", text(&down.stderr));
    for _ in 0..100 {
        let listed = text(&worker(&h, None, &["ls"]).stdout);
        if !listed.contains(&name) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("{name} is still listed");
}
