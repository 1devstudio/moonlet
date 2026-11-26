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
    output_until_from(c, String::new(), needle).await
}

/// What `c` has seen of a terminal: `seen` so far, then its output until
/// `needle` shows.
async fn output_until_from(c: &mut Client, mut seen: String, needle: &str) -> String {
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

/// Opens a terminal running `script` in `sh` and follows its output. Also
/// returns its screen when the client attached: what it printed before.
async fn terminal(c: &mut Client, home: &Path, script: &str) -> (TerminalInfo, String) {
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
    let attach: AttachResult = c
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
    (t, attach.snapshot)
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
    let (_, screen) = terminal(&mut c, home.path(), "echo \"tmp=[$TMPDIR]\"; sleep 30").await;
    let seen = output_until_from(&mut c, screen, "]").await;
    assert!(seen.contains(&format!("tmp=[{expected}]")), "{seen}");
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

/// Waits for `child` to exit, for up to 15 s.
fn exit_code(child: &mut Child) -> Option<i32> {
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(s) = child.try_wait().unwrap() {
            return s.code();
        }
        assert!(std::time::Instant::now() < deadline, "still running");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[tokio::test]
async fn a_daemon_started_at_login_takes_every_terminal_from_the_boot_daemon() {
    let home = tempfile::tempdir().unwrap();
    turn_boot(home.path(), true);
    let socket = home.path().join("run/d.sock");
    let mut boot = Kill(moonletd(home.path(), &socket, &["daemon", "--boot"]).spawn().unwrap());
    let before = info(&socket, home.path()).await;
    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    let (t, screen) = terminal(&mut c, home.path(), "echo before-$((6*7)); exec sh").await;
    output_until_from(&mut c, screen, "before-42").await;
    drop(c);

    // The login item starts its daemon, as at every login.
    let _login = Kill(moonletd(home.path(), &socket, &["daemon"]).spawn().unwrap());
    assert_eq!(exit_code(&mut boot.0), Some(0), "the boot daemon handed over and exited");

    let after = info(&socket, home.path()).await;
    assert_ne!(after.pid, before.pid);
    assert!(!after.started_at_boot, "the daemon in the login session serves");
    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    let list: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    let same = list.iter().find(|x| x.id == t.id).expect("the terminal is still there");
    assert_eq!(same.pid, t.pid, "same process");
    let attach: AttachResult = c
        .request(methods::TERMINAL_ATTACH, TerminalAttach { id: t.id, cols: None, rows: None })
        .await
        .unwrap();
    assert!(attach.snapshot.contains("before-42"), "{}", attach.snapshot);
    c.send(&Frame::Input { terminal: t.id, data: b"echo after-$((1+2))\n".to_vec() })
        .await
        .unwrap();
    output_until(&mut c, "after-3").await;
    let _: bool = c.request(methods::DAEMON_SHUTDOWN, ()).await.unwrap();
}

#[tokio::test]
async fn a_daemon_that_was_not_started_at_boot_is_left_serving() {
    let home = tempfile::tempdir().unwrap();
    let socket = home.path().join("run/d.sock");
    let _first = Kill(moonletd(home.path(), &socket, &["daemon"]).spawn().unwrap());
    let before = info(&socket, home.path()).await;

    let mut second = Kill(moonletd(home.path(), &socket, &["daemon"]).spawn().unwrap());
    assert_eq!(exit_code(&mut second.0), Some(0));
    assert_eq!(info(&socket, home.path()).await.pid, before.pid);
}

/// A hand-over gives every terminal to whoever connects: only the boot
/// daemon's own executable may take them. The other program exits 0, so
/// launchd does not keep starting it.
#[tokio::test]
async fn a_takeover_from_another_program_is_refused_and_the_boot_daemon_keeps_serving() {
    let home = tempfile::tempdir().unwrap();
    turn_boot(home.path(), true);
    let socket = home.path().join("run/d.sock");
    let _boot = Kill(moonletd(home.path(), &socket, &["daemon", "--boot"]).spawn().unwrap());
    let before = info(&socket, home.path()).await;
    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    let (t, screen) = terminal(&mut c, home.path(), "echo before-$((6*7)); exec sh").await;
    output_until_from(&mut c, screen, "before-42").await;

    // The same build, copied elsewhere: another program as far as the
    // boot daemon can tell.
    let elsewhere = tempfile::tempdir().unwrap();
    let copy = elsewhere.path().join("moonletd");
    std::fs::copy(env!("CARGO_BIN_EXE_moonletd"), &copy).unwrap();
    let mut other = Kill(
        Command::new(&copy)
            .arg("daemon")
            .env("MOONLET_HOME", home.path())
            .env("MOONLET_EXIT_WITH", std::process::id().to_string())
            .env("MOONLET_SOCK", &socket)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    assert_eq!(exit_code(&mut other.0), Some(0));

    let after = info(&socket, home.path()).await;
    assert_eq!(after.pid, before.pid, "the boot daemon still serves");
    assert!(after.started_at_boot);
    c.send(&Frame::Input { terminal: t.id, data: b"echo after-$((1+2))\n".to_vec() })
        .await
        .unwrap();
    output_until(&mut c, "after-3").await;
}
