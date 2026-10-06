//! `jaunt`: command-line companion to the jaunt app (A2, A6).
//!
//! Agent hooks call `jaunt hook claude|codex`; scripts use `jaunt notify`,
//! `jaunt ls`, `jaunt pane run` and `jaunt agent start`; agents open sessions
//! in other projects with `jaunt session new` (X22).

mod session;

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand, ValueEnum};
use jaunt_core::client::Client;
use jaunt_core::hooks::{self, HookPaths};
use jaunt_proto::TerminalId;
use jaunt_proto::methods::{self, AgentReport, SessionCreate, TerminalCreate, TerminalWrite};
use jaunt_proto::types::{AgentState, Project, Session, StateSource, TerminalInfo, TerminalKind};

#[derive(Parser)]
#[command(
    name = "jaunt",
    version,
    about = "Control jaunt sessions and agents from the shell"
)]
struct Cli {
    /// Daemon socket (defaults to $JAUNT_SOCK or ~/.jaunt/run/jauntd.sock).
    #[arg(long, env = "JAUNT_SOCK", global = true)]
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
        /// Session id (defaults to $JAUNT_TERMINAL_ID).
        #[arg(long, env = "JAUNT_TERMINAL_ID")]
        session: Option<TerminalId>,
    },
    /// Entry point for agent hooks. Never fails, so a missing daemon cannot break an agent.
    Hook {
        #[arg(value_enum)]
        agent: HookAgent,
        /// Payload passed as an argument (Codex); Claude Code uses stdin.
        payload: Option<String>,
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
    /// List the projects jaunt knows.
    Project {
        #[command(subcommand)]
        action: ProjectAction,
    },
    /// Open sessions (a worktree and an agent) and follow them.
    Session {
        #[command(subcommand)]
        action: SessionAction,
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
        /// Project id, path or name (see `jaunt project ls`).
        project: String,
        /// First message to the agent; also names the session.
        prompt: Vec<String>,
        /// Session name (defaults to the prompt's first line).
        #[arg(long)]
        name: Option<String>,
        /// New branch name (defaults to `jaunt/<name>`).
        #[arg(long)]
        branch: Option<String>,
        /// Start point (defaults to the project's base branch).
        #[arg(long)]
        from: Option<String>,
        /// Agent to start (defaults to the project's; `none` for a shell).
        #[arg(long)]
        agent: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        effort: Option<String>,
        /// Permission mode; inside a jaunt agent, no more permissive than its own.
        #[arg(long)]
        mode: Option<String>,
    },
}

#[derive(Subcommand)]
enum HooksAction {
    /// Add jaunt hooks to Claude Code and Codex settings.
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
    let socket = cli
        .socket
        .clone()
        .unwrap_or_else(jaunt_core::paths::socket_path);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    if let Cmd::Hook { agent, payload } = cli.cmd {
        // Hooks run inside every agent session, jaunt or not: stay silent and fast.
        let _ = rt.block_on(async {
            tokio::time::timeout(Duration::from_secs(2), hook(&socket, agent, payload)).await
        });
        return;
    }
    if let Err(e) = rt.block_on(run(cli.cmd, socket)) {
        eprintln!("jaunt: {e:#}");
        std::process::exit(1);
    }
}

async fn connect(socket: &std::path::Path) -> Result<Client> {
    Client::connect(socket, "jaunt-cli")
        .await
        .context("is the jaunt daemon running? (jauntd start)")
}

async fn hook(socket: &std::path::Path, agent: HookAgent, payload: Option<String>) -> Result<()> {
    // Terminals started before ADR 0005 still carry JAUNT_SESSION_ID.
    let Some(session) = ["JAUNT_TERMINAL_ID", "JAUNT_SESSION_ID"]
        .iter()
        .find_map(|k| {
            std::env::var(k)
                .ok()
                .and_then(|s| s.parse::<TerminalId>().ok())
        })
    else {
        return Ok(());
    };
    let raw = match payload {
        Some(p) => p,
        None => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s)?;
            s
        }
    };
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
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

async fn run(cmd: Cmd, socket: PathBuf) -> Result<()> {
    match cmd {
        Cmd::Hook { .. } => unreachable!(),
        Cmd::Notify {
            state,
            message,
            session,
        } => {
            // Terminals started before ADR 0005 still carry JAUNT_SESSION_ID.
            let session = session.or_else(|| std::env::var("JAUNT_SESSION_ID").ok().and_then(|v| v.parse().ok()));
            let Some(session) = session else {
                bail!("no session: run inside a jaunt pane or pass --session")
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
            let shell = jaunt_core::pty::user_shell();
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
                        spawned_by: terminal_from_env(),
                        cols: 120,
                        rows: 32,
                    },
                )
                .await?;
            println!("{}", serde_json::to_string_pretty(&created)?);
        }
    }
    Ok(())
}

fn terminal_from_env() -> Option<TerminalId> {
    std::env::var("JAUNT_TERMINAL_ID").ok().and_then(|v| v.parse().ok())
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
