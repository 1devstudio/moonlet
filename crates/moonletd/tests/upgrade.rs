//! S3: a new daemon binary takes over live sessions without killing them.

mod common;
use common::logs::KeepLogs;

use std::path::PathBuf;
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

fn moonletd(home: &std::path::Path, socket: &PathBuf, args: &[&str]) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_moonletd"));
    c.args(args)
        .env("MOONLET_HOME", home)
        .env("MOONLET_EXIT_WITH", std::process::id().to_string())
        .env("MOONLET_SOCK", socket)
        // The test attaches as the app (X75, A6).
        .env("MOONLET_TEST_APP_EXE", std::env::current_exe().unwrap())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .keep_logs(home);
    c
}

async fn output_until(c: &mut Client, needle: &str) {
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
}

#[tokio::test]
async fn upgrade_keeps_sessions_alive() {
    let home = tempfile::tempdir().unwrap();
    let socket = home.path().join("run/d.sock");
    let _old = Kill(moonletd(home.path(), &socket, &["daemon"]).spawn().unwrap());
    wait_for_socket(&socket, Duration::from_secs(15))
        .await
        .unwrap();

    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    let before: DaemonInfo = c.request(methods::DAEMON_INFO, ()).await.unwrap();
    let s: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            TerminalCreate {
                cwd: home.path().display().to_string(),
                command: vec!["/bin/sh".into()],
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
        data: b"echo before-$((6*7))\n".to_vec(),
    })
    .await
    .unwrap();
    output_until(&mut c, "before-42").await;
    drop(c);

    let status = moonletd(home.path(), &socket, &["upgrade"])
        .status()
        .unwrap();
    assert!(status.success(), "moonletd upgrade failed");

    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    let after: DaemonInfo = c.request(methods::DAEMON_INFO, ()).await.unwrap();
    assert_ne!(after.pid, before.pid, "a new daemon process serves");
    let list: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    let same = list
        .iter()
        .find(|x| x.id == s.id)
        .expect("same session id after upgrade");
    assert_eq!(same.pid, s.pid, "same shell process");
    assert!(same.exit.is_none());
    let attach: AttachResult = c
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
        attach.snapshot.contains("before-42"),
        "screen survives the upgrade"
    );
    c.send(&Frame::Input {
        terminal: s.id,
        data: b"echo after-$((1+2))\n".to_vec(),
    })
    .await
    .unwrap();
    output_until(&mut c, "after-3").await;

    // Clean up the adopted daemon (not our child).
    let _: bool = c.request(methods::DAEMON_SHUTDOWN, ()).await.unwrap();
    let _ = nix_kill(after.pid);
}

fn nix_kill(pid: u32) -> std::io::Result<()> {
    std::thread::sleep(Duration::from_millis(300));
    let _ = Command::new("kill").arg(pid.to_string()).status();
    Ok(())
}

