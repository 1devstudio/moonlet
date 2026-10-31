//! Runs structured agents: one child process per chat terminal with piped
//! stdio, its adapter, persistence under `~/.moonlet/chats` and restore.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use moonlet_proto::methods::{self, ChatItemEvent, ChatStateEvent};
use moonlet_proto::types::{AgentState, AsideAnswer, ChatImage, ChatState, PermissionAsk, StateSource, TerminalInfo, TerminalKind, ToolCall};
use moonlet_proto::{Message, TerminalId};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use super::{Adapter, ChatConfig, Out, adapter_for, check_mode, item, upsert};
use crate::paths::now_ms;
use crate::terminal::TerminalManager;

/// How a chat terminal is started.
#[derive(Debug, Clone, Default)]
pub struct ChatCreate {
    pub cwd: String,
    pub agent: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mode: Option<String>,
    pub name: String,
    pub title: Option<String>,
    pub session_id: Option<String>,
    pub env: BTreeMap<String, String>,
    /// Extra directories the agent may work in from the start (X29).
    pub add_dirs: Vec<String>,
    /// Claude settings for this chat alone (X64), as JSON.
    pub settings: Option<String>,
    /// For a chat with no session, such as a design system's agent (X64):
    /// the workspace whose Claude profile it starts in.
    pub workspace: Option<String>,
    /// A design system's sync agent (X64) or a design's agent (X65), marked
    /// so on its terminal.
    pub design: Option<moonlet_proto::types::DesignAgent>,
}

/// What is persisted per chat.
#[derive(Serialize, Deserialize)]
struct Saved {
    info: TerminalInfo,
    cfg: ChatConfig,
    #[serde(default)]
    env: BTreeMap<String, String>,
    state: ChatState,
}

struct Inner {
    info: TerminalInfo,
    cfg: ChatConfig,
    env: BTreeMap<String, String>,
    state: ChatState,
    adapter: Option<Box<dyn Adapter>>,
    stdin: Option<mpsc::UnboundedSender<String>>,
    pid: Option<u32>,
    /// Bumped on every spawn so a stale process's exit is ignored.
    generation: u64,
    /// Settings changed: restart (with resume) before the next message.
    restart: bool,
    /// Asks kept from before a daemon restart; their answers go to the
    /// resumed agent as its next message.
    kept: Vec<String>,
    stderr: Vec<String>,
    saved_at: Instant,
    dirty: bool,
}

struct Chat {
    id: TerminalId,
    inner: Mutex<Inner>,
}

/// What a session's agents start with, looked up at every start rather than
/// stored with the chat: the Claude profile (X33) can change.
#[derive(Debug, Clone, Default)]
pub struct SessionLaunch {
    pub env: BTreeMap<String, String>,
    /// The Claude profile's name; `None` for the default profile.
    pub profile: Option<String>,
}

pub type SessionEnv = Box<dyn Fn(&str) -> SessionLaunch + Send + Sync>;

/// How a chat with no session asks [`SessionEnv`] for its workspace's launch:
/// `workspace:<id>` instead of a session id.
pub const WORKSPACE_KEY: &str = "workspace:";

pub struct ChatManager {
    terms: Arc<TerminalManager>,
    chats: Mutex<HashMap<TerminalId, Arc<Chat>>>,
    dir: PathBuf,
    me: Weak<ChatManager>,
    session_env: std::sync::OnceLock<SessionEnv>,
}

/// An added directory as the agent gets it: absolute and existing, so it
/// can never read as one of the agent's flags (X29).
fn check_dir(path: &str) -> Result<String> {
    let dir = crate::terminal::expand_home(path);
    if !dir.is_absolute() || !dir.is_dir() {
        bail!("not a directory: {path}");
    }
    Ok(dir.display().to_string())
}

fn agent_state(status: &str) -> AgentState {
    match status {
        "working" => AgentState::Working,
        "blocked" => AgentState::Blocked,
        "done" => AgentState::Done,
        "error" => AgentState::Error,
        _ => AgentState::Idle,
    }
}

/// Asks that wait through a daemon restart.
const KEPT_TOOLS: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];

/// How long an aside may take before moonlet gives up on it (X49).
const ASIDE_TIMEOUT: Duration = Duration::from_secs(120);

/// The tool call an ask is about: the same tool with the same input.
fn asks_for(ask: &PermissionAsk, tool: &ToolCall) -> bool {
    ask.tool == tool.name && ask.input == tool.input
}

/// Ends the running tool call a kept ask was about.
fn close_tool(st: &mut ChatState, ask: &PermissionAsk, status: &str) -> Option<Out> {
    let it = st.items.iter_mut().find(|i| i.tool.as_ref().is_some_and(|t| t.status == "running" && asks_for(ask, t)))?;
    it.tool.as_mut()?.status = status.into();
    Some(Out::Item(Box::new(it.clone())))
}

/// Answers to a question asked before a daemon restart, as a message, in
/// the order the agent asked them.
fn answers_text(ask: &PermissionAsk, answers: &BTreeMap<String, String>) -> String {
    let asked: Vec<&str> = ask.input["questions"].as_array().into_iter().flatten().filter_map(|q| q["question"].as_str()).collect();
    let rank = |q: &str| asked.iter().position(|a| *a == q).unwrap_or(asked.len());
    let mut pairs: Vec<(&String, &String)> = answers.iter().collect();
    pairs.sort_by_key(|(q, _)| rank(q));
    let lines: Vec<String> = pairs.iter().map(|(q, a)| format!("{q}\n{a}")).collect();
    format!("Answers to your questions:\n\n{}", lines.join("\n\n"))
}


impl ChatManager {
    pub fn new(terms: Arc<TerminalManager>, dir: PathBuf) -> Arc<Self> {
        let mgr = Arc::new_cyclic(|me| Self { terms: terms.clone(), chats: Mutex::new(HashMap::new()), dir, me: me.clone(), session_env: std::sync::OnceLock::new() });
        let weak = Arc::downgrade(&mgr);
        terms.set_chat_stop(Arc::new(move |id, remove| {
            if let Some(m) = weak.upgrade() {
                m.stop(id, remove);
            }
        }));
        mgr
    }

    fn get(&self, id: TerminalId) -> Result<Arc<Chat>> {
        self.chats.lock().unwrap().get(&id).cloned().context("no such chat")
    }

    pub fn is_chat(&self, id: TerminalId) -> bool {
        self.chats.lock().unwrap().contains_key(&id)
    }

    pub fn create(&self, req: ChatCreate) -> Result<TerminalInfo> {
        self.create_from(req, None)
    }

    /// A chat that goes on from `history`, another member's chat of the same
    /// session (X73): its items stay, and its agent resumes the same
    /// conversation. What it had running or asking is over: it starts idle.
    pub fn create_continuing(&self, req: ChatCreate, history: ChatState) -> Result<TerminalInfo> {
        self.create_from(req, Some(history))
    }

    fn create_from(&self, req: ChatCreate, history: Option<ChatState>) -> Result<TerminalInfo> {
        let adapter = adapter_for(&req.agent).with_context(|| format!("{} has no structured mode", req.agent))?;
        check_mode(req.mode.as_deref())?;
        let cwd = crate::terminal::expand_home(&req.cwd);
        if !cwd.is_dir() {
            bail!("working directory does not exist: {}", cwd.display());
        }
        // Only Claude has a permission mode.
        let mode = req.mode.filter(|_| req.agent == "claude");
        let add_dirs = req.add_dirs.iter().map(|d| check_dir(d)).collect::<Result<Vec<_>>>()?;
        let continuing = history.is_some();
        let cfg = ChatConfig { agent: req.agent.clone(), model: req.model, effort: req.effort, mode, resume: None, name: req.name, cwd: cwd.display().to_string(), add_dirs: add_dirs.clone(), settings: req.settings, workspace: req.workspace, config_dir: None };
        let (program, args) = adapter.command(&cfg);
        let mut command = vec![program];
        command.extend(args);
        let now = now_ms();
        let info = self.terms.register_chat(TerminalInfo {
            id: 0,
            kind: TerminalKind::Agent,
            title: req.title.unwrap_or_else(|| req.agent.clone()),
            cwd: cfg.cwd.clone(),
            command,
            session_id: req.session_id,
            agent: Some(req.agent),
            agent_state: AgentState::Idle,
            agent_message: None,
            cols: 80,
            rows: 24,
            pid: None,
            exit: None,
            reported_cwd: None,
            node_version: None,
            prompt: None,
            last_exit: None,
            alt_screen: false,
            chat: true,
            classic: false,
            design: req.design,
            subagents: 0,
            created_at: now,
            last_output_at: now,
        });
        let chat = Arc::new(Chat {
            id: info.id,
            inner: Mutex::new(Inner {
                info: info.clone(),
                cfg,
                env: req.env,
                state: match history {
                    Some(h) => ChatState {
                        status: "idle".into(),
                        pending: Vec::new(),
                        queued: Vec::new(),
                        turn_started_at: None,
                        add_dirs,
                        ..h
                    },
                    None => ChatState { status: "idle".into(), add_dirs, ..Default::default() },
                },
                adapter: None,
                stdin: None,
                pid: None,
                generation: 0,
                restart: false,
                kept: Vec::new(),
                stderr: Vec::new(),
                saved_at: Instant::now(),
                dirty: true,
            }),
        });
        self.chats.lock().unwrap().insert(info.id, chat.clone());
        // Start right away so the agent is warm when the first message comes.
        {
            let mut inner = chat.inner.lock().unwrap();
            // A continued conversation was put in this host's profile for
            // the session (X73): it is resumed there, not started anew.
            if continuing {
                inner.cfg.config_dir = self.launch(&inner).env.get(crate::profiles::CONFIG_DIR_VAR).cloned();
            }
            if let Err(e) = self.spawn(&chat, &mut inner) {
                self.fail(&chat, &mut inner, &format!("{e:#}"));
            }
            self.save(&chat, &mut inner);
        }
        Ok(self.terms.get(info.id).map(|t| t.info()).unwrap_or(info))
    }

