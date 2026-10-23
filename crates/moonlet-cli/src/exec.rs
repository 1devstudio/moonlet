//! `moonlet exec` in a session (X62): asks the session's daemon to run the
//! command, prints its output as it comes and exits with its status.

use std::io::Write;
use std::path::Path;

use moonlet_core::client::Client;
use moonlet_proto::methods::{self, ExecCancel, ExecExited, ExecRun, ExecRunStarted};
use moonlet_proto::{Frame, Message, read_frame, write_frame};
use tokio::signal::unix::{SignalKind, signal};

/// Runs `argv` through the daemon at `socket` and returns its exit status,
/// or `None` when the daemon cannot be reached or will not run it.
pub async fn routed(socket: &Path, session: &str, argv: &[String]) -> Option<i32> {
    let mut c = Client::connect(socket, "moonlet-cli").await.ok()?;
    // Before the command starts, so it never runs here as well.
    let mut int = signal(SignalKind::interrupt()).ok()?;
    let mut term = signal(SignalKind::terminate()).ok()?;
    let run = ExecRun {
        session: session.to_string(),
        argv: argv.to_vec(),
        cwd: std::env::current_dir().ok()?.display().to_string(),
        env: std::env::vars().collect(),
        tool_use_id: None,
    };
    let started: ExecRunStarted = c.request(methods::EXEC_RUN, run).await.ok()?;
    let early = std::mem::take(&mut c.backlog);
    let (mut reader, mut writer) = tokio::io::split(c.into_stream());
    let (tx, mut frames) = tokio::sync::mpsc::unbounded_channel();
    for f in early {
        let _ = tx.send(Some(f));
    }
    // Frames are read in a task of their own, so a signal never interrupts
    // a frame half read.
    tokio::spawn(async move {
        loop {
            let f = read_frame(&mut reader).await.ok().flatten();
            let end = f.is_none();
            if tx.send(f).is_err() || end {
                return;
            }
        }
    });
    // Stopped, it exits as the signal says, whatever the command did.
    let mut cancelled: Option<i32> = None;
    loop {
        let frame = tokio::select! {
            f = frames.recv() => f.flatten(),
            _ = int.recv(), if cancelled.is_none() => { cancelled = Some(130); cancel(&mut writer, started.run).await; continue; }
            _ = term.recv(), if cancelled.is_none() => { cancelled = Some(143); cancel(&mut writer, started.run).await; continue; }
        };
        match frame {
            Some(Frame::RunOutput { run, stream, data }) if run == started.run => {
                let _ = if stream == 1 {
                    std::io::stdout()
                        .write_all(&data)
                        .and_then(|()| std::io::stdout().flush())
                } else {
                    std::io::stderr().write_all(&data)
                };
            }
            Some(Frame::Json(Message::Event { name, data })) if name == methods::EV_EXEC_EXITED => {
                if let Ok(e) = serde_json::from_value::<ExecExited>(data)
                    && e.run == started.run
                {
                    return Some(cancelled.unwrap_or(e.status));
                }
            }
            Some(_) => {}
            None => {
                eprintln!("moonlet: lost {}'s daemon during the run", started.host);
                return Some(125);
            }
        }
    }
}

async fn cancel(writer: &mut (impl tokio::io::AsyncWrite + Unpin), run: u32) {
    let request = Message::Request {
        id: u64::MAX,
        method: methods::EXEC_CANCEL.into(),
        params: serde_json::to_value(ExecCancel { run }).unwrap_or_default(),
    };
    let _ = write_frame(writer, &Frame::Json(request)).await;
}
