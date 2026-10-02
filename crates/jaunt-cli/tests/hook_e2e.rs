//! `jaunt hook claude` inside a pane reaches the daemon and raises attention
//! fast enough for the PRD target (blocked to notified < 2 s).
//! Needs `jauntd` built next to this test binary (`cargo test --workspace`).

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use jaunt_core::client::{Client, wait_for_socket};
use jaunt_proto::methods::{self, Attention, SessionCreate};
use jaunt_proto::types::{AgentState, SessionInfo, SessionKind};
use jaunt_proto::{Frame, Message};

fn target_bin(name: &str) -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().parent().unwrap();
    let p = dir.join(name);
    assert!(
        p.exists(),
        "{} missing: run `cargo test --workspace`",
        p.display()
    );
    p
}

/// Kills the daemon even when an assertion fails, so no orphan holds the
/// test runner's output pipe open.
struct KillOnDrop(std::process::Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn claude_hook_raises_attention_quickly() {
    let home = tempfile::tempdir().unwrap();
    let socket = home.path().join("run/d.sock");
    let _daemon = KillOnDrop(
        Command::new(target_bin("jauntd"))
            .arg("daemon")
            .env("JAUNT_HOME", home.path())
            .env("JAUNT_SOCK", &socket)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_for_socket(&socket, Duration::from_secs(15))
        .await
        .unwrap();

    let mut c = Client::connect(&socket, "test").await.unwrap();
    let jaunt = env!("CARGO_BIN_EXE_jaunt");
    let script = format!(
        "sleep 0.3; echo '{{\"hook_event_name\":\"Notification\",\"message\":\"Claude needs your permission to use Bash\"}}' | '{jaunt}' hook claude; sleep 5"
    );
    let info: SessionInfo = c
        .request(
            methods::SESSION_CREATE,
            SessionCreate {
                cwd: home.path().display().to_string(),
                command: vec!["/bin/sh".into(), "-c".into(), script],
                kind: SessionKind::Agent,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let started = Instant::now();
    let attention = loop {
        let f = tokio::time::timeout(Duration::from_secs(10), c.next_frame())
            .await
            .expect("no attention event")
            .unwrap()
            .unwrap();
        if let Frame::Json(Message::Event { name, data }) = f
            && name == methods::EV_AGENT_ATTENTION
        {
            break serde_json::from_value::<Attention>(data).unwrap();
        }
    };
    let elapsed = started.elapsed();
    assert_eq!(attention.session, info.id);
    assert_eq!(attention.state, AgentState::Blocked);
    assert_eq!(
        attention.message.as_deref(),
        Some("Claude needs your permission to use Bash")
    );
    // 0.3 s of that is the script's own sleep.
    assert!(elapsed < Duration::from_secs(2), "took {elapsed:?}");
    eprintln!(
        "hook to attention: {:?}",
        elapsed - Duration::from_millis(300)
    );
}

#[test]
fn hook_is_silent_outside_jaunt() {
    let out = Command::new(env!("CARGO_BIN_EXE_jaunt"))
        .args(["hook", "claude"])
        .env_remove("JAUNT_SESSION_ID")
        .env("JAUNT_SOCK", "/nonexistent/sock")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(out.stdout.is_empty() && out.stderr.is_empty());
}