    pub fn state(&self, id: TerminalId) -> Result<ChatState> {
        Ok(self.get(id)?.inner.lock().unwrap().state.clone())
    }

    /// What the chat waits for from the user, without copying its items.
    pub fn pending(&self, id: TerminalId) -> Result<Vec<moonlet_proto::types::PermissionAsk>> {
        Ok(self.get(id)?.inner.lock().unwrap().state.pending.clone())
    }

    /// Every chat's state without its items: what the phone's Inbox needs (X40).
    pub fn summaries(&self) -> Vec<(TerminalId, ChatState)> {
        let chats: Vec<(TerminalId, Arc<Chat>)> = self.chats.lock().unwrap().iter().map(|(id, c)| (*id, c.clone())).collect();
        chats
            .into_iter()
            .map(|(id, c)| {
                let mut inner = c.inner.lock().unwrap();
                // The rest of the state is cloned; the items are not copied.
                let items = std::mem::take(&mut inner.state.items);
                let st = inner.state.clone();
                inner.state.items = items;
                (id, st)
            })
            .collect()
    }

    pub fn send(&self, id: TerminalId, text: &str, images: &[ChatImage]) -> Result<()> {
        let chat = self.get(id)?;
        let mut inner = chat.inner.lock().unwrap();
        self.deliver(&chat, &mut inner, text, images)
    }

    /// Sends a user message, starting or restarting the agent first when needed.
    fn deliver(&self, chat: &Arc<Chat>, inner: &mut Inner, text: &str, images: &[ChatImage]) -> Result<()> {
        // A new message instead of an answer: the kept asks are moot.
        let kept = inner.kept.clone();
        self.close_kept(chat, inner, &kept, "error", None);
        if inner.restart || inner.stdin.is_none() {
            self.kill_process(inner);
            self.settle(chat, inner, "Stopped to apply new settings");
            inner.restart = false;
            if let Err(e) = self.spawn(chat, inner) {
                self.fail(chat, inner, &format!("{e:#}"));
                return Err(e);
            }
        }
        let Inner { adapter, state, .. } = &mut *inner;
        let outs = adapter.as_mut().context("agent not running")?.send(text, images, state);
        self.apply(chat, inner, outs);
        Ok(())
    }

    /// Takes kept asks off the chat and ends their tool calls with
    /// `status`. Returns the asks it closed.
    fn close_kept(&self, chat: &Chat, inner: &mut Inner, ids: &[String], status: &str, note: Option<&str>) -> Vec<PermissionAsk> {
        if ids.is_empty() {
            return Vec::new();
        }
        inner.kept.retain(|k| !ids.contains(k));
        let (closed, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut inner.state.pending).into_iter().partition(|p| ids.contains(&p.id));
        inner.state.pending = rest;
        let mut outs: Vec<Out> = closed.iter().filter_map(|p| close_tool(&mut inner.state, p, status)).collect();
        if inner.state.pending.is_empty() {
            inner.state.status = "idle".into();
        }
        if let Some(n) = note {
            outs.push(upsert(&mut inner.state, item(super::local_id("system"), "system", n)));
        }
        outs.push(Out::State);
        self.apply(chat, inner, outs);
        closed
    }

    /// Answers an ask kept from before a daemon restart. Its agent process
    /// is gone, so the answer reaches the resumed agent as a message.
    #[allow(clippy::too_many_arguments)]
    fn answer_kept(&self, chat: &Arc<Chat>, inner: &mut Inner, ask: &str, decision: &str, message: Option<&str>, answers: Option<&BTreeMap<String, String>>, mode: Option<&str>) -> Result<()> {
        let allowed = decision != "deny";
        let Some(asked) = self.close_kept(chat, inner, &[ask.to_string()], if allowed { "ok" } else { "denied" }, None).pop() else { return Ok(()) };
        let text = match asked.tool.as_str() {
            "AskUserQuestion" if allowed => answers.map(|a| answers_text(&asked, a)),
            // The agent starts in the mode the plan was approved into (X20):
            // "ask before edits" carries no mode and means manual.
            "ExitPlanMode" if allowed => {
                let m = mode.unwrap_or("manual").to_string();
                inner.cfg.mode = Some(m.clone());
                inner.state.mode = Some(m);
                inner.restart = true;
                Some("I approve your plan. Go ahead with it.".to_string())
            }
            // Skip, or "Keep planning" with the user's feedback.
            _ if !allowed => message.map(String::from),
            _ => None,
        };
        match text {
            Some(t) => self.deliver(chat, inner, &t, &[]),
            None => Ok(()),
        }
    }

    /// `mode` switches the agent's permission mode with an approval; only a
    /// plan approved into `auto` or `acceptEdits` uses it (X20, X24).
    pub fn permission(&self, id: TerminalId, ask: &str, decision: &str, message: Option<&str>, answers: Option<&BTreeMap<String, String>>, mode: Option<&str>) -> Result<()> {
        if let Some(m) = mode {
            if decision != "allow" {
                bail!("a mode needs decision allow");
            }
            if m != "auto" && m != "acceptEdits" {
                bail!("a plan can only be approved into auto or acceptEdits");
            }
        }
        let chat = self.get(id)?;
        let mut inner = chat.inner.lock().unwrap();
        // A session-wide mode change answers a plan, never a single tool call.
        if mode.is_some() && !inner.state.pending.iter().any(|p| p.id == ask && p.tool == "ExitPlanMode") {
            bail!("only a plan approval can switch the mode");
        }
        if inner.kept.iter().any(|c| c == ask) {
            return self.answer_kept(&chat, &mut inner, ask, decision, message, answers, mode);
        }
        let Inner { adapter, state, .. } = &mut *inner;
        let outs = adapter.as_mut().context("agent not running")?.permission(ask, decision, message, answers, mode, state);
        self.apply(&chat, &mut inner, outs);
        Ok(())
    }

    pub fn interrupt(&self, id: TerminalId) -> Result<()> {
        let chat = self.get(id)?;
        let mut inner = chat.inner.lock().unwrap();
        // A kept ask's turn died with the old agent: nothing runs to stop.
        if !inner.kept.is_empty() {
            let kept = inner.kept.clone();
            self.close_kept(&chat, &mut inner, &kept, "error", Some("Interrupted"));
            return Ok(());
        }
        let Inner { adapter, state, .. } = &mut *inner;
        let Some(a) = adapter.as_mut() else { return Ok(()) };
        let outs = a.interrupt(state);
        self.apply(&chat, &mut inner, outs);
        Ok(())
    }

    /// Asks the agent to read a queued message now, or every queued one
    /// without `message` (X49).
    pub fn send_now(&self, id: TerminalId, message: Option<&str>) -> Result<()> {
        self.with_queued(id, message, |a, m, st| a.send_now(m, st))
    }

    /// Takes a queued message out of the agent's queue (X49).
    pub fn unqueue(&self, id: TerminalId, message: &str) -> Result<()> {
        self.with_queued(id, Some(message), |a, _, st| a.unqueue(message, st))
    }

    fn with_queued(&self, id: TerminalId, message: Option<&str>, f: impl FnOnce(&mut dyn Adapter, Option<&str>, &mut ChatState) -> Vec<Out>) -> Result<()> {
        let chat = self.get(id)?;
        let mut inner = chat.inner.lock().unwrap();
        match message {
            Some(m) if !inner.state.queued.iter().any(|q| q.id == m) => bail!("no queued message {m}"),
            None if inner.state.queued.is_empty() => bail!("no queued messages"),
            _ => {}
        }
        let Inner { adapter, state, .. } = &mut *inner;
        let outs = f(adapter.as_deref_mut().context("agent not running")?, message, state);
        self.apply(&chat, &mut inner, outs);
        Ok(())
    }

    /// Stops one running subagent (X42).
    pub fn stop_agent(&self, id: TerminalId, agent: &str) -> Result<()> {
        let chat = self.get(id)?;
        let mut inner = chat.inner.lock().unwrap();
        if !inner.state.subagents.iter().any(|a| a.id == agent && a.status == "running") {
            bail!("no running subagent {agent}");
        }
        let Inner { adapter, state, .. } = &mut *inner;
        let outs = adapter.as_mut().context("agent not running")?.stop_agent(agent, state);
        self.apply(&chat, &mut inner, outs);
        Ok(())
    }

    /// New model, effort or permission mode, used from the next message on.
    pub fn settings(&self, id: TerminalId, model: Option<String>, effort: Option<String>, mode: Option<String>) -> Result<ChatState> {
        check_mode(mode.as_deref())?;
        let chat = self.get(id)?;
        let mut inner = chat.inner.lock().unwrap();
        if model.is_some() {
            inner.cfg.model = model.clone();
            inner.state.model = model;
        }
        if effort.is_some() {
            inner.cfg.effort = effort.clone();
            inner.state.effort = effort;
        }
        // Only Claude has a permission mode.
        if mode.is_some() && inner.cfg.agent == "claude" {
            inner.cfg.mode = mode.clone();
            inner.state.mode = mode;
        }
        inner.restart = true;
        self.apply(&chat, &mut inner, vec![Out::State]);
        Ok(inner.state.clone())
    }

    /// A directory the agent may work in (X29). It applies from the next
    /// message, which restarts the agent with it; adding one twice does
    /// nothing.
    pub fn add_dir(&self, id: TerminalId, path: &str) -> Result<ChatState> {
        let dir = check_dir(path)?;
        let chat = self.get(id)?;
        let mut inner = chat.inner.lock().unwrap();
        if inner.cfg.add_dirs.contains(&dir) {
            return Ok(inner.state.clone());
        }
        inner.cfg.add_dirs.push(dir.clone());
        inner.state.add_dirs.push(dir.clone());
        inner.restart = true;
        let note = format!("Added directory {dir}. The agent can use it from the next message.");
        let o = upsert(&mut inner.state, item(super::local_id("system"), "system", note));
        self.apply(&chat, &mut inner, vec![o, Out::State]);
        Ok(inner.state.clone())
    }

