//! Structured agents (X6): Claude Code and Codex run headless under the
//! daemon; their protocol streams are mapped onto one chat model
//! (`ChatState` / `ChatItem` in `moonlet-proto`) that the app renders.
//!
//! An [`Adapter`] is a pure state machine: protocol lines in, chat updates
//! and protocol lines out. Process handling lives in [`runtime`].

pub mod claude;
pub mod codex;
pub mod runtime;

use std::collections::{BTreeMap, HashMap};

use moonlet_proto::types::{ChatImage, ChatItem, ChatState, McpServer, ToolCall, TurnTime};

use crate::paths::now_ms;

/// Values `--permission-mode` accepts for Claude, as the picker offers them.
pub const PERMISSION_MODES: [&str; 5] = ["auto", "manual", "acceptEdits", "plan", "bypassPermissions"];

/// Rejects a permission mode `--permission-mode` would not accept.
pub fn check_mode(mode: Option<&str>) -> anyhow::Result<()> {
    match mode {
        Some(m) if !PERMISSION_MODES.contains(&m) => anyhow::bail!("unknown permission mode: {m}"),
        _ => Ok(()),
    }
}

/// Permission modes from the least to the most permissive (X22).
const MODE_ORDER: [&str; 5] = ["plan", "manual", "acceptEdits", "auto", "bypassPermissions"];

/// The mode of a session another agent starts (X22): the parent's when none
/// is asked for, and never more permissive than the parent's. A parent
/// without a mode runs as Claude's default, Manual.
pub fn spawned_mode(requested: Option<&str>, parent: Option<&str>) -> anyhow::Result<String> {
    let parent = parent.unwrap_or("manual");
    let rank = |m: &str| MODE_ORDER.iter().position(|o| *o == m);
    match requested {
        None => Ok(parent.to_string()),
        Some(m) if rank(m) > rank(parent) => {
            anyhow::bail!("permission mode {m} is more permissive than the parent's {parent}")
        }
        Some(m) => Ok(m.to_string()),
    }
}

/// How to start an agent.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ChatConfig {
    pub agent: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Claude permission mode, one of `PERMISSION_MODES`.
    pub mode: Option<String>,
    /// The agent's own conversation id to resume (Claude session, Codex thread).
    pub resume: Option<String>,
    /// Display name, passed to agents that accept one.
    pub name: String,
    pub cwd: String,
    /// Extra directories the agent may work in (X29).
    pub add_dirs: Vec<String>,
    /// The `CLAUDE_CONFIG_DIR` of the last start (X33): a conversation kept
    /// in another profile's folder cannot be resumed.
    pub config_dir: Option<String>,
}

/// What an adapter asks the runtime to do.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    /// Write one line to the agent's stdin.
    Write(String),
    /// An item was added or updated.
    Item(Box<ChatItem>),
    /// Status, pending asks, cost or settings changed.
    State,
}

pub trait Adapter: Send {
    /// Program and arguments.
    fn command(&self, cfg: &ChatConfig) -> (String, Vec<String>);
    /// Lines to write right after the process starts.
    fn start(&mut self, cfg: &ChatConfig, st: &mut ChatState) -> Vec<Out>;
    /// One line from the agent's stdout.
    fn on_line(&mut self, line: &str, st: &mut ChatState) -> Vec<Out>;
    /// The user sends a message, with images after its text (X29).
    fn send(&mut self, text: &str, images: &[ChatImage], st: &mut ChatState) -> Vec<Out>;
    /// The user answers a permission request: `allow`, `always` or `deny`.
    /// `answers` carries the user's answers to a question tool; `mode` is
    /// the permission mode an approved plan switches to.
    fn permission(&mut self, ask: &str, decision: &str, message: Option<&str>, answers: Option<&BTreeMap<String, String>>, mode: Option<&str>, st: &mut ChatState) -> Vec<Out>;
    /// Stop the running turn.
    fn interrupt(&mut self, st: &mut ChatState) -> Vec<Out>;
    /// Stop one running subagent (X42); agents without subagents ignore it.
    fn stop_agent(&mut self, _agent: &str, _st: &mut ChatState) -> Vec<Out> {
        vec![]
    }
    /// Take a queued message out of the agent's queue (X49); agents that
    /// queue nothing ignore it.
    fn unqueue(&mut self, _message: &str, _st: &mut ChatState) -> Vec<Out> {
        vec![]
    }
    /// Ask the agent to read a queued message now, or every queued one
    /// without `message` (X49); agents that queue nothing ignore it.
    fn send_now(&mut self, _message: Option<&str>, _st: &mut ChatState) -> Vec<Out> {
        vec![]
    }
    /// MCP servers (X29): `refresh` asks for their status, `reconnect`
    /// retries `server`, `auth` asks for its sign-in page and `cancel`
    /// gives up on that sign-in. Answers arrive later as state changes.
    fn mcp(&mut self, action: &str, server: Option<&str>, st: &mut ChatState) -> Vec<Out>;
}

