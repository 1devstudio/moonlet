//! Structured agents (X6): Claude Code and Codex run headless under the
//! daemon; their protocol streams are mapped onto one chat model
//! (`ChatState` / `ChatItem` in `jaunt-proto`) that the app renders.
//!
//! An [`Adapter`] is a pure state machine: protocol lines in, chat updates
//! and protocol lines out. Process handling lives in [`runtime`].

pub mod claude;
pub mod codex;
pub mod runtime;

use jaunt_proto::types::{ChatItem, ChatState, ToolCall};

use crate::paths::now_ms;

/// How to start an agent.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ChatConfig {
    pub agent: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// The agent's own conversation id to resume (Claude session, Codex thread).
    pub resume: Option<String>,
    /// Display name, passed to agents that accept one.
    pub name: String,
    pub cwd: String,
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
    /// The user sends a message.
    fn send(&mut self, text: &str, st: &mut ChatState) -> Vec<Out>;
    /// The user answers a permission request: `allow`, `always` or `deny`.
    fn permission(&mut self, ask: &str, decision: &str, message: Option<&str>, st: &mut ChatState) -> Vec<Out>;
    /// Stop the running turn.
    fn interrupt(&mut self, st: &mut ChatState) -> Vec<Out>;
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

/// An id that stays unique across agent restarts (adapters start fresh
/// when a conversation is resumed, the transcript does not).
pub(crate) fn local_id(prefix: &str) -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{prefix}-{}-{n}", now_ms())
}

pub(crate) fn item(id: impl Into<String>, kind: &str, text: impl Into<String>) -> ChatItem {
    ChatItem { id: id.into(), kind: kind.into(), text: text.into(), tool: None, ts: now_ms(), partial: false }
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
