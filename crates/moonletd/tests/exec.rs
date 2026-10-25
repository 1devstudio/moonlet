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
    // `coverage` without a slash: a link of that name is ignored too.
    write(&repo.join(".gitignore"), "coverage\nnode_modules/\n");
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
    central_listening_with(CONFIG, &[]).await
}

async fn central_listening_with(config: &str, env: &[(&str, &str)]) -> (Central, String) {
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
    let mut all = vec![("MOONLET_MOBILE_ADDRS", "127.0.0.1")];
    all.extend_from_slice(env);
    let c = central_in(home, config, &all).await;
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
    let p: MobilePairing = c.daemon.call("mobile.pair_start", json!({ "kind": kind })).await;
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

const RUN_CONFIG: &str = "[heavy]\ncommands = [\"sh run.sh\", \"sh -c\", \"cat\", \"env\", \"pwd\", \"printf\", \"shop-tool\"]\nenv = [\"CI\"]\noutputs = [\"coverage\"]\n";

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

const MAC_ID: &str = "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37";

/// The central host and Alex's MacBook Pro linked to it with heavy
/// commands on, both approving [`RUN_CONFIG`]'s commands. Both report a
/// light load: this machine's own may be anything.
async fn linked() -> (Central, Daemon) {
    linked_as(&[]).await
}

async fn linked_as(worker_env: &[(&str, &str)]) -> (Central, Daemon) {
    linked_with(RUN_CONFIG, worker_env, true).await
}

/// [`linked_as`] with `config` for the project, and the Mac approving its
/// heavy commands only when `mac_approves`.
async fn linked_with(
    config: &str,
    worker_env: &[(&str, &str)],
    mac_approves: bool,
) -> (Central, Daemon) {
    let tools = tempfile::tempdir().unwrap().keep();
    // A tool only the central host has, on its login shell's PATH.
    write(&tools.join("bin/shop-tool"), "#!/bin/sh\necho tool\n");
    std::fs::set_permissions(
        tools.join("bin/shop-tool"),
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    write(
        &tools.join(".profile"),
        &format!("PATH=\"{}/bin:$PATH\"\n", tools.display()),
    );
    let (c, addr) = central_listening_with(
        config,
        &[
            ("MOONLET_TEST_LOAD", "0.5"),
            ("MOONLET_WORKER_PING_MS", "200"),
            ("SHELL", "/bin/sh"),
            ("HOME", tools.to_str().unwrap()),
        ],
    )
    .await;
    c.approve_runs().await;
    let home = tempfile::tempdir().unwrap();
    write(
        &home.path().join("link.json"),
        &json!({ "central": null, "worker": { "id": MAC_ID, "name": "Alex's MacBook Pro", "enabled": true } })
            .to_string(),
    );
    let mac_home = home.path().to_str().unwrap().to_string();
    let mut env = vec![
        ("MOONLET_MOBILE_ADDRS", "127.0.0.2"),
        ("MOONLET_TEST_LOAD", "0.5"),
        ("SHELL", "/bin/sh"),
        ("HOME", mac_home.as_str()),
    ];
    // Later settings win: a test's own load replaces the light one.
    env.retain(|(k, _)| !worker_env.iter().any(|(w, _)| w == k));
    env.extend_from_slice(worker_env);
    let mac = Daemon::start(home, &env).await;
    let token = pair(&c, &addr, "Alex's MacBook Pro", DeviceKind::Desktop).await;
    let _: Value = mac
        .call(
            "link.set",
            json!({ "central": { "name": "studio-mini", "addrs": [addr], "token": token } }),
        )
        .await;
    if mac_approves {
        approve_on(&c, &mac).await;
    }
    for _ in 0..200 {
        let list: Value = c.daemon.call("worker.list", json!({})).await;
        if list[0]["load"].is_number() {
            return (c, mac);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the Mac never linked");
}

/// Approves the project's heavy commands on `mac` too, as the app does.
async fn approve_on(c: &Central, mac: &Daemon) {
    let projects: Value = c.daemon.call("project.list", json!({})).await;
    let info: Value = c
        .daemon
        .call("heavy.get", json!({ "project": c.project }))
        .await;
    let _: Value = mac
        .call(
            "heavy.approve",
            json!({ "identity": projects[0]["identity"], "commands": info["config"]["commands"], "env": info["config"]["env"] }),
        )
        .await;
}

#[tokio::test]
async fn a_routing_copy_lives_under_runs_and_not_in_sync_list() {
    let (c, mac) = linked().await;
    assert_eq!(
        c.run(&["sh", "run.sh", "3"]).await,
        Ran {
            stdout: "out\n".into(),
            stderr: "moonlet: running on Alex's MacBook Pro\nerr\n".into(),
            status: 3,
        }
    );
    let dir = c.worktree.file_name().unwrap();
    let copy = mac.home.path().join("runs/studio-mini/shop").join(dir);
    assert_eq!(
        std::fs::read_to_string(copy.join("run.sh")).unwrap(),
        "echo out\necho err >&2\nexit \"${1:-0}\"\n"
    );
    let listed: Value = mac.call("sync.list", json!({})).await;
    assert_eq!(listed, json!([]));
}

/// The routing copy on the Mac.
fn routing_copy(c: &Central, mac: &Daemon) -> PathBuf {
    mac.home
        .path()
        .join("runs/studio-mini/shop")
        .join(c.worktree.file_name().unwrap())
}

#[tokio::test]
async fn a_file_written_by_the_run_is_on_the_central_host_before_the_exit_status() {
    let (c, _mac) = linked().await;
    let ran = c
        .run(&["sh", "-c", "echo hi > out.txt; rm package.json"])
        .await;
    assert_eq!(ran.stderr, "moonlet: running on Alex's MacBook Pro\n");
    assert_eq!(
        std::fs::read_to_string(c.worktree.join("out.txt")).unwrap(),
        "hi\n"
    );
    assert!(!c.worktree.join("package.json").exists());
}

#[tokio::test]
async fn a_commit_made_by_the_run_moves_the_sessions_branch() {
    let (c, _mac) = linked().await;
    let ran = c
        .run(&[
            "sh",
            "-c",
            "echo x > c.txt && git add c.txt && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm 'from the run'",
        ])
        .await;
    assert_eq!(ran.status, 0, "{ran:?}");
    assert_eq!(
        git(&c.worktree, &["log", "-1", "--format=%s"]),
        "from the run"
    );
    assert_eq!(git(&c.worktree, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn a_run_whose_changes_cannot_come_back_still_ends() {
    let (c, _mac) = linked().await;
    // The central host cannot write the run's file: its folder is read-only.
    write(&c.worktree.join("locked/keep.txt"), "kept\n");
    git(&c.worktree, &["add", "locked"]);
    git(
        &c.worktree,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "locked",
        ],
    );
    let locked = c.worktree.join("locked");
    let mode = |m: u32| {
        std::fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(m)).unwrap()
    };
    mode(0o555);
    let ran = c.run(&["sh", "-c", "echo hi > locked/out.txt"]).await;
    mode(0o755);
    assert_eq!(ran_on(&ran), "Alex's MacBook Pro");
    assert!(
        ran.stderr
            .contains("moonlet: cannot bring back the run's changes"),
        "{ran:?}"
    );
}

#[tokio::test]
async fn a_command_on_a_worker_knows_its_session() {
    let (c, _mac) = linked().await;
    let ran = c.run(&["env"]).await;
    assert_eq!(ran_on(&ran), "Alex's MacBook Pro");
    let lines: Vec<&str> = ran.stdout.lines().collect();
    assert!(
        lines.contains(&format!("MOONLET_SESSION={}", c.session).as_str()),
        "{ran:?}"
    );
    assert!(lines.contains(&"MOONLET_ROUTED=1"), "{ran:?}");
}

#[tokio::test]
async fn two_commands_of_one_session_never_share_a_routing_copy() {
    let (c, _mac) = linked().await;
    // The copy exists already, so both would be ready at once.
    c.run(&["sh", "run.sh"]).await;
    // The Mac has two slots, but one copy of the session: one of them
    // runs there, the others here.
    let (a, b, d) = tokio::join!(
        c.run(&["sh", "-c", "sleep 1"]),
        c.run(&["sh", "-c", "echo b > b.txt; sleep 1.5; cat b.txt"]),
        c.run(&["sh", "-c", "sleep 1"])
    );
    assert_eq!((b.stdout.as_str(), b.status), ("b\n", 0), "{b:?}");
    let on_mac = [&a, &b, &d]
        .iter()
        .filter(|r| ran_on(r) == "Alex's MacBook Pro")
        .count();
    assert_eq!(on_mac, 1, "{a:?} {b:?} {d:?}");
}

#[tokio::test]
async fn cancelling_while_the_worker_prepares_never_runs_the_command() {
    let (c, _mac) = linked().await;
    let worktree = c.worktree.clone();
    // The first run makes the routing copy: cancelled meanwhile.
    let (mut client, run) = c
        .start(&["sh", "-c", "echo ran > ran.txt"], &worktree, json!({}))
        .await;
    let _: Value = client
        .request("exec.cancel", json!({ "run": run }))
        .await
        .unwrap();
    let ran = collect(client, run).await;
    assert_eq!(ran.status, 130, "{ran:?}");
    assert!(!worktree.join("ran.txt").exists());
}

#[tokio::test]
async fn a_command_starts_only_once_the_copy_matches_the_session() {
    let (c, mac) = linked().await;
    assert_eq!(c.run(&["cat", "package.json"]).await.stdout, "{}\n");
    // Edited on the central host between runs: the copy waits for the
    // next run to get it.
    write(&c.worktree.join("package.json"), "{\"name\":\"shop\"}\n");
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(
        std::fs::read_to_string(routing_copy(&c, &mac).join("package.json")).unwrap(),
        "{}\n"
    );
    assert_eq!(
        c.run(&["cat", "package.json"]).await.stdout,
        "{\"name\":\"shop\"}\n"
    );
}

#[tokio::test]
async fn a_file_changed_on_both_sides_during_a_run_keeps_the_central_version_and_saves_the_runs() {
    let (c, _mac) = linked().await;
    let (mut client, run) = c
        .start(
            &[
                "sh",
                "-c",
                "echo started; sleep 2; echo run > run.sh; echo run > other.txt",
            ],
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
    write(&c.worktree.join("run.sh"), "central\n");
    write(&c.worktree.join("notes.md"), "kept\n");
    let ran = collect(client, run).await;
    assert_eq!(ran.status, 0);
    assert_eq!(
        std::fs::read_to_string(c.worktree.join("run.sh")).unwrap(),
        "central\n"
    );
    assert_eq!(
        std::fs::read_to_string(c.worktree.join("other.txt")).unwrap(),
        "run\n"
    );
    assert_eq!(
        std::fs::read_to_string(c.worktree.join("notes.md")).unwrap(),
        "kept\n"
    );
    let last = ran.stderr.lines().last().unwrap().to_string();
    let prefix = "moonlet: run.sh changed on studio-mini during the run; the run's version is in ";
    assert!(last.starts_with(prefix), "{last}");
    let folder = PathBuf::from(&last[prefix.len()..]);
    assert_eq!(
        std::fs::read_to_string(folder.join("run.sh")).unwrap(),
        "run\n"
    );
    assert!(
        folder.starts_with(c.daemon.home.path().join("sync-leftovers")),
        "{}",
        folder.display()
    );
}

#[tokio::test]
async fn outputs_bring_back_an_ignored_coverage_folder() {
    let (c, _mac) = linked().await;
    // Last run's report, which this run's replaces.
    write(&c.worktree.join("coverage/old.txt"), "stale\n");
    let ran = c
        .run(&[
            "sh",
            "-c",
            "mkdir -p coverage/lcov && echo 87 > coverage/lcov/index.txt",
        ])
        .await;
    assert_eq!(ran.stderr, "moonlet: running on Alex's MacBook Pro\n");
    assert_eq!(
        std::fs::read_to_string(c.worktree.join("coverage/lcov/index.txt")).unwrap(),
        "87\n"
    );
    assert!(!c.worktree.join("coverage/old.txt").exists());
    // Ignored, so nothing of it shows as a change in the session.
    assert_eq!(git(&c.worktree, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn a_symbolic_link_in_outputs_is_never_followed() {
    let (c, _mac) = linked().await;
    c.run(&[
        "sh",
        "-c",
        "mkdir -p coverage && echo 1 > coverage/a.txt && ln -s /etc coverage/etc",
    ])
    .await;
    let link = c.worktree.join("coverage/etc");
    let meta = std::fs::symlink_metadata(&link).unwrap();
    assert!(meta.file_type().is_symlink());
    assert_eq!(std::fs::read_link(&link).unwrap(), PathBuf::from("/etc"));
    // On the central host, a folder that leads elsewhere is never written
    // through.
    let elsewhere = tempfile::tempdir().unwrap();
    std::fs::remove_dir_all(c.worktree.join("coverage")).unwrap();
    std::os::unix::fs::symlink(elsewhere.path(), c.worktree.join("coverage")).unwrap();
    let ran = c
        .run(&["sh", "-c", "mkdir -p coverage && echo 2 > coverage/a.txt"])
        .await;
    assert_eq!(
        ran.stderr.lines().last().unwrap(),
        "moonlet: coverage is a symbolic link on studio-mini; not brought back"
    );
    assert!(!elsewhere.path().join("a.txt").exists());
}

#[tokio::test]
async fn an_outputs_path_that_is_a_symbolic_link_is_skipped() {
    let (c, _mac) = linked().await;
    let ran = c.run(&["sh", "-c", "ln -s /etc coverage"]).await;
    assert_eq!(
        ran.stderr.lines().last().unwrap(),
        "moonlet: coverage is a symbolic link; not brought back"
    );
    assert!(!c.worktree.join("coverage").exists());
}

#[tokio::test]
async fn outputs_over_one_gib_stay_on_the_worker_and_say_so() {
    let (c, _mac) = linked_as(&[("MOONLET_TEST_OUTPUTS_LIMIT", "10")]).await;
    let ran = c
        .run(&[
            "sh",
            "-c",
            "mkdir -p coverage && printf 01234567890123456789 > coverage/big.txt",
        ])
        .await;
    assert_eq!(
        ran.stderr.lines().last().unwrap(),
        "moonlet: outputs are 20 B, over the 10 B limit; not brought back"
    );
    assert!(!c.worktree.join("coverage").exists());
}

/// Where a run went, from its first line.
fn ran_on(ran: &Ran) -> &str {
    ran.stderr
        .lines()
        .next()
        .and_then(|l| l.strip_prefix("moonlet: running on "))
        .unwrap_or("")
}

#[tokio::test]
async fn a_worker_that_has_not_approved_refuses_and_the_next_one_runs_it() {
    let (c, mac) = linked_with(RUN_CONFIG, &[], false).await;
    assert_eq!(ran_on(&c.run(&["sh", "run.sh"]).await), "studio-mini");
    // The Mac approved other commands of the project: not this one.
    let projects: Value = c.daemon.call("project.list", json!({})).await;
    let _: Value = mac
        .call(
            "heavy.approve",
            json!({ "identity": projects[0]["identity"], "commands": ["cat"], "env": ["CI"] }),
        )
        .await;
    assert_eq!(ran_on(&c.run(&["sh", "run.sh"]).await), "studio-mini");
    assert_eq!(
        ran_on(&c.run(&["cat", "package.json"]).await),
        "Alex's MacBook Pro"
    );
    approve_on(&c, &mac).await;
    assert_eq!(
        ran_on(&c.run(&["sh", "run.sh"]).await),
        "Alex's MacBook Pro"
    );
}

#[tokio::test]
async fn a_missing_tool_sends_the_command_to_the_next_worker() {
    let (c, _mac) = linked().await;
    let ran = c.run(&["shop-tool"]).await;
    assert_eq!(ran_on(&ran), "studio-mini");
    assert_eq!(ran.stdout, "tool\n");
}

#[tokio::test]
async fn a_worker_waiting_for_setup_approval_is_skipped() {
    let config = format!("setup = \"true\"\n{RUN_CONFIG}");
    let (c, _mac) = linked_with(&config, &[], true).await;
    assert_eq!(ran_on(&c.run(&["sh", "run.sh"]).await), "studio-mini");
}

#[tokio::test]
async fn a_routing_copy_on_a_mac_waits_for_setup_approval() {
    let config = format!("setup = \"touch set-up\"\n{RUN_CONFIG}");
    let (c, mac) = linked_with(&config, &[], true).await;
    let mut app = mac.app().await;
    // An agent's CLI on the Mac never hears what only the app answers.
    let mut cli = Client::connect(&mac.socket, "moonlet-cli").await.unwrap();
    // Until the user approves the setup, the Mac refuses and the central host runs it.
    assert_eq!(ran_on(&c.run(&["sh", "run.sh"]).await), "studio-mini");
    // The Mac's app is asked, as for a live copy (X60).
    let asked = loop {
        let frame = tokio::time::timeout(Duration::from_secs(10), app.next_frame())
            .await
            .expect("the app was never asked")
            .unwrap()
            .unwrap();
        if let Frame::Json(Message::Event { name, data }) = frame
            && name == "exec.setup"
        {
            break data;
        }
    };
    while let Ok(Ok(Some(frame))) =
        tokio::time::timeout(Duration::from_millis(300), cli.next_frame()).await
    {
        if let Frame::Json(Message::Event { name, .. }) = frame {
            assert_ne!(name, "exec.setup", "the CLI heard it");
        }
    }
    let copy = asked["copy"].as_str().unwrap().to_string();
    assert_eq!(
        asked,
        json!({ "copy": copy, "host": "studio-mini", "project": "shop", "command": "touch set-up" })
    );
    // An app that starts later asks too.
    let waiting: Value = mac.call("exec.setups", json!({})).await;
    assert_eq!(waiting, json!([asked]));
    let _: Value = mac
        .call(
            "sync.run_setup",
            json!({ "copy": copy, "command": "touch set-up" }),
        )
        .await;
    let mut on = String::new();
    for _ in 0..50 {
        on = ran_on(&c.run(&["sh", "run.sh"]).await).to_string();
        if on == "Alex's MacBook Pro" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(on, "Alex's MacBook Pro");
    assert!(
        routing_copy(&c, &mac).join("set-up").exists(),
        "setup did not run"
    );
    let waiting: Value = mac.call("exec.setups", json!({})).await;
    assert_eq!(waiting, json!([]));
}

#[tokio::test]
async fn a_worker_with_no_free_slot_is_skipped() {
    let (c, mac) = linked().await;
    let _: Value = mac
        .call("link.set", json!({ "worker": { "slots": 1 } }))
        .await;
    for _ in 0..100 {
        let list: Value = c.daemon.call("worker.list", json!({})).await;
        if list[0]["slots"] == json!(1) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (mut first, run) = c
        .start(
            &["sh", "-c", "echo started; sleep 3"],
            &c.worktree.clone(),
            json!({}),
        )
        .await;
    let mut said = Vec::new();
    loop {
        match first.next_frame().await.unwrap().unwrap() {
            Frame::RunOutput {
                stream: 2, data, ..
            } => said.extend(data),
            Frame::RunOutput {
                stream: 1, data, ..
            } if data.starts_with(b"started") => break,
            _ => {}
        }
    }
    assert_eq!(
        String::from_utf8_lossy(&said),
        "moonlet: running on Alex's MacBook Pro\n"
    );
    assert_eq!(ran_on(&c.run(&["sh", "run.sh"]).await), "studio-mini");
    assert_eq!(collect(first, run).await.status, 0);
    // Two at once: the Mac takes one, whatever the central host thought.
    // Long enough to overlap however slow preparing the other one is.
    let (a, b) = tokio::join!(
        c.run(&["sh", "-c", "sleep 4"]),
        c.run(&["sh", "-c", "sleep 4"])
    );
    let mut on = vec![ran_on(&a).to_string(), ran_on(&b).to_string()];
    on.sort();
    assert_eq!(on, ["Alex's MacBook Pro", "studio-mini"]);
}

#[tokio::test]
async fn a_command_with_no_free_worker_runs_on_the_central_host() {
    let (c, _mac) = linked_as(&[("MOONLET_TEST_LOAD", "1000")]).await;
    assert_eq!(ran_on(&c.run(&["sh", "run.sh"]).await), "studio-mini");
}

#[tokio::test]
async fn a_copy_that_cannot_match_in_time_refuses_not_fenced() {
    let (c, _mac) = linked().await;
    assert_eq!(
        ran_on(&c.run(&["sh", "run.sh"]).await),
        "Alex's MacBook Pro"
    );
    // Off its branch, the session cannot be fenced: the command stays.
    git(&c.worktree, &["checkout", "-q", "--detach"]);
    assert_eq!(ran_on(&c.run(&["sh", "run.sh"]).await), "studio-mini");
}

#[tokio::test]
async fn a_worker_that_goes_away_mid_run_makes_the_command_run_again_on_the_central_host() {
    let (c, mac) = linked().await;
    // On the Mac the run leaves a mark in its copy; on the central host
    // it does not.
    let (mut client, run) = c
        .start(
            &[
                "sh",
                "-c",
                "case \"$PWD\" in */runs/*) echo mac > from-mac.txt;; esac; echo started; sleep 3; echo finished",
            ],
            &c.worktree.clone(),
            json!({}),
        )
        .await;
    let mut said = Vec::new();
    loop {
        match client.next_frame().await.unwrap().unwrap() {
            Frame::RunOutput {
                stream: 2, data, ..
            } => said.extend(data),
            Frame::RunOutput {
                stream: 1, data, ..
            } if data.starts_with(b"started") => break,
            _ => {}
        }
    }
    assert_eq!(
        String::from_utf8_lossy(&said),
        "moonlet: running on Alex's MacBook Pro\n"
    );
    let pid = nix::unistd::Pid::from_raw(mac.child.id() as i32);
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGSTOP).unwrap();
    let ran = collect(client, run).await;
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGCONT).unwrap();
    assert_eq!(ran.status, 0);
    assert_eq!(
        ran.stderr,
        "moonlet: Alex's MacBook Pro went away. Running again on studio-mini.\nmoonlet: running on studio-mini\n"
    );
    assert_eq!(ran.stdout, "started\nfinished\n");
}

#[tokio::test]
async fn an_abandoned_runs_changes_never_reach_the_session() {
    let (c, mac) = linked().await;
    let (mut client, run) = c
        .start(
            &["sh", "-c", "echo mac > from-mac.txt; echo started; sleep 3"],
            &c.worktree.clone(),
            json!({}),
        )
        .await;
    loop {
        if let Frame::RunOutput {
            stream: 1, data, ..
        } = client.next_frame().await.unwrap().unwrap()
            && data.starts_with(b"started")
        {
            break;
        }
    }
    let pid = nix::unistd::Pid::from_raw(mac.child.id() as i32);
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGSTOP).unwrap();
    // Run again on the central host, where it writes the file itself.
    let ran = collect(client, run).await;
    assert_eq!(ran.status, 0);
    std::fs::remove_file(c.worktree.join("from-mac.txt")).unwrap();
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGCONT).unwrap();
    // The Mac links again; the abandoned run's file goes with its copy's
    // return to the fence, and never reaches the session.
    let copy = routing_copy(&c, &mac);
    for _ in 0..200 {
        if !copy.join("from-mac.txt").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!copy.join("from-mac.txt").exists());
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(!c.worktree.join("from-mac.txt").exists());
    // And the Mac runs the next command from the session's files.
    assert_eq!(
        ran_on(&c.run(&["sh", "run.sh"]).await),
        "Alex's MacBook Pro"
    );
    assert!(!c.worktree.join("from-mac.txt").exists());
}

#[tokio::test]
async fn the_copys_path_reads_as_the_sessions_in_output() {
    let (c, _mac) = linked().await;
    let ran = c.run(&["sh", "-c", "pwd; echo \"$PWD/run.sh\" >&2"]).await;
    assert_eq!(ran_on(&ran), "Alex's MacBook Pro");
    let session = c.worktree.display().to_string();
    assert_eq!(ran.stdout, format!("{session}\n"));
    assert!(
        ran.stderr.ends_with(&format!("{session}/run.sh\n")),
        "{}",
        ran.stderr
    );
}

async fn gone(path: &Path) -> bool {
    for _ in 0..200 {
        if !path.exists() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

#[tokio::test]
async fn archiving_the_session_removes_its_routing_copies() {
    let (c, mac) = linked().await;
    assert_eq!(
        ran_on(&c.run(&["sh", "run.sh"]).await),
        "Alex's MacBook Pro"
    );
    let copy = routing_copy(&c, &mac);
    assert!(copy.exists());
    let _: Value = c
        .daemon
        .call("session.archive", json!({ "id": c.session, "force": true }))
        .await;
    assert!(gone(&copy).await, "the routing copy stayed");
    assert!(!mac.home.path().join("sync-leftovers").exists());
}

#[tokio::test]
async fn turning_heavy_commands_off_removes_the_routing_copies() {
    let (c, mac) = linked().await;
    assert_eq!(
        ran_on(&c.run(&["sh", "run.sh"]).await),
        "Alex's MacBook Pro"
    );
    let copy = routing_copy(&c, &mac);
    let _: Value = mac
        .call("link.set", json!({ "worker": { "enabled": false } }))
        .await;
    assert!(gone(&copy).await, "the routing copy stayed");
}

#[tokio::test]
async fn a_routing_copy_unused_for_seven_days_is_removed() {
    let (c, mac) = linked_as(&[
        ("MOONLET_TEST_RUN_COPY_TTL_MS", "1500"),
        ("MOONLET_TEST_RUN_COPY_SWEEP_MS", "100"),
    ])
    .await;
    assert_eq!(
        ran_on(&c.run(&["sh", "run.sh"]).await),
        "Alex's MacBook Pro"
    );
    assert!(
        gone(&routing_copy(&c, &mac)).await,
        "the routing copy stayed"
    );
    // And the next run makes it again.
    assert_eq!(
        ran_on(&c.run(&["sh", "run.sh"]).await),
        "Alex's MacBook Pro"
    );
}

async fn jobs(c: &Central) -> Vec<Value> {
    c.daemon
        .call("job.list", json!({ "session": c.session }))
        .await
}

/// A job's stored output, as one text per stream.
async fn stored(c: &Central, job: &str) -> (String, String) {
    let (mut out, mut err, mut from) = (String::new(), String::new(), 0u64);
    loop {
        let got: Value = c
            .daemon
            .call("job.output", json!({ "job": job, "from": from }))
            .await;
        for chunk in got["chunks"].as_array().unwrap() {
            let text = chunk["text"].as_str().unwrap();
            if chunk["stream"] == json!(1) {
                out.push_str(text)
            } else {
                err.push_str(text)
            }
        }
        from = got["next"].as_u64().unwrap();
        if got["more"] != json!(true) {
            return (out, err);
        }
    }
}

#[tokio::test]
async fn jobs_outlive_a_daemon_restart_and_keep_the_last_fifty() {
    let mut c = central_with(RUN_CONFIG, &[("MOONLET_TEST_JOBS_KEPT", "3")]).await;
    c.approve_runs().await;
    for n in ["1", "2", "3", "4"] {
        c.run(&["sh", "run.sh", n]).await;
    }
    let commands = |list: &[Value]| -> Vec<String> {
        list.iter()
            .map(|j| j["command"].as_str().unwrap().to_string())
            .collect()
    };
    let before = jobs(&c).await;
    assert_eq!(
        commands(&before),
        ["sh run.sh 4", "sh run.sh 3", "sh run.sh 2"]
    );
    assert_eq!(before[0]["state"], json!({ "kind": "done", "exit": 4 }));
    c.daemon.restart().await;
    let after = jobs(&c).await;
    assert_eq!(
        commands(&after),
        ["sh run.sh 4", "sh run.sh 3", "sh run.sh 2"]
    );
    let id = after[0]["id"].as_str().unwrap();
    assert_eq!(
        stored(&c, id).await,
        (
            "out\n".to_string(),
            "moonlet: running on studio-mini\nerr\n".to_string()
        )
    );
}

#[tokio::test]
async fn archiving_the_session_removes_its_jobs() {
    let c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    c.run(&["sh", "run.sh"]).await;
    assert_eq!(jobs(&c).await.len(), 1);
    let _: Value = c
        .daemon
        .call("session.archive", json!({ "id": c.session, "force": true }))
        .await;
    assert_eq!(jobs(&c).await, Vec::<Value>::new());
    assert!(!c.daemon.home.path().join("jobs").join(&c.session).exists());
}

#[tokio::test]
async fn a_character_split_across_two_writes_reads_whole() {
    let c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    // "é" is two bytes, written apart.
    let mut events = c.daemon.app().await;
    c.run(&["sh", "-c", "printf '\\303'; sleep 0.3; printf '\\251\\n'"])
        .await;
    let id = jobs(&c).await[0]["id"].as_str().unwrap().to_string();
    assert_eq!(stored(&c, &id).await.0, "é\n");
    // As it came, too.
    let mut heard = String::new();
    while let Ok(Ok(Some(frame))) =
        tokio::time::timeout(Duration::from_millis(300), events.next_frame()).await
    {
        if let Frame::Json(Message::Event { name, data }) = frame
            && name == "job.output"
        {
            for chunk in data["chunks"].as_array().unwrap() {
                if chunk["stream"] == json!(1) {
                    heard.push_str(chunk["text"].as_str().unwrap());
                }
            }
        }
    }
    assert_eq!(heard, "é\n");
}

#[tokio::test]
async fn a_job_lists_what_came_back_and_the_env_names_only() {
    let (c, _mac) = linked().await;
    let (client, run) = c
        .start(
            &["sh", "-c", "echo one > out.txt; printf 'a\\nb\\n' > run.sh; mkdir -p coverage; printf 12345 > coverage/x"],
            &c.worktree.clone(),
            json!({ "CI": "secret-value" }),
        )
        .await;
    assert_eq!(collect(client, run).await.status, 0);
    let list = jobs(&c).await;
    let job = &list[0];
    assert!(!job.to_string().contains("secret-value"), "{job}");
    assert_eq!(job["env"], json!(["CI"]));
    assert_eq!(job["state"], json!({ "kind": "done", "exit": 0 }));
    assert_eq!(
        job["brought"],
        json!([
            { "path": "out.txt", "added": 1, "removed": 0 },
            { "path": "run.sh", "added": 2, "removed": 3 },
        ])
    );
    assert_eq!(job["outputs"], json!([{ "path": "coverage", "bytes": 5 }]));
    assert_eq!(job["worker"]["name"], json!("Alex's MacBook Pro"));
    assert_eq!(job["worker"]["slot"], json!(1));
    assert_eq!(job["worker"]["slots"], json!(2));
    assert!(
        job["worker"]["copy"].as_str().unwrap().ends_with(&format!(
            "runs/studio-mini/shop/{}",
            c.worktree.file_name().unwrap().to_str().unwrap()
        )),
        "{job}"
    );
    let phases: Vec<&str> = job["phases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        phases,
        [
            "Copy matched the session",
            "Ran on Alex's MacBook Pro",
            "Brought back",
            "Exit status to Claude"
        ]
    );
    assert!(job["phases"][1]["took_ms"].is_u64(), "{job}");
}

#[tokio::test]
async fn output_over_ten_mib_keeps_its_start_and_end() {
    let c = central_with(RUN_CONFIG, &[("MOONLET_TEST_JOB_OUTPUT_MAX", "1000")]).await;
    c.approve_runs().await;
    let ran = c
        .run(&[
            "sh",
            "-c",
            "i=0; while [ $i -lt 300 ]; do echo line$i; i=$((i+1)); done",
        ])
        .await;
    assert_eq!(ran.stdout.lines().count(), 300);
    let id = jobs(&c).await[0]["id"].as_str().unwrap().to_string();
    let (out, err) = stored(&c, &id).await;
    assert!(out.starts_with("line0\nline1\n"), "{out}");
    assert!(out.ends_with("line298\nline299\n"), "{out}");
    assert!(out.len() < 1100, "{}", out.len());
    assert!(
        err.lines()
            .any(|l| l.starts_with("moonlet: ") && l.ends_with(" of output dropped here")),
        "{err}"
    );
}

#[tokio::test]
async fn a_jobs_phases_and_timeline_after_a_rerun() {
    let (c, mac) = linked().await;
    let (mut client, run) = c
        .start(
            &["sh", "-c", "echo started; sleep 3"],
            &c.worktree.clone(),
            json!({}),
        )
        .await;
    loop {
        if let Frame::RunOutput {
            stream: 1, data, ..
        } = client.next_frame().await.unwrap().unwrap()
            && data.starts_with(b"started")
        {
            break;
        }
    }
    let pid = nix::unistd::Pid::from_raw(mac.child.id() as i32);
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGSTOP).unwrap();
    let ran = collect(client, run).await;
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGCONT).unwrap();
    assert_eq!(ran.status, 0);
    let job = jobs(&c).await[0].clone();
    let texts: Vec<&str> = job["timeline"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["text"].as_str().unwrap())
        .collect();
    assert_eq!(
        texts,
        [
            "Started on Alex's MacBook Pro",
            "Alex's MacBook Pro went away",
            "Ran again on studio-mini, from the same files",
            "Exited 0 · status went to Claude",
        ]
    );
    assert_eq!(
        job["timeline"][1]["detail"],
        json!("It missed 3 pings. That run's changes were dropped.")
    );
    let (_, err) = stored(&c, job["id"].as_str().unwrap()).await;
    assert!(err.contains("──── run 2 · studio-mini ────\n"), "{err}");
}

#[tokio::test]
async fn stopping_a_job_gives_exit_143_and_brings_its_changes_back() {
    let (c, _mac) = linked().await;
    let (mut client, run) = c
        .start(
            &["sh", "-c", "echo x > done.txt; echo started; sleep 30"],
            &c.worktree.clone(),
            json!({}),
        )
        .await;
    loop {
        if let Frame::RunOutput {
            stream: 1, data, ..
        } = client.next_frame().await.unwrap().unwrap()
            && data.starts_with(b"started")
        {
            break;
        }
    }
    let id = jobs(&c).await[0]["id"].as_str().unwrap().to_string();
    let stopped: bool = c.daemon.call("job.stop", json!({ "job": id })).await;
    assert!(stopped);
    let ran = collect(client, run).await;
    assert_eq!(ran.status, 143);
    assert!(
        ran.stderr
            .contains("moonlet: stopped from the Jobs panel\n"),
        "{}",
        ran.stderr
    );
    assert_eq!(
        std::fs::read_to_string(c.worktree.join("done.txt")).unwrap(),
        "x\n"
    );
    assert_eq!(
        jobs(&c).await[0]["state"],
        json!({ "kind": "stopped", "exit": 143 })
    );
}

#[tokio::test]
async fn stop_all_stops_every_running_and_waiting_job() {
    let c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    let mut started = Vec::new();
    for _ in 0..2 {
        let (mut client, run) = c
            .start(
                &["sh", "-c", "echo started; sleep 30"],
                &c.worktree.clone(),
                json!({}),
            )
            .await;
        loop {
            if let Frame::RunOutput {
                stream: 1, data, ..
            } = client.next_frame().await.unwrap().unwrap()
                && data.starts_with(b"started")
            {
                break;
            }
        }
        started.push((client, run));
    }
    let n: u32 = c
        .daemon
        .call("job.stop_all", json!({ "session": c.session }))
        .await;
    assert_eq!(n, 2);
    for (client, run) in started {
        assert_eq!(collect(client, run).await.status, 143);
    }
}

#[tokio::test]
async fn job_run_here_needs_a_waiting_job() {
    let c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    c.run(&["sh", "run.sh"]).await;
    let id = jobs(&c).await[0]["id"].as_str().unwrap().to_string();
    assert_eq!(
        c.daemon.fails("job.run_here", json!({ "job": id })).await,
        "not_waiting: the job is not waiting for a machine"
    );
}

#[tokio::test]
async fn a_job_going_on_when_the_daemon_stops_is_lost() {
    let mut c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    let (mut client, _run) = c
        .start(
            &["sh", "-c", "echo started; sleep 30"],
            &c.worktree.clone(),
            json!({}),
        )
        .await;
    loop {
        if let Frame::RunOutput {
            stream: 1, data, ..
        } = client.next_frame().await.unwrap().unwrap()
            && data.starts_with(b"started")
        {
            break;
        }
    }
    c.daemon.restart().await;
    assert_eq!(jobs(&c).await[0]["state"], json!({ "kind": "lost" }));
    // It ended when the daemon stopped, whatever later restarts say.
    let ended = jobs(&c).await[0]["ended_at"].clone();
    tokio::time::sleep(Duration::from_millis(50)).await;
    c.daemon.restart().await;
    assert_eq!(jobs(&c).await[0]["ended_at"], ended);
}

#[tokio::test]
async fn a_job_still_going_on_is_kept_past_the_limit() {
    let c = central_with(RUN_CONFIG, &[("MOONLET_TEST_JOBS_KEPT", "1")]).await;
    c.approve_runs().await;
    let (client, run) = c
        .start(&["sh", "-c", "sleep 2"], &c.worktree.clone(), json!({}))
        .await;
    c.run(&["sh", "run.sh"]).await;
    let commands = |list: Vec<Value>| -> Vec<String> {
        list.iter()
            .map(|j| j["command"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(commands(jobs(&c).await), ["sh run.sh", "sh -c 'sleep 2'"]);
    assert_eq!(collect(client, run).await.status, 0);
    // Once it has ended, the next job drops it.
    c.run(&["sh", "run.sh"]).await;
    assert_eq!(commands(jobs(&c).await), ["sh run.sh"]);
}

#[tokio::test]
async fn a_stopped_job_whose_worker_goes_away_does_not_run_again() {
    let (c, mac) = linked().await;
    let (mut client, run) = c
        .start(
            &["sh", "-c", "echo started; sleep 3; echo finished"],
            &c.worktree.clone(),
            json!({}),
        )
        .await;
    loop {
        if let Frame::RunOutput {
            stream: 1, data, ..
        } = client.next_frame().await.unwrap().unwrap()
            && data.starts_with(b"started")
        {
            break;
        }
    }
    let id = jobs(&c).await[0]["id"].as_str().unwrap().to_string();
    let pid = nix::unistd::Pid::from_raw(mac.child.id() as i32);
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGSTOP).unwrap();
    let app = c.daemon.app().await;
    let stop = tokio::spawn(async move {
        let mut app = app;
        app.request::<_, Value>("job.stop", json!({ "job": id }))
            .await
    });
    let ran = collect(client, run).await;
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGCONT).unwrap();
    assert_eq!(stop.await.unwrap().unwrap(), json!(true));
    assert_eq!(ran.status, 143, "{ran:?}");
    // It never ran again: no second "started", nor "finished".
    assert_eq!(ran.stdout, "");
    assert!(!ran.stderr.contains("Running again"), "{ran:?}");
    assert_eq!(
        jobs(&c).await[0]["state"],
        json!({ "kind": "stopped", "exit": 143 })
    );
}

#[tokio::test]
async fn stopping_a_job_while_its_worker_prepares_never_runs_it() {
    let (c, _mac) = linked().await;
    let worktree = c.worktree.clone();
    // The first run makes the routing copy: stopped meanwhile.
    let (client, run) = c
        .start(&["sh", "-c", "echo ran > ran.txt"], &worktree, json!({}))
        .await;
    let id = jobs(&c).await[0]["id"].as_str().unwrap().to_string();
    let stopped: Value = c.daemon.call("job.stop", json!({ "job": id })).await;
    assert_eq!(stopped, json!(true));
    let ran = collect(client, run).await;
    assert_eq!(ran.status, 143, "{ran:?}");
    assert!(!worktree.join("ran.txt").exists());
    assert_eq!(
        jobs(&c).await[0]["state"],
        json!({ "kind": "stopped", "exit": 143 })
    );
}

#[tokio::test]
async fn an_agents_cli_neither_reads_nor_stops_jobs() {
    let c = central_with(RUN_CONFIG, &[]).await;
    c.approve_runs().await;
    c.run(&["sh", "run.sh"]).await;
    let id = jobs(&c).await[0]["id"].as_str().unwrap().to_string();
    let mut cli = Client::connect(&c.daemon.socket, "moonlet-cli")
        .await
        .unwrap();
    for (method, params) in [
        ("job.list", json!({ "session": c.session })),
        ("job.output", json!({ "job": id })),
        ("job.stop", json!({ "job": id })),
        ("job.stop_all", json!({ "session": c.session })),
        ("job.run_here", json!({ "job": id })),
    ] {
        let e = cli.request::<_, Value>(method, params).await.unwrap_err();
        assert_eq!(
            e.to_string(),
            "forbidden: only the moonlet app manages jobs",
            "{method}"
        );
    }
    // Nor does it hear a job's output as it comes.
    let mut listening = Client::connect(&c.daemon.socket, "moonlet-cli")
        .await
        .unwrap();
    c.run(&["sh", "run.sh"]).await;
    while let Ok(Ok(Some(frame))) =
        tokio::time::timeout(Duration::from_millis(500), listening.next_frame()).await
    {
        if let Frame::Json(Message::Event { name, .. }) = frame {
            assert!(!name.starts_with("job."), "the CLI heard {name}");
        }
    }
}

#[tokio::test]
async fn approving_on_a_worker_clears_its_not_approved_line() {
    let (c, mac) = linked_with(RUN_CONFIG, &[], false).await;
    assert_eq!(ran_on(&c.run(&["sh", "run.sh"]).await), "studio-mini");
    let status: Value = c.daemon.call("exec.status", json!({})).await;
    assert_eq!(
        status["skips"][0]["reason"],
        json!("not_approved"),
        "{status}"
    );
    approve_on(&c, &mac).await;
    for _ in 0..100 {
        let status: Value = c.daemon.call("exec.status", json!({})).await;
        if status["skips"] == json!([]) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the central host still says the Mac has not approved");
}

#[tokio::test]
async fn exec_status_lists_the_central_host_its_runs_and_why_workers_were_skipped() {
    let (c, _mac) = linked_with(RUN_CONFIG, &[], false).await;
    // Not approved on the Mac: it is skipped, and the command runs here.
    let (mut client, run) = c
        .start(
            &["sh", "-c", "echo started; sleep 30"],
            &c.worktree.clone(),
            json!({}),
        )
        .await;
    loop {
        if let Frame::RunOutput {
            stream: 1, data, ..
        } = client.next_frame().await.unwrap().unwrap()
            && data.starts_with(b"started")
        {
            break;
        }
    }
    let status: Value = c.daemon.call("exec.status", json!({})).await;
    assert_eq!(status["host"]["name"], json!("studio-mini"));
    assert_eq!(status["host"]["slots"], json!(2));
    assert_eq!(status["host"]["load"], json!(0.5));
    let running = status["running"].as_array().unwrap();
    assert_eq!(running.len(), 1);
    assert_eq!(running[0]["worker"], json!("studio-mini"));
    assert_eq!(
        running[0]["command"],
        json!("sh -c 'echo started; sleep 30'")
    );
    assert_eq!(running[0]["session"], json!(c.session));
    assert_eq!(
        status["skips"],
        json!([{
            "worker": MAC_ID,
            "project": "shop",
            "reason": "not_approved",
            "detail": "this machine has not approved the project's heavy commands",
        }])
    );
    let _: bool = client
        .request("exec.cancel", json!({ "run": run }))
        .await
        .unwrap();
    collect(client, run).await;
    let status: Value = c.daemon.call("exec.status", json!({})).await;
    assert_eq!(status["running"], json!([]));
    // Other sessions' commands are not for an agent's CLI.
    let mut cli = Client::connect(&c.daemon.socket, "moonlet-cli")
        .await
        .unwrap();
    let e = cli
        .request::<_, Value>("exec.status", json!({}))
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "forbidden: only the moonlet app manages jobs"
    );
}
