//! Routed commands running on this machine (X62). `exec.run` starts one for
//! a `moonlet exec` connection, streams its output back as `RunOutput`
//! frames, and ends with `exec.exited`.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use moonlet_core::terminal::ClientId;
use moonlet_proto::methods::{self as m, ExecExited, ExecRunStarted};
use moonlet_proto::{Frame, Message, RpcError};
use nix::sys::signal::Signal;
use nix::unistd::Pid;
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

use crate::server::Conn;

/// How long a cancelled command has between SIGTERM and SIGKILL.
const GRACE: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct Runs {
    next: AtomicU32,
    /// Cancel signals of the runs going on, by connection and run.
    running: Mutex<HashMap<(ClientId, u32), Arc<Notify>>>,
}

/// What to run, already checked.
pub struct Command {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

impl Runs {
    /// Starts `cmd` for `conn`, as `host`.
    pub fn start(self: &Arc<Self>, conn: Arc<Conn>, host: String, cmd: Command) -> ExecRunStarted {
        let run = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = Arc::new(Notify::new());
        self.running
            .lock()
            .unwrap()
            .insert((conn.id, run), cancel.clone());
        let runs = self.clone();
        let started = ExecRunStarted {
            run,
            host: host.clone(),
        };
        tokio::spawn(async move {
            let send =
                |stream: u8, data: Vec<u8>| conn.tx.send(Frame::RunOutput { run, stream, data });
            send(2, format!("moonlet: running on {host}\n").into_bytes());
            let status = execute(&cmd, &conn, &cancel, &send).await;
            runs.running.lock().unwrap().remove(&(conn.id, run));
            let exited = ExecExited { run, status };
            conn.tx
                .send(Frame::Json(Message::event(m::EV_EXEC_EXITED, exited)));
        });
        started
    }

    /// Stops `run` of connection `conn`; false when there is no such run.
    pub fn cancel(&self, conn: ClientId, run: u32) -> bool {
        match self.running.lock().unwrap().get(&(conn, run)) {
            Some(n) => {
                n.notify_one();
                true
            }
            None => false,
        }
    }
}

/// Runs `cmd` to its end and returns its exit status. It stops the command
/// when the run is cancelled or `conn` goes away.
async fn execute(
    cmd: &Command,
    conn: &Conn,
    cancel: &Notify,
    send: &(impl Fn(u8, Vec<u8>) -> bool + Sync),
) -> i32 {
    let mut child = match tokio::process::Command::new(&cmd.argv[0])
        .args(&cmd.argv[1..])
        .current_dir(&cmd.cwd)
        .env_clear()
        .envs(&cmd.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Its own group, so stopping it reaches every process it starts.
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            send(
                2,
                format!("moonlet: cannot run {}: {e}\n", cmd.argv[0]).into_bytes(),
            );
            return 127;
        }
    };
    let group = child.id().map(|id| Pid::from_raw(id as i32));
    let stdout = pump(child.stdout.take(), 1, send);
    let stderr = pump(child.stderr.take(), 2, send);
    let wait = async {
        let mut stopping: Option<tokio::time::Instant> = None;
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        loop {
            tokio::select! {
                status = child.wait() => return status,
                _ = cancel.notified(), if stopping.is_none() => {
                    signal(group, Signal::SIGTERM);
                    stopping = Some(tokio::time::Instant::now());
                }
                _ = tick.tick() => {
                    if stopping.is_none() && conn.is_gone() {
                        signal(group, Signal::SIGTERM);
                        stopping = Some(tokio::time::Instant::now());
                    }
                    if stopping.is_some_and(|t| t.elapsed() >= GRACE) {
                        signal(group, Signal::SIGKILL);
                    }
                }
            }
        }
    };
    let (status, (), ()) = tokio::join!(wait, stdout, stderr);
    match status {
        Ok(s) => {
            use std::os::unix::process::ExitStatusExt;
            s.code().unwrap_or_else(|| 128 + s.signal().unwrap_or(0))
        }
        Err(e) => {
            send(2, format!("moonlet: lost the command: {e}\n").into_bytes());
            125
        }
    }
}

fn signal(group: Option<Pid>, sig: Signal) {
    if let Some(g) = group {
        let _ = nix::sys::signal::killpg(g, sig);
    }
}

/// Sends what `from` writes as `stream` until it closes.
async fn pump(
    from: Option<impl tokio::io::AsyncRead + Unpin>,
    stream: u8,
    send: &(impl Fn(u8, Vec<u8>) -> bool + Sync),
) {
    let Some(mut from) = from else { return };
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match from.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                send(stream, buf[..n].to_vec());
            }
        }
    }
}

/// The error `exec.run` gives a call it refuses.
pub fn refused(reason: &str) -> RpcError {
    RpcError::new("not_routable", reason.to_string())
}
