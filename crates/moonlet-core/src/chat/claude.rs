//! Claude Code over `--input-format/--output-format stream-json` with
//! `--permission-prompt-tool stdio` (the Agent SDK host protocol).

use std::collections::{BTreeMap, HashMap};

use moonlet_proto::types::{ChatImage, ChatState, ContextCategory, ContextUsage, McpServer, NamedItem, PermissionAsk, Subagent, SubagentTool};
use serde_json::{Value, json};

use super::{Adapter, ChatConfig, Out, SignIns, clip, finish_turn, item, summarize, tool_item, update, upsert, user_text};
use crate::paths::now_ms;

#[derive(Default)]
pub struct Claude {
    /// Current API message id from `message_start`.
    message: Option<String>,
    /// Blocks seen per message in full `assistant` lines (their index).
    blocks: HashMap<String, usize>,
    /// Pending permission requests: request id → (tool_use_id, suggestions, input).
    asks: HashMap<String, (Option<String>, Value, Value)>,
    seq: u64,
    /// The user stopped the turn; its `result` is not an error.
    interrupted: bool,
    /// `mcp_authenticate` requests: request id → server (X29).
    auth_ids: HashMap<String, String>,
    sign_ins: SignIns,
    /// The text of an API error Claude Code reported as a message this turn.
    /// A failed `result` repeats it, and is then not shown again.
    api_error: Option<String>,
}

impl Claude {
    fn next_id(&mut self, prefix: &str) -> String {
        self.seq += 1;
        format!("{prefix}-{}", self.seq)
    }

    fn control(&mut self, prefix: &str, request: Value) -> Out {
        let id = self.next_id(prefix);
        Out::Write(json!({"type": "control_request", "request_id": id, "request": request}).to_string())
    }

    fn user_line(text: &str, images: &[ChatImage]) -> String {
        let mut content: Vec<Value> = if text.is_empty() { vec![] } else { vec![json!({"type": "text", "text": text})] };
        content.extend(images.iter().map(|i| json!({"type": "image", "source": {"type": "base64", "media_type": i.media_type, "data": i.data}})));
        json!({
            "type": "user",
            "message": {"role": "user", "content": content},
            "parent_tool_use_id": null,
        })
        .to_string()
    }
}

/// One row of Claude's `mcp_status` reply (X29).
fn mcp_server(v: &Value) -> Option<McpServer> {
    let cfg = &v["config"];
    let kind = cfg["type"].as_str().unwrap_or(if cfg.get("command").is_some() { "stdio" } else { "http" });
    let endpoint = match cfg["url"].as_str() {
        Some(u) => Some(u.to_string()),
        None => cfg["command"].as_str().map(|c| {
            let args = cfg["args"].as_array().into_iter().flatten().filter_map(Value::as_str);
            std::iter::once(c).chain(args).collect::<Vec<_>>().join(" ")
        }),
    };
    Some(McpServer {
        name: v["name"].as_str()?.to_string(),
        status: v["status"].as_str().unwrap_or("pending").to_string(),
        transport: if kind == "claudeai-proxy" { "claude.ai".into() } else { kind.to_string() },
        endpoint,
        scope: v["scope"].as_str().map(String::from),
        error: v["error"].as_str().map(String::from),
        tools: v["tools"].as_array().into_iter().flatten().filter_map(|t| t["name"].as_str().map(String::from)).collect(),
        auth_url: None,
    })
}

/// Claude's `get_context_usage` reply (X34): the used categories only.
fn context_usage(r: &Value) -> Option<ContextUsage> {
    let categories = r["categories"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["kind"] == "used")
        .filter_map(|c| Some(ContextCategory { name: c["name"].as_str()?.to_string(), tokens: c["tokens"].as_u64()? }))
        .filter(|c| c.tokens > 0)
        .collect();
    Some(ContextUsage {
        used: r["totalTokens"].as_u64()?,
        max: r["maxTokens"].as_u64()?,
        auto_compact_at: r["autoCompactThreshold"].as_u64().filter(|_| r["isAutoCompactEnabled"].as_bool().unwrap_or(false)),
        categories,
    })
}

/// Applies Claude's `task_started`, `task_progress`, `task_updated` and
/// `task_notification` lines to the chat's subagents (X42). Whether
/// anything changed.
fn task_event(v: &Value, st: &mut ChatState) -> bool {
    let Some(id) = v["task_id"].as_str() else { return false };
    if v["subtype"] == "task_started" {
        if st.subagents.iter().any(|a| a.id == id) {
            return false;
        }
        st.subagents.push(Subagent {
            id: id.into(),
            tool_use_id: v["tool_use_id"].as_str().unwrap_or_default().into(),
            description: v["description"].as_str().unwrap_or_default().into(),
            kind: v["subagent_type"].as_str().map(String::from),
            prompt: v["prompt"].as_str().unwrap_or_default().into(),
            status: "running".into(),
            started_at: now_ms(),
            ..Default::default()
        });
        return true;
    }
    let Some(a) = st.subagents.iter_mut().find(|a| a.id == id) else { return false };
    let usage = &v["usage"];
    match v["subtype"].as_str().unwrap_or_default() {
        "task_progress" => {
            a.activity = v["description"].as_str().map(String::from).or(a.activity.take());
        }
        "task_updated" => {
            if let Some(t) = v["patch"]["end_time"].as_u64() {
                a.ended_at = Some(t);
            }
            if let Some(e) = v["patch"]["error"].as_str() {
                a.error = Some(e.into());
            }
            return true;
        }
        "task_notification" => {
            a.status = match v["status"].as_str().unwrap_or_default() {
                "completed" => "done",
                "failed" => "failed",
                _ => "stopped",
            }
            .into();
            a.ended_at.get_or_insert_with(now_ms);
            a.duration_ms = usage["duration_ms"].as_u64().or(a.duration_ms);
            let summary = v["summary"].as_str().map(String::from);
            match a.status.as_str() {
                "done" => a.report = summary,
                "failed" => a.error = a.error.take().or(summary),
                _ => {}
            }
        }
        _ => return false,
    }
    if let Some(n) = usage["total_tokens"].as_u64() {
        a.tokens = n;
    }
    if let Some(n) = usage["tool_uses"].as_u64() {
        a.tool_uses = n;
    }
    true
}

/// The status once an ask is answered or withdrawn: still blocked by
/// another ask, else working, unless it was a subagent's ask after the main
/// turn ended (X42).
fn settle_asks(st: &mut ChatState, subagent: bool) {
    st.status = if !st.pending.is_empty() {
        "blocked"
    } else if !subagent || st.turn_started_at.is_some() {
        "working"
    } else {
        "done"
    }
    .into();
}

/// Tool calls kept per subagent (X42).
const MAX_SUBAGENT_TOOLS: usize = 200;

/// An `assistant` or `user` line from inside the subagent launched by the
/// `parent` tool call: its tool calls and model (X42). Whether anything
/// changed.
fn subagent_line(parent: &str, v: &Value, st: &mut ChatState) -> bool {
    let Some(a) = st.subagents.iter_mut().find(|a| a.tool_use_id == parent) else { return false };
    let blocks = v["message"]["content"].as_array().into_iter().flatten();
    let mut changed = false;
    match v["type"].as_str().unwrap_or_default() {
        "assistant" => {
            if let Some(m) = v["message"]["model"].as_str()
                && a.model.as_deref() != Some(m)
            {
                a.model = Some(m.into());
                changed = true;
            }
            for b in blocks.filter(|b| b["type"] == "tool_use") {
                let id = b["id"].as_str().unwrap_or_default();
                if a.tools.iter().any(|t| t.id == id) {
                    continue;
                }
                let name = b["name"].as_str().unwrap_or("tool");
                let stat = super::diff_for(name, &b["input"]).map(|d| diff_stat(&d));
                a.tools.push(SubagentTool {
                    id: id.into(),
                    name: name.into(),
                    summary: summarize(name, &b["input"]),
                    status: "running".into(),
                    added: stat.map(|s| s.0),
                    removed: stat.map(|s| s.1),
                });
                changed = true;
            }
            let extra = a.tools.len().saturating_sub(MAX_SUBAGENT_TOOLS);
            a.tools.drain(..extra);
        }
        "user" => {
            for part in blocks.filter(|b| b["type"] == "tool_result") {
                if let Some(t) = a.tools.iter_mut().find(|t| part["tool_use_id"] == t.id.as_str())
                    && t.status != "denied"
                {
                    t.status = if part["is_error"].as_bool().unwrap_or(false) { "error".into() } else { "ok".into() };
                    changed = true;
                }
            }
        }
        _ => {}
    }
    changed
}

