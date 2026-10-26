//! Workspaces and sections in the account state (X68, ADR 0014). A change
//! made here is found by comparing the state before and after it, so X32's
//! rules stay where they are; changes from other members are laid back onto
//! this member's state, mapping project identities to its own projects.
//!
//! A section's projects are one field each, `project:<origin>|<root>`, set
//! to the identity with its sort key or to `null` once removed, so two
//! members adding projects to one section at once both keep theirs.

use std::collections::BTreeMap as Map;

use moonlet_proto::types::{Change, ProjectIdentity};
use serde_json::{Value, json};

use super::*;
use crate::account::{Log, LogFile, Record, Version, key_between, new_log_name};
use crate::identity::same_project;

const WORKSPACE: &str = "workspace";
const SECTION: &str = "section";
/// The prefix of a section's project fields.
const PROJECT: &str = "project:";
/// The ids of the workspace and the section every member makes when changes
/// from several members together left none, so they all make the same
/// ones. A deleted one stays deleted, so the next is `default-2` and so on.
const DEFAULT_WORKSPACE_ID: &str = "default";
const DEFAULT_SECTION_ID: &str = "default-section";

type Listener = Arc<dyn Fn(Vec<Change>) + Send + Sync>;

pub(super) struct Account {
    log: Log,
    path: PathBuf,
    listener: Option<Listener>,
}

/// A log with the changes of one request, written beside the log until the
/// state that goes with them is saved: a state that cannot be saved leaves
/// the log as it was, so the edit does not come back after a restart.
pub(super) struct Staged {
    log: Log,
    pub(super) changes: Vec<Change>,
    file: Option<PathBuf>,
}

impl Account {
    /// The changes that turn `old` into `new`, staged.
    pub(super) fn stage(&self, old: &State, new: &State) -> Result<Staged> {
        let mut log = self.log.clone();
        let changes = diff(old, new, &mut log, now_ms());
        let file = if changes.is_empty() {
            None
        } else {
            let staged = self.path.with_extension("json.staged");
            write_private(&staged, &log)?;
            Some(staged)
        };
        Ok(Staged { log, changes, file })
    }

    /// The account after the state was saved: the staged log becomes the
    /// log. One that cannot be moved into place is said in the log and kept
    /// in memory, so the next save writes it.
    pub(super) fn commit(&mut self, staged: Staged) -> Vec<Change> {
        if let Some(file) = &staged.file
            && let Err(e) = std::fs::rename(file, &self.path)
        {
            tracing::warn!("cannot save the account's changes: {e}");
        }
        self.log = staged.log;
        staged.changes
    }
}

impl Staged {
    /// Forgets the staged changes: the state they went with was not saved.
    pub(super) fn discard(self) {
        if let Some(file) = self.file {
            let _ = std::fs::remove_file(file);
        }
    }

    pub(super) fn log(&self) -> &Log {
        &self.log
    }
}

/// Writes `log` to `path` through a temporary file, readable only by the
/// user, as it names the user's projects and the machines they work on.
fn write_private(path: &Path, log: &Log) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        crate::paths::ensure_private_dir(dir)?;
    }
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(&serde_json::to_vec(&log.to_file())?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

impl SessionManager {
    /// Shares this member's workspaces and sections (X68). The first time,
    /// they become the changes of a new log named after `member`, keeping
    /// their ids. A log that cannot be read is kept aside, each time under a
    /// name of its own, and made again from the state the same way; its
    /// changes are stamped as old as can be, so they give way to every
    /// change the other members made.
    pub fn attach_account(&self, path: PathBuf, member: &str) -> Result<()> {
        let mut lost = false;
        let file = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<LogFile>(&bytes) {
                Ok(f) => Some(f),
                Err(e) => {
                    let bad = path.with_extension(format!("json.{}.bad", now_ms()));
                    tracing::warn!(
                        "cannot read {} ({e}); kept it as {}",
                        path.display(),
                        bad.display()
                    );
                    std::fs::rename(&path, &bad)?;
                    lost = true;
                    None
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e).with_context(|| format!("cannot read {}", path.display())),
        };
        let mut st = self.state.lock().unwrap();
        let log = match file {
            Some(f) => {
                let mut log = Log::new(&f.member);
                log.apply(f.changes);
                let mut next = st.clone();
                lay_onto(&mut next, &log);
                self.save(&next)?;
                *st = next;
                log
            }
            None => {
                let mut log = Log::new(&new_log_name(member));
                diff(
                    &State::default(),
                    &st,
                    &mut log,
                    if lost { 0 } else { now_ms() },
                );
                write_private(&path, &log)?;
                log
            }
        };
        *self.account.lock().unwrap() = Some(Account {
            log,
            path,
            listener: None,
        });
        Ok(())
    }

    /// Called with every change this member makes, to send it on.
    pub fn on_account_change(&self, f: impl Fn(Vec<Change>) + Send + Sync + 'static) {
        if let Some(a) = self.account.lock().unwrap().as_mut() {
            a.listener = Some(Arc::new(f));
        }
    }

    pub(super) fn account_changed(&self, changes: Vec<Change>) {
        let listener = self
            .account
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|a| a.listener.clone());
        if let Some(f) = listener {
            f(changes);
        }
    }

    fn with_log<T: Default>(&self, f: impl FnOnce(&Log) -> T) -> T {
        self.account
            .lock()
            .unwrap()
            .as_ref()
            .map(|a| f(&a.log))
            .unwrap_or_default()
    }

    /// What this member has seen of the account; empty without one.
    pub fn account_version(&self) -> Version {
        self.with_log(Log::version)
    }

    /// The changes a member at `version` lacks.
    pub fn account_changes_for(&self, version: &Version) -> Vec<Change> {
        self.with_log(|log| log.missing_for(version))
    }

    /// Takes in changes from other members, and shows what they change.
    pub fn apply_account(&self, changes: Vec<Change>) {
        if changes.is_empty() {
            return;
        }
        let changed = {
            let mut st = self.state.lock().unwrap();
            let mut account = self.account.lock().unwrap();
            let Some(a) = account.as_mut() else { return };
            let mut log = a.log.clone();
            let before = log.version();
            log.apply(changes);
            if log.version() == before {
                false
            } else {
                let mut next = st.clone();
                lay_onto(&mut next, &log);
                match write_private(&a.path, &log).and_then(|()| self.save(&next)) {
                    Ok(()) => {
                        a.log = log;
                        *st = next;
                        true
                    }
                    Err(e) => {
                        tracing::warn!("cannot save the account's changes: {e:#}");
                        false
                    }
                }
            }
        };
        if changed {
            self.emit_all();
        }
    }
}