    /// MCP servers (X29): `refresh` lists them, `reconnect` retries
    /// `server`, `auth` signs in to it, `cancel` gives that up. A stopped
    /// agent is started to answer.
    pub fn mcp(&self, id: TerminalId, action: &str, server: Option<&str>) -> Result<()> {
        if !matches!(action, "refresh" | "reconnect" | "auth" | "cancel") {
            bail!("unknown MCP action: {action}");
        }
        let chat = self.get(id)?;
        let mut inner = chat.inner.lock().unwrap();
        if inner.stdin.is_none() {
            inner.restart = false;
            if let Err(e) = self.spawn(&chat, &mut inner) {
                self.fail(&chat, &mut inner, &format!("{e:#}"));
                return Err(e);
            }
        }
        let Inner { adapter, state, .. } = &mut *inner;
        let outs = adapter.as_mut().context("agent not running")?.mcp(action, server, state);
        self.apply(&chat, &mut inner, outs);
        Ok(())
    }

    /// Stops the agent process; `remove` also forgets the conversation.
    pub fn stop(&self, id: TerminalId, remove: bool) {
        let Ok(chat) = self.get(id) else { return };
        {
            let mut inner = chat.inner.lock().unwrap();
            self.kill_process(&mut inner);
            if !remove {
                self.settle(&chat, &mut inner, "Stopped");
                self.save(&chat, &mut inner);
            }
        }
        if remove {
            self.chats.lock().unwrap().remove(&id);
            let _ = std::fs::remove_file(self.file(id));
        }
    }

    /// Persists every chat (before a restart or upgrade).
    pub fn save_all(&self) {
        let chats: Vec<_> = self.chats.lock().unwrap().values().cloned().collect();
        for chat in chats {
            let mut inner = chat.inner.lock().unwrap();
            inner.dirty = true;
            self.save(&chat, &mut inner);
        }
    }

    /// Stops all agents (daemon shutdown); conversations stay on disk.
    pub fn shutdown(&self) {
        self.save_all();
        let chats: Vec<_> = self.chats.lock().unwrap().values().cloned().collect();
        for chat in chats {
            self.kill_process(&mut chat.inner.lock().unwrap());
        }
    }

    /// Brings back saved conversations after a daemon start. Agents are not
    /// started until the next message, which resumes them.
    pub fn restore(&self) -> usize {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return 0 };
        let mut n = 0;
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().is_none_or(|x| x != "json") {
                continue;
            }
            let Some(saved) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Saved>(&b).ok()) else {
                tracing::warn!("unreadable chat {}", path.display());
                continue;
            };
            let mut state = saved.state;
            let mut interrupted = false;
            let mut kept = Vec::new();
            if matches!(state.status.as_str(), "working" | "blocked") {
                // The main agent's questions and plans wait for their answer,
                // which the resumed agent gets as a message. Tool permissions
                // are asked again when the agent continues.
                state.pending.retain(|p| p.agent.is_none() && KEPT_TOOLS.contains(&p.tool.as_str()));
                kept = state.pending.iter().map(|p| p.id.clone()).collect();
                state.status = if kept.is_empty() { "idle" } else { "blocked" }.into();
                state.turn_started_at = None;
                interrupted = kept.is_empty();
            }
            super::stop_subagents(&mut state);
            let pending = state.pending.clone();
            for it in &mut state.items {
                it.partial = false;
                if let Some(t) = it.tool.as_mut()
                    && t.status == "running"
                    && !pending.iter().any(|p| asks_for(p, t))
                {
                    t.status = "error".into();
                }
            }
            let mut info = saved.info;
            info.pid = None;
            info.agent_state = agent_state(&state.status);
            let old = info.id;
            // Keeps its id unless a live terminal (e.g. adopted) took it.
            let info = self.terms.register_chat(info);
            if info.id != old {
                let _ = std::fs::remove_file(&path);
            }
            let chat = Arc::new(Chat {
                id: info.id,
                inner: Mutex::new(Inner {
                    info,
                    cfg: saved.cfg,
                    env: saved.env,
                    state,
                    adapter: None,
                    stdin: None,
                    pid: None,
                    generation: 0,
                    restart: false,
                    kept,
                    stderr: Vec::new(),
                    saved_at: Instant::now(),
                    dirty: true,
                }),
            });
            self.chats.lock().unwrap().insert(chat.id, chat.clone());
            let mut inner = chat.inner.lock().unwrap();
            if interrupted {
                let id = super::local_id("system");
                upsert(&mut inner.state, item(id, "system", "Interrupted by a daemon restart"));
            }
            super::undeliver(&mut inner.state);
            self.save(&chat, &mut inner);
            n += 1;
        }
        n
    }

    fn file(&self, id: TerminalId) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    fn save(&self, chat: &Chat, inner: &mut Inner) {
        if !inner.dirty {
            return;
        }
        inner.dirty = false;
        inner.saved_at = Instant::now();
        if let Some(t) = self.terms.get(chat.id) {
            inner.info = t.info();
        }
        let saved = Saved { info: inner.info.clone(), cfg: inner.cfg.clone(), env: inner.env.clone(), state: inner.state.clone() };
        let write = || -> Result<()> {
            crate::paths::ensure_private_dir(&self.dir)?;
            let tmp = self.dir.join(format!(".{}.tmp", chat.id));
            std::fs::write(&tmp, serde_json::to_vec(&saved)?)?;
            std::fs::rename(&tmp, self.file(chat.id))?;
            Ok(())
        };
        if let Err(e) = write() {
            tracing::warn!(chat = chat.id, "saving chat failed: {e:#}");
        }
    }

    fn kill_process(&self, inner: &mut Inner) {
        inner.generation += 1;
        inner.stdin = None;
        inner.adapter = None;
        if let Some(pid) = inner.pid.take() {
            let pg = nix::unistd::Pid::from_raw(pid as i32);
            let _ = nix::sys::signal::killpg(pg, nix::sys::signal::Signal::SIGTERM);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(3)).await;
                let _ = nix::sys::signal::killpg(pg, nix::sys::signal::Signal::SIGKILL);
            });
        }
    }

    /// After stopping the process ourselves: its exit handler is skipped
    /// (stale generation), so a running turn is closed here.
    fn settle(&self, chat: &Chat, inner: &mut Inner, note: &str) {
        if super::stop_subagents(&mut inner.state) {
            self.apply(chat, inner, vec![Out::State]);
        }
        if !matches!(inner.state.status.as_str(), "working" | "blocked") {
            return;
        }
        inner.state.status = "idle".into();
        inner.state.pending.clear();
        inner.kept.clear();
        inner.state.turn_started_at = None;
        let mut outs = Vec::new();
        for it in inner.state.items.iter_mut().filter(|i| i.partial || i.tool.as_ref().is_some_and(|t| t.status == "running")) {
            it.partial = false;
            if let Some(t) = it.tool.as_mut()
                && t.status == "running"
            {
                t.status = "error".into();
            }
            outs.push(Out::Item(Box::new(it.clone())));
        }
        outs.push(upsert(&mut inner.state, item(super::local_id("system"), "system", note)));
        outs.extend(super::undeliver(&mut inner.state));
        outs.push(Out::State);
        self.apply(chat, inner, outs);
    }

    fn fail(&self, chat: &Chat, inner: &mut Inner, message: &str) {
        let id = super::local_id("error");
        let o = upsert(&mut inner.state, item(id, "error", message));
        inner.state.status = "error".into();
        inner.state.turn_started_at = None;
        inner.state.pending.clear();
        inner.kept.clear();
        self.apply(chat, inner, vec![o, Out::State]);
    }

    pub fn set_session_env(&self, f: SessionEnv) {
        let _ = self.session_env.set(f);
    }

    /// How the session's agents start: its Claude profile and environment.
    fn launch(&self, inner: &Inner) -> SessionLaunch {
        match (&inner.info.session_id, &inner.cfg.workspace, self.session_env.get()) {
            (Some(s), _, Some(f)) => f(s),
            (None, Some(w), Some(f)) => f(&format!("{WORKSPACE_KEY}{w}")),
            _ => SessionLaunch::default(),
        }
    }

    /// The environment an agent of `chat` runs in.
    fn agent_env(&self, chat: TerminalId, inner: &Inner, launch: BTreeMap<String, String>) -> BTreeMap<String, String> {
        let mut env = self.terms.base_env().clone();
        env.insert("MOONLET_TERMINAL_ID".into(), chat.to_string());
        env.insert("MOONLET_SOCK".into(), self.terms.socket().display().to_string());
        if let Some(s) = &inner.info.session_id {
            env.insert("MOONLET_SESSION".into(), s.clone());
        }
        env.extend(inner.env.clone());
        env.extend(launch);
        env
    }

    /// Answers a side question from the chat's conversation in a separate,
    /// tool-less Claude, leaving the chat as it is (X49).
    pub async fn aside(&self, id: TerminalId, question: &str) -> Result<AsideAnswer> {
        let chat = self.get(id)?;
        let (program, args, cwd, env) = {
            let inner = chat.inner.lock().unwrap();
            if inner.cfg.agent != "claude" {
                bail!("Ask aside works with Claude only");
            }
            let session = inner.state.agent_session.clone().context("Claude has no conversation to ask about yet")?;
            let running = inner.state.items.iter().rev().filter_map(|i| i.tool.as_ref()).find(|t| t.status == "running").map(|t| t.summary.clone());
            // As at a start (X33): a conversation kept in another profile's folder cannot be resumed.
            let launch = self.launch(&inner);
            if launch.env.get(crate::profiles::CONFIG_DIR_VAR) != inner.cfg.config_dir.as_ref() {
                let now = launch.profile.unwrap_or_else(|| "the default Claude profile".into());
                bail!("This conversation is in another Claude profile: send Claude a message to start one in {now}.");
            }
            let args = super::claude::aside_args(&inner.cfg, &session, question, running.as_deref());
            let env = self.agent_env(id, &inner, launch.env);
            ("claude".to_string(), args, inner.cfg.cwd.clone(), env)
        };
        let exe = crate::paths::find_program(&program, &env).with_context(|| format!("{program} not found on PATH"))?;
        let run = tokio::process::Command::new(&exe).args(&args).current_dir(&cwd).env_clear().envs(&env).stdin(Stdio::null()).kill_on_drop(true).output();
        let out = tokio::time::timeout(ASIDE_TIMEOUT, run).await.map_err(|_| anyhow::anyhow!("The aside took too long."))?.context("failed to start claude")?;
        super::claude::aside_answer(&String::from_utf8_lossy(&out.stdout), &String::from_utf8_lossy(&out.stderr))
    }

    fn spawn(&self, chat: &Arc<Chat>, inner: &mut Inner) -> Result<()> {
        let adapter = adapter_for(&inner.cfg.agent).context("unknown agent")?;
        let launch = self.launch(inner);
        // A Claude conversation lives in its profile's folder (X33): after
        // the workspace switched profiles, start a new one. Other agents keep
        // their history elsewhere.
        let config_dir = launch.env.get(crate::profiles::CONFIG_DIR_VAR).cloned();
        if inner.cfg.agent == "claude" && inner.state.agent_session.is_some() && inner.cfg.config_dir != config_dir {
            inner.state.agent_session = None;
            let now = launch.profile.clone().unwrap_or_else(|| "the default Claude profile".into());
            let note = format!("Started a new conversation: this workspace now uses {now}");
            let o = upsert(&mut inner.state, item(super::local_id("system"), "system", note));
            self.apply(chat, inner, vec![o]);
        }
        inner.cfg.config_dir = config_dir;
        let mut cfg = inner.cfg.clone();
        cfg.resume = inner.state.agent_session.clone();
        let (program, args) = adapter.command(&cfg);
        let env = self.agent_env(chat.id, inner, launch.env);
        let exe = crate::paths::find_program(&program, &env).with_context(|| format!("{program} not found on PATH"))?;
        let mut child = tokio::process::Command::new(&exe)
            .args(&args)
            .current_dir(&cfg.cwd)
            .env_clear()
            .envs(&env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .with_context(|| format!("failed to start {program}"))?;
        inner.generation += 1;
        let generation = inner.generation;
        inner.pid = child.id();
        inner.stderr.clear();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        inner.stdin = Some(tx);

        let mut stdin = child.stdin.take().context("no stdin")?;
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });
        let stdout = child.stdout.take().context("no stdout")?;
        let stderr = child.stderr.take().context("no stderr")?;
        let me = self.me.clone();
        let c = chat.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let mut inner = c.inner.lock().unwrap();
                if inner.generation != generation {
                    return;
                }
                inner.stderr.push(super::strip_ansi(&l));
                if inner.stderr.len() > 20 {
                    inner.stderr.remove(0);
                }
            }
        });
        let c = chat.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::with_capacity(1 << 16, stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Some(mgr) = me.upgrade() else { return };
                let mut inner = c.inner.lock().unwrap();
                if inner.generation != generation {
                    return;
                }
                let Inner { adapter, state, .. } = &mut *inner;
                let Some(a) = adapter.as_mut() else { return };
                let outs = a.on_line(&line, state);
                mgr.apply(&c, &mut inner, outs);
            }
            let status = child.wait().await.ok();
            let Some(mgr) = me.upgrade() else { return };
            let mut inner = c.inner.lock().unwrap();
            if inner.generation != generation {
                return;
            }
            inner.stdin = None;
            inner.adapter = None;
            inner.pid = None;
            // Subagents die with the agent process (X42).
            if super::stop_subagents(&mut inner.state) {
                mgr.apply(&c, &mut inner, vec![Out::State]);
            }
            let busy = matches!(inner.state.status.as_str(), "working" | "blocked");
            if busy || !status.is_some_and(|s| s.success()) {
                let tail = inner.stderr.iter().rev().take(5).rev().cloned().collect::<Vec<_>>().join("\n");
                let code = status.and_then(|s| s.code()).map(|c| format!(" (code {c})")).unwrap_or_default();
                let msg = if tail.is_empty() { format!("The agent exited{code}.") } else { format!("The agent exited{code}:\n{tail}") };
                mgr.fail(&c, &mut inner, &msg);
            }
            let mut outs = super::undeliver(&mut inner.state);
            if !outs.is_empty() {
                outs.push(Out::State);
                mgr.apply(&c, &mut inner, outs);
            }
            mgr.save(&c, &mut inner);
        });

        inner.adapter = Some(adapter);
        let Inner { adapter, state, .. } = &mut *inner;
        let outs = adapter.as_mut().unwrap().start(&cfg, state);
        self.apply(chat, inner, outs);
        self.terms.update_info(chat.id, |i| i.pid = inner.pid);
        Ok(())
    }

    /// Carries out an adapter's requests: stdin writes, client events,
    /// agent state and persistence.
    fn apply(&self, chat: &Chat, inner: &mut Inner, outs: Vec<Out>) {
        let mut state_changed = false;
        for o in outs {
            match o {
                Out::Write(line) => {
                    if let Some(tx) = &inner.stdin {
                        let _ = tx.send(line);
                    }
                }
                Out::Item(item) => {
                    if !item.partial {
                        inner.dirty = true;
                    }
                    self.terms.emit(Message::event(methods::EV_CHAT_ITEM, ChatItemEvent { id: chat.id, item: *item }));
                }
                Out::State => state_changed = true,
            }
        }
        if state_changed {
            inner.dirty = true;
            // The mode Claude reports is the one the next start uses (X20).
            if inner.cfg.agent == "claude" && inner.state.mode.is_some() {
                inner.cfg.mode = inner.state.mode.clone();
            }
            // Items travel as `chat.item`; the state event leaves them out.
            let items = std::mem::take(&mut inner.state.items);
            self.terms.emit(Message::event(methods::EV_CHAT_STATE, ChatStateEvent { id: chat.id, state: inner.state.clone() }));
            inner.state.items = items;
            let st = &inner.state;
            let message = match st.pending.first() {
                Some(a) => Some(format!("{} {}", a.tool, a.summary).trim().to_string()),
                None => st.items.iter().rev().find(|i| i.kind == "error").filter(|_| st.status == "error").map(|i| i.text.lines().next().unwrap_or("").to_string()),
            };
            let running = st.subagents.iter().filter(|a| a.status == "running").count() as u32;
            // The turn is not done while its background subagents run, so it alerts once at the end (X47).
            let state = match agent_state(&st.status) {
                AgentState::Done if running > 0 => AgentState::Working,
                s => s,
            };
            let _ = self.terms.report(chat.id, state, StateSource::Hook, message, inner.cfg.agent.clone().into());
            if self.terms.get(chat.id).is_some_and(|t| t.info().subagents != running) {
                self.terms.update_info(chat.id, |i| i.subagents = running);
            }
        }
        if inner.dirty && (state_changed || inner.saved_at.elapsed() > Duration::from_secs(2)) {
            self.save(chat, inner);
        }
    }
}