pub fn adapter_for(agent: &str) -> Option<Box<dyn Adapter>> {
    match agent {
        "claude" => Some(Box::new(claude::Claude::default())),
        "codex" => Some(Box::new(codex::Codex::default())),
        _ => None,
    }
}

/// Agents that have a structured mode.
pub fn supports(agent: &str) -> bool {
    matches!(agent, "claude" | "codex")
}

// ------------------------------------------------------------ helpers

/// MCP sign-ins in progress (X29), by server name. The agents report such
/// a server as still needing sign-in until it connects; moonlet shows it
/// as signing in, with its page.
#[derive(Default)]
pub(crate) struct SignIns(HashMap<String, SignIn>);

struct SignIn {
    url: Option<String>,
    /// The agent does not notice the sign-in finish by itself (a claude.ai
    /// connector), so each refresh reconnects the server.
    poll: bool,
}

fn with_server(st: &mut ChatState, name: &str, f: impl FnOnce(&mut McpServer)) {
    if let Some(s) = st.mcp_servers.iter_mut().flatten().find(|s| s.name == name) {
        f(s);
    }
}

impl SignIns {
    pub(crate) fn start(&mut self, name: &str, st: &mut ChatState) {
        self.0.insert(name.to_string(), SignIn { url: None, poll: false });
        with_server(st, name, |s| {
            s.status = "authing".into();
            s.auth_url = None;
            s.error = None;
        });
    }

    pub(crate) fn page(&mut self, name: &str, url: &str, poll: bool, st: &mut ChatState) {
        if let Some(p) = self.0.get_mut(name) {
            p.url = Some(url.to_string());
            p.poll = poll;
            with_server(st, name, |s| s.auth_url = Some(url.to_string()));
        }
    }

    pub(crate) fn fail(&mut self, name: &str, error: &str, st: &mut ChatState) {
        self.0.remove(name);
        with_server(st, name, |s| {
            s.status = "failed".into();
            s.auth_url = None;
            s.error = Some(error.to_string());
        });
    }

    pub(crate) fn cancel(&mut self, name: &str, st: &mut ChatState) {
        if self.0.remove(name).is_some() {
            with_server(st, name, |s| {
                s.status = "needs-auth".into();
                s.auth_url = None;
            });
        }
    }

    /// Applies the sign-ins to a fresh list; servers past sign-in drop out.
    pub(crate) fn merge(&mut self, rows: &mut [McpServer]) {
        for s in rows.iter_mut() {
            match self.0.get(&s.name) {
                Some(p) if s.status == "needs-auth" => {
                    s.status = "authing".into();
                    s.auth_url = p.url.clone();
                }
                Some(_) => {
                    self.0.remove(&s.name);
                }
                None => {}
            }
        }
    }

    /// Servers to reconnect on each refresh.
    pub(crate) fn polled(&self) -> Vec<String> {
        let mut v: Vec<String> = self.0.iter().filter(|(_, p)| p.poll).map(|(n, _)| n.clone()).collect();
        v.sort();
        v
    }
}