/// Lines added and removed by a unified diff.
fn diff_stat(diff: &str) -> (u32, u32) {
    let count = |sign: char, header: &str| diff.lines().filter(|l| l.starts_with(sign) && !l.starts_with(header)).count() as u32;
    (count('+', "+++ "), count('-', "--- "))
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

impl Adapter for Claude {
    fn command(&self, cfg: &ChatConfig) -> (String, Vec<String>) {
        let mut args: Vec<String> = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-prompt-tool",
            "stdio",
        ]
        .map(String::from)
        .to_vec();
        if let Some(m) = &cfg.model {
            args.extend(["--model".into(), m.clone()]);
        }
        if let Some(e) = &cfg.effort {
            args.extend(["--effort".into(), e.clone()]);
        }
        if let Some(m) = &cfg.mode {
            args.extend(["--permission-mode".into(), m.clone()]);
        }
        match &cfg.resume {
            Some(id) => args.extend(["--resume".into(), id.clone()]),
            None => args.extend(["--session-id".into(), uuid::Uuid::new_v4().to_string()]),
        }
        if !cfg.name.is_empty() {
            args.extend(["-n".into(), cfg.name.clone()]);
        }
        for d in &cfg.add_dirs {
            args.extend(["--add-dir".into(), d.clone()]);
        }
        ("claude".into(), args)
    }

    fn start(&mut self, cfg: &ChatConfig, st: &mut ChatState) -> Vec<Out> {
        st.model = cfg.model.clone().or(st.model.take());
        st.effort = cfg.effort.clone().or(st.effort.take());
        st.mode = cfg.mode.clone().or(st.mode.take());
        if st.status.is_empty() {
            st.status = "idle".into();
        }
        let init = json!({"type": "control_request", "request_id": self.next_id("init"), "request": {"subtype": "initialize"}});
        vec![Out::Write(init.to_string()), Out::State]
    }

    fn on_line(&mut self, line: &str, st: &mut ChatState) -> Vec<Out> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return vec![] };
        let mut out = Vec::new();
        // Lines from inside a subagent go to that agent, never the transcript (X42).
        if let Some(parent) = v.get("parent_tool_use_id").filter(|p| !p.is_null()) {
            if subagent_line(parent.as_str().unwrap_or_default(), &v, st) {
                out.push(Out::State);
            }
            return out;
        }
        match v.get("type").and_then(Value::as_str).unwrap_or("") {
            "system" if v.get("subtype").and_then(Value::as_str) == Some("init") => {
                st.agent_session = v.get("session_id").and_then(Value::as_str).map(String::from);
                if let Some(m) = v.get("model").and_then(Value::as_str) {
                    st.model.get_or_insert_with(|| m.to_string());
                }
                if let Some(cmds) = v.get("slash_commands").and_then(Value::as_array) {
                    st.slash_commands = cmds.iter().filter_map(|c| c.as_str().map(String::from)).collect();
                }
                out.push(Out::State);
            }
            "system" if v.get("subtype").and_then(Value::as_str) == Some("commands_changed") => {
                if let Some(cmds) = v.get("commands").and_then(Value::as_array) {
                    st.slash_commands = cmds.iter().filter_map(|c| c["name"].as_str().map(String::from)).collect();
                    out.push(Out::State);
                }
            }
            // A background subagent started, progressed or ended (X42).
            "system" if v["subtype"].as_str().is_some_and(|s| s.starts_with("task_")) => {
                if task_event(&v, st) {
                    out.push(Out::State);
                }
            }
            // Claude changed its own mode, for example after a plan was approved.
            "system" if v.get("subtype").and_then(Value::as_str) == Some("status") => {
                let mode = match v.get("permissionMode").and_then(Value::as_str) {
                    Some("default") => Some("manual"),
                    m => m.filter(|m| super::PERMISSION_MODES.contains(m)),
                };
                if let Some(m) = mode
                    && st.mode.as_deref() != Some(m)
                {
                    st.mode = Some(m.into());
                    out.push(Out::State);
                }
            }
            "stream_event" => {
                let ev = &v["event"];
                match ev.get("type").and_then(Value::as_str).unwrap_or("") {
                    "message_start" => self.message = ev["message"]["id"].as_str().map(String::from),
                    "content_block_start" => {
                        let idx = ev["index"].as_u64().unwrap_or(0);
                        let block = &ev["content_block"];
                        let msg = self.message.clone().unwrap_or_default();
                        match block["type"].as_str().unwrap_or("") {
                            "text" | "thinking" => {
                                let kind = if block["type"] == "text" { "assistant" } else { "thinking" };
                                let mut it = item(format!("{msg}:{idx}"), kind, "");
                                it.partial = true;
                                out.push(upsert(st, it));
                            }
                            "tool_use" => {
                                let id = block["id"].as_str().unwrap_or_default();
                                let mut it = tool_item(id, block["name"].as_str().unwrap_or("tool"), json!({}), "running");
                                it.partial = true;
                                out.push(upsert(st, it));
                            }
                            _ => {}
                        }
                    }
                    "content_block_delta" => {
                        let idx = ev["index"].as_u64().unwrap_or(0);
                        let id = format!("{}:{idx}", self.message.clone().unwrap_or_default());
                        let delta = &ev["delta"];
                        let chunk = delta.get("text").or_else(|| delta.get("thinking")).and_then(Value::as_str);
                        if let Some(chunk) = chunk
                            && let Some(o) = update(st, &id, |it| it.text.push_str(chunk))
                        {
                            out.push(o);
                        }
                    }
                    _ => {}
                }
            }
            // An API error, e.g. a failed login, sent as a message.
            "assistant" if v["is_api_error_message"].as_bool().unwrap_or(false) => {
                let text: String = v["message"]["content"].as_array().into_iter().flatten().filter_map(|b| b["text"].as_str()).collect();
                let mut it = item(super::local_id("error"), "error", text.clone());
                it.cause = v["error"].as_str().map(String::from);
                out.push(upsert(st, it));
                self.api_error = Some(text);
            }
            "assistant" => {
                let msg = v["message"]["id"].as_str().unwrap_or_default().to_string();
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    let idx = {
                        let n = self.blocks.entry(msg.clone()).or_insert(0);
                        let i = *n;
                        *n += 1;
                        i
                    };
                    match block["type"].as_str().unwrap_or("") {
                        "text" => {
                            out.push(upsert(st, item(format!("{msg}:{idx}"), "assistant", block["text"].as_str().unwrap_or(""))));
                        }
                        "thinking" => {
                            let id = format!("{msg}:{idx}");
                            let text = block["thinking"].as_str().unwrap_or("").to_string();
                            // Keep streamed text when the final block is redacted to "".
                            let o = update(st, &id, |it| {
                                if !text.is_empty() {
                                    it.text = text.clone();
                                }
                                it.partial = false;
                            })
                            .unwrap_or_else(|| upsert(st, item(&id, "thinking", text.clone())));
                            out.push(o);
                        }
                        "tool_use" => {
                            let id = block["id"].as_str().unwrap_or_default();
                            let name = block["name"].as_str().unwrap_or("tool");
                            out.push(upsert(st, tool_item(id, name, block["input"].clone(), "running")));
                        }
                        _ => {}
                    }
                }
            }
            "user" => {
                for part in v["message"]["content"].as_array().into_iter().flatten() {
                    if part["type"] != "tool_result" {
                        continue;
                    }
                    let id = part["tool_use_id"].as_str().unwrap_or_default();
                    let text = clip(&result_text(&part["content"]));
                    let failed = part["is_error"].as_bool().unwrap_or(false);
                    if let Some(o) = update(st, id, |it| {
                        if let Some(t) = it.tool.as_mut() {
                            if t.status != "denied" {
                                t.status = if failed { "error".into() } else { "ok".into() };
                            }
                            t.output = Some(text.clone());
                        }
                        it.partial = false;
                    }) {
                        out.push(o);
                    }
                }
            }
            // Replies to our own control requests.
            "control_response" => {
                let resp = &v["response"];
                let rid = resp["request_id"].as_str().unwrap_or_default();
                if rid.starts_with("context-") {
                    if resp["subtype"] == "success"
                        && let Some(c) = context_usage(&resp["response"])
                    {
                        st.context = Some(c);
                        out.push(Out::State);
                    }
                } else if rid.starts_with("mcp-status-") && resp["subtype"] == "success" {
                    let mut rows: Vec<McpServer> = resp["response"]["mcpServers"].as_array().into_iter().flatten().filter_map(mcp_server).collect();
                    self.sign_ins.merge(&mut rows);
                    st.mcp_servers = Some(rows);
                    out.push(Out::State);
                } else if let Some(name) = self.auth_ids.remove(rid) {
                    let r = &resp["response"];
                    match (resp["subtype"].as_str(), r["authUrl"].as_str()) {
                        (Some("success"), Some(url)) => self.sign_ins.page(&name, url, !r["callbackExpected"].as_bool().unwrap_or(false), st),
                        // Nothing to sign in to: the status tells the rest.
                        (Some("success"), None) => out.push(self.control("mcp-status", json!({"subtype": "mcp_status"}))),
                        _ => self.sign_ins.fail(&name, resp["error"].as_str().unwrap_or("Sign-in failed."), st),
                    }
                    out.push(Out::State);
                } else if rid.starts_with("mcp-reconnect-") {
                    // Connected or not, the status shows how it went.
                    out.push(self.control("mcp-status", json!({"subtype": "mcp_status"})));
                } else if rid.starts_with("init-") && resp["subtype"] == "success" {
                    let r = &resp["response"];
                    if let Some(cmds) = r["commands"].as_array() {
                        st.slash_commands = cmds.iter().filter_map(|c| c["name"].as_str().map(String::from)).collect();
                    }
                    if let Some(agents) = r["agents"].as_array() {
                        st.agents = agents
                            .iter()
                            .filter_map(|a| Some(NamedItem { name: a["name"].as_str()?.to_string(), description: a["description"].as_str().unwrap_or_default().to_string() }))
                            .collect();
                    }
                    out.push(Out::State);
                    out.push(self.control("context", json!({"subtype": "get_context_usage", "detail": "summary"})));
                }
            }
            // Claude withdrew a request, e.g. the ask of a stopped subagent (X42).
            "control_cancel_request" => {
                let rid = v["request_id"].as_str().unwrap_or_default();
                if self.asks.remove(rid).is_some() {
                    let subagent = st.pending.iter().any(|p| p.id == rid && p.agent.is_some());
                    st.pending.retain(|p| p.id != rid);
                    settle_asks(st, subagent);
                    out.push(Out::State);
                }
            }
            "control_request" => {
                let rid = v["request_id"].as_str().unwrap_or_default().to_string();
                let req = &v["request"];
                if req["subtype"] == "can_use_tool" {
                    let tool = req["tool_name"].as_str().unwrap_or("tool").to_string();
                    let input = req["input"].clone();
                    let suggestions = req.get("permission_suggestions").cloned().unwrap_or(Value::Null);
                    let reason = req
                        .get("decision_reason")
                        .or_else(|| req.get("description"))
                        .and_then(Value::as_str)
                        .map(crate::chat::strip_ansi);
                    st.pending.push(PermissionAsk {
                        id: rid.clone(),
                        summary: summarize(&tool, &input),
                        diff: crate::chat::diff_for(&tool, &input),
                        tool,
                        input: input.clone(),
                        reason,
                        can_always: suggestions.as_array().is_some_and(|a| !a.is_empty()),
                        asked_at: Some(crate::paths::now_ms()),
                        agent: req["agent_id"].as_str().map(String::from),
                    });
                    self.asks.insert(rid, (req["tool_use_id"].as_str().map(String::from), suggestions, input));
                    st.status = "blocked".into();
                    out.push(Out::State);
                } else {
                    // Requests we do not implement must not leave the agent waiting.
                    let resp = json!({"type": "control_response", "response": {"subtype": "error", "request_id": rid, "error": "not supported by moonlet"}});
                    out.push(Out::Write(resp.to_string()));
                }
            }
            "result" => {
                let failed = v["is_error"].as_bool().unwrap_or(false) || v["subtype"].as_str().is_some_and(|s| s != "success");
                if let Some(c) = v["total_cost_usd"].as_f64() {
                    st.cost_usd = c;
                }
                st.input_tokens += v["usage"]["input_tokens"].as_u64().unwrap_or(0)
                    + v["usage"]["cache_creation_input_tokens"].as_u64().unwrap_or(0)
                    + v["usage"]["cache_read_input_tokens"].as_u64().unwrap_or(0);
                st.output_tokens += v["usage"]["output_tokens"].as_u64().unwrap_or(0);
                let started_at = st.turn_started_at.take();
                let api_error = self.api_error.take();
                // Background subagents may still wait for an answer (X42).
                st.pending.retain(|p| p.agent.is_some());
                if std::mem::take(&mut self.interrupted) {
                    let id = super::local_id("system");
                    out.push(upsert(st, item(id, "system", "Interrupted")));
                    st.status = "idle".into();
                } else if failed {
                    let msg = v["result"].as_str().or_else(|| v["errors"][0].as_str()).unwrap_or("The turn failed.").to_string();
                    if api_error.as_deref() != Some(msg.as_str()) {
                        out.push(upsert(st, item(super::local_id("error"), "error", msg)));
                    }
                    st.status = "error".into();
                } else {
                    st.status = "done".into();
                }
                // Anything still marked running ended with the turn.
                for it in st.items.iter_mut().filter(|i| i.partial || i.tool.as_ref().is_some_and(|t| t.status == "running")) {
                    it.partial = false;
                    if let Some(t) = it.tool.as_mut()
                        && t.status == "running"
                    {
                        t.status = if failed { "error".into() } else { "ok".into() };
                    }
                    out.push(Out::Item(Box::new(it.clone())));
                }
                if st.status == "done" {
                    out.extend(finish_turn(st, started_at));
                }
                if !st.pending.is_empty() {
                    st.status = "blocked".into();
                }
                out.push(Out::State);
                out.push(self.control("context", json!({"subtype": "get_context_usage", "detail": "summary"})));
            }
            _ => {}
        }
        out
    }

    fn send(&mut self, text: &str, images: &[ChatImage], st: &mut ChatState) -> Vec<Out> {
        let id = super::local_id("user");
        let mut out = vec![upsert(st, item(id, "user", user_text(text, images))), Out::Write(Self::user_line(text, images))];
        if st.status != "working" && st.status != "blocked" {
            st.turn_started_at = Some(now_ms());
        }
        st.status = "working".into();
        out.push(Out::State);
        out
    }

    fn permission(&mut self, ask: &str, decision: &str, message: Option<&str>, answers: Option<&BTreeMap<String, String>>, mode: Option<&str>, st: &mut ChatState) -> Vec<Out> {
        let Some((tool_use, suggestions, mut input)) = self.asks.remove(ask) else { return vec![] };
        let subagent = st.pending.iter().any(|p| p.id == ask && p.agent.is_some());
        st.pending.retain(|p| p.id != ask);
        // AskUserQuestion is answered by allowing it with the answers in its input.
        if let (Some(a), Some(obj)) = (answers, input.as_object_mut()) {
            obj.insert("answers".into(), json!(a));
        }
        let mut out = Vec::new();
        let response = match decision {
            // Approving a plan into another mode (X20); Claude reports the change.
            "allow" if let Some(m) = mode => json!({"behavior": "allow", "updatedInput": input, "updatedPermissions": [{"type": "setMode", "mode": m, "destination": "session"}]}),
            "allow" => json!({"behavior": "allow", "updatedInput": input}),
            "always" => json!({"behavior": "allow", "updatedInput": input, "updatedPermissions": suggestions}),
            _ => {
                if let Some(tid) = &tool_use
                    && let Some(o) = update(st, tid, |it| {
                        if let Some(t) = it.tool.as_mut() {
                            t.status = "denied".into();
                        }
                    })
                {
                    out.push(o);
                }
                if let Some(tid) = &tool_use
                    && let Some(t) = st.subagents.iter_mut().flat_map(|a| a.tools.iter_mut()).find(|t| &t.id == tid)
                {
                    t.status = "denied".into();
                }
                json!({"behavior": "deny", "message": message.unwrap_or("The user denied this action.")})
            }
        };
        out.push(Out::Write(json!({"type": "control_response", "response": {"subtype": "success", "request_id": ask, "response": response}}).to_string()));
        settle_asks(st, subagent);
        out.push(Out::State);
        out
    }

    fn mcp(&mut self, action: &str, server: Option<&str>, st: &mut ChatState) -> Vec<Out> {
        match (action, server) {
            ("refresh", _) => {
                let mut out: Vec<Out> = self.sign_ins.polled().into_iter().map(|name| self.control("mcp-reconnect", json!({"subtype": "mcp_reconnect", "serverName": name}))).collect();
                out.push(self.control("mcp-status", json!({"subtype": "mcp_status"})));
                out
            }
            ("reconnect", Some(name)) => vec![self.control("mcp-reconnect", json!({"subtype": "mcp_reconnect", "serverName": name}))],
            ("auth", Some(name)) => {
                let id = self.next_id("mcp-auth");
                self.auth_ids.insert(id.clone(), name.to_string());
                self.sign_ins.start(name, st);
                let req = json!({"type": "control_request", "request_id": id, "request": {"subtype": "mcp_authenticate", "serverName": name}});
                vec![Out::Write(req.to_string()), Out::State]
            }
            ("cancel", Some(name)) => {
                self.sign_ins.cancel(name, st);
                vec![Out::State]
            }
            _ => vec![],
        }
    }

    fn stop_agent(&mut self, agent: &str, _st: &mut ChatState) -> Vec<Out> {
        vec![self.control("stop", json!({"subtype": "stop_task", "task_id": agent}))]
    }

    fn interrupt(&mut self, st: &mut ChatState) -> Vec<Out> {
        let req = json!({"type": "control_request", "request_id": self.next_id("interrupt"), "request": {"subtype": "interrupt"}});
        let mut out = Vec::new();
        // Pending permission requests are answered so the agent can stop.
        for (rid, _) in self.asks.drain() {
            let resp = json!({"type": "control_response", "response": {"subtype": "success", "request_id": rid, "response": {"behavior": "deny", "message": "Interrupted by the user.", "interrupt": true}}});
            out.push(Out::Write(resp.to_string()));
        }
        st.pending.clear();
        if st.status == "working" || st.status == "blocked" {
            self.interrupted = true;
        }
        out.push(Out::Write(req.to_string()));
        out.push(Out::State);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use moonlet_proto::types::{ContextCategory, ContextUsage, McpServer};

    fn replay(fixture: &str, a: &mut Claude, st: &mut ChatState) -> Vec<Out> {
        fixture.lines().flat_map(|l| a.on_line(l, st)).collect()
    }

    #[test]
    fn command_line() {
        let a = Claude::default();
        let (prog, args) = a.command(&ChatConfig { agent: "claude".into(), model: Some("haiku".into()), effort: Some("high".into()), mode: Some("plan".into()), resume: Some("abc".into()), name: "Fix it".into(), cwd: "/r".into(), ..Default::default() });
        assert_eq!(prog, "claude");
        let joined = args.join(" ");
        assert!(joined.contains("--input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio"));
        assert!(joined.contains("--model haiku --effort high --permission-mode plan --resume abc -n Fix it"));
    }

    #[test]
    fn added_directories_become_add_dir_flags() {
        let a = Claude::default();
        let cfg = ChatConfig { agent: "claude".into(), add_dirs: vec!["/work/shared".into(), "/tmp/notes".into()], cwd: "/r".into(), ..Default::default() };
        let (_, args) = a.command(&cfg);
        assert!(args.join(" ").contains("--add-dir /work/shared --add-dir /tmp/notes"), "{args:?}");
    }

    #[test]
    fn images_go_after_the_text_as_base64_blocks() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        let img = ChatImage { name: "shot.png".into(), media_type: "image/png".into(), data: "iVBORw0KGgo=".into() };
        let outs = a.send("What is wrong here?", std::slice::from_ref(&img), &mut st);
        let line = outs.iter().find_map(|o| if let Out::Write(l) = o { Some(l.clone()) } else { None }).unwrap();
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            v["message"]["content"],
            json!([
                {"type": "text", "text": "What is wrong here?"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}},
            ])
        );
        assert_eq!(st.items.last().unwrap().text, "What is wrong here?\n[image: shot.png]");
    }

    /// Captured from Claude Code 2.1.292 (`mcp_status`, trimmed: one
    /// claude.ai connector of each state, and `--mcp-config` servers).
    const MCP_STATUS_REPLY: &str = r#"{"type":"control_response","response":{"subtype":"success","request_id":"mcp-status-1","response":{"mcpServers":[{"name":"claude.ai Slack","status":"connected","serverInfo":{"name":"Slack MCP","version":"1.0.0"},"config":{"type":"claudeai-proxy","url":"https://mcp.slack.com/mcp","id":"mcpsrv_01RTuDjFH4dWET4nBWFHSt6k"},"scope":"claudeai","source":"claudeai","tools":[{"name":"slack_send_message","annotations":{"openWorld":true}},{"name":"slack_read_channel","annotations":{}}]},{"name":"claude.ai Linear","status":"needs-auth","config":{"type":"claudeai-proxy","url":"https://mcp.linear.app/mcp","id":"mcpsrv_01X9Cj9u4wAJRmUBaoFV4yFt"},"scope":"claudeai","source":"claudeai","tools":[]},{"name":"broken","status":"failed","error":"ENOENT: no such file or directory, posix_spawn 'stdio'","config":{"type":"stdio","command":"/nonexistent/mcp-server","args":["--stdio"]},"scope":"dynamic","source":"dynamic","tools":[]},{"name":"everything","status":"connected","serverInfo":{"name":"mcp-servers/everything","title":"Everything Reference Server","version":"2.0.0"},"config":{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-everything"]},"scope":"dynamic","source":"dynamic","tools":[{"name":"echo"},{"name":"get-env"}]}]}}}"#;

    fn server(name: &str, status: &str, transport: &str, endpoint: &str, scope: &str, error: Option<&str>, tools: &[&str]) -> McpServer {
        McpServer {
            name: name.into(),
            status: status.into(),
            transport: transport.into(),
            endpoint: Some(endpoint.into()),
            scope: Some(scope.into()),
            error: error.map(Into::into),
            tools: tools.iter().map(|t| t.to_string()).collect(),
            auth_url: None,
        }
    }

    #[test]
    fn refreshing_mcp_servers_asks_for_their_status() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        let outs = a.mcp("refresh", None, &mut st);
        let w: Vec<Value> = outs.iter().filter_map(|o| if let Out::Write(l) = o { serde_json::from_str(l).ok() } else { None }).collect();
        assert_eq!(w, [json!({"type": "control_request", "request_id": "mcp-status-1", "request": {"subtype": "mcp_status"}})]);
        assert_eq!(st.mcp_servers, None, "not known until the agent answers");

        assert!(a.on_line(MCP_STATUS_REPLY, &mut st).contains(&Out::State));
        assert_eq!(
            st.mcp_servers.unwrap(),
            [
                server("claude.ai Slack", "connected", "claude.ai", "https://mcp.slack.com/mcp", "claudeai", None, &["slack_send_message", "slack_read_channel"]),
                server("claude.ai Linear", "needs-auth", "claude.ai", "https://mcp.linear.app/mcp", "claudeai", None, &[]),
                server("broken", "failed", "stdio", "/nonexistent/mcp-server --stdio", "dynamic", Some("ENOENT: no such file or directory, posix_spawn 'stdio'"), &[]),
                server("everything", "connected", "stdio", "npx -y @modelcontextprotocol/server-everything", "dynamic", None, &["echo", "get-env"]),
            ]
        );
    }

    #[test]
    fn retrying_a_server_reconnects_it_then_refreshes() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        let outs = a.mcp("reconnect", Some("broken"), &mut st);
        let w: Vec<Value> = outs.iter().filter_map(|o| if let Out::Write(l) = o { serde_json::from_str(l).ok() } else { None }).collect();
        assert_eq!(w, [json!({"type": "control_request", "request_id": "mcp-reconnect-1", "request": {"subtype": "mcp_reconnect", "serverName": "broken"}})]);
        // Captured: a server that still cannot start answers with an error.
        let failed = r#"{"type":"control_response","response":{"subtype":"error","request_id":"mcp-reconnect-1","error":"ENOENT: no such file or directory, posix_spawn 'stdio'"}}"#;
        let outs = a.on_line(failed, &mut st);
        let w: Vec<Value> = outs.iter().filter_map(|o| if let Out::Write(l) = o { serde_json::from_str(l).ok() } else { None }).collect();
        assert_eq!(w, [json!({"type": "control_request", "request_id": "mcp-status-2", "request": {"subtype": "mcp_status"}})]);
    }

    fn writes(outs: &[Out]) -> Vec<Value> {
        outs.iter().filter_map(|o| if let Out::Write(l) = o { serde_json::from_str(l).ok() } else { None }).collect()
    }

    fn status_of<'a>(st: &'a ChatState, name: &str) -> &'a McpServer {
        st.mcp_servers.as_ref().unwrap().iter().find(|s| s.name == name).unwrap()
    }

    /// Captured from Claude Code 2.1.292, organization id replaced: a
    /// claude.ai connector signs in on claude.ai, with no local callback.
    const CLAUDE_AI_AUTH: &str = "https://claude.ai/api/organizations/00000000-0000-4000-8000-000000000000/mcp/start-auth/mcpsrv_01X9Cj9u4wAJRmUBaoFV4yFt?product_surface=sdk-cli";

    #[test]
    fn signing_in_asks_for_the_page_and_shows_the_server_signing_in() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.mcp("refresh", None, &mut st);
        a.on_line(MCP_STATUS_REPLY, &mut st);

        let w = writes(&a.mcp("auth", Some("claude.ai Linear"), &mut st));
        assert_eq!(w, [json!({"type": "control_request", "request_id": "mcp-auth-2", "request": {"subtype": "mcp_authenticate", "serverName": "claude.ai Linear"}})]);
        assert_eq!(status_of(&st, "claude.ai Linear").status, "authing");
        assert_eq!(status_of(&st, "claude.ai Linear").auth_url, None);

        let reply = json!({"type": "control_response", "response": {"subtype": "success", "request_id": "mcp-auth-2", "response": {"authUrl": CLAUDE_AI_AUTH, "requiresUserAction": true, "callbackExpected": false}}});
        assert!(a.on_line(&reply.to_string(), &mut st).contains(&Out::State));
        assert_eq!(status_of(&st, "claude.ai Linear").auth_url.as_deref(), Some(CLAUDE_AI_AUTH));

        // Claude does not notice a claude.ai sign-in: each refresh reconnects.
        let w = writes(&a.mcp("refresh", None, &mut st));
        assert_eq!(w[0]["request"], json!({"subtype": "mcp_reconnect", "serverName": "claude.ai Linear"}));
        assert_eq!(w[1]["request"], json!({"subtype": "mcp_status"}));
        // Still waiting: the status says needs-auth, the card says signing in.
        let id = w[1]["request_id"].as_str().unwrap();
        a.on_line(&MCP_STATUS_REPLY.replace("mcp-status-1", id), &mut st);
        assert_eq!(status_of(&st, "claude.ai Linear").status, "authing");
        assert_eq!(status_of(&st, "claude.ai Linear").auth_url.as_deref(), Some(CLAUDE_AI_AUTH));

        // Signed in: the next status has it connected.
        let w = writes(&a.mcp("refresh", None, &mut st));
        let id = w[1]["request_id"].as_str().unwrap();
        let connected = MCP_STATUS_REPLY.replace("mcp-status-1", id).replace(r#""name":"claude.ai Linear","status":"needs-auth""#, r#""name":"claude.ai Linear","status":"connected""#);
        a.on_line(&connected, &mut st);
        assert_eq!(status_of(&st, "claude.ai Linear").status, "connected");
        assert_eq!(status_of(&st, "claude.ai Linear").auth_url, None);
        assert_eq!(writes(&a.mcp("refresh", None, &mut st)).len(), 1, "no more reconnects");
    }

    #[test]
    fn a_refused_sign_in_shows_the_agents_error() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.mcp("refresh", None, &mut st);
        a.on_line(MCP_STATUS_REPLY, &mut st);
        a.mcp("auth", Some("broken"), &mut st);
        // Captured: the error Claude gives for a server it cannot sign in to.
        let refused = r#"{"type":"control_response","response":{"subtype":"error","request_id":"mcp-auth-2","error":"Server type \"stdio\" does not support OAuth authentication"}}"#;
        a.on_line(refused, &mut st);
        assert_eq!(status_of(&st, "broken").status, "failed");
        assert_eq!(status_of(&st, "broken").error.as_deref(), Some(r#"Server type "stdio" does not support OAuth authentication"#));
    }

    #[test]
    fn cancelling_a_sign_in_shows_it_needed_again() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.mcp("refresh", None, &mut st);
        a.on_line(MCP_STATUS_REPLY, &mut st);
        a.mcp("auth", Some("claude.ai Linear"), &mut st);
        a.mcp("cancel", Some("claude.ai Linear"), &mut st);
        assert_eq!(status_of(&st, "claude.ai Linear").status, "needs-auth");
        let w = writes(&a.mcp("refresh", None, &mut st));
        assert_eq!(w.len(), 1, "a cancelled sign-in is not reconnected");
    }

    /// Captured from Claude Code 2.1.292 (trimmed): `-p` mode sends no
    /// `system/init` before the first message, so commands and subagents
    /// come from the reply to `initialize` (X29).
    const INIT_REPLY: &str = r#"{"type":"control_response","response":{"subtype":"success","request_id":"init-1","response":{"commands":[{"name":"ask-matt","description":"Ask which skill or flow fits your situation. (user)","argumentHint":""},{"name":"claude-handoff","description":"Hand the current conversation off to a fresh background agent.","argumentHint":"What will the next session be used for?"}],"agents":[{"name":"Plan","description":"Software architect agent for designing implementation plans.","model":"inherit"},{"name":"statusline-setup","description":"Use this agent to configure the user's Claude Code status line setting.","model":"sonnet"}],"output_style":"default","models":[{"value":"haiku","displayName":"Haiku"}],"pid":4242}}}"#;

    #[test]
    fn the_initialize_reply_gives_commands_and_subagents() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig::default(), &mut st);
        let outs = a.on_line(INIT_REPLY, &mut st);
        assert!(outs.contains(&Out::State));
        assert_eq!(st.slash_commands, ["ask-matt", "claude-handoff"]);
        assert_eq!(
            st.agents,
            [
                NamedItem { name: "Plan".into(), description: "Software architect agent for designing implementation plans.".into() },
                NamedItem { name: "statusline-setup".into(), description: "Use this agent to configure the user's Claude Code status line setting.".into() },
            ]
        );
    }

    #[test]
    fn replays_a_recorded_turn_with_a_tool_call() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig::default(), &mut st);
        a.send("Run ls", &[], &mut st);
        assert_eq!(st.status, "working");
        let outs = replay(include_str!("fixtures/claude-stream.jsonl"), &mut a, &mut st);
        assert!(outs.iter().any(|o| matches!(o, Out::Item(i) if i.partial)), "streaming produced partial updates");
        assert!(st.agent_session.is_some());
        assert_eq!(st.slash_commands, ["review", "compact"]);
        assert_eq!(st.status, "done");
        assert!(st.cost_usd > 0.0);
        let tools: Vec<_> = st.items.iter().filter_map(|i| i.tool.as_ref()).collect();
        assert!(tools.iter().any(|t| t.name == "Bash" && t.summary.starts_with("ls") && t.status == "ok" && t.output.as_deref().is_some_and(|o| o.contains("a.txt"))), "{tools:?}");
        let last = st.items.iter().rev().find(|i| i.kind == "assistant").unwrap();
        assert!(last.text.to_lowercase().contains("done"), "{}", last.text);
        assert!(st.items.iter().all(|i| !i.partial), "nothing left streaming");
    }

    #[test]
    fn a_completed_turn_stamps_its_final_message() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig::default(), &mut st);
        a.send("Run ls", &[], &mut st);
        st.turn_started_at = Some(1_000);
        replay(include_str!("fixtures/claude-stream.jsonl"), &mut a, &mut st);
        let stamped: Vec<_> = st.items.iter().filter(|i| i.turn.is_some()).collect();
        assert_eq!(stamped.len(), 1, "{stamped:?}");
        assert_eq!(stamped[0].id, st.items.iter().rev().find(|i| i.kind == "assistant").unwrap().id);
        let t = stamped[0].turn.unwrap();
        assert_eq!(t.started_at, 1_000);
        assert!(t.ended_at >= now_ms() - 60_000, "{t:?}");
    }

    #[test]
    fn a_turn_without_an_answer_leaves_the_previous_answer_alone() {
        let done = r#"{"type":"result","subtype":"success","is_error":false}"#;
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.send("first", &[], &mut st);
        st.turn_started_at = Some(1_000);
        a.on_line(r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"First answer"}]}}"#, &mut st);
        a.on_line(done, &mut st);
        let first = st.items.iter().find(|i| i.kind == "assistant").unwrap().turn;
        assert_eq!(first.map(|t| t.started_at), Some(1_000));
        // The next turn starts in the same millisecond and ends without text.
        a.send("second", &[], &mut st);
        st.turn_started_at = Some(st.items.iter().find(|i| i.kind == "assistant").unwrap().ts);
        a.on_line(done, &mut st);
        assert_eq!(st.status, "done");
        assert_eq!(st.items.iter().find(|i| i.kind == "assistant").unwrap().turn, first);
    }

    #[test]
    fn interrupted_and_failed_turns_stamp_nothing() {
        let answer = r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Partly done"}]}}"#;
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.send("go", &[], &mut st);
        a.on_line(answer, &mut st);
        a.on_line(r#"{"type":"result","subtype":"error_during_execution","is_error":true}"#, &mut st);
        assert_eq!(st.status, "error");
        assert!(st.items.iter().all(|i| i.turn.is_none()));

        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.send("go", &[], &mut st);
        a.on_line(answer, &mut st);
        a.interrupt(&mut st);
        a.on_line(r#"{"type":"result","subtype":"success","is_error":false}"#, &mut st);
        assert_eq!(st.status, "idle");
        assert!(st.items.iter().all(|i| i.turn.is_none()));
    }

    // Captured from Claude Code 2.1.296 with a signed-out CLAUDE_CONFIG_DIR.
    const NOT_SIGNED_IN: &str = r#"{"type":"assistant","message":{"id":"cbeac51b-6451-489c-a86a-c94885f14004","model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","type":"message","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"parent_tool_use_id":null,"session_id":"505d7650-5cda-4c14-8e58-2223baa10699","error":"authentication_failed","is_api_error_message":true}"#;
    const NOT_SIGNED_IN_RESULT: &str = r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","stop_reason":"stop_sequence","terminal_reason":"api_error","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}"#;

    /// Every item but the user's, as (kind, text, cause).
    fn shown(st: &ChatState) -> Vec<(String, String, Option<String>)> {
        st.items.iter().filter(|i| i.kind != "user").map(|i| (i.kind.clone(), i.text.clone(), i.cause.clone())).collect()
    }

    #[test]
    fn a_failed_sign_in_shows_one_error_that_names_its_cause() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.send("hi", &[], &mut st);
        a.on_line(NOT_SIGNED_IN, &mut st);
        a.on_line(NOT_SIGNED_IN_RESULT, &mut st);
        assert_eq!(shown(&st), [("error".into(), "Not logged in · Please run /login".into(), Some("authentication_failed".into()))]);
        assert_eq!(st.status, "error");

        // A later failure for another reason names no cause.
        a.send("again", &[], &mut st);
        a.on_line(r#"{"type":"result","subtype":"error_during_execution","is_error":true}"#, &mut st);
        assert_eq!(st.items.last().map(|i| (i.text.clone(), i.cause.clone())), Some(("The turn failed.".into(), None)));
    }

    #[test]
    fn an_agent_error_stays_when_the_turn_does_not_repeat_it() {
        // Stopped before the failed result came.
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.send("hi", &[], &mut st);
        a.on_line(NOT_SIGNED_IN, &mut st);
        a.interrupt(&mut st);
        a.on_line(r#"{"type":"result","subtype":"success","is_error":false}"#, &mut st);
        assert_eq!(
            shown(&st),
            [
                ("error".into(), "Not logged in · Please run /login".into(), Some("authentication_failed".into())),
                ("system".into(), "Interrupted".into(), None),
            ]
        );

        // The turn went on and ended well.
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.send("hi", &[], &mut st);
        a.on_line(NOT_SIGNED_IN, &mut st);
        a.on_line(r#"{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"Done."}]}}"#, &mut st);
        a.on_line(r#"{"type":"result","subtype":"success","is_error":false}"#, &mut st);
        assert_eq!(
            shown(&st).into_iter().map(|(k, t, _)| (k, t)).collect::<Vec<_>>(),
            [("error".to_string(), "Not logged in · Please run /login".to_string()), ("assistant".into(), "Done.".into())]
        );
        assert_eq!(st.status, "done");
    }

    #[test]
    fn permission_requests_round_trip() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        let mut writes = Vec::new();
        for line in include_str!("fixtures/claude-perm.jsonl").lines() {
            for o in a.on_line(line, &mut st) {
                if let Out::Write(w) = o {
                    writes.push(w);
                }
            }
            // Answer asks the way the recording did: allow Write, deny Bash.
            while let Some(ask) = st.pending.first().cloned() {
                assert_eq!(st.status, "blocked");
                let decision = if ask.tool == "Write" { "allow" } else { "deny" };
                for o in a.permission(&ask.id, decision, None, None, None, &mut st) {
                    if let Out::Write(w) = o {
                        writes.push(w);
                    }
                }
            }
        }
        let responses: Vec<Value> = writes.iter().map(|w| serde_json::from_str(w).unwrap()).filter(|v: &Value| v["type"] == "control_response").collect();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["response"]["response"]["behavior"], "allow");
        assert!(responses[0]["response"]["response"]["updatedInput"]["file_path"].as_str().unwrap().ends_with("hello.txt"));
        assert_eq!(responses[1]["response"]["response"]["behavior"], "deny");
        let bash = st.items.iter().filter_map(|i| i.tool.as_ref()).find(|t| t.name == "Bash").unwrap();
        assert_eq!(bash.status, "denied");
        let write = st.items.iter().filter_map(|i| i.tool.as_ref()).find(|t| t.name == "Write").unwrap();
        assert_eq!(write.status, "ok");
        assert!(write.diff.as_deref().unwrap().contains("+hi"));
        assert!(writes.iter().any(|w| w.contains("\"allow\"")));
        assert_eq!(st.status, "done");
    }

    #[test]
    fn always_allow_passes_suggestions_back() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        let req = json!({"type": "control_request", "request_id": "r1", "request": {"subtype": "can_use_tool", "tool_name": "Bash", "tool_use_id": "t1", "input": {"command": "npm test"}, "permission_suggestions": [{"type": "addRules"}]}});
        a.on_line(&req.to_string(), &mut st);
        assert!(st.pending[0].can_always);
        assert_eq!(st.pending[0].summary, "npm test");
        let outs = a.permission("r1", "always", None, None, None, &mut st);
        let Out::Write(w) = &outs[0] else { panic!() };
        let v: Value = serde_json::from_str(w).unwrap();
        assert_eq!(v["response"]["response"]["updatedPermissions"][0]["type"], "addRules");
        assert!(st.pending.is_empty());
    }

    #[test]
    fn questions_are_answered_through_updated_input() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        let questions = json!([{"question": "Which colours?", "header": "Colours", "multiSelect": false, "options": [{"label": "GitHub", "description": "Green and purple"}, {"label": "Mono", "description": "Greys"}]}]);
        let req = json!({"type": "control_request", "request_id": "q1", "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "tool_use_id": "t1", "input": {"questions": questions}}});
        a.on_line(&req.to_string(), &mut st);
        assert_eq!(st.status, "blocked");
        assert_eq!(st.pending[0].summary, "Which colours?");
        let answers = BTreeMap::from([("Which colours?".to_string(), "GitHub".to_string())]);
        let outs = a.permission("q1", "allow", None, Some(&answers), None, &mut st);
        let Out::Write(w) = &outs[0] else { panic!() };
        let v: Value = serde_json::from_str(w).unwrap();
        let r = &v["response"]["response"];
        assert_eq!(r["behavior"], "allow");
        assert_eq!(r["updatedInput"]["questions"], questions);
        assert_eq!(r["updatedInput"]["answers"]["Which colours?"], "GitHub");
        assert!(st.pending.is_empty());
        assert_eq!(st.status, "working");
    }

    /// An `ExitPlanMode` ask as claude 2.1.291 sent it in Plan mode.
    const PLAN_ASK: &str = r#"{"type":"control_request","request_id":"da66e8fc-fa2a-440b-aaeb-4098da758f71","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","display_name":"ExitPlanMode","input":{"plan":"1. Overwrite `a.txt` (untracked, repo root) content with `goodbye`.\n2. Verify by reading file back. Confidence 90%: trivial edit, current content unread by choice.\n","planFilePath":"/Users/me/.claude/plans/plan-changing-a-txt-to-groovy-whale.md"},"tool_use_id":"toolu_013XgKuAKWBb9pZDCyHcs1rP","requires_user_interaction":true}}"#;

    fn response(outs: &[Out]) -> Value {
        let w = outs.iter().find_map(|o| if let Out::Write(w) = o { Some(w) } else { None }).expect("a reply to Claude");
        serde_json::from_str::<Value>(w).unwrap()["response"]["response"].clone()
    }

    #[test]
    fn approving_a_plan_can_switch_to_accept_edits() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.on_line(PLAN_ASK, &mut st);
        assert!(!st.pending[0].can_always);
        let r = response(&a.permission("da66e8fc-fa2a-440b-aaeb-4098da758f71", "allow", None, None, Some("acceptEdits"), &mut st));
        assert_eq!(r["behavior"], "allow");
        assert_eq!(r["updatedPermissions"], json!([{"type": "setMode", "mode": "acceptEdits", "destination": "session"}]));
        assert!(r["updatedInput"]["plan"].as_str().unwrap().starts_with("1. Overwrite `a.txt`"));

        // Without a mode the approval is plain; Claude picks `default` itself.
        a.on_line(PLAN_ASK, &mut st);
        let r = response(&a.permission("da66e8fc-fa2a-440b-aaeb-4098da758f71", "allow", None, None, None, &mut st));
        assert_eq!(r["behavior"], "allow");
        assert!(r.get("updatedPermissions").is_none(), "{r}");

        // Keep planning: the feedback goes back as the deny message.
        a.on_line(PLAN_ASK, &mut st);
        let r = response(&a.permission("da66e8fc-fa2a-440b-aaeb-4098da758f71", "deny", Some("Use a feature flag instead"), None, None, &mut st));
        assert_eq!(r, json!({"behavior": "deny", "message": "Use a feature flag instead"}));
    }

    #[test]
    fn a_plan_is_summarised_by_its_heading_or_first_line() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.on_line(PLAN_ASK, &mut st);
        assert_eq!(st.pending[0].summary, "1. Overwrite `a.txt` (untracked, repo root) content with `goodbye`.");
        let headed = json!({"type": "control_request", "request_id": "p2", "request": {"subtype": "can_use_tool", "tool_name": "ExitPlanMode", "tool_use_id": "t2", "input": {"plan": "# Jobs on other hosts: analysis and options\n\n## Context\n\nmoonlet keeps agent sessions alive on an always-on host."}}});
        a.on_line(&headed.to_string(), &mut st);
        assert_eq!(st.pending[1].summary, "Jobs on other hosts: analysis and options");
    }

    #[test]
    fn claude_reports_set_the_mode() {
        let status = |mode: &str| json!({"type": "system", "subtype": "status", "status": null, "permissionMode": mode}).to_string();
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig { mode: Some("plan".into()), ..Default::default() }, &mut st);
        // Approving a plan with the setMode update (captured, claude 2.1.291).
        assert_eq!(a.on_line(&status("acceptEdits"), &mut st), [Out::State]);
        assert_eq!(st.mode.as_deref(), Some("acceptEdits"));
        // A plain approval: Claude says `default`, the picker calls it Manual.
        a.on_line(&status("default"), &mut st);
        assert_eq!(st.mode.as_deref(), Some("manual"));
        // A mode the picker does not offer changes nothing.
        assert!(a.on_line(&status("dontAsk"), &mut st).is_empty());
        assert_eq!(st.mode.as_deref(), Some("manual"));
    }

    /// Captured from Claude Code 2.1.292 (`get_context_usage`, summary
    /// detail; trimmed to the fields moonlet reads).
    const CONTEXT_REPLY: &str = r#"{"type":"control_response","response":{"subtype":"success","request_id":"context-1","response":{"categories":[{"name":"System prompt","tokens":2387,"color":"promptBorder","kind":"used"},{"name":"System tools","tokens":1096,"color":"inactive","kind":"used"},{"name":"System tools (deferred)","tokens":13287,"color":"inactive","isDeferred":true,"kind":"deferred"},{"name":"Custom agents","tokens":374,"color":"permission","kind":"used"},{"name":"Memory files","tokens":649,"color":"claude","kind":"used"},{"name":"Skills","tokens":8790,"color":"warning","kind":"used"},{"name":"Messages","tokens":1869,"color":"purple_FOR_SUBAGENTS_ONLY","kind":"used"},{"name":"Autocompact buffer","tokens":33000,"color":"inactive","kind":"buffer"},{"name":"Free space","tokens":951835,"color":"promptBorder","kind":"free"}],"totalTokens":15165,"maxTokens":1000000,"rawMaxTokens":1000000,"percentage":2,"model":"claude-opus-5-5","autoCompactThreshold":967000,"isAutoCompactEnabled":true}}}"#;

    fn category(name: &str, tokens: u64) -> ContextCategory {
        ContextCategory { name: name.into(), tokens }
    }

    #[test]
    fn context_usage_is_asked_after_initialize_and_after_each_turn() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig::default(), &mut st);
        let asked = Some(json!({"subtype": "get_context_usage", "detail": "summary"}));
        let outs = a.on_line(r#"{"type":"control_response","response":{"subtype":"success","request_id":"init-1","response":{"commands":[]}}}"#, &mut st);
        assert_eq!(writes(&outs).last().map(|w| w["request"].clone()), asked);
        let outs = a.on_line(r#"{"type":"result","subtype":"success","is_error":false,"usage":{}}"#, &mut st);
        assert_eq!(writes(&outs).last().map(|w| w["request"].clone()), asked);
        // A failed turn and a stopped one still used context.
        let outs = a.on_line(r#"{"type":"result","subtype":"error_during_execution","is_error":true,"usage":{}}"#, &mut st);
        assert_eq!(writes(&outs).last().map(|w| w["request"].clone()), asked);
        st.status = "working".into();
        a.interrupt(&mut st);
        let outs = a.on_line(r#"{"type":"result","subtype":"error_during_execution","is_error":true,"usage":{}}"#, &mut st);
        assert_eq!(writes(&outs).last().map(|w| w["request"].clone()), asked);
    }

    #[test]
    fn context_usage_reply_fills_the_state() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        let id = writes(&a.on_line(r#"{"type":"result","subtype":"success","is_error":false,"usage":{}}"#, &mut st)).last().unwrap()["request_id"].as_str().unwrap().to_string();
        assert_eq!(a.on_line(&CONTEXT_REPLY.replace("context-1", &id), &mut st), [Out::State]);
        assert_eq!(
            st.context,
            Some(ContextUsage {
                used: 15165,
                max: 1_000_000,
                auto_compact_at: Some(967_000),
                categories: vec![
                    category("System prompt", 2387),
                    category("System tools", 1096),
                    category("Custom agents", 374),
                    category("Memory files", 649),
                    category("Skills", 8790),
                    category("Messages", 1869),
                ],
            })
        );
    }

    #[test]
    fn context_usage_drops_empty_categories_and_an_off_threshold() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        let reply = CONTEXT_REPLY.replace(r#""tokens":374"#, r#""tokens":0"#).replace(r#""isAutoCompactEnabled":true"#, r#""isAutoCompactEnabled":false"#);
        a.on_line(&reply, &mut st);
        let ctx = st.context.unwrap();
        assert_eq!(ctx.auto_compact_at, None);
        assert!(!ctx.categories.iter().any(|c| c.name == "Custom agents"), "{:?}", ctx.categories);
    }

    #[test]
    fn a_failed_context_reply_keeps_the_last_reading() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.on_line(CONTEXT_REPLY, &mut st);
        let before = st.context.clone();
        let outs = a.on_line(r#"{"type":"control_response","response":{"subtype":"error","request_id":"context-2","error":"get_context_usage is not supported in this context"}}"#, &mut st);
        assert!(outs.is_empty());
        assert_eq!(st.context, before);
    }

    #[test]
    fn unknown_control_requests_get_an_error_reply() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        let outs = a.on_line(r#"{"type":"control_request","request_id":"x","request":{"subtype":"elicitation"}}"#, &mut st);
        assert!(matches!(&outs[0], Out::Write(w) if w.contains("\"error\"")));
    }

    /// Captured from claude 2.1.296 (haiku, hooks off): two background
    /// subagents, one asks to write a file and is allowed (X42).
    const SUBAGENTS: &str = include_str!("fixtures/claude-subagents.jsonl");
    /// The same with `stop_task` sent for "Touch a file" while it asked.
    const SUBAGENT_STOP: &str = include_str!("fixtures/claude-subagent-stop.jsonl");

    fn started() -> (Claude, ChatState) {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig::default(), &mut st);
        a.send("Launch two agents", &[], &mut st);
        (a, st)
    }

    #[test]
    fn subagents_follow_task_events() {
        let (mut a, mut st) = started();
        replay(SUBAGENTS, &mut a, &mut st);
        let s = &st.subagents;
        assert_eq!(s.len(), 2, "{s:?}");
        assert_eq!(s[0].id, "a98344134013d8227");
        assert_eq!(s[0].tool_use_id, "toolu_01QNjAbPMDQiZwKyCqkmv2VD");
        assert_eq!(s[0].description, "Write hello file");
        assert_eq!(s[0].kind.as_deref(), Some("general-purpose"));
        assert_eq!(s[0].prompt, "Use the Write tool to create hello.txt in the current directory containing the single word hi. Then reply done.");
        assert_eq!(s[0].status, "done");
        assert_eq!(s[0].activity.as_deref(), Some("Writing hello.txt"));
        assert_eq!((s[0].tokens, s[0].tool_uses, s[0].duration_ms), (10682, 1, Some(3175)));
        assert_eq!(s[0].ended_at, Some(1791970434654));
        assert_eq!(s[0].report.as_deref(), Some("done"));
        assert_eq!(s[1].description, "List files");
        assert_eq!(s[1].status, "done");
        assert_eq!(s[1].activity.as_deref(), Some("Running List top-level entries in the working directory"));
        assert_eq!((s[1].tokens, s[1].tool_uses, s[1].duration_ms), (10779, 2, Some(11510)));
        assert!(s[1].report.as_deref().is_some_and(|r| r.starts_with("The directory `/repo` contains two files")), "{:?}", s[1].report);
        assert!(s.iter().all(|a| a.started_at > 0 && a.error.is_none()));
    }

    #[test]
    fn subagent_tool_calls_stay_with_their_agent() {
        let (mut a, mut st) = started();
        replay(SUBAGENTS, &mut a, &mut st);
        let tool = |id: &str, name: &str, summary: &str, status: &str, diff: Option<(u32, u32)>| SubagentTool {
            id: id.into(),
            name: name.into(),
            summary: summary.into(),
            status: status.into(),
            added: diff.map(|d| d.0),
            removed: diff.map(|d| d.1),
        };
        assert_eq!(st.subagents[0].tools, [tool("toolu_01HCnwCanjJxRH3wTnuE1cGa", "Write", "/repo/hello.txt", "ok", Some((1, 0)))]);
        assert_eq!(
            st.subagents[1].tools,
            [
                tool("toolu_01CTxqdEX7sP1JybbuNQQd46", "Glob", "*", "error", None),
                tool("toolu_01S8c7hhXcyBvACkbd3u1Fuq", "Bash", "find /repo -mindepth 1 -maxdepth 1 -print0 | xargs -0 -n1 basename", "ok", None),
            ]
        );
        assert_eq!(st.subagents[0].model.as_deref(), Some("claude-haiku-5-5"));
        // The main transcript keeps only the two launches.
        let tools: Vec<&str> = st.items.iter().filter(|i| i.kind == "tool").map(|i| i.id.as_str()).collect();
        assert_eq!(tools, ["toolu_01QNjAbPMDQiZwKyCqkmv2VD", "toolu_01BxCjWGafqjuD8gywbDsWV7"]);
        assert!(st.items.iter().all(|i| !i.text.contains("Glob tool is not available")), "a subagent's text leaked into the transcript");
    }

    /// The fixture's lines up to and including the first one containing `needle`.
    fn until<'a>(fixture: &'a str, needle: &str) -> String {
        let end = fixture.find(needle).expect(needle);
        let end = end + fixture[end..].find('\n').unwrap_or(fixture.len() - end);
        fixture[..end].to_string()
    }

    #[test]
    fn a_subagent_ask_names_its_agent() {
        let (mut a, mut st) = started();
        replay(&until(SUBAGENTS, r#""subtype": "can_use_tool""#), &mut a, &mut st);
        assert_eq!(st.status, "blocked");
        let ask = st.pending.last().unwrap();
        assert_eq!((ask.id.as_str(), ask.tool.as_str()), ("eee7fb1b-453f-4303-8690-b9312d5f1b24", "Write"));
        assert_eq!(ask.agent.as_deref(), Some("a98344134013d8227"));
    }

    #[test]
    fn a_subagent_ask_outlives_the_main_turn() {
        let (mut a, mut st) = started();
        replay(&until(SUBAGENTS, r#""subtype": "can_use_tool""#), &mut a, &mut st);
        // The main turn ends while the subagent still waits for its answer.
        let result = SUBAGENTS.lines().find(|l| l.contains(r#""type": "result""#)).unwrap();
        a.on_line(result, &mut st);
        assert_eq!(st.pending.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["eee7fb1b-453f-4303-8690-b9312d5f1b24"]);
        assert_eq!(st.status, "blocked");
        let outs = a.permission("eee7fb1b-453f-4303-8690-b9312d5f1b24", "allow", None, None, None, &mut st);
        assert!(outs.iter().any(|o| matches!(o, Out::Write(w) if w.contains(r#""request_id":"eee7fb1b-453f-4303-8690-b9312d5f1b24""#) && w.contains(r#""behavior":"allow""#))), "{outs:?}");
        assert!(st.pending.is_empty());
        // The main agent is not working again: its turn had ended.
        assert_eq!(st.status, "done");
    }

    #[test]
    fn stopping_a_subagent_sends_stop_task() {
        let (mut a, mut st) = started();
        let asked = until(SUBAGENT_STOP, "b45af96a-71d5-42ad-8ebf-a8238ed2a070");
        replay(&asked, &mut a, &mut st);
        assert_eq!(st.pending.iter().map(|p| p.agent.as_deref()).collect::<Vec<_>>(), [Some("a9e80d60e7a0f792f")]);
        let outs = a.stop_agent("a9e80d60e7a0f792f", &mut st);
        let line = outs.iter().find_map(|o| if let Out::Write(l) = o { Some(l.clone()) } else { None }).unwrap();
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!((v["type"].as_str(), &v["request"]), (Some("control_request"), &json!({"subtype": "stop_task", "task_id": "a9e80d60e7a0f792f"})));
        // Claude cancels the agent's ask, then reports it stopped.
        replay(&SUBAGENT_STOP[asked.len()..], &mut a, &mut st);
        assert!(st.pending.iter().all(|p| p.id != "b45af96a-71d5-42ad-8ebf-a8238ed2a070"), "{:?}", st.pending);
        let s = &st.subagents;
        assert_eq!((s[0].description.as_str(), s[0].status.as_str(), s[0].ended_at), ("Touch a file", "stopped", Some(1791970412270)));
        assert_eq!(s[0].report, None);
        assert_eq!((s[1].description.as_str(), s[1].status.as_str()), ("List files", "done"));
    }

    #[test]
    fn denying_a_subagent_ask_marks_its_tool_call() {
        let (mut a, mut st) = started();
        replay(&until(SUBAGENTS, r#""subtype": "can_use_tool""#), &mut a, &mut st);
        a.permission("eee7fb1b-453f-4303-8690-b9312d5f1b24", "deny", None, None, None, &mut st);
        let t = &st.subagents[0].tools[0];
        assert_eq!((t.name.as_str(), t.status.as_str()), ("Write", "denied"));
    }
}
