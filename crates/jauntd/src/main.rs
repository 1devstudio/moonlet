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
enum Cmd {
    /// Run the daemon in the foreground.
    Daemon,
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
    match cli.cmd.unwrap_or(Cmd::Daemon) {
        Cmd::Daemon => run_daemon(rt, socket),
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

fn run_daemon(rt: tokio::runtime::Runtime, socket: PathBuf) -> Result<()> {
    init_logging();
    // A dead client must never kill the daemon.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }
    rt.block_on(async move {
        // Bind first so clients waiting for the socket never time out; they
        // queue in the backlog while the login environment is captured.
        let listener = server::bind(&socket)
            .await
            .inspect_err(|e| tracing::error!("cannot listen: {e:#}"))?;
        tracing::info!(pid = std::process::id(), socket = %socket.display(), "jauntd listening");
        let env = tokio::task::spawn_blocking(launch::login_environment).await?;
        if let Some(path) = env.get("PATH") {
            // SAFETY: no other task reads or writes the environment yet.
            unsafe { std::env::set_var("PATH", path) };
        }
        let daemon = daemon::Daemon::new(socket.clone(), env);
        let restored = daemon.workspaces.restore_after_restart();
        if restored > 0 {
            tracing::info!(
                restored,
                "restarted workspace sessions after daemon restart"
            );
        }
        let d = daemon.clone();
        tokio::spawn(async move {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            term.recv().await;
            d.request_shutdown();
        });
        server::serve(daemon, listener, socket).await
    })?;
    tracing::info!("jauntd stopped");
    // Exiting drops every PTY master; sessions end with SIGHUP.
    std::process::exit(0);
}

async fn proxy(socket: PathBuf) -> Result<()> {
    launch::ensure_running(&socket).await?;
    let stream = tokio::net::UnixStream::connect(&socket).await?;
    let (mut sr, mut sw) = stream.into_split();
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    tokio::select! {
        _ = tokio::io::copy(&mut stdin, &mut sw) => {}
        _ = async {
            let _ = tokio::io::copy(&mut sr, &mut stdout).await;
        } => {}
    }
    Ok(())
}