/// The user's message as the transcript shows it: the text, then one
/// `[image: <name>]` line per image.
pub(crate) fn user_text(text: &str, images: &[ChatImage]) -> String {
    let mut lines: Vec<String> = if text.is_empty() { vec![] } else { vec![text.to_string()] };
    lines.extend(images.iter().map(|i| format!("[image: {}]", i.name)));
    lines.join("\n")
}

/// An id that stays unique across agent restarts (adapters start fresh
/// when a conversation is resumed, the transcript does not).
pub(crate) fn local_id(prefix: &str) -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{prefix}-{}-{n}", now_ms())
}

pub(crate) fn item(id: impl Into<String>, kind: &str, text: impl Into<String>) -> ChatItem {
    ChatItem { id: id.into(), kind: kind.into(), text: text.into(), tool: None, ts: now_ms(), partial: false, turn: None, cause: None }
}

/// Inserts or replaces by id and returns the stored copy.
pub(crate) fn upsert(st: &mut ChatState, it: ChatItem) -> Out {
    match st.items.iter_mut().find(|x| x.id == it.id) {
        Some(existing) => {
            let ts = existing.ts;
            *existing = ChatItem { ts, ..it };
            Out::Item(Box::new(existing.clone()))
        }
        None => {
            st.items.push(it.clone());
            Out::Item(Box::new(it))
        }
    }
}

/// Stamps a completed turn's final assistant message with when the turn
/// started and ended (X16); `None` without a start or an answer.
pub(crate) fn finish_turn(st: &mut ChatState, started_at: Option<u64>) -> Option<Out> {
    let started_at = started_at?;
    // The user's message bounds the turn; timestamps alone can tie across turns.
    let it = st.items.iter_mut().rev().take_while(|i| i.kind != "user" && i.ts >= started_at).find(|i| i.kind == "assistant" && !i.text.is_empty())?;
    it.turn = Some(TurnTime { started_at, ended_at: now_ms() });
    Some(Out::Item(Box::new(it.clone())))
}

/// Marks every running subagent stopped, when its agent process is gone
/// (X42). Whether any was running.
pub(crate) fn stop_subagents(st: &mut ChatState) -> bool {
    let mut any = false;
    for a in st.subagents.iter_mut().filter(|a| a.status == "running") {
        a.status = "stopped".into();
        a.ended_at.get_or_insert_with(now_ms);
        any = true;
    }
    any
}

/// Moves the messages still queued when their agent is gone into the
/// transcript, each with a note that it never reached the agent (X49).
pub(crate) fn undeliver(st: &mut ChatState) -> Vec<Out> {
    let mut out = Vec::new();
    for q in std::mem::take(&mut st.queued) {
        out.push(upsert(st, item(local_id("user"), "user", q.text)));
        out.push(upsert(st, item(local_id("system"), "system", "Not delivered: Claude stopped before reading this message.")));
    }
    out
}

/// Mutates an existing item; `None` if it is unknown.
pub(crate) fn update(st: &mut ChatState, id: &str, f: impl FnOnce(&mut ChatItem)) -> Option<Out> {
    let it = st.items.iter_mut().find(|x| x.id == id)?;
    f(it);
    Some(Out::Item(Box::new(it.clone())))
}

pub(crate) fn tool_item(id: &str, name: &str, input: serde_json::Value, status: &str) -> ChatItem {
    let mut it = item(id, "tool", "");
    it.tool = Some(ToolCall { name: name.into(), summary: summarize(name, &input), diff: diff_for(name, &input), input, output: None, status: status.into() });
    it
}

/// Removes terminal escape sequences from agent-provided text.
pub fn strip_ansi(s: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\-_])").unwrap());
    re.replace_all(s, "").chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect()
}

const MAX_OUTPUT: usize = 20_000;

pub(crate) fn clip(s: &str) -> String {
    if s.len() <= MAX_OUTPUT {
        return s.to_string();
    }
    let mut end = MAX_OUTPUT;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… ({} more bytes)", &s[..end], s.len() - end)
}

fn str_field<'a>(input: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| input.get(*k).and_then(|v| v.as_str()))
}

