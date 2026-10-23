//! Heavy commands on the central host (X62): what the user approved of
//! each project's `[heavy]` table, kept in `~/.moonlet/heavy.json` by
//! project identity, and whether an agent's Bash call may be routed.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use moonlet_core::heavy;
use moonlet_core::hooks::HookPaths;
use moonlet_core::project_config;
use moonlet_core::session::SessionManager;
use moonlet_proto::RpcError;
use moonlet_proto::methods::{ExecRoute, ExecRouted, HeavyApproval, HeavyApprove, HeavyInfo};
use moonlet_proto::types::{Project, ProjectIdentity};

use crate::daemon::internal;

/// A command `exec.run` may run, as checked.
pub struct Checked {
    /// The session's project's name.
    pub project: String,
    /// The session's worktree.
    pub worktree: PathBuf,
    pub cwd: PathBuf,
    /// `cwd` relative to the session's worktree, for a routing copy.
    pub cwd_rel: String,
    /// The approved variables of `moonlet exec`'s environment.
    pub env: BTreeMap<String, String>,
    pub os: moonlet_proto::types::HeavyOs,
    /// Ignored paths brought back after a run.
    pub outputs: Vec<String>,
}

pub struct Heavy {
    file: PathBuf,
    /// Reads and writes of `heavy.json` never interleave.
    lock: Mutex<()>,
    sessions: Arc<SessionManager>,
}

impl Heavy {
    pub fn new(home: &Path, sessions: Arc<SessionManager>) -> Arc<Self> {
        Arc::new(Self {
            file: home.join("heavy.json"),
            lock: Mutex::new(()),
            sessions,
        })
    }

    /// `heavy.get`.
    pub fn get(&self, project: &str) -> Result<HeavyInfo, RpcError> {
        let p = self.project(project)?;
        let config = project_config::load(Path::new(&p.path), p.base_branch.clone());
        let approved = match key(&p.identity) {
            Some(k) => self.read().map_err(internal)?.remove(&k),
            None => None,
        };
        let error = config
            .error
            .clone()
            .or_else(|| heavy::check(&config.config.heavy).err());
        Ok(HeavyInfo {
            config: config.config.heavy,
            approved,
            error,
        })
    }

    /// `heavy.set`: writes `[heavy]` in the project's config. Never
    /// approves.
    pub fn set(
        &self,
        project: &str,
        heavy: &moonlet_proto::types::HeavyConfig,
    ) -> Result<HeavyInfo, RpcError> {
        let p = self.project(project)?;
        project_config::set_heavy(Path::new(&p.path), heavy).map_err(internal)?;
        self.get(project)
    }

    /// `heavy.approve`: the lists must be the config's as it is now, so the
    /// user never approves a list they did not see.
    pub fn approve(&self, r: HeavyApprove) -> Result<HeavyInfo, RpcError> {
        let project = r.project.clone().unwrap_or_default();
        let p = self.project(&project)?;
        let Some(k) = key(&p.identity) else {
            return Err(RpcError::new(
                "no_identity",
                format!("{} has no first commit to keep the approval by", p.name),
            ));
        };
        let config = project_config::load(Path::new(&p.path), p.base_branch.clone());
        if let Some(e) = config
            .error
            .or_else(|| heavy::check(&config.config.heavy).err())
        {
            return Err(RpcError::new("invalid_config", e));
        }
        let heavy = config.config.heavy;
        if sorted(&r.commands) != sorted(&heavy.commands) || sorted(&r.env) != sorted(&heavy.env) {
            return Err(RpcError::new(
                "changed",
                format!("{}'s heavy commands changed since they were shown", p.name),
            ));
        }
        {
            let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
            let mut all = self.read().map_err(internal)?;
            all.insert(
                k,
                HeavyApproval {
                    commands: sorted(&r.commands),
                    env: sorted(&r.env),
                },
            );
            let bytes = serde_json::to_vec_pretty(&all).map_err(internal)?;
            crate::mobile::write_private(&self.file, &bytes).map_err(internal)?;
        }
        self.get(&project)
    }

    /// `exec.route`: whether a Bash call of an agent in a session may run
    /// on another machine. Anything moonlet cannot vouch for stays where
    /// it is.
    pub fn route(&self, r: &ExecRoute) -> ExecRouted {
        match self.why_not(r) {
            Ok(()) => ExecRouted {
                route: true,
                reason: None,
            },
            Err(reason) => ExecRouted {
                route: false,
                reason: Some(reason.into()),
            },
        }
    }