/// A workspace as account fields. Its profile goes by name, as each member
/// has its own folder for it.
fn workspace_fields(st: &State, w: &Workspace) -> Record {
    let profile = w
        .claude_profile
        .as_deref()
        .and_then(|id| st.profiles.iter().find(|p| p.id == id))
        .map(|p| json!(p.name))
        .unwrap_or(Value::Null);
    Record::from([
        ("name".into(), json!(w.name)),
        ("color".into(), json!(w.color)),
        ("claude_profile".into(), profile),
        ("created_at".into(), json!(w.created_at)),
    ])
}

/// A section as account fields, but for its projects (see `diff_projects`).
fn section_fields(st: &State, s: &Section) -> Record {
    let workspace = st
        .workspace_of_section(&s.id)
        .map(|i| json!(st.workspaces[i].id))
        .unwrap_or(Value::Null);
    Record::from([
        ("workspace".into(), workspace),
        ("name".into(), json!(s.name)),
        ("view".into(), json!(s.view)),
        ("created_at".into(), json!(s.created_at)),
    ])
}

/// The key of a project identity in a section's fields; `None` for a
/// project without a root, which is this member's alone.
fn identity_key(i: &ProjectIdentity) -> Option<String> {
    Some(format!(
        "{}|{}",
        i.origin.as_deref().unwrap_or(""),
        i.root.as_deref()?
    ))
}

/// A section's projects by identity, in its order: this member's own that
/// have one, then those it does not have; each says whether it is this
/// member's own.
fn section_identities(st: &State, s: &Section) -> Vec<(String, ProjectIdentity, bool)> {
    let own = s
        .project_ids
        .iter()
        .filter_map(|id| st.projects.iter().find(|p| &p.id == id))
        .map(|p| (p.identity.clone(), true));
    own.chain(s.missing.iter().map(|i| (i.clone(), false)))
        .filter_map(|(i, mine)| Some((identity_key(&i)?, i, mine)))
        .collect()
}

/// Records in `log` the changes that turn `old` into `new`.
fn diff(old: &State, new: &State, log: &mut Log, now: u64) -> Vec<Change> {
    let mut out = Vec::new();
    for w in &new.workspaces {
        let before = old
            .workspaces
            .iter()
            .find(|o| o.id == w.id)
            .map(|o| workspace_fields(old, o));
        set_changed(
            log,
            now,
            WORKSPACE,
            &w.id,
            before,
            workspace_fields(new, w),
            &mut out,
        );
    }
    for w in old
        .workspaces
        .iter()
        .filter(|o| !new.workspaces.iter().any(|w| w.id == o.id))
    {
        out.push(log.delete(now, WORKSPACE, &w.id));
    }
    for s in &new.sections {
        let before = old.sections.iter().find(|o| o.id == s.id);
        set_changed(
            log,
            now,
            SECTION,
            &s.id,
            before.map(|o| section_fields(old, o)),
            section_fields(new, s),
            &mut out,
        );
        let had = before
            .map(|o| section_identities(old, o))
            .unwrap_or_default();
        diff_projects(log, now, &s.id, &had, &section_identities(new, s), &mut out);
    }
    for s in old
        .sections
        .iter()
        .filter(|o| !new.sections.iter().any(|s| s.id == o.id))
    {
        out.push(log.delete(now, SECTION, &s.id));
    }
    for w in &new.workspaces {
        order_sections(log, now, w, &mut out);
    }
    out
}

fn set_changed(
    log: &mut Log,
    now: u64,
    kind: &str,
    id: &str,
    before: Option<Record>,
    after: Record,
    out: &mut Vec<Change>,
) {
    for (field, value) in after {
        if before.as_ref().and_then(|b| b.get(&field)) != Some(&value) {
            out.push(log.set(now, kind, id, &field, value));
        }
    }
}

/// Sort keys for a list whose items have `keys` so far: the indexes of the
/// items that need one, with it. Only items without one get one, unless the
/// others' keys are out of order, when all of them get new ones.
fn place(mut keys: Vec<Option<String>>) -> Vec<(usize, String)> {
    let kept: Vec<&String> = keys.iter().flatten().collect();
    if kept.windows(2).any(|p| p[0] >= p[1]) {
        keys = vec![None; keys.len()];
    }
    let mut out = Vec::new();
    for i in 0..keys.len() {
        if keys[i].is_some() {
            continue;
        }
        let before = keys[..i].iter().rev().flatten().next().cloned();
        let after = keys[i + 1..].iter().flatten().next().cloned();
        let k = key_between(before.as_deref(), after.as_deref());
        out.push((i, k.clone()));
        keys[i] = Some(k);
    }
    out
}

/// Gives the sections of `w` sort keys in its order.
fn order_sections(log: &mut Log, now: u64, w: &Workspace, out: &mut Vec<Change>) {
    let records = log.records(SECTION);
    let key = |id: &str| -> Option<String> {
        let r = records.get(id)?;
        (r.get("workspace") == Some(&json!(w.id)))
            .then(|| r.get("order")?.as_str().map(String::from))?
    };
    for (i, k) in place(w.section_ids.iter().map(|id| key(id)).collect()) {
        out.push(log.set(now, SECTION, &w.section_ids[i], "order", json!(k)));
    }
}

/// Records the projects section `id` gained or lost: one field each, so a
/// change touches only the projects it is about. A project added goes after
/// the last one. Only when this member puts its own projects in another
/// order do they all get new keys, in the new order: the projects it lacks
/// come after its own in `has`, which is no order of the account's.
fn diff_projects(
    log: &mut Log,
    now: u64,
    id: &str,
    had: &[(String, ProjectIdentity, bool)],
    has: &[(String, ProjectIdentity, bool)],
    out: &mut Vec<Change>,
) {
    let held =
        |list: &[(String, ProjectIdentity, bool)], key: &str| list.iter().any(|(k, _, _)| k == key);
    for (key, _, _) in had.iter().filter(|(k, _, _)| !held(has, k)) {
        out.push(log.set(now, SECTION, id, &format!("{PROJECT}{key}"), Value::Null));
    }
    let own_order = |list: &[(String, ProjectIdentity, bool)],
                     other: &[(String, ProjectIdentity, bool)]|
     -> Vec<String> {
        list.iter()
            .filter(|(k, _, mine)| *mine && held(other, k))
            .map(|(k, _, _)| k.clone())
            .collect()
    };
    let reordered = own_order(had, has) != own_order(has, had);
    let value = |identity: &ProjectIdentity, order: &str| json!({ "origin": identity.origin, "root": identity.root, "order": order });
    if reordered {
        for (i, k) in place(vec![None; has.len()]) {
            let (key, identity, _) = &has[i];
            out.push(log.set(
                now,
                SECTION,
                id,
                &format!("{PROJECT}{key}"),
                value(identity, &k),
            ));
        }
        return;
    }
    let record = log.records(SECTION).remove(id).unwrap_or_default();
    let mut last: Option<String> = record
        .iter()
        .filter(|(f, v)| f.starts_with(PROJECT) && !v.is_null())
        .filter_map(|(_, v)| v.get("order")?.as_str().map(String::from))
        .max();
    for (key, identity, _) in has.iter().filter(|(k, _, _)| !held(had, k)) {
        let k = key_between(last.as_deref(), None);
        out.push(log.set(
            now,
            SECTION,
            id,
            &format!("{PROJECT}{key}"),
            value(identity, &k),
        ));
        last = Some(k);
    }
}

