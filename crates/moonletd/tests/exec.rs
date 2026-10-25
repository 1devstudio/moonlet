//! X62: an agent's heavy commands run on a free worker. The central host
//! here is one scratch daemon with project `shop`, whose committed
//! `.moonlet/config.toml` lists its heavy commands, and session `Fix cart`.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::methods::ExecRunStarted;
use moonlet_proto::methods::{DeviceKind, MobilePairing};
use moonlet_proto::{Frame, Message};
use serde_json::{Value, json};

const CONFIG: &str = "[heavy]\ncommands = [\"pnpm test\", \"pnpm build\"]\nenv = [\"CI\"]\n";

struct Daemon {
    home: tempfile::TempDir,
    socket: PathBuf,
    env: Vec<(String, String)>,
    child: Child,
}

impl Daemon {
    async fn start(home: tempfile::TempDir, env: &[(&str, &str)]) -> Daemon {
        let socket = home.path().join("run").join("d.sock");
        let env: Vec<(String, String)> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let child = spawn(home.path(), &socket, &env).await;
        Daemon {
            home,
            socket,
            env,
            child,
        }
    }

    async fn restart(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.child = spawn(self.home.path(), &self.socket, &self.env).await;
    }

    async fn app(&self) -> Client {
        Client::connect(&self.socket, "moonlet-app").await.unwrap()
    }

    async fn call<T: serde::de::DeserializeOwned>(&self, method: &str, params: Value) -> T {
        self.app().await.request(method, params).await.unwrap()
    }

    async fn fails(&self, method: &str, params: Value) -> String {
        let e = self
            .app()
            .await
            .request::<_, Value>(method, params)
            .await
            .unwrap_err();
        e.to_string()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn spawn(home: &Path, socket: &Path, env: &[(String, String)]) -> Child {
    let child = Command::new(env!("CARGO_BIN_EXE_moonletd"))
        .arg("daemon")
        .env("MOONLET_HOME", home)
        .env("MOONLET_SOCK", socket)
        // The user's own Claude Code settings never reach a test.
        .env("CLAUDE_CONFIG_DIR", home.join("claude"))
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    wait_for_socket(&socket.to_path_buf(), Duration::from_secs(15))
        .await
        .unwrap();
    child
}

fn git(dir: &Path, args: &[&str]) -> String {
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
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// The central host with project `shop` and its session `Fix cart`.
struct Central {
    daemon: Daemon,
    project: String,
    session: String,
    /// The session's worktree.
    worktree: PathBuf,
}

async fn central_with(config: &str, env: &[(&str, &str)]) -> Central {
    central_in(tempfile::tempdir().unwrap(), config, env).await
}

async fn central_in(home: tempfile::TempDir, config: &str, env: &[(&str, &str)]) -> Central {
    // This machine's name, as the first line of a run says it.
    write(
        &home.path().join("link.json"),
        r#"{ "central": null, "worker": { "id": "0f6c2a9e-9d2b-4f5e-8f1a-2b3c4d5e6f70", "name": "studio-mini", "enabled": false } }"#,
    );
    let repo = home.path().join("src").join("shop");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            "https://git.invalid/acme/shop.git",
        ],
    );
    write(&repo.join("package.json"), "{}\n");
    // A command the run tests use: prints to both streams, then exits with
    // its first argument.
    write(
        &repo.join("run.sh"),
        "echo out\necho err >&2\nexit \"${1:-0}\"\n",
    );
    write(&repo.join(".moonlet/config.toml"), config);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "shop"]);
    let daemon = Daemon::start(home, env).await;
    let project: Value = daemon.call("project.add", json!({ "path": repo })).await;
    let session: Value = daemon
        .call(
            "session.create",
            json!({ "project_id": project["id"], "name": "Fix cart" }),
        )
        .await;
    Central {
        daemon,
        project: project["id"].as_str().unwrap().into(),
        session: session["id"].as_str().unwrap().into(),
        worktree: PathBuf::from(session["path"].as_str().unwrap()),
    }
}

async fn central() -> Central {
    central_with(CONFIG, &[]).await
}

