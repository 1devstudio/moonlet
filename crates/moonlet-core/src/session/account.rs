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
use crate::account::{
    Log, LogFile, Record, RecordKind, Version, key_between, log_owner, new_log_name,
};
use crate::identity::same_project;

const WORKSPACE: RecordKind = RecordKind::Workspace;
const SECTION: RecordKind = RecordKind::Section;
/// The prefix of a section's project fields.
const PROJECT: &str = "project:";
/// The ids of the workspace and the section every member makes when changes
/// from several members together left none, so they all make the same
/// ones. A deleted one stays deleted, so the next is `default-2` and so on.
const DEFAULT_WORKSPACE_ID: &str = "default";
const DEFAULT_SECTION_ID: &str = "default-section";
/// A workspace merged into another: its `into` (X68).
const MERGE: RecordKind = RecordKind::Merge;
/// A member, by its log's name: its `name`, as it calls itself.
const MEMBER: RecordKind = RecordKind::Member;
/// A design system or workspace design shared with every member (X71).
const DESIGN: RecordKind = RecordKind::Design;
/// A session, so every member knows which member runs it (X72).
const SESSION: RecordKind = RecordKind::Session;

type Listener = Arc<dyn Fn(Vec<Change>) + Send + Sync>;
type Applied = Arc<dyn Fn(&[Change]) + Send + Sync>;

/// How far ahead of this machine's clock a change may be stamped. One
/// further ahead would win every field from then on and pull every
/// member's clock forward with it, so it is refused, and stays with its
/// member until its clock is right.
const AHEAD_MS: u64 = 24 * 60 * 60 * 1000;

