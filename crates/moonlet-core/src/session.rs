//! Workspaces, projects and sessions (X5, A4, S4). A workspace is a named
//! set of projects; a project is a repo folder; a session is one task: a git
//! worktree on its own branch plus the terminals running in it. State is
//! persisted to `~/.moonlet/state.json` so it survives daemon restarts.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use moonlet_proto::methods::{
    self, SessionArchive, SessionCreate, SessionUpdate, TerminalCreate, WorkspaceUpdate,
};
use moonlet_proto::types::{
    Project, ProjectConfig, ProjectConfigFile, PullRequest, RestoreEntry, Session, TerminalInfo, TerminalKind,
    Workspace, WorkspaceView,
};
use moonlet_proto::{Message, TerminalId};
use serde::{Deserialize, Serialize};

use crate::git;
use crate::paths::now_ms;
use crate::pty::user_shell;
use crate::terminal::{TerminalManager, expand_home};

const STATE_VERSION: u32 = 2;
pub const DEFAULT_WORKSPACE: &str = "My workspaces";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub sessions: Vec<Session>,
}

impl State {
    /// Reads `state.json`, migrating the pre-ADR-0005 layout where `repos`
    /// were projects and `workspaces` were what are now sessions.
    pub fn parse(text: &str) -> State {
        Self::try_parse(text).unwrap_or_else(|_| {
            let mut st = State {
                version: STATE_VERSION,
                ..Default::default()
            };
            st.ensure_workspace();
            st
        })
    }

    /// Parses (and migrates) a state file; fails on unreadable JSON instead
    /// of silently starting empty.
    pub fn try_parse(text: &str) -> Result<State, serde_json::Error> {
        let mut v = serde_json::from_str::<serde_json::Value>(text)?;
        if v.get("version").and_then(|x| x.as_u64()).unwrap_or(0) < 2
            && let Some(obj) = v.as_object_mut()
        {
            let repos = obj.remove("repos").unwrap_or(serde_json::json!([]));
            let tasks = obj.remove("workspaces").unwrap_or(serde_json::json!([]));
            obj.insert("projects".into(), repos);
            obj.insert("sessions".into(), tasks);
        }
        let mut st: State = serde_json::from_value(v)?;
        st.version = STATE_VERSION;
        st.ensure_workspace();
        Ok(st)
    }