impl Central {
    /// `exec.route` for `command` run at the top of the session's worktree.
    async fn route(&self, command: &str) -> Value {
        self.route_in(command, &self.worktree.clone()).await
    }

    async fn route_in(&self, command: &str, cwd: &Path) -> Value {
        self.daemon
            .call(
                "exec.route",
                json!({ "session": self.session, "command": command, "cwd": cwd }),
            )
            .await
    }

    async fn approve(&self, commands: &[&str], env: &[&str]) {
        let _: Value = self
            .daemon
            .call(
                "heavy.approve",
                json!({ "project": self.project, "commands": commands, "env": env }),
            )
            .await;
    }
}

#[tokio::test]
async fn an_unapproved_entry_is_not_routed() {
    let c = central().await;
    assert_eq!(
        c.route("pnpm test").await,
        json!({ "route": false, "reason": "not_approved" })
    );
    c.approve(&["pnpm test", "pnpm build"], &["CI"]).await;
    assert_eq!(
        c.route("pnpm test --run").await,
        json!({ "route": true, "reason": null })
    );
    assert_eq!(
        c.route("pnpm lint").await,
        json!({ "route": false, "reason": "not_heavy" })
    );
    assert_eq!(
        c.route("pnpm test && git status").await,
        json!({ "route": false, "reason": "not_heavy" })
    );
}

/// Edits the session's own `.moonlet/config.toml`, as an agent would.
fn edit_config(c: &Central, text: &str) {
    write(&c.worktree.join(".moonlet/config.toml"), text);
}

#[tokio::test]
async fn a_changed_entry_needs_approving_again() {
    let c = central().await;
    c.approve(&["pnpm test", "pnpm build"], &["CI"]).await;
    edit_config(
        &c,
        "[heavy]\ncommands = [\"pnpm vitest\", \"pnpm build\"]\nenv = [\"CI\"]\n",
    );
    assert_eq!(
        c.route("pnpm vitest").await,
        json!({ "route": false, "reason": "not_approved" })
    );
    // The old entry is no longer in the config.
    assert_eq!(
        c.route("pnpm test").await,
        json!({ "route": false, "reason": "not_heavy" })
    );
    assert_eq!(c.route("pnpm build").await["route"], json!(true));
}

#[tokio::test]
async fn a_new_env_name_stops_routing_until_approved() {
    let c = central().await;
    c.approve(&["pnpm test", "pnpm build"], &["CI"]).await;
    edit_config(
        &c,
        "[heavy]\ncommands = [\"pnpm test\", \"pnpm build\"]\nenv = [\"CI\", \"NPM_TOKEN\"]\n",
    );
    assert_eq!(
        c.route("pnpm test").await,
        json!({ "route": false, "reason": "env_not_approved" })
    );
}

#[tokio::test]
async fn removing_an_entry_needs_no_approval() {
    let c = central().await;
    c.approve(&["pnpm test", "pnpm build"], &["CI"]).await;
    edit_config(&c, "[heavy]\ncommands = [\"pnpm test\"]\n");
    assert_eq!(c.route("pnpm test").await["route"], json!(true));
}

#[tokio::test]
async fn approving_records_the_commands_and_env_names_together() {
    let mut c = central().await;
    let before: Value = c
        .daemon
        .call("heavy.get", json!({ "project": c.project }))
        .await;
    assert_eq!(
        before,
        json!({
            "config": { "commands": ["pnpm test", "pnpm build"], "os": "any", "env": ["CI"], "outputs": [] },
            "approved": null,
            "error": null,
        })
    );
    c.approve(&["pnpm build", "pnpm test"], &["CI"]).await;
    // Kept across a restart of the daemon.
    c.daemon.restart().await;
    let after: Value = c
        .daemon
        .call("heavy.get", json!({ "project": c.project }))
        .await;
    assert_eq!(
        after["approved"],
        json!({ "commands": ["pnpm build", "pnpm test"], "env": ["CI"] })
    );
}

