//! Workspaces, projects and sessions (X5, A4, S4). A workspace is a named
//! set of projects; a project is a repo folder; a session is one task: a git
//! worktree on its own branch plus the terminals running in it. State is
//! persisted to `~/.moonlet/state.json` so it survives daemon restarts.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use moonlet_proto::methods::{
    self, SectionUpdate, SessionArchive, SessionCreate, SessionUpdate, TerminalCreate, WorkspaceCreate,
    WorkspaceUpdate,
};
use moonlet_proto::types::{
    ClaudeProfile, Project, ProjectConfig, ProjectConfigFile, PullRequest, RestoreEntry, Section, SectionView, Session, SessionArchived, StartFrom,
    TerminalInfo, TerminalKind, Workspace, WorkspaceColor,
};
use moonlet_proto::{Message, TerminalId};
use serde::{Deserialize, Serialize};

use crate::{git, git_settings};
use crate::paths::now_ms;
use crate::pty::user_shell;
use crate::terminal::{TerminalManager, expand_home};

mod account;

const STATE_VERSION: u32 = 3;
/// The workspace every install starts with, and that X5's workspaces are
/// migrated into (X32).
pub const DEFAULT_WORKSPACE: &str = "Personal";
const DEFAULT_COLOR: WorkspaceColor = WorkspaceColor::Clay;
/// The section a project lands in when nothing else holds it.
pub const DEFAULT_SECTION: &str = "My projects";
const NO_PROFILE: &str = "no such Claude profile";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub sections: Vec<Section>,
    /// Claude profiles (X33).
    #[serde(default)]
    pub profiles: Vec<ClaudeProfile>,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub sessions: Vec<Session>,
    /// Workspaces merged into another, by id: their sessions on every
    /// member follow them there (X68). Kept in the account, not here.
    #[serde(skip)]
    pub merges: BTreeMap<String, String>,
}

impl State {
    /// Reads `state.json`, migrating the pre-ADR-0005 layout where `repos`
    /// were projects and `workspaces` were what are now sessions, and the X5
    /// layout where workspaces were what are now sections (ADR 0007).
    pub fn parse(text: &str) -> State {
        Self::try_parse(text).unwrap_or_else(|_| {
            let mut st = State {
                version: STATE_VERSION,
                ..Default::default()
            };
            st.ensure();
            st
        })
    }

    /// Parses (and migrates) a state file; fails on unreadable JSON instead
    /// of silently starting empty.
    pub fn try_parse(text: &str) -> Result<State, serde_json::Error> {
        let mut v = serde_json::from_str::<serde_json::Value>(text)?;
        let version = v.get("version").and_then(|x| x.as_u64()).unwrap_or(0);
        if let Some(obj) = v.as_object_mut() {
            if version < 2 {
                let repos = obj.remove("repos").unwrap_or(serde_json::json!([]));
                let tasks = obj.remove("workspaces").unwrap_or(serde_json::json!([]));
                obj.insert("projects".into(), repos);
                obj.insert("sessions".into(), tasks);
            }
            if version < 3 {
                migrate_x5(obj);
            }
        }
        let mut st: State = serde_json::from_value(v)?;
        st.version = STATE_VERSION;
        st.ensure();
        Ok(st)
    }

    /// Forgets a project, its archived sessions and its section entries.
    fn drop_project(&mut self, id: &str) -> Result<()> {
        if self
            .sessions
            .iter()
            .any(|w| w.project_id == id && !w.archived)
        {
            bail!("archive this project's sessions first");
        }
        self.projects.retain(|r| r.id != id);
        self.sessions.retain(|w| w.project_id != id);
        for s in &mut self.sections {
            s.project_ids.retain(|p| p != id);
        }
        Ok(())
    }

    /// The profile of a session's workspace (X33).
    fn profile_of(&self, session: &str) -> Option<&ClaudeProfile> {
        let ws = self.sessions.iter().find(|s| s.id == session)?.workspace_id.as_deref()?;
        self.profile_of_workspace(ws)
    }

    fn profile_of_workspace(&self, ws: &str) -> Option<&ClaudeProfile> {
        let profile = self.workspaces.iter().find(|w| w.id == ws)?.claude_profile.as_deref()?;
        self.profiles.iter().find(|p| p.id == profile)
    }

    fn workspace_mut(&mut self, id: &str) -> Result<&mut Workspace> {
        self.workspaces.iter_mut().find(|w| w.id == id).context("no such workspace")
    }

    fn section_mut(&mut self, id: &str) -> Result<&mut Section> {
        self.sections.iter_mut().find(|s| s.id == id).context("no such section")
    }

    fn workspace_of_section(&self, section: &str) -> Option<usize> {
        self.workspaces
            .iter()
            .position(|w| w.section_ids.iter().any(|s| s == section))
    }

    /// Whether a section of workspace `ws`, other than `except`, holds `project`.
    fn holds_project(&self, ws: &str, project: &str, except: Option<&str>) -> bool {
        let Some(w) = self.workspaces.iter().find(|w| w.id == ws) else {
            return false;
        };
        self.sections.iter().any(|s| {
            Some(s.id.as_str()) != except
                && w.section_ids.contains(&s.id)
                && s.project_ids.iter().any(|p| p == project)
        })
    }

    /// The first workspace with a section holding `project`.
    fn first_holding(&self, project: &str) -> Option<String> {
        self.workspaces
            .iter()
            .find(|w| self.holds_project(&w.id, project, None))
            .map(|w| w.id.clone())
    }

    /// Whether `project` has an unarchived session in workspace `ws`.
    fn has_live_sessions(&self, ws: &str, project: &str) -> bool {
        self.sessions
            .iter()
            .any(|s| !s.archived && s.project_id == project && s.workspace_id.as_deref() == Some(ws))
    }

    /// Moves section `id` to workspace `to`. Sessions of its projects follow it
    /// unless their old workspace still holds the project in another section.
    fn move_section(&mut self, id: &str, to: &str) -> Result<()> {
        if !self.workspaces.iter().any(|w| w.id == to) {
            bail!("no such workspace");
        }
        let from = self.workspace_of_section(id).context("no such section")?;
        let from_id = self.workspaces[from].id.clone();
        if from_id == to {
            return Ok(());
        }
        let projects = self
            .sections
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.project_ids.clone())
            .unwrap_or_default();
        let following: Vec<String> = projects
            .into_iter()
            .filter(|p| !self.holds_project(&from_id, p, Some(id)))
            .collect();
        self.workspaces[from].section_ids.retain(|s| s != id);
        self.workspaces
            .iter_mut()
            .find(|w| w.id == to)
            .unwrap()
            .section_ids
            .push(id.to_string());
        for s in &mut self.sessions {
            if s.workspace_id.as_deref() == Some(from_id.as_str()) && following.contains(&s.project_id) {
                s.workspace_id = Some(to.to_string());
            }
        }
        Ok(())
    }

    /// Keeps the model whole: there is always a workspace; every section
    /// belongs to one; every project is in a section; every session is in a
    /// workspace, preferably one that holds its project.
    fn ensure(&mut self) {
        if self.workspaces.is_empty() {
            self.workspaces.push(new_workspace(DEFAULT_WORKSPACE, DEFAULT_COLOR));
        }
        let known: Vec<String> = self.sections.iter().map(|s| s.id.clone()).collect();
        for w in &mut self.workspaces {
            w.section_ids.retain(|id| known.contains(id));
        }
        for id in known {
            if self.workspace_of_section(&id).is_none() {
                self.workspaces[0].section_ids.push(id);
            }
        }
        let orphans: Vec<String> = self
            .projects
            .iter()
            .filter(|p| !self.sections.iter().any(|s| s.project_ids.contains(&p.id)))
            .map(|p| p.id.clone())
            .collect();
        if self.sections.is_empty() || !orphans.is_empty() {
            let first = self.workspaces[0].section_ids.first().cloned();
            let id = match first {
                Some(id) => id,
                None => {
                    let s = new_section(DEFAULT_SECTION);
                    let id = s.id.clone();
                    self.sections.push(s);
                    self.workspaces[0].section_ids.push(id.clone());
                    id
                }
            };
            if let Some(s) = self.sections.iter_mut().find(|s| s.id == id) {
                s.project_ids.extend(orphans);
            }
        }
        let workspaces: Vec<String> = self.workspaces.iter().map(|w| w.id.clone()).collect();
        for i in 0..self.sessions.len() {
            let project = self.sessions[i].project_id.clone();
            let current = self.sessions[i].workspace_id.clone().filter(|w| workspaces.contains(w));
            // A session's workspace must hold its project, or the session
            // shows nowhere; the delete rules keep live sessions there.
            let home = match current {
                Some(w) if self.holds_project(&w, &project, None) => continue,
                Some(w) => self.first_holding(&project).unwrap_or(w),
                None => self.first_holding(&project).unwrap_or_else(|| workspaces[0].clone()),
            };
            self.sessions[i].workspace_id = Some(home);
        }
    }
}

/// X5 to X32 (ADR 0007): X5's workspaces become sections of one workspace,
/// "Personal", in the same order; X5's session sections are dropped.
fn migrate_x5(obj: &mut serde_json::Map<String, serde_json::Value>) {
    use serde_json::{Value, json};
    let old = match obj.remove("workspaces") {
        Some(Value::Array(a)) => a,
        _ => Vec::new(),
    };
    let sections: Vec<Value> = old
        .into_iter()
        .map(|mut w| {
            if let Some(o) = w.as_object_mut() {
                o.remove("sections");
            }
            w
        })
        .collect();
    let ids: Vec<Value> = sections.iter().filter_map(|s| s.get("id").cloned()).collect();
    let mut personal = new_workspace(DEFAULT_WORKSPACE, DEFAULT_COLOR);
    personal.section_ids = ids.iter().filter_map(|v| v.as_str().map(String::from)).collect();
    let pid = personal.id.clone();
    obj.insert("workspaces".into(), json!([personal]));
    obj.insert("sections".into(), Value::Array(sections));
    if let Some(Value::Array(sessions)) = obj.get_mut("sessions") {
        for s in sessions {
            if let Some(o) = s.as_object_mut() {
                o.remove("section");
                o.insert("workspace_id".into(), json!(pid));
            }
        }
    }
}

/// `cmd` run with profile folder `dir` (X33): an export in front, after the
/// login shell's rc files, replacing the one it may already start with.
fn with_profile(cmd: &str, dir: Option<&str>) -> String {
    let var = crate::profiles::CONFIG_DIR_VAR;
    let bare = match cmd.strip_prefix(&format!("export {var}=")) {
        Some(rest) => rest.split_once("; ").map_or(cmd, |(_, after)| after),
        None => cmd,
    };
    match dir {
        Some(d) => format!("export {var}={}; {bare}", shell_quote(d)),
        None => bare.to_string(),
    }
}

/// A workspace's `claude_profile`: `None`/`""` is the default profile,
/// anything else must be a known profile.
fn check_profile(st: &State, id: Option<&str>) -> Result<Option<String>> {
    match id.filter(|id| !id.is_empty()) {
        None => Ok(None),
        Some(id) if st.profiles.iter().any(|p| p.id == id) => Ok(Some(id.to_string())),
        Some(_) => bail!(NO_PROFILE),
    }
}

fn new_workspace(name: &str, color: WorkspaceColor) -> Workspace {
    Workspace {
        id: new_id(),
        name: name.into(),
        color,
        section_ids: Vec::new(),
        claude_profile: None,
        created_at: now_ms(),
        made_by: None,
    }
}

fn new_section(name: &str) -> Section {
    Section {
        id: new_id(),
        name: name.into(),
        project_ids: Vec::new(),
        view: SectionView::default(),
        created_at: now_ms(),
        missing: Vec::new(),
    }
}

pub struct SessionManager {
    state: Mutex<State>,
    file: PathBuf,
    worktrees_root: PathBuf,
    terminals: Arc<TerminalManager>,
    /// Structured agents (X6); absent in tests that do not need them.
    chats: std::sync::OnceLock<Arc<crate::chat::runtime::ChatManager>>,
    /// Set when an unreadable state file could not be backed up: saving
    /// would destroy the only copy, so it is refused.
    save_blocked: bool,
    /// Per session, held while its new terminals start and while it is
    /// archived, so an archive never runs between a creation's look at the
    /// session and its terminals starting (X65).
    lifecycles: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// The account state this member shares (X68), once the daemon has
    /// attached it; tests without it keep the state to themselves.
    account: Mutex<Option<account::Account>>,
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

/// Session name: the given one, else the prompt's first line (≤ 48 chars).
pub fn derive_name(name: Option<&str>, prompt: Option<&str>) -> String {
    if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
        return n.to_string();
    }
    let line = prompt
        .and_then(|p| p.lines().map(str::trim).find(|l| !l.is_empty()))
        .unwrap_or("");
    if line.is_empty() {
        return "Untitled".into();
    }
    let mut out: String = line.chars().take(48).collect();
    if line.chars().count() > 48 {
        if let Some(i) = out.rfind(' ').filter(|i| *i > 24) {
            out.truncate(i);
        }
        out.push('…');
    }
    out
}

/// Model, effort and name flags for the agents that understand them.
fn agent_flags(cmd: &str, s: &Session) -> String {
    let mut out = String::new();
    match crate::agent::detect_agent(cmd) {
        Some("claude") => {
            if let Some(m) = &s.model {
                out.push_str(&format!(" --model {}", shell_quote(m)));
            }
            if let Some(e) = &s.effort {
                out.push_str(&format!(" --effort {}", shell_quote(e)));
            }
            if let Some(m) = s.mode.as_deref().filter(|m| crate::chat::PERMISSION_MODES.contains(m)) {
                out.push_str(&format!(" --permission-mode {}", shell_quote(m)));
            }
            out.push_str(&format!(" -n {}", shell_quote(&s.name)));
        }
        Some("codex") => {
            if let Some(m) = &s.model {
                out.push_str(&format!(" -m {}", shell_quote(m)));
            }
            if let Some(e) = &s.effort {
                out.push_str(&format!(
                    " -c {}",
                    shell_quote(&format!("model_reasoning_effort={e}"))
                ));
            }
        }
        _ => {}
    }
    out
}

/// Built-in agent commands; `.moonlet/config.toml` `[agents]` adds more.
fn builtin_agent(name: &str, resume: bool) -> Option<&'static str> {
    match (name, resume) {
        ("claude", false) => Some("claude"),
        ("claude", true) => Some("claude --continue"),
        ("codex", false) => Some("codex"),
        ("codex", true) => Some("codex resume --last"),
        _ => None,
    }
}

