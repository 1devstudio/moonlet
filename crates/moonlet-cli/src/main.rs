//! `moonlet`: command-line companion to the moonlet app (A2, A6).
//!
//! Agent hooks call `moonlet hook claude|codex`; scripts use `moonlet notify`,
//! `moonlet ls`, `moonlet pane run` and `moonlet agent start`; agents open sessions
//! in other projects with `moonlet session new` (X22).

mod exec;
mod hook;
mod session;
mod term;

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand, ValueEnum};
use moonlet_core::client::Client;
use moonlet_core::hooks::{self, HookPaths};
use moonlet_proto::TerminalId;
use moonlet_proto::methods::{
    self, AgentReport, ChatSend, SessionCreate, TerminalCreate, TerminalRef, TerminalWrite,
};
use moonlet_proto::types::{
    AgentState, ChatState, Project, Session, StateSource, TerminalInfo, TerminalKind,
};

#[derive(Parser)]
#[command(
    name = "moonlet",
    version,
    about = "Control moonlet sessions and agents from the shell"
)]
struct Cli {
    /// Daemon socket (defaults to $MOONLET_SOCK or ~/.moonlet/run/moonletd.sock).
    #[arg(long, env = "MOONLET_SOCK", global = true)]
    socket: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Report agent state for the current pane.
    Notify {
        #[arg(long, value_enum)]
        state: StateArg,
        #[arg(long, short)]
        message: Option<String>,
        /// Session id (defaults to $MOONLET_TERMINAL_ID).
        #[arg(long, env = "MOONLET_TERMINAL_ID")]
        session: Option<TerminalId>,
    },
    /// Entry point for agent hooks. Never fails, so a missing daemon cannot break an agent.
    Hook {
        #[arg(value_enum)]
        agent: HookAgent,
        /// Payload passed as an argument (Codex); Claude Code uses stdin.
        payload: Option<String>,
    },
    /// Run a heavy command (X62). The `PreToolUse` hook rewrites an agent's
    /// approved heavy commands to this; with no central host to route it,
    /// the command runs here.
    Exec {
        /// The Claude Code tool call it runs for, so its job is found (X62).
        #[arg(long)]
        tool_use: Option<String>,
        /// The command and its arguments, after `--`.
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, required = true)]
        command: Vec<String>,
    },
    /// Install, inspect or remove agent hooks.
    Hooks {
        #[command(subcommand)]
        action: HooksAction,
    },
    /// List sessions.
    Ls {
        #[arg(long)]
        json: bool,
    },
    /// Interact with a pane.
    Pane {
        #[command(subcommand)]
        action: PaneAction,
    },
    /// Call any daemon method and print the JSON result (for scripts).
    Rpc {
        method: String,
        /// JSON params, e.g. '{"path": "~/code/app"}'.
        params: Option<String>,
    },
    /// Start agents.
    Agent {
        #[command(subcommand)]
        action: AgentAction,
    },
    /// List the projects moonlet knows.
    Project {
        #[command(subcommand)]
        action: ProjectAction,
    },
    /// Open sessions (a worktree and an agent) and follow them.
    Session {
        #[command(subcommand)]
        action: SessionAction,
    },
    /// Read the terminals of your session, with the user's approval (X31).
    Term {
        #[command(subcommand)]
        action: TermAction,
    },
}

