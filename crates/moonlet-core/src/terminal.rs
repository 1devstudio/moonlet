//! Sessions: a PTY, its process, its terminal state and the clients
//! attached to it (S1, S2). Sessions belong to the daemon, never to a
//! client, so they outlive every connection.

use std::collections::{BTreeMap, HashMap};
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use moonlet_proto::methods::{self, Attention, TerminalCreate};
use moonlet_proto::types::{AgentState, ExitInfo, StateSource, TerminalInfo, TerminalKind};
use moonlet_proto::{Frame, Message, TerminalId};
use tokio::io::unix::AsyncFd;
use tokio::sync::{broadcast, mpsc};

use crate::agent::{AgentTracker, detect_agent, needs_attention};
use crate::paths::now_ms;
use crate::pty::{Pty, SpawnSpec, user_shell};
use crate::term::{Signal, TermState};

pub type ClientId = u64;

/// Output a client may have queued before it is detached (a frozen app or
/// a stuck SSH proxy must not grow the daemon's memory without bound).
pub const MAX_QUEUED_OUTPUT: usize = 32 * 1024 * 1024;

/// Outbound queue of one client connection. Terminal output is counted in
/// bytes; the connection's writer subtracts what it takes off the queue.
#[derive(Clone)]
pub struct ClientTx {
    tx: mpsc::UnboundedSender<Frame>,
    queued: Arc<AtomicUsize>,
}

impl ClientTx {
    pub fn new(tx: mpsc::UnboundedSender<Frame>) -> Self {
        Self { tx, queued: Arc::new(AtomicUsize::new(0)) }
    }

    /// Counter the writer decrements as it dequeues output frames.
    pub fn counter(&self) -> Arc<AtomicUsize> {
        self.queued.clone()
    }

    pub fn queued(&self) -> usize {
        self.queued.load(Ordering::Relaxed)
    }

    /// Queues a frame; false once the connection is gone.
    pub fn send(&self, frame: Frame) -> bool {
        self.queued.fetch_add(counted_len(&frame), Ordering::Relaxed);
        self.tx.send(frame).is_ok()
    }
}

impl From<mpsc::UnboundedSender<Frame>> for ClientTx {
    fn from(tx: mpsc::UnboundedSender<Frame>) -> Self {
        Self::new(tx)
    }
}

/// Call after taking a frame off a [`ClientTx`] queue.
pub fn dequeued(counter: &AtomicUsize, frame: &Frame) {
    counter.fetch_sub(counted_len(frame), Ordering::Relaxed);
}

/// Bytes a frame counts against [`MAX_QUEUED_OUTPUT`]: terminal output,
/// and replies whose payload carries a snapshot (attach). Small control
/// messages are not counted.
fn counted_len(frame: &Frame) -> usize {
    match frame {
        Frame::Output { data, .. } => data.len(),
        Frame::Json(Message::Response { result: Some(v), .. }) => {
            v.get("snapshot").and_then(|s| s.as_str()).map_or(0, str::len)
        }
        _ => 0,
    }
}

struct TerminalState {
    info: TerminalInfo,
    term: TermState,
    pty: Option<Pty>,
    subscribers: HashMap<ClientId, ClientTx>,
    agent: AgentTracker,
    last_output: Instant,
    remove_on_exit: bool,
    /// The shell's PATH as its prompt hook last reported it (T8).
    shell_path: Option<String>,
}

pub struct Terminal {
    pub id: TerminalId,
    state: Mutex<TerminalState>,
    /// Replaced when I/O restarts after a failed handoff.
    input: Mutex<mpsc::UnboundedSender<Vec<u8>>>,
    /// Reader/writer tasks; aborted before a handoff so this process stops
    /// consuming PTY output the next daemon must see.
    tasks: Mutex<Vec<tokio::task::AbortHandle>>,
}

impl Terminal {
    pub fn info(&self) -> TerminalInfo {
        self.state.lock().unwrap().info.clone()
    }
}

pub struct TerminalManager {
    terminals: Mutex<BTreeMap<TerminalId, Arc<Terminal>>>,
    next_id: AtomicU32,
    next_client: AtomicU64,
    events: broadcast::Sender<Message>,
    socket: PathBuf,
    base_env: BTreeMap<String, String>,
    /// Stops (and with `true`, forgets) a structured agent (X6).
    chat_stop: Mutex<Option<ChatStop>>,
}

