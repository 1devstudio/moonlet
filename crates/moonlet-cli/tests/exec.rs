//! X62 from the agent's side: `moonlet hook claude` rewrites an approved
//! heavy command to `moonlet exec`, and stays silent otherwise.
//! Needs `moonletd` built next to this test binary (`cargo test --workspace`).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use moonlet_core::client::{Client, wait_for_socket};
use serde_json::{Value, json};

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

struct KillOnDrop(std::process::Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
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

/// A daemon with project `shop`, whose heavy command is `pnpm test`, and
/// its session `Fix cart`.
struct Shop {
    _daemon: KillOnDrop,
    home: tempfile::TempDir,
    socket: PathBuf,
    project: String,
    session: String,
    worktree: String,
}

async fn shop() -> Shop {
    let home = tempfile::tempdir().unwrap();
    let socket = home.path().join("run/d.sock");
    // This machine's name, as the first line of a run says it; read when
    // the daemon starts.
    std::fs::write(
        home.path().join("link.json"),
        r#"{ "central": null, "worker": { "id": "0f6c2a9e-9d2b-4f5e-8f1a-2b3c4d5e6f70", "name": "studio-mini", "enabled": false } }"#,
    )
    .unwrap();
    let daemon = KillOnDrop(
        Command::new(target_bin("moonletd"))
            .arg("daemon")
            .env("MOONLET_HOME", home.path())
            .env("MOONLET_SOCK", &socket)
            .env("CLAUDE_CONFIG_DIR", home.path().join("claude"))
            .env(
                "MOONLET_CLAUDE_MANAGED_SETTINGS",
                home.path().join("managed.json"),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_for_socket(&socket, Duration::from_secs(15))
        .await
        .unwrap();
    let repo = home.path().join("src/shop");
    std::fs::create_dir_all(repo.join(".moonlet")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(
        repo.join(".moonlet/config.toml"),
        "[heavy]\ncommands = [\"pnpm test\", \"sh -c\"]\n",
    )
    .unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "shop"]);
    let mut app = Client::connect(&socket, "moonlet-app").await.unwrap();
    let project: Value = app
        .request("project.add", json!({ "path": repo }))
        .await
        .unwrap();
    let session: Value = app
        .request(
            "session.create",
            json!({ "project_id": project["id"], "name": "Fix cart" }),
        )
        .await
        .unwrap();
    Shop {
        _daemon: daemon,
        home,
        socket,
        project: project["id"].as_str().unwrap().into(),
        session: session["id"].as_str().unwrap().into(),
        worktree: session["path"].as_str().unwrap().into(),
    }
}

/// Claude Code's `PreToolUse` payload for `command`, as captured in
/// `src/fixtures/pre_tool_use_bash.json`, run in `cwd`.
fn payload(command: &str, cwd: &str) -> String {
    json!({
        "session_id": "8de3b575-7c1c-4fc1-a497-429c518725f6",
        "cwd": cwd,
        "permission_mode": "default",
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": { "command": command, "timeout": 600000, "description": "Run the tests" },
        "tool_use_id": "toolu_012ftuDv3XBoqpcogRjeHhqb",
    })
    .to_string()
}

fn hook(socket: &Path, session: &str, stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_moonlet"))
        .args(["hook", "claude"])
        .env("MOONLET_SOCK", socket)
        .env("MOONLET_SESSION", session)
        .env_remove("MOONLET_TERMINAL_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn the_hook_outside_moonlet_returns_with_stdin_open() {
    // An agent hook outside any moonlet session never waits for its payload.
    let mut child = Command::new(env!("CARGO_BIN_EXE_moonlet"))
        .args(["hook", "claude"])
        .env_remove("MOONLET_SESSION")
        .env_remove("MOONLET_TERMINAL_ID")
        .env_remove("JAUNT_TERMINAL_ID")
        .env_remove("JAUNT_SESSION_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _stdin = child.stdin.take();
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(3) {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    panic!("the hook waited on its stdin");
}

#[tokio::test]
async fn the_hook_prints_nothing_when_the_daemon_says_no() {
    let s = shop().await;
    // Not approved yet.
    let out = hook(&s.socket, &s.session, &payload("pnpm test", &s.worktree));
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "");

    let mut app = Client::connect(&s.socket, "moonlet-app").await.unwrap();
    let _: Value = app
        .request(
            "heavy.approve",
            json!({ "project": s.project, "commands": ["pnpm test", "sh -c"], "env": [] }),
        )
        .await
        .unwrap();
    // Not a heavy command.
    let out = hook(&s.socket, &s.session, &payload("pnpm lint", &s.worktree));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "");

    // Approved: the call goes through `moonlet exec`.
    let out = hook(&s.socket, &s.session, &payload("pnpm test", &s.worktree));
    let answer: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        answer["hookSpecificOutput"]["updatedInput"],
        json!({
            "command": format!(
                "'{}' exec --tool-use toolu_012ftuDv3XBoqpcogRjeHhqb -- pnpm test",
                env!("CARGO_BIN_EXE_moonlet")
            ),
            "timeout": 600000,
            "description": "Run the tests",
        })
    );
    assert_eq!(
        answer["hookSpecificOutput"]["permissionDecision"],
        json!("allow")
    );
    drop(s.home);
}

#[tokio::test]
async fn the_hook_prints_nothing_when_the_daemon_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    let started = Instant::now();
    let out = hook(
        &dir.path().join("no.sock"),
        "s1",
        &payload("pnpm test", dir.path().to_str().unwrap()),
    );
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "");
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn moonlet_exec_without_routing_runs_the_command_here() {
    let out = Command::new(env!("CARGO_BIN_EXE_moonlet"))
        .args(["exec", "--", "sh", "-c", "echo hi; echo oops >&2; exit 3"])
        .env_remove("MOONLET_SESSION")
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "hi\n");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "oops\n");
    assert_eq!(out.status.code(), Some(3));

    let out = Command::new(env!("CARGO_BIN_EXE_moonlet"))
        .args(["exec", "--", "no-such-command-x62"])
        .env_remove("MOONLET_SESSION")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(127));
    assert!(
        String::from_utf8_lossy(&out.stderr)
            .starts_with("moonlet: cannot run no-such-command-x62: "),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

async fn approved_shop() -> Shop {
    let s = shop().await;
    let mut app = Client::connect(&s.socket, "moonlet-app").await.unwrap();
    let _: Value = app
        .request(
            "heavy.approve",
            json!({ "project": s.project, "commands": ["pnpm test", "sh -c"], "env": [] }),
        )
        .await
        .unwrap();
    s
}

/// `moonlet exec -- <argv>` as an agent of the session runs it.
fn exec_in(s: &Shop, argv: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_moonlet"));
    cmd.arg("exec")
        .arg("--")
        .args(argv)
        .current_dir(&s.worktree)
        .env("MOONLET_SOCK", &s.socket)
        .env("MOONLET_SESSION", &s.session);
    cmd
}

#[tokio::test]
async fn moonlet_exec_in_a_session_runs_through_its_daemon() {
    let s = approved_shop().await;
    let out = exec_in(&s, &["sh", "-c", "echo out; echo err >&2; exit 4"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "out\n");
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "moonlet: running on studio-mini\nerr\n"
    );
    assert_eq!(out.status.code(), Some(4));
    // A command the daemon will not run runs here, as without moonlet.
    let out = exec_in(&s, &["echo", "here"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "here\n");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "");
}

/// Starts `moonlet exec` on a long command and waits until it printed
/// `started`.
fn start_long(
    s: &Shop,
) -> (
    std::process::Child,
    std::io::BufReader<std::process::ChildStdout>,
) {
    use std::io::BufRead;
    let mut child = exec_in(s, &["sh", "-c", "echo started; sleep 30"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    assert_eq!(line, "started\n");
    (child, out)
}

#[tokio::test]
async fn moonlet_exec_stops_the_command_when_it_is_stopped() {
    let s = approved_shop().await;
    let (mut child, _out) = start_long(&s);
    let started = Instant::now();
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(143));
    assert!(started.elapsed() < Duration::from_secs(4));
}

#[tokio::test]
async fn ctrl_c_ends_moonlet_exec_with_130() {
    let s = approved_shop().await;
    let (mut child, _out) = start_long(&s);
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(130));
}

#[tokio::test]
async fn a_stopped_moonlet_exec_exits_143_whatever_the_command_does() {
    use std::io::BufRead;
    let s = approved_shop().await;
    // The command exits 0 on SIGTERM; moonlet exec still says it was stopped.
    let mut child = exec_in(
        &s,
        &[
            "sh",
            "-c",
            "trap 'exit 0' TERM; echo started; sleep 30 & wait",
        ],
    )
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .unwrap();
    let mut out = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    assert_eq!(line, "started\n");
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(143));
}