#[derive(Subcommand)]
enum TermAction {
    /// List the terminals of your session you may read.
    Ls {
        #[arg(long)]
        json: bool,
    },
    /// Print a terminal's output once the user allows it.
    Read {
        id: TerminalId,
        /// The last N lines (default 200, at most 2000).
        #[arg(long)]
        lines: Option<usize>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum ProjectAction {
    /// List projects: name, base branch and path.
    Ls {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum SessionAction {
    /// Create a session in a project and start its agent with a prompt.
    /// Prints the session as JSON.
    New {
        /// Project id, path or name (see `moonlet project ls`).
        project: String,
        /// First message to the agent; also names the session.
        prompt: Vec<String>,
        /// Session name (defaults to the prompt's first line).
        #[arg(long)]
        name: Option<String>,
        /// New branch name (defaults to `moonlet/<name>`).
        #[arg(long)]
        branch: Option<String>,
        /// Start point (defaults to the project's base branch).
        #[arg(long)]
        from: Option<String>,
        /// Agent to start; `none` for a shell. Defaults to the project's,
        /// then, inside a moonlet agent, that agent, then `claude`.
        #[arg(long)]
        agent: Option<String>,
        /// Model; inside a moonlet agent of the same kind, defaults to its own.
        #[arg(long)]
        model: Option<String>,
        /// Effort; inside a moonlet agent of the same kind, defaults to its own.
        #[arg(long)]
        effort: Option<String>,
        /// Permission mode; inside a moonlet agent, no more permissive than its own.
        #[arg(long)]
        mode: Option<String>,
    },
    /// List live sessions with their agent's status and parent.
    Ls {
        #[arg(long)]
        json: bool,
    },
    /// Wait until the session's agent stops working; prints its status.
    Wait {
        id: String,
        /// Give up after this many seconds.
        #[arg(long, default_value_t = 1800)]
        timeout: u64,
    },
    /// Print the agent's last reply and any approvals it waits for.
    Read { id: String },
    /// Send a message to the session's agent.
    Send { id: String, text: Vec<String> },
}

#[derive(Subcommand)]
enum HooksAction {
    /// Add moonlet hooks to Claude Code and Codex settings.
    Install {
        #[arg(long)]
        no_claude: bool,
        #[arg(long)]
        no_codex: bool,
    },
    Status,
    Uninstall,
}

#[derive(Subcommand)]
enum PaneAction {
    /// Type a command into a pane and press Enter.
    Run {
        id: TerminalId,
        command: Vec<String>,
    },
}

#[derive(Subcommand)]
enum AgentAction {
    /// Start an agent in a directory.
    Start {
        #[arg(long, default_value = "claude")]
        agent: String,
        #[arg(long)]
        cwd: Option<PathBuf>,
        /// Initial prompt.
        prompt: Vec<String>,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum StateArg {
    Idle,
    Working,
    Blocked,
    Done,
    Error,
}

#[derive(Clone, Copy, ValueEnum)]
enum HookAgent {
    Claude,
    Codex,
}

impl From<StateArg> for AgentState {
    fn from(s: StateArg) -> Self {
        match s {
            StateArg::Idle => AgentState::Idle,
            StateArg::Working => AgentState::Working,
            StateArg::Blocked => AgentState::Blocked,
            StateArg::Done => AgentState::Done,
            StateArg::Error => AgentState::Error,
        }
    }
}

fn main() {
    let cli = Cli::parse();
    moonlet_core::paths::migrate_legacy_home();
    let socket = cli
        .socket
        .clone()
        .unwrap_or_else(moonlet_core::paths::socket_path);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    if let Cmd::Exec { command, tool_use } = &cli.cmd {
        // In a session, the session's daemon runs it (X62); anything it
        // refuses, or no daemon at all, runs here as without moonlet.
        if let Ok(session) = std::env::var("MOONLET_SESSION") {
            if let Some(status) = rt.block_on(exec::routed(&socket, &session, command, tool_use.clone())) {
                std::process::exit(status);
            }
        }
        exec_here(command);
    }
    if let Cmd::Hook { agent, payload } = cli.cmd {
        // Hooks run inside every agent session, moonlet or not: stay silent and fast.
        let _ = rt.block_on(async {
            tokio::time::timeout(Duration::from_secs(2), hook(&socket, agent, payload)).await
        });
        return;
    }
    if let Err(e) = rt.block_on(run(cli.cmd, socket)) {
        eprintln!("moonlet: {e:#}");
        std::process::exit(1);
    }
}

async fn connect(socket: &std::path::Path) -> Result<Client> {
    Client::connect(socket, "moonlet-cli")
        .await
        .context("is the moonlet daemon running? (moonletd start)")
}

/// Runs `command` in place of this process, as the shell would have.
fn exec_here(command: &[String]) -> ! {
    use std::os::unix::process::CommandExt;
    let e = std::process::Command::new(&command[0]).args(&command[1..]).exec();
    eprintln!("moonlet: cannot run {}: {e}", command[0]);
    std::process::exit(127);
}

async fn hook(socket: &std::path::Path, agent: HookAgent, payload: Option<String>) -> Result<()> {
    // Outside a moonlet session there is nothing to route or report, so
    // the payload is never read.
    if std::env::var_os("MOONLET_SESSION").is_none() && terminal_from_env().is_none() {
        return Ok(());
    }
    let raw = match payload {
        Some(p) => p,
        None => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s)?;
            s
        }
    };
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
    // Routing comes first: Claude Code waits for this answer (X62).
    if matches!(agent, HookAgent::Claude) {
        let _ = route(socket, &value).await;
    }
    let Some(session) = terminal_from_env() else {
        return Ok(());
    };
    let (mapped, name) = match agent {
        HookAgent::Claude => (hooks::map_claude_event(&value), "claude"),
        HookAgent::Codex => (hooks::map_codex_event(&value), "codex"),
    };
    let Some((state, message)) = mapped else {
        return Ok(());
    };
    let mut c = connect(socket).await?;
    let _: bool = c
        .request(
            methods::AGENT_REPORT,
            AgentReport {
                terminal: session,
                state,
                message,
                source: StateSource::Hook,
                agent: Some(name.into()),
            },
        )
        .await?;
    Ok(())
}

/// Prints the answer that sends an approved heavy command of an agent in a
/// session through `moonlet exec`; prints nothing otherwise.
async fn route(socket: &std::path::Path, payload: &serde_json::Value) -> Result<()> {
    let Ok(session) = std::env::var("MOONLET_SESSION") else {
        return Ok(());
    };
    let Some(ask) = hook::asks(payload) else {
        return Ok(());
    };
    let mut c = connect(socket).await?;
    let routed: methods::ExecRouted = c
        .request(
            methods::EXEC_ROUTE,
            methods::ExecRoute {
                session,
                command: ask.command,
                cwd: ask.cwd,
                tool_use_id: ask.tool_use_id,
            },
        )
        .await?;
    if routed.route {
        let moonlet = std::env::current_exe()?;
        println!("{}", hook::rewrite(payload, &moonlet.display().to_string()));
    }
    Ok(())
}

async fn run(cmd: Cmd, socket: PathBuf) -> Result<()> {
    match cmd {
        Cmd::Hook { .. } | Cmd::Exec { .. } => unreachable!(),
        Cmd::Notify {
            state,
            message,
            session,
        } => {
            let session = session.or_else(terminal_from_env);
            let Some(session) = session else {
                bail!("no session: run inside a moonlet pane or pass --session")
            };
            let mut c = connect(&socket).await?;
            let _: bool = c
                .request(
                    methods::AGENT_REPORT,
                    AgentReport {
                        terminal: session,
                        state: state.into(),
                        message,
                        source: StateSource::Hook,
                        agent: None,
                    },
                )
                .await?;
        }
        Cmd::Hooks { action } => {
            let paths = HookPaths::default_paths();
            let status = match action {
                HooksAction::Install {
                    no_claude,
                    no_codex,
                } => {
                    let bin = std::env::current_exe()?.canonicalize()?;
                    hooks::install(&paths, &bin, !no_claude, !no_codex)?
                }
                HooksAction::Status => hooks::status(&paths)?,
                HooksAction::Uninstall => hooks::uninstall(&paths)?,
            };
            println!("{}", serde_json::to_string_pretty(&status)?);
        }
        Cmd::Ls { json } => {
            let mut c = connect(&socket).await?;
            let list: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&list)?);
            } else {
                println!(
                    "{:>4}  {:<8} {:<9} {:<24} CWD",
                    "ID", "KIND", "STATE", "TITLE"
                );
                for s in list {
                    let state = if s.exit.is_some() {
                        "exited".to_string()
                    } else {
                        format!("{:?}", s.agent_state).to_lowercase()
                    };
                    println!(
                        "{:>4}  {:<8} {:<9} {:<24} {}",
                        s.id,
                        format!("{:?}", s.kind).to_lowercase(),
                        state,
                        s.title,
                        s.cwd
                    );
                }
            }
        }
        Cmd::Pane {
            action: PaneAction::Run { id, command },
        } => {
            let mut c = connect(&socket).await?;
            let _: bool = c
                .request(
                    methods::TERMINAL_WRITE,
                    TerminalWrite {
                        id,
                        data: format!("{}\r", command.join(" ")),
                    },
                )
                .await?;
        }
        Cmd::Term { action } => {
            let Some(caller) = terminal_from_env() else {
                bail!("term {} runs inside a moonlet terminal or agent", match action {
                    TermAction::Ls { .. } => "ls",
                    TermAction::Read { .. } => "read",
                });
            };
            let mut c = connect(&socket).await?;
            match action {
                TermAction::Ls { json } => {
                    let list: Vec<TerminalInfo> = c
                        .request(methods::TERMINAL_READ_LIST, TerminalRef { id: caller })
                        .await
                        .map_err(term::rpc_message)?;
                    if json {
                        println!("{}", serde_json::to_string_pretty(&list)?);
                    } else {
                        print!("{}", term::ls_table(&list));
                    }
                }
                TermAction::Read { id, lines, json } => {
                    // Waits for the user's answer in the app.
                    let read: methods::ReadResult = c
                        .request(methods::TERMINAL_READ, methods::TerminalRead { caller, id, lines })
                        .await
                        .map_err(term::rpc_message)?;
                    if json {
                        println!("{}", serde_json::to_string_pretty(&read)?);
                    } else if !read.text.is_empty() {
                        println!("{}", read.text);
                    }
                }
            }
        }
        Cmd::Rpc { method, params } => {
            let params: serde_json::Value = match params {
                Some(p) => serde_json::from_str(&p).context("params must be JSON")?,
                None => serde_json::json!({}),
            };
            let mut c = connect(&socket).await?;
            let out: serde_json::Value = c.request(&method, params).await?;
            println!("{}", serde_json::to_string_pretty(&out)?);
        }
        Cmd::Agent {
            action: AgentAction::Start { agent, cwd, prompt },
        } => {
            let cwd = cwd.map(Ok).unwrap_or_else(std::env::current_dir)?;
            let mut line = agent.clone();
            if !prompt.is_empty() {
                line.push(' ');
                line.push_str(&shell_quote(&prompt.join(" ")));
            }
            let shell = moonlet_core::pty::user_shell();
            let mut c = connect(&socket).await?;
            let info: TerminalInfo = c
                .request(
                    methods::TERMINAL_CREATE,
                    TerminalCreate {
                        cwd: cwd.display().to_string(),
                        command: vec![shell, "-lic".into(), line],
                        kind: TerminalKind::Agent,
                        agent: Some(agent),
                        cols: 120,
                        rows: 32,
                        ..Default::default()
                    },
                )
                .await?;
            println!("{}", info.id);
        }
        Cmd::Project {
            action: ProjectAction::Ls { json },
        } => {
            let mut c = connect(&socket).await?;
            let list: Vec<Project> = c.request(methods::PROJECT_LIST, ()).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&list)?);
            } else {
                println!("{:<20} {:<12} PATH", "NAME", "BASE");
                for p in list {
                    println!("{:<20} {:<12} {}", p.name, p.base_branch, p.path);
                }
            }
        }
        Cmd::Session {
            action:
                SessionAction::New {
                    project,
                    prompt,
                    name,
                    branch,
                    from,
                    agent,
                    model,
                    effort,
                    mode,
                },
        } => {
            let mut c = connect(&socket).await?;
            let projects: Vec<Project> = c.request(methods::PROJECT_LIST, ()).await?;
            let home = std::env::var("HOME").unwrap_or_default();
            let project = session::find_project(&projects, &project, &home)?;
            let prompt = prompt.join(" ");
            let created: Session = c
                .request(
                    methods::SESSION_CREATE,
                    SessionCreate {
                        project_id: project.id.clone(),
                        name,
                        branch,
                        from,
                        existing_branch: false,
                        agent,
                        prompt: Some(prompt).filter(|p| !p.trim().is_empty()),
                        model,
                        effort,
                        mode,
                        pr: None,
                        tui: false,
                        cloud: false,
                        spawned_by: terminal_from_env(),
                        workspace_id: None,
                        add_dirs: vec![],
                        task: None,
                        worktree: None,
                        cols: 120,
                        rows: 32,
                    },
                )
                .await?;
            println!("{}", serde_json::to_string_pretty(&created)?);
        }
        Cmd::Session {
            action: SessionAction::Ls { json },
        } => {
            let mut c = connect(&socket).await?;
            let sessions: Vec<Session> = c.request(methods::SESSION_LIST, ()).await?;
            let projects: Vec<Project> = c.request(methods::PROJECT_LIST, ()).await?;
            let mut rows = Vec::new();
            for s in sessions.into_iter().filter(|s| !s.archived) {
                let status = match session_agent(&mut c, &s.id).await {
                    Ok(t) => Some(chat_state(&mut c, t).await?.status),
                    Err(_) => None,
                };
                rows.push((s, status));
            }
            if json {
                let out: Vec<_> = rows
                    .iter()
                    .map(|(s, status)| serde_json::json!({"session": s, "status": status}))
                    .collect();
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("{:<13} {:<12} {:<9} {:<13} NAME", "ID", "PROJECT", "STATUS", "FROM");
                for (s, status) in rows {
                    let project = projects
                        .iter()
                        .find(|p| p.id == s.project_id)
                        .map_or("?", |p| p.name.as_str());
                    println!(
                        "{:<13} {:<12} {:<9} {:<13} {}",
                        s.id,
                        project,
                        status.as_deref().unwrap_or("-"),
                        s.spawned_by.as_deref().unwrap_or("-"),
                        // Names come from prompts an agent wrote.
                        moonlet_core::chat::strip_ansi(&s.name)
                    );
                }
            }
        }
        Cmd::Session {
            action: SessionAction::Wait { id, timeout },
        } => {
            let mut c = connect(&socket).await?;
            let agent = session_agent(&mut c, &id).await?;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
            loop {
                let st = chat_state(&mut c, agent).await?;
                if st.status != "working" {
                    println!("{}", st.status);
                    break;
                }
                if tokio::time::Instant::now() >= deadline {
                    bail!("timed out after {timeout}s; the agent is still working");
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
        Cmd::Session {
            action: SessionAction::Read { id },
        } => {
            let mut c = connect(&socket).await?;
            let agent = session_agent(&mut c, &id).await?;
            print!("{}", session::reply(&chat_state(&mut c, agent).await?));
        }
        Cmd::Session {
            action: SessionAction::Send { id, text },
        } => {
            let mut c = connect(&socket).await?;
            let agent = session_agent(&mut c, &id).await?;
            let _: bool = c
                .request(
                    methods::CHAT_SEND,
                    ChatSend {
                        id: agent,
                        text: text.join(" "),
                        images: vec![],
                    },
                )
                .await?;
        }
    }
    Ok(())
}

/// The session's agent: its first structured agent terminal.
async fn session_agent(c: &mut Client, id: &str) -> Result<TerminalId> {
    let sessions: Vec<Session> = c.request(methods::SESSION_LIST, ()).await?;
    let s = sessions
        .iter()
        .find(|s| s.id == id)
        .with_context(|| format!("no session \"{id}\""))?;
    let terminals: Vec<TerminalInfo> = c.request(methods::TERMINAL_LIST, ()).await?;
    s.terminals
        .iter()
        .copied()
        .find(|t| {
            terminals
                .iter()
                .any(|i| i.id == *t && i.chat && i.kind == TerminalKind::Agent)
        })
        .with_context(|| format!("session \"{id}\" has no structured agent"))
}

async fn chat_state(c: &mut Client, id: TerminalId) -> Result<ChatState> {
    c.request(methods::CHAT_STATE, TerminalRef { id }).await
}

/// The terminal this command runs in. Terminals jaunt opened carry
/// `JAUNT_TERMINAL_ID` (X27), and those from before ADR 0005
/// `JAUNT_SESSION_ID`.
fn terminal_from_env() -> Option<TerminalId> {
    ["MOONLET_TERMINAL_ID", "JAUNT_TERMINAL_ID", "JAUNT_SESSION_ID"]
        .iter()
        .find_map(|k| std::env::var(k).ok().and_then(|v| v.parse().ok()))
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