pub(super) struct Account {
    log: Log,
    path: PathBuf,
    listener: Option<Listener>,
    /// Called with the changes taken from other members.
    applied: Option<Applied>,
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
                    // Never over an earlier one, even from the same millisecond.
                    let ms = now_ms();
                    let bad = (1..)
                        .map(|n| {
                            path.with_extension(if n == 1 {
                                format!("json.{ms}.bad")
                            } else {
                                format!("json.{ms}-{n}.bad")
                            })
                        })
                        .find(|p| !p.exists())
                        .unwrap();
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
                // A log named after another worker id (link.json was made
                // again) goes on under a new name: its central host takes
                // changes only under this machine's worker id. It takes over
                // the old log's changes, so those made before still get
                // there, and the old name stays reserved.
                let old = f.member.clone();
                let renamed = log_owner(&old) != Some(member);
                let mut log = Log::from_file(LogFile {
                    member: if renamed {
                        new_log_name(member)
                    } else {
                        old.clone()
                    },
                    ..f
                });
                if renamed {
                    log.adopt(&old);
                    write_private(&path, &log)?;
                }
                let mut next = st.clone();
                lay_onto(&mut next, &log);
                self.save(&next)?;
                *st = next;
                // Sessions made before X72, or while the log was away,
                // get their records now.
                if !session_changes(&st, &mut log, now_ms()).is_empty() {
                    write_private(&path, &log)?;
                }
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
            applied: None,
        });
        Ok(())
    }

    /// The names of this member's log, now and before: no other member
    /// may send changes under them.
    pub fn account_names(&self) -> Vec<String> {
        self.with_log(|log| {
            log.former()
                .iter()
                .cloned()
                .chain([log.member().to_string()])
                .collect()
        })
    }

    /// The account this member shares, as its central host named it.
    pub fn central_account(&self) -> Option<String> {
        self.with_log(|log| log.account().map(String::from))
    }

    /// Keeps the account its central host names, or none once it has no
    /// central host; true when that changed.
    pub fn set_central_account(&self, account: Option<String>) -> bool {
        let mut guard = self.account.lock().unwrap();
        let Some(a) = guard.as_mut() else {
            return false;
        };
        if a.log.account() == account.as_deref() {
            return false;
        }
        let mut log = a.log.clone();
        log.set_account(account);
        if let Err(e) = write_private(&a.path, &log) {
            tracing::warn!("cannot save the account's name: {e:#}");
        }
        a.log = log;
        true
    }

    /// Gives this member's name to the account, as the Mac calls itself,
    /// so the others can say which one made a workspace.
    pub fn name_member(&self, name: &str) {
        let changes = {
            let mut st = self.state.lock().unwrap();
            let mut account = self.account.lock().unwrap();
            let Some(a) = account.as_mut() else { return };
            let me = a.log.member().to_string();
            if a.log.records(MEMBER).get(&me).and_then(|r| r.get("name")) == Some(&json!(name)) {
                return;
            }
            let mut log = a.log.clone();
            let change = log.set(now_ms(), MEMBER, &me, "name", json!(name));
            let mut next = st.clone();
            lay_onto(&mut next, &log);
            if let Err(e) = write_private(&a.path, &log).and_then(|()| self.save(&next)) {
                tracing::warn!("cannot save this member's name: {e:#}");
                return;
            }
            a.log = log;
            *st = next;
            vec![change]
        };
        self.emit_workspaces();
        self.account_changed(changes);
    }

    /// The design systems and workspace designs of the account (X71), by
    /// record id; none without an account.
    pub fn design_records(&self) -> Map<String, Record> {
        self.with_log(|log| log.records(DESIGN))
    }

    /// Sets the fields of design record `id` that differ from `fields`, as
    /// this member's changes, and sends them on; true when one changed.
    pub fn set_design(&self, id: &str, fields: &[(&str, Value)]) -> bool {
        let changes = {
            let mut account = self.account.lock().unwrap();
            let Some(a) = account.as_mut() else { return false };
            if a.log.is_deleted(DESIGN, id) {
                return false;
            }
            let now = a.log.records(DESIGN).remove(id).unwrap_or_default();
            let mut log = a.log.clone();
            let changes: Vec<Change> = fields
                .iter()
                .filter(|(field, value)| now.get(*field) != Some(value))
                .map(|(field, value)| log.set(now_ms(), DESIGN, id, field, value.clone()))
                .collect();
            if changes.is_empty() {
                return false;
            }
            if let Err(e) = write_private(&a.path, &log) {
                tracing::warn!("cannot save a design's record: {e:#}");
                return false;
            }
            a.log = log;
            changes
        };
        self.account_changed(changes);
        true
    }

    /// Deletes design record `id` for good, and sends that on.
    pub fn delete_design(&self, id: &str) {
        let change = {
            let mut account = self.account.lock().unwrap();
            let Some(a) = account.as_mut() else { return };
            if a.log.is_deleted(DESIGN, id) {
                return;
            }
            let mut log = a.log.clone();
            let change = log.delete(now_ms(), DESIGN, id);
            if let Err(e) = write_private(&a.path, &log) {
                tracing::warn!("cannot save a design's removal: {e:#}");
                return;
            }
            a.log = log;
            change
        };
        self.account_changed(vec![change]);
    }

    /// The sessions of the account (X72), by session id; none without an
    /// account. Only the changes of the member that made a session count,
    /// and its `owner` must be that member: a member cannot claim another's
    /// session, nor make one in another's name.
    pub fn session_records(&self) -> Map<String, Record> {
        self.with_log(|log| {
            log.records_by_maker(SESSION)
                .into_iter()
                .filter(|(id, r)| {
                    let maker = log.first_change(SESSION, id).and_then(|c| log_owner(&c.stamp.member));
                    maker.is_some() && r.get("owner").and_then(Value::as_str) == maker
                })
                .collect()
        })
    }

    /// Each member's name as it calls itself, by worker id (X71).
    pub fn member_names(&self) -> Map<String, String> {
        self.with_log(|log| {
            log.records(MEMBER)
                .into_iter()
                .filter_map(|(name, r)| Some((log_owner(&name)?.to_string(), r.get("name")?.as_str()?.to_string())))
                .collect()
        })
    }

    /// Called with the changes this member takes from the others.
    pub fn on_account_applied(&self, f: impl Fn(&[Change]) + Send + Sync + 'static) {
        if let Some(a) = self.account.lock().unwrap().as_mut() {
            a.applied = Some(Arc::new(f));
        }
    }

    /// Whether this member shares an account (X68).
    pub fn has_account(&self) -> bool {
        self.account.lock().unwrap().is_some()
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
    /// Returns those it had not seen and kept: the ones to pass on.
    pub fn apply_account(&self, changes: Vec<Change>) -> Vec<Change> {
        let limit = now_ms() + AHEAD_MS;
        let (changes, ahead): (Vec<Change>, Vec<Change>) =
            changes.into_iter().partition(|c| c.stamp.ms <= limit);
        if let Some(c) = ahead.first() {
            tracing::warn!(member = %c.stamp.member, "refused {} account changes stamped more than a day ahead", ahead.len());
        }
        let (taken, own) = {
            let mut st = self.state.lock().unwrap();
            let mut account = self.account.lock().unwrap();
            let Some(a) = account.as_mut() else {
                return Vec::new();
            };
            let mut log = a.log.clone();
            // Only the first of two changes under one number counts, as in
            // the log, so the others are never handed the second.
            let mut seen = std::collections::HashSet::new();
            let new: Vec<Change> = changes
                .into_iter()
                .filter(|c| !log.has(&c.stamp.member, c.seq) && seen.insert((c.stamp.member.clone(), c.seq)))
                .collect();
            if new.is_empty() {
                return Vec::new();
            }
            log.apply(new.clone());
            let mut next = st.clone();
            lay_onto(&mut next, &log);
            // Another member's merge can move this member's sessions to
            // another workspace: their records follow (X72).
            let own = session_changes(&next, &mut log, now_ms());
            match write_private(&a.path, &log).and_then(|()| self.save(&next)) {
                Ok(()) => {
                    a.log = log;
                    *st = next;
                    (new, Some(own))
                }
                Err(e) => {
                    tracing::warn!("cannot save the account's changes: {e:#}");
                    (Vec::new(), None)
                }
            }
        };
        let changed = own.is_some();
        if let Some(own) = own.filter(|o| !o.is_empty()) {
            self.account_changed(own);
        }
        if changed {
            self.emit_all();
            let applied = self.account.lock().unwrap().as_ref().and_then(|a| a.applied.clone());
            if let Some(f) = applied {
                f(&taken);
            }
        }
        taken
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
    for (from, into) in &new.merges {
        if old.merges.get(from) != Some(into) {
            out.push(log.set(now, MERGE, from, "into", json!(into)));
        }
    }
    out.extend(session_changes(new, log, now));
    out
}

/// This member's own session as account fields (X72): what the other
/// members show of it, with `owner` this member's worker id. A project
/// without an identity gives `null`, as it is this member's alone.
fn session_fields(st: &State, s: &Session, owner: &str) -> Record {
    let project = st
        .projects
        .iter()
        .find(|p| p.id == s.project_id)
        .filter(|p| identity_key(&p.identity).is_some())
        .map(|p| json!({ "origin": p.identity.origin, "root": p.identity.root }))
        .unwrap_or(Value::Null);
    Record::from([
        ("name".to_string(), json!(s.name)),
        ("project".to_string(), project),
        ("workspace".to_string(), json!(s.workspace_id)),
        ("branch".to_string(), json!(s.branch)),
        ("owner".to_string(), json!(owner)),
        ("created_at".to_string(), json!(s.created_at)),
        ("archived".to_string(), json!(s.archived)),
    ])
}

/// Records in `log` what changed of this member's own sessions since their
/// records: their fields, and the records of sessions it no longer has.
/// Sessions another member owns are that member's to record.
fn session_changes(st: &State, log: &mut Log, now: u64) -> Vec<Change> {
    let Some(me) = log_owner(log.member()).map(str::to_string) else {
        return Vec::new();
    };
    let records = log.records(SESSION);
    let mut out = Vec::new();
    for s in st.sessions.iter().filter(|s| s.owner.is_none()) {
        if log.is_deleted(SESSION, &s.id) {
            continue;
        }
        let had = records.get(&s.id);
        for (field, value) in session_fields(st, s, &me) {
            if had.and_then(|r| r.get(&field)) != Some(&value) {
                out.push(log.set(now, SESSION, &s.id, &field, value));
            }
        }
    }
    for (id, _) in records.iter().filter(|(id, r)| {
        r.get("owner").and_then(Value::as_str) == Some(me.as_str())
            && !st.sessions.iter().any(|s| &s.id == *id)
    }) {
        out.push(log.delete(now, SESSION, id));
    }
    out
}

fn set_changed(
    log: &mut Log,
    now: u64,
    kind: RecordKind,
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
fn repair_id(log: &Log, kind: RecordKind, base: &str) -> String {
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

/// The name of the member that made workspace `id`: the member record of
/// the log of its first change, or of that log's worker under a later name.
fn maker(log: &Log, id: &str) -> Option<String> {
    let made = &log.first_change(WORKSPACE, id)?.stamp.member;
    let members = log.records(MEMBER);
    let name = |r: &Record| r.get("name")?.as_str().map(String::from);
    members.get(made).and_then(name).or_else(|| {
        let worker = log_owner(made)?;
        members
            .iter()
            .filter(|(m, _)| log_owner(m) == Some(worker))
            .find_map(|(_, r)| name(r))
    })
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
            made_by: maker(log, &id),
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

    // Sessions of a merged workspace follow it, on every member alike.
    st.merges = log
        .records(MERGE)
        .into_iter()
        .filter_map(|(from, r)| Some((from, r.get("into")?.as_str()?.to_string())))
        .collect();
    for s in &mut st.sessions {
        let mut at = s.workspace_id.clone();
        for _ in 0..8 {
            match at
                .as_ref()
                .filter(|w| !st.workspaces.iter().any(|x| &x.id == *w))
                .and_then(|w| st.merges.get(w))
            {
                Some(into) => at = Some(into.clone()),
                None => break,
            }
        }
        if at
            .as_ref()
            .is_some_and(|w| st.workspaces.iter().any(|x| &x.id == w))
        {
            s.workspace_id = at;
        }
    }

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
        let mine = book
            .list_workspaces()
            .into_iter()
            .find(|w| w.id == ws.id)
            .unwrap()
            .section_ids[0]
            .clone();
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
    async fn a_log_named_after_an_older_worker_id_goes_on_under_the_new_one() {
        let (_h1, book) = member("book").await;
        let (h2, mini) = member("mini").await;
        sync(&book, &mini);
        drop(mini);
        // link.json was made again, with a new worker id.
        let mini = reload(h2.path(), "mini2");
        assert_eq!(names(&mini), ["Personal", "Personal"]);
        let sent = Arc::new(Mutex::new(Vec::<Change>::new()));
        let out = sent.clone();
        mini.on_account_change(move |c| out.lock().unwrap().extend(c));
        let ws = mini.list_workspaces()[0].clone();
        mini.create_section(&ws.id, "Clients").unwrap();
        let sent = sent.lock().unwrap().clone();
        assert!(!sent.is_empty());
        assert!(
            sent.iter().all(|c| c.stamp.member.starts_with("mini2.")),
            "{sent:?}"
        );
    }

    #[tokio::test]
    async fn a_merged_workspace_hands_its_sections_and_sessions_to_the_chosen_one_on_every_member()
    {
        let shop = crate::git::tests::repo().await;
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        let minis = mini.list_workspaces()[0].clone();
        let mini_section = mini.list_sections()[0].clone();
        let p = mini
            .section_add_project(&mini_section.id, &shop.path().display().to_string())
            .await
            .unwrap();
        let req = SessionCreate {
            name: Some("Fix cart".into()),
            agent: Some("none".into()),
            workspace_id: Some(minis.id.clone()),
            cols: 80,
            rows: 24,
            ..SessionCreate::new(&p.id)
        };
        let session = mini.create_session(req).await.unwrap();
        let books = book.list_workspaces()[0].clone();
        let book_section = book.list_sections()[0].clone();
        sync(&book, &mini);

        // On the MacBook: studio-mini's "Personal" into its own.
        book.merge_workspace(&minis.id, &books.id).unwrap();
        sync(&book, &mini);
        for m in [&book, &mini] {
            let ws = m.list_workspaces();
            assert_eq!(
                ws.iter().map(|w| w.id.clone()).collect::<Vec<_>>(),
                [books.id.clone()]
            );
            assert_eq!(
                ws[0].section_ids,
                [book_section.id.clone(), mini_section.id.clone()]
            );
        }
        let moved = mini
            .list_sessions()
            .into_iter()
            .find(|s| s.id == session.id)
            .unwrap();
        assert_eq!(moved.workspace_id, Some(books.id.clone()));
    }

    #[tokio::test]
    async fn a_workspace_merges_only_into_another_existing_one() {
        let (_h1, book) = member("book").await;
        let ws = book.list_workspaces()[0].clone();
        assert!(book.merge_workspace(&ws.id, &ws.id).is_err());
        assert!(book.merge_workspace(&ws.id, "nowhere").is_err());
        assert!(book.merge_workspace("nowhere", &ws.id).is_err());
        assert_eq!(book.list_workspaces().len(), 1);
    }

    #[tokio::test]
    async fn a_change_stamped_more_than_a_day_ahead_is_refused() {
        use moonlet_proto::types::{ChangeOp, Stamp};
        let (_h1, book) = member("book").await;
        let w = book.list_workspaces()[0].clone();
        let at = |ms: u64, seq: u64, name: &str| Change {
            stamp: Stamp {
                ms,
                n: 0,
                member: "mini.a1b2c3".into(),
            },
            seq,
            kind: "workspace".into(),
            id: w.id.clone(),
            op: ChangeOp::Set {
                field: "name".into(),
                value: serde_json::json!(name),
            },
        };
        let day = 24 * 60 * 60 * 1000;
        // A clock two days fast would win every field from now on, and drag
        // every member's clock with it.
        book.apply_account(vec![at(now_ms() + 2 * day, 1, "From the future")]);
        assert_eq!(book.list_workspaces()[0].name, "Personal");
        assert!(!book.account_version().contains_key("mini.a1b2c3"));
        // An hour fast is a clock that drifted, and is taken.
        book.apply_account(vec![at(now_ms() + 60 * 60 * 1000, 1, "Home")]);
        assert_eq!(book.list_workspaces()[0].name, "Home");
    }

    #[tokio::test]
    async fn a_design_record_set_on_one_member_reads_the_same_on_another_and_a_deleted_one_is_gone() {
        use serde_json::json;
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        let heard = Arc::new(Mutex::new(Vec::<String>::new()));
        let out = heard.clone();
        mini.on_account_applied(move |c| out.lock().unwrap().extend(c.iter().map(|c| c.kind.clone())));
        assert!(book.set_design("d-acme", &[("workspace", json!("w-1")), ("slug", json!("acme-web")), ("owner", json!("book"))]));
        // Setting what is already there changes nothing.
        assert!(!book.set_design("d-acme", &[("owner", json!("book"))]));
        sync(&book, &mini);
        let records = mini.design_records();
        assert_eq!(records.len(), 1);
        assert_eq!(records["d-acme"]["slug"], json!("acme-web"));
        assert_eq!(records["d-acme"]["owner"], json!("book"));
        assert!(heard.lock().unwrap().iter().all(|k| k == "design" || k == "member" || k == "workspace" || k == "section"));
        assert!(heard.lock().unwrap().iter().any(|k| k == "design"));
        mini.delete_design("d-acme");
        sync(&book, &mini);
        assert!(book.design_records().is_empty());
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
    async fn sessions_from_before_x72_get_records_the_other_members_read() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("state.json"),
            r#"{"version":3,"workspaces":[{"id":"7c1e2a9b0d44","name":"Acme","color":"blue","section_ids":["3f6b8c2d1e90"],"claude_profile":null,"created_at":1790000000000}],"sections":[{"id":"3f6b8c2d1e90","name":"Clients","project_ids":["a1b2c3d4e5f6"],"view":{"group_by":"status","sort_by":"name","filter":[]},"created_at":1790000000001}],"profiles":[],"projects":[{"id":"a1b2c3d4e5f6","name":"shop","path":"/Users/alex/src/shop","base_branch":"main","identity":{"origin":"github.com/acme/shop","root":"9f2c4e1a7b3d5f6e8a0c2e4f6a8b0c2d4e6f8a0b"}}],"sessions":[{"id":"5e7f9a1b3c5d","project_id":"a1b2c3d4e5f6","name":"fix-cart","branch":"moonlet/fix-cart","base":"main","path":"/Users/alex/.moonlet/worktrees/shop/fix-cart","agent":"claude","archived":false,"created_at":1790000000002,"workspace_id":"7c1e2a9b0d44"}]}"#,
        )
        .unwrap();
        // A log from before X72: it has the workspace, but no session.
        std::fs::write(
            home.path().join("account.json"),
            r#"{"member":"book.k3x9q2","changes":[{"stamp":{"ms":1790000000003,"n":0,"member":"book.k3x9q2"},"seq":1,"kind":"workspace","id":"7c1e2a9b0d44","op":{"set":{"field":"name","value":"Acme"}}}]}"#,
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
        let records = mini.session_records();
        let fix_cart = records.get("5e7f9a1b3c5d").expect("fix-cart's record");
        assert_eq!(
            serde_json::Value::Object(fix_cart.clone().into_iter().collect()),
            serde_json::json!({
                "name": "fix-cart",
                "project": { "origin": "github.com/acme/shop", "root": "9f2c4e1a7b3d5f6e8a0c2e4f6a8b0c2d4e6f8a0b" },
                "workspace": "7c1e2a9b0d44",
                "branch": "moonlet/fix-cart",
                "owner": "book",
                "created_at": 1790000000002u64,
                "archived": false,
            })
        );
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

    #[tokio::test]
    async fn sessions_of_a_merged_workspace_join_the_chosen_one_on_the_other_member_too() {
        let shop = repo_named("shop").await;
        // studio-mini's "Personal" is made first, so it comes before the
        // MacBook's.
        let (_h2, mini) = member("mini").await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let (_h1, book) = member("book").await;
        let minis = mini.list_workspaces()[0].clone();
        let mine = mini.list_sections()[0].clone();
        let p = mini
            .section_add_project(&mine.id, &shop.path().display().to_string())
            .await
            .unwrap();
        // Acme holds shop too, and a session works in it.
        let acme = mini
            .create_workspace(WorkspaceCreate {
                name: "Acme".into(),
                color: WorkspaceColor::Blue,
                move_sections: vec![],
                claude_profile: None,
            })
            .unwrap();
        let work = mini.create_section(&acme.id, "Shop work").unwrap();
        mini.section_add_project(&work.id, &shop.path().display().to_string())
            .await
            .unwrap();
        let req = SessionCreate {
            name: Some("Fix cart".into()),
            agent: Some("none".into()),
            workspace_id: Some(acme.id.clone()),
            cols: 80,
            rows: 24,
            ..SessionCreate::new(&p.id)
        };
        let session = mini.create_session(req).await.unwrap();
        sync(&book, &mini);
        // The MacBook merges Acme into its own "Personal".
        let books = book
            .list_workspaces()
            .into_iter()
            .find(|w| w.id != minis.id && w.id != acme.id)
            .unwrap();
        book.merge_workspace(&acme.id, &books.id).unwrap();
        sync(&book, &mini);
        let moved = mini
            .list_sessions()
            .into_iter()
            .find(|s| s.id == session.id)
            .unwrap();
        assert_eq!(moved.workspace_id, Some(books.id.clone()));
        // Its record follows it there on every member (X72).
        assert_eq!(
            book.session_records()[&session.id]["workspace"],
            serde_json::json!(books.id)
        );
    }

    #[tokio::test]
    async fn a_member_cannot_claim_another_members_session_nor_make_one_in_its_name() {
        let shop = repo_named("shop").await;
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        let mine = book.list_sections()[0].clone();
        let p = book
            .section_add_project(&mine.id, &shop.path().display().to_string())
            .await
            .unwrap();
        let session = book
            .create_session(SessionCreate {
                name: Some("Fix cart".into()),
                agent: Some("none".into()),
                cols: 80,
                rows: 24,
                ..SessionCreate::new(&p.id)
            })
            .await
            .unwrap();
        sync(&book, &mini);
        let at = |n: u64| moonlet_proto::types::Stamp { ms: now_ms() + n, n: 0, member: "air.k3x9q2".into() };
        let forged = |seq: u64, id: &str, field: &str, value: serde_json::Value| Change {
            stamp: at(seq),
            seq,
            kind: "session".into(),
            id: id.into(),
            op: moonlet_proto::types::ChangeOp::Set { field: field.into(), value },
        };
        // Another member takes book's session for itself, and makes one
        // that says it is book's.
        mini.apply_account(vec![
            forged(1, &session.id, "owner", serde_json::json!("air")),
            forged(2, "0a1b2c3d4e5f", "owner", serde_json::json!("book")),
            forged(3, "0a1b2c3d4e5f", "name", serde_json::json!("not book's")),
        ]);
        let records = mini.session_records();
        assert_eq!(records[&session.id]["owner"], serde_json::json!("book"));
        assert!(!records.contains_key("0a1b2c3d4e5f"));
    }


    #[tokio::test]
    async fn a_workspace_says_which_member_made_it() {
        let (_h1, book) = member("book").await;
        let (_h2, mini) = member("mini").await;
        book.name_member("Alex's MacBook Pro");
        mini.name_member("studio-mini");
        let acme = book
            .create_workspace(WorkspaceCreate {
                name: "Acme".into(),
                color: WorkspaceColor::Blue,
                move_sections: vec![],
                claude_profile: None,
            })
            .unwrap();
        sync(&book, &mini);
        let made_by = |m: &SessionManager, id: &str| {
            m.list_workspaces()
                .into_iter()
                .find(|w| w.id == id)
                .unwrap()
                .made_by
        };
        assert_eq!(
            made_by(&mini, &acme.id).as_deref(),
            Some("Alex's MacBook Pro")
        );
        let minis = mini.list_workspaces().into_iter().find(|w| {
            w.name == "Personal" && made_by(&mini, &w.id).as_deref() == Some("studio-mini")
        });
        assert!(minis.is_some(), "{:?}", mini.list_workspaces());
        // A new name for the Mac follows.
        book.name_member("Alex's MacBook");
        sync(&book, &mini);
        assert_eq!(made_by(&mini, &acme.id).as_deref(), Some("Alex's MacBook"));
    }
}
