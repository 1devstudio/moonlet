//! Codex over `codex app-server` (JSON-RPC 2.0 without the `jsonrpc` field,
//! one message per line). Thread items map one-to-one onto chat items.

use std::collections::{BTreeMap, HashMap};

use moonlet_proto::types::{ChatImage, ChatState, McpServer, PermissionAsk};
use serde_json::{Value, json};

use super::{Adapter, ChatConfig, Out, SignIns, clip, finish_turn, item, tool_item, update, upsert, user_text};
use crate::paths::now_ms;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Pending {
    Initialize,
    Thread,
    Turn,
    /// `mcpServerStatus/list` (X29).
    McpList,
    /// `mcpServer/oauth/login` (X29).
    McpLogin,
    Other,
}

/// One row of Codex's `mcpServerStatus/list` reply (X29).
fn mcp_server(v: &Value) -> Option<McpServer> {
    let status = match v["runtimeStatus"].as_str() {
        Some("connected") => "connected",
        Some("authenticationRequired") => "needs-auth",
        Some("failed") => "failed",
        Some("disabled" | "cancelled") => "disabled",
        Some(_) => "pending",
        None if v["authStatus"] == "notLoggedIn" => "needs-auth",
        None if v["toolsError"].is_string() => "failed",
        None => "pending",
    };
    let origin = v["httpOrigin"].as_str();
    // Tools are keyed by name, in no promised order: sort them.
    let mut tools: Vec<String> = v["tools"].as_object().map(|t| t.keys().cloned().collect()).unwrap_or_default();
    tools.sort();
    Some(McpServer {
        name: v["name"].as_str()?.to_string(),
        status: status.into(),
        transport: if origin.is_some() { "http".into() } else { "stdio".into() },
        endpoint: origin.map(String::from),
        scope: None,
        error: if status == "failed" { v["toolsError"].as_str().map(String::from) } else { None },
        tools,
        auth_url: None,
    })
}

#[derive(Default)]
pub struct Codex {
    next: u64,
    calls: HashMap<u64, Pending>,
    thread: Option<String>,
    turn: Option<String>,
    /// Messages (text and images) sent before the thread exists.
    queued: Vec<(String, Vec<ChatImage>)>,
    cfg: ChatConfig,
    /// Approval requests: our ask id → JSON-RPC request id and item id.
    asks: HashMap<String, (Value, String)>,
    /// The MCP servers were asked for before the thread existed (X29).
    mcp_wanted: bool,
    /// `mcpServer/oauth/login` requests: request id → server (X29).
    logins: HashMap<u64, String>,
    sign_ins: SignIns,
}

impl Codex {
    fn request(&mut self, kind: Pending, method: &str, params: Value) -> Out {
        self.next += 1;
        self.calls.insert(self.next, kind);
        Out::Write(json!({"id": self.next, "method": method, "params": params}).to_string())
    }

    /// `thread/resume` when there is a thread to continue, else `thread/start`.
    fn thread_request(&mut self) -> Out {
        let mut params = json!({"cwd": self.cfg.cwd, "approvalPolicy": "on-request", "sandbox": "workspace-write"});
        if let Some(m) = &self.cfg.model {
            params["model"] = json!(m);
        }
        // Added directories (X29) are writable next to the workspace.
        if !self.cfg.add_dirs.is_empty() {
            params["config"] = json!({"sandbox_workspace_write.writable_roots": self.cfg.add_dirs});
        }
        match self.cfg.resume.clone() {
            Some(t) => {
                params["threadId"] = json!(t);
                params["excludeTurns"] = json!(true);
                self.request(Pending::Thread, "thread/resume", params)
            }
            None => self.request(Pending::Thread, "thread/start", params),
        }
    }

    fn mcp_list(&mut self) -> Out {
        let params = json!({"threadId": self.thread, "detail": "toolsAndAuthOnly"});
        self.request(Pending::McpList, "mcpServerStatus/list", params)
    }

    /// A message as Codex `UserInput`s: the text, then each image as a
    /// `data:` URL (X29).
    fn input(text: &str, images: &[ChatImage]) -> Value {
        let mut input: Vec<Value> = if text.is_empty() { vec![] } else { vec![json!({"type": "text", "text": text, "text_elements": []})] };
        input.extend(images.iter().map(|i| json!({"type": "image", "url": format!("data:{};base64,{}", i.media_type, i.data)})));
        json!(input)
    }