#[tokio::test]
async fn a_stopped_central_daemon_ends_moonlet_exec_with_125() {
    use std::io::Read;
    let mut s = approved_shop().await;
    let (mut child, _out) = start_long(&s);
    let _ = s._daemon.0.kill();
    let _ = s._daemon.0.wait();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(125));
    let mut err = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut err)
        .unwrap();
    assert!(
        err.ends_with("moonlet: lost studio-mini's daemon during the run\n"),
        "{err}"
    );
}

#[tokio::test]
async fn a_job_knows_its_tool_call() {
    let s = approved_shop().await;
    let out = Command::new(env!("CARGO_BIN_EXE_moonlet"))
        .args([
            "exec",
            "--tool-use",
            "toolu_01Abc",
            "--",
            "sh",
            "-c",
            "echo hi",
        ])
        .current_dir(&s.worktree)
        .env("MOONLET_SOCK", &s.socket)
        .env("MOONLET_SESSION", &s.session)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "hi\n");
    let mut app = Client::connect(&s.socket, "moonlet-app").await.unwrap();
    let jobs: Value = app
        .request("job.list", json!({ "session": s.session }))
        .await
        .unwrap();
    assert_eq!(jobs[0]["tool_use_id"], json!("toolu_01Abc"));
    assert_eq!(jobs[0]["command"], json!("sh -c 'echo hi'"));
}
