//! `jauntd`: the jaunt session daemon.
//!
//! * `jauntd daemon` runs the daemon in the foreground (launchd, tests).
//! * `jauntd start` starts it detached if it is not running.
//! * `jauntd proxy` bridges stdio to the daemon socket, starting the daemon
//!   first. Remote hosts are reached with `ssh host jauntd proxy`.
//! * `jauntd stop` / `jauntd status`.

mod daemon;
mod launch;
mod server;
mod service;
mod upgrade;

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use jaunt_core::client::Client;
use jaunt_proto::methods;
use jaunt_proto::types::DaemonInfo;

#[derive(Parser)]
#[command(name = "jauntd", version, about = "jaunt session daemon")]
struct Cli {
    /// Socket path (defaults to ~/.jaunt/run/jauntd.sock).
    #[arg(long, env = "JAUNT_SOCK", global = true)]
    socket: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum ServiceAction {
    Install,
    Uninstall,
    Status,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the daemon in the foreground.
    Daemon {
        /// Take over sessions from a running daemon (used by `upgrade`).
        #[arg(long, hide = true)]
        handoff: Option<PathBuf>,
    },
    /// Replace the running daemon with this binary, keeping every session.
    Upgrade,
    /// Manage the launchd LaunchAgent (macOS).
    Service {
        #[command(subcommand)]
        action: ServiceAction,
    },
    /// Start the daemon in the background if needed.
    Start,
    /// Bridge stdin/stdout to the daemon socket.
    Proxy,
    /// Print daemon info as JSON.
    Status,
    /// Stop the daemon and every session it owns.
    Stop,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let socket = cli.socket.unwrap_or_else(jaunt_core::paths::socket_path);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    match cli.cmd.unwrap_or(Cmd::Daemon { handoff: None }) {
        Cmd::Daemon { handoff } => run_daemon(rt, socket, handoff),
        Cmd::Upgrade => rt.block_on(upgrade::request_upgrade(&socket, std::env::current_exe()?)),
        Cmd::Service { action } => {
            match action {
                ServiceAction::Install => service::install()?,
                ServiceAction::Uninstall => service::uninstall()?,
                ServiceAction::Status => {
                    println!("{}", serde_json::to_string_pretty(&service::status()?)?)
                }
            }
            Ok(())
        }
        Cmd::Start => rt.block_on(launch::ensure_running(&socket)),
        Cmd::Proxy => rt.block_on(proxy(socket)),
        Cmd::Status => rt.block_on(async {
            let mut c = Client::connect(&socket, "jauntd-status").await?;
            let info: DaemonInfo = c.request(methods::DAEMON_INFO, ()).await?;
            println!("{}", serde_json::to_string_pretty(&info)?);
            Ok(())
        }),
        Cmd::Stop => rt.block_on(async {
            let mut c = Client::connect(&socket, "jauntd-stop").await?;
            let _: bool = c.request(methods::DAEMON_SHUTDOWN, ()).await?;
            Ok(())
        }),
    }
}

fn init_logging() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_env("JAUNT_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let log = jaunt_core::paths::log_file();
    if let Some(dir) = log.parent() {
        let _ = jaunt_core::paths::ensure_private_dir(dir);
    }
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
    {
        Ok(file) => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_ansi(false)
            .with_writer(std::sync::Mutex::new(file))
            .init(),
        Err(_) => tracing_subscriber::fmt().with_env_filter(filter).init(),
    }
}

fn run_daemon(
    rt: tokio::runtime::Runtime,
    socket: PathBuf,
    handoff: Option<PathBuf>,
) -> Result<()> {
    init_logging();
    // A dead client must never kill the daemon.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }
    rt.block_on(async move {
        let (listener, daemon) = match handoff {
            None => {
                // Bind first so clients waiting for the socket never time out;
                // they queue in the backlog while the login env is captured.
                let listener = match server::bind(&socket).await {
                    Ok(l) => l,
                    Err(e) if e.to_string().contains("already listening") => {
                        // Not a failure: launchd must not keep restarting us.
                        tracing::info!("{e:#}; exiting");
                        std::process::exit(0);
                    }
                    Err(e) => {
                        tracing::error!("cannot listen: {e:#}");
                        return Err(e);
                    }
                };
                tracing::info!(pid = std::process::id(), socket = %socket.display(), "jauntd listening");
                let env = tokio::task::spawn_blocking(launch::login_environment).await?;
                set_path(&env);
                (listener, daemon::Daemon::new(socket.clone(), env))
            }
            Some(path) => {
                // Upgrade: take the PTYs first, then the socket once the old
                // daemon lets go of it.
                let incoming = tokio::task::spawn_blocking(move || upgrade::receive(&path))
                    .await?
                    .inspect_err(|e| tracing::error!("handoff failed: {e:#}"))?;
                let mut incoming = incoming;
                launch::scrub_agent_markers(&mut incoming.env);
                set_path(&incoming.env);
                let daemon = daemon::Daemon::new(socket.clone(), incoming.env.clone());
                let sessions = daemon.terminals.clone();
                tokio::task::spawn_blocking(move || upgrade::adopt(incoming, &sessions)).await??;
                let mut attempt = 0;
                let listener = loop {
                    match server::bind(&socket).await {
                        Ok(l) => break l,
                        Err(e) if attempt < 200 => {
                            attempt += 1;
                            tracing::debug!("waiting for the old daemon to release the socket: {e:#}");
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        }
                        Err(e) => return Err(e),
                    }
                };
                tracing::info!(pid = std::process::id(), "jauntd listening after upgrade");
                (listener, daemon)
            }
        };
        upgrade::write_pid();
        let chats = daemon.chats.restore();
        if chats > 0 {
            tracing::info!(chats, "restored structured agent conversations");
        }
        daemon.sessions.relink_terminals();
        let restored = daemon.sessions.restore_after_restart();
        if restored > 0 {
            tracing::info!(restored, "restarted workspace sessions after daemon restart");
        }
        let d = daemon.clone();
        tokio::spawn(async move {
            use tokio::signal::unix::{SignalKind, signal};
            let mut term = signal(SignalKind::terminate()).unwrap();
            let mut usr2 = signal(SignalKind::user_defined2()).unwrap();
            loop {
                tokio::select! {
                    _ = term.recv() => {
                        d.request_shutdown();
                        return;
                    }
                    _ = usr2.recv() => {
                        if let Err(e) = upgrade::hand_off(d.clone(), None).await {
                            tracing::error!("upgrade failed, still serving: {e:#}");
                        }
                    }
                }
            }
        });
        server::serve(daemon, listener, socket).await
    })?;
    tracing::info!("jauntd stopped");
    // After a handoff the PTYs live on in the new daemon; otherwise exiting
    // drops every PTY master and sessions end with SIGHUP.
    std::process::exit(0);
}

fn set_path(env: &std::collections::BTreeMap<String, String>) {
    if let Some(path) = env.get("PATH") {
        // SAFETY: called before any task reads the environment.
        unsafe { std::env::set_var("PATH", path) };
    }
}

async fn proxy(socket: PathBuf) -> Result<()> {
    launch::ensure_running(&socket).await?;
    // A freshly installed helper takes over from an older running daemon
    // before bridging, so remote upgrades never cost sessions (S3).
    let outdated = match Client::connect(&socket, "jauntd-proxy").await {
        Ok(c) => {
            !matches!(&c.welcome, jaunt_proto::Message::Welcome { daemon_version, .. } if daemon_version == env!("CARGO_PKG_VERSION"))
        }
        Err(_) => true,
    };
    if outdated
        && upgrade::pid_file().exists()
        && let Err(e) = upgrade::request_upgrade(&socket, std::env::current_exe()?).await
    {
        eprintln!("jauntd: upgrade of the running daemon failed: {e:#}");
    }
    let stream = tokio::net::UnixStream::connect(&socket).await?;
    let (mut sr, mut sw) = stream.into_split();
    // Stdin EOF only half-closes the socket: replies still in flight reach
    // stdout, and the proxy exits when the daemon closes the stream.
    let up = tokio::spawn(async move {
        let mut stdin = tokio::io::stdin();
        let _ = tokio::io::copy(&mut stdin, &mut sw).await;
        let _ = tokio::io::AsyncWriteExt::shutdown(&mut sw).await;
    });
    let mut stdout = tokio::io::stdout();
    let _ = tokio::io::copy(&mut sr, &mut stdout).await;
    let _ = tokio::io::AsyncWriteExt::flush(&mut stdout).await;
    up.abort();
    Ok(())
}
