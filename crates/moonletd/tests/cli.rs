//! X57: `moonletd tailnet on|off|status` and `moonletd pair`, run as a user
//! would on a host without the app, against a test daemon that listens on
//! 127.0.0.1 (`MOONLET_MOBILE_ADDRS`) instead of a Tailscale address.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, Output, Stdio};
use std::time::Duration;

use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::methods::MobileStatus;
use moonlet_proto::{Frame, Message, read_frame, write_frame};
use serde_json::json;
use tokio::net::TcpStream;

struct Host {
    home: tempfile::TempDir,
    socket: PathBuf,
    child: Child,
}

impl Host {
    /// A daemon with tailnet access `enabled` on an ephemeral port, and
    /// `addrs` as its Tailscale addresses.
    async fn start(enabled: bool, addrs: &str) -> Host {
        Host::launch(enabled, addrs, true).await
    }

    /// A daemon that, unless `ssh`, takes `moonletd pair` and `tailnet`
    /// run by this test for what they are: not started at a login.
    async fn launch(enabled: bool, addrs: &str, ssh: bool) -> Host {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("mobile.json"),
            json!({ "enabled": enabled, "port": 0 }).to_string(),
        )
        .unwrap();
        let socket = home.path().join("run").join("d.sock");
        let mut daemon = Command::new(env!("CARGO_BIN_EXE_moonletd"));
        daemon.env_remove("MOONLET_TEST_SSHD_EXE");
        if ssh {
            // `moonletd pair` and `tailnet`, run by this test, count as
            // typed in an SSH login (X75).
            daemon.env("MOONLET_TEST_SSHD_EXE", std::env::current_exe().unwrap());
        }
        let child = daemon
            .arg("daemon")
            .env("MOONLET_TEST_APP_EXE", std::env::current_exe().unwrap())
            .env("MOONLET_HOME", home.path())
            .env("MOONLET_SOCK", &socket)
            .env("MOONLET_MOBILE_ADDRS", addrs)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        wait_for_socket(&socket, Duration::from_secs(15))
            .await
            .unwrap();
        Host {
            home,
            socket,
            child,
        }
    }

    /// `moonletd <args>` against this daemon.
    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_moonletd"));
        c.args(args)
            .env("MOONLET_HOME", self.home.path())
            .env("MOONLET_SOCK", &self.socket);
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().unwrap()
    }

    /// `moonletd <args>` below 4 shells of the user's, so none of its
    /// nearest 4 ancestors starts a login, even when this test runs in one.
    fn run_in_a_plain_terminal(&self, args: &[&str]) -> Output {
        let mut c = Command::new("/bin/sh");
        for _ in 0..3 {
            c.args(["-c", "\"$@\"; exit $?", "sh", "/bin/sh"]);
        }
        c.args(["-c", "\"$@\"; exit $?", "sh", env!("CARGO_BIN_EXE_moonletd")]);
        c.args(args)
            .env("MOONLET_HOME", self.home.path())
            .env("MOONLET_SOCK", &self.socket)
            .output()
            .unwrap()
    }

    async fn app(&self) -> Client {
        Client::connect_app(&self.socket, self.home.path()).await.unwrap()
    }

    async fn listening(&self) -> String {
        let mut app = self.app().await;
        for _ in 0..100 {
            let st: MobileStatus = app.request("mobile.status", json!({})).await.unwrap();
            if let Some(a) = st.listening.first() {
                return a.clone();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the daemon never listened");
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn text(out: &[u8]) -> String {
    String::from_utf8_lossy(out).into_owned()
}

#[tokio::test]
async fn tailnet_on_off_and_status_say_where_it_listens() {
    let host = Host::start(false, "127.0.0.1").await;
    let out = host.run(&["tailnet", "status"]);
    assert!(out.status.success());
    assert_eq!(text(&out.stdout), "Tailnet access is off\n");

    let out = host.run(&["tailnet", "on"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    let addr = host.listening().await;
    assert_eq!(text(&out.stdout), format!("Listening on {addr}\n"));

    let out = host.run(&["tailnet", "off"]);
    assert!(out.status.success());
    assert_eq!(text(&out.stdout), "Tailnet access is off\n");
}

/// What `moonletd pair` printed, read up to and including the link.
fn read_pairing(stdout: &mut BufReader<ChildStdout>) -> (Vec<String>, String) {
    let mut lines = Vec::new();
    loop {
        let mut line = String::new();
        if stdout.read_line(&mut line).unwrap() == 0 {
            break;
        }
        let line = line.trim_end().to_string();
        let done = line.starts_with("moonlet://pair?");
        lines.push(line);
        if done {
            break;
        }
    }
    let link = lines.last().cloned().unwrap_or_default();
    (lines, link)
}

fn code_in(link: &str) -> String {
    link.split("&code=").nth(1).unwrap_or_default().to_string()
}

#[tokio::test]
async fn pair_prints_the_code_and_link_and_says_who_paired() {
    let host = Host::start(true, "127.0.0.1").await;
    let addr = host.listening().await;
    let mut pair = host
        .cmd(&["pair"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(pair.stdout.take().unwrap());
    let (lines, link) = read_pairing(&mut stdout);
    assert!(link.starts_with("moonlet://pair?v=1&"), "{lines:?}");
    let code = code_in(&link);
    assert_eq!(code.len(), 10, "{link}");
    let shown = format!("Code: {}-{}", &code[..5], &code[5..]);
    assert!(lines.iter().any(|l| l.trim() == shown), "{lines:?}");
    assert!(
        lines.iter().any(|l| l.trim() == "Expires in 5:00"),
        "{lines:?}"
    );

    let mut s = TcpStream::connect(&addr).await.unwrap();
    let auth: Message = serde_json::from_value(
        json!({ "t": "auth", "pair": code, "device": "Test Mac", "kind": "desktop" }),
    )
    .unwrap();
    write_frame(&mut s, &Frame::Json(auth)).await.unwrap();
    assert!(matches!(
        read_frame(&mut s).await.unwrap(),
        Some(Frame::Json(Message::Authed { .. }))
    ));

    let mut rest = String::new();
    stdout.read_to_string(&mut rest).unwrap();
    let out = pair.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    assert_eq!(rest.trim(), "Paired with Test Mac");
}

#[tokio::test]
async fn pair_shows_the_name_it_is_given() {
    let host = Host::start(true, "127.0.0.1").await;
    host.listening().await;
    let mut pair = host
        .cmd(&["pair", "--name", "build-box"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let (lines, _) = read_pairing(&mut BufReader::new(pair.stdout.take().unwrap()));
    assert!(
        lines.iter().any(|l| l.trim() == "Name: build-box"),
        "{lines:?}"
    );
    let _ = pair.kill();
    let _ = pair.wait();
}

#[tokio::test]
async fn pair_needs_tailnet_access_and_tailscale() {
    let host = Host::start(false, "127.0.0.1").await;
    let out = host.run(&["pair"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        text(&out.stderr),
        "Tailnet access is off. Run `moonletd tailnet on` first.\n"
    );

    let host = Host::start(true, "").await;
    let out = host.run(&["pair"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        text(&out.stderr),
        "Tailscale is not running on this machine.\n"
    );
}

#[tokio::test]
async fn tailnet_and_pair_from_a_plain_terminal_say_where_to_run_them() {
    let host = Host::launch(true, "127.0.0.1", false).await;
    let only =
        "Only the moonlet app, or you over SSH or at the console, manages tailnet access and pairing.";
    for (args, command) in [
        (&["tailnet", "on"][..], "tailnet on"),
        (&["tailnet", "off"][..], "tailnet off"),
        (&["pair"][..], "pair"),
    ] {
        let out = host.run_in_a_plain_terminal(args);
        assert_eq!(out.status.code(), Some(1), "{command}");
        assert_eq!(text(&out.stdout), "", "{command}");
        let hint = if cfg!(target_os = "linux") {
            format!(
                "{only}\nFrom this terminal, run: sudo runuser -u \"$(id -un)\" -- ~/.moonlet/bin/moonletd {command}\n"
            )
        } else {
            format!("{only}\n")
        };
        assert_eq!(text(&out.stderr), hint, "{command}");
    }
    // Still on: the refused `tailnet off` changed nothing.
    host.listening().await;
}

#[tokio::test]
async fn ctrl_c_cancels_the_pairing() {
    let host = Host::start(true, "127.0.0.1").await;
    host.listening().await;
    let mut app = host.app().await;
    let mut pair = host.cmd(&["pair"]).stdout(Stdio::piped()).spawn().unwrap();
    read_pairing(&mut BufReader::new(pair.stdout.take().unwrap()));
    unsafe {
        libc::kill(pair.id() as i32, libc::SIGINT);
    }
    let reason = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(Frame::Json(Message::Event { name, data })) =
                app.next_frame().await.unwrap()
                && name == "mobile.pair_ended"
            {
                return data["reason"].clone();
            }
        }
    })
    .await
    .expect("no pair_ended");
    assert_eq!(reason, "cancelled");
    assert_eq!(pair.wait().unwrap().code(), Some(1));
}
