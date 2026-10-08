//! Runs structured agents: one child process per chat terminal with piped
//! stdio, its adapter, persistence under `~/.moonlet/chats` and restore.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use moonlet_proto::methods::{self, ChatItemEvent, ChatStateEvent};
use moonlet_proto::types::{AgentState, ChatImage, ChatState, StateSource, TerminalInfo, TerminalKind};
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
    stderr: Vec<String>,
    saved_at: Instant,
    dirty: bool,
}

struct Chat {
    id: TerminalId,
    inner: Mutex<Inner>,
}

pub struct ChatManager {
    terms: Arc<TerminalManager>,
    chats: Mutex<HashMap<TerminalId, Arc<Chat>>>,
    dir: PathBuf,
    me: Weak<ChatManager>,
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

/// Finds `program` on the PATH the agent will get (the login environment),
/// not the daemon's own.
fn resolve(program: &str, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    if program.contains('/') {
        return Some(PathBuf::from(program));
    }
    let path = env.get("PATH").cloned().or_else(|| std::env::var("PATH").ok())?;
    std::env::split_paths(&path).map(|d| d.join(program)).find(|p| {
        use std::os::unix::fs::PermissionsExt;
        p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    })
}

impl ChatManager {
    pub fn new(terms: Arc<TerminalManager>, dir: PathBuf) -> Arc<Self> {
        let mgr = Arc::new_cyclic(|me| Self { terms: terms.clone(), chats: Mutex::new(HashMap::new()), dir, me: me.clone() });
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
        let adapter = adapter_for(&req.agent).with_context(|| format!("{} has no structured mode", req.agent))?;
        check_mode(req.mode.as_deref())?;
        let cwd = crate::terminal::expand_home(&req.cwd);
        if !cwd.is_dir() {
            bail!("working directory does not exist: {}", cwd.display());
        }
        // Only Claude has a permission mode.
        let mode = req.mode.filter(|_| req.agent == "claude");
        let add_dirs = req.add_dirs.iter().map(|d| check_dir(d)).collect::<Result<Vec<_>>>()?;
        let cfg = ChatConfig { agent: req.agent.clone(), model: req.model, effort: req.effort, mode, resume: None, name: req.name, cwd: cwd.display().to_string(), add_dirs: add_dirs.clone() };
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
            alt_screen: false,
            chat: true,
            classic: false,
            created_at: now,
            last_output_at: now,
        });
        let chat = Arc::new(Chat {
            id: info.id,
            inner: Mutex::new(Inner {
                info: info.clone(),
                cfg,
                env: req.env,
                state: ChatState { status: "idle".into(), add_dirs, ..Default::default() },
                adapter: None,
                stdin: None,
                pid: None,
                generation: 0,
                restart: false,
                stderr: Vec::new(),
                saved_at: Instant::now(),
                dirty: true,
            }),
        });
        self.chats.lock().unwrap().insert(info.id, chat.clone());
        // Start right away so the agent is warm when the first message comes.
        {
            let mut inner = chat.inner.lock().unwrap();
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

    pub fn send(&self, id: TerminalId, text: &str, images: &[ChatImage]) -> Result<()> {
        let chat = self.get(id)?;
        let mut inner = chat.inner.lock().unwrap();
        if inner.restart || inner.stdin.is_none() {
            self.kill_process(&mut inner);
            self.settle(&chat, &mut inner, "Stopped to apply new settings");
            inner.restart = false;
            if let Err(e) = self.spawn(&chat, &mut inner) {
                self.fail(&chat, &mut inner, &format!("{e:#}"));
                return Err(e);
            }
        }
        let Inner { adapter, state, .. } = &mut *inner;
        let outs = adapter.as_mut().context("agent not running")?.send(text, images, state);
        self.apply(&chat, &mut inner, outs);
        Ok(())
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
        let Inner { adapter, state, .. } = &mut *inner;
        let outs = adapter.as_mut().context("agent not running")?.permission(ask, decision, message, answers, mode, state);
        self.apply(&chat, &mut inner, outs);
        Ok(())
    }

    pub fn interrupt(&self, id: TerminalId) -> Result<()> {
        let chat = self.get(id)?;
        let mut inner = chat.inner.lock().unwrap();
        let Inner { adapter, state, .. } = &mut *inner;
        let Some(a) = adapter.as_mut() else { return Ok(()) };
        let outs = a.interrupt(state);
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
            if matches!(state.status.as_str(), "working" | "blocked") {
                state.status = "idle".into();
                state.pending.clear();
                state.turn_started_at = None;
                interrupted = true;
            }
            for it in &mut state.items {
                it.partial = false;
                if let Some(t) = it.tool.as_mut()
                    && t.status == "running"
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
        if !matches!(inner.state.status.as_str(), "working" | "blocked") {
            return;
        }
        inner.state.status = "idle".into();
        inner.state.pending.clear();
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
        outs.push(Out::State);
        self.apply(chat, inner, outs);
    }

    fn fail(&self, chat: &Chat, inner: &mut Inner, message: &str) {
        let id = super::local_id("error");
        let o = upsert(&mut inner.state, item(id, "error", message));
        inner.state.status = "error".into();
        inner.state.turn_started_at = None;
        inner.state.pending.clear();
        self.apply(chat, inner, vec![o, Out::State]);
    }

    fn spawn(&self, chat: &Arc<Chat>, inner: &mut Inner) -> Result<()> {
        let adapter = adapter_for(&inner.cfg.agent).context("unknown agent")?;
        let mut cfg = inner.cfg.clone();
        cfg.resume = inner.state.agent_session.clone();
        let (program, args) = adapter.command(&cfg);
        let mut env = self.terms.base_env().clone();
        env.insert("MOONLET_TERMINAL_ID".into(), chat.id.to_string());
        env.insert("MOONLET_SOCK".into(), self.terms.socket().display().to_string());
        if let Some(s) = &inner.info.session_id {
            env.insert("MOONLET_SESSION".into(), s.clone());
        }
        env.extend(inner.env.clone());
        let exe = resolve(&program, &env).with_context(|| format!("{program} not found on PATH"))?;
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
            let busy = matches!(inner.state.status.as_str(), "working" | "blocked");
            if busy || !status.is_some_and(|s| s.success()) {
                let tail = inner.stderr.iter().rev().take(5).rev().cloned().collect::<Vec<_>>().join("\n");
                let code = status.and_then(|s| s.code()).map(|c| format!(" (code {c})")).unwrap_or_default();
                let msg = if tail.is_empty() { format!("The agent exited{code}.") } else { format!("The agent exited{code}:\n{tail}") };
                mgr.fail(&c, &mut inner, &msg);
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
            let _ = self.terms.report(chat.id, agent_state(&st.status), StateSource::Hook, message, inner.cfg.agent.clone().into());
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
    /// Each start appends its arguments to `claude-args` in the working directory.
    const FAKE_CLAUDE: &str = r#"#!/bin/sh
echo "$*" >> claude-args
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"system","subtype":"init","session_id":"sess-1","model":"fake","slash_commands":["clear"]}' ;;
    *'run a command'*)
      echo '{"type":"control_request","request_id":"b1","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"t1","input":{"command":"npm test"}}}' ;;
    *'propose a plan'*)
      echo '{"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","tool_use_id":"t2","input":{"plan":"Add a theme"}}}' ;;
    *'"mode":"auto"'*)
      echo '{"type":"system","subtype":"status","status":null,"permissionMode":"auto"}'
      echo '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
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

    #[tokio::test]
    async fn a_missing_agent_shows_an_error() {
        let (dir, _terms, chats) = setup().await;
        let info = chats.create(ChatCreate { cwd: dir.path().display().to_string(), agent: "codex".into(), ..Default::default() }).unwrap();
        let st = chats.state(info.id).unwrap();
        assert_eq!(st.status, "error");
        assert!(st.items[0].text.contains("codex not found"));
    }
}