    /// `exec.run`'s check: the words `moonlet exec` got, as the hook would
    /// have judged them, since an agent can call `moonlet exec` itself. The
    /// command runs from the canonical folder, with only the approved
    /// variables of `env`.
    pub fn check_run(
        &self,
        session: &str,
        argv: &[String],
        cwd: &str,
        env: &BTreeMap<String, String>,
    ) -> Result<Checked, &'static str> {
        if argv.is_empty() {
            return Err("not_heavy");
        }
        let command = argv.iter().map(|w| quote(w)).collect::<Vec<_>>().join(" ");
        let ask = ExecRoute {
            session: session.to_string(),
            command,
            cwd: cwd.to_string(),
            tool_use_id: None,
        };
        self.why_not(&ask)?;
        let worktree = self
            .sessions
            .session(session)
            .ok()
            .and_then(|s| std::fs::canonicalize(s.path).ok())
            .ok_or("no_session")?;
        let config = project_config::load(&worktree, String::new());
        let os = config.config.heavy.os;
        let outputs = config.config.heavy.outputs.clone();
        let names = config.config.heavy.env;
        let passed = env
            .iter()
            .filter(|(k, _)| names.contains(k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let cwd = std::fs::canonicalize(cwd).map_err(|_| "outside_worktree")?;
        let cwd_rel = cwd
            .strip_prefix(&worktree)
            .map_err(|_| "outside_worktree")?
            .display()
            .to_string();
        let project = self
            .sessions
            .session(session)
            .ok()
            .and_then(|s| self.sessions.list_projects().into_iter().find(|p| p.id == s.project_id))
            .map(|p| p.name)
            .unwrap_or_default();
        Ok(Checked {
            project,
            worktree: worktree.clone(),
            cwd,
            cwd_rel,
            env: passed,
            os,
            outputs,
        })
    }

    fn why_not(&self, r: &ExecRoute) -> Result<(), &'static str> {
        let session = self
            .sessions
            .session(&r.session)
            .ok()
            .filter(|s| !s.archived)
            .ok_or("no_session")?;
        let worktree = std::fs::canonicalize(&session.path).map_err(|_| "no_session")?;
        let inside = std::fs::canonicalize(&r.cwd).is_ok_and(|cwd| cwd.starts_with(&worktree));
        if !inside {
            return Err("outside_worktree");
        }
        let project = self
            .sessions
            .list_projects()
            .into_iter()
            .find(|p| p.id == session.project_id)
            .ok_or("no_session")?;
        // The worktree's own config: an agent's edit there counts.
        let config = project_config::load(&worktree, project.base_branch.clone());
        if config.error.is_some() || heavy::check(&config.config.heavy).is_err() {
            return Err("invalid_config");
        }
        let heavy = config.config.heavy;
        let words = heavy::route(&r.command, &heavy.commands).ok_or("not_heavy")?;
        let approved = key(&project.identity)
            .and_then(|k| self.read().ok()?.remove(&k))
            .ok_or("not_approved")?;
        let entries: Vec<String> = heavy
            .commands
            .iter()
            .filter(|c| approved.commands.contains(c))
            .cloned()
            .collect();
        heavy::route(&r.command, &entries).ok_or("not_approved")?;
        if !heavy.env.iter().all(|e| approved.env.contains(e)) {
            return Err("env_not_approved");
        }
        let user = match self.sessions.config_dir(&r.session) {
            Some(dir) => Path::new(&dir).join("settings.json"),
            None => HookPaths::default_paths().claude_settings,
        };
        let files = [
            managed_settings(),
            user,
            worktree.join(".claude/settings.json"),
            worktree.join(".claude/settings.local.json"),
        ];
        if heavy::rules_block(&heavy::claude_rules(&files), &r.command, &words) {
            return Err("claude_rule");
        }
        Ok(())
    }

    fn project(&self, id: &str) -> Result<Project, RpcError> {
        self.sessions
            .list_projects()
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| RpcError::new("not_found", format!("no project {id}")))
    }

    /// `heavy.json`: empty when there is none yet, an error when it cannot
    /// be read, so nothing writes over approvals it failed to read.
    fn read(&self) -> anyhow::Result<BTreeMap<String, HeavyApproval>> {
        match std::fs::read(&self.file) {
            Ok(b) => serde_json::from_slice(&b)
                .map_err(|e| anyhow::anyhow!("{} cannot be read: {e}", self.file.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(anyhow::anyhow!("{}: {e}", self.file.display())),
        }
    }
}

/// Claude Code's managed settings, which an organisation's deny rules may
/// come from. `MOONLET_CLAUDE_MANAGED_SETTINGS` points tests elsewhere.
fn managed_settings() -> PathBuf {
    if let Some(p) = std::env::var_os("MOONLET_CLAUDE_MANAGED_SETTINGS") {
        return PathBuf::from(p);
    }
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json")
    } else {
        PathBuf::from("/etc/claude-code/managed-settings.json")
    }
}

/// A project's key in `heavy.json`: its origin and root commit. A project
/// with no root commit has none, so nothing is approved for it.
pub(crate) fn key(id: &ProjectIdentity) -> Option<String> {
    let root = id.root.as_deref()?;
    if !matches!(root.len(), 40 | 64) || !root.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let origin = id.origin.as_deref().unwrap_or("");
    if origin.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    Some(format!("{origin} {root}"))
}

/// `w` as one word for a POSIX shell: as it is when it holds nothing a
/// shell reads, in single quotes otherwise.
pub fn quote(w: &str) -> String {
    let plain = !w.is_empty()
        && w.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:,+@%".contains(c));
    if plain {
        w.to_string()
    } else {
        format!("'{}'", w.replace('\'', "'\\''"))
    }
}

pub fn sorted(v: &[String]) -> Vec<String> {
    let mut v = v.to_vec();
    v.sort();
    v.dedup();
    v
}
