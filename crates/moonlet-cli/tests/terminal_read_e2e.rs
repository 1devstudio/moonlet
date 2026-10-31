//! `moonlet term ls` and `moonlet term read` against a real daemon (X31):
//! an agent reads a terminal of its own session once the user allows it.
//! Needs `moonletd` built next to this test binary (`cargo test --workspace`).

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::Duration;

use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::methods;
use moonlet_proto::types::{Project, Session, TerminalInfo};
use serde_json::{Value, json};

fn target_bin(name: &str) -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let p = exe.parent().unwrap().parent().unwrap().join(name);
    assert!(p.exists(), "{} missing: run `cargo test --workspace`", p.display());
    p
}

struct Daemon {
    home: tempfile::TempDir,
    socket: PathBuf,
    child: Child,
}

impl Daemon {
    async fn start(env: &[(&str, &str)]) -> Daemon {
        Self::start_in(tempfile::tempdir().unwrap(), env).await
    }

    /// A daemon whose terminals run zsh with moonlet's shell integration,
    /// and none of the user's startup files.
    async fn with_zsh() -> Daemon {
        let home = tempfile::tempdir().unwrap();
        let h = home.path().display().to_string();
        Self::start_in(home, &[("HOME", h.as_str()), ("SHELL", "/bin/zsh")]).await
    }

    async fn start_in(home: tempfile::TempDir, env: &[(&str, &str)]) -> Daemon {
        let socket = home.path().join("run/d.sock");
        let child = Command::new(target_bin("moonletd"))
            .arg("daemon")
            .env("MOONLET_HOME", home.path())
            .env("MOONLET_SOCK", &socket)
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        wait_for_socket(&socket, Duration::from_secs(15)).await.unwrap();
        Daemon { home, socket, child }
    }

    async fn client(&self) -> Client {
        Client::connect_app(&self.socket, self.home.path()).await.unwrap()
    }

    fn command(&self, terminal: Option<u32>, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_moonlet"));
        cmd.args(args)
            .env("MOONLET_HOME", self.home.path())
            .env("MOONLET_SOCK", &self.socket)
            .env_remove("MOONLET_TERMINAL_ID")
            .env_remove("JAUNT_TERMINAL_ID")
            .env_remove("JAUNT_SESSION_ID")
            .stdin(Stdio::null());
        if let Some(t) = terminal {
            cmd.env("MOONLET_TERMINAL_ID", t.to_string());
        }
        cmd
    }

    /// Runs `moonlet` as an agent in `terminal` would, and waits for it.
    fn moonlet(&self, terminal: Option<u32>, args: &[&str]) -> Output {
        self.command(terminal, args).output().unwrap()
    }