#[tokio::test]
async fn approving_a_list_that_changed_meanwhile_fails() {
    let c = central().await;
    for (commands, env) in [
        (vec!["pnpm test"], vec!["CI"]),
        (vec!["pnpm test", "pnpm build"], vec![]),
        (vec!["pnpm test", "pnpm build", "rm -rf ~"], vec!["CI"]),
    ] {
        assert_eq!(
            c.daemon
                .fails(
                    "heavy.approve",
                    json!({ "project": c.project, "commands": commands, "env": env }),
                )
                .await,
            "changed: shop's heavy commands changed since they were shown"
        );
    }
    let info: Value = c
        .daemon
        .call("heavy.get", json!({ "project": c.project }))
        .await;
    assert_eq!(info["approved"], Value::Null);
}

#[tokio::test]
async fn a_call_outside_the_sessions_worktree_is_not_routed() {
    let c = central().await;
    c.approve(&["pnpm test", "pnpm build"], &["CI"]).await;
    let elsewhere = tempfile::tempdir().unwrap();
    assert_eq!(
        c.route_in("pnpm test", elsewhere.path()).await,
        json!({ "route": false, "reason": "outside_worktree" })
    );
    let sub = c.worktree.join("web");
    std::fs::create_dir_all(&sub).unwrap();
    assert_eq!(c.route_in("pnpm test", &sub).await["route"], json!(true));
    // A path that leads out of the worktree through `..` is outside too.
    let out = c.worktree.join("web/../..");
    assert_eq!(
        c.route_in("pnpm test", &out).await,
        json!({ "route": false, "reason": "outside_worktree" })
    );
}

#[tokio::test]
async fn a_terminal_outside_a_session_is_not_routed() {
    let c = central().await;
    c.approve(&["pnpm test", "pnpm build"], &["CI"]).await;
    let none: Value = c
        .daemon
        .call(
            "exec.route",
            json!({ "session": "nope", "command": "pnpm test", "cwd": c.worktree }),
        )
        .await;
    assert_eq!(none, json!({ "route": false, "reason": "no_session" }));
    let _: Value = c
        .daemon
        .call("session.archive", json!({ "id": c.session, "force": true }))
        .await;
    assert_eq!(
        c.route("pnpm test").await,
        json!({ "route": false, "reason": "no_session" })
    );
}

#[tokio::test]
async fn a_deny_rule_in_the_worktree_keeps_the_command_here() {
    let c = central().await;
    c.approve(&["pnpm test", "pnpm build"], &["CI"]).await;
    write(
        &c.worktree.join(".claude/settings.json"),
        r#"{"permissions": {"deny": ["Bash(pnpm build:*)"]}}"#,
    );
    assert_eq!(
        c.route("pnpm build").await,
        json!({ "route": false, "reason": "claude_rule" })
    );
    assert_eq!(c.route("pnpm test").await["route"], json!(true));
}

/// The central host with tailnet access on, listening on 127.0.0.1 as its
/// own "Tailscale address".
async fn central_listening() -> (Central, String) {
    let home = tempfile::tempdir().unwrap();
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
    let c = central_in(home, CONFIG, &[("MOONLET_MOBILE_ADDRS", "127.0.0.1")]).await;
    let addr = format!("127.0.0.1:{port}");
    for _ in 0..100 {
        let st: Value = c.daemon.call("mobile.status", json!({})).await;
        if st["listening"]
            .as_array()
            .is_some_and(|l| l.contains(&json!(addr)))
        {
            return (c, addr);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the central host never listened");
}

async fn pair(c: &Central, addr: &str, device: &str, kind: DeviceKind) -> String {
    let p: MobilePairing = c.daemon.call("mobile.pair_start", json!({})).await;
    moonlet_link::tailnet::pair(&[addr.to_string()], &p.code, device, kind)
        .await
        .unwrap()
        .token
}

/// A paired device's connection over the tailnet.
async fn device(addr: &str, token: &str, client: &str) -> tokio::net::TcpStream {
    use moonlet_proto::{read_frame, write_frame};
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let auth = Message::Auth {
        token: Some(token.into()),
        pair: None,
        device: None,
        route: None,
        kind: None,
    };
    write_frame(&mut s, &Frame::Json(auth)).await.unwrap();
    assert!(matches!(
        read_frame(&mut s).await.unwrap(),
        Some(Frame::Json(Message::Authed { .. }))
    ));
    let hello = Message::Hello {
        protocol: moonlet_proto::PROTOCOL_VERSION,
        client: client.into(),
    };
    write_frame(&mut s, &Frame::Json(hello)).await.unwrap();
    assert!(matches!(
        read_frame(&mut s).await.unwrap(),
        Some(Frame::Json(Message::Welcome { .. }))
    ));
    s
}

/// The error code of `method`'s answer over `s`, or `None` when it worked.
async fn refusal(
    s: &mut tokio::net::TcpStream,
    id: u64,
    method: &str,
    params: Value,
) -> Option<String> {
    use moonlet_proto::{read_frame, write_frame};
    let req = Message::Request {
        id,
        method: method.into(),
        params,
    };
    write_frame(s, &Frame::Json(req)).await.unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(10), read_frame(s))
            .await
            .expect("no reply")
            .unwrap();
        if let Some(Frame::Json(Message::Response { id: rid, error, .. })) = frame
            && rid == id
        {
            return error.map(|e| e.code);
        }
    }
}

