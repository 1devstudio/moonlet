//! Codex over `codex app-server` (JSON-RPC 2.0 without the `jsonrpc` field,
//! one message per line). Thread items map one-to-one onto chat items.

use std::collections::HashMap;

use jaunt_proto::types::{ChatState, PermissionAsk};
use serde_json::{Value, json};

use super::{Adapter, ChatConfig, Out, clip, item, tool_item, update, upsert};
use crate::paths::now_ms;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Pending {
    Initialize,
    Thread,
    Turn,
    Other,
}

#[derive(Default)]
pub struct Codex {
    next: u64,
    calls: HashMap<u64, Pending>,
    thread: Option<String>,
    turn: Option<String>,
    /// Messages sent before the thread exists.
    queued: Vec<String>,
    cfg: ChatConfig,
    /// Approval requests: our ask id → JSON-RPC request id and item id.
    asks: HashMap<String, (Value, String)>,
}

impl Codex {
    fn request(&mut self, kind: Pending, method: &str, params: Value) -> Out {
        self.next += 1;
        self.calls.insert(self.next, kind);
        Out::Write(json!({"id": self.next, "method": method, "params": params}).to_string())
    }

    fn turn_start(&mut self, text: &str) -> Out {
        let mut params = json!({
            "threadId": self.thread.clone().unwrap_or_default(),
            "input": [{"type": "text", "text": text, "text_elements": []}],
        });
        if let Some(m) = &self.cfg.model {
            params["model"] = json!(m);
        }
        if let Some(e) = &self.cfg.effort {
            params["effort"] = json!(e);
        }
        self.request(Pending::Turn, "turn/start", params)
    }

    /// Applies a ThreadItem from `item/started` or `item/completed`.
    fn apply_item(&mut self, it: &Value, done: bool, st: &mut ChatState) -> Option<Out> {
        let id = it["id"].as_str()?.to_string();
        let status_of = |s: &str| match s {
            "completed" => "ok",
            "failed" => "error",
            "declined" => "denied",
            _ => "running",
        };
        let mut chat = match it["type"].as_str()? {
            "agentMessage" => item(&id, "assistant", it["text"].as_str().unwrap_or("")),
            "reasoning" => {
                let parts = |k: &str| it[k].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n\n")).unwrap_or_default();
                let summary = parts("summary");
                item(&id, "thinking", if summary.is_empty() { parts("content") } else { summary })
            }
            "commandExecution" => {
                let mut t = tool_item(&id, "Bash", json!({"command": it["command"], "cwd": it["cwd"]}), status_of(it["status"].as_str().unwrap_or("")));
                if let Some(tc) = t.tool.as_mut() {
                    tc.output = it["aggregatedOutput"].as_str().map(clip);
                    if tc.status == "ok" && it["exitCode"].as_i64().is_some_and(|c| c != 0) {
                        tc.status = "error".into();
                    }
                }
                t
            }
            "fileChange" => {
                let changes = it["changes"].as_array().cloned().unwrap_or_default();
                let paths: Vec<&str> = changes.iter().filter_map(|c| c["path"].as_str()).collect();
                let mut t = tool_item(&id, "Edit", json!({"file_path": paths.join(", ")}), status_of(it["status"].as_str().unwrap_or("")));
                if let Some(tc) = t.tool.as_mut() {
                    let diff: String = changes.iter().filter_map(|c| c["diff"].as_str()).collect::<Vec<_>>().join("\n");
                    tc.diff = (!diff.is_empty()).then_some(diff);
                }
                t
            }
            "mcpToolCall" => {
                let name = format!("{}.{}", it["server"].as_str().unwrap_or("mcp"), it["tool"].as_str().unwrap_or("tool"));
                let mut t = tool_item(&id, &name, it["arguments"].clone(), status_of(it["status"].as_str().unwrap_or("")));
                if let Some(tc) = t.tool.as_mut() {
                    if let Some(e) = it["error"]["message"].as_str() {
                        tc.output = Some(e.to_string());
                        tc.status = "error".into();
                    } else if !it["result"].is_null() {
                        tc.output = Some(clip(&it["result"].to_string()));
                    }
                }
                t
            }
            "webSearch" => tool_item(&id, "WebSearch", json!({"query": it["query"]}), if done { "ok" } else { "running" }),
            // The user's own message is added when it is sent.
            _ => return None,
        };
        // A denial recorded locally wins over the agent's later status.
        if let Some(prev) = st.items.iter().find(|x| x.id == id)
            && prev.tool.as_ref().is_some_and(|t| t.status == "denied")
            && let Some(t) = chat.tool.as_mut()
        {
            t.status = "denied".into();
        }
        chat.partial = !done;
        Some(upsert(st, chat))
    }