/// One-line description of a tool call for the collapsed row.
pub fn summarize(name: &str, input: &serde_json::Value) -> String {
    let s = match name {
        "Bash" | "shell" | "command" => str_field(input, &["command", "cmd"]).map(String::from),
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => str_field(input, &["file_path", "notebook_path", "path"]).map(String::from),
        "Grep" => str_field(input, &["pattern"]).map(|p| format!("\"{p}\"")),
        "Glob" => str_field(input, &["pattern"]).map(String::from),
        "WebFetch" => str_field(input, &["url"]).map(String::from),
        "WebSearch" => str_field(input, &["query"]).map(String::from),
        "Task" | "Agent" => str_field(input, &["description", "prompt"]).map(String::from),
        "TodoWrite" => Some("update todos".into()),
        "Skill" => str_field(input, &["skill", "command", "name"]).map(String::from),
        "AskUserQuestion" => input["questions"][0]["question"].as_str().map(String::from),
        // The plan's first heading, else its first line.
        "ExitPlanMode" => input["plan"].as_str().map(|p| {
            let mut lines = p.lines().map(str::trim).filter(|l| !l.is_empty());
            let first = lines.clone().next().unwrap_or("");
            lines.find(|l| l.starts_with('#')).map_or(first, |h| h.trim_start_matches('#').trim()).to_string()
        }),
        _ => None,
    };
    s.or_else(|| str_field(input, &["command", "file_path", "path", "description", "query"]).map(String::from))
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(200)
        .collect()
}

/// A unified-diff-like preview for edit tools.
pub fn diff_for(name: &str, input: &serde_json::Value) -> Option<String> {
    let path = str_field(input, &["file_path", "path"]).unwrap_or("file");
    let hunk = |old: &str, new: &str| {
        let mut out = String::new();
        for l in old.lines() {
            out.push_str(&format!("-{l}\n"));
        }
        for l in new.lines() {
            out.push_str(&format!("+{l}\n"));
        }
        out
    };
    match name {
        "Edit" => {
            let old = str_field(input, &["old_string"])?;
            let new = str_field(input, &["new_string"])?;
            Some(format!("--- {path}\n+++ {path}\n@@\n{}", hunk(old, new)))
        }
        "MultiEdit" => {
            let edits = input.get("edits")?.as_array()?;
            let mut out = format!("--- {path}\n+++ {path}\n");
            for e in edits {
                out.push_str("@@\n");
                out.push_str(&hunk(e.get("old_string")?.as_str()?, e.get("new_string")?.as_str()?));
            }
            Some(out)
        }
        "Write" => {
            let content = str_field(input, &["content"])?;
            Some(format!("--- /dev/null\n+++ {path}\n@@\n{}", hunk("", content)))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summaries_and_diffs() {
        assert_eq!(summarize("Bash", &json!({"command": "git status\nmore"})), "git status");
        assert_eq!(summarize("Grep", &json!({"pattern": "fn main"})), "\"fn main\"");
        assert_eq!(summarize("Read", &json!({"file_path": "/r/a.rs"})), "/r/a.rs");
        let d = diff_for("Edit", &json!({"file_path": "a.rs", "old_string": "a\nb", "new_string": "a\nc"})).unwrap();
        assert!(d.contains("-b\n") && d.contains("+c\n"));
        assert!(diff_for("Write", &json!({"file_path": "h.txt", "content": "hi"})).unwrap().contains("+hi"));
        assert!(clip(&"x".repeat(30_000)).contains("more bytes"));
        assert_eq!(strip_ansi("\x1b[1mbold\x1b[0m \x1b]0;t\x07ok\x07"), "bold ok");
    }

    #[test]
    fn upsert_keeps_first_timestamp() {
        let mut st = ChatState::default();
        let mut a = item("x", "assistant", "he");
        a.ts = 5;
        upsert(&mut st, a);
        upsert(&mut st, item("x", "assistant", "hello"));
        assert_eq!(st.items.len(), 1);
        assert_eq!(st.items[0].ts, 5);
        assert_eq!(st.items[0].text, "hello");
    }
}