#[tokio::test]
async fn only_the_app_or_a_paired_mac_approves_heavy_commands() {
    let (c, addr) = central_listening().await;
    let approve =
        json!({ "project": c.project, "commands": ["pnpm test", "pnpm build"], "env": ["CI"] });

    // An agent's `moonlet` CLI.
    let mut cli = Client::connect(&c.daemon.socket, "moonlet-cli")
        .await
        .unwrap();
    let e = cli
        .request::<_, Value>("heavy.approve", approve.clone())
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "forbidden: only the moonlet app manages heavy commands"
    );

    // A paired phone.
    let token = pair(&c, &addr, "Alex's iPhone", DeviceKind::Phone).await;
    let mut phone = device(&addr, &token, "moonlet-mobile").await;
    assert_eq!(
        refusal(&mut phone, 1, "heavy.approve", approve.clone())
            .await
            .as_deref(),
        Some("forbidden")
    );
    let info: Value = c
        .daemon
        .call("heavy.get", json!({ "project": c.project }))
        .await;
    assert_eq!(info["approved"], Value::Null);

    // A paired Mac's daemon linked as a worker is not its app.
    let token = pair(&c, &addr, "Alex's MacBook Pro", DeviceKind::Desktop).await;
    let mut worker = device(&addr, &token, "moonletd-worker").await;
    assert_eq!(
        refusal(&mut worker, 1, "heavy.approve", approve.clone())
            .await
            .as_deref(),
        Some("forbidden")
    );

    // A paired Mac.
    let mut mac = device(&addr, &token, "moonlet-app").await;
    assert_eq!(refusal(&mut mac, 1, "heavy.approve", approve).await, None);
    assert_eq!(c.route("pnpm test").await["route"], json!(true));
}

#[tokio::test]
async fn heavy_set_writes_the_projects_config_and_never_approves() {
    let c = central().await;
    c.approve(&["pnpm test", "pnpm build"], &["CI"]).await;
    let info: Value = c
        .daemon
        .call(
            "heavy.set",
            json!({ "project": c.project, "heavy": { "commands": ["pnpm test", "cargo test"], "os": "any", "env": ["CI"], "outputs": [] } }),
        )
        .await;
    assert_eq!(
        info["config"]["commands"],
        json!(["pnpm test", "cargo test"])
    );
    // The approval stays the list the user saw before.
    assert_eq!(
        info["approved"],
        json!({ "commands": ["pnpm build", "pnpm test"], "env": ["CI"] })
    );
    let project: Value = c
        .daemon
        .call("project.config_file", json!({ "id": c.project }))
        .await;
    let text = std::fs::read_to_string(project["path"].as_str().unwrap()).unwrap();
    assert!(
        text.ends_with("[heavy]\ncommands = [\"pnpm test\", \"cargo test\"]\nenv = [\"CI\"]\n"),
        "{text}"
    );
    assert_eq!(
        c.daemon
            .fails(
                "heavy.set",
                json!({ "project": c.project, "heavy": { "commands": [], "outputs": ["."] } }),
            )
            .await,
        "failed: outputs: `.` is the whole worktree; name a folder or file in it"
    );
}