/// Whether `s` is the unarchived session at `path`. Archived sessions keep
/// their old path, which a new session of the same name may now use.
fn live_at(s: &Session, path: &Path) -> bool {
    !s.archived && Path::new(&s.path) == path
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

impl SessionManager {
    pub fn load(
        file: PathBuf,
        worktrees_root: PathBuf,
        terminals: Arc<TerminalManager>,
    ) -> Arc<Self> {
        let mut save_blocked = false;
        let parsed = std::fs::read(&file).map(|bytes| {
            String::from_utf8(bytes)
                .map_err(|e| e.to_string())
                .and_then(|s| State::try_parse(&s).map_err(|e| e.to_string()))
        });
        let state = match parsed {
            Ok(Ok(st)) => st,
            Ok(Err(e)) => {
                // Keep the damaged file: the next save would overwrite it.
                let backup = file.with_extension(format!("json.corrupt-{}", now_ms()));
                match std::fs::copy(&file, &backup) {
                    Ok(_) => tracing::warn!(
                        "{} is unreadable ({e}); starting empty, kept a copy at {}",
                        file.display(),
                        backup.display()
                    ),
                    Err(ce) => {
                        save_blocked = true;
                        tracing::error!(
                            "{} is unreadable ({e}) and could not be backed up ({ce}); not saving over it",
                            file.display()
                        );
                    }
                }
                State::parse("")
            }
            // Missing (first start) or unreadable: start empty.
            Err(_) => State::parse(""),
        };
        let mgr = Arc::new(Self {
            state: Mutex::new(state),
            file,
            worktrees_root,
            terminals,
            chats: std::sync::OnceLock::new(),
            save_blocked,
            lifecycles: Mutex::new(HashMap::new()),
            account: Mutex::new(None),
        });
        tokio::spawn(track_removed_sessions(Arc::downgrade(&mgr)));
        mgr
    }

    pub fn set_chats(self: &Arc<Self>, chats: Arc<crate::chat::runtime::ChatManager>) {
        let me = Arc::downgrade(self);
        chats.set_session_env(Box::new(move |id| me.upgrade().map(|m| m.session_launch(id)).unwrap_or_default()));
        let _ = self.chats.set(chats);
    }

    /// The chat runtime when `agent` should run structured.
    fn chat_runtime(&self, agent: Option<&str>) -> Option<&Arc<crate::chat::runtime::ChatManager>> {
        agent.filter(|a| crate::chat::supports(a)).and(self.chats.get())
    }

    fn save(&self, state: &State) -> Result<()> {
        if self.save_blocked {
            bail!(
                "{} could not be backed up after a read error; move it aside to continue",
                self.file.display()
            );
        }
        if let Some(dir) = self.file.parent() {
            crate::paths::ensure_private_dir(dir)?;
        }
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(state)?)?;
        std::fs::rename(&tmp, &self.file)?;
        Ok(())
    }

    /// Applies `f` to a copy of the state and keeps it only when `f` and the
    /// save succeed, so a request failing half-way changes nothing.
    fn mutate<T>(&self, f: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        let mut st = self.state.lock().unwrap();
        let mut next = st.clone();
        let out = f(&mut next)?;
        let mut account = self.account.lock().unwrap();
        let staged = match account.as_ref() {
            Some(a) => Some(a.stage(&st, &next)?),
            None => None,
        };
        // The state as every member lays the account onto theirs, so that
        // a project added here leaves `missing`, and repairs match (X68).
        if let Some(s) = staged.as_ref().filter(|s| !s.changes.is_empty()) {
            account::lay_onto(&mut next, s.log());
        }
        if let Err(e) = self.save(&next) {
            if let Some(s) = staged {
                s.discard();
            }
            return Err(e);
        }
        *st = next;
        let changes = match (account.as_mut(), staged) {
            (Some(a), Some(s)) => a.commit(s),
            _ => Vec::new(),
        };
        drop(account);
        drop(st);
        if !changes.is_empty() {
            self.account_changed(changes);
        }
        Ok(out)
    }

    fn emit_sessions(&self) {
        self.terminals.emit(Message::event(
            methods::EV_SESSIONS_CHANGED,
            self.list_sessions(),
        ));
    }

    pub fn list_projects(&self) -> Vec<Project> {
        self.state.lock().unwrap().projects.clone()
    }

    pub fn list_sessions(&self) -> Vec<Session> {
        let live: std::collections::HashSet<TerminalId> =
            self.terminals.list().into_iter().map(|s| s.id).collect();
        let mut list = self.state.lock().unwrap().sessions.clone();
        for w in &mut list {
            w.terminals.retain(|id| live.contains(id));
        }
        list
    }

    pub fn session(&self, id: &str) -> Result<Session> {
        self.state
            .lock()
            .unwrap()
            .sessions
            .iter()
            .find(|w| w.id == id)
            .cloned()
            .context("no such session")
    }

    fn project(&self, id: &str) -> Result<Project> {
        self.state
            .lock()
            .unwrap()
            .projects
            .iter()
            .find(|r| r.id == id)
            .cloned()
            .context("no such project")
    }

    fn emit_workspaces(&self) {
        self.terminals.emit(Message::event(
            methods::EV_WORKSPACES_CHANGED,
            self.list_workspaces(),
        ));
    }

    fn emit_sections(&self) {
        self.terminals.emit(Message::event(
            methods::EV_SECTIONS_CHANGED,
            self.list_sections(),
        ));
    }

    fn emit_projects(&self) {
        self.terminals.emit(Message::event(
            methods::EV_PROJECTS_CHANGED,
            self.list_projects(),
        ));
    }

    pub fn list_workspaces(&self) -> Vec<Workspace> {
        self.state.lock().unwrap().workspaces.clone()
    }

    pub fn list_sections(&self) -> Vec<Section> {
        self.state.lock().unwrap().sections.clone()
    }

    /// Creates a workspace (X32), moving `move_sections` into it from the
    /// workspaces they are in.
    pub fn create_workspace(&self, req: WorkspaceCreate) -> Result<Workspace> {
        let name = req.name.trim();
        if name.is_empty() {
            bail!("workspace name is empty");
        }
        let mut ws = new_workspace(name, req.color);
        let id = ws.id.clone();
        self.mutate(|st| {
            ws.claude_profile = check_profile(st, req.claude_profile.as_deref())?;
            st.workspaces.push(ws);
            for sec in &req.move_sections {
                st.move_section(sec, &id)?;
            }
            Ok(())
        })?;
        self.emit_all();
        Ok(self
            .list_workspaces()
            .into_iter()
            .find(|w| w.id == id)
            .unwrap())
    }

    pub fn update_workspace(&self, req: WorkspaceUpdate) -> Result<Workspace> {
        let out = self.mutate(|st| {
            let profile = match &req.claude_profile {
                Some(p) => Some(check_profile(st, p.as_deref())?),
                None => None,
            };
            let w = st.workspace_mut(&req.id)?;
            if let Some(p) = profile {
                w.claude_profile = p;
            }
            if let Some(n) = req.name {
                if n.trim().is_empty() {
                    bail!("workspace name is empty");
                }
                w.name = n.trim().to_string();
            }
            if let Some(c) = req.color {
                w.color = c;
            }
            let own = w.section_ids.clone();
            if let Some(ids) = req.section_ids {
                if own.iter().any(|s| !ids.contains(s)) {
                    bail!("section_ids must keep this workspace's sections: move or delete a section instead");
                }
                // Sections of other workspaces come in with their sessions.
                for id in ids.iter().filter(|id| !own.contains(id)) {
                    st.move_section(id, &req.id)?;
                }
                st.workspaces.iter_mut().find(|w| w.id == req.id).unwrap().section_ids = ids;
            }
            Ok(st.workspaces.iter().find(|w| w.id == req.id).cloned().unwrap())
        })?;
        self.emit_all();
        Ok(out)
    }

    /// Deletes an empty workspace. Its archived sessions move to the first
    /// workspace holding their project.
    pub fn delete_workspace(&self, id: &str) -> Result<()> {
        self.mutate(|st| {
            let w = st
                .workspaces
                .iter()
                .find(|w| w.id == id)
                .context("no such workspace")?;
            if st.workspaces.len() == 1 {
                bail!("the last workspace cannot be deleted");
            }
            if !w.section_ids.is_empty() {
                bail!("move or delete this workspace's sections first");
            }
            st.workspaces.retain(|w| w.id != id);
            st.ensure();
            Ok(())
        })?;
        self.emit_workspaces();
        self.emit_sessions();
        Ok(())
    }

    /// Merges workspace `id` into `into` (X68): its sections move in after
    /// `into`'s own, with every session of `id`, and `id` is deleted.
    pub fn merge_workspace(&self, id: &str, into: &str) -> Result<()> {
        if id == into {
            bail!("a workspace cannot merge into itself");
        }
        self.mutate(|st| {
            st.workspace_mut(into)?;
            let sections = st.workspaces.iter().find(|w| w.id == id).context("no such workspace")?.section_ids.clone();
            for s in &sections {
                st.move_section(s, into)?;
            }
            st.merges.insert(id.to_string(), into.to_string());
            // Archived sessions, and those of projects held elsewhere too.
            for s in &mut st.sessions {
                if s.workspace_id.as_deref() == Some(id) {
                    s.workspace_id = Some(into.to_string());
                }
            }
            st.workspaces.retain(|w| w.id != id);
            st.ensure();
            Ok(())
        })?;
        self.emit_all();
        Ok(())
    }

    /// Each workspace merged into another (X68) that is gone, with the
    /// workspace it now lives in: the end of its chain of merges.
    pub fn merged_workspaces(&self) -> Vec<(String, String)> {
        let st = self.state.lock().unwrap();
        let exists = |w: &str| st.workspaces.iter().any(|x| x.id == w);
        st.merges
            .keys()
            .filter(|from| !exists(from))
            .filter_map(|from| {
                // However long the chain; a loop ends it.
                let mut seen = std::collections::HashSet::from([from.as_str()]);
                let mut at = st.merges.get(from)?;
                while !exists(at) {
                    if !seen.insert(at.as_str()) {
                        return None;
                    }
                    at = st.merges.get(at)?;
                }
                Some((from.clone(), at.clone()))
            })
            .collect()
    }

    pub fn create_section(&self, workspace_id: &str, name: &str) -> Result<Section> {
        let name = name.trim();
        if name.is_empty() {
            bail!("section name is empty");
        }
        let sec = new_section(name);
        let out = sec.clone();
        self.mutate(|st| {
            st.workspace_mut(workspace_id)?
                .section_ids
                .push(sec.id.clone());
            st.sections.push(sec);
            Ok(())
        })?;
        self.emit_sections();
        self.emit_workspaces();
        Ok(out)
    }

    pub fn update_section(&self, req: SectionUpdate) -> Result<Section> {
        let out = self.mutate(|st| {
            let known: Vec<String> = st.projects.iter().map(|p| p.id.clone()).collect();
            let s = st.section_mut(&req.id)?;
            if let Some(n) = req.name.filter(|n| !n.trim().is_empty()) {
                s.name = n.trim().to_string();
            }
            if let Some(ids) = req.project_ids {
                s.project_ids = ids.into_iter().filter(|id| known.contains(id)).collect();
            }
            if let Some(view) = req.view {
                s.view = view;
            }
            Ok(s.clone())
        })?;
        self.emit_sections();
        Ok(out)
    }

    /// Deletes the grouping only. Projects no other section of the workspace
    /// holds move to its first other section; without one, they may only go
    /// while none of their sessions here is live.
    pub fn delete_section(&self, id: &str) -> Result<()> {
        self.mutate(|st| {
            let wi = st.workspace_of_section(id).context("no such section")?;
            let ws = st.workspaces[wi].id.clone();
            let other = st.workspaces[wi].section_ids.iter().find(|s| *s != id).cloned();
            let sec = st.sections.iter().find(|s| s.id == id).cloned().context("no such section")?;
            let held_only_here: Vec<String> = sec
                .project_ids
                .iter()
                .filter(|p| !st.holds_project(&ws, p, Some(id)))
                .cloned()
                .collect();
            match other {
                Some(other) => {
                    let o = st.sections.iter_mut().find(|s| s.id == other).unwrap();
                    o.project_ids.extend(held_only_here);
                    // Those other members have but this one lacks, too (X68).
                    for m in &sec.missing {
                        if !o.missing.contains(m) {
                            o.missing.push(m.clone());
                        }
                    }
                }
                None if held_only_here.iter().any(|p| st.has_live_sessions(&ws, p)) => {
                    bail!("archive the sessions of this section's projects first")
                }
                None => {}
            }
            st.sections.retain(|s| s.id != id);
            st.ensure();
            Ok(())
        })?;
        self.emit_all();
        Ok(())
    }

    /// Moves a section to another workspace, with the sessions of the
    /// projects only it held in its old workspace.
    pub fn move_section(&self, id: &str, workspace_id: &str) -> Result<()> {
        self.mutate(|st| st.move_section(id, workspace_id))?;
        self.emit_all();
        Ok(())
    }

    fn emit_all(&self) {
        self.emit_workspaces();
        self.emit_sections();
        self.emit_sessions();
        self.emit_projects();
    }

    /// Adds a project (or finds it) and attaches it to a section.
    pub async fn section_add_project(&self, id: &str, path: &str) -> Result<Project> {
        self.add_project_to(path, Some(id)).await
    }

    /// Detaches a project from a section. It must not leave live sessions
    /// behind in a workspace that no longer holds it, and a project no
    /// section holds is removed from moonlet, which needs its sessions
    /// archived first.
    pub fn section_remove_project(&self, id: &str, project_id: &str) -> Result<()> {
        let dropped = self.mutate(|st| {
            let wi = st.workspace_of_section(id).context("no such section")?;
            let ws = st.workspaces[wi].id.clone();
            let i = st
                .sections
                .iter()
                .position(|s| s.id == id)
                .context("no such section")?;
            if !st.sections[i].project_ids.iter().any(|p| p == project_id) {
                bail!("the project is not in this section");
            }
            let elsewhere = st
                .sections
                .iter()
                .any(|s| s.id != id && s.project_ids.iter().any(|p| p == project_id));
            if !elsewhere {
                st.drop_project(project_id)?;
                return Ok(true);
            }
            if !st.holds_project(&ws, project_id, Some(id)) && st.has_live_sessions(&ws, project_id) {
                bail!("archive this project's sessions in this workspace first");
            }
            st.sections[i].project_ids.retain(|p| p != project_id);
            st.ensure();
            Ok(false)
        })?;
        self.emit_sections();
        if dropped {
            self.emit_projects();
        }
        Ok(())
    }

    /// X41: projects saved before identities existed, or with a field that
    /// could not be read, get one. A repository that cannot be read keeps
    /// what it has, and the load goes on.
    pub async fn fill_identities(&self) {
        let projects: Vec<(String, String, bool)> = self
            .list_projects()
            .into_iter()
            .map(|p| (p.id, p.path, p.identity.root.is_none()))
            .collect();
        if projects.is_empty() {
            return;
        }
        // The origin is read again every time, as a repository's remote can
        // move; the root never changes, so it is read only while unknown.
        let mut found = Vec::new();
        for (id, path, no_root) in projects {
            let path = Path::new(&path);
            let origin = crate::identity::origin(path).await;
            let root = if no_root { crate::identity::root(path).await } else { None };
            found.push((id, origin, root));
        }
        let saved = self.mutate(|st| {
            for (id, origin, root) in found {
                if let Some(p) = st.projects.iter_mut().find(|p| p.id == id) {
                    // A folder that cannot be read keeps what was known.
                    if let Some(origin) = origin {
                        p.identity.origin = origin;
                    }
                    p.identity.root = root.or(p.identity.root.take());
                }
            }
            Ok(())
        });
        if let Err(e) = saved {
            tracing::warn!("cannot save project identities: {e:#}");
        }
    }

    pub async fn add_project(&self, path: &str) -> Result<Project> {
        self.add_project_to(path, None).await
    }

    /// A new project joins `section` in the same update, so the orphan sweep
    /// in `State::ensure` does not also file it under the first one.
    async fn add_project_to(&self, path: &str, section: Option<&str>) -> Result<Project> {
        let root = git::toplevel(&expand_home(path)).await?;
        let root_s = root.display().to_string();
        if let Some(r) = self.list_projects().into_iter().find(|r| r.path == root_s) {
            if let Some(id) = section {
                self.mutate(|st| {
                    let s = st.section_mut(id)?;
                    if !s.project_ids.contains(&r.id) {
                        s.project_ids.push(r.id.clone());
                    }
                    Ok(())
                })?;
                self.emit_sections();
            }
            return Ok(r);
        }
        let config = read_config(&root);
        let base = match config.base_branch {
            Some(b) => b,
            None => git::default_branch(&root).await,
        };
        let repo = Project {
            id: new_id(),
            name: root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| root_s.clone()),
            path: root_s,
            base_branch: base,
            identity: crate::identity::identity(&root).await,
        };
        let r = repo.clone();
        self.mutate(|st| {
            if let Some(id) = section {
                st.section_mut(id)?
                    .project_ids
                    .push(r.id.clone());
            }
            st.projects.push(r);
            st.ensure();
            Ok(())
        })?;
        self.emit_sections();
        self.emit_workspaces();
        self.emit_projects();
        Ok(repo)
    }

    pub fn remove_project(&self, id: &str) -> Result<()> {
        self.mutate(|st| st.drop_project(id))?;
        self.terminals.emit(Message::event(
            methods::EV_PROJECTS_CHANGED,
            self.list_projects(),
        ));
        Ok(())
    }

    pub fn project_config(&self, id: &str) -> Result<ProjectConfig> {
        Ok(read_config(Path::new(&self.project(id)?.path)))
    }

    /// The config file as the Project settings dialog edits it (X8).
    pub async fn project_config_file(&self, id: &str) -> Result<ProjectConfigFile> {
        let root = PathBuf::from(self.project(id)?.path);
        let default_branch = git::default_branch(&root).await;
        load_config_file(root, default_branch).await
    }

    /// Writes `.moonlet/config.toml` and keeps the project's base branch in
    /// step with it, then tells clients so they refetch the config.
    pub async fn set_project_config(
        &self,
        id: &str,
        version: &str,
        config: &ProjectConfig,
    ) -> Result<ProjectConfigFile> {
        let root = PathBuf::from(self.project(id)?.path);
        let (r, v, c) = (root.clone(), version.to_string(), config.clone());
        tokio::task::spawn_blocking(move || crate::project_config::save(&r, &v, &c)).await??;
        let default_branch = git::default_branch(&root).await;
        let file = load_config_file(root, default_branch.clone()).await?;
        let base = file.config.base_branch.clone().unwrap_or(default_branch);
        self.mutate(|st| {
            if let Some(p) = st.projects.iter_mut().find(|p| p.id == id) {
                p.base_branch = base;
            }
            Ok(())
        })?;
        self.terminals.emit(Message::event(
            methods::EV_PROJECTS_CHANGED,
            self.list_projects(),
        ));
        Ok(file)
    }

    fn agent_command(
        &self,
        repo: &Project,
        agent: &str,
        prompt: Option<&str>,
        resume: bool,
        session: Option<&Session>,
    ) -> String {
        let config = read_config(Path::new(&repo.path));
        let mut cmd = config
            .agents
            .get(agent)
            .cloned()
            .or_else(|| builtin_agent(agent, resume).map(String::from))
            .unwrap_or_else(|| agent.to_string());
        if let Some(s) = session {
            cmd.push_str(&agent_flags(&cmd, s));
        }
        if let Some(p) = prompt.filter(|p| !p.trim().is_empty())
            && !resume
        {
            cmd.push(' ');
            cmd.push_str(&shell_quote(p));
        }
        cmd
    }

    fn script_env(&self, ws: &Session, repo: &Project) -> BTreeMap<String, String> {
        let mut env = BTreeMap::from([
            ("MOONLET_ROOT_PATH".into(), repo.path.clone()),
            ("MOONLET_SESSION_PATH".into(), ws.path.clone()),
            ("MOONLET_SESSION_NAME".into(), ws.name.clone()),
            ("MOONLET_BRANCH".into(), ws.branch.clone()),
        ]);
        env.extend(self.session_env(&ws.id));
        env
    }

    /// The Claude profile folder of a session's workspace (X33); `None` for
    /// the default profile.
    pub fn config_dir(&self, session: &str) -> Option<String> {
        self.state.lock().unwrap().profile_of(session).map(|p| p.path.clone())
    }

    /// The Claude profile folder of workspace `ws`, when it has one (X33).
    pub fn workspace_config_dir(&self, ws: &str) -> Option<String> {
        self.state.lock().unwrap().profile_of_workspace(ws).map(|p| p.path.clone())
    }

    /// Variables every process of a session gets for its workspace's
    /// profile, looked up at each start (X33).
    pub fn session_env(&self, session: &str) -> BTreeMap<String, String> {
        self.session_launch(session).env
    }

    /// What a session's agents start with (X33): its profile's variables
    /// and name.
    pub fn session_launch(&self, session: &str) -> crate::chat::runtime::SessionLaunch {
        let st = self.state.lock().unwrap();
        let profile = match session.strip_prefix(crate::chat::runtime::WORKSPACE_KEY) {
            Some(ws) => st.profile_of_workspace(ws),
            None => st.profile_of(session),
        };
        match profile {
            Some(p) => crate::chat::runtime::SessionLaunch {
                env: BTreeMap::from([(crate::profiles::CONFIG_DIR_VAR.to_string(), p.path.clone())]),
                profile: Some(p.name.clone()),
            },
            None => crate::chat::runtime::SessionLaunch::default(),
        }
    }

    pub fn list_profiles(&self) -> Vec<ClaudeProfile> {
        self.state.lock().unwrap().profiles.clone()
    }

    pub fn profile(&self, id: &str) -> Result<ClaudeProfile> {
        self.state.lock().unwrap().profiles.iter().find(|p| p.id == id).cloned().context(NO_PROFILE)
    }

    /// Adds a profile (X33): its folder is `path`, or `~/.claude-<name>`.
    pub fn create_profile(&self, name: &str, path: Option<&str>) -> Result<ClaudeProfile> {
        let name = name.trim();
        if name.is_empty() {
            bail!("profile name is empty");
        }
        let home = dirs::home_dir().context("no home folder")?;
        let (taken, projects): (Vec<PathBuf>, Vec<PathBuf>) = {
            let st = self.state.lock().unwrap();
            (
                st.profiles.iter().map(|p| PathBuf::from(&p.path)).collect(),
                st.projects.iter().map(|p| PathBuf::from(&p.path)).collect(),
            )
        };
        let mut defaults = vec![home.join(".claude")];
        if let Some(d) = self.terminals.base_env().get(crate::profiles::CONFIG_DIR_VAR) {
            defaults.push(expand_home(d));
        }
        let rules = crate::profiles::FolderRules { home: &home, defaults, taken: &taken, projects: &projects, exists: &|p: &Path| p.exists(), canonical: &crate::profiles::canonical };
        let dir = crate::profiles::profile_folder(path, name, &rules)?;
        crate::profiles::ensure_folder(&dir)?;
        let profile = ClaudeProfile { id: new_id(), name: name.to_string(), path: dir.display().to_string(), created_at: now_ms() };
        let out = profile.clone();
        self.mutate(|st| {
            st.profiles.push(profile);
            Ok(())
        })?;
        Ok(out)
    }

    pub fn update_profile(&self, id: &str, name: Option<&str>) -> Result<ClaudeProfile> {
        let out = self.mutate(|st| {
            let p = st.profiles.iter_mut().find(|p| p.id == id).context(NO_PROFILE)?;
            if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
                p.name = n.to_string();
            }
            Ok(p.clone())
        })?;
        Ok(out)
    }

    /// Forgets a profile; its workspaces go back to the default. The folder
    /// and its login stay on disk.
    pub fn delete_profile(&self, id: &str) -> Result<()> {
        self.mutate(|st| {
            if !st.profiles.iter().any(|p| p.id == id) {
                bail!(NO_PROFILE);
            }
            st.profiles.retain(|p| p.id != id);
            for w in &mut st.workspaces {
                if w.claude_profile.as_deref() == Some(id) {
                    w.claude_profile = None;
                }
            }
            Ok(())
        })?;
        self.emit_workspaces();
        Ok(())
    }



    /// Takes in session `s`, which another member made and this member now
    /// owns (X73): its worktree is already here, at `s.path`. It keeps its id.
    pub fn adopt_session(&self, s: Session) -> Result<Session> {
        let id = s.id.clone();
        self.mutate(|st| {
            if st.sessions.iter().any(|o| o.id == s.id) {
                bail!("this host already has that session");
            }
            if !st.projects.iter().any(|p| p.id == s.project_id) {
                bail!("no such project");
            }
            st.sessions.push(Session { owner: None, terminals: vec![], restore: vec![], ..s });
            Ok(())
        })?;
        self.emit_sessions();
        self.session(&id)
    }

    /// Undoes [`Self::adopt_session`] when taking the session in failed
    /// before anything ran in it (X73): it leaves this member's state, and
    /// its worktree stays as it is.
    pub fn unadopt_session(&self, id: &str) -> Result<()> {
        self.mutate(|st| {
            st.sessions.retain(|o| o.id != id || !o.terminals.is_empty());
            Ok(())
        })?;
        self.emit_sessions();
        Ok(())
    }

    /// Lets go of session `id`, which the central host gave another member
    /// (X73): it leaves this member's state, its terminals end, and its
    /// worktree goes. Its record is the new owner's, so it is not touched.
    pub async fn let_go_session(&self, id: &str) -> Result<()> {
        let s = self.session(id)?;
        for t in &s.terminals {
            let _ = self.terminals.kill(*t, true);
            if let Some(chats) = self.chats.get() {
                chats.stop(*t, true);
            }
        }
        self.mutate(|st| {
            st.sessions.retain(|o| o.id != id);
            Ok(())
        })?;
        if let Ok(repo) = self.project(&s.project_id) {
            let _ = git::git(Path::new(&repo.path), &["worktree", "remove", "--force", &s.path]).await;
        }
        self.emit_sessions();
        Ok(())
    }

    /// A chat in session `ws` that goes on from `history`, another member's
    /// chat of it (X73), resuming the same conversation.
    pub fn continue_chat(&self, ws: &Session, mut history: moonlet_proto::types::ChatState) -> Result<TerminalInfo> {
        let chats = self.chat_runtime(Some("claude")).context("no structured chats")?;
        // Another member's word: a conversation id that is not one starts
        // a new conversation, and a mode that turns every check off, or
        // that this host does not know, is never taken from it; it is set
        // here, on this member.
        if !history.agent_session.as_deref().is_some_and(crate::transcript::is_uuid) {
            history.agent_session = None;
        }
        if history.mode.as_deref().is_some_and(|m| m == "bypassPermissions" || !crate::chat::PERMISSION_MODES.contains(&m)) {
            history.mode = None;
        }
        let repo = self.project(&ws.project_id)?;
        let info = chats.create_continuing(
            crate::chat::runtime::ChatCreate {
                cwd: ws.path.clone(),
                agent: "claude".into(),
                model: history.model.clone().or_else(|| ws.model.clone()),
                effort: history.effort.clone().or_else(|| ws.effort.clone()),
                mode: history.mode.clone().or_else(|| ws.mode.clone()).filter(|m| m != "bypassPermissions"),
                name: ws.name.clone(),
                title: Some("claude".into()),
                session_id: Some(ws.id.clone()),
                env: self
                    .script_env(ws, &repo)
                    .into_iter()
                    .filter(|(k, _)| k != crate::profiles::CONFIG_DIR_VAR)
                    .collect(),
                // Only folders inside the session's worktree here, that
                // are there, and not a link out of it: the member's word
                // gives nothing else.
                add_dirs: crate::chat::moved_dirs(&history.add_dirs, &ws.path, &ws.path)
                    .into_iter()
                    .filter(|d| {
                        let real = |p: &str| std::fs::canonicalize(p).ok();
                        Path::new(d).is_dir() && real(d).zip(real(&ws.path)).is_some_and(|(d, w)| d.starts_with(w))
                    })
                    .collect(),
                settings: None,
                workspace: None,
                design: None,
            },
            history,
        )?;
        self.mutate(|st| {
            if let Some(w) = st.sessions.iter_mut().find(|w| w.id == ws.id) {
                w.terminals.push(info.id);
            }
            Ok(())
        })?;
        self.emit_sessions();
        Ok(info)
    }

    /// Starts a session inside a workspace and remembers how to restart it.
    pub fn spawn_in(&self, ws: &Session, mut req: TerminalCreate) -> Result<TerminalInfo> {
        let repo = self.project(&ws.project_id)?;
        // "New agent tab": an agent session without a command runs that agent.
        if req.kind == TerminalKind::Agent
            && req.command.is_empty()
            && !req.chat
            && let Some(agent) = req.agent.clone()
        {
            // An explicit mode wins over the one the session was created with.
            let mut with_mode = ws.clone();
            if req.mode.is_some() {
                with_mode.mode = req.mode.clone();
            }
            let base = self.agent_session(&with_mode, &repo, &agent, None, false, req.cols, req.rows);
            req.command = base.command;
            req.title.get_or_insert(agent);
        }
        req.session_id = Some(ws.id.clone());
        if req.cwd.is_empty() {
            req.cwd = ws.path.clone();
        }
        for (k, v) in self.script_env(ws, &repo) {
            req.env.entry(k).or_insert(v);
        }
        let chats = if req.chat { self.chat_runtime(req.agent.as_deref()) } else { None };
        let info = match chats {
            Some(chats) => chats.create(crate::chat::runtime::ChatCreate {
                cwd: req.cwd.clone(),
                agent: req.agent.clone().unwrap_or_default(),
                model: req.model.clone().or_else(|| ws.model.clone()),
                effort: req.effort.clone().or_else(|| ws.effort.clone()),
                mode: req.mode.clone().or_else(|| ws.mode.clone()),
                name: ws.name.clone(),
                title: req.title.clone(),
                session_id: Some(ws.id.clone()),
                // The profile is looked up at each start instead (X33).
                env: req.env.iter().filter(|(k, _)| *k != crate::profiles::CONFIG_DIR_VAR).map(|(k, v)| (k.clone(), v.clone())).collect(),
                add_dirs: req.add_dirs.clone(),
                settings: None,
                workspace: None,
                design: None,
            })?,
            None => self.terminals.create(req.clone())?,
        };
        // Chats persist and restore themselves; they need no restore entry.
        if matches!(info.kind, TerminalKind::Agent | TerminalKind::Shell) && !info.chat {
            let entry = RestoreEntry {
                kind: info.kind,
                title: info.title.clone(),
                cwd: info.cwd.clone(),
                command: info.command.clone(),
                agent: info.agent.clone(),
                terminal: Some(info.id),
                config_dir: self.config_dir(&ws.id),
            };
            self.mutate(|st| {
                if let Some(w) = st.sessions.iter_mut().find(|w| w.id == ws.id) {
                    w.terminals.push(info.id);
                    w.restore.push(entry);
                }
                Ok(())
            })?;
        } else {
            self.mutate(|st| {
                if let Some(w) = st.sessions.iter_mut().find(|w| w.id == ws.id) {
                    w.terminals.push(info.id);
                }
                Ok(())
            })?;
        }
        self.emit_sessions();
        Ok(info)
    }

    #[allow(clippy::too_many_arguments)]
    fn agent_session(
        &self,
        ws: &Session,
        repo: &Project,
        agent: &str,
        prompt: Option<&str>,
        resume: bool,
        cols: u16,
        rows: u16,
    ) -> TerminalCreate {
        let cmd = with_profile(&self.agent_command(repo, agent, prompt, resume, Some(ws)), self.config_dir(&ws.id).as_deref());
        TerminalCreate {
            cwd: ws.path.clone(),
            command: vec![user_shell(), "-lic".into(), cmd],
            cols,
            rows,
            kind: TerminalKind::Agent,
            title: Some(agent.to_string()),
            agent: Some(agent.to_string()),
            ..Default::default()
        }
    }

    /// The workspace a new session of `project` goes into (X32): the one
    /// asked for, which must hold the project; else the spawning agent's,
    /// when it holds the project; else the first that does.
    fn session_workspace(&self, project: &str, asked: Option<&str>, parent: Option<&str>) -> Result<String> {
        let st = self.state.lock().unwrap();
        if let Some(ws) = asked {
            if !st.workspaces.iter().any(|w| w.id == ws) {
                bail!("no such workspace");
            }
            if !st.holds_project(ws, project, None) {
                bail!("the project is not in this workspace");
            }
            return Ok(ws.to_string());
        }
        if let Some(ws) = parent.filter(|ws| st.holds_project(ws, project, None)) {
            return Ok(ws.to_string());
        }
        Ok(st.first_holding(project).unwrap_or_else(|| st.workspaces[0].id.clone()))
    }

    /// The project's linked work trees, including the sessions' own (X45).
    pub async fn project_worktrees(&self, id: &str) -> Result<Vec<moonlet_proto::types::Worktree>> {
        let project = self.project(id)?;
        git::worktrees(Path::new(&project.path)).await
    }

    /// A linked work tree of the repo that no session uses.
    async fn free_worktree(&self, repo: &Path, dir: &str) -> Result<moonlet_proto::types::Worktree> {
        // Paths compare by where they lead: `/var/…` and `/private/var/…`
        // are the same worktree on macOS.
        let real = |p: &str| std::fs::canonicalize(p).ok();
        let not_ours = || format!("{dir} is not a worktree of this project");
        let want = real(dir).with_context(not_ours)?;
        let found = git::worktrees(repo)
            .await?
            .into_iter()
            .find(|w| real(&w.path).as_ref() == Some(&want))
            .with_context(not_ours)?;
        if let Some(s) = self
            .list_sessions()
            .into_iter()
            .find(|s| !s.archived && real(&s.path).as_ref() == Some(&want))
        {
            anyhow::bail!("{dir} is used by session {}", s.name);
        }
        Ok(found)
    }

    /// A free work tree of the repo, with its branch (X46: start a session on
    /// a worktree made outside moonlet).
    async fn adoptable_worktree(&self, repo: &Path, dir: &str) -> Result<(PathBuf, String)> {
        let found = self.free_worktree(repo, dir).await?;
        let branch = found.branch.with_context(|| format!("{dir} is on a detached HEAD"))?;
        Ok((PathBuf::from(found.path), branch))
    }

    /// Removes a free work tree of the project, uncommitted changes and all;
    /// the app asks first (X45 Clean up). Its branch is kept.
    pub async fn remove_worktree(&self, id: &str, dir: &str) -> Result<()> {
        let project = self.project(id)?;
        let repo = Path::new(&project.path);
        let found = self.free_worktree(repo, dir).await?;
        git::worktree_remove(repo, Path::new(&found.path)).await
    }

    pub async fn create_session(&self, req: SessionCreate) -> Result<Session> {
        self.create_session_prepared(req, |_| async { Ok(()) }, |_| async {})
            .await
    }

    /// [`Self::create_session`], with `prepare` run on the new session
    /// once its worktree is there and before anything starts in it, such
    /// as the design a session builds copied into it (X65). When `prepare`
    /// fails or the session cannot be saved, the session is not made: a
    /// worktree and branch made for it are removed again, and a worktree it
    /// adopted is left to its owner. So too when this request is dropped
    /// before the session is saved: `prepare` runs on to its end on a task
    /// of its own, and only then are they removed, so nothing it writes
    /// lands in the worktree after. `on_saved` runs, to its end on a task of
    /// its own, once the session is saved and before anything starts in it,
    /// so what it records (the session a design is built in) holds even when
    /// its terminals then fail to start; never for a session not saved.
    pub async fn create_session_prepared<F, G>(
        &self,
        req: SessionCreate,
        prepare: impl FnOnce(Session) -> F,
        on_saved: impl FnOnce(Session) -> G,
    ) -> Result<Session>
    where
        F: std::future::Future<Output = Result<()>> + Send + 'static,
        G: std::future::Future<Output = ()> + Send + 'static,
    {
        let mut req = req;
        crate::chat::check_mode(req.mode.as_deref())?;
        // Directories widen what the agent may write (X29): only the user
        // picks them, never an agent opening a session (X22).
        if req.spawned_by.is_some() && !req.add_dirs.is_empty() {
            anyhow::bail!("a session another agent starts cannot add directories");
        }
        let repo = self.project(&req.project_id)?;
        let repo_path = PathBuf::from(&repo.path);
        let name = derive_name(req.name.as_deref(), req.prompt.as_deref());
        if let Some(pr) = req.pr {
            // Work on the pull request's own branch.
            let head = git::pr_head_branch(&repo_path, pr).await?;
            req.branch = Some(head);
            req.existing_branch = true;
        }
        // The agent asking for this session, if any (X22).
        let parent = match req.spawned_by {
            Some(t) => Some(
                self.terminals
                    .list()
                    .into_iter()
                    .find(|i| i.id == t)
                    .with_context(|| format!("no terminal {t}"))?,
            ),
            None => None,
        };
        // What the parent runs with now, as (mode, model, effort): its chat's
        // settings for a structured agent, otherwise its session's. The
        // session's model and effort belong to the session's agent, not to
        // another agent's tab in it.
        let parent_run = parent.as_ref().map(|p| {
            if p.chat {
                let s = self.chats.get().and_then(|c| c.state(p.id).ok());
                s.map_or((None, None, None), |s| (s.mode, s.model, s.effort))
            } else {
                let s = p.session_id.as_deref().and_then(|id| self.session(id).ok());
                s.map_or((None, None, None), |s| {
                    if p.agent == s.agent { (s.mode, s.model, s.effort) } else { (s.mode, None, None) }
                })
            }
        });
        if let Some((parent_mode, _, _)) = &parent_run {
            req.mode = Some(crate::chat::spawned_mode(req.mode.as_deref(), parent_mode.as_deref())?);
        }
        let parent_ws = parent
            .as_ref()
            .and_then(|p| p.session_id.as_deref())
            .and_then(|id| self.session(id).ok())
            .and_then(|s| s.workspace_id);
        let workspace_id = self.session_workspace(&repo.id, req.workspace_id.as_deref(), parent_ws.as_deref())?;
        let slug = git::slug(&name);
        let adopted = match req.worktree.as_deref() {
            Some(dir) => Some(self.adoptable_worktree(&repo_path, dir).await?),
            None => None,
        };
        let existing_branches = git::branches(&repo_path).await.unwrap_or_default();
        let config = read_config(&repo_path);
        let settings = git_settings::load(&self.file.with_file_name("git.toml"));
        let branch = if let Some((_, branch)) = &adopted {
            branch.clone()
        } else if req.existing_branch {
            let b = req
                .branch
                .clone()
                .context("existing_branch needs a branch name")?;
            b.strip_prefix("origin/").map(String::from).unwrap_or(b)
        } else {
            let prefix = config
                .branch_prefix
                .as_deref()
                .unwrap_or(&settings.branch_prefix);
            let wanted = req
                .branch
                .clone()
                .unwrap_or_else(|| format!("{prefix}{slug}"));
            unique(&wanted, |b| existing_branches.iter().any(|e| e == b))
        };
        let from = match req.from.clone() {
            Some(from) => from,
            None if settings.start_from == StartFrom::Origin
                && !req.existing_branch
                && adopted.is_none() =>
            {
                match git::fetch_branch(&repo_path, &repo.base_branch).await {
                    Ok(()) => format!("origin/{}", repo.base_branch),
                    Err(e) => {
                        tracing::warn!("cannot fetch {}, starting from the local branch: {e:#}", repo.base_branch);
                        repo.base_branch.clone()
                    }
                }
            }
            None => repo.base_branch.clone(),
        };
        let dir = if let Some((dir, _)) = &adopted {
            dir.clone()
        } else {
            let base = self.worktrees_root.join(&repo.name);
            let name = unique(&slug, |n| base.join(n).exists());
            let dir = base.join(name);
            git::worktree_add(&repo_path, &dir, &branch, &from, req.existing_branch).await?;
            // The path as `git worktree list` prints it (no /var → /private/var
            // symlink), so the session's worktree is recognised as its own (X45).
            std::fs::canonicalize(&dir).unwrap_or(dir)
        };

        // Absent means "the repo default"; "none" (or empty) means a plain shell.
        let agent = match req.agent.as_deref() {
            // An agent asking for a session wants an agent in it (X22): the
            // repo default, else the parent's own structured agent, else
            // Claude, as in the composer. A parent's custom agent may not
            // exist in this repo.
            None if parent.is_some() => Some(
                config
                    .default_agent
                    .clone()
                    .or_else(|| parent.as_ref().and_then(|p| p.agent.clone()).filter(|a| crate::chat::supports(a)))
                    .unwrap_or_else(|| "claude".into()),
            ),
            None => config.default_agent.clone(),
            Some("") | Some("none") => None,
            Some(a) => Some(a.to_string()),
        };
        // The same agent as the parent's runs its model and effort unless
        // asked otherwise; another agent's model would mean nothing to it.
        if let (Some(p), Some((_, model, effort))) = (&parent, parent_run)
            && agent.is_some()
            && agent == p.agent
        {
            req.model = req.model.filter(|m| !m.is_empty()).or(model);
            req.effort = req.effort.filter(|e| !e.is_empty()).or(effort);
        }
        let ws = Session {
            id: new_id(),
            project_id: repo.id.clone(),
            name,
            branch,
            base: if req.existing_branch || adopted.is_some() {
                repo.base_branch.clone()
            } else {
                from.trim_start_matches("origin/").to_string()
            },
            path: dir.display().to_string(),
            agent: agent.clone(),
            archived: false,
            created_at: now_ms(),
            workspace_id: Some(workspace_id),
            model: req.model.clone().filter(|m| !m.is_empty()),
            effort: req.effort.clone().filter(|e| !e.is_empty()),
            mode: req.mode.clone(),
            // A session opened from a PR is that PR's session.
            pr: req.pr,
            spawned_by: parent.as_ref().and_then(|p| p.session_id.clone()),
            task: req.task.clone(),
            task_unlinked: false,
            cloud: req.cloud,
            terminals: vec![],
            layout: serde_json::Value::Null,
            restore: vec![],
            owner: None,
        };
        // Until the session is saved, what was made for it goes again,
        // however this request ends.
        let mut unmade = Unmade {
            repo: repo_path.clone(),
            dir: adopted.is_none().then(|| dir.clone()),
            branch: (adopted.is_none() && !req.existing_branch).then(|| ws.branch.clone()),
            preparing: None,
        };
        let prepared = unmade
            .preparing
            .insert(tokio::spawn(prepare(ws.clone())))
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("preparing the session failed: {e}")));
        unmade.preparing = None;
        let w = ws.clone();
        let saved = prepared.and_then(|()| {
            self.mutate(|st| {
                st.sessions.push(w);
                Ok(())
            })
        });
        if let Err(e) = saved {
            unmade.remove().await;
            return Err(e);
        }
        unmade.keep();
        let _ = tokio::spawn(on_saved(ws.clone())).await;
        // It shows once saved: archived or removed meanwhile, its terminals
        // never start, its worktree maybe gone (X65). An archive under way
        // ends first; one asked for now waits until they have started.
        let lifecycle = self.lifecycle(&ws.id);
        let _starting = lifecycle.lock().await;
        match self.session(&ws.id) {
            Ok(now) if !now.archived => {}
            Ok(_) => bail!("the session was archived before its terminals started"),
            Err(_) => bail!("the session was removed before its terminals started"),
        }

        if let Some(agent) = &agent
            && !req.tui
            && self.chat_runtime(Some(agent)).is_some()
        {
            let info = self.spawn_in(
                &ws,
                TerminalCreate {
                    kind: TerminalKind::Agent,
                    title: Some(agent.clone()),
                    agent: Some(agent.clone()),
                    chat: true,
                    cols: req.cols,
                    rows: req.rows,
                    add_dirs: req.add_dirs.clone(),
                    ..Default::default()
                },
            )?;
            if let Some(p) = req.prompt.as_deref().filter(|p| !p.trim().is_empty())
                && let Some(chats) = self.chats.get()
                && let Err(e) = chats.send(info.id, p, &[])
            {
                // The session exists and the chat shows the error; creating
                // it again would only add a second worktree.
                tracing::warn!(session = %ws.id, "first message not delivered: {e:#}");
            }
        } else if let Some(agent) = &agent {
            self.spawn_in(
                &ws,
                self.agent_session(
                    &ws,
                    &repo,
                    agent,
                    req.prompt.as_deref(),
                    false,
                    req.cols,
                    req.rows,
                ),
            )?;
        } else {
            self.spawn_in(
                &ws,
                TerminalCreate {
                    cols: req.cols,
                    rows: req.rows,
                    ..Default::default()
                },
            )?;
        }
        // After the agent: the app opens a new session on its first
        // terminal, and that should be the agent, not setup.
        if let Some(setup) = config.setup.filter(|s| !s.trim().is_empty()) {
            self.spawn_in(
                &ws,
                TerminalCreate {
                    command: vec![user_shell(), "-lic".into(), setup],
                    kind: TerminalKind::Setup,
                    title: Some("setup".into()),
                    cols: req.cols,
                    rows: req.rows,
                    ..Default::default()
                },
            )?;
        }
        self.session(&ws.id)
    }

    pub async fn run_script(
        &self,
        id: &str,
        script: &str,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalInfo> {
        let ws = self.session(id)?;
        let config = read_config(Path::new(&self.project(&ws.project_id)?.path));
        let (cmd, kind) = match script {
            "run" => (config.run, TerminalKind::Run),
            "setup" => (config.setup, TerminalKind::Setup),
            "archive" => (config.archive, TerminalKind::Run),
            other => bail!("unknown script {other}"),
        };
        let cmd = cmd
            .filter(|c| !c.trim().is_empty())
            .with_context(|| format!("no `{script}` script in .moonlet/config.toml"))?;
        // Restart instead of piling up run panes.
        for s in self.terminals.list() {
            if s.session_id.as_deref() == Some(id) && s.kind == kind && s.title == script {
                let _ = self.terminals.kill(s.id, true);
            }
        }
        self.spawn_in(
            &ws,
            TerminalCreate {
                command: vec![user_shell(), "-lic".into(), cmd],
                kind,
                title: Some(script.into()),
                cols,
                rows,
                ..Default::default()
            },
        )
    }

    pub async fn archive(&self, req: SessionArchive) -> Result<SessionArchived> {
        // Never while a new session's terminals start (X65).
        let lifecycle = self.lifecycle(&req.id);
        let _archiving = lifecycle.lock().await;
        let ws = self.session(&req.id)?;
        let repo = self.project(&ws.project_id)?;
        let config = read_config(Path::new(&repo.path));
        if let Some(script) = config.archive.filter(|s| !s.trim().is_empty())
            && Path::new(&ws.path).exists()
        {
            let mut cmd = tokio::process::Command::new(user_shell());
            cmd.args(["-lc", &script])
                .current_dir(&ws.path)
                .envs(self.script_env(&ws, &repo))
                .kill_on_drop(true);
            let _ = tokio::time::timeout(std::time::Duration::from_secs(60), cmd.status()).await;
        }
        for s in self.terminals.list() {
            if s.session_id.as_deref() == Some(ws.id.as_str()) {
                let _ = self.terminals.kill(s.id, true);
            }
        }
        if req.remove_worktree {
            git::worktree_remove(Path::new(&repo.path), Path::new(&ws.path)).await?;
        }
        let mut done = SessionArchived::default();
        // The project's base branch is never deleted (X55), whoever asks.
        if req.delete_branch && ws.branch != repo.base_branch {
            git::delete_branch(Path::new(&repo.path), &ws.branch).await?;
            if req.delete_remote
                && let Err(e) = git::delete_remote_branch(Path::new(&repo.path), &ws.branch).await
            {
                done.remote_error = Some(format!("{e:#}"));
            }
        }
        self.mutate(|st| {
            if let Some(w) = st.sessions.iter_mut().find(|w| w.id == ws.id) {
                w.archived = true;
                w.terminals.clear();
                w.restore.clear();
            }
            Ok(())
        })?;
        self.emit_sessions();
        Ok(done)
    }

    /// The lock a session's terminals starting and its archive share (X65):
    /// one per session, made the first time either asks for it.
    fn lifecycle(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.lifecycles.lock().unwrap().entry(id.to_string()).or_default().clone()
    }

    /// Brings an archived workspace back (recreating the worktree if needed).
    pub async fn unarchive(&self, id: &str) -> Result<Session> {
        let ws = self.session(id)?;
        let repo = self.project(&ws.project_id)?;
        if !Path::new(&ws.path).exists() {
            git::worktree_add(
                Path::new(&repo.path),
                Path::new(&ws.path),
                &ws.branch,
                &ws.base,
                true,
            )
            .await?;
        }
        self.mutate(|st| {
            if let Some(w) = st.sessions.iter_mut().find(|w| w.id == id) {
                w.archived = false;
            }
            Ok(())
        })?;
        let ws = self.session(id)?;
        self.spawn_in(&ws, TerminalCreate::default())?;
        self.session(id)
    }

    pub fn update(&self, req: SessionUpdate) -> Result<Session> {
        self.mutate(|st| {
            let w = st
                .sessions
                .iter_mut()
                .find(|w| w.id == req.id)
                .context("no such session")?;
            if let Some(n) = req
                .name
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
            {
                w.name = n;
            }
            if let Some(l) = req.layout {
                w.layout = l;
            }
            if let Some(task) = req.task {
                w.task_unlinked = task.is_none();
                w.task = task;
            }
            Ok(())
        })?;
        self.emit_sessions();
        self.session(&req.id)
    }

    /// Records PR `number` as the pull request of the session at `path`, if
    /// a session lives there.
    pub fn set_pr(&self, path: &Path, number: u64) -> Result<()> {
        let changed = self.mutate(|st| {
            Ok(match st.sessions.iter_mut().find(|w| live_at(w, path)) {
                Some(w) if w.pr != Some(number) => {
                    w.pr = Some(number);
                    true
                }
                _ => false,
            })
        })?;
        if changed {
            self.emit_sessions();
        }
        Ok(())
    }

    /// The pull request of the session at `path`. Once known it is read by
    /// number; until then (or after it was closed unmerged) it is looked for
    /// among the PRs heading the session's branch, and remembered. A path no
    /// session owns gets its branch's PR.
    pub async fn pr_status(&self, path: &Path) -> Result<Option<PullRequest>> {
        let Some(s) = self.session_at(path) else {
            return git::pr_status(path).await;
        };
        let known = match s.pr {
            Some(n) => git::pr_view(path, Some(n)).await?,
            None => None,
        };
        if known.as_ref().is_some_and(|pr| pr.state != "closed") {
            return Ok(known);
        }
        let branch = git::current_branch(path).await.unwrap_or(s.branch);
        let list = match git::pr_list_head(path, &branch).await {
            Ok(list) => list,
            // Still show the closed PR when the search fails.
            Err(_) if known.is_some() => return Ok(known),
            Err(e) => return Err(e),
        };
        match git::session_pr(&list, s.created_at, s.pr.unwrap_or(0)) {
            Some(pr) => {
                self.set_pr(path, pr.number)?;
                Ok(Some(pr))
            }
            None => Ok(known),
        }
    }

    fn session_at(&self, path: &Path) -> Option<Session> {
        let st = self.state.lock().unwrap();
        st.sessions.iter().find(|w| live_at(w, path)).cloned()
    }

    /// After a daemon restart, terminals are gone: restart each workspace's
    /// agents (resuming where the agent supports it) and shells (S4).
    /// Re-links live terminals to the sessions that list them.
    pub fn relink_terminals(&self) {
        let st = self.state.lock().unwrap();
        for s in &st.sessions {
            for id in &s.terminals {
                self.terminals.link_session(*id, &s.id);
            }
        }
    }

    pub fn restore_after_restart(&self) -> usize {
        let live: std::collections::HashSet<TerminalId> =
            self.terminals.list().into_iter().map(|s| s.id).collect();
        let pending: Vec<Session> = self
            .state
            .lock()
            .unwrap()
            .sessions
            .iter()
            .filter(|w| !w.archived && Path::new(&w.path).is_dir())
            .cloned()
            .collect();
        let mut restored = 0;
        for ws in pending {
            let Ok(repo) = self.project(&ws.project_id) else {
                continue;
            };
            let dead: Vec<RestoreEntry> = ws
                .restore
                .iter()
                .filter(|e| e.terminal.is_none_or(|id| !live.contains(&id)))
                .cloned()
                .collect();
            if dead.is_empty() {
                continue;
            }
            let _ = self.mutate(|st| {
                if let Some(w) = st.sessions.iter_mut().find(|w| w.id == ws.id) {
                    w.restore
                        .retain(|e| e.terminal.is_some_and(|id| live.contains(&id)));
                    w.terminals.retain(|id| live.contains(id));
                }
                Ok(())
            });
            for entry in dead {
                let known = |a: &str| {
                    builtin_agent(a, true).is_some()
                        || read_config(Path::new(&repo.path)).agents.contains_key(a)
                };
                let req = match (&entry.kind, &entry.agent) {
                    (TerminalKind::Agent, Some(agent)) if known(agent) => {
                        // A Claude conversation is in the profile it ran in
                        // (X33); other agents keep their history elsewhere.
                        let resume = agent != "claude" || entry.config_dir == self.config_dir(&ws.id);
                        let mut r = self.agent_session(&ws, &repo, agent, None, resume, 120, 32);
                        r.title = Some(entry.title.clone());
                        r
                    }
                    _ => TerminalCreate {
                        cwd: entry.cwd.clone(),
                        command: match entry.command.as_slice() {
                            // An agent tab run through the login shell: its
                            // export names the profile it started with.
                            [shell, flag, cmd] if flag == "-lic" => vec![shell.clone(), flag.clone(), with_profile(cmd, self.config_dir(&ws.id).as_deref())],
                            other => other.to_vec(),
                        },
                        title: Some(entry.title.clone()),
                        kind: entry.kind,
                        agent: entry.agent.clone(),
                        ..Default::default()
                    },
                };
                match self.spawn_in(&ws, req) {
                    Ok(_) => restored += 1,
                    Err(e) => tracing::warn!(workspace = %ws.id, "restore failed: {e:#}"),
                }
            }
        }
        restored
    }

    /// `removed`: the tab was closed. Otherwise the process exited while the
    /// daemon ran, so there is nothing to bring back after a restart.
    fn forget_session(&self, id: TerminalId, removed: bool) {
        let changed = self
            .mutate(|st| {
                let mut changed = false;
                for w in &mut st.sessions {
                    let before = (w.terminals.len(), w.restore.len());
                    if removed {
                        w.terminals.retain(|s| *s != id);
                    }
                    w.restore.retain(|e| e.terminal != Some(id));
                    changed |= before != (w.terminals.len(), w.restore.len());
                }
                Ok(changed)
            })
            .unwrap_or(false);
        if changed {
            self.emit_sessions();
        }
    }
}

