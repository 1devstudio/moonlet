//! An agent reads a terminal of its own session (X31). Every read waits for
//! the user's answer in the app, unless the user allowed the session's reads
//! for good. The text is taken when the request arrives, so the agent gets
//! exactly what the user saw.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use moonlet_proto::Message;
use moonlet_proto::methods::{
    self, ReadAnswer, ReadDone, ReadGrant, ReadRequest, ReadResult, TerminalRead, TerminalRef,
};
use moonlet_proto::types::{TerminalInfo, TerminalKind};
use tokio::sync::{broadcast, oneshot};

use crate::terminal::TerminalManager;

/// Lines a read returns when the agent names no number.
pub const DEFAULT_LINES: usize = 200;
pub const MAX_LINES: usize = 2000;
/// How long a read waits for the user.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);

pub struct TerminalReads {
    terminals: Arc<TerminalManager>,
    pending: Mutex<BTreeMap<u64, (ReadRequest, oneshot::Sender<ReadAnswer>)>>,
    grants: Mutex<BTreeSet<String>>,
    next_id: AtomicU64,
    timeout: Duration,
}

impl TerminalReads {
    pub fn new(terminals: Arc<TerminalManager>, timeout: Duration) -> Self {
        Self {
            terminals,
            pending: Mutex::new(BTreeMap::new()),
            grants: Mutex::new(BTreeSet::new()),
            next_id: AtomicU64::new(1),
            timeout,
        }
    }

    /// The caller's session and the terminals of it an agent may read:
    /// shells, Run and Setup tabs, never agents.
    pub fn readable(&self, caller: u32) -> Result<(String, Vec<TerminalInfo>)> {
        let session = self
            .terminals
            .get(caller)
            .and_then(|t| t.info().session_id)
            .ok_or_else(|| anyhow!("this terminal is not in a session"))?;
        let list = self
            .terminals
            .list()
            .into_iter()
            .filter(|t| t.session_id.as_deref() == Some(session.as_str()))
            .filter(|t| !t.chat && matches!(t.kind, TerminalKind::Shell | TerminalKind::Run | TerminalKind::Setup))
            .collect();
        Ok((session, list))
    }

    /// Reads a terminal once the user allows it.
    pub async fn read(&self, req: TerminalRead) -> Result<ReadResult> {
        let (session, list) = self.readable(req.caller)?;
        if !list.iter().any(|t| t.id == req.id) {
            bail!("no terminal {} in this session", req.id);
        }
        let lines = req.lines.map(|n| n.clamp(1, MAX_LINES));
        let result = self.terminals.read_text(req.id, lines)?;
        if self.grants.lock().unwrap().contains(&session) {
            return Ok(result);
        }

        let request_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = ReadRequest {
            request_id,
            session_id: session.clone(),
            caller: req.caller,
            agent: self.terminals.get(req.caller).and_then(|t| t.info().agent),
            terminal_id: req.id,
            title: result.title.clone(),
            command: result.command.clone(),
            exit: result.exit,
            lines: result.lines,
            text: result.text.clone(),
        };
        // Subscribe before asking, so a tab closed right away is noticed.
        let mut events = self.terminals.subscribe_events();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(request_id, (request.clone(), tx));
        self.terminals.emit(Message::event(methods::EV_TERMINAL_READ_REQUEST, &request));

        let outcome = tokio::select! {
            answer = rx => answer.ok(),
            () = tokio::time::sleep(self.timeout) => None,
            () = removed(&self.terminals, &mut events, req.id) => {
                self.finish(request_id);
                bail!("terminal {} closed", req.id);
            }
        };
        self.finish(request_id);
        match outcome {
            Some(a) if a.allow => {
                if a.remember {
                    self.grants.lock().unwrap().insert(session.clone());
                    self.emit_grant(&session, true);
                }
                Ok(result)
            }
            Some(_) => bail!("the user declined to share terminal {}", req.id),
            None => bail!("the user did not answer; ask them to share the output"),
        }
    }

    /// The user's answer to a waiting request.
    pub fn answer(&self, answer: ReadAnswer) -> Result<()> {
        let (_, tx) = self
            .pending
            .lock()
            .unwrap()
            .remove(&answer.request_id)
            .ok_or_else(|| anyhow!("already answered"))?;
        let _ = tx.send(answer);
        Ok(())
    }

    /// Requests waiting for the user, oldest first.
    pub fn requests(&self) -> Vec<ReadRequest> {
        self.pending.lock().unwrap().values().map(|(r, _)| r.clone()).collect()
    }

    /// Sessions whose reads need no answer.
    pub fn grants(&self) -> Vec<String> {
        self.grants.lock().unwrap().iter().cloned().collect()
    }

    pub fn clear_grant(&self, session_id: &str) {
        if self.grants.lock().unwrap().remove(session_id) {
            self.emit_grant(session_id, false);
        }
    }

    fn finish(&self, request_id: u64) {
        self.pending.lock().unwrap().remove(&request_id);
        self.terminals
            .emit(Message::event(methods::EV_TERMINAL_READ_DONE, ReadDone { request_id }));
    }

    fn emit_grant(&self, session_id: &str, granted: bool) {
        self.terminals.emit(Message::event(
            methods::EV_TERMINAL_READ_GRANT,
            ReadGrant { session_id: session_id.to_string(), granted },
        ));
    }
}

/// Resolves when terminal `id` is removed (its tab closed).
async fn removed(terminals: &TerminalManager, events: &mut broadcast::Receiver<Message>, id: u32) {
    loop {
        if terminals.get(id).is_none() {
            return;
        }
        match events.recv().await {
            Ok(Message::Event { name, data }) if name == methods::EV_TERMINAL_REMOVED => {
                if serde_json::from_value::<TerminalRef>(data).is_ok_and(|r| r.id == id) {
                    return;
                }
            }
            // A lagged receiver may have missed the removal: check again.
            Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
            Err(broadcast::error::RecvError::Closed) => std::future::pending().await,
        }
    }
}
