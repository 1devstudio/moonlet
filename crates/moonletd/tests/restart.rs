//! X97: `moonletd restart` hands terminals to a fresh daemon, and
//! `--force` replaces one that is stuck.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use moonlet_core::client::Client;
use moonlet_proto::methods::{self, TerminalCreate};
use moonlet_proto::types::{DaemonInfo, TerminalInfo};

/// A scratch home whose daemon runs detached, as `moonletd start` leaves it,
/// and is stopped when the test ends.
struct Home {
    dir: tempfile::TempDir,
    socket: PathBuf,
}

impl Home {
    fn new() -> Home {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("run/moonletd.sock");
        Home { dir, socket }
    }

    fn moonletd(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_moonletd"))
            .args(args)
            .env("MOONLET_HOME", self.dir.path())
            .env("MOONLET_SOCK", &self.socket)
            .env("MOONLET_EXIT_WITH", std::process::id().to_string())
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }

    async fn info(&self) -> DaemonInfo {
        let mut c = Client::connect(&self.socket, "test").await.unwrap();
        c.request(methods::DAEMON_INFO, ()).await.unwrap()
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let pid =
            std::fs::read_to_string(self.socket.with_file_name("moonletd.pid")).unwrap_or_default();
        if let Ok(pid) = pid.trim().parse::<i32>() {
            signal(pid, "KILL");
        }
    }
}

fn signal(pid: i32, sig: &str) {
    let _ = Command::new("kill")
        .arg(format!("-{sig}"))
        .arg(pid.to_string())
        .status();
}

fn alive(pid: i32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
}

async fn terminal(home: &Home, cwd: &Path) -> TerminalInfo {
    let mut c = Client::connect(&home.socket, "test").await.unwrap();
    c.request(
        methods::TERMINAL_CREATE,
        TerminalCreate {
            cwd: cwd.display().to_string(),
            command: vec!["/bin/sh".into()],
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn restart_keeps_terminals_on_a_daemon_that_answers() {
    let home = Home::new();
    assert!(home.moonletd(&["start"]).status.success());
    let before = home.info().await;
    let t = terminal(&home, home.dir.path()).await;

    let out = home.moonletd(&["restart"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let after = home.info().await;
    assert_ne!(after.pid, before.pid, "a new daemon process serves");
    let mut c = Client::connect(&home.socket, "test").await.unwrap();
    let list: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    let same = list
        .iter()
        .find(|x| x.id == t.id)
        .expect("the terminal is still there");
    assert_eq!(same.pid, t.pid, "the same shell keeps running");
    assert!(same.exit.is_none());
}

#[tokio::test]
async fn restart_leaves_a_daemon_that_does_not_answer_and_exits_3() {
    let home = Home::new();
    assert!(home.moonletd(&["start"]).status.success());
    let stuck = home.info().await.pid as i32;
    signal(stuck, "STOP");

    let asked = std::time::Instant::now();
    let out = home.moonletd(&["restart"]);
    let took = asked.elapsed();

    assert_eq!(out.status.code(), Some(3));
    // It gives up after 3 s; the rest of the bound is slack for a busy machine.
    assert!(
        took >= std::time::Duration::from_secs(3) && took < std::time::Duration::from_secs(10),
        "took {took:?}"
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        "the daemon isn't answering"
    );
    assert!(alive(stuck), "the daemon is left running");
    signal(stuck, "CONT");
    assert_eq!(
        home.info().await.pid as i32,
        stuck,
        "and it still serves once it answers again"
    );
}

#[tokio::test]
async fn force_restart_replaces_a_daemon_that_does_not_answer() {
    let home = Home::new();
    assert!(home.moonletd(&["start"]).status.success());
    let stuck = home.info().await.pid as i32;
    signal(stuck, "STOP");

    let out = home.moonletd(&["restart", "--force"]);

    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!alive(stuck), "the stuck daemon is gone");
    let fresh = home.info().await.pid as i32;
    assert_ne!(fresh, stuck, "a new daemon answers on the same socket");
}

#[tokio::test]
async fn force_restart_never_kills_a_process_that_is_not_moonletd() {
    let home = Home::new();
    // A pid file left by a daemon that died, naming a pid that now belongs
    // to something else.
    let mut other = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    std::fs::create_dir_all(home.socket.parent().unwrap()).unwrap();
    std::fs::write(
        home.socket.with_file_name("moonletd.pid"),
        other.id().to_string(),
    )
    .unwrap();

    let out = home.moonletd(&["restart", "--force"]);

    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(alive(other.id() as i32), "the other process keeps running");
    assert_ne!(home.info().await.pid, other.id(), "a new daemon answers");
    let _ = other.kill();
    let _ = other.wait();
}

#[tokio::test]
async fn restart_starts_a_daemon_when_none_runs() {
    let home = Home::new();

    let out = home.moonletd(&["restart"]);

    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(home.info().await.pid > 0, "a daemon answers");
}

#[tokio::test]
async fn force_restart_finds_a_daemon_whose_pid_file_is_gone() {
    let home = Home::new();
    assert!(home.moonletd(&["start"]).status.success());
    let old = home.info().await.pid as i32;
    std::fs::remove_file(home.socket.with_file_name("moonletd.pid")).unwrap();

    let out = home.moonletd(&["restart", "--force"]);

    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!alive(old), "the old daemon is gone");
    assert_ne!(home.info().await.pid as i32, old, "a new daemon answers");
}

#[tokio::test]
async fn force_restart_does_not_wait_for_a_killed_daemon_to_be_reaped() {
    let home = Home::new();
    // Started by a parent that never waits on it, as a long-lived
    // `moonletd proxy` does: once killed it stays a zombie.
    let mut parent = Command::new(env!("CARGO_BIN_EXE_moonletd"))
        .arg("daemon")
        .env("MOONLET_HOME", home.dir.path())
        .env("MOONLET_SOCK", &home.socket)
        .env("MOONLET_EXIT_WITH", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    moonlet_core::client::wait_for_socket(&home.socket, std::time::Duration::from_secs(15))
        .await
        .unwrap();
    let old = home.info().await.pid;
    signal(old as i32, "STOP");

    let out = home.moonletd(&["restart", "--force"]);

    // Waiting on the zombie would fail the restart after 5 s.
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_ne!(home.info().await.pid, old, "a new daemon answers");
    let _ = parent.wait();
}

#[tokio::test]
async fn force_restart_never_kills_another_homes_moonletd_that_got_a_stale_pid() {
    let home = Home::new();
    let other = Home::new();
    assert!(other.moonletd(&["start"]).status.success());
    let theirs = other.info().await.pid;
    // This home's daemon died an hour ago without cleaning up, and its pid
    // now belongs to the other home's daemon, started since.
    let pid_file = home.socket.with_file_name("moonletd.pid");
    std::fs::create_dir_all(pid_file.parent().unwrap()).unwrap();
    std::fs::write(&pid_file, theirs.to_string()).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&pid_file)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600))
        .unwrap();

    let out = home.moonletd(&["restart", "--force"]);

    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        alive(theirs as i32),
        "the other home's daemon keeps running"
    );
    assert_eq!(other.info().await.pid, theirs);
    assert_ne!(
        home.info().await.pid,
        theirs,
        "this home gets a daemon of its own"
    );
}
