//! Repos and workspaces (A4, S4). A workspace is one task: a git worktree
//! on its own branch plus the sessions running in it. State is persisted
//! to `~/.jaunt/state.json` so it survives daemon restarts.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use jaunt_proto::methods::{
    self, SessionCreate, WorkspaceArchive, WorkspaceCreate, WorkspaceUpdate,
};
use jaunt_proto::types::{Repo, RepoConfig, RestoreEntry, SessionInfo, SessionKind, Workspace};
use jaunt_proto::{Message, SessionId};
use serde::{Deserialize, Serialize};

use crate::git;
use crate::paths::now_ms;
use crate::pty::user_shell;
use crate::session::{SessionManager, expand_home};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub repos: Vec<Repo>,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
}

pub struct WorkspaceManager {
    state: Mutex<State>,
    file: PathBuf,
    worktrees_root: PathBuf,
    sessions: Arc<SessionManager>,
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

/// Built-in agent commands; `.jaunt/config.toml` `[agents]` adds more.
fn builtin_agent(name: &str, resume: bool) -> Option<&'static str> {
    match (name, resume) {
        ("claude", false) => Some("claude"),
        ("claude", true) => Some("claude --continue"),
        ("codex", false) => Some("codex"),
        ("codex", true) => Some("codex resume --last"),
        _ => None,
    }
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

impl WorkspaceManager {
    pub fn load(
        file: PathBuf,
        worktrees_root: PathBuf,
        sessions: Arc<SessionManager>,
    ) -> Arc<Self> {
        let state = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mgr = Arc::new(Self {
            state: Mutex::new(state),
            file,
            worktrees_root,
            sessions,
        });
        tokio::spawn(track_removed_sessions(Arc::downgrade(&mgr)));
        mgr
    }

    fn save(&self, state: &State) -> Result<()> {
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

    fn emit_workspaces(&self) {
        self.sessions.emit(Message::event(
            methods::EV_WORKSPACES_CHANGED,
            self.list_workspaces(),
        ));
    }

    pub fn list_repos(&self) -> Vec<Repo> {
        self.state.lock().unwrap().repos.clone()
    }

    pub fn list_workspaces(&self) -> Vec<Workspace> {
        let live: std::collections::HashSet<SessionId> =
            self.sessions.list().into_iter().map(|s| s.id).collect();
        let mut list = self.state.lock().unwrap().workspaces.clone();
        for w in &mut list {
            w.sessions.retain(|id| live.contains(id));
        }
        list
    }

    pub fn workspace(&self, id: &str) -> Result<Workspace> {
        self.state
            .lock()
            .unwrap()
            .workspaces
            .iter()
            .find(|w| w.id == id)
            .cloned()
            .context("no such workspace")
    }

    fn repo(&self, id: &str) -> Result<Repo> {
        self.state
            .lock()
            .unwrap()
            .repos
            .iter()
            .find(|r| r.id == id)
            .cloned()
            .context("no such repo")
    }

    pub async fn add_repo(&self, path: &str) -> Result<Repo> {
        let root = git::toplevel(&expand_home(path)).await?;
        let root_s = root.display().to_string();
        if let Some(r) = self.list_repos().into_iter().find(|r| r.path == root_s) {
            return Ok(r);
        }
        let config = read_config(&root);
        let base = match config.base_branch {
            Some(b) => b,
            None => git::default_branch(&root).await,
        };
        let repo = Repo {
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
            st.repos.push(r);
            Ok(())
        })?;
        self.sessions
            .emit(Message::event(methods::EV_REPOS_CHANGED, self.list_repos()));
        Ok(repo)
    }

    pub fn remove_repo(&self, id: &str) -> Result<()> {
        self.mutate(|st| {
            if st.workspaces.iter().any(|w| w.repo_id == id && !w.archived) {
                bail!("archive this repo's workspaces first");
            }
            st.repos.retain(|r| r.id != id);
            st.workspaces.retain(|w| w.repo_id != id);
            Ok(())
        })?;
        self.sessions
            .emit(Message::event(methods::EV_REPOS_CHANGED, self.list_repos()));
        Ok(())
    }

    pub fn repo_config(&self, id: &str) -> Result<RepoConfig> {
        Ok(read_config(Path::new(&self.repo(id)?.path)))
    }

