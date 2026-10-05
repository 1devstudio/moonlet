//! Claude Code over `--input-format/--output-format stream-json` with
//! `--permission-prompt-tool stdio` (the Agent SDK host protocol).

use std::collections::{BTreeMap, HashMap};

use jaunt_proto::types::{ChatState, PermissionAsk};
use serde_json::{Value, json};

use super::{Adapter, ChatConfig, Out, clip, finish_turn, item, summarize, tool_item, update, upsert};
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
}

impl Claude {
    fn next_id(&mut self, prefix: &str) -> String {
        self.seq += 1;
        format!("{prefix}-{}", self.seq)
    }

    fn user_line(text: &str) -> String {
        json!({
            "type": "user",
            "message": {"role": "user", "content": [{"type": "text", "text": text}]},
            "parent_tool_use_id": null,
        })
        .to_string()
    }
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
        // Sub-agent (Task) traffic stays inside its tool row.
        if v.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
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
                    });
                    self.asks.insert(rid, (req["tool_use_id"].as_str().map(String::from), suggestions, input));
                    st.status = "blocked".into();
                    out.push(Out::State);
                } else {
                    // Requests we do not implement must not leave the agent waiting.
                    let resp = json!({"type": "control_response", "response": {"subtype": "error", "request_id": rid, "error": "not supported by jaunt"}});
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
                st.pending.clear();
                if std::mem::take(&mut self.interrupted) {
                    let id = super::local_id("system");
                    out.push(upsert(st, item(id, "system", "Interrupted")));
                    st.status = "idle".into();
                } else if failed {
                    let msg = v["result"].as_str().or_else(|| v["errors"][0].as_str()).unwrap_or("The turn failed.").to_string();
                    let id = super::local_id("error");
                    out.push(upsert(st, item(id, "error", msg)));
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
                out.push(Out::State);
            }
            _ => {}
        }
        out
    }

    fn send(&mut self, text: &str, st: &mut ChatState) -> Vec<Out> {
        let id = super::local_id("user");
        let mut out = vec![upsert(st, item(id, "user", text)), Out::Write(Self::user_line(text))];
        if st.status != "working" && st.status != "blocked" {
            st.turn_started_at = Some(now_ms());
        }
        st.status = "working".into();
        out.push(Out::State);
        out
    }

    fn permission(&mut self, ask: &str, decision: &str, message: Option<&str>, answers: Option<&BTreeMap<String, String>>, st: &mut ChatState) -> Vec<Out> {
        let Some((tool_use, suggestions, mut input)) = self.asks.remove(ask) else { return vec![] };
        st.pending.retain(|p| p.id != ask);
        // AskUserQuestion is answered by allowing it with the answers in its input.
        if let (Some(a), Some(obj)) = (answers, input.as_object_mut()) {
            obj.insert("answers".into(), json!(a));
        }
        let mut out = Vec::new();
        let response = match decision {
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
                json!({"behavior": "deny", "message": message.unwrap_or("The user denied this action.")})
            }
        };
        out.push(Out::Write(json!({"type": "control_response", "response": {"subtype": "success", "request_id": ask, "response": response}}).to_string()));
        st.status = if st.pending.is_empty() { "working".into() } else { "blocked".into() };
        out.push(Out::State);
        out
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

    fn replay(fixture: &str, a: &mut Claude, st: &mut ChatState) -> Vec<Out> {
        fixture.lines().flat_map(|l| a.on_line(l, st)).collect()
    }

    #[test]
    fn command_line() {
        let a = Claude::default();
        let (prog, args) = a.command(&ChatConfig { agent: "claude".into(), model: Some("haiku".into()), effort: Some("high".into()), mode: Some("plan".into()), resume: Some("abc".into()), name: "Fix it".into(), cwd: "/r".into() });
        assert_eq!(prog, "claude");
        let joined = args.join(" ");
        assert!(joined.contains("--input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio"));
        assert!(joined.contains("--model haiku --effort high --permission-mode plan --resume abc -n Fix it"));
    }

    #[test]
    fn replays_a_recorded_turn_with_a_tool_call() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig::default(), &mut st);
        a.send("Run ls", &mut st);
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
        a.send("Run ls", &mut st);
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
        a.send("first", &mut st);
        st.turn_started_at = Some(1_000);
        a.on_line(r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"First answer"}]}}"#, &mut st);
        a.on_line(done, &mut st);
        let first = st.items.iter().find(|i| i.kind == "assistant").unwrap().turn;
        assert_eq!(first.map(|t| t.started_at), Some(1_000));
        // The next turn starts in the same millisecond and ends without text.
        a.send("second", &mut st);
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
        a.send("go", &mut st);
        a.on_line(answer, &mut st);
        a.on_line(r#"{"type":"result","subtype":"error_during_execution","is_error":true}"#, &mut st);
        assert_eq!(st.status, "error");
        assert!(st.items.iter().all(|i| i.turn.is_none()));

        let mut a = Claude::default();
        let mut st = ChatState::default();
        a.send("go", &mut st);
        a.on_line(answer, &mut st);
        a.interrupt(&mut st);
        a.on_line(r#"{"type":"result","subtype":"success","is_error":false}"#, &mut st);
        assert_eq!(st.status, "idle");
        assert!(st.items.iter().all(|i| i.turn.is_none()));
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
                for o in a.permission(&ask.id, decision, None, None, &mut st) {
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
        let outs = a.permission("r1", "always", None, None, &mut st);
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
        let outs = a.permission("q1", "allow", None, Some(&answers), &mut st);
        let Out::Write(w) = &outs[0] else { panic!() };
        let v: Value = serde_json::from_str(w).unwrap();
        let r = &v["response"]["response"];
        assert_eq!(r["behavior"], "allow");
        assert_eq!(r["updatedInput"]["questions"], questions);
        assert_eq!(r["updatedInput"]["answers"]["Which colours?"], "GitHub");
        assert!(st.pending.is_empty());
        assert_eq!(st.status, "working");
    }

    #[test]
    fn unknown_control_requests_get_an_error_reply() {
        let mut a = Claude::default();
        let mut st = ChatState::default();
        let outs = a.on_line(r#"{"type":"control_request","request_id":"x","request":{"subtype":"elicitation"}}"#, &mut st);
        assert!(matches!(&outs[0], Out::Write(w) if w.contains("\"error\"")));
    }
}