#[tokio::test]
async fn a_managed_deny_rule_keeps_the_command_here() {
    let scratch = tempfile::tempdir().unwrap();
    let managed = scratch.path().join("managed-settings.json");
    write(
        &managed,
        r#"{"permissions": {"deny": ["Bash(pnpm test:*)"]}}"#,
    );
    let c = central_with(
        CONFIG,
        &[("MOONLET_CLAUDE_MANAGED_SETTINGS", managed.to_str().unwrap())],
    )
    .await;
    c.approve(&["pnpm test", "pnpm build"], &["CI"]).await;
    assert_eq!(
        c.route("pnpm test").await,
        json!({ "route": false, "reason": "claude_rule" })
    );
    assert_eq!(c.route("pnpm build").await["route"], json!(true));
}

const RUN_CONFIG: &str = "[heavy]\ncommands = [\"sh run.sh\", \"sh -c\", \"cat\", \"env\", \"pwd\", \"printf\"]\nenv = [\"CI\"]\n";

/// What a run sent back: its stdout, its stderr and its exit status.
#[derive(Debug, PartialEq)]
struct Ran {
    stdout: String,
    stderr: String,
    status: i32,
}

impl Central {
    async fn approve_runs(&self) {
        let info: Value = self
            .daemon
            .call("heavy.get", json!({ "project": self.project }))
            .await;
        let _: Value = self
            .daemon
            .call(
                "heavy.approve",
                json!({ "project": self.project, "commands": info["config"]["commands"], "env": info["config"]["env"] }),
            )
            .await;
    }

    /// Starts `argv` with `exec.run` in `cwd` and returns the client that
    /// gets its output.
    async fn start(&self, argv: &[&str], cwd: &Path, env: Value) -> (Client, u32) {
        let mut c = self.daemon.app().await;
        let started: ExecRunStarted = c
            .request(
                "exec.run",
                json!({ "session": self.session, "argv": argv, "cwd": cwd, "env": env }),
            )
            .await
            .unwrap();
        (c, started.run)
    }

    async fn run(&self, argv: &[&str]) -> Ran {
        let (c, run) = self.start(argv, &self.worktree.clone(), json!({})).await;
        collect(c, run).await
    }
}

async fn collect(mut c: Client, run: u32) -> Ran {
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), c.next_frame())
            .await
            .expect("the run never ended")
            .unwrap()
            .expect("the daemon closed the connection");
        match frame {
            Frame::RunOutput {
                run: r,
                stream,
                data,
            } if r == run => {
                if stream == 1 {
                    stdout.extend(data)
                } else {
                    stderr.extend(data)
                }
            }
            Frame::Json(Message::Event { name, data })
                if name == "exec.exited" && data["run"] == json!(run) =>
            {
                return Ran {
                    stdout: String::from_utf8_lossy(&stdout).into(),
                    stderr: String::from_utf8_lossy(&stderr).into(),
                    status: data["status"].as_i64().unwrap() as i32,
                };
            }
            _ => {}
        }
    }
}

#[tokio::test]
async fn a_routed_commands_output_and_exit_status_come_back() {
    let c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    assert_eq!(
        c.run(&["sh", "run.sh", "3"]).await,
        Ran {
            stdout: "out\n".into(),
            stderr: "moonlet: running on studio-mini\nerr\n".into(),
            status: 3,
        }
    );
    assert_eq!(c.run(&["sh", "run.sh"]).await.status, 0);
}

#[tokio::test]
async fn a_command_killed_by_a_signal_exits_with_128_plus_it() {
    let c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    assert_eq!(c.run(&["sh", "-c", "kill -9 $$"]).await.status, 137);
}

