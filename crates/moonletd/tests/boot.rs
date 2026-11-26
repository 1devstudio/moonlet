//! X113: moonletd starts at system start, before anyone logs in.

mod common;
use common::logs::KeepLogs;

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::Frame;
use moonlet_proto::methods::{self, AttachResult, TerminalAttach, TerminalCreate};
use moonlet_proto::types::{DaemonInfo, TerminalInfo};

struct Kill(Child);
impl Drop for Kill {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn moonletd(home: &Path, socket: &PathBuf, args: &[&str]) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_moonletd"));
    c.args(args)
        .env("MOONLET_HOME", home)
        .env("MOONLET_EXIT_WITH", std::process::id().to_string())
        .env("MOONLET_SOCK", socket)
        .env("MOONLET_TEST_APP_EXE", std::env::current_exe().unwrap())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .keep_logs(home);
    c
}

/// The user's choice, as the app saves it in `app.toml`.
fn turn_boot(home: &Path, on: bool) {
    std::fs::write(
        home.join("app.toml"),
        format!("start_daemon_at_login = true\nstart_daemon_at_boot = {on}\n"),
    )
    .unwrap();
}

async fn info(socket: &Path, home: &Path) -> DaemonInfo {
    wait_for_socket(&socket.to_path_buf(), Duration::from_secs(15))
        .await
        .unwrap();
    let mut c = Client::connect_app(socket, home).await.unwrap();
    c.request(methods::DAEMON_INFO, ()).await.unwrap()
}

#[tokio::test]
async fn a_boot_daemon_says_so() {
    let home = tempfile::tempdir().unwrap();
    turn_boot(home.path(), true);
    let socket = home.path().join("run/d.sock");
    let _boot = Kill(
        moonletd(home.path(), &socket, &["daemon", "--boot"])
            .spawn()
            .unwrap(),
    );
    assert!(info(&socket, home.path()).await.started_at_boot);

    let other = tempfile::tempdir().unwrap();
    let socket = other.path().join("run/d.sock");
    let _plain = Kill(
        moonletd(other.path(), &socket, &["daemon"])
            .spawn()
            .unwrap(),
    );
    assert!(!info(&socket, other.path()).await.started_at_boot);
}

#[test]
fn only_users_who_turned_it_on_get_a_daemon() {
    for choice in [None, Some(false)] {
        let home = tempfile::tempdir().unwrap();
        if let Some(on) = choice {
            turn_boot(home.path(), on);
        }
        let socket = home.path().join("run/d.sock");
        let mut boot = Kill(
            moonletd(home.path(), &socket, &["daemon", "--boot"])
                .spawn()
                .unwrap(),
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(s) = boot.0.try_wait().unwrap() {
                break s;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "{choice:?}: still running"
            );
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(status.code(), Some(0), "{choice:?}");
        assert!(!socket.exists(), "{choice:?}: it never listened");
    }
}

async fn output_until(c: &mut Client, needle: &str) -> String {
    let mut seen = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !seen.contains(needle) {
        let f = tokio::time::timeout_at(deadline, c.next_frame())
            .await
            .unwrap_or_else(|_| panic!("no {needle:?} in {seen:?}"))
            .unwrap()
            .unwrap();
        if let Frame::Output { data, .. } = f {
            seen.push_str(&String::from_utf8_lossy(&data));
        }
    }
    seen
}

/// Opens a terminal running `script` in `sh` and follows its output.
async fn terminal(c: &mut Client, home: &Path, script: &str) -> TerminalInfo {
    let t: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            TerminalCreate {
                cwd: home.display().to_string(),
                command: vec!["/bin/sh".into(), "-c".into(), script.into()],
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
    t
}

/// launchd gives a launch daemon no `TMPDIR` (X113 Findings).
#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_boot_daemon_gives_its_terminals_the_users_temporary_folder() {
    let out = Command::new("getconf")
        .arg("DARWIN_USER_TEMP_DIR")
        .output()
        .unwrap();
    let expected = String::from_utf8(out.stdout).unwrap().trim().to_string();
    assert!(expected.starts_with("/var/folders/"), "{expected}");

    let home = tempfile::tempdir().unwrap();
    turn_boot(home.path(), true);
    let socket = home.path().join("run/d.sock");
    let _boot = Kill(
        moonletd(home.path(), &socket, &["daemon", "--boot"])
            .env_remove("TMPDIR")
            .spawn()
            .unwrap(),
    );
    info(&socket, home.path()).await;
    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    terminal(&mut c, home.path(), "echo \"tmp=[$TMPDIR]\"; sleep 30").await;
    let seen = output_until(&mut c, "]").await;
    assert!(seen.contains(&format!("tmp=[{expected}]")), "{seen}");
}

#[cfg(target_os = "macos")]
#[test]
fn the_launcher_refuses_to_run_as_a_user() {
    let home = tempfile::tempdir().unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_moonletd"))
        .arg("boot")
        .env("MOONLET_HOME", home.path())
        .output()
        .unwrap();
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("moonletd boot runs from launchd at system start"),
        "{err}"
    );
    assert!(!home.path().join("run").exists(), "it started no daemon");
}

/// The S3 handoff starts the new daemon from the old one, so it runs where
/// the boot daemon ran: outside a login session.
#[tokio::test]
async fn an_upgraded_boot_daemon_still_says_so() {
    let home = tempfile::tempdir().unwrap();
    turn_boot(home.path(), true);
    let socket = home.path().join("run/d.sock");
    let _boot = Kill(
        moonletd(home.path(), &socket, &["daemon", "--boot"])
            .spawn()
            .unwrap(),
    );
    let before = info(&socket, home.path()).await;
    // Turned off since: the terminals it serves stay served.
    turn_boot(home.path(), false);

    let status = moonletd(home.path(), &socket, &["upgrade"])
        .status()
        .unwrap();
    assert!(status.success());
    let after = info(&socket, home.path()).await;
    assert_ne!(after.pid, before.pid);
    assert!(after.started_at_boot);

    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    let _: bool = c.request(methods::DAEMON_SHUTDOWN, ()).await.unwrap();
}