/// Closed tabs and processes that exited on their own are not restored.
async fn track_removed_sessions(mgr: std::sync::Weak<SessionManager>) {
    let Some(m) = mgr.upgrade() else { return };
    let mut rx = m.terminals.subscribe_events();
    drop(m);
    loop {
        match rx.recv().await {
            Ok(Message::Event { name, data })
                if name == methods::EV_TERMINAL_REMOVED || name == methods::EV_TERMINAL_EXITED =>
            {
                let Some(m) = mgr.upgrade() else { return };
                if let Some(id) = data.get("id").and_then(serde_json::Value::as_u64) {
                    m.forget_session(id as TerminalId, name == methods::EV_TERMINAL_REMOVED);
                }
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
            Err(_) => return,
        }
    }
}

fn unique(base: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(base) {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|c| !taken(c))
        .unwrap()
}

/// `project_config::load` off the async runtime: it reads the disk.
async fn load_config_file(root: PathBuf, default_branch: String) -> Result<ProjectConfigFile> {
    Ok(tokio::task::spawn_blocking(move || crate::project_config::load(&root, default_branch)).await?)
}

/// Reads the project's config file ([`crate::project_config::path`]);
/// missing or invalid files give defaults.
pub fn read_config(repo: &Path) -> ProjectConfig {
    let path = crate::project_config::path(repo);
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let mut config: ProjectConfig = toml::from_str(&text).unwrap_or_else(|e| {
                tracing::warn!("{}: {e}", path.display());
                ProjectConfig::default()
            });
            // A blank command would start an empty shell instead of the agent.
            config.agents.retain(|name, cmd| {
                let keep = !cmd.trim().is_empty();
                if !keep {
                    tracing::warn!("{}: agent `{name}` has an empty command", path.display());
                }
                keep
            });
            config
        }
        Err(_) => ProjectConfig::default(),
    }
}