/// The first of `base`, `base-2`, `base-3`… that `log` has not deleted.
fn repair_id(log: &Log, kind: &str, base: &str) -> String {
    (1..)
        .map(|n| {
            if n == 1 {
                base.to_string()
            } else {
                format!("{base}-{n}")
            }
        })
        .find(|id| !log.is_deleted(kind, id))
        .unwrap()
}

/// Field `f` of `r` as a `T`, when it is one.
fn parsed<T: serde::de::DeserializeOwned>(r: &Record, f: &str) -> Option<T> {
    r.get(f)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// A section of the account, with where it goes.
struct Placed {
    workspace: String,
    order: String,
    section: Section,
}

/// Lays the account's workspaces and sections onto this member's state.
/// A field whose value does not fit takes its default, and the state is
/// made whole the same way on every member.
pub(super) fn lay_onto(st: &mut State, log: &Log) {
    let text = |r: &Record, f: &str, default: &str| -> String {
        let s: String = r
            .get(f)
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_control())
            .collect();
        let s = s.trim();
        if s.is_empty() {
            default.to_string()
        } else {
            s.to_string()
        }
    };
    let number = |r: &Record, f: &str| r.get(f).and_then(Value::as_u64).unwrap_or(0);

    let sections: Map<String, Record> = log.records(SECTION);
    let default_workspace = repair_id(log, WORKSPACE, DEFAULT_WORKSPACE_ID);
    let mut workspaces: Vec<Workspace> = log
        .records(WORKSPACE)
        .into_iter()
        .map(|(id, r)| Workspace {
            name: text(&r, "name", DEFAULT_WORKSPACE),
            color: parsed(&r, "color").unwrap_or(DEFAULT_COLOR),
            claude_profile: r
                .get("claude_profile")
                .and_then(Value::as_str)
                .and_then(|name| st.profiles.iter().find(|p| p.name == name))
                .map(|p| p.id.clone()),
            created_at: number(&r, "created_at"),
            section_ids: Vec::new(),
            id,
        })
        .collect();
    // The repair workspace, made on every member alike: with none left, or
    // while sections made in it are about and it has no fields yet.
    let wanted = workspaces.is_empty()
        || sections
            .values()
            .any(|r| r.get("workspace") == Some(&json!(default_workspace)));
    if wanted && !workspaces.iter().any(|w| w.id == default_workspace) {
        let mut w = new_workspace(DEFAULT_WORKSPACE, DEFAULT_COLOR);
        w.id = default_workspace;
        w.created_at = 0;
        workspaces.push(w);
    }
    workspaces.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));

    let mut placed: Vec<Placed> = Vec::new();
    for (id, r) in &sections {
        let mut projects: Vec<(String, String, ProjectIdentity)> = r
            .iter()
            .filter_map(|(f, v)| {
                let key = f.strip_prefix(PROJECT)?;
                let identity: ProjectIdentity = serde_json::from_value(v.clone()).ok()?;
                identity.root.as_ref()?;
                Some((
                    v.get("order")?.as_str().unwrap_or("").to_string(),
                    key.to_string(),
                    identity,
                ))
            })
            .collect();
        projects.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
        let mut project_ids = Vec::new();
        let mut missing = Vec::new();
        let had: Vec<String> = st
            .sections
            .iter()
            .find(|s| &s.id == id)
            .map(|s| s.project_ids.clone())
            .unwrap_or_default();
        for (_, _, i) in projects {
            // Two checkouts of one repository are one project to the
            // account: those this section held stay, else the first.
            let matches: Vec<&Project> = st
                .projects
                .iter()
                .filter(|p| same_project(&p.identity, &i))
                .collect();
            let held: Vec<&Project> = matches
                .iter()
                .copied()
                .filter(|p| had.contains(&p.id))
                .collect();
            let chosen: Vec<&Project> = if held.is_empty() {
                matches.into_iter().take(1).collect()
            } else {
                held
            };
            if chosen.is_empty() {
                missing.push(i);
            }
            for p in chosen {
                if !project_ids.contains(&p.id) {
                    project_ids.push(p.id.clone());
                }
            }
        }
        // Projects without an identity are this member's alone, and stay
        // in the section that had them.
        if let Some(old) = st.sections.iter().find(|s| &s.id == id) {
            for p in &old.project_ids {
                let unshared = st
                    .projects
                    .iter()
                    .any(|q| &q.id == p && q.identity.root.is_none());
                if unshared && !project_ids.contains(p) {
                    project_ids.push(p.clone());
                }
            }
        }
        let workspace = r
            .get("workspace")
            .and_then(Value::as_str)
            .filter(|w| workspaces.iter().any(|x| x.id == *w))
            .unwrap_or(&workspaces[0].id)
            .to_string();
        let section = Section {
            name: text(r, "name", DEFAULT_SECTION),
            view: parsed(r, "view").unwrap_or_default(),
            created_at: number(r, "created_at"),
            project_ids,
            missing,
            id: id.clone(),
        };
        placed.push(Placed {
            workspace,
            order: r
                .get("order")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            section,
        });
    }
    // The repair section, made on every member alike when none is left.
    if placed.is_empty() {
        let mut section = new_section(DEFAULT_SECTION);
        section.id = repair_id(log, SECTION, DEFAULT_SECTION_ID);
        section.created_at = 0;
        placed.push(Placed {
            workspace: workspaces[0].id.clone(),
            order: String::new(),
            section,
        });
    }
    placed.sort_by(|a, b| (&a.order, &a.section.id).cmp(&(&b.order, &b.section.id)));
    for p in &placed {
        if let Some(w) = workspaces.iter_mut().find(|w| w.id == p.workspace) {
            w.section_ids.push(p.section.id.clone());
        }
    }
    st.workspaces = workspaces;
    st.sections = placed.into_iter().map(|p| p.section).collect();

    // A shared project no section holds any more was removed on another
    // member, and goes here too, unless it still has live sessions here. A
    // second checkout of a project a section holds is not removed.
    let laid: Vec<ProjectIdentity> = st
        .sections
        .iter()
        .flat_map(|s| {
            s.project_ids
                .iter()
                .filter_map(|id| st.projects.iter().find(|p| &p.id == id))
                .map(|p| p.identity.clone())
        })
        .collect();
    let dropped: Vec<String> = st
        .projects
        .iter()
        .filter(|p| p.identity.root.is_some() && !laid.iter().any(|i| same_project(i, &p.identity)))
        .filter(|p| {
            !st.sessions
                .iter()
                .any(|s| s.project_id == p.id && !s.archived)
        })
        .map(|p| p.id.clone())
        .collect();
    for id in dropped {
        let _ = st.drop_project(&id);
    }
    st.ensure();
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use moonlet_proto::types::{Change, ProjectIdentity};

    async fn member(name: &str) -> (tempfile::TempDir, Arc<SessionManager>) {
        let home = tempfile::tempdir().unwrap();
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let terminals = TerminalManager::new(home.path().join("s.sock"), env);
        let mgr = SessionManager::load(
            home.path().join("state.json"),
            home.path().join("worktrees"),
            terminals,
        );
        mgr.attach_account(home.path().join("account.json"), name)
            .unwrap();
        (home, mgr)
    }

    /// What linked members do through the central host: each takes what
    /// it lacks from the other.
    fn sync(a: &SessionManager, b: &SessionManager) {
        let to_b = a.account_changes_for(&b.account_version());
        b.apply_account(to_b);
        let to_a = b.account_changes_for(&a.account_version());
        a.apply_account(to_a);
    }

    fn names(mgr: &SessionManager) -> Vec<String> {
        let mut n: Vec<String> = mgr.list_workspaces().into_iter().map(|w| w.name).collect();
        n.sort();
        n
    }

    #[tokio::test]
    async fn a_workspace_renamed_on_one_member_is_renamed_on_the_other() {
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        let personal = book.list_workspaces()[0].clone();
        book.update_workspace(WorkspaceUpdate {
            id: personal.id.clone(),
            name: Some("Home".into()),
            color: None,
            section_ids: None,
            claude_profile: None,
        })
        .unwrap();
        sync(&book, &mini);
        // Each member's own "Personal" until the user merges them, and the
        // renamed one on both.
        assert_eq!(names(&mini), ["Home", "Personal"]);
        assert_eq!(names(&book), ["Home", "Personal"]);
        let ids = |m: &SessionManager| {
            let mut ids: Vec<String> = m.list_workspaces().into_iter().map(|w| w.id).collect();
            ids.sort();
            ids
        };
        assert_eq!(ids(&book), ids(&mini));
    }

    fn section(mgr: &SessionManager, name: &str) -> Section {
        mgr.list_sections()
            .into_iter()
            .find(|s| s.name == name)
            .unwrap_or_else(|| panic!("no section {name}"))
    }

    #[tokio::test]
    async fn a_sections_projects_are_this_members_clones_and_the_rest_are_missing() {
        let shop = crate::git::tests::repo().await;
        let blog = crate::git::tests::repo().await;
        // Test repositories share their first commit; their origins tell
        // them apart, as for real ones.
        crate::git::git(
            shop.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/acme/shop.git",
            ],
        )
        .await
        .unwrap();
        crate::git::git(
            blog.path(),
            &["remote", "add", "origin", "git@github.com:acme/blog.git"],
        )
        .await
        .unwrap();
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        let ws = book.list_workspaces()[0].clone();
        let work = book.create_section(&ws.id, "1devstudio").unwrap();
        book.section_add_project(&work.id, &shop.path().display().to_string())
            .await
            .unwrap();
        book.section_add_project(&work.id, &blog.path().display().to_string())
            .await
            .unwrap();
        // studio-mini has its own clone of shop, at another path.
        let clone = tempfile::tempdir().unwrap();
        crate::git::git(
            clone.path(),
            &["clone", "-q", &shop.path().display().to_string(), "."],
        )
        .await
        .unwrap();
        crate::git::git(
            clone.path(),
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/acme/shop",
            ],
        )
        .await
        .unwrap();
        let mini_shop = mini
            .add_project(&clone.path().display().to_string())
            .await
            .unwrap();

        sync(&book, &mini);
        let on_mini = section(&mini, "1devstudio");
        assert_eq!(on_mini.project_ids, [mini_shop.id.clone()]);
        let blog_root = git::git_text(blog.path(), &["rev-list", "--max-parents=0", "HEAD"])
            .await
            .unwrap();
        assert_eq!(
            on_mini.missing,
            [ProjectIdentity {
                origin: Some("github.com/acme/blog".into()),
                root: Some(blog_root)
            }]
        );
        let on_book = section(&book, "1devstudio");
        assert_eq!(on_book.project_ids.len(), 2);
        assert!(on_book.missing.is_empty(), "{:?}", on_book.missing);

        // Renaming the section on studio-mini keeps blog in it on both.
        mini.update_section(SectionUpdate {
            id: work.id.clone(),
            name: Some("1dev".into()),
            project_ids: None,
            view: None,
        })
        .unwrap();
        sync(&book, &mini);
        assert_eq!(section(&book, "1dev").project_ids, on_book.project_ids);
        assert_eq!(section(&mini, "1dev").missing, on_mini.missing);
    }

    /// Two members with a clone each of one repository, both in the
    /// book's section "1devstudio".
    async fn shared_project() -> (
        Vec<tempfile::TempDir>,
        Arc<SessionManager>,
        Arc<SessionManager>,
        Section,
    ) {
        let shop = crate::git::tests::repo().await;
        crate::git::git(
            shop.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/acme/shop.git",
            ],
        )
        .await
        .unwrap();
        let clone = tempfile::tempdir().unwrap();
        crate::git::git(
            clone.path(),
            &["clone", "-q", &shop.path().display().to_string(), "."],
        )
        .await
        .unwrap();
        crate::git::git(
            clone.path(),
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/acme/shop.git",
            ],
        )
        .await
        .unwrap();
        let (h1, book) = member("book").await;
        let (h2, mini) = member("mini").await;
        let ws = book.list_workspaces()[0].clone();
        let work = book.create_section(&ws.id, "1devstudio").unwrap();
        book.section_add_project(&work.id, &shop.path().display().to_string())
            .await
            .unwrap();
        sync(&book, &mini);
        mini.section_add_project(&work.id, &clone.path().display().to_string())
            .await
            .unwrap();
        sync(&book, &mini);
        (vec![shop, clone, h1, h2], book, mini, work)
    }

    #[tokio::test]
    async fn a_project_removed_on_one_member_goes_on_the_other() {
        let (_dirs, book, mini, work) = shared_project().await;
        assert_eq!(mini.list_projects().len(), 1);
        let shop = book.list_projects()[0].clone();
        book.section_remove_project(&work.id, &shop.id).unwrap();
        sync(&book, &mini);
        assert!(section(&mini, "1devstudio").project_ids.is_empty());
        assert!(
            mini.list_projects().is_empty(),
            "{:?}",
            mini.list_projects()
        );
    }

    #[tokio::test]
    async fn a_project_removed_elsewhere_stays_while_it_has_live_sessions_here() {
        let (_dirs, book, mini, work) = shared_project().await;
        let mini_shop = mini.list_projects()[0].clone();
        let req = SessionCreate {
            name: Some("Keep me".into()),
            agent: Some("none".into()),
            // The workspace holding the shared section, whichever member's
            // "Personal" lists first.
            workspace_id: mini
                .list_workspaces()
                .into_iter()
                .find(|w| w.section_ids.contains(&work.id))
                .map(|w| w.id),
            cols: 80,
            rows: 24,
            ..SessionCreate::new(&mini_shop.id)
        };
        mini.create_session(req).await.unwrap();
        let shop = book.list_projects()[0].clone();
        book.section_remove_project(&work.id, &shop.id).unwrap();
        sync(&book, &mini);
        assert_eq!(mini.list_projects().len(), 1);
        assert!(
            mini.list_sections()
                .iter()
                .any(|s| s.project_ids.contains(&mini_shop.id))
        );
    }

    /// Each workspace's section names, in order, by workspace name.
    fn layout(mgr: &SessionManager) -> Vec<(String, Vec<String>)> {
        let sections = mgr.list_sections();
        let mut out: Vec<(String, Vec<String>)> = mgr
            .list_workspaces()
            .into_iter()
            .map(|w| {
                let names = w
                    .section_ids
                    .iter()
                    .map(|id| sections.iter().find(|s| &s.id == id).unwrap().name.clone())
                    .collect();
                (w.name, names)
            })
            .collect();
        out.sort();
        out
    }

    #[tokio::test]
    async fn a_section_moved_into_a_workspace_deleted_meanwhile_lands_in_the_same_place_on_both() {
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        let acme = book
            .create_workspace(WorkspaceCreate {
                name: "Acme".into(),
                color: WorkspaceColor::Blue,
                move_sections: vec![],
                claude_profile: None,
            })
            .unwrap();
        let mini_personal = mini.list_workspaces()[0].clone();
        let side = mini
            .create_section(&mini_personal.id, "Side projects")
            .unwrap();
        sync(&book, &mini);
        // Offline from each other: studio-mini moves a section into Acme
        // while the MacBook deletes Acme, which it sees empty.
        mini.move_section(&side.id, &acme.id).unwrap();
        book.delete_workspace(&acme.id).unwrap();
        sync(&book, &mini);
        assert_eq!(layout(&book), layout(&mini));
        assert!(!book.list_workspaces().iter().any(|w| w.id == acme.id));
        assert!(
            layout(&mini)
                .iter()
                .any(|(_, s)| s.contains(&"Side projects".to_string())),
            "{:?}",
            layout(&mini)
        );
    }

    #[tokio::test]
    async fn sections_reordered_on_one_member_are_in_that_order_on_the_other() {
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        let ws = book.list_workspaces()[0].clone();
        let a = book.create_section(&ws.id, "Acme").unwrap();
        let b = book.create_section(&ws.id, "Blog").unwrap();
        sync(&book, &mini);
        let mine = book.list_workspaces()[0].section_ids[0].clone();
        book.update_workspace(WorkspaceUpdate {
            id: ws.id.clone(),
            name: None,
            color: None,
            section_ids: Some(vec![b.id.clone(), mine, a.id.clone()]),
            claude_profile: None,
        })
        .unwrap();
        // Meanwhile studio-mini adds one at the end.
        mini.create_section(&ws.id, "Clients").unwrap();
        sync(&book, &mini);
        let expected = ["Blog", "My projects", "Acme", "Clients"]
            .map(String::from)
            .to_vec();
        let on = |m: &SessionManager| {
            m.list_workspaces()
                .into_iter()
                .find(|w| w.id == ws.id)
                .unwrap()
                .section_ids
                .len()
        };
        assert_eq!((on(&book), on(&mini)), (4, 4));
        let names = |m: &SessionManager| {
            let all = m.list_sections();
            m.list_workspaces()
                .into_iter()
                .find(|w| w.id == ws.id)
                .unwrap()
                .section_ids
                .iter()
                .map(|id| all.iter().find(|s| &s.id == id).unwrap().name.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&book), expected);
        assert_eq!(names(&mini), expected);
    }

    fn reload(home: &Path, name: &str) -> Arc<SessionManager> {
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let terminals = TerminalManager::new(home.join("s2.sock"), env);
        let mgr = SessionManager::load(home.join("state.json"), home.join("worktrees"), terminals);
        mgr.attach_account(home.join("account.json"), name).unwrap();
        mgr
    }

    #[tokio::test]
    async fn a_restarted_member_keeps_the_others_workspaces_and_its_count() {
        let (_h1, book) = member("book").await;
        let (h2, mini) = member("mini").await;
        sync(&book, &mini);
        let before = mini.account_version();
        drop(mini);
        let mini = reload(h2.path(), "mini");
        assert_eq!(names(&mini), ["Personal", "Personal"]);
        assert_eq!(mini.account_version(), before);
        // Its next change follows on from its earlier ones, so the other
        // member takes it.
        let w = mini
            .list_workspaces()
            .into_iter()
            .find(|w| book.list_workspaces()[0].id == w.id)
            .unwrap();
        mini.update_workspace(WorkspaceUpdate {
            id: w.id,
            name: Some("Home".into()),
            color: None,
            section_ids: None,
            claude_profile: None,
        })
        .unwrap();
        sync(&book, &mini);
        assert_eq!(names(&book), ["Home", "Personal"]);
    }

    #[tokio::test]
    async fn an_unreadable_log_is_kept_aside_and_made_again_from_the_state() {
        let (_h1, book) = member("book").await;
        let (h2, mini) = member("mini").await;
        // A member in use has made many more changes than its state holds.
        let own = mini.list_workspaces()[0].clone();
        for n in 0..40 {
            mini.update_workspace(WorkspaceUpdate {
                id: own.id.clone(),
                name: Some(format!("Personal {n}")),
                color: None,
                section_ids: None,
                claude_profile: None,
            })
            .unwrap();
        }
        mini.update_workspace(WorkspaceUpdate {
            id: own.id.clone(),
            name: Some("Personal".into()),
            color: None,
            section_ids: None,
            claude_profile: None,
        })
        .unwrap();
        sync(&book, &mini);
        drop(mini);
        std::fs::write(h2.path().join("account.json"), "{ not json").unwrap();
        let mini = reload(h2.path(), "mini");
        let bad: Vec<String> = std::fs::read_dir(h2.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().ends_with(".bad"))
            .map(|p| std::fs::read_to_string(p).unwrap())
            .collect();
        assert_eq!(bad, ["{ not json"]);
        // The new log counts its changes apart from the lost one, so no
        // member takes one of them for a change it already has.
        let logs = |m: &SessionManager| {
            m.account_version()
                .into_keys()
                .filter(|k| k.starts_with("mini"))
                .count()
        };
        assert_eq!(logs(&mini), 1);
        // The workspaces it had are still there, and still shared: its
        // changes from now on reach a member that saw the old log.
        assert_eq!(names(&mini), ["Personal", "Personal"]);
        sync(&book, &mini);
        let w = book.list_workspaces()[0].clone();
        mini.update_workspace(WorkspaceUpdate {
            id: w.id.clone(),
            name: Some("Home".into()),
            color: None,
            section_ids: None,
            claude_profile: None,
        })
        .unwrap();
        mini.create_section(&w.id, "Clients").unwrap();
        sync(&book, &mini);
        assert_eq!(names(&book), ["Home", "Personal"]);
        assert_eq!(layout(&book), layout(&mini));
        assert_eq!((logs(&book), logs(&mini)), (2, 2));
    }

    #[tokio::test]
    async fn changes_made_here_are_handed_on_and_changes_from_elsewhere_are_not() {
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        let sent = Arc::new(Mutex::new(Vec::<Change>::new()));
        let out = sent.clone();
        mini.on_account_change(move |c| out.lock().unwrap().extend(c));
        sync(&book, &mini);
        assert!(sent.lock().unwrap().is_empty());
        let ws = mini.list_workspaces()[0].clone();
        mini.create_section(&ws.id, "Clients").unwrap();
        let sent = sent.lock().unwrap().clone();
        assert!(!sent.is_empty());
        assert!(
            sent.iter()
                .all(|c| c.stamp.member.starts_with("mini.") && c.kind == "section"),
            "{sent:?}"
        );
        // The new section, field by field, and nothing else.
        let mut fields: Vec<String> = sent
            .iter()
            .map(|c| match &c.op {
                moonlet_proto::types::ChangeOp::Set { field, .. } => field.clone(),
                moonlet_proto::types::ChangeOp::Delete => "delete".into(),
            })
            .collect();
        fields.sort();
        assert_eq!(fields, ["created_at", "name", "order", "view", "workspace"]);
    }

    /// A repository whose origin is `github.com/acme/<name>`: test
    /// repositories share their first commit, so the origin tells them apart.
    async fn repo_named(name: &str) -> tempfile::TempDir {
        let repo = crate::git::tests::repo().await;
        let url = format!("https://github.com/acme/{name}.git");
        crate::git::git(repo.path(), &["remote", "add", "origin", &url])
            .await
            .unwrap();
        repo
    }

    /// A clone of `repo` with the same origin, as another Mac has it.
    async fn clone_of(repo: &tempfile::TempDir) -> tempfile::TempDir {
        let url = crate::git::git_text(repo.path(), &["remote", "get-url", "origin"])
            .await
            .unwrap();
        let clone = tempfile::tempdir().unwrap();
        crate::git::git(
            clone.path(),
            &["clone", "-q", &repo.path().display().to_string(), "."],
        )
        .await
        .unwrap();
        crate::git::git(clone.path(), &["remote", "set-url", "origin", &url])
            .await
            .unwrap();
        clone
    }

    fn holds(mgr: &SessionManager, section: &str) -> Vec<String> {
        let projects = mgr.list_projects();
        let s = mgr
            .list_sections()
            .into_iter()
            .find(|s| s.id == section)
            .unwrap();
        let mut names: Vec<String> = s
            .project_ids
            .iter()
            .map(|id| {
                projects
                    .iter()
                    .find(|p| &p.id == id)
                    .unwrap()
                    .identity
                    .origin
                    .clone()
                    .unwrap_or_default()
            })
            .chain(
                s.missing
                    .iter()
                    .map(|i| format!("missing {}", i.origin.clone().unwrap_or_default())),
            )
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn projects_two_members_add_to_one_section_at_once_are_both_kept() {
        let (shop, blog) = (repo_named("shop").await, repo_named("blog").await);
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        let ws = book.list_workspaces()[0].clone();
        let work = book.create_section(&ws.id, "1devstudio").unwrap();
        sync(&book, &mini);
        // Apart: each adds a project to the same section.
        book.section_add_project(&work.id, &shop.path().display().to_string())
            .await
            .unwrap();
        mini.section_add_project(&work.id, &blog.path().display().to_string())
            .await
            .unwrap();
        sync(&book, &mini);
        assert_eq!(
            holds(&book, &work.id),
            ["github.com/acme/shop", "missing github.com/acme/blog"]
        );
        assert_eq!(
            holds(&mini, &work.id),
            ["github.com/acme/blog", "missing github.com/acme/shop"]
        );
    }

    #[tokio::test]
    async fn a_section_deleted_with_projects_this_member_lacks_hands_them_on() {
        let shop = repo_named("shop").await;
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        let ws = book.list_workspaces()[0].clone();
        let first = book.list_sections()[0].clone();
        let work = book.create_section(&ws.id, "1devstudio").unwrap();
        book.section_add_project(&work.id, &shop.path().display().to_string())
            .await
            .unwrap();
        sync(&book, &mini);
        // studio-mini has no clone of shop, and deletes the section.
        mini.delete_section(&work.id).unwrap();
        sync(&book, &mini);
        assert_eq!(holds(&book, &first.id), ["github.com/acme/shop"]);
        assert_eq!(book.list_projects().len(), 1);
    }

    #[tokio::test]
    async fn a_project_kept_here_for_its_sessions_does_not_come_back_on_the_other_member() {
        let (_dirs, book, mini, work) = shared_project().await;
        let mini_shop = mini.list_projects()[0].clone();
        let req = SessionCreate {
            name: Some("Keep me".into()),
            agent: Some("none".into()),
            workspace_id: mini
                .list_workspaces()
                .into_iter()
                .find(|w| w.section_ids.contains(&work.id))
                .map(|w| w.id),
            cols: 80,
            rows: 24,
            ..SessionCreate::new(&mini_shop.id)
        };
        mini.create_session(req).await.unwrap();
        let shop = book.list_projects()[0].clone();
        book.section_remove_project(&work.id, &shop.id).unwrap();
        sync(&book, &mini);
        // studio-mini then adds another project to the same section.
        let blog = repo_named("blog").await;
        mini.section_add_project(&work.id, &blog.path().display().to_string())
            .await
            .unwrap();
        sync(&book, &mini);
        assert_eq!(holds(&book, &work.id), ["missing github.com/acme/blog"]);
    }

    #[tokio::test]
    async fn a_clone_added_here_is_no_longer_missing() {
        let shop = repo_named("shop").await;
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        let ws = book.list_workspaces()[0].clone();
        let work = book.create_section(&ws.id, "1devstudio").unwrap();
        book.section_add_project(&work.id, &shop.path().display().to_string())
            .await
            .unwrap();
        sync(&book, &mini);
        assert_eq!(holds(&mini, &work.id), ["missing github.com/acme/shop"]);
        let clone = clone_of(&shop).await;
        mini.section_add_project(&work.id, &clone.path().display().to_string())
            .await
            .unwrap();
        assert_eq!(holds(&mini, &work.id), ["github.com/acme/shop"]);
    }

    #[tokio::test]
    async fn the_log_is_readable_only_by_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let (home, _book) = member("book").await;
        let mode = std::fs::metadata(home.path().join("account.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[tokio::test]
    async fn an_edit_whose_state_could_not_be_saved_does_not_come_back_after_a_restart() {
        use std::os::unix::fs::PermissionsExt;
        let state = tempfile::tempdir().unwrap();
        let logs = tempfile::tempdir().unwrap();
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let load = || {
            let mgr = SessionManager::load(
                state.path().join("state.json"),
                state.path().join("worktrees"),
                TerminalManager::new(logs.path().join("s.sock"), env.clone()),
            );
            mgr.attach_account(logs.path().join("account.json"), "book")
                .unwrap();
            mgr
        };
        let book = load();
        let ws = book.list_workspaces()[0].clone();
        // The state's folder cannot be written: the rename fails.
        std::fs::set_permissions(state.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let failed = book.update_workspace(WorkspaceUpdate {
            id: ws.id.clone(),
            name: Some("Home".into()),
            color: None,
            section_ids: None,
            claude_profile: None,
        });
        std::fs::set_permissions(state.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(failed.is_err());
        drop(book);
        assert_eq!(load().list_workspaces()[0].name, "Personal");
    }

    #[tokio::test]
    async fn members_that_deleted_the_last_workspaces_apart_make_the_same_one_and_fill_it_alike() {
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        sync(&book, &mini);
        // Apart, each deletes one of the two "Personal" workspaces, with its
        // section: together they leave none.
        let ids: Vec<String> = book.list_workspaces().into_iter().map(|w| w.id).collect();
        for (m, id) in [(&book, &ids[0]), (&mini, &ids[1])] {
            let w = m
                .list_workspaces()
                .into_iter()
                .find(|w| &w.id == id)
                .unwrap();
            for s in &w.section_ids {
                m.delete_section(s).unwrap();
            }
            m.delete_workspace(id).unwrap();
        }
        sync(&book, &mini);
        let names = |m: &SessionManager| {
            m.list_workspaces()
                .into_iter()
                .map(|w| (w.id, w.name))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(&book),
            [("default".to_string(), "Personal".to_string())]
        );
        assert_eq!(names(&mini), names(&book));
        // A section made in it on one member is in it on the other.
        book.create_section("default", "Clients").unwrap();
        book.update_workspace(WorkspaceUpdate {
            id: "default".into(),
            name: Some("Home".into()),
            color: None,
            section_ids: None,
            claude_profile: None,
        })
        .unwrap();
        sync(&book, &mini);
        let clients = |m: &SessionManager| {
            let all = m.list_sections();
            m.list_workspaces()
                .into_iter()
                .map(|w| {
                    (
                        w.name.clone(),
                        w.section_ids
                            .iter()
                            .map(|id| all.iter().find(|s| &s.id == id).unwrap().name.clone())
                            .collect::<Vec<_>>(),
                    )
                })
                .collect::<Vec<_>>()
        };
        let both = [(
            "Home".to_string(),
            vec!["My projects".to_string(), "Clients".to_string()],
        )];
        assert_eq!(clients(&mini), both);
        assert_eq!(clients(&book), both);
    }

    #[tokio::test]
    async fn a_field_that_does_not_fit_takes_its_default() {
        use moonlet_proto::types::{ChangeOp, Stamp};
        let (_h1, book) = member("book").await;
        let at = |seq: u64, field: &str, value: serde_json::Value| Change {
            stamp: Stamp {
                ms: now_ms() + seq,
                n: 0,
                member: "mini.a1b2c3".into(),
            },
            seq,
            kind: "workspace".into(),
            id: "w9".into(),
            op: ChangeOp::Set {
                field: field.into(),
                value,
            },
        };
        book.apply_account(vec![
            at(1, "name", serde_json::json!("  Acme\u{7}\n ")),
            at(2, "color", serde_json::json!("purple")),
            at(3, "created_at", serde_json::json!(1)),
        ]);
        let w = book
            .list_workspaces()
            .into_iter()
            .find(|w| w.id == "w9")
            .unwrap();
        assert_eq!((w.name.as_str(), w.color), ("Acme", WorkspaceColor::Clay));
        book.apply_account(vec![at(4, "name", serde_json::json!(42))]);
        let w = book
            .list_workspaces()
            .into_iter()
            .find(|w| w.id == "w9")
            .unwrap();
        assert_eq!(w.name, "Personal");
    }

    #[tokio::test]
    async fn a_state_from_before_the_account_becomes_its_changes_with_the_same_ids() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("state.json"),
            r#"{"version":3,"workspaces":[{"id":"7c1e2a9b0d44","name":"Acme","color":"blue","section_ids":["3f6b8c2d1e90"],"claude_profile":null,"created_at":1790000000000}],"sections":[{"id":"3f6b8c2d1e90","name":"Clients","project_ids":[],"view":{"group_by":"status","sort_by":"name","filter":[]},"created_at":1790000000001}],"profiles":[],"projects":[],"sessions":[]}"#,
        )
        .unwrap();
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let book = SessionManager::load(
            home.path().join("state.json"),
            home.path().join("worktrees"),
            TerminalManager::new(home.path().join("s.sock"), env),
        );
        book.attach_account(home.path().join("account.json"), "book")
            .unwrap();
        let (_h2, mini) = member("mini").await;
        sync(&book, &mini);
        let acme = mini
            .list_workspaces()
            .into_iter()
            .find(|w| w.id == "7c1e2a9b0d44")
            .unwrap();
        assert_eq!(
            (acme.name.as_str(), acme.color, acme.section_ids.as_slice()),
            (
                "Acme",
                WorkspaceColor::Blue,
                ["3f6b8c2d1e90".to_string()].as_slice()
            )
        );
        let clients = mini
            .list_sections()
            .into_iter()
            .find(|s| s.id == "3f6b8c2d1e90")
            .unwrap();
        assert_eq!(
            (
                clients.name.as_str(),
                clients.view.group_by.as_str(),
                clients.view.sort_by.as_str()
            ),
            ("Clients", "status", "name")
        );
    }

    #[tokio::test]
    async fn a_log_made_again_gives_way_to_changes_it_had_not_seen_and_keeps_every_bad_file() {
        let (_h1, book) = member("book").await;
        let (h2, mini) = member("mini").await;
        sync(&book, &mini);
        drop(mini);
        let w = book.list_workspaces()[0].clone();
        // A rename studio-mini has not seen when its log is lost, twice.
        book.update_workspace(WorkspaceUpdate {
            id: w.id.clone(),
            name: Some("Home".into()),
            color: None,
            section_ids: None,
            claude_profile: None,
        })
        .unwrap();
        for _ in 0..2 {
            std::fs::write(h2.path().join("account.json"), "{ not json").unwrap();
            drop(reload(h2.path(), "mini"));
        }
        let bad = std::fs::read_dir(h2.path())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".bad")
            })
            .count();
        assert_eq!(bad, 2);
        let mini = reload(h2.path(), "mini");
        sync(&book, &mini);
        assert!(
            names(&mini).contains(&"Home".to_string()),
            "{:?}",
            names(&mini)
        );
        assert!(
            names(&book).contains(&"Home".to_string()),
            "{:?}",
            names(&book)
        );
    }

    #[tokio::test]
    async fn another_members_section_keeps_its_project_order_through_this_members_changes() {
        let (shop, blog) = (repo_named("shop").await, repo_named("blog").await);
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        let first = book.list_sections()[0].clone();
        book.section_add_project(&first.id, &blog.path().display().to_string())
            .await
            .unwrap();
        book.section_add_project(&first.id, &shop.path().display().to_string())
            .await
            .unwrap();
        // studio-mini has shop only.
        let clone = clone_of(&shop).await;
        mini.add_project(&clone.path().display().to_string())
            .await
            .unwrap();
        sync(&book, &mini);
        let before = book.account_version();
        // Any change on studio-mini, not about that section.
        let minis = mini
            .list_workspaces()
            .into_iter()
            .find(|w| {
                !book
                    .list_sections()
                    .iter()
                    .any(|s| w.section_ids.contains(&s.id) && s.id == first.id)
            })
            .unwrap();
        mini.update_workspace(WorkspaceUpdate {
            id: minis.id,
            name: Some("Studio".into()),
            color: None,
            section_ids: None,
            claude_profile: None,
        })
        .unwrap();
        let sent: Vec<String> = mini
            .account_changes_for(&before)
            .into_iter()
            .filter(|c| c.id == first.id)
            .map(|c| format!("{:?}", c.op))
            .collect();
        assert!(sent.is_empty(), "{sent:?}");
        sync(&book, &mini);
        assert_eq!(
            holds_in_order(&book, &first.id),
            ["github.com/acme/blog", "github.com/acme/shop"]
        );
    }

    #[tokio::test]
    async fn projects_reordered_on_one_member_are_in_that_order_on_the_other() {
        let (shop, blog) = (repo_named("shop").await, repo_named("blog").await);
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        let first = book.list_sections()[0].clone();
        let b = book
            .section_add_project(&first.id, &blog.path().display().to_string())
            .await
            .unwrap();
        let s = book
            .section_add_project(&first.id, &shop.path().display().to_string())
            .await
            .unwrap();
        let (c1, c2) = (clone_of(&shop).await, clone_of(&blog).await);
        mini.add_project(&c1.path().display().to_string())
            .await
            .unwrap();
        mini.add_project(&c2.path().display().to_string())
            .await
            .unwrap();
        sync(&book, &mini);
        book.update_section(SectionUpdate {
            id: first.id.clone(),
            name: None,
            project_ids: Some(vec![s.id.clone(), b.id.clone()]),
            view: None,
        })
        .unwrap();
        sync(&book, &mini);
        assert_eq!(
            holds_in_order(&mini, &first.id),
            ["github.com/acme/shop", "github.com/acme/blog"]
        );
    }

    #[tokio::test]
    async fn two_checkouts_of_one_repository_on_one_member_both_stay() {
        // Two folders with the same first commit and origin: one project
        // to the account, two here.
        let one = repo_named("shop").await;
        let two = clone_of(&one).await;
        let (_h1, book) = member("book").await;
        let a = book
            .add_project(&one.path().display().to_string())
            .await
            .unwrap();
        let b = book
            .add_project(&two.path().display().to_string())
            .await
            .unwrap();
        let mut ids: Vec<String> = book.list_projects().into_iter().map(|p| p.id).collect();
        ids.sort();
        let mut want = vec![a.id.clone(), b.id.clone()];
        want.sort();
        assert_eq!(ids, want);
        let first = book.list_sections()[0].clone();
        assert!(
            first.project_ids.contains(&a.id) && first.project_ids.contains(&b.id),
            "{first:?}"
        );
    }

    fn holds_in_order(mgr: &SessionManager, section: &str) -> Vec<String> {
        let projects = mgr.list_projects();
        let s = mgr
            .list_sections()
            .into_iter()
            .find(|s| s.id == section)
            .unwrap();
        s.project_ids
            .iter()
            .map(|id| {
                projects
                    .iter()
                    .find(|p| &p.id == id)
                    .unwrap()
                    .identity
                    .origin
                    .clone()
                    .unwrap_or_default()
            })
            .collect()
    }
}