/// The chats directory under a moonlet home.
pub fn chats_dir(home: &Path) -> PathBuf {
    home.join("chats")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A stand-in for `claude` that speaks just enough stream-json.
    /// Each start appends its arguments to `claude-args` in the working
    /// directory, and its `CLAUDE_CONFIG_DIR` (X33) to `claude-env`.
    const FAKE_CLAUDE: &str = r#"#!/bin/sh
echo "$*" >> claude-args
echo "${CLAUDE_CONFIG_DIR:-default}" >> claude-env
case "$*" in
  *--fork-session*) echo '{"type":"result","subtype":"success","is_error":false,"result":"Port 4000.","duration_ms":1200,"total_cost_usd":0.0015}'; exit 0 ;;
esac
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"sess-1","model":"fake","slash_commands":["clear"]}' ;;
    *'"subtype":"mcp_status"'*)
      id=$(printf '%s' "$line" | sed 's/.*"request_id":"\([^"]*\)".*/\1/')
      echo '{"type":"control_response","response":{"subtype":"success","request_id":"'"$id"'","response":{"mcpServers":[{"name":"linear","status":"needs-auth","config":{"type":"http","url":"https://mcp.linear.app/mcp"},"scope":"user","tools":[]}]}}}' ;;
    *'run a command'*)
      echo '{"type":"control_request","request_id":"b1","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"t1","input":{"command":"npm test"}}}' ;;
    *'propose a plan'*)
      echo '{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"t2","name":"ExitPlanMode","input":{"plan":"Add a theme"}}]}}'
      echo '{"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","tool_use_id":"t2","input":{"plan":"Add a theme"}}}' ;;
    *'propose it again'*)
      echo '{"type":"assistant","message":{"id":"m4","content":[{"type":"tool_use","id":"t4","name":"ExitPlanMode","input":{"plan":"Add a theme"}}]}}'
      echo '{"type":"control_request","request_id":"p2","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","tool_use_id":"t4","input":{"plan":"Add a theme"}}}' ;;
    *'agent asks'*)
      echo '{"type":"system","subtype":"task_started","task_id":"a1","tool_use_id":"toolu_1","description":"Pick colours","subagent_type":"general-purpose","is_backgrounded":true,"prompt":"Ask for colours."}'
      echo '{"type":"control_request","request_id":"q2","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"t5","agent_id":"a1","input":{"questions":[{"question":"Which colours?","header":"Colours","multiSelect":false,"options":[{"label":"GitHub","description":"Green and purple"}]}]}}}' ;;
    *'ask me'*)
      echo '{"type":"assistant","message":{"id":"m3","content":[{"type":"tool_use","id":"t3","name":"AskUserQuestion","input":{"questions":[{"question":"Which size?","header":"Size","multiSelect":false,"options":[{"label":"Large","description":"Roomy"},{"label":"Small","description":"Compact"}]},{"question":"Which colours?","header":"Colours","multiSelect":false,"options":[{"label":"GitHub","description":"Green and purple"},{"label":"Mono","description":"Greys"}]}]}}]}}'
      echo '{"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"t3","input":{"questions":[{"question":"Which size?","header":"Size","multiSelect":false,"options":[{"label":"Large","description":"Roomy"},{"label":"Small","description":"Compact"}]},{"question":"Which colours?","header":"Colours","multiSelect":false,"options":[{"label":"GitHub","description":"Green and purple"},{"label":"Mono","description":"Greys"}]}]}}}' ;;
    *'"mode":"auto"'*)
      echo '{"type":"system","subtype":"status","status":null,"permissionMode":"auto"}'
      echo '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
    *'run a long command'*)
      echo '{"type":"assistant","message":{"id":"m5","content":[{"type":"tool_use","id":"t6","name":"Bash","input":{"command":"pnpm stack:check"}}]}}' ;;
    *'queue this'*) ;;
    *'crash now'*) exit 3 ;;
    *'"send_now":true'*)
      uuid=$(printf '%s' "$line" | sed 's/.*"message_uuid":"\([^"]*\)".*/\1/')
      echo '{"type":"result","subtype":"error_during_execution","is_error":true,"usage":{}}'
      echo '{"type":"command_lifecycle","command_uuid":"'"$uuid"'","state":"started"}'
      echo '{"type":"assistant","message":{"id":"m6","content":[{"type":"text","text":"Port 4000."}]}}'
      echo '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
    *'launch an agent'*)
      echo '{"type":"system","subtype":"task_started","task_id":"a1","tool_use_id":"toolu_1","description":"List files","subagent_type":"general-purpose","is_backgrounded":true,"prompt":"List the files."}'
      echo '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
    *'"subtype":"stop_task"'*)
      echo '{"type":"system","subtype":"task_updated","task_id":"a1","patch":{"status":"killed","end_time":1791970412270}}'
      echo '{"type":"system","subtype":"task_notification","task_id":"a1","tool_use_id":"toolu_1","status":"stopped","summary":"List files"}' ;;
    *'approve the plan'*)
      echo '{"type":"system","subtype":"status","status":null,"permissionMode":"acceptEdits"}'
      echo '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
    *'"type":"user"'*)
      echo '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}'
      echo '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}'
      echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}}'
      echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hello"}]}}'
      echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":2}}' ;;
  esac