/// The worktree and branch made for a session that is not saved yet
/// (X65): removed again unless [`Unmade::keep`] is called, on a drop too,
/// then once `preparing`, the session's preparing still running, is done.
struct Unmade {
    repo: PathBuf,
    dir: Option<PathBuf>,
    branch: Option<String>,
    preparing: Option<tokio::task::JoinHandle<Result<()>>>,
}

impl Unmade {
    /// The session is saved: its worktree and branch are its own.
    fn keep(mut self) {
        self.dir = None;
        self.branch = None;
    }

    /// Removes them now, on a task of their own that owns them to its end:
    /// this request dropped meanwhile leaves that removal running.
    async fn remove(mut self) {
        let (repo, dir, branch) = (self.repo.clone(), self.dir.take(), self.branch.take());
        let removing = tokio::spawn(async move { remove_unmade(&repo, dir, branch).await });
        let _ = removing.await;
    }
}

impl Drop for Unmade {
    fn drop(&mut self) {
        let (dir, branch) = (self.dir.take(), self.branch.take());
        if dir.is_none() && branch.is_none() {
            return;
        }
        let (repo, preparing) = (self.repo.clone(), self.preparing.take());
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                rt.spawn(async move {
                    if let Some(preparing) = preparing {
                        let _ = preparing.await;
                    }
                    remove_unmade(&repo, dir, branch).await;
                });
            }
            Err(_) => tracing::warn!(
                "cannot remove the worktree {dir:?} and branch {branch:?} of a session not made"
            ),
        }
    }
}

/// A test's hold on the removal of a session not made in a repository:
/// told when it starts, it waits until let go.
#[cfg(test)]
type RemoveHold = (
    PathBuf,
    tokio::sync::oneshot::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
);

#[cfg(test)]
static BEFORE_REMOVE: std::sync::Mutex<Vec<RemoveHold>> = std::sync::Mutex::new(Vec::new());

/// Holds the removal of a session not made in `repo` while a test asks,
/// so it can be cancelled midway deterministically; nothing outside tests.
async fn before_remove(repo: &Path) {
    #[cfg(test)]
    {
        let hold = {
            let mut holds = BEFORE_REMOVE.lock().unwrap();
            let at = holds.iter().position(|(r, ..)| r == repo);
            at.map(|i| holds.remove(i))
        };
        if let Some((_, started, release)) = hold {
            let _ = started.send(());
            let _ = release.await;
        }
    }
    #[cfg(not(test))]
    let _ = repo;
}