    /// Starts `moonlet` without waiting: `term read` waits for the user.
    fn spawn(&self, terminal: u32, args: &[&str]) -> Child {
        self.command(Some(terminal), args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }

    /// A project with one session ("Fix login"); the session's shell
    /// stands in for the agent that reads.
    async fn session(&self, c: &mut Client, name: &str) -> Session {
        let repo = self.home.path().join("code").join(name.replace(' ', "-"));
        git_repo(&repo);
        let p: Project = c.request(methods::PROJECT_ADD, json!({ "path": repo })).await.unwrap();
        c.request(
            methods::SESSION_CREATE,
            json!({ "project_id": p.id, "name": name, "agent": "none" }),
        )
        .await
        .unwrap()
    }

    /// A terminal in `session` that runs `script` with `/bin/sh`, and once
    /// it printed `ready`.
    async fn terminal(&self, c: &mut Client, session: &Session, script: &str, ready: &str) -> TerminalInfo {
        let t: TerminalInfo = c
            .request(
                methods::TERMINAL_CREATE,
                json!({
                    "cwd": session.path,
                    "session_id": session.id,
                    "command": ["/bin/sh", "-c", script],
                    "title": "tests",
                }),
            )
            .await
            .unwrap();
        wait_for_text(c, t.id, ready).await;
        t
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn git_repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"],
    ] {
        assert!(Command::new("git").args(args).current_dir(dir).status().unwrap().success());
    }
}

async fn wait_for_text(c: &mut Client, id: u32, text: &str) {
    for _ in 0..200 {
        let hits: Value = c
            .request(methods::TERMINAL_SEARCH, json!({ "id": id, "query": text }))
            .await
            .unwrap();
        if hits.as_array().is_some_and(|h| !h.is_empty()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("terminal {id} never printed {text:?}");
}

/// The read requests waiting for the user, once there are `n`.
async fn requests(c: &mut Client, n: usize) -> Vec<Value> {
    for _ in 0..200 {
        let list: Vec<Value> = c.request("terminal.read_requests", json!({})).await.unwrap();
        if list.len() >= n {
            return list;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("no read request arrived");
}

fn finished(child: Child) -> (bool, String, String) {
    let out = child.wait_with_output().unwrap();
    (
        out.status.success(),
        String::from_utf8(out.stdout).unwrap(),
        String::from_utf8(out.stderr).unwrap(),
    )
}

const THREE_LINES: &str = "printf 'one\\ntwo\\nthree\\n'; exec sleep 600";

#[tokio::test]
async fn the_agent_gets_the_output_once_the_user_allows() {
    let d = Daemon::start(&[]).await;
    let mut c = d.client().await;
    let s = d.session(&mut c, "Fix login").await;
    let t = d.terminal(&mut c, &s, THREE_LINES, "three").await;

    let reader = d.spawn(s.terminals[0], &["term", "read", &t.id.to_string()]);
    let list = requests(&mut c, 1).await;
    let req = &list[0];
    assert_eq!(req["session_id"], json!(s.id));
    assert_eq!(req["caller"], json!(s.terminals[0]));
    assert_eq!(req["terminal_id"], json!(t.id));
    assert_eq!(req["title"], json!("tests"));
    assert_eq!(req["lines"], json!(3));
    assert_eq!(req["text"], json!("one\ntwo\nthree"));

    let _: Value = c
        .request(
            "terminal.read_answer",
            json!({ "request_id": req["request_id"], "allow": true, "remember": false }),
        )
        .await
        .unwrap();
    assert_eq!(finished(reader), (true, "one\ntwo\nthree\n".to_string(), String::new()));
    let list: Vec<Value> = c.request("terminal.read_requests", json!({})).await.unwrap();
    assert!(list.is_empty(), "answered requests are gone: {list:?}");
}

#[tokio::test]
async fn a_declined_read_tells_the_agent_so() {
    let d = Daemon::start(&[]).await;
    let mut c = d.client().await;
    let s = d.session(&mut c, "Fix login").await;
    let t = d.terminal(&mut c, &s, THREE_LINES, "three").await;

    let reader = d.spawn(s.terminals[0], &["term", "read", &t.id.to_string()]);
    let req = requests(&mut c, 1).await.remove(0);
    let _: Value = c
        .request(
            "terminal.read_answer",
            json!({ "request_id": req["request_id"], "allow": false, "remember": false }),
        )
        .await
        .unwrap();
    assert_eq!(
        finished(reader),
        (false, String::new(), format!("moonlet: the user declined to share terminal {}\n", t.id))
    );
    let again = c
        .request::<_, Value>(
            "terminal.read_answer",
            json!({ "request_id": req["request_id"], "allow": true, "remember": false }),
        )
        .await;
    assert!(again.unwrap_err().to_string().contains("already answered"));
}

#[tokio::test]
async fn the_agent_gets_the_text_the_user_saw() {
    let d = Daemon::start(&[]).await;
    let mut c = d.client().await;
    let s = d.session(&mut c, "Fix login").await;
    let t = d
        .terminal(&mut c, &s, "echo one; read x; echo \"later $x\"; exec sleep 600", "one")
        .await;

    let reader = d.spawn(s.terminals[0], &["term", "read", &t.id.to_string()]);
    let req = requests(&mut c, 1).await.remove(0);
    let _: Value = c
        .request(methods::TERMINAL_WRITE, json!({ "id": t.id, "data": "secret\r" }))
        .await
        .unwrap();
    wait_for_text(&mut c, t.id, "later secret").await;
    let _: Value = c
        .request(
            "terminal.read_answer",
            json!({ "request_id": req["request_id"], "allow": true, "remember": false }),
        )
        .await
        .unwrap();
    let (ok, out, _) = finished(reader);
    assert!(ok);
    assert!(!out.contains("later"), "output printed after the request leaked: {out:?}");
}

#[tokio::test]
async fn only_terminals_of_the_callers_session_can_be_read() {
    let d = Daemon::start(&[]).await;
    let mut c = d.client().await;
    let mine = d.session(&mut c, "Fix login").await;
    let other = d.session(&mut c, "Billing").await;
    let theirs = d.terminal(&mut c, &other, THREE_LINES, "three").await;
    let loose: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            json!({ "cwd": d.home.path(), "command": ["/bin/sh", "-c", "exec sleep 600"] }),
        )
        .await
        .unwrap();

    // An agent's own terminal in the same session is not readable either.
    let agent: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            json!({ "cwd": mine.path, "session_id": mine.id, "kind": "agent", "agent": "claude",
                    "command": ["/bin/sh", "-c", "exec sleep 600"] }),
        )
        .await
        .unwrap();
    for id in [theirs.id, agent.id, 999] {
        let out = d.moonlet(Some(mine.terminals[0]), &["term", "read", &id.to_string()]);
        assert!(!out.status.success());
        assert_eq!(
            String::from_utf8_lossy(&out.stderr),
            format!("moonlet: no terminal {id} in this session\n")
        );
    }
    let out = d.moonlet(Some(loose.id), &["term", "read", &theirs.id.to_string()]);
    assert_eq!(String::from_utf8_lossy(&out.stderr), "moonlet: this terminal is not in a session\n");
    let out = d.moonlet(None, &["term", "read", &theirs.id.to_string()]);
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "moonlet: term read runs inside a moonlet terminal or agent\n"
    );
    let list: Vec<Value> = c.request("terminal.read_requests", json!({})).await.unwrap();
    assert!(list.is_empty(), "refused reads ask nothing: {list:?}");
}

#[tokio::test]
async fn term_ls_lists_the_sessions_terminals_without_their_output() {
    let d = Daemon::start(&[]).await;
    let mut c = d.client().await;
    let mine = d.session(&mut c, "Fix login").await;
    let other = d.session(&mut c, "Billing").await;
    let t = d.terminal(&mut c, &mine, THREE_LINES, "three").await;
    d.terminal(&mut c, &other, THREE_LINES, "three").await;
    let done: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            json!({ "cwd": mine.path, "session_id": mine.id, "command": ["/bin/sh", "-c", "exit 3"], "title": "build" }),
        )
        .await
        .unwrap();
    for _ in 0..200 {
        let list: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, json!({})).await.unwrap();
        if list.iter().any(|i| i.id == done.id && i.exit.is_some()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let out = d.moonlet(Some(mine.terminals[0]), &["term", "ls"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let last = |i: &TerminalInfo| i.last_exit.map_or(String::new(), |e| format!("exit {e}"));
    let shell = mine.terminals[0];
    let shell_info: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, json!({})).await.unwrap();
    // The session's own shell depends on the user's shell: take its title,
    // prompt state and reported directory as they are.
    let sh = shell_info.iter().find(|i| i.id == shell).unwrap();
    let shell_title = &sh.title;
    let shell_cwd = sh.reported_cwd.as_deref().unwrap_or(&sh.cwd);
    let shell_status = match sh.prompt {
        Some(true) => "at prompt",
        _ => "running",
    };
    let shell_last = last(sh);
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        format!(
            "  ID  KIND     STATUS      LAST     TITLE                    CWD\n\
             {shell:>4}  shell    {shell_status:<11} {shell_last:<8} {shell_title:<24} {shell_cwd}\n\
             {:>4}  shell    running              tests                    {path}\n\
             {:>4}  shell    exited 3             build                    {path}\n",
            t.id,
            done.id,
            path = mine.path,
        )
    );
}

#[tokio::test]
async fn allowing_for_the_session_skips_later_questions_until_cleared() {
    let d = Daemon::start(&[]).await;
    let mut c = d.client().await;
    let s = d.session(&mut c, "Fix login").await;
    let t = d.terminal(&mut c, &s, THREE_LINES, "three").await;
    let id = t.id.to_string();

    let reader = d.spawn(s.terminals[0], &["term", "read", &id]);
    let req = requests(&mut c, 1).await.remove(0);
    let _: Value = c
        .request(
            "terminal.read_answer",
            json!({ "request_id": req["request_id"], "allow": true, "remember": true }),
        )
        .await
        .unwrap();
    assert!(finished(reader).0);
    let grants: Vec<String> = c.request("terminal.read_grants", json!({})).await.unwrap();
    assert_eq!(grants, vec![s.id.clone()]);

    let out = d.moonlet(Some(s.terminals[0]), &["term", "read", &id, "--lines", "2"]);
    assert_eq!(String::from_utf8_lossy(&out.stdout), "two\nthree\n");

    let _: Value = c
        .request("terminal.read_grant_clear", json!({ "session_id": s.id }))
        .await
        .unwrap();
    let reader = d.spawn(s.terminals[0], &["term", "read", &id]);
    let req = requests(&mut c, 1).await.remove(0);
    let _: Value = c
        .request(
            "terminal.read_answer",
            json!({ "request_id": req["request_id"], "allow": true, "remember": true }),
        )
        .await
        .unwrap();
    assert!(finished(reader).0);

    let _: Value = c
        .request(methods::SESSION_ARCHIVE, json!({ "id": s.id }))
        .await
        .unwrap();
    let grants: Vec<String> = c.request("terminal.read_grants", json!({})).await.unwrap();
    assert!(grants.is_empty(), "archiving clears the grant: {grants:?}");
}

#[tokio::test]
async fn an_unanswered_read_times_out() {
    let d = Daemon::start(&[("MOONLET_TERMINAL_READ_TIMEOUT_MS", "300")]).await;
    let mut c = d.client().await;
    let s = d.session(&mut c, "Fix login").await;
    let t = d.terminal(&mut c, &s, THREE_LINES, "three").await;

    let out = d.moonlet(Some(s.terminals[0]), &["term", "read", &t.id.to_string()]);
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "moonlet: the user did not answer; ask them to share the output\n"
    );
    let list: Vec<Value> = c.request("terminal.read_requests", json!({})).await.unwrap();
    assert!(list.is_empty());
}

#[tokio::test]
async fn closing_the_terminal_withdraws_the_request() {
    let d = Daemon::start(&[]).await;
    let mut c = d.client().await;
    let s = d.session(&mut c, "Fix login").await;
    let t = d.terminal(&mut c, &s, THREE_LINES, "three").await;

    let reader = d.spawn(s.terminals[0], &["term", "read", &t.id.to_string()]);
    requests(&mut c, 1).await;
    let _: Value = c
        .request(methods::TERMINAL_KILL, json!({ "id": t.id, "remove": true }))
        .await
        .unwrap();
    assert_eq!(
        finished(reader),
        (false, String::new(), format!("moonlet: terminal {} closed\n", t.id))
    );
}

/// The agent waiting for an answer cannot give it, nor see the waiting text,
/// through `moonlet rpc`: only the app answers.
#[tokio::test]
async fn the_agent_cannot_answer_or_peek_through_moonlet_rpc() {
    let d = Daemon::start(&[]).await;
    let mut c = d.client().await;
    let s = d.session(&mut c, "Fix login").await;
    let t = d.terminal(&mut c, &s, THREE_LINES, "three").await;

    let reader = d.spawn(s.terminals[0], &["term", "read", &t.id.to_string()]);
    let req = requests(&mut c, 1).await.remove(0);
    let answer = format!(r#"{{"request_id":{},"allow":true,"remember":true}}"#, req["request_id"]);
    for args in [
        vec!["rpc", "terminal.read_answer", answer.as_str()],
        vec!["rpc", "terminal.read_requests"],
    ] {
        let out = d.moonlet(Some(s.terminals[0]), &args);
        assert!(!out.status.success(), "{args:?} went through");
        assert_eq!(
            String::from_utf8_lossy(&out.stderr),
            "moonlet: forbidden: only the moonlet app answers read requests\n"
        );
    }
    assert_eq!(requests(&mut c, 1).await.len(), 1, "the request still waits");
    let _: Value = c
        .request(
            "terminal.read_answer",
            json!({ "request_id": req["request_id"], "allow": false, "remember": false }),
        )
        .await
        .unwrap();
    assert!(!finished(reader).0);
}

#[tokio::test]
async fn a_terminal_that_exited_can_still_be_read() {
    let d = Daemon::start(&[]).await;
    let mut c = d.client().await;
    let s = d.session(&mut c, "Fix login").await;
    let t = d.terminal(&mut c, &s, "echo build failed; exit 2", "build failed").await;
    for _ in 0..200 {
        let list: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, json!({})).await.unwrap();
        if list.iter().any(|i| i.id == t.id && i.exit.is_some()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let reader = d.spawn(s.terminals[0], &["term", "read", &t.id.to_string(), "--json"]);
    let req = requests(&mut c, 1).await.remove(0);
    assert_eq!(req["exit"], json!(2));
    let _: Value = c
        .request(
            "terminal.read_answer",
            json!({ "request_id": req["request_id"], "allow": true, "remember": false }),
        )
        .await
        .unwrap();
    let (ok, out, _) = finished(reader);
    assert!(ok);
    let read: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        read,
        json!({ "terminal": t.id, "title": "tests", "exit": 2, "running": false, "truncated": false, "lines": 1, "text": "build failed" })
    );
}

/// The waiting text reaches the app's connection, never one the `moonlet`
/// CLI opened: an agent listening on the socket cannot read it unasked.
#[tokio::test]
async fn the_request_event_skips_cli_connections() {
    use moonlet_proto::{Frame, Message};
    let d = Daemon::start(&[]).await;
    let mut c = d.client().await;
    let mut cli = Client::connect(&d.socket, "moonlet-cli").await.unwrap();
    let mut app = Client::connect_app(&d.socket, d.home.path()).await.unwrap();
    let s = d.session(&mut c, "Fix login").await;
    let t = d.terminal(&mut c, &s, THREE_LINES, "three").await;

    let reader = d.spawn(s.terminals[0], &["term", "read", &t.id.to_string()]);
    let req = requests(&mut c, 1).await.remove(0);
    let _: Value = c
        .request(
            "terminal.read_answer",
            json!({ "request_id": req["request_id"], "allow": false, "remember": false }),
        )
        .await
        .unwrap();
    assert!(!finished(reader).0);

    // Both saw `read_done`; only the app saw the request with its text.
    async fn events_until_done(c: &mut Client) -> Vec<String> {
        let mut names = Vec::new();
        while !names.iter().any(|n| n == "terminal.read_done") {
            let frame = tokio::time::timeout(Duration::from_secs(5), c.next_frame())
                .await
                .expect("no terminal.read_done")
                .unwrap()
                .unwrap();
            if let Frame::Json(Message::Event { name, .. }) = frame {
                names.push(name);
            }
        }
        names
    }
    assert!(events_until_done(&mut app).await.iter().any(|n| n == "terminal.read_request"));
    assert!(!events_until_done(&mut cli).await.iter().any(|n| n == "terminal.read_request"));
}

/// Waits until shell `id` is at a prompt after a command that exited `exit`.
async fn at_prompt(c: &mut Client, id: u32, exit: Option<i32>) {
    for _ in 0..200 {
        let list: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, json!({})).await.unwrap();
        let i = list.into_iter().find(|i| i.id == id).unwrap();
        if i.prompt == Some(true) && i.last_exit == exit {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("terminal {id} never got back to a prompt with {exit:?}");
}

/// X31 part 2: without `--lines`, a read is the last command a shell ran:
/// its command line and its output, with its exit code.
#[tokio::test]
async fn a_read_is_the_last_command_and_its_exit_code() {
    if !Path::new("/bin/zsh").exists() {
        return;
    }
    let d = Daemon::with_zsh().await;
    let mut c = d.client().await;
    let s = d.session(&mut c, "Fix login").await;
    let t: TerminalInfo = c
        .request(
            methods::TERMINAL_CREATE,
            json!({ "cwd": s.path, "session_id": s.id, "title": "tests" }),
        )
        .await
        .unwrap();
    at_prompt(&mut c, t.id, None).await;
    let _: Value = c
        .request(methods::TERMINAL_WRITE, json!({ "id": t.id, "data": "printf 'one\\ntwo\\n'; false\n" }))
        .await
        .unwrap();
    at_prompt(&mut c, t.id, Some(1)).await;

    let out = d.moonlet(Some(s.terminals[0]), &["term", "ls"]);
    let ls = String::from_utf8(out.stdout).unwrap();
    assert!(
        ls.lines().any(|l| l.starts_with(&format!("{:>4}  shell    at prompt   exit 1   tests ", t.id))),
        "{ls}"
    );

    let reader = d.spawn(s.terminals[0], &["term", "read", &t.id.to_string(), "--json"]);
    let req = requests(&mut c, 1).await.remove(0);
    assert_eq!(req["command"], json!("printf 'one\\ntwo\\n'; false"));
    assert_eq!(req["exit"], json!(1));
    assert_eq!(req["lines"], json!(2), "lines of output, not the command line");
    let _: Value = c
        .request(
            "terminal.read_answer",
            json!({ "request_id": req["request_id"], "allow": true, "remember": true }),
        )
        .await
        .unwrap();
    let (ok, out, err) = finished(reader);
    assert!(ok, "{err}");
    assert_eq!(
        serde_json::from_str::<Value>(&out).unwrap(),
        json!({
            "terminal": t.id,
            "title": "tests",
            "command": "printf 'one\\ntwo\\n'; false",
            "exit": 1,
            "running": false,
            "truncated": false,
            "lines": 2,
            "text": "$ printf 'one\\ntwo\\n'; false\none\ntwo",
        })
    );

    // `--lines` still reads the screen's last lines, prompt included.
    let out = d.moonlet(Some(s.terminals[0]), &["term", "read", &t.id.to_string(), "--lines", "3"]);
    assert!(String::from_utf8_lossy(&out.stdout).contains("two\n"));
}
