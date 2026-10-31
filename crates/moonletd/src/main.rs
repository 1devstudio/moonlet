//! `moonletd`: the moonlet session daemon.
//!
//! * `moonletd daemon` runs the daemon in the foreground (launchd, tests).
//! * `moonletd start` starts it detached if it is not running.
//! * `moonletd proxy` bridges stdio to the daemon socket, starting the daemon
//!   first. Remote hosts are reached with `ssh host moonletd proxy`.
//! * `moonletd stop` / `moonletd status`.

mod clones;
mod copied_files;
mod copies;
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
mod power;
mod session_copies;
mod signin;
mod sync;
mod tailnet_cli;
mod update;
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
    /// Check a release archive against `<archive>.sig` with moonlet's
    /// updater key (X69); the release workflow runs it.
    #[command(hide = true)]
    VerifyRelease { archive: PathBuf },
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
    // The release check needs no home, socket or runtime (X69).
    if let Some(Cmd::VerifyRelease { archive }) = &cli.cmd {
        return update::verify_file(archive);
    }
    moonlet_core::paths::migrate_legacy_home();
    let socket = cli.socket.unwrap_or_else(moonlet_core::paths::socket_path);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    match cli.cmd.unwrap_or(Cmd::Daemon { handoff: None }) {
        Cmd::Daemon { handoff } => run_daemon(rt, socket, handoff),
        Cmd::Upgrade => rt.block_on(upgrade::request_upgrade(&socket, std::env::current_exe()?)),
        Cmd::VerifyRelease { .. } => unreachable!("handled before the home is set up"),
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
            let mut c = tailnet_cli::connect_as_app(&socket, "moonletd-join").await?;
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
                // The app credential exists before anyone can connect, so the
                // app never reads a missing one (X75).
                if let Err(e) = moonlet_core::app_token::load_or_create(&moonlet_core::app_token::file()) {
                    tracing::error!("cannot keep the app credential: {e}");
                }
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
        update::clean_leftovers();
        let chats = daemon.chats.restore();
        if chats > 0 {
            tracing::info!(chats, "restored structured agent conversations");
        }
        daemon.sessions.relink_terminals();
        // Before anything can ask, phones and the socket alike, so
        // `project.list` never lacks one (X41).
        daemon.sessions.fill_identities().await;
        // Workspaces shared with the account's other members (X68), once
        // projects have the identities its sections name them by.
        link::attach_account(&daemon);
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
        // A design's snapshot when its agent ends a turn (X65).
        daemon.snapshot_agent_turns();
        // Design systems and designs follow a merged workspace (X71).
        daemon.follow_merges();
        // Design systems and designs on every member of the account (X71).
        daemon.keep_design_copies();
        daemon.keep_session_copies();
        // The Mac's sleep hands its sessions to the central host (X73).
        power::spawn(daemon.clone());
        // The session designs saved before a restart, watched again at once.
        daemon.watch_saved_session_designs();
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
        if forward_hello(&mut stdin, &mut sw).await.is_ok() {
            let _ = tokio::io::copy(&mut stdin, &mut sw).await;
        }
        let _ = tokio::io::AsyncWriteExt::shutdown(&mut sw).await;
    });
    let mut stdout = tokio::io::stdout();
    let _ = tokio::io::copy(&mut sr, &mut stdout).await;
    let _ = tokio::io::AsyncWriteExt::flush(&mut stdout).await;
    up.abort();
    Ok(())
}

/// Forwards the client's first frame. The Mac's app cannot read this host's
/// app credential (X75), so a `hello` from `moonlet-app` without one gets it
/// here: the proxy runs as the user, and the SSH login proved who that is.
/// Any other first frame, and any other client's `hello`, goes on unchanged.
async fn forward_hello(
    from: &mut (impl tokio::io::AsyncRead + Unpin),
    to: &mut (impl tokio::io::AsyncWrite + Unpin),
) -> std::io::Result<()> {
    use moonlet_proto::{Frame, Message};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut raw = vec![0u8; 4];
    from.read_exact(&mut raw).await?;
    let len = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
    if (1..=moonlet_proto::MAX_FRAME_LEN).contains(&len) {
        raw.resize(4 + len, 0);
        from.read_exact(&mut raw[4..]).await?;
    }
    let mut frames = moonlet_proto::FrameDecoder::new();
    frames.push(&raw);
    if let Ok(Some(Frame::Json(Message::Hello { protocol, client, app_token: None }))) =
        frames.next_frame()
        && client == daemon::APP_CLIENT
        && let Some(token) = moonlet_core::app_token::read(&moonlet_core::app_token::file())
        && let Ok(hello) = moonlet_proto::encode_frame(&Frame::Json(Message::Hello {
            protocol,
            client,
            app_token: Some(token),
        }))
    {
        raw = hello;
    }
    to.write_all(&raw).await
}