done
"#;

    /// An environment whose PATH finds the fake `claude`, written under `dir`.
    pub(crate) fn fake_claude_env(dir: &Path) -> BTreeMap<String, String> {
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let fake = bin.join("claude");
        std::fs::write(&fake, FAKE_CLAUDE).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        BTreeMap::from([("PATH".to_string(), format!("{}:/usr/bin:/bin", bin.display()))])
    }

    async fn setup() -> (tempfile::TempDir, Arc<TerminalManager>, Arc<ChatManager>) {
        let dir = tempfile::tempdir().unwrap();
        let env = fake_claude_env(dir.path());
        let terms = TerminalManager::new(dir.path().join("sock"), env);
        let chats = ChatManager::new(terms.clone(), dir.path().join("chats"));
        (dir, terms, chats)
    }

    async fn wait_for(chats: &ChatManager, id: TerminalId, f: impl Fn(&ChatState) -> bool) -> ChatState {
        for _ in 0..200 {
            let st = chats.state(id).unwrap();
            if f(&st) {
                return st;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("timed out: {:?}", chats.state(id).unwrap());
    }

    #[tokio::test]
    async fn runs_a_turn_persists_and_restores() {
        let (dir, terms, chats) = setup().await;
        let info = chats
            .create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), name: "t".into(), ..Default::default() })
            .unwrap();
        assert!(info.chat);
        assert!(terms.list().iter().any(|t| t.id == info.id && t.chat));
        wait_for(&chats, info.id, |s| s.agent_session.is_some()).await;
        chats.send(info.id, "hi", &[]).unwrap();
        let st = wait_for(&chats, info.id, |s| s.status == "done").await;
        assert_eq!(st.items.iter().find(|i| i.kind == "assistant").unwrap().text, "hello");
        assert_eq!(terms.get(info.id).unwrap().info().agent_state, AgentState::Done);
        chats.save_all();

        // A new daemon: same id, transcript back, agent not yet started.
        let terms2 = TerminalManager::new(dir.path().join("sock2"), terms.base_env().clone());
        let chats2 = ChatManager::new(terms2.clone(), dir.path().join("chats"));
        assert_eq!(chats2.restore(), 1);
        let st2 = chats2.state(info.id).unwrap();
        assert_eq!(st2.items.len(), st.items.len());
        assert_eq!(st2.agent_session.as_deref(), Some("sess-1"));
        assert!(terms2.get(info.id).unwrap().info().chat);
        assert_eq!(terms2.get(info.id).unwrap().info().agent_state, AgentState::Done);

        // The next message resumes the agent and keeps earlier messages intact.
        chats2.send(info.id, "again", &[]).unwrap();
        let st3 = wait_for(&chats2, info.id, |s| s.status == "done" && s.items.len() > st2.items.len()).await;
        let users: Vec<_> = st3.items.iter().filter(|i| i.kind == "user").map(|i| i.text.as_str()).collect();
        assert_eq!(users, ["hi", "again"]);
        chats2.shutdown();

        // Closing the tab forgets the conversation.
        terms.kill(info.id, true).unwrap();
        assert!(!chats.is_chat(info.id));
        assert!(!dir.path().join("chats").join(format!("{}.json", info.id)).exists());
    }

    /// A chat whose agent runs `pnpm stack:check` and holds "queue this" (X49).
    async fn holding_a_queued_message(chats: &ChatManager, cwd: &Path) -> TerminalId {
        let id = chats.create(ChatCreate { cwd: cwd.display().to_string(), agent: "claude".into(), ..Default::default() }).unwrap().id;
        wait_for(chats, id, |s| s.agent_session.is_some()).await;
        chats.send(id, "run a long command", &[]).unwrap();
        wait_for(chats, id, |s| s.items.iter().any(|i| i.tool.is_some())).await;
        chats.send(id, "queue this", &[]).unwrap();
        assert_eq!(chats.state(id).unwrap().queued.len(), 1);
        id
    }

    fn last_two(st: &ChatState) -> Vec<(&str, &str)> {
        st.items[st.items.len() - 2..].iter().map(|i| (i.kind.as_str(), i.text.as_str())).collect()
    }

    #[tokio::test]
    async fn a_message_still_queued_when_the_agent_stops_is_not_delivered() {
        let (dir, _terms, chats) = setup().await;
        let id = holding_a_queued_message(&chats, dir.path()).await;
        chats.stop(id, false);
        let st = chats.state(id).unwrap();
        assert!(st.queued.is_empty());
        assert_eq!(last_two(&st), [("user", "queue this"), ("system", "Not delivered: Claude stopped before reading this message.")]);
    }

    #[tokio::test]
    async fn send_now_delivers_a_queued_message_in_place_of_the_running_turn() {
        let (dir, _terms, chats) = setup().await;
        let id = holding_a_queued_message(&chats, dir.path()).await;
        let message = chats.state(id).unwrap().queued[0].id.clone();
        chats.send_now(id, Some(&message)).unwrap();
        let st = wait_for(&chats, id, |s| s.status == "done").await;
        let shown: Vec<(&str, &str)> = st.items.iter().filter(|i| i.tool.is_none()).map(|i| (i.kind.as_str(), i.text.as_str())).collect();
        assert_eq!(shown[shown.len() - 3..], [("system", "Interrupted"), ("user", "queue this"), ("assistant", "Port 4000.")]);
    }

    #[tokio::test]
    async fn only_a_queued_message_can_be_unqueued() {
        let (dir, _terms, chats) = setup().await;
        let id = holding_a_queued_message(&chats, dir.path()).await;
        let err = chats.unqueue(id, "not-a-queued-message").unwrap_err();
        assert_eq!(err.to_string(), "no queued message not-a-queued-message");
        let message = chats.state(id).unwrap().queued[0].id.clone();
        chats.unqueue(id, &message).unwrap();
    }

    #[tokio::test]
    async fn an_aside_answers_from_a_fork_and_leaves_the_running_turn_alone() {
        let (dir, _terms, chats) = setup().await;
        let id = holding_a_queued_message(&chats, dir.path()).await;
        let before = chats.state(id).unwrap();
        let answer = chats.aside(id, "which port is the api on?").await.unwrap();
        assert_eq!(answer, AsideAnswer { text: "Port 4000.".into(), cost_usd: 0.0015, duration_ms: 1200 });
        let args = std::fs::read_to_string(dir.path().join("claude-args")).unwrap();
        assert!(args.contains("-p --resume sess-1 --fork-session --no-session-persistence --tools  --output-format json"), "{args}");
        assert!(args.contains("Your tool call `pnpm stack:check` is still running in the main session"), "{args}");
        assert_eq!(chats.state(id).unwrap(), before);
    }

    #[tokio::test]
    async fn an_aside_needs_a_claude_conversation() {
        let (dir, _terms, chats) = setup().await;
        let codex = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "codex".into(), ..Default::default() }).unwrap().id;
        assert_eq!(chats.aside(codex, "hi").await.unwrap_err().to_string(), "Ask aside works with Claude only");
    }

    #[tokio::test]
    async fn an_aside_needs_a_conversation_to_ask_about() {
        let dir = tempfile::tempdir().unwrap();
        // No `claude` on PATH: the chat never gets a conversation.
        let terms = TerminalManager::new(dir.path().join("sock"), BTreeMap::from([("PATH".to_string(), "/nonexistent".to_string())]));
        let chats = ChatManager::new(terms, dir.path().join("chats"));
        let id = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), ..Default::default() }).unwrap().id;
        assert_eq!(chats.aside(id, "hi").await.unwrap_err().to_string(), "Claude has no conversation to ask about yet");
    }

    #[tokio::test]
    async fn an_aside_after_a_profile_switch_asks_for_a_message_first() {
        let (dir, _terms, chats) = setup().await;
        let profile = Arc::new(Mutex::new("/profiles/personal".to_string()));
        let current = profile.clone();
        chats.set_session_env(Box::new(move |_| SessionLaunch {
            env: BTreeMap::from([(crate::profiles::CONFIG_DIR_VAR.to_string(), current.lock().unwrap().clone())]),
            profile: Some("Work".into()),
        }));
        let id = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), session_id: Some("s1".into()), ..Default::default() }).unwrap().id;
        wait_for(&chats, id, |s| s.agent_session.is_some()).await;
        *profile.lock().unwrap() = "/profiles/work".into();
        let err = chats.aside(id, "which port?").await.unwrap_err();
        assert_eq!(err.to_string(), "This conversation is in another Claude profile: send Claude a message to start one in Work.");
    }

    #[tokio::test]
    async fn a_message_queued_when_the_agent_crashes_is_not_delivered() {
        let (dir, _terms, chats) = setup().await;
        let id = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), ..Default::default() }).unwrap().id;
        wait_for(&chats, id, |s| s.agent_session.is_some()).await;
        chats.send(id, "run a long command", &[]).unwrap();
        wait_for(&chats, id, |s| s.items.iter().any(|i| i.tool.is_some())).await;
        chats.send(id, "crash now", &[]).unwrap();
        let st = wait_for(&chats, id, |s| s.status == "error").await;
        assert!(st.queued.is_empty());
        let shown: Vec<(&str, &str)> = st.items.iter().map(|i| (i.kind.as_str(), i.text.as_str())).collect();
        assert_eq!(shown[shown.len() - 3..], [("error", "The agent exited (code 3)."), ("user", "crash now"), ("system", "Not delivered: Claude stopped before reading this message.")]);
    }

    #[tokio::test]
    async fn a_message_still_queued_at_a_daemon_restart_is_not_delivered() {
        let (dir, terms, chats) = setup().await;
        let id = holding_a_queued_message(&chats, dir.path()).await;
        chats.save_all();
        let terms2 = TerminalManager::new(dir.path().join("sock2"), terms.base_env().clone());
        let chats2 = ChatManager::new(terms2, dir.path().join("chats"));
        chats2.restore();
        let st = chats2.state(id).unwrap();
        assert!(st.queued.is_empty());
        assert_eq!(last_two(&st), [("user", "queue this"), ("system", "Not delivered: Claude stopped before reading this message.")]);
        chats.shutdown();
    }

    /// X40: the phone's Inbox reads every chat's pending asks at once,
    /// without loading every conversation.
    #[tokio::test]
    async fn summaries_carry_every_chats_asks_without_its_items() {
        let (dir, _terms, chats) = setup().await;
        let cwd = dir.path().display().to_string();
        let a = chats.create(ChatCreate { cwd: cwd.clone(), agent: "claude".into(), ..Default::default() }).unwrap();
        let b = chats.create(ChatCreate { cwd, agent: "claude".into(), ..Default::default() }).unwrap();
        wait_for(&chats, a.id, |s| s.agent_session.is_some()).await;
        let before = crate::paths::now_ms();
        chats.send(a.id, "run a command", &[]).unwrap();
        wait_for(&chats, a.id, |s| !s.pending.is_empty()).await;
        let after = crate::paths::now_ms();

        let mut sums = chats.summaries();
        sums.sort_by_key(|(id, _)| *id);
        assert_eq!(sums.iter().map(|(id, _)| *id).collect::<Vec<_>>(), [a.id, b.id]);
        let (_, sa) = &sums[0];
        assert!(sa.items.is_empty(), "items are left out");
        assert_eq!(sa.status, "blocked");
        assert_eq!(sa.pending.len(), 1);
        assert_eq!(sa.pending[0].tool, "Bash");
        let asked = sa.pending[0].asked_at.expect("the ask says when it was asked");
        assert!(before <= asked && asked <= after, "{before} <= {asked} <= {after}");
        assert!(sums[1].1.pending.is_empty());
        chats.shutdown();
    }

    #[tokio::test]
    async fn an_added_directory_restarts_the_agent_with_it() {
        let (dir, _terms, chats) = setup().await;
        let extra = dir.path().join("shared-lib");
        std::fs::create_dir(&extra).unwrap();
        let extra = extra.display().to_string();
        let info = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), ..Default::default() }).unwrap();
        wait_for(&chats, info.id, |s| s.agent_session.is_some()).await;

        assert!(chats.add_dir(info.id, "/no/such/dir").is_err());
        let st = chats.add_dir(info.id, &extra).unwrap();
        assert_eq!(st.add_dirs, [extra.clone()]);
        assert_eq!(st.items.last().unwrap().text, format!("Added directory {extra}. The agent can use it from the next message."));
        let again = chats.add_dir(info.id, &extra).unwrap();
        assert_eq!(again.add_dirs, [extra.clone()]);
        assert_eq!(again.items.len(), st.items.len(), "adding it twice changes nothing");

        chats.send(info.id, "hi", &[]).unwrap();
        wait_for(&chats, info.id, |s| s.status == "done").await;
        let starts = std::fs::read_to_string(dir.path().join("claude-args")).unwrap();
        let lines: Vec<&str> = starts.lines().collect();
        assert_eq!(lines.len(), 2, "{starts}");
        assert!(!lines[0].contains("--add-dir"));
        assert!(lines[1].contains(&format!("--add-dir {extra}")), "{}", lines[1]);
        chats.shutdown();
    }

    #[tokio::test]
    async fn listing_mcp_servers_starts_a_stopped_agent_and_reports_them() {
        let (dir, terms, chats) = setup().await;
        let info = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), ..Default::default() }).unwrap();
        wait_for(&chats, info.id, |s| s.agent_session.is_some()).await;
        chats.save_all();
        chats.shutdown();

        // After a daemon restart the agent is not running until it is needed.
        let terms2 = TerminalManager::new(dir.path().join("sock2"), terms.base_env().clone());
        let chats2 = ChatManager::new(terms2, dir.path().join("chats"));
        chats2.restore();
        chats2.mcp(info.id, "refresh", None).unwrap();
        let st = wait_for(&chats2, info.id, |s| s.mcp_servers.is_some()).await;
        let servers = st.mcp_servers.unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!((servers[0].name.as_str(), servers[0].status.as_str(), servers[0].endpoint.as_deref()), ("linear", "needs-auth", Some("https://mcp.linear.app/mcp")));
        assert!(chats2.mcp(info.id, "explode", None).is_err());
        chats2.shutdown();
    }

    #[tokio::test]
    async fn added_directories_must_be_absolute_directories() {
        let (dir, _terms, chats) = setup().await;
        let cwd = dir.path().display().to_string();
        // Each would reach the agent's command line as a flag.
        for bad in ["--permission-mode=bypassPermissions", "-n", "relative/dir", "/no/such/dir"] {
            let r = chats.create(ChatCreate { cwd: cwd.clone(), agent: "claude".into(), add_dirs: vec![bad.into()], ..Default::default() });
            assert!(r.is_err(), "{bad} was accepted");
        }
        assert!(chats.add_dir(1, "--permission-mode=bypassPermissions").is_err());
    }

    #[tokio::test]
    async fn permission_mode_is_validated_stored_and_restored() {
        let (dir, _terms, chats) = setup().await;
        let info = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), ..Default::default() }).unwrap();
        assert!(chats.settings(info.id, None, None, Some("yolo".into())).is_err());
        assert_eq!(chats.state(info.id).unwrap().mode, None);
        let st = chats.settings(info.id, None, None, Some("plan".into())).unwrap();
        assert_eq!(st.mode.as_deref(), Some("plan"));
        let chat = chats.get(info.id).unwrap();
        assert_eq!(chat.inner.lock().unwrap().cfg.mode.as_deref(), Some("plan"));
        assert!(chat.inner.lock().unwrap().restart);
        chats.save_all();
        let saved = std::fs::read_to_string(dir.path().join("chats").join(format!("{}.json", info.id))).unwrap();
        assert!(saved.contains("\"mode\":\"plan\""));
        chats.shutdown();
    }

    #[tokio::test]
    async fn the_agent_restarts_in_the_mode_claude_last_reported() {
        let (dir, terms, chats) = setup().await;
        let info = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), mode: Some("plan".into()), ..Default::default() }).unwrap();
        wait_for(&chats, info.id, |s| s.agent_session.is_some()).await;
        chats.send(info.id, "approve the plan", &[]).unwrap();
        wait_for(&chats, info.id, |s| s.status == "done" && s.mode.as_deref() == Some("acceptEdits")).await;
        let last_start = || std::fs::read_to_string(dir.path().join("claude-args")).unwrap().lines().last().unwrap().to_string();

        // A settings change restarts the agent before the next message.
        chats.settings(info.id, Some("opus".into()), None, None).unwrap();
        chats.send(info.id, "hi", &[]).unwrap();
        wait_for(&chats, info.id, |s| s.status == "done" && s.items.iter().filter(|i| i.kind == "user").count() == 2).await;
        assert!(last_start().contains("--permission-mode acceptEdits"), "{}", last_start());

        // So does a daemon restart.
        chats.save_all();
        chats.shutdown();
        let terms2 = TerminalManager::new(dir.path().join("sock2"), terms.base_env().clone());
        let chats2 = ChatManager::new(terms2, dir.path().join("chats"));
        chats2.restore();
        assert_eq!(chats2.state(info.id).unwrap().mode.as_deref(), Some("acceptEdits"));
        chats2.send(info.id, "again", &[]).unwrap();
        wait_for(&chats2, info.id, |s| s.status == "done" && s.items.iter().filter(|i| i.kind == "user").count() == 3).await;
        assert!(last_start().contains("--permission-mode acceptEdits"), "{}", last_start());
        chats2.shutdown();
    }

    #[tokio::test]
    async fn approving_a_plan_can_switch_to_auto() {
        let (dir, _terms, chats) = setup().await;
        let info = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), mode: Some("plan".into()), ..Default::default() }).unwrap();
        wait_for(&chats, info.id, |s| s.agent_session.is_some()).await;
        chats.send(info.id, "propose a plan", &[]).unwrap();
        wait_for(&chats, info.id, |s| s.status == "blocked").await;
        chats.permission(info.id, "p1", "allow", None, None, Some("auto")).unwrap();
        wait_for(&chats, info.id, |s| s.status == "done" && s.mode.as_deref() == Some("auto")).await;

        // The next start keeps Auto.
        chats.settings(info.id, Some("opus".into()), None, None).unwrap();
        chats.send(info.id, "hi", &[]).unwrap();
        wait_for(&chats, info.id, |s| s.status == "done" && s.items.iter().filter(|i| i.kind == "user").count() == 2).await;
        let last_start = std::fs::read_to_string(dir.path().join("claude-args")).unwrap().lines().last().unwrap().to_string();
        assert!(last_start.contains("--permission-mode auto"), "{last_start}");
        chats.shutdown();
    }

    #[tokio::test]
    async fn a_plan_approval_only_switches_to_auto_or_accept_edits() {
        let (dir, _terms, chats) = setup().await;
        let info = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), mode: Some("plan".into()), ..Default::default() }).unwrap();
        wait_for(&chats, info.id, |s| s.agent_session.is_some()).await;
        for mode in ["bypassPermissions", "plan", "manual"] {
            let err = chats.permission(info.id, "ask-1", "allow", None, None, Some(mode)).unwrap_err();
            assert_eq!(err.to_string(), "a plan can only be approved into auto or acceptEdits");
        }
        let err = chats.permission(info.id, "ask-1", "deny", None, None, Some("acceptEdits")).unwrap_err();
        assert_eq!(err.to_string(), "a mode needs decision allow");

        // Any other ask is answered without a mode, or not at all.
        chats.send(info.id, "run a command", &[]).unwrap();
        wait_for(&chats, info.id, |s| s.status == "blocked").await;
        let err = chats.permission(info.id, "b1", "allow", None, None, Some("acceptEdits")).unwrap_err();
        assert_eq!(err.to_string(), "only a plan approval can switch the mode");
        let st = chats.state(info.id).unwrap();
        assert_eq!(st.pending.iter().map(|p| p.tool.as_str()).collect::<Vec<_>>(), ["Bash"]);
        assert_eq!(st.mode.as_deref(), Some("plan"));
        chats.shutdown();
    }

    #[tokio::test]
    async fn a_new_chat_starts_in_the_requested_mode() {
        let (dir, _terms, chats) = setup().await;
        let cwd = dir.path().display().to_string();
        let bad = chats.create(ChatCreate { cwd: cwd.clone(), agent: "claude".into(), mode: Some("yolo".into()), ..Default::default() });
        assert!(bad.is_err());
        let info = chats.create(ChatCreate { cwd, agent: "claude".into(), mode: Some("acceptEdits".into()), ..Default::default() }).unwrap();
        assert!(info.command.join(" ").contains("--permission-mode acceptEdits"), "{:?}", info.command);
        wait_for(&chats, info.id, |s| s.agent_session.is_some()).await;
        assert_eq!(chats.state(info.id).unwrap().mode.as_deref(), Some("acceptEdits"));
        chats.shutdown();
    }

    /// X22: the agent can reach the daemon with `moonlet`, whatever MOONLET_HOME is.
    #[tokio::test]
    async fn the_agent_gets_the_daemon_socket_and_its_terminal_id() {
        let (dir, _terms, chats) = setup().await;
        let out = dir.path().join("env.txt");
        std::fs::write(
            dir.path().join("bin/claude"),
            format!("#!/bin/sh\nprintf '%s\\n' \"$MOONLET_SOCK\" \"$MOONLET_TERMINAL_ID\" > '{}'\nexec cat >/dev/null\n", out.display()),
        )
        .unwrap();
        let info = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), ..Default::default() }).unwrap();
        for _ in 0..200 {
            if std::fs::read_to_string(&out).is_ok_and(|s| s.lines().count() == 2) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let sock = dir.path().join("sock");
        assert_eq!(std::fs::read_to_string(&out).unwrap(), format!("{}\n{}\n", sock.display(), info.id));
        chats.shutdown();
    }

    #[tokio::test]
    async fn stopping_a_busy_agent_ends_its_turn() {
        let (dir, terms, chats) = setup().await;
        let info = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), ..Default::default() }).unwrap();
        chats.get(info.id).unwrap().inner.lock().unwrap().state.status = "working".into();
        terms.kill(info.id, false).unwrap();
        let st = chats.state(info.id).unwrap();
        assert_eq!(st.status, "idle");
        assert_eq!(st.items.last().unwrap().text, "Stopped");
        assert_eq!(terms.get(info.id).unwrap().info().agent_state, AgentState::Idle);
    }

    /// X42: one subagent stopped from the app; the terminal counts running ones.
    #[tokio::test]
    async fn a_running_subagent_can_be_stopped() {
        let (dir, terms, chats) = setup().await;
        let info = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), ..Default::default() }).unwrap();
        wait_for(&chats, info.id, |s| s.agent_session.is_some()).await;
        chats.send(info.id, "launch an agent", &[]).unwrap();
        wait_for(&chats, info.id, |s| s.status == "done" && s.subagents.first().is_some_and(|a| a.status == "running")).await;
        assert_eq!(terms.get(info.id).unwrap().info().subagents, 1);
        assert!(chats.stop_agent(info.id, "nope").is_err(), "an unknown agent");

        chats.stop_agent(info.id, "a1").unwrap();
        let st = wait_for(&chats, info.id, |s| s.subagents[0].status == "stopped").await;
        assert_eq!(st.subagents[0].ended_at, Some(1791970412270));
        assert_eq!(terms.get(info.id).unwrap().info().subagents, 0);
        assert!(chats.stop_agent(info.id, "a1").is_err(), "no longer running");
        chats.shutdown();
    }

    /// The agent states `agent.attention` raised for `id` since the last call.
    fn attention(events: &mut tokio::sync::broadcast::Receiver<Message>, id: TerminalId) -> Vec<AgentState> {
        let mut out = Vec::new();
        while let Ok(ev) = events.try_recv() {
            if let Message::Event { name, data } = ev
                && name == methods::EV_AGENT_ATTENTION
            {
                let a: methods::Attention = serde_json::from_value(data).unwrap();
                if a.terminal == id {
                    out.push(a.state);
                }
            }
        }
        out
    }

    #[tokio::test]
    async fn a_turn_is_not_done_while_its_subagents_run() {
        let (dir, terms, chats) = setup().await;
        let mut events = terms.subscribe_events();
        let info = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "claude".into(), ..Default::default() }).unwrap();
        wait_for(&chats, info.id, |s| s.agent_session.is_some()).await;
        chats.send(info.id, "launch an agent", &[]).unwrap();
        wait_for(&chats, info.id, |s| s.status == "done" && s.subagents.first().is_some_and(|a| a.status == "running")).await;
        assert_eq!(terms.get(info.id).unwrap().info().agent_state, AgentState::Working);
        assert_eq!(attention(&mut events, info.id), []);

        chats.stop_agent(info.id, "a1").unwrap();
        wait_for(&chats, info.id, |s| s.subagents[0].status == "stopped").await;
        assert_eq!(terms.get(info.id).unwrap().info().agent_state, AgentState::Done);
        assert_eq!(attention(&mut events, info.id), [AgentState::Done]);
        chats.shutdown();
    }

    #[tokio::test]
    async fn subagents_stop_with_their_agent_and_after_a_restart() {
        let (dir, terms, chats) = setup().await;
        let cwd = dir.path().display().to_string();
        let a = chats.create(ChatCreate { cwd: cwd.clone(), agent: "claude".into(), ..Default::default() }).unwrap();
        let b = chats.create(ChatCreate { cwd, agent: "claude".into(), ..Default::default() }).unwrap();
        for id in [a.id, b.id] {
            wait_for(&chats, id, |s| s.agent_session.is_some()).await;
            chats.send(id, "launch an agent", &[]).unwrap();
            wait_for(&chats, id, |s| s.subagents.first().is_some_and(|x| x.status == "running")).await;
        }
        // The agent process of `a` is stopped.
        terms.kill(a.id, false).unwrap();
        assert_eq!(chats.state(a.id).unwrap().subagents[0].status, "stopped");
        assert_eq!(terms.get(a.id).unwrap().info().subagents, 0);

        // The daemon restarts while `b`'s subagent runs.
        chats.save_all();
        let terms2 = TerminalManager::new(dir.path().join("sock2"), terms.base_env().clone());
        let chats2 = ChatManager::new(terms2.clone(), dir.path().join("chats"));
        chats2.restore();
        assert_eq!(chats2.state(b.id).unwrap().subagents[0].status, "stopped");
        chats.shutdown();
    }

    /// A daemon on a fresh socket over the same chats directory, as after an update.
    fn restarted(dir: &Path, terms: &TerminalManager) -> Arc<ChatManager> {
        let terms2 = TerminalManager::new(dir.join("sock2"), terms.base_env().clone());
        let chats2 = ChatManager::new(terms2, dir.join("chats"));
        chats2.restore();
        chats2
    }

    /// A new Claude chat, blocked on what `text` makes the fake agent ask.
    async fn blocked_chat(dir: &Path, chats: &ChatManager, mode: Option<&str>, text: &str) -> TerminalId {
        let info = chats.create(ChatCreate { cwd: dir.display().to_string(), agent: "claude".into(), mode: mode.map(String::from), ..Default::default() }).unwrap();
        wait_for(chats, info.id, |s| s.agent_session.is_some()).await;
        chats.send(info.id, text, &[]).unwrap();
        wait_for(chats, info.id, |s| s.status == "blocked").await;
        info.id
    }

    /// The arguments of the fake agent's latest start.
    fn last_start(dir: &Path) -> String {
        std::fs::read_to_string(dir.join("claude-args")).unwrap().lines().last().unwrap().to_string()
    }

    fn last_user_text(st: &ChatState) -> &str {
        &st.items.iter().rev().find(|i| i.kind == "user").unwrap().text
    }

    fn tool_status(st: &ChatState, name: &str) -> String {
        st.items.iter().filter_map(|i| i.tool.as_ref()).find(|t| t.name == name).unwrap().status.clone()
    }

    #[tokio::test]
    async fn a_question_waits_through_a_daemon_restart_and_its_answer_resumes_claude() {
        let (dir, terms, chats) = setup().await;
        let id = blocked_chat(dir.path(), &chats, None, "ask me").await;
        chats.shutdown();

        let chats2 = restarted(dir.path(), &terms);
        let st = chats2.state(id).unwrap();
        assert_eq!(st.status, "blocked");
        assert_eq!(st.pending.iter().map(|p| (p.id.as_str(), p.summary.as_str())).collect::<Vec<_>>(), [("q1", "Which size?")]);
        assert_eq!(tool_status(&st, "AskUserQuestion"), "running");
        assert!(!st.items.iter().any(|i| i.text == "Interrupted by a daemon restart"));

        let answers = BTreeMap::from([("Which colours?".to_string(), "GitHub".to_string()), ("Which size?".to_string(), "Large".to_string())]);
        chats2.permission(id, "q1", "allow", None, Some(&answers), None).unwrap();
        let st = wait_for(&chats2, id, |s| s.status == "done").await;
        assert!(st.pending.is_empty());
        assert_eq!(tool_status(&st, "AskUserQuestion"), "ok");
        assert_eq!(last_user_text(&st), "Answers to your questions:\n\nWhich size?\nLarge\n\nWhich colours?\nGitHub");
        let start = last_start(dir.path());
        assert!(start.contains("--resume sess-1"), "{start}");
        chats2.shutdown();
    }

    #[tokio::test]
    async fn tool_permissions_and_subagent_asks_end_at_a_daemon_restart() {
        let (dir, terms, chats) = setup().await;
        let a = blocked_chat(dir.path(), &chats, None, "run a command").await;
        let b = blocked_chat(dir.path(), &chats, None, "agent asks").await;
        chats.shutdown();

        let chats2 = restarted(dir.path(), &terms);
        for id in [a, b] {
            let st = chats2.state(id).unwrap();
            assert_eq!(st.status, "idle");
            assert!(st.pending.is_empty(), "{:?}", st.pending);
            assert_eq!(st.items.last().unwrap().text, "Interrupted by a daemon restart");
        }
        chats2.shutdown();
    }

    #[tokio::test]
    async fn skipping_a_question_after_a_daemon_restart_tells_claude() {
        let (dir, terms, chats) = setup().await;
        let id = blocked_chat(dir.path(), &chats, None, "ask me").await;
        chats.shutdown();

        let chats2 = restarted(dir.path(), &terms);
        chats2.permission(id, "q1", "deny", Some("The user declined to answer the questions."), None, None).unwrap();
        let st = wait_for(&chats2, id, |s| s.status == "done").await;
        assert!(st.pending.is_empty());
        assert_eq!(tool_status(&st, "AskUserQuestion"), "denied");
        assert_eq!(last_user_text(&st), "The user declined to answer the questions.");
        let start = last_start(dir.path());
        assert!(start.contains("--resume sess-1"), "{start}");
        chats2.shutdown();
    }

    #[tokio::test]
    async fn stop_ends_a_question_kept_through_a_daemon_restart() {
        let (dir, terms, chats) = setup().await;
        let a = blocked_chat(dir.path(), &chats, None, "ask me").await;
        let b = blocked_chat(dir.path(), &chats, None, "ask me").await;
        chats.shutdown();

        let chats2 = restarted(dir.path(), &terms);
        // The + menu starts the agent of `b` while its question waits.
        chats2.mcp(b, "refresh", None).unwrap();
        wait_for(&chats2, b, |s| s.mcp_servers.is_some()).await;
        for id in [a, b] {
            chats2.interrupt(id).unwrap();
            let st = chats2.state(id).unwrap();
            assert_eq!(st.status, "idle");
            assert!(st.pending.is_empty());
            assert_eq!(tool_status(&st, "AskUserQuestion"), "error");
            assert_eq!(st.items.last().unwrap().text, "Interrupted");
        }
        chats2.shutdown();
    }

    #[tokio::test]
    async fn a_plan_approved_after_a_daemon_restart_resumes_claude_in_the_chosen_mode() {
        let (dir, terms, chats) = setup().await;
        let id = blocked_chat(dir.path(), &chats, Some("plan"), "propose a plan").await;
        chats.shutdown();

        let chats2 = restarted(dir.path(), &terms);
        let st = chats2.state(id).unwrap();
        assert_eq!(st.status, "blocked");
        assert_eq!(st.pending.iter().map(|p| (p.id.as_str(), p.tool.as_str())).collect::<Vec<_>>(), [("p1", "ExitPlanMode")]);

        chats2.permission(id, "p1", "allow", None, None, Some("acceptEdits")).unwrap();
        let st = wait_for(&chats2, id, |s| s.status == "done").await;
        assert!(st.pending.is_empty());
        assert_eq!(st.mode.as_deref(), Some("acceptEdits"));
        assert_eq!(tool_status(&st, "ExitPlanMode"), "ok");
        assert_eq!(last_user_text(&st), "I approve your plan. Go ahead with it.");
        let start = last_start(dir.path());
        assert!(start.contains("--permission-mode acceptEdits --resume sess-1"), "{start}");
        chats2.shutdown();
    }

    #[tokio::test]
    async fn a_plan_approved_to_ask_before_edits_after_a_daemon_restart_resumes_claude_in_manual() {
        let (dir, terms, chats) = setup().await;
        let id = blocked_chat(dir.path(), &chats, Some("plan"), "propose a plan").await;
        chats.shutdown();

        let chats2 = restarted(dir.path(), &terms);
        chats2.permission(id, "p1", "allow", None, None, None).unwrap();
        let st = wait_for(&chats2, id, |s| s.status == "done").await;
        assert_eq!(st.mode.as_deref(), Some("manual"));
        let start = last_start(dir.path());
        assert!(start.contains("--permission-mode manual --resume sess-1"), "{start}");
        chats2.shutdown();
    }

    #[tokio::test]
    async fn approving_a_plan_proposed_again_after_a_daemon_restart_closes_the_new_call() {
        let (dir, terms, chats) = setup().await;
        let id = blocked_chat(dir.path(), &chats, Some("plan"), "propose a plan").await;
        chats.permission(id, "p1", "deny", Some("Think again"), None, None).unwrap();
        // The same plan comes back as a new call.
        chats.send(id, "propose it again", &[]).unwrap();
        wait_for(&chats, id, |s| s.status == "blocked").await;
        chats.shutdown();

        let chats2 = restarted(dir.path(), &terms);
        chats2.permission(id, "p2", "allow", None, None, Some("acceptEdits")).unwrap();
        let st = wait_for(&chats2, id, |s| s.status == "done").await;
        let status = |id: &str| st.items.iter().find(|i| i.id == id).and_then(|i| i.tool.as_ref()).unwrap().status.clone();
        assert_eq!((status("t2").as_str(), status("t4").as_str()), ("denied", "ok"));
        chats2.shutdown();
    }

    #[tokio::test]
    async fn plan_feedback_after_a_daemon_restart_reaches_claude_still_in_plan_mode() {
        let (dir, terms, chats) = setup().await;
        let id = blocked_chat(dir.path(), &chats, Some("plan"), "propose a plan").await;
        chats.shutdown();

        let chats2 = restarted(dir.path(), &terms);
        chats2.permission(id, "p1", "deny", Some("Use a feature flag instead"), None, None).unwrap();
        let st = wait_for(&chats2, id, |s| s.status == "done").await;
        assert_eq!(st.mode.as_deref(), Some("plan"));
        assert_eq!(tool_status(&st, "ExitPlanMode"), "denied");
        assert_eq!(last_user_text(&st), "Use a feature flag instead");
        let start = last_start(dir.path());
        assert!(start.contains("--permission-mode plan --resume sess-1"), "{start}");
        chats2.shutdown();
    }

    #[tokio::test]
    async fn a_new_message_instead_of_an_answer_after_a_daemon_restart_drops_the_question() {
        let (dir, terms, chats) = setup().await;
        let id = blocked_chat(dir.path(), &chats, None, "ask me").await;
        chats.shutdown();

        let chats2 = restarted(dir.path(), &terms);
        chats2.send(id, "never mind, use Mono", &[]).unwrap();
        let st = wait_for(&chats2, id, |s| s.status == "done").await;
        assert!(st.pending.is_empty());
        assert_eq!(tool_status(&st, "AskUserQuestion"), "error");
        let texts: Vec<&str> = st.items.iter().filter(|i| i.kind == "system").map(|i| i.text.as_str()).collect();
        assert!(texts.is_empty(), "{texts:?}");
        assert_eq!(last_user_text(&st), "never mind, use Mono");
        chats2.shutdown();
    }

    #[tokio::test]
    async fn a_missing_agent_shows_an_error() {
        let (dir, _terms, chats) = setup().await;
        let info = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "codex".into(), ..Default::default() }).unwrap();
        let st = chats.state(info.id).unwrap();
        assert_eq!(st.status, "error");
        assert!(st.items[0].text.contains("codex not found"));
    }
}