    fn turn_start(&mut self, text: &str, images: &[ChatImage]) -> Out {
        let mut params = json!({
            "threadId": self.thread.clone().unwrap_or_default(),
            "input": Self::input(text, images),
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
            asked_at: Some(crate::paths::now_ms()),
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
            json!({"clientInfo": {"name": "moonlet", "title": "moonlet", "version": env!("CARGO_PKG_VERSION")}, "capabilities": null}),
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
                if kind == Pending::McpList {
                    let mut rows: Vec<McpServer> = v["result"]["data"].as_array().into_iter().flatten().filter_map(mcp_server).collect();
                    self.sign_ins.merge(&mut rows);
                    st.mcp_servers = Some(rows);
                    out.push(Out::State);
                    return out;
                }
                if kind == Pending::McpLogin {
                    let name = id.as_u64().and_then(|n| self.logins.remove(&n)).unwrap_or_default();
                    match v["result"]["authorizationUrl"].as_str() {
                        Some(url) => self.sign_ins.page(&name, url, false, st),
                        None => self.sign_ins.fail(&name, v["error"]["message"].as_str().unwrap_or("Sign-in failed."), st),
                    }
                    out.push(Out::State);
                    return out;
                }
                if let Some(err) = v.get("error") {
                    let msg = err["message"].as_str().unwrap_or("Codex request failed").to_string();
                    if kind == Pending::Thread && self.cfg.resume.take().is_some() {
                        // The saved thread is gone: continue in a new one.
                        let note = format!("Could not resume the previous Codex thread ({msg}); started a new one.");
                        out.push(upsert(st, item(super::local_id("system"), "system", note)));
                        out.push(self.thread_request());
                        out.push(Out::State);
                        return out;
                    }
                    if kind == Pending::Thread && !self.queued.is_empty() {
                        let lost = std::mem::take(&mut self.queued).len();
                        let note = format!("{lost} message(s) not delivered: no Codex thread.");
                        out.push(upsert(st, item(super::local_id("error"), "error", note)));
                    }
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
                        out.push(self.thread_request());
                    }
                    Pending::Thread => {
                        self.thread = r["thread"]["id"].as_str().map(String::from);
                        st.agent_session = self.thread.clone();
                        if let Some(m) = r["model"].as_str() {
                            st.model.get_or_insert_with(|| m.to_string());
                        }
                        if std::mem::take(&mut self.mcp_wanted) {
                            out.push(self.mcp_list());
                        }
                        for (text, images) in std::mem::take(&mut self.queued) {
                            out.push(self.turn_start(&text, &images));
                        }
                        out.push(Out::State);
                    }
                    Pending::Turn => self.turn = r["turn"]["id"].as_str().map(String::from).or(self.turn.take()),
                    Pending::McpList | Pending::McpLogin | Pending::Other => {}
                }
            }
            // Request from the server.
            (Some(m), Some(id)) => match m {
                "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                    out.push(self.ask(id.clone(), m, &v["params"], st));
                }
                _ => out.push(Out::Write(json!({"id": id, "error": {"code": -32601, "message": "not supported by moonlet"}}).to_string())),
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
                    // A server started, failed or came back: list them again
                    // once the user has looked at them.
                    "mcpServer/startupStatus/updated" if st.mcp_servers.is_some() && self.thread.is_some() => out.push(self.mcp_list()),
                    "mcpServer/oauthLogin/completed" => {
                        let name = p["name"].as_str().unwrap_or_default();
                        if p["success"].as_bool().unwrap_or(false) {
                            out.push(self.mcp_list());
                        } else {
                            self.sign_ins.fail(name, p["error"].as_str().unwrap_or("Sign-in failed."), st);
                            out.push(Out::State);
                        }
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
                        let started_at = st.turn_started_at.take();
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
                        if st.status == "done" {
                            out.extend(finish_turn(st, started_at));
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

    fn send(&mut self, text: &str, images: &[ChatImage], st: &mut ChatState) -> Vec<Out> {
        let mut out = vec![upsert(st, item(super::local_id("user"), "user", user_text(text, images)))];
        if self.thread.is_none() {
            self.queued.push((text.to_string(), images.to_vec()));
        } else if let Some(turn) = self.turn.clone() {
            // A turn is running: steer it with the new input.
            let params = json!({"threadId": self.thread, "expectedTurnId": turn, "input": Self::input(text, images)});
            out.push(self.request(Pending::Other, "turn/steer", params));
        } else {
            out.push(self.turn_start(text, images));
        }
        st.status = "working".into();
        st.turn_started_at.get_or_insert_with(now_ms);
        out.push(Out::State);
        out
    }

    fn mcp(&mut self, action: &str, server: Option<&str>, st: &mut ChatState) -> Vec<Out> {
        match (action, server) {
            ("auth", Some(name)) if self.thread.is_some() => {
                let out = self.request(Pending::McpLogin, "mcpServer/oauth/login", json!({"name": name, "threadId": self.thread}));
                self.logins.insert(self.next, name.to_string());
                self.sign_ins.start(name, st);
                return vec![out, Out::State];
            }
            ("cancel", Some(name)) => {
                self.sign_ins.cancel(name, st);
                return vec![Out::State];
            }
            // Codex has no per-server reconnect: retrying lists the servers again.
            ("refresh" | "reconnect", _) => {}
            _ => return vec![],
        }
        if self.thread.is_none() {
            self.mcp_wanted = true;
            return vec![];
        }
        vec![self.mcp_list()]
    }

    fn permission(&mut self, ask: &str, decision: &str, _message: Option<&str>, _answers: Option<&BTreeMap<String, String>>, _mode: Option<&str>, st: &mut ChatState) -> Vec<Out> {
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
    use moonlet_proto::types::McpServer;

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
        assert!(writes(&a.send("hello", &[], &mut st)).is_empty(), "queued");
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
    fn added_directories_are_extra_writable_roots() {
        let mut a = Codex::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig { add_dirs: vec!["/work/shared".into()], resume: Some("th9".into()), ..Default::default() }, &mut st);
        let w = writes(&feed(&mut a, &mut st, json!({"id": 1, "result": {}})));
        assert_eq!(w[1]["method"], "thread/resume");
        assert_eq!(w[1]["params"]["config"], json!({"sandbox_workspace_write.writable_roots": ["/work/shared"]}));
    }

    #[test]
    fn images_are_data_url_inputs_after_the_text() {
        let mut a = Codex::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig::default(), &mut st);
        feed(&mut a, &mut st, json!({"id": 1, "result": {}}));
        feed(&mut a, &mut st, json!({"id": 2, "result": {"thread": {"id": "th"}}}));
        let img = ChatImage { name: "shot.png".into(), media_type: "image/png".into(), data: "iVBORw0KGgo=".into() };
        let w = writes(&a.send("What is wrong here?", &[img], &mut st));
        assert_eq!(
            w[0]["params"]["input"],
            json!([
                {"type": "text", "text": "What is wrong here?", "text_elements": []},
                {"type": "image", "url": "data:image/png;base64,iVBORw0KGgo="},
            ])
        );
        assert_eq!(st.items.last().unwrap().text, "What is wrong here?\n[image: shot.png]");
    }

    /// Captured from codex-cli 0.160.0 (`mcpServerStatus/list` with a
    /// thread, trimmed): a stdio server that cannot start, a connected one,
    /// and an HTTP server that is not logged in.
    fn status_reply(id: u64) -> Value {
        json!({"id": id, "result": {"data": [
            {"name": "broken", "runtimeStatus": "failed", "pluginId": null, "httpOrigin": null, "serverInfo": null, "tools": {}, "toolsError": "MCP startup failed: No such file or directory (os error 2)", "resources": [], "resourceTemplates": [], "authStatus": "unsupported"},
            {"name": "everything", "runtimeStatus": "connected", "pluginId": null, "httpOrigin": null, "tools": {"get-env": {"name": "get-env", "title": "Print Environment Tool"}, "echo": {"name": "echo"}}, "toolsError": null, "resources": [], "resourceTemplates": [], "authStatus": "unsupported"},
            {"name": "linear", "runtimeStatus": "authenticationRequired", "pluginId": null, "httpOrigin": "https://mcp.linear.app", "tools": {}, "toolsError": "MCP startup failed: handshaking with MCP server failed: Send message error Transport error: Auth required", "resources": [], "resourceTemplates": [], "authStatus": "notLoggedIn"}
        ], "nextCursor": null}})
    }

    fn server(name: &str, status: &str, transport: &str, endpoint: Option<&str>, error: Option<&str>, tools: &[&str]) -> McpServer {
        McpServer { name: name.into(), status: status.into(), transport: transport.into(), endpoint: endpoint.map(Into::into), scope: None, error: error.map(Into::into), tools: tools.iter().map(|t| t.to_string()).collect(), auth_url: None }
    }

    #[test]
    fn mcp_servers_are_listed_for_the_thread_once_it_exists() {
        let mut a = Codex::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig::default(), &mut st);
        assert!(writes(&a.mcp("refresh", None, &mut st)).is_empty(), "no thread yet");
        feed(&mut a, &mut st, json!({"id": 1, "result": {}}));
        let w = writes(&feed(&mut a, &mut st, json!({"id": 2, "result": {"thread": {"id": "th"}}})));
        assert_eq!(w[0]["method"], "mcpServerStatus/list");
        assert_eq!(w[0]["params"], json!({"threadId": "th", "detail": "toolsAndAuthOnly"}));
        let id = w[0]["id"].as_u64().unwrap();
        feed(&mut a, &mut st, status_reply(id));
        assert_eq!(
            st.mcp_servers.clone().unwrap(),
            [
                server("broken", "failed", "stdio", None, Some("MCP startup failed: No such file or directory (os error 2)"), &[]),
                server("everything", "connected", "stdio", None, None, &["echo", "get-env"]),
                server("linear", "needs-auth", "http", Some("https://mcp.linear.app"), None, &[]),
            ]
        );
        assert_eq!(st.status, "idle", "listing servers is not a turn");
    }

    #[test]
    fn a_server_changing_state_relists_the_servers() {
        let mut a = Codex::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig::default(), &mut st);
        feed(&mut a, &mut st, json!({"id": 1, "result": {}}));
        feed(&mut a, &mut st, json!({"id": 2, "result": {"thread": {"id": "th"}}}));
        // Not listed yet: startup news is not worth a request.
        let quiet = json!({"method": "mcpServer/startupStatus/updated", "params": {"threadId": "th", "name": "everything", "status": "ready", "error": null, "failureReason": null}});
        assert!(writes(&feed(&mut a, &mut st, quiet.clone())).is_empty());
        let w = writes(&a.mcp("refresh", None, &mut st));
        feed(&mut a, &mut st, status_reply(w[0]["id"].as_u64().unwrap()));
        let w = writes(&feed(&mut a, &mut st, quiet));
        assert_eq!(w[0]["method"], "mcpServerStatus/list");
    }