    fn agent_command(
        &self,
        repo: &Repo,
        agent: &str,
        prompt: Option<&str>,
        resume: bool,
    ) -> String {
        let config = read_config(Path::new(&repo.path));
        let mut cmd = config
            .agents
            .get(agent)
            .cloned()
            .or_else(|| builtin_agent(agent, resume).map(String::from))
            .unwrap_or_else(|| agent.to_string());
        if let Some(p) = prompt.filter(|p| !p.trim().is_empty())
            && !resume
        {
            cmd.push(' ');
            cmd.push_str(&shell_quote(p));
        }
        cmd
    }

    fn script_env(&self, ws: &Workspace, repo: &Repo) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("JAUNT_ROOT_PATH".into(), repo.path.clone()),
            ("JAUNT_WORKSPACE_PATH".into(), ws.path.clone()),
            ("JAUNT_WORKSPACE_NAME".into(), ws.name.clone()),
            ("JAUNT_BRANCH".into(), ws.branch.clone()),
        ])
    }

    /// Starts a session inside a workspace and remembers how to restart it.
    pub fn spawn_in(&self, ws: &Workspace, mut req: SessionCreate) -> Result<SessionInfo> {
        let repo = self.repo(&ws.repo_id)?;
        req.workspace_id = Some(ws.id.clone());
        if req.cwd.is_empty() {
            req.cwd = ws.path.clone();
        }
        for (k, v) in self.script_env(ws, &repo) {
            req.env.entry(k).or_insert(v);
        }
        let info = self.sessions.create(req.clone())?;
        if matches!(info.kind, SessionKind::Agent | SessionKind::Shell) {
            let entry = RestoreEntry {
                kind: info.kind,
                title: info.title.clone(),
                cwd: info.cwd.clone(),
                command: info.command.clone(),
                agent: info.agent.clone(),
                session: Some(info.id),
            };
            self.mutate(|st| {
                if let Some(w) = st.workspaces.iter_mut().find(|w| w.id == ws.id) {
                    w.sessions.push(info.id);
                    w.restore.push(entry);
                }
                Ok(())
            })?;
        } else {
            self.mutate(|st| {
                if let Some(w) = st.workspaces.iter_mut().find(|w| w.id == ws.id) {
                    w.sessions.push(info.id);
                }
                Ok(())
            })?;
        }
        self.emit_workspaces();
        Ok(info)
    }

    #[allow(clippy::too_many_arguments)]
    fn agent_session(
        &self,
        ws: &Workspace,
        repo: &Repo,
        agent: &str,
        prompt: Option<&str>,
        resume: bool,
        cols: u16,
        rows: u16,
    ) -> SessionCreate {
        SessionCreate {
            cwd: ws.path.clone(),
            command: vec![
                user_shell(),
                "-lic".into(),
                self.agent_command(repo, agent, prompt, resume),
            ],
            cols,
            rows,
            kind: SessionKind::Agent,
            title: Some(agent.to_string()),
            agent: Some(agent.to_string()),
            ..Default::default()
        }
    }

    pub async fn create_workspace(&self, req: WorkspaceCreate) -> Result<Workspace> {
        let repo = self.repo(&req.repo_id)?;
        let repo_path = PathBuf::from(&repo.path);
        let slug = git::slug(&req.name);
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
                .unwrap_or_else(|| format!("jaunt/{slug}"));
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
            None => config.default_agent.clone(),
            Some("") | Some("none") => None,
            Some(a) => Some(a.to_string()),
        };
        let ws = Workspace {
            id: new_id(),
            repo_id: repo.id.clone(),
            name: req.name.clone(),
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
            sessions: vec![],
            layout: serde_json::Value::Null,
            restore: vec![],
        };
        let w = ws.clone();
        self.mutate(|st| {
            st.workspaces.push(w);
            Ok(())
        })?;

        if let Some(setup) = config.setup.filter(|s| !s.trim().is_empty()) {
            self.spawn_in(
                &ws,
                SessionCreate {
                    command: vec![user_shell(), "-lic".into(), setup],
                    kind: SessionKind::Setup,
                    title: Some("setup".into()),
                    cols: req.cols,
                    rows: req.rows,
                    ..Default::default()
                },
            )?;
        }
        if let Some(agent) = &agent {
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
                SessionCreate {
                    cols: req.cols,
                    rows: req.rows,
                    ..Default::default()
                },
            )?;
        }
        self.workspace(&ws.id)
    }

    pub async fn run_script(
        &self,
        id: &str,
        script: &str,
        cols: u16,
        rows: u16,
    ) -> Result<SessionInfo> {
        let ws = self.workspace(id)?;
        let config = read_config(Path::new(&self.repo(&ws.repo_id)?.path));
        let (cmd, kind) = match script {
            "run" => (config.run, SessionKind::Run),
            "setup" => (config.setup, SessionKind::Setup),
            "archive" => (config.archive, SessionKind::Run),
            other => bail!("unknown script {other}"),
        };
        let cmd = cmd
            .filter(|c| !c.trim().is_empty())
            .with_context(|| format!("no `{script}` script in .jaunt/config.toml"))?;
        // Restart instead of piling up run panes.
        for s in self.sessions.list() {
            if s.workspace_id.as_deref() == Some(id) && s.kind == kind && s.title == script {
                let _ = self.sessions.kill(s.id, true);
            }
        }
        self.spawn_in(
            &ws,
            SessionCreate {
                command: vec![user_shell(), "-lic".into(), cmd],
                kind,
                title: Some(script.into()),
                cols,
                rows,
                ..Default::default()
            },
        )
    }

    pub async fn archive(&self, req: WorkspaceArchive) -> Result<()> {
        let ws = self.workspace(&req.id)?;
        let repo = self.repo(&ws.repo_id)?;
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
        for s in self.sessions.list() {
            if s.workspace_id.as_deref() == Some(ws.id.as_str()) {
                let _ = self.sessions.kill(s.id, true);
            }
        }
        if req.remove_worktree {
            git::worktree_remove(Path::new(&repo.path), Path::new(&ws.path)).await?;
        }
        if req.delete_branch {
            git::delete_branch(Path::new(&repo.path), &ws.branch).await?;
        }
        self.mutate(|st| {
            if let Some(w) = st.workspaces.iter_mut().find(|w| w.id == ws.id) {
                w.archived = true;
                w.sessions.clear();
                w.restore.clear();
            }
            Ok(())
        })?;
        self.emit_workspaces();
        Ok(())
    }

    /// Brings an archived workspace back (recreating the worktree if needed).
    pub async fn unarchive(&self, id: &str) -> Result<Workspace> {
        let ws = self.workspace(id)?;
        let repo = self.repo(&ws.repo_id)?;
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
            if let Some(w) = st.workspaces.iter_mut().find(|w| w.id == id) {
                w.archived = false;
            }
            Ok(())
        })?;
        let ws = self.workspace(id)?;
        self.spawn_in(&ws, SessionCreate::default())?;
        self.workspace(id)
    }

    pub fn update(&self, req: WorkspaceUpdate) -> Result<Workspace> {
        self.mutate(|st| {
            let w = st
                .workspaces
                .iter_mut()
                .find(|w| w.id == req.id)
                .context("no such workspace")?;
            if let Some(n) = req.name {
                w.name = n;
            }
            if let Some(l) = req.layout {
                w.layout = l;
            }
            Ok(())
        })?;
        self.emit_workspaces();
        self.workspace(&req.id)
    }

    /// After a daemon restart, sessions are gone: restart each workspace's
    /// agents (resuming where the agent supports it) and shells (S4).
    pub fn restore_after_restart(&self) -> usize {
        let live: std::collections::HashSet<SessionId> =
            self.sessions.list().into_iter().map(|s| s.id).collect();
        let pending: Vec<Workspace> = self
            .state
            .lock()
            .unwrap()
            .workspaces
            .iter()
            .filter(|w| !w.archived && Path::new(&w.path).is_dir())
            .cloned()
            .collect();
        let mut restored = 0;
        for ws in pending {
            let Ok(repo) = self.repo(&ws.repo_id) else {
                continue;
            };
            let dead: Vec<RestoreEntry> = ws
                .restore
                .iter()
                .filter(|e| e.session.is_none_or(|id| !live.contains(&id)))
                .cloned()
                .collect();
            if dead.is_empty() {
                continue;
            }
            let _ = self.mutate(|st| {
                if let Some(w) = st.workspaces.iter_mut().find(|w| w.id == ws.id) {
                    w.restore
                        .retain(|e| e.session.is_some_and(|id| live.contains(&id)));
                    w.sessions.retain(|id| live.contains(id));
                }
                Ok(())
            });
            for entry in dead {
                let known = |a: &str| {
                    builtin_agent(a, true).is_some()
                        || read_config(Path::new(&repo.path)).agents.contains_key(a)
                };
                let req = match (&entry.kind, &entry.agent) {
                    (SessionKind::Agent, Some(agent)) if known(agent) => {
                        let mut r = self.agent_session(&ws, &repo, agent, None, true, 120, 32);
                        r.title = Some(entry.title.clone());
                        r
                    }
                    _ => SessionCreate {
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

    fn forget_session(&self, id: SessionId) {
        let changed = self
            .mutate(|st| {
                let mut changed = false;
                for w in &mut st.workspaces {
                    let before = (w.sessions.len(), w.restore.len());
                    w.sessions.retain(|s| *s != id);
                    w.restore.retain(|e| e.session != Some(id));
                    changed |= before != (w.sessions.len(), w.restore.len());
                }
                Ok(changed)
            })
            .unwrap_or(false);
        if changed {
            self.emit_workspaces();
        }
    }
}

/// A closed tab is gone for good: stop restoring it.
async fn track_removed_sessions(mgr: std::sync::Weak<WorkspaceManager>) {
    let Some(m) = mgr.upgrade() else { return };
    let mut rx = m.sessions.subscribe_events();
    drop(m);
    loop {
        match rx.recv().await {
            Ok(Message::Event { name, data }) if name == methods::EV_SESSION_REMOVED => {
                let Some(m) = mgr.upgrade() else { return };
                if let Ok(r) = serde_json::from_value::<methods::SessionRef>(data) {
                    m.forget_session(r.id);
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

/// Reads `<repo>/.jaunt/config.toml`; missing or invalid files give defaults.
pub fn read_config(repo: &Path) -> RepoConfig {
    let path = repo.join(".jaunt").join("config.toml");
    match std::fs::read_to_string(&path) {
        Ok(text) => toml::from_str(&text).unwrap_or_else(|e| {
            tracing::warn!("{}: {e}", path.display());
            RepoConfig::default()
        }),
        Err(_) => RepoConfig::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn setup() -> (tempfile::TempDir, tempfile::TempDir, Arc<WorkspaceManager>) {
        let repo = crate::git::tests::repo().await;
        std::fs::create_dir(repo.path().join(".jaunt")).unwrap();
        std::fs::write(
            repo.path().join(".jaunt/config.toml"),
            "setup = \"echo setting-up\"\nrun = \"echo running\"\ndefault_agent = \"fake\"\n[agents]\nfake = \"sh -c 'echo agent:$JAUNT_WORKSPACE_NAME; sleep 30'\"\n",
        )
        .unwrap();
        crate::git::git(repo.path(), &["add", "-A"]).await.unwrap();
        crate::git::git(repo.path(), &["commit", "-qm", "config"])
            .await
            .unwrap();
        let home = tempfile::tempdir().unwrap();
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let sessions = SessionManager::new(home.path().join("s.sock"), env);
        let mgr = WorkspaceManager::load(
            home.path().join("state.json"),
            home.path().join("worktrees"),
            sessions,
        );
        (repo, home, mgr)
    }

    #[tokio::test]
    async fn create_run_archive_workspace() {
        let (repo, home, mgr) = setup().await;
        let r = mgr
            .add_repo(&repo.path().display().to_string())
            .await
            .unwrap();
        assert_eq!(r.base_branch, "main");
        assert_eq!(
            mgr.add_repo(
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
            .create_workspace(WorkspaceCreate {
                repo_id: r.id.clone(),
                name: "Fix login".into(),
                branch: None,
                from: None,
                existing_branch: false,
                agent: None,
                prompt: Some("it's broken".into()),
                cols: 80,
                rows: 24,
            })
            .await
            .unwrap();
        assert_eq!(ws.branch, "jaunt/fix-login");
        assert!(Path::new(&ws.path).join("a.txt").exists());
        let sessions = mgr.sessions.list();
        let agent = sessions
            .iter()
            .find(|s| s.kind == SessionKind::Agent)
            .expect("agent started");
        assert_eq!(agent.agent.as_deref(), Some("fake"));
        assert!(agent.command.last().unwrap().ends_with("'it'\\''s broken'"));
        assert!(sessions.iter().any(|s| s.kind == SessionKind::Setup));
        assert_eq!(ws.restore.len(), 1, "setup is not restored, the agent is");

        // Second workspace with the same name gets unique branch and dir.
        let ws2 = mgr
            .create_workspace(WorkspaceCreate {
                repo_id: r.id.clone(),
                name: "Fix login".into(),
                branch: None,
                from: None,
                existing_branch: false,
                agent: Some("none-agent".into()),
                prompt: None,
                cols: 80,
                rows: 24,
            })
            .await
            .unwrap();
        assert_eq!(ws2.branch, "jaunt/fix-login-2");
        assert_ne!(ws2.path, ws.path);

        let run = mgr.run_script(&ws.id, "run", 80, 24).await.unwrap();
        assert_eq!(run.kind, SessionKind::Run);

        // State is persisted.
        let saved: State =
            serde_json::from_str(&std::fs::read_to_string(home.path().join("state.json")).unwrap())
                .unwrap();
        assert_eq!(saved.workspaces.len(), 2);

        mgr.archive(WorkspaceArchive {
            id: ws.id.clone(),
            remove_worktree: true,
            delete_branch: true,
        })
        .await
        .unwrap();
        assert!(!Path::new(&ws.path).exists());
        assert!(mgr.workspace(&ws.id).unwrap().archived);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            mgr.sessions
                .list()
                .iter()
                .all(|s| s.workspace_id.as_deref() != Some(ws.id.as_str()))
        );
        assert!(mgr.remove_repo(&r.id).is_err(), "ws2 still active");
    }

    #[tokio::test]
    async fn restores_agents_after_restart() {
        let (repo, home, mgr) = setup().await;
        let r = mgr
            .add_repo(&repo.path().display().to_string())
            .await
            .unwrap();
        let ws = mgr
            .create_workspace(WorkspaceCreate {
                repo_id: r.id.clone(),
                name: "t".into(),
                branch: None,
                from: None,
                existing_branch: false,
                agent: Some("fake".into()),
                prompt: Some("hi".into()),
                cols: 80,
                rows: 24,
            })
            .await
            .unwrap();
        assert_eq!(ws.restore.len(), 1);

        // Simulate a daemon restart: a fresh session manager with no sessions.
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let sessions = SessionManager::new(home.path().join("s2.sock"), env);
        let mgr2 = WorkspaceManager::load(
            home.path().join("state.json"),
            home.path().join("worktrees"),
            sessions,
        );
        assert_eq!(mgr2.restore_after_restart(), 1);
        let s = mgr2.sessions.list();
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
        assert_eq!(mgr2.workspace(&ws.id).unwrap().restore.len(), 1);
        assert_eq!(
            mgr2.restore_after_restart(),
            0,
            "idempotent while sessions live"
        );
    }

    #[tokio::test]
    async fn closing_a_tab_stops_restoring_it() {
        let (repo, _home, mgr) = setup().await;
        let r = mgr
            .add_repo(&repo.path().display().to_string())
            .await
            .unwrap();
        let ws = mgr
            .create_workspace(WorkspaceCreate {
                repo_id: r.id.clone(),
                name: "t".into(),
                branch: None,
                from: None,
                existing_branch: false,
                agent: Some("fake".into()),
                prompt: None,
                cols: 80,
                rows: 24,
            })
            .await
            .unwrap();
        let id = ws.restore[0].session.unwrap();
        mgr.sessions.kill(id, true).unwrap();
        for _ in 0..100 {
            if mgr.workspace(&ws.id).unwrap().restore.is_empty() {
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
            .add_repo(&repo.path().display().to_string())
            .await
            .unwrap();
        assert_eq!(
            mgr.agent_command(&r, "claude", Some("fix it"), false),
            "claude 'fix it'"
        );
        assert_eq!(
            mgr.agent_command(&r, "claude", Some("fix it"), true),
            "claude --continue"
        );
        assert_eq!(
            mgr.agent_command(&r, "codex", None, true),
            "codex resume --last"
        );
        assert!(
            mgr.agent_command(&r, "fake", None, false)
                .starts_with("sh -c")
        );
    }

    #[test]
    fn config_parsing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_config(dir.path()), RepoConfig::default());
        std::fs::create_dir(dir.path().join(".jaunt")).unwrap();
        std::fs::write(
            dir.path().join(".jaunt/config.toml"),
            "run = \"npm run dev\"\nbase_branch = \"develop\"\n",
        )
        .unwrap();
        let c = read_config(dir.path());
        assert_eq!(c.run.as_deref(), Some("npm run dev"));
        assert_eq!(c.base_branch.as_deref(), Some("develop"));
    }
}
