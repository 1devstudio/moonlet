//! Sessions: a PTY, its process, its terminal state and the clients
//! attached to it (S1, S2). Sessions belong to the daemon, never to a
//! client, so they outlive every connection.

use std::collections::{BTreeMap, HashMap};
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use jaunt_proto::methods::{self, Attention, SessionCreate};
use jaunt_proto::types::{AgentState, ExitInfo, SessionInfo, SessionKind, StateSource};
use jaunt_proto::{Frame, Message, SessionId};
use tokio::io::unix::AsyncFd;
use tokio::sync::{broadcast, mpsc};

use crate::agent::{AgentTracker, detect_agent, needs_attention};
use crate::paths::now_ms;
use crate::pty::{Pty, SpawnSpec, user_shell};
use crate::term::{Signal, TermState};

pub type ClientId = u64;

/// Outbound queue of one client connection.
pub type ClientTx = mpsc::UnboundedSender<Frame>;

struct SessionState {
    info: SessionInfo,
    term: TermState,
    pty: Option<Pty>,
    subscribers: HashMap<ClientId, ClientTx>,
    agent: AgentTracker,
    last_output: Instant,
    remove_on_exit: bool,
}

pub struct Session {
    pub id: SessionId,
    state: Mutex<SessionState>,
    input: mpsc::UnboundedSender<Vec<u8>>,
    /// Reader/writer tasks; aborted before a handoff so this process stops
    /// consuming PTY output the next daemon must see.
    tasks: Mutex<Vec<tokio::task::AbortHandle>>,
}

impl Session {
    pub fn info(&self) -> SessionInfo {
        self.state.lock().unwrap().info.clone()
    }
}

pub struct SessionManager {
    sessions: Mutex<BTreeMap<SessionId, Arc<Session>>>,
    next_id: AtomicU32,
    next_client: AtomicU64,
    events: broadcast::Sender<Message>,
    socket: PathBuf,
    base_env: BTreeMap<String, String>,
}

impl SessionManager {
    pub fn new(socket: PathBuf, base_env: BTreeMap<String, String>) -> Arc<Self> {
        let (events, _) = broadcast::channel(1024);
        let mgr = Arc::new(Self {
            sessions: Mutex::new(BTreeMap::new()),
            next_id: AtomicU32::new(1),
            next_client: AtomicU64::new(1),
            events,
            socket,
            base_env,
        });
        tokio::spawn(quiet_watcher(Arc::downgrade(&mgr)));
        mgr
    }