/// Removes the worktree `dir` and the branch `branch` of a session not
/// made, logging what it cannot.
async fn remove_unmade(repo: &Path, dir: Option<PathBuf>, branch: Option<String>) {
    before_remove(repo).await;
    if let Some(dir) = dir
        && let Err(gone) = git::worktree_remove(repo, &dir).await
    {
        tracing::warn!(
            "cannot remove the worktree {} of a session not made: {gone:#}",
            dir.display()
        );
    }
    if let Some(branch) = branch
        && let Err(gone) = git::delete_branch(repo, &branch).await
    {
        tracing::warn!("cannot delete the branch {branch} of a session not made: {gone:#}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_workspace_merged_ten_times_over_still_ends_in_the_last() {
        let home = tempfile::tempdir().unwrap();
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let terminals = TerminalManager::new(home.path().join("s.sock"), env);
        let mgr = SessionManager::load(home.path().join("state.json"), home.path().join("worktrees"), terminals);
        let ids: Vec<String> = (0..11)
            .map(|n| mgr.create_workspace(moonlet_proto::methods::WorkspaceCreate { name: format!("W{n}"), color: moonlet_proto::types::WorkspaceColor::Blue, move_sections: vec![], claude_profile: None }).unwrap().id)
            .collect();
        for pair in ids.windows(2) {
            mgr.merge_workspace(&pair[0], &pair[1]).unwrap();
        }
        let mut merged = mgr.merged_workspaces();
        merged.sort();
        let mut want: Vec<(String, String)> = ids[..10].iter().map(|id| (id.clone(), ids[10].clone())).collect();
        want.sort();
        assert_eq!(merged, want);
    }
    use std::time::Duration;

    #[test]
    fn an_id_is_twelve_hex_digits_so_a_workspace_id_never_starts_with_s_dash() {
        // The app's moonlet-design:// scheme reads a host label `s-<id>` as
        // a session's (design_scheme.rs, X65).
        for _ in 0..1000 {
            let id = new_id();
            assert_eq!(id.len(), 12, "{id}");
            assert!(id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{id}");
            assert!(!id.starts_with("s-"), "{id}");
        }
    }

    async fn setup() -> (tempfile::TempDir, tempfile::TempDir, Arc<SessionManager>) {
        let repo = crate::git::tests::repo().await;
        std::fs::create_dir(repo.path().join(".moonlet")).unwrap();
        std::fs::write(
            repo.path().join(".moonlet/config.toml"),
            "setup = \"echo setting-up\"\nrun = \"echo running\"\ndefault_agent = \"fake\"\n[agents]\nfake = \"sh -c 'echo agent:$MOONLET_SESSION_NAME; sleep 30'\"\n",
        )
        .unwrap();
        crate::git::git(repo.path(), &["add", "-A"]).await.unwrap();
        crate::git::git(repo.path(), &["commit", "-qm", "config"])
            .await
            .unwrap();
        let home = tempfile::tempdir().unwrap();
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let terminals = TerminalManager::new(home.path().join("s.sock"), env);
        let mgr = SessionManager::load(
            home.path().join("state.json"),
            home.path().join("worktrees"),
            terminals,
        );
        (repo, home, mgr)
    }

    #[tokio::test]
    async fn saving_base_branch_updates_the_project() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let default = r.base_branch.clone();
        let file = mgr.project_config_file(&r.id).await.unwrap();
        assert_eq!(file.default_branch, default);
        let mut config = file.config.clone();
        config.base_branch = Some("develop".into());
        let file = mgr.set_project_config(&r.id, &file.version, &config).await.unwrap();
        assert_eq!(file.config.base_branch.as_deref(), Some("develop"));
        assert_eq!(mgr.project(&r.id).unwrap().base_branch, "develop");
        // The rest of the file is kept.
        assert_eq!(mgr.project_config(&r.id).unwrap().agents.len(), 1);
        config.base_branch = None;
        mgr.set_project_config(&r.id, &file.version, &config).await.unwrap();
        assert_eq!(mgr.project(&r.id).unwrap().base_branch, default);
    }

    #[tokio::test]
    async fn a_session_whose_making_is_cancelled_leaves_no_worktree_or_branch_once_its_preparing_is_done()
     {
        use std::sync::atomic::{AtomicBool, Ordering};
        let (repo, _home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let req = SessionCreate {
            project_id: r.id.clone(),
            name: Some("Built".into()),
            branch: None,
            from: None,
            existing_branch: false,
            agent: Some("none".into()),
            prompt: None,
            cols: 80,
            rows: 24,
            model: None,
            effort: None,
            mode: None,
            pr: None,
            tui: false,
            cloud: false,
            spawned_by: None,
            add_dirs: vec![],
            workspace_id: None,
            task: None,
            worktree: None,
            design: None,
        };
        let (started, made) = tokio::sync::oneshot::channel::<Session>();
        let copied = Arc::new(AtomicBool::new(false));
        let done = copied.clone();
        // A copy into the new worktree on a blocking thread, as Build it's,
        // still writing when the request is dropped.
        let prepare = move |s: Session| async move {
            let _ = started.send(s.clone());
            tokio::task::spawn_blocking(move || {
                std::thread::sleep(Duration::from_millis(300));
                let dir = Path::new(&s.path).join("docs/design/built");
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(dir.join("design.toml"), "name = \"Built\"\n").unwrap();
                done.store(true, Ordering::SeqCst);
            })
            .await?;
            Ok(())
        };
        let making = mgr.create_session_prepared(req, prepare, |_| async {});
        // Dropped once its preparing has started, as a client that goes away.
        let mut making = Box::pin(making);
        let s = tokio::select! {
            s = made => s.unwrap(),
            _ = &mut making => panic!("the session was made before its preparing started"),
        };
        drop(making);
        let branches = || async {
            crate::git::git(repo.path(), &["branch", "--list", &s.branch])
                .await
                .map(|out| String::from_utf8_lossy(&out).trim().to_string())
                .unwrap()
        };
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let gone = !Path::new(&s.path).exists() && branches().await.is_empty();
            if copied.load(Ordering::SeqCst) && gone {
                break;
            }
        }
        assert!(copied.load(Ordering::SeqCst), "the copy never finished");
        // Settled: nothing comes back after it is removed.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let left = (Path::new(&s.path).exists(), !branches().await.is_empty());
        assert_eq!(left, (false, false), "(worktree, branch) left behind");
        assert!(mgr.list_sessions().is_empty(), "a session was recorded");
    }

    /// X65: a session archived while its creation waits on what runs once
    /// it is saved (Build it records its design there), as it shows in the
    /// sidebar, starts no terminal: its agent and setup never run in an
    /// archived session, and the creation says why.
    #[tokio::test]
    async fn a_session_archived_before_its_terminals_start_starts_none() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let req = SessionCreate { name: Some("Built".into()), agent: Some("fake".into()), cols: 80, rows: 24, ..SessionCreate::new(&r.id) };
        let archiving = mgr.clone();
        let on_saved = move |s: Session| async move {
            archiving.archive(SessionArchive { id: s.id, remove_worktree: false, delete_branch: false, delete_remote: false }).await.unwrap();
        };
        let made = mgr.create_session_prepared(req, |_| async { anyhow::Ok(()) }, on_saved).await;
        assert_eq!(made.map(|s| s.name).map_err(|e| e.to_string()), Err("the session was archived before its terminals started".to_string()));
        let s = mgr.list_sessions().into_iter().find(|s| s.name == "Built").unwrap();
        assert!(s.archived);
        let running: Vec<String> = mgr.terminals.list().into_iter().filter(|t| t.session_id.as_deref() == Some(s.id.as_str())).map(|t| t.title).collect();
        assert_eq!(running, Vec::<String>::new());
        assert_eq!(s.terminals, Vec::<TerminalId>::new());
    }

    /// X65: a session whose archive is under way as its creation goes on to
    /// start its terminals, its archive script still running, starts none:
    /// the creation waits for the archive, then says why.
    #[tokio::test]
    async fn a_session_whose_archive_is_under_way_as_its_terminals_would_start_starts_none() {
        let (repo, _home, mgr) = setup().await;
        let gate = tempfile::tempdir().unwrap();
        let (started, go) = (gate.path().join("started"), gate.path().join("go"));
        std::fs::write(
            repo.path().join(".moonlet/config.toml"),
            format!(
                "archive = \"touch {}; while [ ! -f {} ]; do sleep 0.05; done\"\ndefault_agent = \"fake\"\n[agents]\nfake = \"sh -c 'sleep 30'\"\n",
                started.display(),
                go.display()
            ),
        )
        .unwrap();
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let req = SessionCreate { name: Some("Built".into()), agent: Some("fake".into()), cols: 80, rows: 24, ..SessionCreate::new(&r.id) };
        let archiving = mgr.clone();
        let seen = started.clone();
        let on_saved = move |s: Session| async move {
            tokio::spawn(async move {
                archiving.archive(SessionArchive { id: s.id, remove_worktree: false, delete_branch: false, delete_remote: false }).await.unwrap();
            });
            while !seen.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        let making = mgr.create_session_prepared(req, |_| async { anyhow::Ok(()) }, on_saved);
        let release = async {
            while !started.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
            std::fs::write(&go, "").unwrap();
        };
        let (made, ()) = tokio::join!(making, release);
        assert_eq!(made.map(|s| s.name).map_err(|e| e.to_string()), Err("the session was archived before its terminals started".to_string()));
        let s = mgr.list_sessions().into_iter().find(|s| s.name == "Built").unwrap();
        assert!(s.archived);
        assert_eq!(mgr.terminals.list().into_iter().filter(|t| t.session_id.as_deref() == Some(s.id.as_str())).count(), 0);
    }

    /// X65: a session removed, with its project, while its creation waits on
    /// what runs once it is saved starts no terminal, and the creation says
    /// why.
    #[tokio::test]
    async fn a_session_removed_before_its_terminals_start_starts_none() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let req = SessionCreate { name: Some("Built".into()), agent: Some("fake".into()), cols: 80, rows: 24, ..SessionCreate::new(&r.id) };
        let (removing, project) = (mgr.clone(), r.id.clone());
        let on_saved = move |s: Session| async move {
            removing.archive(SessionArchive { id: s.id, remove_worktree: false, delete_branch: false, delete_remote: false }).await.unwrap();
            removing.remove_project(&project).unwrap();
        };
        let made = mgr.create_session_prepared(req, |_| async { anyhow::Ok(()) }, on_saved).await;
        assert_eq!(made.map(|s| s.name).map_err(|e| e.to_string()), Err("the session was removed before its terminals started".to_string()));
        assert!(mgr.list_sessions().is_empty());
        assert_eq!(mgr.terminals.list().len(), 0);
    }

    #[tokio::test]
    async fn a_session_not_made_whose_removal_is_cancelled_midway_still_leaves_no_worktree_or_branch()
     {
        let (repo, _home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let req = SessionCreate {
            project_id: r.id.clone(),
            name: Some("Refused".into()),
            branch: None,
            from: None,
            existing_branch: false,
            agent: Some("none".into()),
            prompt: None,
            cols: 80,
            rows: 24,
            model: None,
            effort: None,
            mode: None,
            pr: None,
            tui: false,
            cloud: false,
            spawned_by: None,
            add_dirs: vec![],
            workspace_id: None,
            task: None,
            worktree: None,
            design: None,
        };
        // The removal of what was made is held as it starts.
        let (started, removing) = tokio::sync::oneshot::channel();
        let (release, held) = tokio::sync::oneshot::channel();
        BEFORE_REMOVE
            .lock()
            .unwrap()
            .push((PathBuf::from(&r.path), started, held));
        let (made, session) = tokio::sync::oneshot::channel::<Session>();
        let prepare = move |s: Session| async move {
            let _ = made.send(s);
            anyhow::bail!("the copy is refused")
        };
        let mut making = Box::pin(mgr.create_session_prepared(req, prepare, |_| async {}));
        tokio::select! {
            _ = removing => {}
            r = &mut making => panic!("ended before its removal started: {r:?}"),
        }
        let s = session.await.unwrap();
        // The request goes away while its worktree and branch are removed.
        drop(making);
        let _ = release.send(());
        let branches = || async {
            crate::git::git(repo.path(), &["branch", "--list", &s.branch])
                .await
                .map(|out| String::from_utf8_lossy(&out).trim().to_string())
                .unwrap()
        };
        let mut left = (true, true);
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            left = (Path::new(&s.path).exists(), !branches().await.is_empty());
            if left == (false, false) {
                break;
            }
        }
        assert_eq!(left, (false, false), "(worktree, branch) left behind");
        assert!(mgr.list_sessions().is_empty(), "a session was recorded");
    }

    #[tokio::test]
    async fn session_mode_is_recorded_and_unknown_modes_create_nothing() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let req = |mode: &str| SessionCreate {
            project_id: r.id.clone(),
            name: Some("Planned".into()),
            branch: None,
            from: None,
            existing_branch: false,
            agent: Some("none".into()),
            prompt: None,
            cols: 80,
            rows: 24,
            model: None,
            effort: None,
            mode: Some(mode.into()),
            pr: None,
            tui: false,
            cloud: false,
            spawned_by: None,
            add_dirs: vec![],
            workspace_id: None,
            task: None,
            worktree: None,
            design: None,
        };
        for bad in ["", "yolo"] {
            let err = mgr.create_session(req(bad)).await.unwrap_err();
            assert!(err.to_string().contains("unknown permission mode"), "{err}");
        }
        let err = mgr.create_session(req("yolo")).await.unwrap_err();
        assert!(err.to_string().contains("unknown permission mode"), "{err}");
        assert!(mgr.list_sessions().is_empty(), "nothing was created");
        let s = mgr.create_session(req("plan")).await.unwrap();
        assert_eq!(s.mode.as_deref(), Some("plan"));
        assert_eq!(mgr.session(&s.id).unwrap().mode.as_deref(), Some("plan"));
    }

    #[tokio::test]
    async fn a_sessions_pr_survives_a_restart() {
        let (repo, home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let s = mgr
            .create_session(SessionCreate {
                project_id: r.id.clone(),
                name: Some("Lowercase paths".into()),
                branch: None,
                from: None,
                existing_branch: false,
                agent: Some("none".into()),
                prompt: None,
                cols: 80,
                rows: 24,
                model: None,
                effort: None,
                mode: None,
                pr: None,
                tui: false,
                cloud: false,
                spawned_by: None,
                add_dirs: vec![],
                workspace_id: None,
                task: None,
                worktree: None,
                design: None,
            })
            .await
            .unwrap();
        assert_eq!(s.pr, None);
        mgr.set_pr(Path::new(&s.path), 38).unwrap();
        assert_eq!(mgr.session(&s.id).unwrap().pr, Some(38));

        let env: BTreeMap<String, String> = std::env::vars().collect();
        let again = SessionManager::load(
            home.path().join("state.json"),
            home.path().join("worktrees"),
            TerminalManager::new(home.path().join("s2.sock"), env),
        );
        assert_eq!(again.session(&s.id).unwrap().pr, Some(38));

        // Archiving frees the worktree path; a new session with the same
        // name gets it, and the PR is the new session's only.
        again
            .archive(SessionArchive { id: s.id.clone(), remove_worktree: true, delete_branch: true, delete_remote: false })
            .await
            .unwrap();
        let next = again
            .create_session(SessionCreate {
                project_id: r.id.clone(),
                name: Some("Lowercase paths".into()),
                branch: None,
                from: None,
                existing_branch: false,
                agent: Some("none".into()),
                prompt: None,
                cols: 80,
                rows: 24,
                model: None,
                effort: None,
                mode: None,
                pr: None,
                tui: false,
                cloud: false,
                spawned_by: None,
                add_dirs: vec![],
                workspace_id: None,
                task: None,
                worktree: None,
                design: None,
            })
            .await
            .unwrap();
        assert_eq!(next.path, s.path);
        again.set_pr(Path::new(&next.path), 41).unwrap();
        assert_eq!(again.session(&next.id).unwrap().pr, Some(41));
        assert_eq!(again.session(&s.id).unwrap().pr, Some(38));
    }

    // The app opens a new session on its first terminal, so the agent comes
    // before the setup script.
    /// A terminal-only session request, as `moonlet session new` sends it (X22).
    fn spawn_req(project_id: &str, name: &str, mode: Option<&str>, spawned_by: Option<TerminalId>) -> SessionCreate {
        SessionCreate {
            name: Some(name.into()),
            agent: Some("none".into()),
            mode: mode.map(Into::into),
            spawned_by,
            cols: 80,
            rows: 24,
            ..SessionCreate::new(project_id)
        }
    }

    #[tokio::test]
    async fn a_session_started_from_another_sessions_terminal_records_its_parent() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let parent = mgr.create_session(spawn_req(&r.id, "Billing export", None, None)).await.unwrap();
        assert_eq!(parent.spawned_by, None);
        let child = mgr
            .create_session(spawn_req(&r.id, "Download button", None, Some(parent.terminals[0])))
            .await
            .unwrap();
        assert_eq!(child.spawned_by.as_deref(), Some(parent.id.as_str()));
        assert_eq!(mgr.session(&child.id).unwrap().spawned_by.as_deref(), Some(parent.id.as_str()));
    }

    #[tokio::test]
    async fn a_spawned_session_starts_in_its_parents_mode_or_a_stricter_one() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let parent = mgr
            .create_session(spawn_req(&r.id, "Edits", Some("acceptEdits"), None))
            .await
            .unwrap();
        let t = Some(parent.terminals[0]);
        let inherited = mgr.create_session(spawn_req(&r.id, "Inherited", None, t)).await.unwrap();
        assert_eq!(inherited.mode.as_deref(), Some("acceptEdits"));
        let stricter = mgr.create_session(spawn_req(&r.id, "Stricter", Some("plan"), t)).await.unwrap();
        assert_eq!(stricter.mode.as_deref(), Some("plan"));
        for wider in ["auto", "bypassPermissions"] {
            let err = mgr.create_session(spawn_req(&r.id, wider, Some(wider), t)).await.unwrap_err();
            assert_eq!(
                err.to_string(),
                format!("permission mode {wider} is more permissive than the parent's acceptEdits")
            );
        }
        assert_eq!(mgr.list_sessions().len(), 3, "the rejected ones created nothing");
    }

    /// Polls `check` until it holds; panics with `what` after five seconds.
    async fn wait_until(what: &str, check: impl Fn() -> bool) {
        for _ in 0..250 {
            if check() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("{what}");
    }

    /// The lines a process wrote to `path` so far.
    fn lines_of(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path).map(|t| t.lines().map(String::from).collect()).unwrap_or_default()
    }

    /// Waits for `path` to have `n` lines and returns the last one.
    async fn nth_line(path: &Path, n: usize) -> String {
        wait_until(&format!("{} never had {n} lines", path.display()), || lines_of(path).len() >= n).await;
        lines_of(path)[n - 1].clone()
    }

    fn set_profile(mgr: &SessionManager, ws: &str, profile: Option<&str>) {
        mgr.update_workspace(WorkspaceUpdate {
            id: ws.into(),
            name: None,
            color: None,
            section_ids: None,
            claude_profile: Some(profile.map(String::from)),
        })
        .unwrap();
    }

    /// A folder under a temp dir, as the profile stores it (macOS temp dirs
    /// are behind the /var → /private/var link).
    fn folder(home: &tempfile::TempDir, name: &str) -> String {
        home.path().canonicalize().unwrap().join(name).display().to_string()
    }

    fn shell_writing(file: &str, command: &str) -> TerminalCreate {
        TerminalCreate { command: vec!["sh".into(), "-c".into(), format!("{command} > {file}; sleep 5")], ..Default::default() }
    }

    /// X33: a profile is a private folder, and a workspace using it sends it
    /// to its sessions' shells and agent tabs as `CLAUDE_CONFIG_DIR`.
    #[tokio::test]
    async fn a_workspaces_profile_reaches_its_sessions_terminals() {
        let (repo, home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let dir = folder(&home, "claude-work");
        let profile = mgr.create_profile("Work", Some(&dir)).unwrap();
        assert_eq!(profile.path, dir);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);

        let personal = mgr.list_workspaces()[0].clone();
        set_profile(&mgr, &personal.id, Some(&profile.id));
        let s = mgr.create_session(new_session(&r.id, None)).await.unwrap();
        mgr.spawn_in(&s, shell_writing("config-dir", "echo ${CLAUDE_CONFIG_DIR:-default}")).unwrap();
        assert_eq!(nth_line(&Path::new(&s.path).join("config-dir"), 1).await, dir);
        // An agent tab names the folder in its own command, so a shell rc
        // file exporting another one cannot win.
        let agent = mgr
            .spawn_in(&s, TerminalCreate { kind: TerminalKind::Agent, agent: Some("fake".into()), ..Default::default() })
            .unwrap();
        assert!(agent.command[2].starts_with(&format!("export CLAUDE_CONFIG_DIR='{dir}'; ")), "{:?}", agent.command);

        // Back on the default profile, nothing is set.
        set_profile(&mgr, &personal.id, None);
        let agent = mgr
            .spawn_in(&s, TerminalCreate { kind: TerminalKind::Agent, agent: Some("fake".into()), ..Default::default() })
            .unwrap();
        assert!(!agent.command[2].contains("CLAUDE_CONFIG_DIR"), "{:?}", agent.command);
    }

    /// X33: a project two workspaces share runs with each workspace's profile.
    #[tokio::test]
    async fn a_shared_project_runs_with_each_workspaces_profile() {
        let (repo, home, mgr) = setup().await;
        let path = repo.path().display().to_string();
        let r = mgr.add_project(&path).await.unwrap();
        let personal = mgr.list_workspaces()[0].id.clone();
        let work = workspace(&mgr, "Acme", vec![]);
        let ops = mgr.create_section(&work.id, "AI Operations").unwrap();
        mgr.section_add_project(&ops.id, &path).await.unwrap();
        let profile = mgr.create_profile("Work", Some(&folder(&home, "claude-work"))).unwrap();
        set_profile(&mgr, &work.id, Some(&profile.id));

        let mine = mgr.create_session(new_session(&r.id, Some(&personal))).await.unwrap();
        let theirs = mgr.create_session(new_session(&r.id, Some(&work.id))).await.unwrap();
        mgr.spawn_in(&mine, shell_writing("config-dir", "echo ${CLAUDE_CONFIG_DIR:-default}")).unwrap();
        mgr.spawn_in(&theirs, shell_writing("config-dir", "echo ${CLAUDE_CONFIG_DIR:-default}")).unwrap();
        assert_eq!(nth_line(&Path::new(&mine.path).join("config-dir"), 1).await, "default");
        assert_eq!(nth_line(&Path::new(&theirs.path).join("config-dir"), 1).await, folder(&home, "claude-work"));
    }

    /// X33: run scripts get the profile too.
    #[tokio::test]
    async fn run_scripts_get_the_workspaces_profile() {
        let (repo, home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let profile = mgr.create_profile("Work", Some(&folder(&home, "claude-work"))).unwrap();
        set_profile(&mgr, &mgr.list_workspaces()[0].id, Some(&profile.id));
        let s = mgr.create_session(new_session(&r.id, None)).await.unwrap();
        std::fs::write(repo.path().join(".moonlet/config.toml"), "run = \"echo $CLAUDE_CONFIG_DIR > ran-with\"\n").unwrap();
        mgr.run_script(&s.id, "run", 80, 24).await.unwrap();
        assert_eq!(nth_line(&Path::new(&s.path).join("ran-with"), 1).await, folder(&home, "claude-work"));
    }

    /// X33: a workspace's profile is kept across a daemon restart.
    #[tokio::test]
    async fn a_workspaces_profile_survives_a_restart() {
        let (_repo, home, mgr) = setup().await;
        let profile = mgr.create_profile("Work", Some(&folder(&home, "claude-work"))).unwrap();
        let ws = mgr.list_workspaces()[0].id.clone();
        set_profile(&mgr, &ws, Some(&profile.id));
        let again = SessionManager::load(home.path().join("state.json"), home.path().join("worktrees"), TerminalManager::new(home.path().join("s2.sock"), BTreeMap::new()));
        assert_eq!(again.list_workspaces()[0].claude_profile.as_deref(), Some(profile.id.as_str()));
        assert_eq!(again.list_profiles()[0].name, "Work");
    }

    /// X33: the structured view's Claude gets the profile on every start, and
    /// a conversation kept in another profile is not resumed: a notice says so.
    #[tokio::test]
    async fn the_structured_agent_starts_in_the_workspaces_profile() {
        let (repo, home, mgr, chats) = structured().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let work = mgr.create_profile("Work", Some(&folder(&home, "claude-work"))).unwrap();
        let private = mgr.create_profile("Private", Some(&folder(&home, "claude-private"))).unwrap();
        let ws = mgr.list_workspaces()[0].clone();
        set_profile(&mgr, &ws.id, Some(&work.id));
        let mut req = new_session(&r.id, None);
        req.agent = Some("claude".into());
        req.prompt = Some("hi".into());
        let s = mgr.create_session(req).await.unwrap();
        let env = Path::new(&s.path).join("claude-env");
        assert_eq!(nth_line(&env, 1).await, folder(&home, "claude-work"));

        // The conversation started; switch the workspace to another profile
        // and restart the agent with a new message.
        let chat = s.terminals[0];
        wait_until("the conversation never started", || chats.state(chat).unwrap().agent_session.is_some()).await;
        set_profile(&mgr, &ws.id, Some(&private.id));
        chats.settings(chat, Some("opus".into()), None, None).unwrap();
        chats.send(chat, "again", &[]).unwrap();
        assert_eq!(nth_line(&env, 2).await, folder(&home, "claude-private"));
        let args = lines_of(&Path::new(&s.path).join("claude-args"));
        assert!(!args.last().unwrap().contains("--resume"), "{args:?}");
        let notes: Vec<String> = chats.state(chat).unwrap().items.into_iter().filter(|i| i.kind == "system").map(|i| i.text).collect();
        assert!(notes.contains(&"Started a new conversation: this workspace now uses Private".to_string()), "{notes:?}");
    }

    /// X73: another member's chat goes on here in the profile of this
    /// host's workspace, where its conversation was put: it is resumed.
    #[tokio::test]
    async fn a_continued_chat_resumes_its_conversation_in_the_workspaces_profile() {
        let (repo, home, mgr, chats) = structured().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let work = mgr.create_profile("Work", Some(&folder(&home, "claude-work"))).unwrap();
        set_profile(&mgr, &mgr.list_workspaces()[0].id, Some(&work.id));
        let s = mgr.create_session(new_session(&r.id, None)).await.unwrap();
        let history = moonlet_proto::types::ChatState {
            status: "done".into(),
            agent_session: Some("0d6e2a4c-1b3f-4a5e-9c7d-8e1f2a3b4c5d".into()),
            ..Default::default()
        };

        let chat = mgr.continue_chat(&s, history).unwrap();
        let args = nth_line(&Path::new(&s.path).join("claude-args"), 1).await;
        assert!(args.contains("--resume 0d6e2a4c-1b3f-4a5e-9c7d-8e1f2a3b4c5d"), "{args}");
        assert_eq!(nth_line(&Path::new(&s.path).join("claude-env"), 1).await, folder(&home, "claude-work"));
        let notes: Vec<String> = chats.state(chat.id).unwrap().items.into_iter().filter(|i| i.kind == "system").map(|i| i.text).collect();
        assert!(notes.is_empty(), "{notes:?}");
    }

    /// X73: what the member's agent had running when it went away is over
    /// in the chat that goes on here, as after a daemon restart.
    #[tokio::test]
    async fn a_continued_chat_closes_what_its_member_had_running() {
        let (repo, _home, mgr, chats) = structured().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let s = mgr.create_session(new_session(&r.id, None)).await.unwrap();
        let history: moonlet_proto::types::ChatState = serde_json::from_value(serde_json::json!({
            "status": "working",
            "items": [
                { "id": "m1", "kind": "assistant", "text": "Running the te", "ts": 1, "partial": true },
                { "id": "t1", "kind": "tool", "ts": 2, "tool": { "name": "Bash", "summary": "npm test", "input": { "command": "npm test" }, "status": "running" } }
            ],
            "subagents": [
                { "id": "a1", "tool_use_id": "toolu_1", "description": "List files", "status": "running", "started_at": 1 }
            ],
            "queued": [ { "id": "q1", "text": "Also fix the header" } ]
        }))
        .unwrap();

        let chat = mgr.continue_chat(&s, history).unwrap();
        let st = chats.state(chat.id).unwrap();
        assert!(!st.items[0].partial);
        assert_eq!(st.items[1].tool.as_ref().unwrap().status, "error");
        assert_eq!(st.subagents[0].status, "stopped");
        assert!(st.queued.is_empty());
        let texts: Vec<&str> = st.items[2..].iter().map(|i| i.text.as_str()).collect();
        assert_eq!(texts, ["Also fix the header", "Not delivered: Claude stopped before reading this message."]);
    }

    /// X73: a permission mode this host does not know, from another
    /// member's word, never stops its chat going on: it runs in the default.
    #[tokio::test]
    async fn a_continued_chat_with_an_unknown_mode_goes_on_in_the_default_one() {
        let (repo, _home, mgr, chats) = structured().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let s = mgr.create_session(new_session(&r.id, None)).await.unwrap();
        let history = moonlet_proto::types::ChatState { status: "done".into(), mode: Some("yolo".into()), ..Default::default() };

        let chat = mgr.continue_chat(&s, history).unwrap();
        assert_eq!(chats.state(chat.id).unwrap().mode, None);
        let args = nth_line(&Path::new(&s.path).join("claude-args"), 1).await;
        assert!(!args.contains("--permission-mode"), "{args}");
    }

    /// X73: a continued chat keeps the folders it was given inside the
    /// session's worktree here; one anywhere else, or gone, is not given.
    #[tokio::test]
    async fn a_continued_chat_keeps_its_folders_inside_the_worktree_alone() {
        let (repo, home, mgr, chats) = structured().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let s = mgr.create_session(new_session(&r.id, None)).await.unwrap();
        let web = format!("{}/packages/web", s.path);
        std::fs::create_dir_all(&web).unwrap();
        let elsewhere = home.path().join("shared-lib");
        std::fs::create_dir(&elsewhere).unwrap();
        let link = format!("{}/packages/lib", s.path);
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        let history = moonlet_proto::types::ChatState {
            status: "done".into(),
            add_dirs: vec![web.clone(), elsewhere.display().to_string(), format!("{}/gone", s.path), format!("{}/packages/../../x", s.path), link],
            ..Default::default()
        };

        let chat = mgr.continue_chat(&s, history).unwrap();
        assert_eq!(chats.state(chat.id).unwrap().add_dirs, vec![web.clone()]);
        let args = nth_line(&Path::new(&s.path).join("claude-args"), 1).await;
        assert!(args.contains(&format!("--add-dir {web}")), "{args}");
        assert!(!args.contains("shared-lib"), "{args}");
    }

    /// X64: a design system's agent has no session; it starts in its
    /// workspace's profile, with its own settings.
    #[tokio::test]
    async fn a_chat_of_a_workspace_without_a_session_starts_in_the_workspaces_profile() {
        let (_repo, home, mgr, chats) = structured().await;
        let work = mgr.create_profile("Work", Some(&folder(&home, "claude-work"))).unwrap();
        let ws = mgr.list_workspaces()[0].clone();
        set_profile(&mgr, &ws.id, Some(&work.id));
        let dir = tempfile::tempdir().unwrap();
        let settings = r#"{"permissions":{"deny":["Edit(//src/**)"]}}"#;
        let info = chats
            .create(crate::chat::runtime::ChatCreate {
                cwd: dir.path().display().to_string(),
                agent: "claude".into(),
                model: None,
                effort: None,
                mode: Some("acceptEdits".into()),
                name: "Design · storefront".into(),
                title: Some("Design · storefront".into()),
                session_id: None,
                workspace: Some(ws.id.clone()),
                design: None,
                env: BTreeMap::new(),
                add_dirs: vec![],
                settings: Some(settings.into()),
            })
            .unwrap();
        assert_eq!((info.session_id.as_deref(), info.title.as_str()), (None, "Design · storefront"));
        chats.send(info.id, "build it", &[]).unwrap();
        assert_eq!(nth_line(&dir.path().join("claude-env"), 1).await, folder(&home, "claude-work"));
        assert!(lines_of(&dir.path().join("claude-args"))[0].contains(&format!("--settings {settings}")));
    }

    /// A manager whose login shells get a scratch HOME and a PATH finding the
    /// fake `claude` and a fake `codex`, never real ones.
    fn fake_agents(home: &tempfile::TempDir) -> impl Fn(&str) -> Arc<SessionManager> + '_ {
        let env = {
            let mut env = crate::chat::runtime::tests::fake_claude_env(home.path());
            env.insert("HOME".into(), home.path().display().to_string());
            env
        };
        let codex = home.path().join("bin/codex");
        std::fs::write(&codex, "#!/bin/sh\necho \"$*\" >> codex-args\nsleep 30\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
        move |sock: &str| SessionManager::load(home.path().join("state.json"), home.path().join("worktrees"), TerminalManager::new(home.path().join(sock), env.clone()))
    }

    /// X33: after a daemon restart, a Claude tab continues its conversation
    /// only while the workspace still uses the profile it ran in.
    #[tokio::test]
    async fn a_restored_claude_tab_continues_only_in_the_same_profile() {
        let repo = crate::git::tests::repo().await;
        let home = tempfile::tempdir().unwrap();
        let load = fake_agents(&home);
        let mgr = load("s1.sock");
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let work = mgr.create_profile("Work", Some(&folder(&home, "claude-work"))).unwrap();
        let private = mgr.create_profile("Private", Some(&folder(&home, "claude-private"))).unwrap();
        let ws = mgr.list_workspaces()[0].id.clone();
        set_profile(&mgr, &ws, Some(&work.id));
        let mut req = new_session(&r.id, None);
        req.agent = Some("claude".into());
        req.prompt = None;
        req.tui = true;
        let s = mgr.create_session(req).await.unwrap();
        let args = Path::new(&s.path).join("claude-args");
        nth_line(&args, 1).await;

        // Same profile: the restored tab continues.
        let mgr = load("s2.sock");
        assert_eq!(mgr.restore_after_restart(), 1);
        assert!(nth_line(&args, 2).await.contains("--continue"));

        // Another profile: a new conversation, in the new folder.
        set_profile(&mgr, &ws, Some(&private.id));
        let mgr = load("s3.sock");
        assert_eq!(mgr.restore_after_restart(), 1);
        assert!(!nth_line(&args, 3).await.contains("--continue"));
        assert_eq!(nth_line(&Path::new(&s.path).join("claude-env"), 3).await, folder(&home, "claude-private"));
    }

    /// X33: Codex keeps its own history in ~/.codex, so a Claude profile
    /// change does not stop it resuming.
    #[tokio::test]
    async fn a_restored_codex_tab_resumes_whatever_the_claude_profile() {
        let repo = crate::git::tests::repo().await;
        let home = tempfile::tempdir().unwrap();
        let load = fake_agents(&home);
        let mgr = load("s1.sock");
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let work = mgr.create_profile("Work", Some(&folder(&home, "claude-work"))).unwrap();
        let ws = mgr.list_workspaces()[0].id.clone();
        let mut req = new_session(&r.id, None);
        req.agent = Some("codex".into());
        req.prompt = None;
        req.tui = true;
        let s = mgr.create_session(req).await.unwrap();
        let args = Path::new(&s.path).join("codex-args");
        nth_line(&args, 1).await;
        set_profile(&mgr, &ws, Some(&work.id));
        let mgr = load("s2.sock");
        assert_eq!(mgr.restore_after_restart(), 1);
        assert_eq!(nth_line(&args, 2).await, "resume --last");
    }

    /// X33: a tab whose agent left the repo's config is restored with its
    /// stored command, but with the workspace's current profile.
    #[tokio::test]
    async fn a_restored_custom_agent_tab_takes_the_current_profile() {
        let (repo, home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let work = mgr.create_profile("Work", Some(&folder(&home, "claude-work"))).unwrap();
        let private = mgr.create_profile("Private", Some(&folder(&home, "claude-private"))).unwrap();
        let ws = mgr.list_workspaces()[0].id.clone();
        set_profile(&mgr, &ws, Some(&work.id));
        let s = mgr.create_session(new_session(&r.id, None)).await.unwrap();
        mgr.spawn_in(&s, TerminalCreate { kind: TerminalKind::Agent, agent: Some("fake".into()), ..Default::default() }).unwrap();
        std::fs::write(repo.path().join(".moonlet/config.toml"), "").unwrap();
        set_profile(&mgr, &ws, Some(&private.id));
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let again = SessionManager::load(home.path().join("state.json"), home.path().join("worktrees"), TerminalManager::new(home.path().join("s2.sock"), env));
        assert!(again.restore_after_restart() >= 1);
        let restored: Vec<String> = again.terminals.list().into_iter().filter(|t| t.agent.as_deref() == Some("fake")).map(|t| t.command.join(" ")).collect();
        assert_eq!(restored.len(), 1);
        assert!(restored[0].contains(&format!("export CLAUDE_CONFIG_DIR='{}'; ", folder(&home, "claude-private"))), "{restored:?}");
        assert!(!restored[0].contains("claude-work"), "{restored:?}");
    }

    /// X32: an agent's new session joins the agent's workspace when that
    /// workspace holds the project, not the first one that does.
    #[tokio::test]
    async fn a_spawned_session_joins_its_parents_workspace() {
        let (repo, _home, mgr) = setup().await;
        let path = repo.path().display().to_string();
        let r = mgr.add_project(&path).await.unwrap();
        let work = workspace(&mgr, "Acme", vec![]);
        let sec = mgr.create_section(&work.id, "AI Operations").unwrap();
        mgr.section_add_project(&sec.id, &path).await.unwrap();
        let mut req = spawn_req(&r.id, "Parent", None, None);
        req.workspace_id = Some(work.id.clone());
        let parent = mgr.create_session(req).await.unwrap();
        let child = mgr
            .create_session(spawn_req(&r.id, "Child", None, Some(parent.terminals[0])))
            .await
            .unwrap();
        assert_eq!(child.workspace_id.as_deref(), Some(work.id.as_str()));
    }

    #[tokio::test]
    async fn a_parent_without_a_mode_counts_as_manual() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let parent = mgr.create_session(spawn_req(&r.id, "Default", None, None)).await.unwrap();
        let t = Some(parent.terminals[0]);
        let child = mgr.create_session(spawn_req(&r.id, "Child", None, t)).await.unwrap();
        assert_eq!(child.mode.as_deref(), Some("manual"));
        let err = mgr.create_session(spawn_req(&r.id, "Edits", Some("acceptEdits"), t)).await.unwrap_err();
        assert_eq!(err.to_string(), "permission mode acceptEdits is more permissive than the parent's manual");
    }

    #[tokio::test]
    async fn a_structured_parent_counts_with_its_current_chat_mode() {
        let (repo, _old_home, _) = setup().await;
        let home = tempfile::tempdir().unwrap();
        let terminals = TerminalManager::new(
            home.path().join("s.sock"),
            crate::chat::runtime::tests::fake_claude_env(home.path()),
        );
        let chats = crate::chat::runtime::ChatManager::new(terminals.clone(), home.path().join("chats"));
        let mgr = SessionManager::load(home.path().join("state.json"), home.path().join("worktrees"), terminals);
        mgr.set_chats(chats.clone());
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let mut req = spawn_req(&r.id, "Structured", None, None);
        req.agent = Some("claude".into());
        let parent = mgr.create_session(req).await.unwrap();
        let chat = parent.terminals[0];
        // Picked in the footer after the session started: the session keeps
        // its creation mode, the chat has the current one.
        chats.settings(chat, None, None, Some("plan".into())).unwrap();
        let child = mgr.create_session(spawn_req(&r.id, "Child", None, Some(chat))).await.unwrap();
        assert_eq!(child.mode.as_deref(), Some("plan"));
    }

    /// A manager that runs structured agents with the fake `claude`, and a
    /// repo with no `.moonlet/config.toml`.
    async fn structured() -> (tempfile::TempDir, tempfile::TempDir, Arc<SessionManager>, Arc<crate::chat::runtime::ChatManager>) {
        let repo = crate::git::tests::repo().await;
        let home = tempfile::tempdir().unwrap();
        let terminals = TerminalManager::new(
            home.path().join("s.sock"),
            crate::chat::runtime::tests::fake_claude_env(home.path()),
        );
        let chats = crate::chat::runtime::ChatManager::new(terminals.clone(), home.path().join("chats"));
        let mgr = SessionManager::load(home.path().join("state.json"), home.path().join("worktrees"), terminals);
        mgr.set_chats(chats.clone());
        (repo, home, mgr, chats)
    }

    /// The session's terminals in creation order, as (agent, structured).
    fn agents_of(mgr: &SessionManager, s: &Session) -> Vec<(Option<String>, bool)> {
        let mut ts: Vec<_> = mgr
            .terminals
            .list()
            .into_iter()
            .filter(|t| t.session_id.as_deref() == Some(s.id.as_str()))
            .collect();
        ts.sort_by_key(|t| t.id);
        ts.into_iter().map(|t| (t.agent, t.chat)).collect()
    }

    #[tokio::test]
    async fn directories_picked_for_a_new_session_reach_its_agent() {
        let (repo, home, mgr, _chats) = structured().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let extra = home.path().join("shared-lib");
        std::fs::create_dir(&extra).unwrap();
        let mut req = spawn_req(&r.id, "With a directory", None, None);
        req.agent = Some("claude".into());
        req.add_dirs = vec![extra.display().to_string()];
        let s = mgr.create_session(req).await.unwrap();
        // The fake records its arguments in its working directory, the worktree.
        let args = std::path::Path::new(&s.path).join("claude-args");
        for _ in 0..200 {
            if args.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let started = std::fs::read_to_string(&args).unwrap();
        assert!(started.contains(&format!("--add-dir {}", extra.display())), "{started}");
    }

    #[tokio::test]
    async fn an_agent_cannot_widen_a_spawned_sessions_directories() {
        let (repo, home, mgr, _chats) = structured().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let mut req = spawn_req(&r.id, "Parent", None, None);
        req.agent = Some("claude".into());
        let parent = mgr.create_session(req).await.unwrap();
        let mut req = spawn_req(&r.id, "Child", None, Some(parent.terminals[0]));
        req.agent = Some("claude".into());
        req.add_dirs = vec![home.path().display().to_string()];
        let err = mgr.create_session(req).await.unwrap_err();
        assert_eq!(err.to_string(), "a session another agent starts cannot add directories");
    }

    #[tokio::test]
    async fn a_spawned_session_without_an_agent_starts_its_parents_agent() {
        let (repo, _home, mgr, _chats) = structured().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let mut req = spawn_req(&r.id, "Parent", None, None);
        req.agent = Some("claude".into());
        let parent = mgr.create_session(req).await.unwrap();
        let mut req = spawn_req(&r.id, "Child", None, Some(parent.terminals[0]));
        req.agent = None;
        let child = mgr.create_session(req).await.unwrap();
        assert_eq!(child.agent.as_deref(), Some("claude"));
        assert_eq!(agents_of(&mgr, &child), vec![(Some("claude".to_string()), true)]);
    }

    #[tokio::test]
    async fn a_spawned_session_runs_its_parents_model_and_effort_unless_asked_otherwise() {
        let (repo, _home, mgr, chats) = structured().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let mut req = spawn_req(&r.id, "Parent", None, None);
        req.agent = Some("claude".into());
        req.model = Some("sonnet".into());
        let parent = mgr.create_session(req).await.unwrap();
        let chat = parent.terminals[0];
        // Picked in the footer after the session started.
        chats.settings(chat, Some("opus".into()), Some("max".into()), None).unwrap();

        let mut req = spawn_req(&r.id, "Inherits", None, Some(chat));
        req.agent = None;
        let child = mgr.create_session(req).await.unwrap();
        assert_eq!((child.model.as_deref(), child.effort.as_deref()), (Some("opus"), Some("max")));
        let state = chats.state(child.terminals[0]).unwrap();
        assert_eq!((state.model.as_deref(), state.effort.as_deref()), (Some("opus"), Some("max")));

        let mut req = spawn_req(&r.id, "Asks", None, Some(chat));
        req.agent = None;
        req.model = Some("haiku".into());
        req.effort = Some("low".into());
        let child = mgr.create_session(req).await.unwrap();
        assert_eq!((child.model.as_deref(), child.effort.as_deref()), (Some("haiku"), Some("low")));
    }

    #[tokio::test]
    async fn an_agent_tab_does_not_pass_on_its_sessions_model_for_another_agent() {
        let (repo, _home, mgr, _chats) = structured().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let mut req = spawn_req(&r.id, "Claude session", None, None);
        req.agent = Some("claude".into());
        req.model = Some("opus".into());
        req.effort = Some("max".into());
        let parent = mgr.create_session(req).await.unwrap();
        // A Codex tab the user opened in that Claude session.
        let codex = mgr
            .spawn_in(
                &parent,
                TerminalCreate {
                    kind: TerminalKind::Agent,
                    agent: Some("codex".into()),
                    command: vec!["sh".into(), "-c".into(), "sleep 30".into()],
                    ..Default::default()
                },
            )
            .unwrap();
        let mut req = spawn_req(&r.id, "From the Codex tab", None, Some(codex.id));
        req.agent = None;
        let child = mgr.create_session(req).await.unwrap();
        assert_eq!(child.agent.as_deref(), Some("codex"));
        assert_eq!((child.model, child.effort), (None, None));
    }

    #[tokio::test]
    async fn a_spawned_session_starts_the_projects_default_agent_first() {
        let (parent_repo, _home, mgr, _chats) = structured().await;
        let p = mgr.add_project(&parent_repo.path().display().to_string()).await.unwrap();
        // The `setup()` repo's config says `default_agent = "fake"`.
        let (repo, _old_home, _) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let mut req = spawn_req(&p.id, "Parent", None, None);
        req.agent = Some("claude".into());
        req.model = Some("opus".into());
        let parent = mgr.create_session(req).await.unwrap();
        let mut req = spawn_req(&r.id, "Child", None, Some(parent.terminals[0]));
        req.agent = None;
        let child = mgr.create_session(req).await.unwrap();
        assert_eq!(child.agent.as_deref(), Some("fake"));
        assert_eq!(child.model, None, "a Claude model means nothing to another agent");
        assert_eq!(
            agents_of(&mgr, &child),
            vec![(Some("fake".to_string()), false), (None, false)],
            "the fake agent in its terminal, then setup"
        );
    }

    #[tokio::test]
    async fn a_spawned_session_starts_claude_when_the_parent_has_no_structured_agent() {
        let (repo, _home, mgr, _chats) = structured().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let (fake_repo, _old_home, _) = setup().await;
        let f = mgr.add_project(&fake_repo.path().display().to_string()).await.unwrap();
        let shell = mgr.create_session(spawn_req(&r.id, "Shell", None, None)).await.unwrap();
        let mut req = spawn_req(&f.id, "Fake", None, None);
        req.agent = None;
        let fake = mgr.create_session(req).await.unwrap();
        assert_eq!(fake.agent.as_deref(), Some("fake"));
        for parent in [&shell, &fake] {
            let mut req = spawn_req(&r.id, &format!("From {}", parent.name), None, Some(parent.terminals[0]));
            req.agent = None;
            let child = mgr.create_session(req).await.unwrap();
            assert_eq!(child.agent.as_deref(), Some("claude"), "{}", parent.name);
            assert_eq!(agents_of(&mgr, &child), vec![(Some("claude".to_string()), true)], "{}", parent.name);
        }
        // Asking for no agent still gives a shell.
        let child = mgr
            .create_session(spawn_req(&r.id, "Asked for a shell", None, Some(shell.terminals[0])))
            .await
            .unwrap();
        assert_eq!(child.agent, None);
        assert_eq!(agents_of(&mgr, &child), vec![(None, false)]);
    }

    #[tokio::test]
    async fn without_a_parent_any_mode_is_allowed() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let s = mgr
            .create_session(spawn_req(&r.id, "Bypass", Some("bypassPermissions"), None))
            .await
            .unwrap();
        assert_eq!(s.mode.as_deref(), Some("bypassPermissions"));
        let s = mgr.create_session(spawn_req(&r.id, "Default", None, None)).await.unwrap();
        assert_eq!(s.mode, None);
    }

    #[tokio::test]
    async fn an_unknown_parent_terminal_creates_nothing() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let err = mgr
            .create_session(spawn_req(&r.id, "Orphan", None, Some(9999)))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "no terminal 9999");
        assert!(mgr.list_sessions().is_empty());
    }

    #[tokio::test]
    async fn a_new_sessions_first_terminal_is_the_agent_not_setup() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        for (name, agent, first) in [
            ("With agent", None, TerminalKind::Agent),
            ("Terminal only", Some("none"), TerminalKind::Shell),
        ] {
            let ws = mgr
                .create_session(SessionCreate {
                    project_id: r.id.clone(),
                    name: Some(name.into()),
                    branch: None,
                    from: None,
                    existing_branch: false,
                    agent: agent.map(Into::into),
                    prompt: None,
                    cols: 80,
                    rows: 24,
                    model: None,
                    effort: None,
                    mode: None,
                    pr: None,
                    tui: false,
                    cloud: false,
                    spawned_by: None,
                    add_dirs: vec![],
                    workspace_id: None,
                    task: None,
                    worktree: None,
                    design: None,
                })
                .await
                .unwrap();
            let mut kinds: Vec<_> = mgr
                .terminals
                .list()
                .into_iter()
                .filter(|t| t.session_id.as_deref() == Some(ws.id.as_str()))
                .map(|t| (t.id, t.kind))
                .collect();
            kinds.sort_by_key(|(id, _)| *id);
            let kinds: Vec<_> = kinds.into_iter().map(|(_, k)| k).collect();
            assert_eq!(kinds, vec![first, TerminalKind::Setup], "{name}");
        }
    }

    #[tokio::test]
    async fn create_run_archive_workspace() {
        let (repo, home, mgr) = setup().await;
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        assert_eq!(r.base_branch, "main");
        assert_eq!(
            mgr.add_project(
                &repo
                    .path()
                    .join("subdir-does-not-matter")
                    .parent()
                    .unwrap()
                    .display()
                    .to_string()
            )
            .await
            .unwrap()
            .id,
            r.id
        );

        let ws = mgr
            .create_session(SessionCreate {
                project_id: r.id.clone(),
                name: Some("Fix login".into()),
                branch: None,
                from: None,
                existing_branch: false,
                agent: None,
                prompt: Some("it's broken".into()),
                cols: 80,
                rows: 24,
                model: None,
                effort: None,
                mode: None,
                pr: None,
                tui: false,
                cloud: false,
                spawned_by: None,
                add_dirs: vec![],
                workspace_id: None,
                task: None,
                worktree: None,
                design: None,
            })
            .await
            .unwrap();
        assert_eq!(ws.branch, "moonlet/fix-login");
        assert!(Path::new(&ws.path).join("a.txt").exists());
        let terminals = mgr.terminals.list();
        let agent = terminals
            .iter()
            .find(|s| s.kind == TerminalKind::Agent)
            .expect("agent started");
        assert_eq!(agent.agent.as_deref(), Some("fake"));
        assert!(agent.command.last().unwrap().ends_with("'it'\\''s broken'"));
        assert!(terminals.iter().any(|s| s.kind == TerminalKind::Setup));
        assert_eq!(ws.restore.len(), 1, "setup is not restored, the agent is");

        // Second workspace with the same name gets unique branch and dir.
        let ws2 = mgr
            .create_session(SessionCreate {
                project_id: r.id.clone(),
                name: Some("Fix login".into()),
                branch: None,
                from: None,
                existing_branch: false,
                agent: Some("none-agent".into()),
                prompt: None,
                cols: 80,
                rows: 24,
                model: None,
                effort: None,
                mode: None,
                pr: None,
                tui: false,
                cloud: false,
                spawned_by: None,
                add_dirs: vec![],
                workspace_id: None,
                task: None,
                worktree: None,
                design: None,
            })
            .await
            .unwrap();
        assert_eq!(ws2.branch, "moonlet/fix-login-2");
        assert_ne!(ws2.path, ws.path);

        let run = mgr.run_script(&ws.id, "run", 80, 24).await.unwrap();
        assert_eq!(run.kind, TerminalKind::Run);

        // State is persisted.
        let saved: State =
            serde_json::from_str(&std::fs::read_to_string(home.path().join("state.json")).unwrap())
                .unwrap();
        assert_eq!(saved.sessions.len(), 2);

        mgr.archive(SessionArchive {
            id: ws.id.clone(),
            remove_worktree: true,
            delete_branch: true,
            delete_remote: false,
        })
        .await
        .unwrap();
        assert!(!Path::new(&ws.path).exists());
        assert!(mgr.session(&ws.id).unwrap().archived);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            mgr.terminals
                .list()
                .iter()
                .all(|s| s.session_id.as_deref() != Some(ws.id.as_str()))
        );
        assert!(mgr.remove_project(&r.id).is_err(), "ws2 still active");
    }

    #[tokio::test]
    async fn restores_agents_after_restart() {
        let (repo, home, mgr) = setup().await;
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        let ws = mgr
            .create_session(SessionCreate {
                project_id: r.id.clone(),
                name: Some("t".into()),
                branch: None,
                from: None,
                existing_branch: false,
                agent: Some("fake".into()),
                prompt: Some("hi".into()),
                cols: 80,
                rows: 24,
                model: None,
                effort: None,
                mode: None,
                pr: None,
                tui: false,
                cloud: false,
                spawned_by: None,
                add_dirs: vec![],
                workspace_id: None,
                task: None,
                worktree: None,
                design: None,
            })
            .await
            .unwrap();
        assert_eq!(ws.restore.len(), 1);

        // Simulate a daemon restart: a fresh session manager with no terminals.
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let terminals = TerminalManager::new(home.path().join("s2.sock"), env);
        let mgr2 = SessionManager::load(
            home.path().join("state.json"),
            home.path().join("worktrees"),
            terminals,
        );
        assert_eq!(mgr2.restore_after_restart(), 1);
        let s = mgr2.terminals.list();
        assert_eq!(s.len(), 1);
        assert!(
            s[0].command.last().unwrap().contains("agent:"),
            "{:?}",
            s[0].command
        );
        assert!(
            !s[0].command.last().unwrap().contains("'hi'"),
            "the first prompt is not replayed"
        );
        assert_eq!(mgr2.session(&ws.id).unwrap().restore.len(), 1);
        assert_eq!(
            mgr2.restore_after_restart(),
            0,
            "idempotent while terminals live"
        );
    }

    #[tokio::test]
    async fn closing_a_tab_stops_restoring_it() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        let ws = mgr
            .create_session(SessionCreate {
                project_id: r.id.clone(),
                name: Some("t".into()),
                branch: None,
                from: None,
                existing_branch: false,
                agent: Some("fake".into()),
                prompt: None,
                cols: 80,
                rows: 24,
                model: None,
                effort: None,
                mode: None,
                pr: None,
                tui: false,
                cloud: false,
                spawned_by: None,
                add_dirs: vec![],
                workspace_id: None,
                task: None,
                worktree: None,
                design: None,
            })
            .await
            .unwrap();
        let id = ws.restore[0].terminal.unwrap();
        mgr.terminals.kill(id, true).unwrap();
        for _ in 0..100 {
            if mgr.session(&ws.id).unwrap().restore.is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        panic!("restore entry not dropped");
    }

    #[tokio::test]
    async fn agent_commands_resume_where_supported() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        assert_eq!(
            mgr.agent_command(&r, "claude", Some("fix it"), false, None),
            "claude 'fix it'"
        );
        assert_eq!(
            mgr.agent_command(&r, "claude", Some("fix it"), true, None),
            "claude --continue"
        );
        assert_eq!(
            mgr.agent_command(&r, "codex", None, true, None),
            "codex resume --last"
        );
        assert!(
            mgr.agent_command(&r, "fake", None, false, None)
                .starts_with("sh -c")
        );
    }

    #[tokio::test]
    async fn exited_sessions_are_not_restored() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        let ws = mgr
            .create_session(SessionCreate {
                project_id: r.id.clone(),
                name: Some("t".into()),
                branch: None,
                from: None,
                existing_branch: false,
                agent: Some("none".into()),
                prompt: None,
                cols: 80,
                rows: 24,
                model: None,
                effort: None,
                mode: None,
                pr: None,
                tui: false,
                cloud: false,
                spawned_by: None,
                add_dirs: vec![],
                workspace_id: None,
                task: None,
                worktree: None,
                design: None,
            })
            .await
            .unwrap();
        assert_eq!(ws.restore.len(), 1, "the shell is restorable");
        let id = ws.restore[0].terminal.unwrap();
        mgr.terminals.write(id, b"exit\n".to_vec()).unwrap();
        for _ in 0..200 {
            if mgr.session(&ws.id).unwrap().restore.is_empty() {
                assert!(
                    mgr.terminals.get(id).is_some(),
                    "exited session stays visible"
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        panic!("exited shell still scheduled for restore");
    }

    #[tokio::test]
    async fn a_corrupt_state_file_is_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        std::fs::write(&file, "{ not json").unwrap();
        let terms = TerminalManager::new(dir.path().join("s.sock"), BTreeMap::new());
        let mgr = SessionManager::load(file.clone(), dir.path().join("wt"), terms);
        assert!(mgr.list_projects().is_empty());
        let kept: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("corrupt"))
            .collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(std::fs::read_to_string(kept[0].path()).unwrap(), "{ not json");
    }

    #[tokio::test]
    async fn a_state_file_with_invalid_utf8_is_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        std::fs::write(&file, b"{\"projects\": [\xff]}").unwrap();
        let terms = TerminalManager::new(dir.path().join("s.sock"), BTreeMap::new());
        let _mgr = SessionManager::load(file.clone(), dir.path().join("wt"), terms);
        let kept = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("corrupt"))
            .count();
        assert_eq!(kept, 1);
    }

    /// Loads a state file the way the daemon does at start.
    fn load_state(text: &str) -> (tempfile::TempDir, Arc<SessionManager>) {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("state.json"), text).unwrap();
        let mgr = SessionManager::load(home.path().join("state.json"), home.path().join("worktrees"), TerminalManager::new(home.path().join("s.sock"), BTreeMap::new()));
        (home, mgr)
    }

    #[tokio::test]
    async fn migrates_pre_rename_state() {
        let old = r#"{"repos":[{"id":"p1","name":"api","path":"/r/api","base_branch":"main"}],
            "workspaces":[{"id":"s1","repo_id":"p1","name":"Fix","branch":"moonlet/fix","base":"main","path":"/w/fix",
            "agent":"claude","archived":false,"created_at":1,"sessions":[3],"layout":null,
            "restore":[{"kind":"agent","title":"claude","cwd":"/w/fix","command":["zsh"],"agent":"claude","session":3}]}]}"#;
        let (home, mgr) = load_state(old);
        let sessions = mgr.list_sessions();
        assert_eq!(mgr.list_projects().len(), 1);
        assert_eq!(sessions[0].project_id, "p1");
        assert_eq!(sessions[0].restore[0].terminal, Some(3));
        let ws = mgr.list_workspaces();
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].name, "Personal");
        let secs = mgr.list_sections();
        assert_eq!(secs.len(), 1);
        assert_eq!(secs[0].name, "My projects");
        assert_eq!(secs[0].project_ids, vec!["p1".to_string()]);
        assert_eq!(sessions[0].workspace_id.as_deref(), Some(ws[0].id.as_str()));
        // Loaded again, the migrated file reads the same.
        mgr.create_section(&ws[0].id, "Side projects").unwrap();
        let again = SessionManager::load(home.path().join("state.json"), home.path().join("worktrees"), TerminalManager::new(home.path().join("s2.sock"), BTreeMap::new()));
        assert_eq!(again.list_workspaces()[0].id, ws[0].id);
    }

    /// X32: the X5 workspaces become sections of one workspace, "Personal";
    /// the X5 session sections are dropped.
    #[tokio::test]
    async fn migrates_x5_workspaces_into_sections() {
        let x5 = r#"{"version":2,
            "workspaces":[
              {"id":"w1","name":"1devstudio","project_ids":["p1","p2"],"sections":[],
               "view":{"group_by":"project","sort_by":"recent","filter":[]},"created_at":1},
              {"id":"w2","name":"Acme","project_ids":["p2","p3"],"sections":[{"id":"w2:a","name":"Today"}],
               "view":{"group_by":"status","sort_by":"name","filter":["p3"]},"created_at":2}],
            "projects":[
              {"id":"p1","name":"jaunt","path":"/r/jaunt","base_branch":"main"},
              {"id":"p2","name":"shared","path":"/r/shared","base_branch":"main"},
              {"id":"p3","name":"acme-api","path":"/r/acme-api","base_branch":"develop"}],
            "sessions":[
              {"id":"s1","project_id":"p1","name":"Fix","branch":"moonlet/fix","base":"main","path":"/w/fix",
               "agent":"claude","archived":false,"created_at":3,"section":null},
              {"id":"s2","project_id":"p3","name":"Deploy","branch":"moonlet/deploy","base":"develop","path":"/w/deploy",
               "agent":"claude","archived":false,"created_at":4,"section":"w2:a"}]}"#;
        let (home, mgr) = load_state(x5);
        let ws = mgr.list_workspaces();
        assert_eq!(ws.len(), 1);
        let personal = &ws[0];
        assert_eq!(personal.name, "Personal");
        assert_eq!(personal.color, WorkspaceColor::Clay);
        assert_eq!(personal.section_ids, vec!["w1".to_string(), "w2".to_string()]);
        let secs = mgr.list_sections();
        let names: Vec<&str> = secs.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["1devstudio", "Acme"]);
        assert_eq!(secs[1].project_ids, vec!["p2".to_string(), "p3".to_string()]);
        assert_eq!(secs[1].view.group_by, "status");
        assert_eq!(secs[1].view.filter, vec!["p3".to_string()]);
        for s in mgr.list_sessions() {
            assert_eq!(s.workspace_id.as_deref(), Some(personal.id.as_str()), "{}", s.id);
        }
        // The session in X5's "Today" section is in no section now: it shows
        // under its project, and loading the file again changes nothing.
        mgr.create_section(&personal.id, "Side projects").unwrap();
        let again = SessionManager::load(home.path().join("state.json"), home.path().join("worktrees"), TerminalManager::new(home.path().join("s2.sock"), BTreeMap::new()));
        assert_eq!(again.list_workspaces()[0].section_ids.len(), 3);
        assert_eq!(again.list_sessions().len(), 2);
    }

    /// A shell-only session: the X32 tests need sessions, not agents.
    fn new_session(project: &str, workspace: Option<&str>) -> SessionCreate {
        let mut req = spawn_req(project, "Keep me", None, None);
        req.workspace_id = workspace.map(Into::into);
        req
    }

    fn workspace(mgr: &SessionManager, name: &str, move_sections: Vec<String>) -> Workspace {
        mgr.create_workspace(WorkspaceCreate { name: name.into(), color: WorkspaceColor::Blue, move_sections, claude_profile: None })
            .unwrap()
    }

    fn section_names(mgr: &SessionManager, ws: &Workspace) -> Vec<String> {
        let ws = mgr.list_workspaces().into_iter().find(|w| w.id == ws.id).unwrap();
        let all = mgr.list_sections();
        ws.section_ids
            .iter()
            .map(|id| all.iter().find(|s| &s.id == id).unwrap().name.clone())
            .collect()
    }

    #[tokio::test]
    async fn new_project_added_to_a_section_lands_only_there() {
        let (repo, _home, mgr) = setup().await;
        let first = mgr.list_sections()[0].clone();
        let ws = mgr.list_workspaces()[0].clone();
        let work = mgr.create_section(&ws.id, "Acme").unwrap();
        let r = mgr
            .section_add_project(&work.id, &repo.path().display().to_string())
            .await
            .unwrap();
        let names: Vec<String> = mgr
            .list_sections()
            .into_iter()
            .filter(|s| s.project_ids.contains(&r.id))
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["Acme".to_string()]);
        assert_eq!(first.name, "My projects");
    }

    #[tokio::test]
    async fn removing_a_shared_project_detaches_it_from_one_section() {
        let (repo, _home, mgr) = setup().await;
        let ws = mgr.list_workspaces()[0].clone();
        let first = mgr.list_sections()[0].clone();
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        let work = mgr.create_section(&ws.id, "Acme").unwrap();
        mgr.section_add_project(&work.id, &repo.path().display().to_string())
            .await
            .unwrap();
        mgr.section_remove_project(&first.id, &r.id).unwrap();
        let names: Vec<String> = mgr
            .list_sections()
            .into_iter()
            .filter(|s| s.project_ids.contains(&r.id))
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["Acme".to_string()]);
        assert_eq!(mgr.list_projects().len(), 1, "the project is kept");
    }

    #[tokio::test]
    async fn removing_a_project_from_its_last_section_drops_it() {
        let (repo, _home, mgr) = setup().await;
        let first = mgr.list_sections()[0].clone();
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        mgr.section_remove_project(&first.id, &r.id).unwrap();
        assert!(mgr.list_projects().is_empty());
        assert!(mgr.list_sections()[0].project_ids.is_empty());
    }

    #[tokio::test]
    async fn removing_a_project_a_section_does_not_hold_changes_nothing() {
        let (repo, _home, mgr) = setup().await;
        let ws = mgr.list_workspaces()[0].clone();
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        let empty = mgr.create_section(&ws.id, "Acme").unwrap();
        let err = mgr.section_remove_project(&empty.id, &r.id).unwrap_err();
        assert_eq!(err.to_string(), "the project is not in this section");
        assert_eq!(mgr.list_projects().len(), 1);
        assert_eq!(mgr.list_sections()[0].project_ids, vec![r.id.clone()]);
    }

    #[tokio::test]
    async fn a_project_with_live_sessions_stays_in_its_last_section() {
        let (repo, _home, mgr) = setup().await;
        let first = mgr.list_sections()[0].clone();
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        mgr.create_session(new_session(&r.id, None)).await.unwrap();
        let err = mgr.section_remove_project(&first.id, &r.id).unwrap_err();
        assert_eq!(err.to_string(), "archive this project's sessions first");
        assert_eq!(mgr.list_sections()[0].project_ids, vec![r.id.clone()]);
        assert_eq!(mgr.list_projects().len(), 1);
    }

    /// X32: a project held by sections of two workspaces has sessions in
    /// each, and a session goes where it is asked to.
    #[tokio::test]
    async fn sessions_belong_to_the_workspace_they_are_created_in() {
        let (repo, _home, mgr) = setup().await;
        let personal = mgr.list_workspaces()[0].clone();
        let path = repo.path().display().to_string();
        let r = mgr.add_project(&path).await.unwrap();
        let work = workspace(&mgr, "Acme", vec![]);
        let sec = mgr.create_section(&work.id, "AI Operations").unwrap();
        mgr.section_add_project(&sec.id, &path).await.unwrap();

        let here = mgr.create_session(new_session(&r.id, Some(&work.id))).await.unwrap();
        assert_eq!(here.workspace_id.as_deref(), Some(work.id.as_str()));
        let default = mgr.create_session(new_session(&r.id, None)).await.unwrap();
        assert_eq!(
            default.workspace_id.as_deref(),
            Some(personal.id.as_str()),
            "without a workspace, the first one holding the project"
        );
        let empty = workspace(&mgr, "Empty", vec![]);
        let err = mgr
            .create_session(new_session(&r.id, Some(&empty.id)))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "the project is not in this workspace");
    }

    /// X32: moving a section takes the sessions of the projects only it held
    /// in its old workspace, and leaves the others.
    #[tokio::test]
    async fn moving_a_section_takes_sessions_it_alone_holds() {
        let (repo, _home, mgr) = setup().await;
        let personal = mgr.list_workspaces()[0].clone();
        let path = repo.path().display().to_string();
        let r = mgr.add_project(&path).await.unwrap();
        let alone = mgr.list_sections()[0].clone();
        let s = mgr.create_session(new_session(&r.id, None)).await.unwrap();

        let work = workspace(&mgr, "Acme", vec![alone.id.clone()]);
        assert_eq!(section_names(&mgr, &work), vec!["My projects".to_string()]);
        assert!(section_names(&mgr, &personal).is_empty());
        assert_eq!(mgr.session(&s.id).unwrap().workspace_id.as_deref(), Some(work.id.as_str()));

        // Back in Personal, a second section holds the project too: moving
        // the first one away leaves the session behind.
        mgr.move_section(&alone.id, &personal.id).unwrap();
        let kept = mgr.create_section(&personal.id, "Side projects").unwrap();
        mgr.section_add_project(&kept.id, &path).await.unwrap();
        mgr.move_section(&alone.id, &work.id).unwrap();
        assert_eq!(mgr.session(&s.id).unwrap().workspace_id.as_deref(), Some(personal.id.as_str()));
    }

    #[tokio::test]
    async fn a_workspace_is_deleted_only_when_empty_and_not_last() {
        let (_repo, _home, mgr) = setup().await;
        let personal = mgr.list_workspaces()[0].clone();
        let err = mgr.delete_workspace(&personal.id).unwrap_err();
        assert_eq!(err.to_string(), "the last workspace cannot be deleted");
        let sec = mgr.list_sections()[0].clone();
        let work = workspace(&mgr, "Acme", vec![sec.id.clone()]);
        let err = mgr.delete_workspace(&work.id).unwrap_err();
        assert_eq!(err.to_string(), "move or delete this workspace's sections first");
        mgr.move_section(&sec.id, &personal.id).unwrap();
        mgr.delete_workspace(&work.id).unwrap();
        assert_eq!(mgr.list_workspaces().len(), 1);
    }

    /// A request that fails half-way changes nothing, in memory or on disk.
    #[tokio::test]
    async fn a_failed_workspace_create_leaves_nothing_behind() {
        let (_repo, home, mgr) = setup().await;
        let sec = mgr.list_sections()[0].id.clone();
        let err = mgr
            .create_workspace(WorkspaceCreate { name: "Acme".into(), color: WorkspaceColor::Blue, move_sections: vec![sec.clone(), "gone".into()], claude_profile: None })
            .unwrap_err();
        assert_eq!(err.to_string(), "no such section");
        let names: Vec<String> = mgr.list_workspaces().into_iter().map(|w| w.name).collect();
        assert_eq!(names, vec!["Personal".to_string()]);
        assert_eq!(mgr.list_workspaces()[0].section_ids, vec![sec]);
        // A later successful change does not write the half-made workspace either.
        mgr.create_section(&mgr.list_workspaces()[0].id, "Side projects").unwrap();
        let reloaded = SessionManager::load(home.path().join("state.json"), home.path().join("worktrees"), TerminalManager::new(home.path().join("s2.sock"), BTreeMap::new()));
        let names: Vec<String> = reloaded.list_workspaces().into_iter().map(|w| w.name).collect();
        assert_eq!(names, vec!["Personal".to_string()]);
    }

    #[tokio::test]
    async fn workspace_names_cannot_be_emptied() {
        let (_repo, _home, mgr) = setup().await;
        let ws = mgr.list_workspaces()[0].id.clone();
        let err = mgr.update_workspace(WorkspaceUpdate { id: ws, name: Some("  ".into()), color: None, section_ids: None, claude_profile: None }).unwrap_err();
        assert_eq!(err.to_string(), "workspace name is empty");
        assert_eq!(mgr.list_workspaces()[0].name, "Personal");
    }

    /// `workspace.update {section_ids}` reorders, and moves in sections of
    /// other workspaces with their sessions; it never drops one.
    #[tokio::test]
    async fn updating_a_workspaces_sections_reorders_and_moves_them_in() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let personal = mgr.list_workspaces()[0].clone();
        let mine = personal.section_ids[0].clone();
        let s = mgr.create_session(new_session(&r.id, None)).await.unwrap();
        let work = workspace(&mgr, "Acme", vec![]);
        let ops = mgr.create_section(&work.id, "AI Operations").unwrap();

        let updated = mgr
            .update_workspace(WorkspaceUpdate { id: work.id.clone(), name: None, color: None, section_ids: Some(vec![mine.clone(), ops.id.clone()]), claude_profile: None })
            .unwrap();
        assert_eq!(updated.section_ids, vec![mine.clone(), ops.id.clone()]);
        assert!(section_names(&mgr, &personal).is_empty());
        assert_eq!(mgr.session(&s.id).unwrap().workspace_id.as_deref(), Some(work.id.as_str()));

        let reordered = mgr
            .update_workspace(WorkspaceUpdate { id: work.id.clone(), name: None, color: None, section_ids: Some(vec![ops.id.clone(), mine.clone()]), claude_profile: None })
            .unwrap();
        assert_eq!(reordered.section_ids, vec![ops.id.clone(), mine.clone()]);
        let err = mgr
            .update_workspace(WorkspaceUpdate { id: work.id.clone(), name: None, color: None, section_ids: Some(vec![ops.id.clone()]), claude_profile: None })
            .unwrap_err();
        assert_eq!(err.to_string(), "section_ids must keep this workspace's sections: move or delete a section instead");
    }

    async fn archive(mgr: &SessionManager, s: &Session) {
        mgr.archive(SessionArchive { id: s.id.clone(), remove_worktree: true, delete_branch: false, delete_remote: false }).await.unwrap();
    }

    /// X5's rule per workspace: a project leaves a workspace's last section
    /// holding it only once its sessions there are archived.
    #[tokio::test]
    async fn a_project_with_live_sessions_stays_in_its_workspace() {
        let (repo, _home, mgr) = setup().await;
        let path = repo.path().display().to_string();
        let r = mgr.add_project(&path).await.unwrap();
        let mine = mgr.list_sections()[0].clone();
        let work = workspace(&mgr, "Acme", vec![]);
        let ops = mgr.create_section(&work.id, "AI Operations").unwrap();
        mgr.section_add_project(&ops.id, &path).await.unwrap();
        let s = mgr.create_session(new_session(&r.id, Some(&work.id))).await.unwrap();

        let err = mgr.section_remove_project(&ops.id, &r.id).unwrap_err();
        assert_eq!(err.to_string(), "archive this project's sessions in this workspace first");
        // Personal has no live session of it, so it can let the project go.
        mgr.section_remove_project(&mine.id, &r.id).unwrap();
        archive(&mgr, &s).await;
        let err = mgr.section_remove_project(&ops.id, &r.id);
        assert!(err.is_ok(), "{err:?}");
        assert!(mgr.list_projects().is_empty(), "no section holds it any more");
    }

    /// Archived sessions follow their project when their workspace goes, so
    /// a restored session always shows somewhere.
    #[tokio::test]
    async fn archived_sessions_move_to_a_workspace_holding_their_project() {
        let (repo, _home, mgr) = setup().await;
        let path = repo.path().display().to_string();
        let r = mgr.add_project(&path).await.unwrap();
        let personal = mgr.list_workspaces()[0].clone();
        let mine = mgr.list_sections()[0].clone();
        let work = workspace(&mgr, "Acme", vec![]);
        let ops = mgr.create_section(&work.id, "AI Operations").unwrap();
        mgr.section_add_project(&ops.id, &path).await.unwrap();
        let s = mgr.create_session(new_session(&r.id, Some(&work.id))).await.unwrap();
        archive(&mgr, &s).await;

        // The workspace's last section goes: the archived session follows
        // its project to Personal.
        mgr.delete_section(&ops.id).unwrap();
        assert_eq!(mgr.session(&s.id).unwrap().workspace_id.as_deref(), Some(personal.id.as_str()));
        mgr.delete_workspace(&work.id).unwrap();
        assert_eq!(mgr.session(&s.id).unwrap().workspace_id.as_deref(), Some(personal.id.as_str()));
        assert_eq!(mine.project_ids, vec![r.id.clone()]);
    }

    #[tokio::test]
    async fn workspace_names_are_checked_and_colours_change() {
        let (_repo, _home, mgr) = setup().await;
        let empty = mgr.create_workspace(WorkspaceCreate { name: "  ".into(), color: WorkspaceColor::Sand, move_sections: vec![], claude_profile: None });
        assert_eq!(empty.unwrap_err().to_string(), "workspace name is empty");
        let w = workspace(&mgr, "Acme", vec![]);
        let renamed = mgr
            .update_workspace(WorkspaceUpdate { id: w.id.clone(), name: Some("Acme Corp".into()), color: Some(WorkspaceColor::Violet), section_ids: None, claude_profile: None })
            .unwrap();
        assert_eq!((renamed.name.as_str(), renamed.color), ("Acme Corp", WorkspaceColor::Violet));
    }

    /// Deleting a section keeps its projects: they move to another section of
    /// the workspace, with their sessions still shown there.
    #[tokio::test]
    async fn deleting_a_section_keeps_projects_and_sessions() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr.add_project(&repo.path().display().to_string()).await.unwrap();
        let first = mgr.list_sections()[0].clone();
        let work = workspace(&mgr, "Acme", vec![first.id.clone()]);
        let s = mgr.create_session(new_session(&r.id, None)).await.unwrap();
        let err = mgr.delete_section(&first.id).unwrap_err();
        assert_eq!(err.to_string(), "archive the sessions of this section's projects first");
        let other = mgr.create_section(&work.id, "Integrations").unwrap();
        mgr.delete_section(&first.id).unwrap();
        assert_eq!(section_names(&mgr, &work), vec!["Integrations".to_string()]);
        let other = mgr.list_sections().into_iter().find(|s| s.id == other.id).unwrap();
        assert_eq!(other.project_ids, vec![r.id.clone()]);
        assert_eq!(mgr.session(&s.id).unwrap().workspace_id.as_deref(), Some(work.id.as_str()));
    }

    #[test]
    fn names_and_agent_flags() {
        assert_eq!(derive_name(None, None), "Untitled");
        assert_eq!(derive_name(Some("  Mine "), Some("x")), "Mine");
        let long = "Refactor the authentication flow so that sessions survive token refresh";
        let n = derive_name(None, Some(long));
        assert!(n.ends_with('…') && n.chars().count() <= 49, "{n}");
        let s = Session {
            id: "s".into(),
            project_id: "p".into(),
            name: "it's fine".into(),
            branch: "b".into(),
            base: "main".into(),
            path: "/w".into(),
            agent: Some("claude".into()),
            archived: false,
            created_at: 0,
            workspace_id: None,
            model: Some("sonnet".into()),
            effort: Some("high".into()),
            mode: Some("plan".into()),
            pr: None,
            spawned_by: None,
            task: None,
            task_unlinked: false,
            cloud: false,
            terminals: vec![],
            layout: serde_json::Value::Null,
            restore: vec![],
            owner: None,
        };
        assert_eq!(
            agent_flags("claude", &s),
            " --model 'sonnet' --effort 'high' --permission-mode 'plan' -n 'it'\\''s fine'"
        );
        assert_eq!(
            agent_flags("codex", &s),
            " -m 'sonnet' -c 'model_reasoning_effort=high'"
        );
        assert_eq!(agent_flags("my-agent --x", &s), "");
    }

    #[test]
    fn config_parsing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_config(dir.path()), ProjectConfig::default());
        std::fs::create_dir(dir.path().join(".moonlet")).unwrap();
        std::fs::write(
            dir.path().join(".moonlet/config.toml"),
            "run = \"npm run dev\"\nbase_branch = \"develop\"\n",
        )
        .unwrap();
        let c = read_config(dir.path());
        assert_eq!(c.run.as_deref(), Some("npm run dev"));
        assert_eq!(c.base_branch.as_deref(), Some("develop"));
    }
}