pub type ChatStop = Arc<dyn Fn(TerminalId, bool) + Send + Sync>;

impl TerminalManager {
    pub fn new(socket: PathBuf, base_env: BTreeMap<String, String>) -> Arc<Self> {
        let (events, _) = broadcast::channel(1024);
        let mgr = Arc::new(Self {
            terminals: Mutex::new(BTreeMap::new()),
            next_id: AtomicU32::new(1),
            next_client: AtomicU64::new(1),
            events,
            socket,
            base_env,
            chat_stop: Mutex::new(None),
        });
        tokio::spawn(quiet_watcher(Arc::downgrade(&mgr)));
        mgr
    }

    /// Environment every terminal starts from (the captured login env).
    pub fn base_env(&self) -> &BTreeMap<String, String> {
        &self.base_env
    }

    /// The daemon socket terminals get as `JAUNT_SOCK`.
    pub fn socket(&self) -> &std::path::Path {
        &self.socket
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<Message> {
        self.events.subscribe()
    }

    pub fn emit(&self, message: Message) {
        let _ = self.events.send(message);
    }

    pub fn set_chat_stop(&self, f: ChatStop) {
        *self.chat_stop.lock().unwrap() = Some(f);
    }

    /// A fresh terminal id (also used for structured agents).
    pub fn allocate_id(&self) -> TerminalId {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Registers a structured agent (X6): a terminal without a PTY whose
    /// conversation lives in the chat runtime. `info.id` is kept if free.
    pub fn register_chat(&self, mut info: TerminalInfo) -> TerminalInfo {
        let mut terminals = self.terminals.lock().unwrap();
        if terminals.contains_key(&info.id) || info.id == 0 {
            info.id = self.allocate_id();
        }
        self.next_id.fetch_max(info.id + 1, Ordering::Relaxed);
        info.chat = true;
        let (input, _) = mpsc::unbounded_channel();
        let input = Mutex::new(input);
        // A restored chat keeps its state without announcing it again.
        let mut agent = AgentTracker::default();
        agent.report(info.agent_state, StateSource::Hook, info.agent_message.clone());
        let terminal = Arc::new(Terminal {
            id: info.id,
            input,
            tasks: Mutex::new(Vec::new()),
            state: Mutex::new(TerminalState {
                info: info.clone(),
                term: TermState::new(info.rows.max(1), info.cols.max(1)),
                pty: None,
                subscribers: HashMap::new(),
                agent,
                last_output: Instant::now(),
                remove_on_exit: false,
                shell_path: None,
            }),
        });
        terminals.insert(info.id, terminal);
        drop(terminals);
        self.emit(Message::event(methods::EV_TERMINAL_CREATED, &info));
        info
    }

    /// The PATH a shell terminal's prompt hook last reported (T8), if any.
    pub fn shell_path(&self, id: TerminalId) -> Option<String> {
        self.get(id)?.state.lock().unwrap().shell_path.clone()
    }

    /// Changes a terminal's info and tells clients.
    pub fn update_info(&self, id: TerminalId, f: impl FnOnce(&mut TerminalInfo)) {
        let Some(t) = self.get(id) else { return };
        let mut st = t.state.lock().unwrap();
        f(&mut st.info);
        self.emit(Message::event(methods::EV_TERMINAL_UPDATED, &st.info));
    }

    pub fn new_client_id(&self) -> ClientId {
        self.next_client.fetch_add(1, Ordering::Relaxed)
    }

    pub fn get(&self, id: TerminalId) -> Option<Arc<Terminal>> {
        self.terminals.lock().unwrap().get(&id).cloned()
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        self.terminals
            .lock()
            .unwrap()
            .values()
            .map(|s| s.info())
            .collect()
    }

    pub fn len(&self) -> usize {
        self.terminals.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn create(self: &Arc<Self>, req: TerminalCreate) -> Result<TerminalInfo> {
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
        env.insert("TERM_PROGRAM".into(), "moonlet".into());
        env.insert(
            "TERM_PROGRAM_VERSION".into(),
            env!("CARGO_PKG_VERSION").into(),
        );
        env.insert("JAUNT_TERMINAL_ID".into(), id.to_string());
        env.insert("JAUNT_SOCK".into(), self.socket.display().to_string());
        env.entry("SHELL".into()).or_insert(shell);
        env.entry("LANG".into())
            .or_insert_with(|| "en_US.UTF-8".into());
        if let Some(ws) = &req.session_id {
            env.insert("JAUNT_SESSION".into(), ws.clone());
        }
        env.extend(req.env.clone());

        // Interactive shells get prompt marks and cwd reporting (T3), and
        // Blocks mode with a blank prompt unless classic is chosen (T7).
        if default_shell {
            let marker = self.classic_file(id);
            if req.classic {
                std::fs::create_dir_all(marker.parent().context("no run directory")?)
                    .and_then(|()| std::fs::write(&marker, b""))
                    .with_context(|| format!("cannot write {}", marker.display()))?;
            } else {
                // A marker left by an earlier terminal with this id (ids are
                // reused after a restart) would wrongly keep the prompt.
                match std::fs::remove_file(&marker) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                        return Err(e).with_context(|| format!("cannot remove {}", marker.display()));
                    }
                    _ => {}
                }
            }
            env.insert("JAUNT_CLASSIC_FILE".into(), marker.display().to_string());
        }
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
            if req.kind == TerminalKind::Agent {
                // The program itself (`claude --continue`), else the last
                // argument (`zsh -lic "claude --continue"`).
                command
                    .first()
                    .and_then(|p| detect_agent(p))
                    .or_else(|| command.last().and_then(|l| detect_agent(l)))
                    .map(String::from)
            } else {
                None
            }
        });
        let now = now_ms();
        let info = TerminalInfo {
            id,
            kind: req.kind,
            title: req.title.clone().unwrap_or_else(|| default_title(&command)),
            cwd: cwd.display().to_string(),
            command,
            session_id: req.session_id.clone(),
            agent,
            agent_state: AgentState::Idle,
            agent_message: None,
            cols: req.cols,
            rows: req.rows,
            pid: Some(pty.pid()),
            exit: None,
            reported_cwd: None,
            node_version: None,
            prompt: None,
            alt_screen: false,
            chat: false,
            classic: req.classic,
            created_at: now,
            last_output_at: now,
        };
        self.install(info.clone(), TermState::new(req.rows, req.cols), pty)?;
        self.emit(Message::event(methods::EV_TERMINAL_CREATED, &info));
        Ok(info)
    }

    /// Registers a running PTY (fresh or adopted) and starts its I/O tasks.
    pub fn install(self: &Arc<Self>, info: TerminalInfo, term: TermState, pty: Pty) -> Result<()> {
        let id = info.id;
        self.next_id.fetch_max(id + 1, Ordering::Relaxed);
        let (input_tx, _) = mpsc::unbounded_channel();
        let terminal = Arc::new(Terminal {
            id,
            input: Mutex::new(input_tx),
            tasks: Mutex::new(Vec::new()),
            state: Mutex::new(TerminalState {
                info,
                term,
                pty: Some(pty),
                subscribers: HashMap::new(),
                agent: AgentTracker::default(),
                last_output: Instant::now(),
                remove_on_exit: false,
                shell_path: None,
            }),
        });
        self.start_io(&terminal)?;
        self.terminals.lock().unwrap().insert(id, terminal.clone());
        Ok(())
    }

    /// Starts the PTY reader and writer tasks of a terminal.
    fn start_io(self: &Arc<Self>, terminal: &Arc<Terminal>) -> Result<()> {
        let (reader_fd, writer_fd) = {
            let st = terminal.state.lock().unwrap();
            let pty = st.pty.as_ref().context("terminal has no pty")?;
            (pty.clone_master()?, pty.clone_master()?)
        };
        let (input_tx, input_rx) = mpsc::unbounded_channel();
        *terminal.input.lock().unwrap() = input_tx;
        let w = tokio::spawn(write_loop(writer_fd, input_rx)).abort_handle();
        let r = tokio::spawn(read_loop(Arc::downgrade(self), terminal.clone(), reader_fd))
            .abort_handle();
        terminal.tasks.lock().unwrap().extend([w, r]);
        Ok(())
    }

    /// Restarts I/O for terminals whose tasks were stopped by [`export`]
    /// when the handoff to a new daemon then failed.
    ///
    /// [`export`]: Self::export
    pub fn resume_io(self: &Arc<Self>) {
        let terminals: Vec<_> = self.terminals.lock().unwrap().values().cloned().collect();
        for t in terminals {
            let idle = t.tasks.lock().unwrap().is_empty();
            let live = {
                let st = t.state.lock().unwrap();
                st.pty.is_some() && st.info.exit.is_none()
            };
            if idle && live && let Err(e) = self.start_io(&t) {
                tracing::warn!(terminal = t.id, "restarting terminal I/O failed: {e:#}");
            }
        }
    }

    /// Installs a PTY received from a previous daemon (S3): the terminal
    /// state is rebuilt by replaying its snapshot, the agent state carries over.
    pub fn adopt(
        self: &Arc<Self>,
        info: TerminalInfo,
        rows: u16,
        cols: u16,
        snapshot: &[u8],
        fd: std::os::fd::RawFd,
    ) -> Result<()> {
        let pid = info.pid.context("adopted terminal has no pid")?;
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
        id: TerminalId,
        client: ClientId,
        tx: impl Into<ClientTx>,
        size: Option<(u16, u16)>,
    ) -> Result<(TerminalInfo, Vec<u8>)> {
        let mut out = None;
        self.attach_with(id, client, tx.into(), size, |info, snapshot| {
            out = Some((info, snapshot));
            None
        })?;
        Ok(out.expect("attach_with calls back"))
    }

    /// Attaches and lets `reply` build the response frame, which is queued
    /// before the client is subscribed, both under the terminal's lock. Live
    /// output therefore always reaches the client after its snapshot.
    pub fn attach_with(
        &self,
        id: TerminalId,
        client: ClientId,
        tx: ClientTx,
        size: Option<(u16, u16)>,
        reply: impl FnOnce(TerminalInfo, Vec<u8>) -> Option<Frame>,
    ) -> Result<()> {
        let terminal = self.get(id).context("no such terminal")?;
        let mut st = terminal.state.lock().unwrap();
        if let Some((cols, rows)) = size {
            resize_locked(&mut st, cols, rows);
        }
        let snapshot = st.term.snapshot();
        if let Some(frame) = reply(st.info.clone(), snapshot) {
            let _ = tx.send(frame);
        }
        st.subscribers.insert(client, tx);
        Ok(())
    }

    pub fn detach(&self, id: TerminalId, client: ClientId) {
        if let Some(s) = self.get(id) {
            s.state.lock().unwrap().subscribers.remove(&client);
        }
    }

    pub fn detach_all(&self, client: ClientId) {
        for s in self.terminals.lock().unwrap().values() {
            s.state.lock().unwrap().subscribers.remove(&client);
        }
    }

    pub fn write(&self, id: TerminalId, data: Vec<u8>) -> Result<()> {
        let s = self.get(id).context("no such terminal")?;
        s.input.lock().unwrap().send(data).ok().context("terminal input closed")
    }

    pub fn resize(&self, id: TerminalId, cols: u16, rows: u16) -> Result<()> {
        let s = self.get(id).context("no such terminal")?;
        let mut st = s.state.lock().unwrap();
        resize_locked(&mut st, cols, rows);
        let info = st.info.clone();
        drop(st);
        self.emit(Message::event(methods::EV_TERMINAL_UPDATED, &info));
        Ok(())
    }

    pub fn kill(&self, id: TerminalId, remove: bool) -> Result<()> {
        let s = self.get(id).context("no such terminal")?;
        if s.info().chat {
            let stop = self.chat_stop.lock().unwrap().clone();
            if let Some(stop) = stop {
                stop(id, remove);
            }
            if remove {
                self.remove(id);
            }
            return Ok(());
        }
        // Decide and set `remove_on_exit` under one lock, so the read loop
        // cannot record the exit in between and miss the flag.
        let (exited, session) = {
            let mut st = s.state.lock().unwrap();
            let exited = st.info.exit.is_some();
            // A script owns every process it starts, including jobs a
            // job-control shell moved to their own process group, which
            // outlive the shell when they ignore SIGHUP.
            let script = matches!(st.info.kind, TerminalKind::Run | TerminalKind::Setup);
            let session = st
                .pty
                .as_ref()
                .filter(|_| script && !exited)
                .map(|pty| pty.pid());
            if let Some(sid) = session {
                crate::pty::signal_session(sid, nix::sys::signal::Signal::SIGHUP, false);
            } else if let Some(pty) = &st.pty {
                let _ = pty.signal(nix::sys::signal::Signal::SIGHUP);
            }
            if remove && !exited {
                st.remove_on_exit = true;
            }
            (exited, session)
        };
        if let Some(sid) = session {
            // Keep escalating after the shell exits, until the session is empty.
            let weak = Arc::downgrade(&s);
            tokio::spawn(async move {
                for (delay, sig) in [
                    (1500, nix::sys::signal::Signal::SIGTERM),
                    (3000, nix::sys::signal::Signal::SIGKILL),
                ] {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    // The read loop records the exit after reaping the shell,
                    // and only removes the terminal after that.
                    let reaped = weak
                        .upgrade()
                        .is_none_or(|s| s.state.lock().unwrap().info.exit.is_some());
                    if !crate::pty::signal_session(sid, sig, reaped) {
                        return;
                    }
                }
            });
        } else if !exited {
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
        // Otherwise the read loop removes it once the process is gone.
        if remove && exited {
            self.remove(id);
        }
        Ok(())
    }

    /// Marker whose presence keeps a shell's own prompt (T7). Lives next to
    /// the socket, in the daemon's private run directory.
    fn classic_file(&self, id: TerminalId) -> PathBuf {
        self.socket.with_file_name("prompt").join(id.to_string())
    }

    /// Switches a shell between Blocks mode and its own prompt (T7). Takes
    /// effect at the shell's next prompt.
    pub fn set_classic(&self, id: TerminalId, classic: bool) -> Result<TerminalInfo> {
        let t = self.get(id).context("no such terminal")?;
        let marker = self.classic_file(id);
        if classic {
            std::fs::create_dir_all(marker.parent().context("no run directory")?)?;
            std::fs::write(&marker, b"")?;
        } else if marker.exists() {
            std::fs::remove_file(&marker)?;
        }
        let mut st = t.state.lock().unwrap();
        st.info.classic = classic;
        self.emit(Message::event(methods::EV_TERMINAL_UPDATED, &st.info));
        Ok(st.info.clone())
    }

    pub fn remove(&self, id: TerminalId) {
        let _ = std::fs::remove_file(self.classic_file(id));
        if self.terminals.lock().unwrap().remove(&id).is_some() {
            self.emit(Message::event(
                methods::EV_TERMINAL_REMOVED,
                methods::TerminalRef { id },
            ));
        }
    }

    pub fn report(
        &self,
        id: TerminalId,
        state: AgentState,
        source: StateSource,
        message: Option<String>,
        agent: Option<String>,
    ) -> Result<()> {
        let s = self.get(id).context("no such terminal")?;
        let mut st = s.state.lock().unwrap();
        let promoted = st.info.agent.is_none();
        if promoted {
            st.info.agent = agent.or(Some("agent".into()));
            st.info.kind = TerminalKind::Agent;
        }
        if st.agent.report(state, source, message) {
            self.publish_agent(&mut st);
        } else if promoted {
            // The first hook made it an agent terminal even if the state held.
            self.emit(Message::event(methods::EV_TERMINAL_UPDATED, &st.info));
        }
        Ok(())
    }

    fn publish_agent(&self, st: &mut TerminalState) {
        st.info.agent_state = st.agent.state;
        st.info.agent_message = st.agent.message.clone();
        self.emit(Message::event(methods::EV_TERMINAL_UPDATED, &st.info));
        if needs_attention(st.agent.state) {
            self.emit(Message::event(
                methods::EV_AGENT_ATTENTION,
                Attention {
                    terminal: st.info.id,
                    session_id: st.info.session_id.clone(),
                    state: st.agent.state,
                    title: st.info.title.clone(),
                    message: st.agent.message.clone(),
                },
            ));
        }
    }

    /// Links a terminal to its session if it lost the link (e.g. adopted from
    /// a daemon that called sessions "workspaces").
    pub fn link_session(&self, id: TerminalId, session: &str) {
        if let Some(t) = self.get(id) {
            let mut st = t.state.lock().unwrap();
            if st.info.session_id.is_none() {
                st.info.session_id = Some(session.to_string());
            }
        }
    }

    pub fn search(
        &self,
        id: TerminalId,
        query: &str,
        regex: bool,
        case_sensitive: bool,
    ) -> Result<Vec<methods::SearchHit>> {
        let s = self.get(id).context("no such terminal")?;
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

    /// Everything needed to hand live terminals to a new daemon process.
    /// Subscribers are dropped; clients reattach to the new daemon.
    pub fn export(&self) -> Vec<ExportedTerminal> {
        let terminals = self.terminals.lock().unwrap();
        let mut out = Vec::new();
        for s in terminals.values() {
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
            out.push(ExportedTerminal {
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
pub struct ExportedTerminal {
    pub info: TerminalInfo,
    #[serde(skip)]
    pub fd: std::os::fd::RawFd,
    pub rows: u16,
    pub cols: u16,
    pub snapshot: String,
}

fn resize_locked(st: &mut TerminalState, cols: u16, rows: u16) {
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

async fn read_loop(mgr: std::sync::Weak<TerminalManager>, terminal: Arc<Terminal>, fd: OwnedFd) {
    let fd = match AsyncFd::new(fd) {
        Ok(fd) => fd,
        Err(e) => {
            tracing::error!(terminal = terminal.id, "cannot watch pty: {e}");
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
        on_output(&mgr, &terminal, &buf[..n]);
    }
    let Some(mgr) = mgr.upgrade() else { return };
    let exit = wait_exit(&terminal).await;
    let (info, remove) = {
        let mut st = terminal.state.lock().unwrap();
        st.info.exit = Some(exit.clone());
        st.info.pid = None;
        let remove = st.remove_on_exit;
        let is_agent = st.info.kind == TerminalKind::Agent;
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
    mgr.emit(Message::event(methods::EV_TERMINAL_EXITED, &info));
    if remove {
        mgr.remove(info.id);
    }
}

async fn wait_exit(terminal: &Arc<Terminal>) -> ExitInfo {
    for _ in 0..200 {
        {
            let mut st = terminal.state.lock().unwrap();
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

fn on_output(mgr: &TerminalManager, terminal: &Terminal, data: &[u8]) {
    let mut st = terminal.state.lock().unwrap();
    let now = Instant::now();
    st.last_output = now;
    st.info.last_output_at = now_ms();
    let signals = st.term.process(data);
    let alt = st.term.screen().alternate_screen();
    let alt_changed = alt != st.info.alt_screen;
    st.info.alt_screen = alt;
    st.subscribers.retain(|_, tx| {
        if tx.queued() > MAX_QUEUED_OUTPUT {
            // The client stopped reading: detach it and ask it to re-attach.
            let _ = tx.send(Frame::Json(Message::event(
                methods::EV_TERMINAL_RESYNC,
                methods::TerminalRef { id: terminal.id },
            )));
            return false;
        }
        tx.send(Frame::Output {
            terminal: terminal.id,
            data: data.to_vec(),
        })
    });

    let mut info_changed = alt_changed;
    let mut agent_changed = false;
    for signal in signals {
        match signal {
            Signal::Title(t) if !t.is_empty() && st.info.kind != TerminalKind::Agent => {
                st.info.title = t;
                info_changed = true;
            }
            Signal::Cwd(cwd) => {
                st.info.reported_cwd = Some(cwd);
                info_changed = true;
            }
            Signal::Path(path) => st.shell_path = Some(path),
            Signal::NodePath(path) => {
                // Read from the install, never by running it (T8).
                st.info.node_version = (!path.is_empty())
                    .then(|| crate::node::version_of(std::path::Path::new(&path)))
                    .flatten();
                info_changed = true;
            }
            Signal::Prompt { mark, .. } => {
                let at_prompt = match mark {
                    'A' | 'D' => Some(true),
                    'C' => Some(false),
                    _ => st.info.prompt,
                };
                if at_prompt != st.info.prompt {
                    st.info.prompt = at_prompt;
                    info_changed = true;
                }
            }
            Signal::Notify { title, body } if st.info.kind == TerminalKind::Agent => {
                let msg = Some(match title {
                    Some(t) if !t.is_empty() => format!("{t}: {body}"),
                    _ => body,
                });
                agent_changed |= st
                    .agent
                    .report(AgentState::Blocked, StateSource::Terminal, msg);
            }
            Signal::Bell if st.info.kind == TerminalKind::Agent => {
                agent_changed |= st
                    .agent
                    .report(AgentState::Blocked, StateSource::Heuristic, None);
            }
            _ => {}
        }
    }
    if st.info.kind == TerminalKind::Agent && !agent_changed {
        agent_changed = st.agent.on_output(now);
    }
    if agent_changed {
        mgr.publish_agent(&mut st);
    } else if info_changed {
        mgr.emit(Message::event(methods::EV_TERMINAL_UPDATED, &st.info));
    }
}

/// Flips hook-less agent terminals back to idle after output stops.
async fn quiet_watcher(mgr: std::sync::Weak<TerminalManager>) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tick.tick().await;
        let Some(mgr) = mgr.upgrade() else { return };
        let terminals: Vec<_> = mgr.terminals.lock().unwrap().values().cloned().collect();
        let now = Instant::now();
        for s in terminals {
            let mut st = s.state.lock().unwrap();
            if st.info.kind == TerminalKind::Agent
                && !st.info.chat
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

    fn manager() -> Arc<TerminalManager> {
        let env: BTreeMap<String, String> = std::env::vars().collect();
        TerminalManager::new(PathBuf::from("/tmp/jaunt-test.sock"), env)
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
    async fn classic_mode_is_a_marker_file() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = TerminalManager::new(dir.path().join("run").join("d.sock"), BTreeMap::new());
        let info = mgr
            .create(TerminalCreate {
                cwd: "/tmp".into(),
                command: vec!["/bin/sleep".into(), "5".into()],
                ..Default::default()
            })
            .unwrap();
        let marker = dir.path().join("run").join("prompt").join(info.id.to_string());
        assert!(mgr.set_classic(info.id, true).unwrap().classic);
        assert!(marker.exists());
        assert!(!mgr.set_classic(info.id, false).unwrap().classic);
        assert!(!marker.exists());
        mgr.set_classic(info.id, true).unwrap();
        mgr.kill(info.id, false).unwrap();
        mgr.remove(info.id);
        assert!(!marker.exists(), "removed with the terminal");
    }

    #[tokio::test]
    async fn runs_a_command_and_reports_exit() {
        let mgr = manager();
        let mut events = mgr.subscribe_events();
        let info = mgr
            .create(TerminalCreate {
                cwd: "/tmp".into(),
                command: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "echo hi-$JAUNT_TERMINAL_ID; exit 3".into(),
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
                && name == methods::EV_TERMINAL_EXITED
            {
                let exited: TerminalInfo = serde_json::from_value(data).unwrap();
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
            .create(TerminalCreate {
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
            .create(TerminalCreate {
                cwd: "/tmp".into(),
                command: vec!["/bin/sleep".into(), "5".into()],
                kind: TerminalKind::Agent,
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
            .create(TerminalCreate {
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
                && name == methods::EV_TERMINAL_REMOVED
            {
                break;
            }
        }
        assert!(start.elapsed() < Duration::from_secs(6));
        assert!(mgr.get(info.id).is_none());
    }

    #[tokio::test]
    async fn closing_a_run_tab_stops_jobs_that_outlive_the_shell() {
        // A job-control shell puts the job in its own process group, and the
        // job ignores SIGHUP, so it keeps running after the shell exits.
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("job.pid");
        let mgr = manager();
        let info = mgr
            .create(TerminalCreate {
                cwd: "/tmp".into(),
                command: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    format!(
                        "set -m; (trap '' HUP; exec sleep 60) & echo $! > {}; sleep 60",
                        pid_file.display()
                    ),
                ],
                kind: TerminalKind::Run,
                ..Default::default()
            })
            .unwrap();
        let mut job = None;
        for _ in 0..100 {
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|s| s.trim().parse::<i32>().ok())
            {
                job = Some(nix::unistd::Pid::from_raw(pid));
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let job = job.expect("the script never started its job");
        mgr.kill(info.id, true).unwrap();
        let start = std::time::Instant::now();
        while nix::sys::signal::kill(job, None).is_ok() {
            assert!(
                start.elapsed() < Duration::from_secs(8),
                "the run tab's job is still running"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
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
