//! `moonletd`: the moonlet session daemon.
//!
//! * `moonletd daemon` runs the daemon in the foreground (launchd, tests).
//! * `moonletd start` starts it detached if it is not running.
//! * `moonletd proxy` bridges stdio to the daemon socket, starting the daemon
//!   first. Remote hosts are reached with `ssh host moonletd proxy`.
//! * `moonletd stop` / `moonletd status`.

mod clones;
mod cloud;
mod cloud_fake;
mod daemon;
mod exec;
mod heavy;
mod jobs;
mod launch;
mod link;
mod machines;
mod mobile;
mod notify;
mod render;
mod server;
mod service;
mod sync;
mod tailnet_cli;
mod upgrade;
mod workers;

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use moonlet_core::client::Client;
use moonlet_proto::methods;
use moonlet_proto::types::DaemonInfo;

#[derive(Parser)]
#[command(name = "moonletd", version, about = "moonlet session daemon")]
struct Cli {
    /// Socket path (defaults to ~/.moonlet/run/moonletd.sock).
    #[arg(long, env = "MOONLET_SOCK", global = true)]
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
enum TailnetAction {
    /// Let paired devices connect over the tailnet.
    On,
    /// Stop listening on the tailnet.
    Off,
    /// Print whether and where it listens.
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
    /// Start the daemon at login: a launchd LaunchAgent (macOS) or a systemd user unit (Linux).
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
    /// Tailnet access: other Macs and phones connect over Tailscale (X57).
    Tailnet {
        #[command(subcommand)]
        action: TailnetAction,
    },
    /// Pair this cloud machine with its central host and take heavy
    /// commands (X63); run by the machine's first-boot script.
    Join {
        /// The central host's tailnet addresses, comma-separated.
        addrs: String,
        /// The join code the central host made for this machine.
        code: String,
        /// This machine's name.
        #[arg(long)]
        name: String,
    },
    /// Show a one-time code that pairs a Mac or a phone with this host.
    Pair {
        /// The name to type on the other Mac, such as the host's MagicDNS
        /// name (the install script passes it); the host name otherwise.
        #[arg(long)]
        name: Option<String>,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    moonlet_core::paths::migrate_legacy_home();
    let socket = cli.socket.unwrap_or_else(moonlet_core::paths::socket_path);
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
            let mut c = Client::connect(&socket, "moonletd-status").await?;
            let info: DaemonInfo = c.request(methods::DAEMON_INFO, ()).await?;
            println!("{}", serde_json::to_string_pretty(&info)?);
            Ok(())
        }),
        Cmd::Tailnet { action } => rt.block_on(tailnet_cli::tailnet(
            &socket,
            match action {
                TailnetAction::On => Some(true),
                TailnetAction::Off => Some(false),
                TailnetAction::Status => None,
            },
        )),
        Cmd::Join { addrs, code, name } => rt.block_on(async {
            let mut c = Client::connect(&socket, "moonletd-join").await?;
            let join = methods::LinkJoin {
                addrs: addrs.split(',').map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect(),
                code,
                name,
            };
            let _: serde_json::Value = c.request(methods::LINK_JOIN, join).await?;
            Ok(())
        }),
        Cmd::Pair { name } => {
            let code = rt.block_on(tailnet_cli::pair(&socket, name))?;
            std::process::exit(code)
        }
        Cmd::Stop => rt.block_on(async {
            let mut c = Client::connect(&socket, "moonletd-stop").await?;
            let _: bool = c.request(methods::DAEMON_SHUTDOWN, ()).await?;
            Ok(())
        }),
    }
}

fn init_logging() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_env("MOONLET_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let log = moonlet_core::paths::log_file();
    if let Some(dir) = log.parent() {
        let _ = moonlet_core::paths::ensure_private_dir(dir);
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
    let fresh = handoff.is_none();
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
                tracing::info!(pid = std::process::id(), socket = %socket.display(), "moonletd listening");
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
                // Terminals get a freshly captured login environment, never
                // the old daemon's: an older daemon may have inherited
                // credentials from whatever started it.
                let env = tokio::task::spawn_blocking(launch::login_environment).await?;
                set_path(&env);
                let daemon = daemon::Daemon::new(socket.clone(), env);
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
                tracing::info!(pid = std::process::id(), "moonletd listening after upgrade");
                (listener, daemon)
            }
        };
        upgrade::write_pid(&socket);
        let chats = daemon.chats.restore();
        if chats > 0 {
            tracing::info!(chats, "restored structured agent conversations");
        }
        daemon.sessions.relink_terminals();
        // Before anything can ask, phones and the socket alike, so
        // `project.list` never lacks one (X41).
        daemon.sessions.fill_identities().await;
        let restored = daemon.sessions.restore_after_restart();
        if restored > 0 {
            tracing::info!(restored, "restarted workspace sessions after daemon restart");
        }
        let d = daemon.clone();
        // Registered before the daemon says it is ready, so an upgrade asked
        // for right after finds the handler.
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate())?;
        let mut usr2 = signal(SignalKind::user_defined2())?;
        tokio::spawn(async move {
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
        // Phones over Tailscale, when the user allows them (X39).
        mobile::spawn(daemon.clone());
        // Cloud machines: the sweep and the startup deadlines (X63).
        daemon.machines.start();
        // Live copies, before the link they may open (X60).
        sync::spawn(daemon.clone());
        // This Mac's link to its central host, when one is set (X41).
        link::spawn(daemon.clone());
        // A daemon that took over already told systemd (X58).
        if fresh {
            notify::ready();
        }
        server::serve(daemon, listener, socket).await
    })?;
    tracing::info!("moonletd stopped");
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
    let outdated = match Client::connect(&socket, "moonletd-proxy").await {
        Ok(c) => {
            !matches!(&c.welcome, moonlet_proto::Message::Welcome { daemon_version, .. } if daemon_version == env!("CARGO_PKG_VERSION"))
        }
        Err(_) => true,
    };
    if outdated
        && upgrade::pid_file(&socket).exists()
        && let Err(e) = upgrade::request_upgrade(&socket, std::env::current_exe()?).await
    {
        eprintln!("moonletd: upgrade of the running daemon failed: {e:#}");
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