    fn ask(&mut self, rid: Value, method: &str, p: &Value, st: &mut ChatState) -> Out {
        let item_id = p["itemId"].as_str().unwrap_or_default().to_string();
        let change = st.items.iter().find(|x| x.id == item_id).and_then(|x| x.tool.as_ref());
        let (tool, input, diff) = if method.contains("fileChange") {
            let paths = change.map(|t| t.summary.clone()).unwrap_or_default();
            ("Edit".to_string(), json!({"file_path": paths}), change.and_then(|t| t.diff.clone()))
        } else {
            ("Bash".to_string(), json!({"command": p["command"], "cwd": p["cwd"]}), None)
        };
        let id = format!("codex-{}", rid);
        st.pending.push(PermissionAsk {
            id: id.clone(),
            summary: super::summarize(&tool, &input),
            tool,
            input,
            reason: p["reason"].as_str().map(super::strip_ansi),
            can_always: true,
            diff,
        });
        self.asks.insert(id, (rid, item_id));
        st.status = "blocked".into();
        Out::State
    }
}

impl Adapter for Codex {
    fn command(&self, _cfg: &ChatConfig) -> (String, Vec<String>) {
        ("codex".into(), vec!["app-server".into()])
    }

    fn start(&mut self, cfg: &ChatConfig, st: &mut ChatState) -> Vec<Out> {
        self.cfg = cfg.clone();
        st.model = cfg.model.clone().or(st.model.take());
        st.effort = cfg.effort.clone().or(st.effort.take());
        if st.status.is_empty() {
            st.status = "idle".into();
        }
        let init = self.request(
            Pending::Initialize,
            "initialize",
            json!({"clientInfo": {"name": "jaunt", "title": "jaunt", "version": env!("CARGO_PKG_VERSION")}, "capabilities": null}),
        );
        vec![init, Out::State]
    }