    /// Environment every session starts from (the captured login env).
    pub fn base_env(&self) -> &BTreeMap<String, String> {
        &self.base_env
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<Message> {
        self.events.subscribe()
    }

    pub fn emit(&self, message: Message) {
        let _ = self.events.send(message);
    }

    pub fn new_client_id(&self) -> ClientId {
        self.next_client.fetch_add(1, Ordering::Relaxed)
    }

    pub fn get(&self, id: SessionId) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(&id).cloned()
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| s.info())
            .collect()
    }

    pub fn len(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn create(self: &Arc<Self>, req: SessionCreate) -> Result<SessionInfo> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let shell = user_shell();
        let default_shell = req.command.is_empty();
        let (program, args) = if default_shell {
            (shell.clone(), vec!["-l".to_string()])
        } else {
            (req.command[0].clone(), req.command[1..].to_vec())
        };
        let cwd = expand_home(&req.cwd);
        if !cwd.is_dir() {
            bail!("working directory does not exist: {}", cwd.display());
        }

        let mut env = self.base_env.clone();
        env.insert("TERM".into(), "xterm-256color".into());
        env.insert("COLORTERM".into(), "truecolor".into());
        env.insert("TERM_PROGRAM".into(), "jaunt".into());
        env.insert(
            "TERM_PROGRAM_VERSION".into(),
            env!("CARGO_PKG_VERSION").into(),
        );
        env.insert("JAUNT_SESSION_ID".into(), id.to_string());
        env.insert("JAUNT_SOCK".into(), self.socket.display().to_string());
        env.entry("SHELL".into()).or_insert(shell);
        env.entry("LANG".into())
            .or_insert_with(|| "en_US.UTF-8".into());
        if let Some(ws) = &req.workspace_id {
            env.insert("JAUNT_WORKSPACE_ID".into(), ws.clone());
        }
        env.extend(req.env.clone());

        // Interactive shells get prompt marks and cwd reporting (T3).
        let args = if default_shell {
            crate::shell::apply(&crate::shell::dir(), &program, args, &mut env)
        } else {
            args
        };
        let pty = Pty::spawn(SpawnSpec {
            program: program.clone().into(),
            args: args.iter().map(Into::into).collect(),
            cwd: cwd.clone(),
            env,
            cols: req.cols,
            rows: req.rows,
        })
        .with_context(|| format!("failed to start {program}"))?;

        let mut command = vec![program];
        command.extend(args);
        let agent = req.agent.clone().or_else(|| {
            if req.kind == SessionKind::Agent {
                detect_agent(command.last().map(String::as_str).unwrap_or("")).map(String::from)
            } else {
                None
            }
        });
        let now = now_ms();
        let info = SessionInfo {
            id,
            kind: req.kind,
            title: req.title.clone().unwrap_or_else(|| default_title(&command)),
            cwd: cwd.display().to_string(),
            command,
            workspace_id: req.workspace_id.clone(),
            agent,
            agent_state: AgentState::Idle,
            agent_message: None,
            cols: req.cols,
            rows: req.rows,
            pid: Some(pty.pid()),
            exit: None,
            reported_cwd: None,
            created_at: now,
            last_output_at: now,
        };
        self.install(info.clone(), TermState::new(req.rows, req.cols), pty)?;
        self.emit(Message::event(methods::EV_SESSION_CREATED, &info));
        Ok(info)
    }

    /// Registers a running PTY (fresh or adopted) and starts its I/O tasks.
    pub fn install(self: &Arc<Self>, info: SessionInfo, term: TermState, pty: Pty) -> Result<()> {
        let id = info.id;
        self.next_id.fetch_max(id + 1, Ordering::Relaxed);
        let reader_fd = pty.clone_master()?;
        let writer_fd = pty.clone_master()?;
        let (input_tx, input_rx) = mpsc::unbounded_channel();
        let session = Arc::new(Session {
            id,
            input: input_tx,
            tasks: Mutex::new(Vec::new()),
            state: Mutex::new(SessionState {
                info,
                term,
                pty: Some(pty),
                subscribers: HashMap::new(),
                agent: AgentTracker::default(),
                last_output: Instant::now(),
                remove_on_exit: false,
            }),
        });
        self.sessions.lock().unwrap().insert(id, session.clone());
        let w = tokio::spawn(write_loop(writer_fd, input_rx)).abort_handle();
        let r = tokio::spawn(read_loop(Arc::downgrade(self), session.clone(), reader_fd))
            .abort_handle();
        session.tasks.lock().unwrap().extend([w, r]);
        Ok(())
    }

    /// Installs a PTY received from a previous daemon (S3): the terminal
    /// state is rebuilt by replaying its snapshot, the agent state carries over.
    pub fn adopt(
        self: &Arc<Self>,
        info: SessionInfo,
        rows: u16,
        cols: u16,
        snapshot: &[u8],
        fd: std::os::fd::RawFd,
    ) -> Result<()> {
        let pid = info.pid.context("adopted session has no pid")?;
        // SAFETY: the fd was received via SCM_RIGHTS and is owned by us now.
        let pty = unsafe { Pty::adopt(fd, pid)? };
        let mut term = TermState::new(rows, cols);
        term.process(snapshot);
        let id = info.id;
        let (state, message) = (info.agent_state, info.agent_message.clone());
        self.install(info, term, pty)?;
        if let Some(s) = self.get(id) {
            let mut st = s.state.lock().unwrap();
            st.agent.report(state, StateSource::Process, message);
        }
        Ok(())
    }

    /// Returns the snapshot and subscribes `client` atomically, so live output
    /// continues exactly where the snapshot ends.
    pub fn attach(
        &self,
        id: SessionId,
        client: ClientId,
        tx: ClientTx,
        size: Option<(u16, u16)>,
    ) -> Result<(SessionInfo, Vec<u8>)> {
        let session = self.get(id).context("no such session")?;
        let mut st = session.state.lock().unwrap();
        if let Some((cols, rows)) = size {
            resize_locked(&mut st, cols, rows);
        }
        let snapshot = st.term.snapshot();
        st.subscribers.insert(client, tx);
        Ok((st.info.clone(), snapshot))
    }

    pub fn detach(&self, id: SessionId, client: ClientId) {
        if let Some(s) = self.get(id) {
            s.state.lock().unwrap().subscribers.remove(&client);
        }
    }

    pub fn detach_all(&self, client: ClientId) {
        for s in self.sessions.lock().unwrap().values() {
            s.state.lock().unwrap().subscribers.remove(&client);
        }
    }

    pub fn write(&self, id: SessionId, data: Vec<u8>) -> Result<()> {
        let s = self.get(id).context("no such session")?;
        s.input.send(data).ok().context("session input closed")
    }

    pub fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<()> {
        let s = self.get(id).context("no such session")?;
        let mut st = s.state.lock().unwrap();
        resize_locked(&mut st, cols, rows);
        let info = st.info.clone();
        drop(st);
        self.emit(Message::event(methods::EV_SESSION_UPDATED, &info));
        Ok(())
    }

    pub fn kill(&self, id: SessionId, remove: bool) -> Result<()> {
        let s = self.get(id).context("no such session")?;
        let exited = {
            let st = s.state.lock().unwrap();
            if let Some(pty) = &st.pty {
                let _ = pty.signal(nix::sys::signal::Signal::SIGHUP);
            }
            st.info.exit.is_some()
        };
        if !exited {
            // Some programs (agents included) ignore SIGHUP: escalate.
            let weak = Arc::downgrade(&s);
            tokio::spawn(async move {
                for (delay, sig) in [
                    (1500, nix::sys::signal::Signal::SIGTERM),
                    (3000, nix::sys::signal::Signal::SIGKILL),
                ] {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    let Some(s) = weak.upgrade() else { return };
                    let st = s.state.lock().unwrap();
                    if st.info.exit.is_some() {
                        return;
                    }
                    if let Some(pty) = &st.pty {
                        let _ = pty.signal(sig);
                    }
                }
            });
        }
        if remove {
            if exited {
                self.remove(id);
            } else {
                // Removed by the read loop once the process is gone.
                s.state.lock().unwrap().remove_on_exit = true;
            }
        }
        Ok(())
    }

    pub fn remove(&self, id: SessionId) {
        if self.sessions.lock().unwrap().remove(&id).is_some() {
            self.emit(Message::event(
                methods::EV_SESSION_REMOVED,
                methods::SessionRef { id },
            ));
        }
    }

    pub fn report(
        &self,
        id: SessionId,
        state: AgentState,
        source: StateSource,
        message: Option<String>,
        agent: Option<String>,
    ) -> Result<()> {
        let s = self.get(id).context("no such session")?;
        let mut st = s.state.lock().unwrap();
        if st.info.agent.is_none() {
            st.info.agent = agent.or(Some("agent".into()));
            st.info.kind = SessionKind::Agent;
        }
        if st.agent.report(state, source, message) {
            self.publish_agent(&mut st);
        }
        Ok(())
    }

    fn publish_agent(&self, st: &mut SessionState) {
        st.info.agent_state = st.agent.state;
        st.info.agent_message = st.agent.message.clone();
        self.emit(Message::event(methods::EV_SESSION_UPDATED, &st.info));
        if needs_attention(st.agent.state) {
            self.emit(Message::event(
                methods::EV_AGENT_ATTENTION,
                Attention {
                    session: st.info.id,
                    workspace_id: st.info.workspace_id.clone(),
                    state: st.agent.state,
                    title: st.info.title.clone(),
                    message: st.agent.message.clone(),
                },
            ));
        }
    }

    pub fn search(
        &self,
        id: SessionId,
        query: &str,
        regex: bool,
        case_sensitive: bool,
    ) -> Result<Vec<methods::SearchHit>> {
        let s = self.get(id).context("no such session")?;
        let lines = s.state.lock().unwrap().term.all_lines();
        let pattern = if regex {
            query.to_string()
        } else {
            regex::escape(query)
        };
        let re = regex::RegexBuilder::new(&pattern)
            .case_insensitive(!case_sensitive)
            .build()?;
        Ok(lines
            .into_iter()
            .enumerate()
            .filter(|(_, l)| re.is_match(l))
            .map(|(line, text)| methods::SearchHit { line, text })
            .collect())
    }

    /// Everything needed to hand live sessions to a new daemon process.
    /// Subscribers are dropped; clients reattach to the new daemon.
    pub fn export(&self) -> Vec<ExportedSession> {
        let sessions = self.sessions.lock().unwrap();
        let mut out = Vec::new();
        for s in sessions.values() {
            for t in s.tasks.lock().unwrap().drain(..) {
                t.abort();
            }
            let mut st = s.state.lock().unwrap();
            if st.info.exit.is_some() {
                continue;
            }
            let Some(pty) = st.pty.as_mut() else { continue };
            pty.forget_child();
            let fd = pty.master_fd();
            let (rows, cols) = st.term.size();
            let snapshot = String::from_utf8_lossy(&st.term.snapshot()).into_owned();
            out.push(ExportedSession {
                info: st.info.clone(),
                fd,
                rows,
                cols,
                snapshot,
            });
        }
        out
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ExportedSession {
    pub info: SessionInfo,
    #[serde(skip)]
    pub fd: std::os::fd::RawFd,
    pub rows: u16,
    pub cols: u16,
    pub snapshot: String,
}

fn resize_locked(st: &mut SessionState, cols: u16, rows: u16) {
    if (st.info.cols, st.info.rows) == (cols, rows) {
        return;
    }
    st.info.cols = cols;
    st.info.rows = rows;
    st.term.resize(rows, cols);
    if let Some(pty) = &st.pty {
        let _ = pty.resize(cols, rows);
    }
}

fn default_title(command: &[String]) -> String {
    let last = command.last().map(String::as_str).unwrap_or("shell");
    let word = if command.len() >= 3
        && command[command.len() - 2].ends_with('c')
        && command[command.len() - 2].starts_with('-')
    {
        last.split_whitespace().next().unwrap_or(last)
    } else if command.len() <= 2 {
        command.first().map(String::as_str).unwrap_or("shell")
    } else {
        last
    };
    word.rsplit('/').next().unwrap_or(word).to_string()
}

pub fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~")
        && let Some(home) = dirs::home_dir()
    {
        return home.join(rest.trim_start_matches('/'));
    }
    PathBuf::from(path)
}