/// X27: `moonletd start` finds a jaunt daemon on `run/jauntd.sock` and takes
/// over its terminals instead of starting an empty daemon next to it.
#[tokio::test]
async fn start_takes_over_a_jaunt_daemon() {
    let home = tempfile::tempdir().unwrap();
    let legacy = home.path().join("run/jauntd.sock");
    let socket = home.path().join("run/moonletd.sock");
    let plain = |args: &[&str]| {
        let mut c = Command::new(env!("CARGO_BIN_EXE_moonletd"));
        c.args(args)
            .env("MOONLET_HOME", home.path())
            .env("MOONLET_EXIT_WITH", std::process::id().to_string())
            .env_remove("MOONLET_SOCK")
            .env_remove("JAUNT_HOME")
            .env("MOONLET_TEST_APP_EXE", std::env::current_exe().unwrap())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .keep_logs(home.path());
        c
    };
    // jaunt's daemon listens on run/jauntd.sock and has JAUNT_SOCK in its
    // environment, which the daemon it hands over to inherits.
    let mut old = plain(&["--socket", legacy.to_str().unwrap(), "daemon"]);
    old.env("JAUNT_SOCK", &legacy);
    let mut old = Kill(old.spawn().unwrap());
    wait_for_socket(&legacy, Duration::from_secs(15))
        .await
        .unwrap();

    let mut c = Client::connect_app(&legacy, home.path()).await.unwrap();
    let s: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            TerminalCreate {
                cwd: home.path().display().to_string(),
                command: vec!["/bin/sh".into()],
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
        data: b"echo before-$((6*7))\n".to_vec(),
    })
    .await
    .unwrap();
    output_until(&mut c, "before-42").await;
    drop(c);

    let status = plain(&["start"]).status().unwrap();
    assert!(status.success(), "moonletd start failed");

    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    let after: DaemonInfo = c.request(methods::DAEMON_INFO, ()).await.unwrap();
    let list: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    let same = list
        .iter()
        .find(|x| x.id == s.id)
        .expect("jaunt's terminal is here");
    assert_eq!(same.pid, s.pid, "same shell process");
    let attach: AttachResult = c
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
        attach.snapshot.contains("before-42"),
        "screen survives the takeover"
    );

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while old.0.try_wait().unwrap().is_none() {
        assert!(
            std::time::Instant::now() < deadline,
            "jaunt's daemon is still running"
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    // Hooks and CLI calls from jaunt's binary still dial run/jauntd.sock.
    let mut via_old = Client::connect_app(&legacy, home.path()).await.unwrap();
    let info: DaemonInfo = via_old.request(methods::DAEMON_INFO, ()).await.unwrap();
    assert_eq!(info.pid, after.pid);

    let _: bool = c.request(methods::DAEMON_SHUTDOWN, ()).await.unwrap();
    let _ = nix_kill(after.pid);
}

/// X79: a job an exited shell left running is not handed over (only running
/// terminals are), yet stays recorded by the new daemon, so a crash of that
/// one still leaves it to the next daemon to end.
#[tokio::test]
async fn after_an_upgrade_a_crash_still_ends_what_an_exited_shell_left() {
    let home = tempfile::tempdir().unwrap();
    let socket = home.path().join("run/d.sock");
    let _old = Kill(moonletd(home.path(), &socket, &["daemon"]).spawn().unwrap());
    wait_for_socket(&socket, Duration::from_secs(15)).await.unwrap();
    let job_file = home.path().join("job.pid");
    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    let _: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            TerminalCreate {
                cwd: home.path().display().to_string(),
                command: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    format!("set -m; (trap '' HUP; exec sleep 60) </dev/null >/dev/null 2>&1 & echo $! > '{}'", job_file.display()),
                ],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let mut job = None;
    for _ in 0..100 {
        job = std::fs::read_to_string(&job_file).ok().and_then(|s| s.trim().parse::<i32>().ok());
        if job.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let job = nix::unistd::Pid::from_raw(job.expect("the shell never started its job"));
    drop(c);
    // Time for the old daemon to record the shell's session.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(moonletd(home.path(), &socket, &["upgrade"]).status().unwrap().success(), "moonletd upgrade failed");
    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    let new: DaemonInfo = c.request(methods::DAEMON_INFO, ()).await.unwrap();
    drop(c);
    // Time for the new daemon to write its own record, then it crashes.
    tokio::time::sleep(Duration::from_millis(4500)).await;
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(new.pid as i32), nix::sys::signal::Signal::SIGKILL).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = std::fs::remove_file(&socket);
    assert!(nix::sys::signal::kill(job, None).is_ok(), "the crash itself ended the job");
    let _next = Kill(moonletd(home.path(), &socket, &["daemon"]).spawn().unwrap());
    wait_for_socket(&socket, Duration::from_secs(15)).await.unwrap();
    let mut gone = false;
    for _ in 0..80 {
        if nix::sys::signal::kill(job, None).is_err() {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !gone {
        let _ = nix::sys::signal::kill(job, nix::sys::signal::Signal::SIGKILL);
    }
    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    let _: bool = c.request(methods::DAEMON_SHUTDOWN, ()).await.unwrap();
    assert!(gone, "the exited shell's job outlived the upgraded daemon's crash");
}

/// Reads one systemd notification from the socket a test plays systemd on.
fn next_notification(sock: &std::os::unix::net::UnixDatagram) -> String {
    let mut buf = [0u8; 512];
    let n = sock.recv(&mut buf).expect("no notification in time");
    String::from_utf8_lossy(&buf[..n]).into_owned()
}

#[tokio::test]
async fn systemd_hears_ready_and_follows_the_upgrade() {
    let home = tempfile::tempdir().unwrap();
    let socket = home.path().join("run/d.sock");
    let notify_path = home.path().join("notify.sock");
    let systemd = std::os::unix::net::UnixDatagram::bind(&notify_path).unwrap();
    systemd
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();

    let _old = Kill(
        moonletd(home.path(), &socket, &["daemon"])
            .env("NOTIFY_SOCKET", &notify_path)
            .spawn()
            .unwrap(),
    );
    assert_eq!(next_notification(&systemd), "READY=1");
    wait_for_socket(&socket, Duration::from_secs(15))
        .await
        .unwrap();

    let status = moonletd(home.path(), &socket, &["upgrade"])
        .status()
        .unwrap();
    assert!(status.success(), "moonletd upgrade failed");
    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    let after: DaemonInfo = c.request(methods::DAEMON_INFO, ()).await.unwrap();
    // The new daemon names itself before it answers the handoff.
    assert_eq!(
        next_notification(&systemd),
        format!("MAINPID={}\nREADY=1", after.pid)
    );

    let _: bool = c.request(methods::DAEMON_SHUTDOWN, ()).await.unwrap();
    let _ = nix_kill(after.pid);
}

/// X73 across S3: an agent tab in the middle of a turn keeps the Mac from
/// idle sleep through a live upgrade, held by the new daemon once the old
/// one let go, and the hold ends when that daemon stops. What the Mac
/// would do with its power assertion is written down, by both daemons in
/// turn, rather than done: a test never keeps this machine awake.
#[tokio::test]
async fn an_agent_at_work_keeps_the_mac_awake_across_an_upgrade_until_the_daemon_stops() {
    use moonlet_proto::types::{AgentState, TerminalKind};
    let home = tempfile::tempdir().unwrap();
    let socket = home.path().join("run/d.sock");
    let awake = home.path().join("awake");
    let read = || std::fs::read_to_string(&awake).unwrap_or_default();
    let until = async |holds: usize, releases: usize| {
        let counts = || {
            let log = read();
            (log.lines().filter(|l| *l == "hold").count(), log.lines().filter(|l| *l == "release").count())
        };
        for _ in 0..100 {
            if counts() == (holds, releases) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(counts(), (holds, releases), "{}", read());
    };
    let _old = Kill(moonletd(home.path(), &socket, &["daemon"]).env("MOONLET_TEST_AWAKE_LOG", &awake).spawn().unwrap());
    wait_for_socket(&socket, Duration::from_secs(15)).await.unwrap();
    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    let tab: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            TerminalCreate {
                cwd: home.path().display().to_string(),
                command: vec!["/bin/sh".into()],
                kind: TerminalKind::Agent,
                agent: Some("claude".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let report = |state: AgentState| methods::AgentReport { terminal: tab.id, state, message: None, source: moonlet_proto::types::StateSource::Hook, agent: Some("claude".into()) };
    let _: bool = c.request(methods::AGENT_REPORT, report(AgentState::Working)).await.unwrap();
    until(1, 0).await;
    assert_eq!(read(), "hold\n");
    drop(c);

    let status = moonletd(home.path(), &socket, &["upgrade"]).env("MOONLET_TEST_AWAKE_LOG", &awake).status().unwrap();
    assert!(status.success(), "moonletd upgrade failed");
    // The old daemon let go as it handed over; the new one holds.
    until(2, 1).await;
    let mut c = Client::connect_app(&socket, home.path()).await.unwrap();
    let after: DaemonInfo = c.request(methods::DAEMON_INFO, ()).await.unwrap();
    let list: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await.unwrap();
    assert_eq!(list.iter().find(|t| t.id == tab.id).map(|t| t.agent_state), Some(AgentState::Working));

    // The daemon stops: let go.
    let _: bool = c.request(methods::DAEMON_SHUTDOWN, ()).await.unwrap();
    until(2, 2).await;
    let _ = nix_kill(after.pid);
}