    /// Captured from codex-cli 0.160.0, state and challenge replaced.
    const LINEAR_LOGIN: &str = "https://mcp.linear.app/authorize?response_type=code&client_id=https%3A%2F%2Fchatgpt.com%2Foauth%2Fcodex%2Fclient.json&state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A51137%2Fcallback&scope=read+write+openid+email&resource=https%3A%2F%2Fmcp.linear.app%2Fmcp";

    /// A Codex adapter with a thread and the captured servers listed.
    fn listed() -> (Codex, ChatState) {
        let mut a = Codex::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig::default(), &mut st);
        feed(&mut a, &mut st, json!({"id": 1, "result": {}}));
        feed(&mut a, &mut st, json!({"id": 2, "result": {"thread": {"id": "th"}}}));
        let w = writes(&a.mcp("refresh", None, &mut st));
        feed(&mut a, &mut st, status_reply(w[0]["id"].as_u64().unwrap()));
        (a, st)
    }

    fn linear(st: &ChatState) -> McpServer {
        st.mcp_servers.as_ref().unwrap().iter().find(|s| s.name == "linear").unwrap().clone()
    }

    #[test]
    fn signing_in_asks_codex_for_the_page_and_relists_when_done() {
        let (mut a, mut st) = listed();
        let w = writes(&a.mcp("auth", Some("linear"), &mut st));
        assert_eq!(w[0]["method"], "mcpServer/oauth/login");
        assert_eq!(w[0]["params"], json!({"name": "linear", "threadId": "th"}));
        assert_eq!(linear(&st).status, "authing");
        feed(&mut a, &mut st, json!({"id": w[0]["id"], "result": {"authorizationUrl": LINEAR_LOGIN}}));
        assert_eq!(linear(&st).auth_url.as_deref(), Some(LINEAR_LOGIN));

        // Listing again while the user signs in keeps it signing in.
        let w = writes(&a.mcp("refresh", None, &mut st));
        feed(&mut a, &mut st, status_reply(w[0]["id"].as_u64().unwrap()));
        assert_eq!((linear(&st).status.as_str(), linear(&st).auth_url.as_deref()), ("authing", Some(LINEAR_LOGIN)));

        let w = writes(&feed(&mut a, &mut st, json!({"method": "mcpServer/oauthLogin/completed", "params": {"name": "linear", "success": true, "error": null, "threadId": "th"}})));
        assert_eq!(w[0]["method"], "mcpServerStatus/list");
        let connected = status_reply(w[0]["id"].as_u64().unwrap()).to_string().replace("authenticationRequired", "connected");
        a.on_line(&connected, &mut st);
        assert_eq!((linear(&st).status.as_str(), linear(&st).auth_url.as_deref()), ("connected", None));
    }

    #[test]
    fn a_failed_codex_sign_in_shows_its_error() {
        let (mut a, mut st) = listed();
        let w = writes(&a.mcp("auth", Some("linear"), &mut st));
        feed(&mut a, &mut st, json!({"id": w[0]["id"], "result": {"authorizationUrl": LINEAR_LOGIN}}));
        feed(&mut a, &mut st, json!({"method": "mcpServer/oauthLogin/completed", "params": {"name": "linear", "success": false, "error": "access denied", "threadId": "th"}}));
        assert_eq!((linear(&st).status.as_str(), linear(&st).error.as_deref()), ("failed", Some("access denied")));
        assert_eq!(st.status, "idle", "a sign-in is not a turn");
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
        a.send("list files", &[], &mut st);
        feed(&mut a, &mut st, json!({"method": "turn/started", "params": {"threadId": "th", "turn": {"id": "tu"}}}));
        feed(&mut a, &mut st, json!({"method": "item/started", "params": {"item": {"type": "reasoning", "id": "r1", "summary": [], "content": []}}}));
        feed(&mut a, &mut st, json!({"method": "item/reasoning/summaryTextDelta", "params": {"itemId": "r1", "delta": "Look"}}));
        feed(&mut a, &mut st, json!({"method": "item/started", "params": {"item": {"type": "commandExecution", "id": "c1", "command": "rm -rf build", "cwd": "/repo", "status": "inProgress"}}}));
        feed(&mut a, &mut st, json!({"id": 7, "method": "item/commandExecution/requestApproval", "params": {"itemId": "c1", "command": "rm -rf build", "cwd": "/repo", "reason": "\u{1b}[1mwrites\u{1b}[0m outside"}}));
        assert_eq!(st.status, "blocked");
        let ask = st.pending[0].clone();
        assert_eq!(ask.summary, "rm -rf build");
        assert_eq!(ask.reason.as_deref(), Some("writes outside"));
        let w = writes(&a.permission(&ask.id, "deny", None, None, None, &mut st));
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
    fn only_a_completed_turn_stamps_its_final_message() {
        for (status, stamped) in [("completed", true), ("interrupted", false), ("failed", false)] {
            let mut a = Codex::default();
            let mut st = ChatState::default();
            a.thread = Some("th".into());
            a.send("hi", &[], &mut st);
            st.turn_started_at = Some(1_000);
            feed(&mut a, &mut st, json!({"method": "item/agentMessage/delta", "params": {"itemId": "m1", "delta": "First"}}));
            feed(&mut a, &mut st, json!({"method": "item/agentMessage/delta", "params": {"itemId": "m2", "delta": "Final"}}));
            feed(&mut a, &mut st, json!({"method": "turn/completed", "params": {"turn": {"id": "tu", "status": status}}}));
            let turns: Vec<_> = st.items.iter().filter_map(|i| i.turn.map(|t| (i.id.clone(), t.started_at))).collect();
            assert_eq!(turns, if stamped { vec![("m2".to_string(), 1_000)] } else { vec![] }, "{status}");
        }
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

    #[test]
    fn a_failed_resume_starts_a_new_thread_and_delivers_queued_messages() {
        let mut a = Codex::default();
        let mut st = ChatState::default();
        a.start(&ChatConfig { resume: Some("gone".into()), ..Default::default() }, &mut st);
        a.send("hi", &[], &mut st);
        feed(&mut a, &mut st, json!({"id": 1, "result": {}}));
        let w = writes(&feed(&mut a, &mut st, json!({"id": 2, "error": {"message": "thread not found"}})));
        assert_eq!(w[0]["method"], "thread/start");
        assert_ne!(st.status, "error");
        let w = writes(&feed(&mut a, &mut st, json!({"id": 3, "result": {"thread": {"id": "new"}}})));
        assert_eq!(w[0]["method"], "turn/start");
        assert_eq!(w[0]["params"]["input"][0]["text"], "hi");
        assert_eq!(st.agent_session.as_deref(), Some("new"));
    }
}