async fn write_loop(fd: OwnedFd, mut rx: mpsc::UnboundedReceiver<Vec<u8>>) {
    let Ok(fd) = AsyncFd::new(fd) else { return };
    while let Some(data) = rx.recv().await {
        let mut off = 0;
        while off < data.len() {
            let Ok(mut guard) = fd.writable().await else {
                return;
            };
            match guard.try_io(|inner| {
                let n = unsafe {
                    libc::write(
                        inner.get_ref().as_raw_fd(),
                        data[off..].as_ptr().cast(),
                        data.len() - off,
                    )
                };
                if n < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(n as usize)
                }
            }) {
                Ok(Ok(n)) => off += n,
                Ok(Err(_)) => return,
                Err(_would_block) => continue,
            }
        }
    }
}

async fn read_loop(mgr: std::sync::Weak<SessionManager>, session: Arc<Session>, fd: OwnedFd) {
    let fd = match AsyncFd::new(fd) {
        Ok(fd) => fd,
        Err(e) => {
            tracing::error!(session = session.id, "cannot watch pty: {e}");
            return;
        }
    };
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let Ok(mut guard) = fd.readable().await else {
            break;
        };
        let res = guard.try_io(|inner| {
            let n = unsafe {
                libc::read(
                    inner.get_ref().as_raw_fd(),
                    buf.as_mut_ptr().cast(),
                    buf.len(),
                )
            };
            if n < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(n as usize)
            }
        });
        let n = match res {
            Err(_would_block) => continue,
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => n,
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Ok(Err(_)) => break, // EIO: slave side closed.
        };
        let Some(mgr) = mgr.upgrade() else { return };
        on_output(&mgr, &session, &buf[..n]);
    }
    let Some(mgr) = mgr.upgrade() else { return };
    let exit = wait_exit(&session).await;
    let (info, remove) = {
        let mut st = session.state.lock().unwrap();
        st.info.exit = Some(exit.clone());
        st.info.pid = None;
        let remove = st.remove_on_exit;
        let is_agent = st.info.kind == SessionKind::Agent;
        let failed = exit.code.is_some_and(|c| c != 0) || exit.signal.is_some();
        if is_agent {
            let state = if failed {
                AgentState::Error
            } else {
                AgentState::Done
            };
            let msg = Some(match (exit.code, exit.signal) {
                (Some(c), _) => format!("exited with code {c}"),
                (_, Some(s)) => format!("killed by signal {s}"),
                _ => "exited".into(),
            });
            if st.agent.report(state, StateSource::Process, msg) {
                mgr.publish_agent(&mut st);
            }
        }
        (st.info.clone(), remove)
    };
    mgr.emit(Message::event(methods::EV_SESSION_EXITED, &info));
    if remove {
        mgr.remove(info.id);
    }
}