    fn on_line(&mut self, line: &str, st: &mut ChatState) -> Vec<Out> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return vec![] };
        let mut out = Vec::new();
        let method = v["method"].as_str();
        match (method, v.get("id")) {
            // Response to one of our requests.
            (None, Some(id)) => {
                let kind = id.as_u64().and_then(|n| self.calls.remove(&n)).unwrap_or(Pending::Other);
                if let Some(err) = v.get("error") {
                    let msg = err["message"].as_str().unwrap_or("Codex request failed").to_string();
                    let eid = super::local_id("error");
                    out.push(upsert(st, item(eid, "error", msg)));
                    if kind != Pending::Other {
                        st.status = "error".into();
                        st.turn_started_at = None;
                    }
                    out.push(Out::State);
                    return out;
                }
                let r = &v["result"];
                match kind {
                    Pending::Initialize => {
                        out.push(Out::Write(json!({"method": "initialized"}).to_string()));
                        let mut params = json!({"cwd": self.cfg.cwd, "approvalPolicy": "on-request", "sandbox": "workspace-write"});
                        if let Some(m) = &self.cfg.model {
                            params["model"] = json!(m);
                        }
                        out.push(match self.cfg.resume.clone() {
                            Some(t) => {
                                params["threadId"] = json!(t);
                                params["excludeTurns"] = json!(true);
                                self.request(Pending::Thread, "thread/resume", params)
                            }
                            None => self.request(Pending::Thread, "thread/start", params),
                        });
                    }
                    Pending::Thread => {
                        self.thread = r["thread"]["id"].as_str().map(String::from);
                        st.agent_session = self.thread.clone();
                        if let Some(m) = r["model"].as_str() {
                            st.model.get_or_insert_with(|| m.to_string());
                        }
                        for text in std::mem::take(&mut self.queued) {
                            out.push(self.turn_start(&text));
                        }
                        out.push(Out::State);
                    }
                    Pending::Turn => self.turn = r["turn"]["id"].as_str().map(String::from).or(self.turn.take()),
                    Pending::Other => {}
                }
            }
            // Request from the server.
            (Some(m), Some(id)) => match m {
                "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                    out.push(self.ask(id.clone(), m, &v["params"], st));
                }
                _ => out.push(Out::Write(json!({"id": id, "error": {"code": -32601, "message": "not supported by jaunt"}}).to_string())),
            },
            (Some(m), None) => {
                let p = &v["params"];
                match m {
                    "turn/started" => {
                        self.turn = p["turn"]["id"].as_str().map(String::from);
                        st.status = "working".into();
                        st.turn_started_at.get_or_insert_with(now_ms);
                        out.push(Out::State);
                    }
                    "item/started" | "item/completed" => out.extend(self.apply_item(&p["item"], m == "item/completed", st)),
                    "item/agentMessage/delta" | "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                        let (id, delta) = (p["itemId"].as_str().unwrap_or_default().to_string(), p["delta"].as_str().unwrap_or(""));
                        let kind = if m == "item/agentMessage/delta" { "assistant" } else { "thinking" };
                        let o = update(st, &id, |it| it.text.push_str(delta)).unwrap_or_else(|| {
                            let mut it = item(&id, kind, delta);
                            it.partial = true;
                            upsert(st, it)
                        });
                        out.push(o);
                    }
                    "item/commandExecution/outputDelta" => {
                        let id = p["itemId"].as_str().unwrap_or_default();
                        let delta = p["delta"].as_str().unwrap_or("");
                        out.extend(update(st, id, |it| {
                            if let Some(t) = it.tool.as_mut() {
                                let o = t.output.get_or_insert_with(String::new);
                                o.push_str(delta);
                                *o = clip(o);
                            }
                        }));
                    }
                    "thread/tokenUsage/updated" => {
                        let total = &p["tokenUsage"]["total"];
                        st.input_tokens = total["inputTokens"].as_u64().unwrap_or(st.input_tokens);
                        st.output_tokens = total["outputTokens"].as_u64().unwrap_or(st.output_tokens);
                        out.push(Out::State);
                    }
                    "error" if !p["willRetry"].as_bool().unwrap_or(false) => {
                        let msg = p["error"]["message"].as_str().unwrap_or("Codex reported an error").to_string();
                        out.push(upsert(st, item(super::local_id("error"), "error", msg)));
                    }
                    "serverRequest/resolved" => {
                        // Answered elsewhere (or timed out): drop the card.
                        let rid = p["requestId"].to_string();
                        let id = format!("codex-{rid}");
                        if self.asks.remove(&id).is_some() {
                            st.pending.retain(|a| a.id != id);
                            if st.pending.is_empty() && st.status == "blocked" {
                                st.status = "working".into();
                            }
                            out.push(Out::State);
                        }
                    }
                    "turn/completed" => {
                        let turn = &p["turn"];
                        let status = turn["status"].as_str().unwrap_or("completed");
                        self.turn = None;
                        st.turn_started_at = None;
                        st.pending.clear();
                        self.asks.clear();
                        if status == "interrupted" {
                            out.push(upsert(st, item(super::local_id("system"), "system", "Interrupted")));
                            st.status = "idle".into();
                        } else if status == "failed" {
                            let msg = turn["error"]["message"].as_str().unwrap_or("The turn failed.").to_string();
                            out.push(upsert(st, item(super::local_id("error"), "error", msg)));
                            st.status = "error".into();
                        } else {
                            st.status = "done".into();
                        }
                        for it in st.items.iter_mut().filter(|i| i.partial) {
                            it.partial = false;
                            if let Some(t) = it.tool.as_mut()
                                && t.status == "running"
                            {
                                t.status = if status == "completed" { "ok".into() } else { "error".into() };
                            }
                            out.push(Out::Item(Box::new(it.clone())));
                        }
                        out.push(Out::State);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        out
    }

    fn send(&mut self, text: &str, st: &mut ChatState) -> Vec<Out> {
        let mut out = vec![upsert(st, item(super::local_id("user"), "user", text))];
        if self.thread.is_none() {
            self.queued.push(text.to_string());
        } else if let Some(turn) = self.turn.clone() {
            // A turn is running: steer it with the new input.
            let params = json!({"threadId": self.thread, "expectedTurnId": turn, "input": [{"type": "text", "text": text, "text_elements": []}]});
            out.push(self.request(Pending::Other, "turn/steer", params));
        } else {
            out.push(self.turn_start(text));
        }
        st.status = "working".into();
        st.turn_started_at.get_or_insert_with(now_ms);
        out.push(Out::State);
        out
    }

    fn permission(&mut self, ask: &str, decision: &str, _message: Option<&str>, st: &mut ChatState) -> Vec<Out> {
        let Some((rid, item_id)) = self.asks.remove(ask) else { return vec![] };
        st.pending.retain(|p| p.id != ask);
        let mut out = Vec::new();
        let d = match decision {
            "allow" => "accept",
            "always" => "acceptForSession",
            _ => {
                out.extend(update(st, &item_id, |it| {
                    if let Some(t) = it.tool.as_mut() {
                        t.status = "denied".into();
                    }
                }));
                "decline"
            }
        };
        out.push(Out::Write(json!({"id": rid, "result": {"decision": d}}).to_string()));
        st.status = if st.pending.is_empty() { "working".into() } else { "blocked".into() };
        out.push(Out::State);
        out
    }

    fn interrupt(&mut self, st: &mut ChatState) -> Vec<Out> {
        let (Some(thread), Some(turn)) = (self.thread.clone(), self.turn.clone()) else { return vec![] };
        let mut out = Vec::new();
        for (_, (rid, _)) in self.asks.drain() {
            out.push(Out::Write(json!({"id": rid, "result": {"decision": "cancel"}}).to_string()));
        }
        st.pending.clear();
        out.push(self.request(Pending::Other, "turn/interrupt", json!({"threadId": thread, "turnId": turn})));
        out.push(Out::State);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn writes(outs: &[Out]) -> Vec<Value> {
        outs.iter()
            .filter_map(|o| match o {
                Out::Write(w) => Some(serde_json::from_str(w).unwrap()),
                _ => None,
            })
            .collect()
    }

    fn feed(a: &mut Codex, st: &mut ChatState, v: Value) -> Vec<Out> {
        a.on_line(&v.to_string(), st)
    }

    #[test]
    fn handshake_queues_the_first_message_until_the_thread_exists() {
        let mut a = Codex::default();
        let mut st = ChatState::default();
        let cfg = ChatConfig { agent: "codex".into(), model: Some("gpt-5.5".into()), effort: Some("high".into()), cwd: "/repo".into(), ..Default::default() };
        let w = writes(&a.start(&cfg, &mut st));
        assert_eq!(w[0]["method"], "initialize");
        assert!(writes(&a.send("hello", &mut st)).is_empty(), "queued");
        let w = writes(&feed(&mut a, &mut st, json!({"id": 1, "result": {"userAgent": "codex"}})));
        assert_eq!(w[0]["method"], "initialized");
        assert_eq!(w[1]["method"], "thread/start");
        assert_eq!(w[1]["params"]["cwd"], "/repo");
        assert_eq!(w[1]["params"]["approvalPolicy"], "on-request");
        let w = writes(&feed(&mut a, &mut st, json!({"id": 2, "result": {"thread": {"id": "th1"}, "model": "gpt-5.5"}})));
        assert_eq!(st.agent_session.as_deref(), Some("th1"));
        assert_eq!(w[0]["method"], "turn/start");
        assert_eq!(w[0]["params"]["input"][0]["text"], "hello");
        assert_eq!(w[0]["params"]["effort"], "high");
    }

    #[test]
    fn resume_uses_thread_resume() {
        let mut a = Codex::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig { resume: Some("th9".into()), ..Default::default() }, &mut st);
        let w = writes(&feed(&mut a, &mut st, json!({"id": 1, "result": {}})));
        assert_eq!(w[1]["method"], "thread/resume");
        assert_eq!(w[1]["params"]["threadId"], "th9");
    }

    #[test]
    fn a_turn_with_streaming_a_command_and_an_approval() {
        let mut a = Codex::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig::default(), &mut st);
        feed(&mut a, &mut st, json!({"id": 1, "result": {}}));
        feed(&mut a, &mut st, json!({"id": 2, "result": {"thread": {"id": "th"}}}));
        a.send("list files", &mut st);
        feed(&mut a, &mut st, json!({"method": "turn/started", "params": {"threadId": "th", "turn": {"id": "tu"}}}));
        feed(&mut a, &mut st, json!({"method": "item/started", "params": {"item": {"type": "reasoning", "id": "r1", "summary": [], "content": []}}}));
        feed(&mut a, &mut st, json!({"method": "item/reasoning/summaryTextDelta", "params": {"itemId": "r1", "delta": "Look"}}));
        feed(&mut a, &mut st, json!({"method": "item/started", "params": {"item": {"type": "commandExecution", "id": "c1", "command": "rm -rf build", "cwd": "/repo", "status": "inProgress"}}}));
        feed(&mut a, &mut st, json!({"id": 7, "method": "item/commandExecution/requestApproval", "params": {"itemId": "c1", "command": "rm -rf build", "cwd": "/repo", "reason": "\u{1b}[1mwrites\u{1b}[0m outside"}}));
        assert_eq!(st.status, "blocked");
        let ask = st.pending[0].clone();
        assert_eq!(ask.summary, "rm -rf build");
        assert_eq!(ask.reason.as_deref(), Some("writes outside"));
        let w = writes(&a.permission(&ask.id, "deny", None, &mut st));
        assert_eq!(w[0], json!({"id": 7, "result": {"decision": "decline"}}));
        feed(&mut a, &mut st, json!({"method": "item/completed", "params": {"item": {"type": "commandExecution", "id": "c1", "command": "rm -rf build", "cwd": "/repo", "status": "declined"}}}));
        feed(&mut a, &mut st, json!({"method": "item/agentMessage/delta", "params": {"itemId": "m1", "delta": "Skipped"}}));
        feed(&mut a, &mut st, json!({"method": "item/agentMessage/delta", "params": {"itemId": "m1", "delta": " it."}}));
        feed(&mut a, &mut st, json!({"method": "thread/tokenUsage/updated", "params": {"tokenUsage": {"total": {"inputTokens": 100, "outputTokens": 20}}}}));
        feed(&mut a, &mut st, json!({"method": "turn/completed", "params": {"turn": {"id": "tu", "status": "completed"}}}));
        assert_eq!(st.status, "done");
        assert_eq!(st.items.iter().find(|i| i.id == "m1").unwrap().text, "Skipped it.");
        assert_eq!(st.items.iter().find(|i| i.id == "r1").unwrap().text, "Look");
        assert_eq!(st.items.iter().find(|i| i.id == "c1").unwrap().tool.as_ref().unwrap().status, "denied");
        assert_eq!((st.input_tokens, st.output_tokens), (100, 20));
        assert!(st.items.iter().all(|i| !i.partial));
    }

    #[test]
    fn interrupt_cancels_pending_approvals() {
        let mut a = Codex::default();
        let mut st = ChatState::default();
        a.thread = Some("th".into());
        a.turn = Some("tu".into());
        feed(&mut a, &mut st, json!({"id": "x", "method": "item/fileChange/requestApproval", "params": {"itemId": "f1"}}));
        let w = writes(&a.interrupt(&mut st));
        assert_eq!(w[0], json!({"id": "x", "result": {"decision": "cancel"}}));
        assert_eq!(w[1]["method"], "turn/interrupt");
        assert!(st.pending.is_empty());
    }
}