#[tokio::test]
async fn a_command_that_leaves_a_background_process_still_ends() {
    let c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    let started = std::time::Instant::now();
    let ran = tokio::time::timeout(
        Duration::from_secs(10),
        c.run(&["sh", "-c", "sleep 30 & echo hi"]),
    )
    .await
    .expect("the run waited for the background process");
    assert_eq!((ran.stdout.as_str(), ran.status), ("hi\n", 0));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn a_client_that_stops_reading_holds_the_command_back() {
    let c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    let worktree = c.worktree.clone();
    // 100 MB of output the client never reads: the command waits for it,
    // rather than the daemon keeping it all.
    let (client, _run) = c
        .start(
            &["sh", "-c", "head -c 100000000 /dev/zero; touch done"],
            &worktree,
            json!({}),
        )
        .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(
        !worktree.join("done").exists(),
        "the command ran ahead of its reader"
    );
    drop(client);
}

#[tokio::test]
async fn a_routed_command_reads_an_empty_stdin() {
    let c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    let ran = tokio::time::timeout(Duration::from_secs(5), c.run(&["cat"]))
        .await
        .expect("cat waited for input");
    assert_eq!((ran.stdout.as_str(), ran.status), ("", 0));
    // It is /dev/null, a character device, not a pipe left open.
    let ran = c
        .run(&["sh", "-c", "[ -c /dev/stdin ] && echo null || echo other"])
        .await;
    assert_eq!(ran.stdout, "null\n");
}

#[tokio::test]
async fn only_approved_env_names_reach_the_worker() {
    let c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    let (client, run) = c
        .start(
            &["env"],
            &c.worktree.clone(),
            json!({ "CI": "1", "NPM_TOKEN": "secret", "HOME_GROWN": "x" }),
        )
        .await;
    let ran = collect(client, run).await;
    let lines: Vec<&str> = ran.stdout.lines().collect();
    assert!(lines.contains(&"CI=1"), "{lines:?}");
    assert!(lines.contains(&"MOONLET_ROUTED=1"), "{lines:?}");
    assert!(
        lines.contains(&format!("MOONLET_SESSION={}", c.session).as_str()),
        "{lines:?}"
    );
    assert!(!ran.stdout.contains("secret"), "{lines:?}");
    assert!(!ran.stdout.contains("HOME_GROWN"), "{lines:?}");
}

#[tokio::test]
async fn a_routed_command_runs_without_a_shell_from_the_same_folder() {
    let c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    assert_eq!(
        c.run(&["printf", "%s|", "a b", "$HOME", "*"]).await.stdout,
        "a b|$HOME|*|"
    );
    let web = c.worktree.join("web");
    std::fs::create_dir_all(&web).unwrap();
    let (client, run) = c.start(&["pwd"], &web, json!({})).await;
    let ran = collect(client, run).await;
    assert_eq!(
        ran.stdout.trim(),
        std::fs::canonicalize(&web).unwrap().to_str().unwrap()
    );
}

#[tokio::test]
async fn cancelling_stops_the_command_and_brings_its_changes_back() {
    let c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    let (mut client, run) = c
        .start(
            &["sh", "-c", "echo x > done.txt; echo started; sleep 30"],
            &c.worktree.clone(),
            json!({}),
        )
        .await;
    loop {
        let f = client.next_frame().await.unwrap().unwrap();
        if matches!(&f, Frame::RunOutput { stream: 1, data, .. } if data.starts_with(b"started")) {
            break;
        }
    }
    let started = std::time::Instant::now();
    let _: bool = client
        .request("exec.cancel", json!({ "run": run }))
        .await
        .unwrap();
    let ran = collect(client, run).await;
    assert_eq!(ran.status, 143);
    assert!(started.elapsed() < Duration::from_secs(4));
    assert_eq!(
        std::fs::read_to_string(c.worktree.join("done.txt")).unwrap(),
        "x\n"
    );
}

#[tokio::test]
async fn an_unapproved_moonlet_exec_is_refused() {
    let c = central_with(RUN_CONFIG, &[]).await;
    let refuse = |argv: Value| {
        let c = &c;
        async move {
            c.daemon
                .fails(
                    "exec.run",
                    json!({ "session": c.session, "argv": argv, "cwd": c.worktree }),
                )
                .await
        }
    };
    assert_eq!(
        refuse(json!(["sh", "run.sh"])).await,
        "not_routable: not_approved"
    );
    c.approve_runs().await;
    assert_eq!(
        refuse(json!(["rm", "-rf", "."])).await,
        "not_routable: not_heavy"
    );
}
