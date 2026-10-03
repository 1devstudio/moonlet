//! S3: a new daemon binary takes over live sessions without killing them.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use jaunt_core::client::{Client, wait_for_socket};
use jaunt_proto::Frame;
use jaunt_proto::methods::{self, AttachResult, TerminalAttach, TerminalCreate};
use jaunt_proto::types::{DaemonInfo, TerminalInfo};

struct Kill(Child);
impl Drop for Kill {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn jauntd(home: &std::path::Path, socket: &PathBuf, args: &[&str]) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_jauntd"));
    c.args(args)
        .env("JAUNT_HOME", home)
        .env("JAUNT_SOCK", socket)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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
    let _old = Kill(jauntd(home.path(), &socket, &["daemon"]).spawn().unwrap());
    wait_for_socket(&socket, Duration::from_secs(15))
        .await
        .unwrap();

    let mut c = Client::connect(&socket, "test").await.unwrap();
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

    let status = jauntd(home.path(), &socket, &["upgrade"]).status().unwrap();
    assert!(status.success(), "jauntd upgrade failed");

    let mut c = Client::connect(&socket, "test").await.unwrap();
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