async fn wait_exit(session: &Arc<Session>) -> ExitInfo {
    for _ in 0..200 {
        {
            let mut st = session.state.lock().unwrap();
            let Some(pty) = st.pty.as_mut() else { break };
            if let Some((code, signal)) = pty.try_wait() {
                return ExitInfo { code, signal };
            }
            if !pty.is_alive() {
                return ExitInfo {
                    code: None,
                    signal: None,
                };
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    ExitInfo {
        code: None,
        signal: None,
    }
}

fn on_output(mgr: &SessionManager, session: &Session, data: &[u8]) {
    let mut st = session.state.lock().unwrap();
    let now = Instant::now();
    st.last_output = now;
    st.info.last_output_at = now_ms();
    let signals = st.term.process(data);
    st.subscribers.retain(|_, tx| {
        tx.send(Frame::Output {
            session: session.id,
            data: data.to_vec(),
        })
        .is_ok()
    });

    let mut info_changed = false;
    let mut agent_changed = false;
    for signal in signals {
        match signal {
            Signal::Title(t) if !t.is_empty() && st.info.kind != SessionKind::Agent => {
                st.info.title = t;
                info_changed = true;
            }
            Signal::Cwd(cwd) => {
                st.info.reported_cwd = Some(cwd);
                info_changed = true;
            }
            Signal::Notify { title, body } if st.info.kind == SessionKind::Agent => {
                let msg = Some(match title {
                    Some(t) if !t.is_empty() => format!("{t}: {body}"),
                    _ => body,
                });
                agent_changed |= st
                    .agent
                    .report(AgentState::Blocked, StateSource::Terminal, msg);
            }
            Signal::Bell if st.info.kind == SessionKind::Agent => {
                agent_changed |= st
                    .agent
                    .report(AgentState::Blocked, StateSource::Heuristic, None);
            }
            _ => {}
        }
    }
    if st.info.kind == SessionKind::Agent && !agent_changed {
        agent_changed = st.agent.on_output(now);
    }
    if agent_changed {
        mgr.publish_agent(&mut st);
    } else if info_changed {
        mgr.emit(Message::event(methods::EV_SESSION_UPDATED, &st.info));
    }
}

/// Flips hook-less agent sessions back to idle after output stops.
async fn quiet_watcher(mgr: std::sync::Weak<SessionManager>) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tick.tick().await;
        let Some(mgr) = mgr.upgrade() else { return };
        let sessions: Vec<_> = mgr.sessions.lock().unwrap().values().cloned().collect();
        let now = Instant::now();
        for s in sessions {
            let mut st = s.state.lock().unwrap();
            if st.info.kind == SessionKind::Agent
                && now.duration_since(st.last_output) > Duration::from_secs(4)
                && st.agent.on_quiet(now)
            {
                mgr.publish_agent(&mut st);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> Arc<SessionManager> {
        let env: BTreeMap<String, String> = std::env::vars().collect();
        SessionManager::new(PathBuf::from("/tmp/jaunt-test.sock"), env)
    }

    async fn read_until(rx: &mut mpsc::UnboundedReceiver<Frame>, needle: &str) -> String {
        let mut seen = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !seen.contains(needle) {
            let frame = tokio::time::timeout_at(deadline, rx.recv())
                .await
                .expect("timed out")
                .expect("closed");
            if let Frame::Output { data, .. } = frame {
                seen.push_str(&String::from_utf8_lossy(&data));
            }
        }
        seen
    }

    #[tokio::test]
    async fn runs_a_command_and_reports_exit() {
        let mgr = manager();
        let mut events = mgr.subscribe_events();
        let info = mgr
            .create(SessionCreate {
                cwd: "/tmp".into(),
                command: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "echo hi-$JAUNT_SESSION_ID; exit 3".into(),
                ],
                cols: 80,
                rows: 24,
                ..Default::default()
            })
            .unwrap();
        loop {
            let ev = tokio::time::timeout(Duration::from_secs(10), events.recv())
                .await
                .unwrap()
                .unwrap();
            if let Message::Event { name, data } = ev
                && name == methods::EV_SESSION_EXITED
            {
                let exited: SessionInfo = serde_json::from_value(data).unwrap();
                assert_eq!(exited.exit.unwrap().code, Some(3));
                break;
            }
        }
        let s = mgr.get(info.id).unwrap();
        assert!(
            s.state
                .lock()
                .unwrap()
                .term
                .contents()
                .contains(&format!("hi-{}", info.id))
        );
    }

    #[tokio::test]
    async fn attach_replays_screen_then_streams_live_output() {
        let mgr = manager();
        let info = mgr
            .create(SessionCreate {
                cwd: "/tmp".into(),
                command: vec!["/bin/cat".into()],
                cols: 40,
                rows: 10,
                ..Default::default()
            })
            .unwrap();
        mgr.write(info.id, b"first\n".to_vec()).unwrap();
        // Wait until the echo reaches the emulator.
        for _ in 0..200 {
            if mgr
                .get(info.id)
                .unwrap()
                .state
                .lock()
                .unwrap()
                .term
                .contents()
                .contains("first")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (_, snapshot) = mgr.attach(info.id, 1, tx, None).unwrap();
        assert!(String::from_utf8_lossy(&snapshot).contains("first"));
        mgr.write(info.id, b"second\n".to_vec()).unwrap();
        let live = read_until(&mut rx, "second").await;
        assert!(!live.contains("first"), "no duplicate of pre-attach output");
        mgr.kill(info.id, true).unwrap();
    }

    #[tokio::test]
    async fn hook_reports_raise_attention() {
        let mgr = manager();
        let mut events = mgr.subscribe_events();
        let info = mgr
            .create(SessionCreate {
                cwd: "/tmp".into(),
                command: vec!["/bin/sleep".into(), "5".into()],
                kind: SessionKind::Agent,
                ..Default::default()
            })
            .unwrap();
        mgr.report(
            info.id,
            AgentState::Blocked,
            StateSource::Hook,
            Some("Allow Bash?".into()),
            Some("claude".into()),
        )
        .unwrap();
        loop {
            let ev = tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .unwrap()
                .unwrap();
            if let Message::Event { name, data } = ev
                && name == methods::EV_AGENT_ATTENTION
            {
                let a: Attention = serde_json::from_value(data).unwrap();
                assert_eq!(a.state, AgentState::Blocked);
                assert_eq!(a.message.as_deref(), Some("Allow Bash?"));
                break;
            }
        }
        mgr.kill(info.id, true).unwrap();
    }

    #[tokio::test]
    async fn kill_escalates_when_sighup_is_ignored() {
        let mgr = manager();
        let info = mgr
            .create(SessionCreate {
                cwd: "/tmp".into(),
                command: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "trap '' HUP; echo ready; sleep 60".into(),
                ],
                ..Default::default()
            })
            .unwrap();
        let mut events = mgr.subscribe_events();
        tokio::time::sleep(Duration::from_millis(200)).await;
        mgr.kill(info.id, true).unwrap();
        let start = std::time::Instant::now();
        loop {
            let ev = tokio::time::timeout(Duration::from_secs(10), events.recv())
                .await
                .unwrap()
                .unwrap();
            if let Message::Event { name, .. } = ev
                && name == methods::EV_SESSION_REMOVED
            {
                break;
            }
        }
        assert!(start.elapsed() < Duration::from_secs(6));
        assert!(mgr.get(info.id).is_none());
    }

    #[test]
    fn titles() {
        assert_eq!(default_title(&["/bin/zsh".into(), "-l".into()]), "zsh");
        assert_eq!(
            default_title(&["/bin/zsh".into(), "-lic".into(), "claude --continue".into()]),
            "claude"
        );
    }
}