    /// There is always at least one workspace; projects nobody groups land
    /// in the first one so nothing disappears from the sidebar.
    /// Forgets a project, its archived sessions and its workspace entries.
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
        for w in &mut self.workspaces {
            w.project_ids.retain(|p| p != id);
        }
        Ok(())
    }

    fn ensure_workspace(&mut self) {
        if self.workspaces.is_empty() {
            self.workspaces.push(Workspace {
                id: new_id(),
                name: DEFAULT_WORKSPACE.into(),
                project_ids: Vec::new(),
                sections: Vec::new(),
                view: WorkspaceView::default(),
                created_at: now_ms(),
            });
        }
        let orphans: Vec<String> = self
            .projects
            .iter()
            .filter(|p| {
                !self
                    .workspaces
                    .iter()
                    .any(|w| w.project_ids.contains(&p.id))
            })
            .map(|p| p.id.clone())
            .collect();
        self.workspaces[0].project_ids.extend(orphans);
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
        });
        tokio::spawn(track_removed_sessions(Arc::downgrade(&mgr)));
        mgr
    }

    pub fn set_chats(&self, chats: Arc<crate::chat::runtime::ChatManager>) {
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

    fn mutate<T>(&self, f: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        let mut st = self.state.lock().unwrap();
        let out = f(&mut st)?;
        self.save(&st)?;
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

    pub fn list_workspaces(&self) -> Vec<Workspace> {
        self.state.lock().unwrap().workspaces.clone()
    }

    pub fn create_workspace(&self, name: &str) -> Result<Workspace> {
        let name = name.trim();
        if name.is_empty() {
            bail!("workspace name is empty");
        }
        let ws = Workspace {
            id: new_id(),
            name: name.to_string(),
            project_ids: Vec::new(),
            sections: Vec::new(),
            view: WorkspaceView::default(),
            created_at: now_ms(),
        };
        let out = ws.clone();
        self.mutate(|st| {
            st.workspaces.push(ws);
            Ok(())
        })?;
        self.emit_workspaces();
        Ok(out)
    }

    pub fn update_workspace(&self, req: WorkspaceUpdate) -> Result<Workspace> {
        let out = self.mutate(|st| {
            let known: Vec<String> = st.projects.iter().map(|p| p.id.clone()).collect();
            let w = st
                .workspaces
                .iter_mut()
                .find(|w| w.id == req.id)
                .context("no such workspace")?;
            if let Some(n) = req.name.filter(|n| !n.trim().is_empty()) {
                w.name = n.trim().to_string();
            }
            if let Some(ids) = req.project_ids {
                w.project_ids = ids.into_iter().filter(|id| known.contains(id)).collect();
            }
            if let Some(sections) = req.sections {
                let ids: Vec<String> = sections.iter().map(|s| s.id.clone()).collect();
                w.sections = sections;
                // Sessions in a removed section fall back to their project.
                for s in &mut st.sessions {
                    if s.section.as_ref().is_some_and(|sec| {
                        sec.starts_with(&format!("{}:", req.id)) && !ids.contains(sec)
                    }) {
                        s.section = None;
                    }
                }
            }
            if let Some(view) = req.view {
                w.view = view;
            }
            Ok(st
                .workspaces
                .iter()
                .find(|w| w.id == req.id)
                .cloned()
                .unwrap())
        })?;
        self.emit_workspaces();
        self.emit_sessions();
        Ok(out)
    }

    /// Deletes the grouping only; projects and sessions stay.
    pub fn delete_workspace(&self, id: &str) -> Result<()> {
        self.mutate(|st| {
            if st.workspaces.len() == 1 {
                bail!("the last workspace cannot be deleted");
            }
            st.workspaces.retain(|w| w.id != id);
            st.ensure_workspace();
            Ok(())
        })?;
        self.emit_workspaces();
        Ok(())
    }

    /// Adds a project (or finds it) and attaches it to a workspace.
    pub async fn workspace_add_project(&self, id: &str, path: &str) -> Result<Project> {
        self.add_project_to(path, Some(id)).await
    }

    /// Detaches a project from a workspace. A project no other workspace
    /// holds is removed from moonlet, which needs its sessions archived first.
    pub fn workspace_remove_project(&self, id: &str, project_id: &str) -> Result<()> {
        let dropped = self.mutate(|st| {
            let i = st
                .workspaces
                .iter()
                .position(|w| w.id == id)
                .context("no such workspace")?;
            if !st.workspaces[i].project_ids.iter().any(|p| p == project_id) {
                bail!("the project is not in this workspace");
            }
            let elsewhere = st
                .workspaces
                .iter()
                .any(|w| w.id != id && w.project_ids.iter().any(|p| p == project_id));
            if elsewhere {
                st.workspaces[i].project_ids.retain(|p| p != project_id);
            } else {
                st.drop_project(project_id)?;
            }
            Ok(!elsewhere)
        })?;
        self.emit_workspaces();
        if dropped {
            self.terminals.emit(Message::event(
                methods::EV_PROJECTS_CHANGED,
                self.list_projects(),
            ));
        }
        Ok(())
    }

    pub async fn add_project(&self, path: &str) -> Result<Project> {
        self.add_project_to(path, None).await
    }

    /// A new project joins `workspace` in the same update, so the orphan
    /// sweep in `ensure_workspace` does not also file it under the first one.
    async fn add_project_to(&self, path: &str, workspace: Option<&str>) -> Result<Project> {
        let root = git::toplevel(&expand_home(path)).await?;
        let root_s = root.display().to_string();
        if let Some(r) = self.list_projects().into_iter().find(|r| r.path == root_s) {
            if let Some(id) = workspace {
                self.mutate(|st| {
                    let w = st
                        .workspaces
                        .iter_mut()
                        .find(|w| w.id == id)
                        .context("no such workspace")?;
                    if !w.project_ids.contains(&r.id) {
                        w.project_ids.push(r.id.clone());
                    }
                    Ok(())
                })?;
                self.emit_workspaces();
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
        };
        let r = repo.clone();
        self.mutate(|st| {
            if let Some(id) = workspace {
                st.workspaces
                    .iter_mut()
                    .find(|w| w.id == id)
                    .context("no such workspace")?
                    .project_ids
                    .push(r.id.clone());
            }
            st.projects.push(r);
            st.ensure_workspace();
            Ok(())
        })?;
        self.emit_workspaces();
        self.terminals.emit(Message::event(
            methods::EV_PROJECTS_CHANGED,
            self.list_projects(),
        ));
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
        BTreeMap::from([
            ("MOONLET_ROOT_PATH".into(), repo.path.clone()),
            ("MOONLET_SESSION_PATH".into(), ws.path.clone()),
            ("MOONLET_SESSION_NAME".into(), ws.name.clone()),
            ("MOONLET_BRANCH".into(), ws.branch.clone()),
        ])
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
                env: req.env.clone(),
                add_dirs: req.add_dirs.clone(),
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
        TerminalCreate {
            cwd: ws.path.clone(),
            command: vec![
                user_shell(),
                "-lic".into(),
                self.agent_command(repo, agent, prompt, resume, Some(ws)),
            ],
            cols,
            rows,
            kind: TerminalKind::Agent,
            title: Some(agent.to_string()),
            agent: Some(agent.to_string()),
            ..Default::default()
        }
    }

    pub async fn create_session(&self, req: SessionCreate) -> Result<Session> {
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
        let slug = git::slug(&name);
        let existing_branches = git::branches(&repo_path).await.unwrap_or_default();
        let branch = if req.existing_branch {
            let b = req
                .branch
                .clone()
                .context("existing_branch needs a branch name")?;
            b.strip_prefix("origin/").map(String::from).unwrap_or(b)
        } else {
            let wanted = req
                .branch
                .clone()
                .unwrap_or_else(|| format!("moonlet/{slug}"));
            unique(&wanted, |b| existing_branches.iter().any(|e| e == b))
        };
        let dir = {
            let base = self.worktrees_root.join(&repo.name);
            let name = unique(&slug, |n| base.join(n).exists());
            base.join(name)
        };
        let from = req.from.clone().unwrap_or_else(|| repo.base_branch.clone());
        git::worktree_add(&repo_path, &dir, &branch, &from, req.existing_branch).await?;

        let config = read_config(&repo_path);
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
            base: if req.existing_branch {
                repo.base_branch.clone()
            } else {
                from.trim_start_matches("origin/").to_string()
            },
            path: dir.display().to_string(),
            agent: agent.clone(),
            archived: false,
            created_at: now_ms(),
            section: None,
            model: req.model.clone().filter(|m| !m.is_empty()),
            effort: req.effort.clone().filter(|e| !e.is_empty()),
            mode: req.mode.clone(),
            // A session opened from a PR is that PR's session.
            pr: req.pr,
            spawned_by: parent.as_ref().and_then(|p| p.session_id.clone()),
            terminals: vec![],
            layout: serde_json::Value::Null,
            restore: vec![],
        };
        let w = ws.clone();
        self.mutate(|st| {
            st.sessions.push(w);
            Ok(())
        })?;

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

    pub async fn archive(&self, req: SessionArchive) -> Result<()> {
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
        if req.delete_branch {
            git::delete_branch(Path::new(&repo.path), &ws.branch).await?;
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
        Ok(())
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
            if let Some(sec) = req.section {
                w.section = (!sec.is_empty()).then_some(sec);
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
                        let mut r = self.agent_session(&ws, &repo, agent, None, true, 120, 32);
                        r.title = Some(entry.title.clone());
                        r
                    }
                    _ => TerminalCreate {
                        cwd: entry.cwd.clone(),
                        command: entry.command.clone(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

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
            spawned_by: None,
            add_dirs: vec![],
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
                spawned_by: None,
                add_dirs: vec![],
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
            .archive(SessionArchive { id: s.id.clone(), remove_worktree: true, delete_branch: true })
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
                spawned_by: None,
                add_dirs: vec![],
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
            project_id: project_id.into(),
            name: Some(name.into()),
            branch: None,
            from: None,
            existing_branch: false,
            agent: Some("none".into()),
            prompt: None,
            cols: 80,
            rows: 24,
            model: None,
            effort: None,
            mode: mode.map(Into::into),
            pr: None,
            tui: false,
            spawned_by,
            add_dirs: vec![],
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
                    spawned_by: None,
                    add_dirs: vec![],
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
                spawned_by: None,
                add_dirs: vec![],
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
                spawned_by: None,
                add_dirs: vec![],
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
                spawned_by: None,
                add_dirs: vec![],
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
                spawned_by: None,
                add_dirs: vec![],
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
                spawned_by: None,
                add_dirs: vec![],
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

    #[test]
    fn migrates_pre_rename_state() {
        let old = r#"{"repos":[{"id":"p1","name":"api","path":"/r/api","base_branch":"main"}],
            "workspaces":[{"id":"s1","repo_id":"p1","name":"Fix","branch":"moonlet/fix","base":"main","path":"/w/fix",
            "agent":"claude","archived":false,"created_at":1,"sessions":[3],"layout":null,
            "restore":[{"kind":"agent","title":"claude","cwd":"/w/fix","command":["zsh"],"agent":"claude","session":3}]}]}"#;
        let st = State::parse(old);
        assert_eq!(st.version, STATE_VERSION);
        assert_eq!(st.projects.len(), 1);
        assert_eq!(st.sessions[0].project_id, "p1");
        assert_eq!(st.sessions[0].terminals, vec![3]);
        assert_eq!(st.sessions[0].restore[0].terminal, Some(3));
        assert_eq!(st.workspaces.len(), 1);
        assert_eq!(st.workspaces[0].name, DEFAULT_WORKSPACE);
        assert_eq!(st.workspaces[0].project_ids, vec!["p1".to_string()]);
        // Already-migrated files are read as they are.
        let again = State::parse(&serde_json::to_string(&st).unwrap());
        assert_eq!(again.workspaces.len(), 1);
        assert_eq!(again.workspaces[0].id, st.workspaces[0].id);
    }

    #[tokio::test]
    async fn new_project_added_to_a_workspace_lands_only_there() {
        let (repo, _home, mgr) = setup().await;
        let first = mgr.list_workspaces()[0].clone();
        let work = mgr.create_workspace("CipherHealth").unwrap();
        let r = mgr
            .workspace_add_project(&work.id, &repo.path().display().to_string())
            .await
            .unwrap();
        let all = mgr.list_workspaces();
        let names: Vec<&str> = all
            .iter()
            .filter(|w| w.project_ids.contains(&r.id))
            .map(|w| w.name.as_str())
            .collect();
        assert_eq!(names, vec!["CipherHealth"]);
        assert!(
            !all.iter()
                .find(|w| w.id == first.id)
                .unwrap()
                .project_ids
                .contains(&r.id)
        );
    }

    #[tokio::test]
    async fn removing_a_shared_project_detaches_it_from_one_workspace() {
        let (repo, _home, mgr) = setup().await;
        let first = mgr.list_workspaces()[0].clone();
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        let work = mgr.create_workspace("CipherHealth").unwrap();
        mgr.workspace_add_project(&work.id, &repo.path().display().to_string())
            .await
            .unwrap();
        mgr.workspace_remove_project(&first.id, &r.id).unwrap();
        let names: Vec<String> = mgr
            .list_workspaces()
            .into_iter()
            .filter(|w| w.project_ids.contains(&r.id))
            .map(|w| w.name)
            .collect();
        assert_eq!(names, vec!["CipherHealth".to_string()]);
        assert_eq!(mgr.list_projects().len(), 1, "the project is kept");
    }

    #[tokio::test]
    async fn removing_a_project_from_its_last_workspace_drops_it() {
        let (repo, _home, mgr) = setup().await;
        let first = mgr.list_workspaces()[0].clone();
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        mgr.workspace_remove_project(&first.id, &r.id).unwrap();
        assert!(mgr.list_projects().is_empty());
        assert!(mgr.list_workspaces()[0].project_ids.is_empty());
    }

    #[tokio::test]
    async fn removing_a_project_a_workspace_does_not_hold_changes_nothing() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        let empty = mgr.create_workspace("CipherHealth").unwrap();
        let err = mgr.workspace_remove_project(&empty.id, &r.id).unwrap_err();
        assert_eq!(err.to_string(), "the project is not in this workspace");
        assert_eq!(mgr.list_projects().len(), 1);
        assert_eq!(mgr.list_workspaces()[0].project_ids, vec![r.id.clone()]);
    }

    #[tokio::test]
    async fn a_project_with_live_sessions_stays_in_its_last_workspace() {
        let (repo, _home, mgr) = setup().await;
        let first = mgr.list_workspaces()[0].clone();
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        mgr.create_session(SessionCreate {
            project_id: r.id.clone(),
            name: None,
            branch: None,
            from: None,
            existing_branch: false,
            agent: Some("none".into()),
            prompt: Some("Keep me".into()),
            model: None,
            effort: None,
            mode: None,
            pr: None,
            tui: false,
            spawned_by: None,
            add_dirs: vec![],
            cols: 80,
            rows: 24,
        })
        .await
        .unwrap();
        let err = mgr.workspace_remove_project(&first.id, &r.id).unwrap_err();
        assert_eq!(err.to_string(), "archive this project's sessions first");
        assert_eq!(mgr.list_workspaces()[0].project_ids, vec![r.id.clone()]);
        assert_eq!(mgr.list_projects().len(), 1);
    }

    #[tokio::test]
    async fn workspaces_share_projects_and_sections() {
        let (repo, _home, mgr) = setup().await;
        let first = mgr.list_workspaces()[0].clone();
        let r = mgr
            .add_project(&repo.path().display().to_string())
            .await
            .unwrap();
        assert!(
            mgr.list_workspaces()[0].project_ids.contains(&r.id),
            "new projects land in the first workspace"
        );
        let work = mgr.create_workspace("Work").unwrap();
        mgr.workspace_add_project(&work.id, &repo.path().display().to_string())
            .await
            .unwrap();
        let all = mgr.list_workspaces();
        assert!(
            all.iter().all(|w| w.project_ids.contains(&r.id)),
            "shared by both"
        );

        let sec = moonlet_proto::types::Section {
            id: format!("{}:a", work.id),
            name: "Today".into(),
        };
        mgr.update_workspace(WorkspaceUpdate {
            id: work.id.clone(),
            name: None,
            project_ids: None,
            sections: Some(vec![sec.clone()]),
            view: None,
        })
        .unwrap();
        let s = mgr
            .create_session(SessionCreate {
                project_id: r.id.clone(),
                name: None,
                branch: None,
                from: None,
                existing_branch: false,
                agent: Some("none".into()),
                prompt: Some("Make the login page faster\nand more".into()),
                model: None,
                effort: None,
                mode: None,
                pr: None,
                tui: false,
                spawned_by: None,
                add_dirs: vec![],
                cols: 80,
                rows: 24,
            })
            .await
            .unwrap();
        assert_eq!(s.name, "Make the login page faster");
        assert_eq!(s.branch, "moonlet/make-the-login-page-faster");
        let moved = mgr
            .update(SessionUpdate {
                id: s.id.clone(),
                name: None,
                layout: None,
                section: Some(sec.id.clone()),
            })
            .unwrap();
        assert_eq!(moved.section.as_deref(), Some(sec.id.as_str()));
        // Removing the section returns the session to its project.
        mgr.update_workspace(WorkspaceUpdate {
            id: work.id.clone(),
            name: None,
            project_ids: None,
            sections: Some(vec![]),
            view: None,
        })
        .unwrap();
        assert_eq!(mgr.session(&s.id).unwrap().section, None);

        mgr.delete_workspace(&work.id).unwrap();
        assert!(
            mgr.delete_workspace(&first.id).is_err(),
            "the last workspace stays"
        );
        assert!(
            !mgr.list_projects().is_empty(),
            "deleting a workspace keeps projects"
        );
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
            section: None,
            model: Some("sonnet".into()),
            effort: Some("high".into()),
            mode: Some("plan".into()),
            pr: None,
            spawned_by: None,
            terminals: vec![],
            layout: serde_json::Value::Null,
            restore: vec![],
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
