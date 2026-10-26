//! Workspaces and sections in the account state (X68, ADR 0014). A change
//! made here is found by comparing the state before and after it, so X32's
//! rules stay where they are; changes from other members are laid back onto
//! this member's state, mapping project identities to its own projects.

use moonlet_proto::types::{Change, ProjectIdentity};
use serde_json::{Value, json};

use super::*;
use crate::account::{Log, LogFile, Record, Version, key_between};
use crate::identity::same_project;

const WORKSPACE: &str = "workspace";
/// The id of the workspace every member makes when changes from several
/// members together left none, so they all make the same one.
const DEFAULT_ID: &str = "default";
const SECTION: &str = "section";

type Listener = Arc<dyn Fn(Vec<Change>) + Send + Sync>;

pub(super) struct Account {
    pub(super) log: Log,
    path: PathBuf,
    listener: Option<Listener>,
}

impl Account {
    /// The log with the changes that turn `old` into `new`, and those
    /// changes; the log is saved, the account itself left as it is.
    pub(super) fn record(&self, old: &State, new: &State) -> Result<(Log, Vec<Change>)> {
        let mut log = self.log.clone();
        let changes = diff(old, new, &mut log, now_ms());
        if !changes.is_empty() {
            save_log(&self.path, &log)?;
        }
        Ok((log, changes))
    }
}

fn save_log(path: &Path, log: &Log) -> Result<()> {
    if let Some(dir) = path.parent() {
        crate::paths::ensure_private_dir(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&log.to_file())?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

impl SessionManager {
    /// Shares this member's workspaces and sections (X68). The first time,
    /// they become the changes of a new log, keeping their ids; a log that
    /// cannot be read is kept aside and made again the same way. Each new
    /// log is named after `member` with a suffix of its own, so a log made
    /// again never numbers its changes as the lost one did.
    pub fn attach_account(&self, path: PathBuf, member: &str) -> Result<()> {
        let file = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<LogFile>(&bytes) {
                Ok(f) => Some(f),
                Err(e) => {
                    let bad = path.with_extension("json.bad");
                    tracing::warn!(
                        "cannot read {} ({e}); kept it as {}",
                        path.display(),
                        bad.display()
                    );
                    std::fs::rename(&path, &bad)?;
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
                let mut log = Log::new(&format!("{member}.{}", &new_id()[..6]));
                diff(&State::default(), &st, &mut log, now_ms());
                save_log(&path, &log)?;
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

    /// What this member has seen of the account; empty without one.
    pub fn account_version(&self) -> Version {
        self.account
            .lock()
            .unwrap()
            .as_ref()
            .map(|a| a.log.version())
            .unwrap_or_default()
    }

    /// The changes a member at `version` lacks.
    pub fn account_changes_for(&self, version: &Version) -> Vec<Change> {
        self.account
            .lock()
            .unwrap()
            .as_ref()
            .map(|a| a.log.missing_for(version))
            .unwrap_or_default()
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
                let saved = save_log(&a.path, &log).and_then(|()| self.save(&next));
                match saved {
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

/// A section as account fields, its projects by identity: this member's
/// own that have one, then those it does not have.
fn section_fields(st: &State, s: &Section) -> Record {
    let mut projects: Vec<Value> = s
        .project_ids
        .iter()
        .filter_map(|id| st.projects.iter().find(|p| &p.id == id))
        .filter(|p| p.identity.root.is_some())
        .map(|p| json!(p.identity))
        .collect();
    projects.extend(s.missing.iter().map(|i| json!(i)));
    let workspace = st
        .workspace_of_section(&s.id)
        .map(|i| json!(st.workspaces[i].id))
        .unwrap_or(Value::Null);
    Record::from([
        ("workspace".into(), workspace),
        ("name".into(), json!(s.name)),
        ("view".into(), json!(s.view)),
        ("projects".into(), Value::Array(projects)),
        ("created_at".into(), json!(s.created_at)),
    ])
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
        let before = old
            .sections
            .iter()
            .find(|o| o.id == s.id)
            .map(|o| section_fields(old, o));
        set_changed(
            log,
            now,
            SECTION,
            &s.id,
            before,
            section_fields(new, s),
            &mut out,
        );
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

/// Gives the sections of `w` sort keys in its order: only those without a
/// key in it yet, unless the others' keys are out of order, when all of
/// them get new ones.
fn order_sections(log: &mut Log, now: u64, w: &Workspace, out: &mut Vec<Change>) {
    let records = log.records(SECTION);
    let key = |id: &str| -> Option<String> {
        let r = records.get(id)?;
        (r.get("workspace") == Some(&json!(w.id)))
            .then(|| r.get("order")?.as_str().map(String::from))?
    };
    let mut keys: Vec<Option<String>> = w.section_ids.iter().map(|id| key(id)).collect();
    let kept: Vec<&String> = keys.iter().flatten().collect();
    if kept.windows(2).any(|p| p[0] >= p[1]) {
        keys = vec![None; keys.len()];
    }
    for i in 0..keys.len() {
        if keys[i].is_some() {
            continue;
        }
        let before = keys[..i].iter().rev().flatten().next().cloned();
        let after = keys[i + 1..].iter().flatten().next().cloned();
        let k = key_between(before.as_deref(), after.as_deref());
        out.push(log.set(now, SECTION, &w.section_ids[i], "order", json!(k)));
        keys[i] = Some(k);
    }
}

/// Lays the account's workspaces and sections onto this member's state.
/// A field whose value does not fit takes its default, and the state is
/// made whole the same way on every member.
fn lay_onto(st: &mut State, log: &Log) {
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

    let mut workspaces: Vec<Workspace> = log
        .records(WORKSPACE)
        .into_iter()
        .map(|(id, r)| Workspace {
            name: text(&r, "name", DEFAULT_WORKSPACE),
            color: r
                .get("color")
                .and_then(|c| serde_json::from_value(c.clone()).ok())
                .unwrap_or(DEFAULT_COLOR),
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
    workspaces.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    if workspaces.is_empty() {
        let mut w = new_workspace(DEFAULT_WORKSPACE, DEFAULT_COLOR);
        w.id = DEFAULT_ID.into();
        w.created_at = 0;
        workspaces.push(w);
    }

    let mut placed: Vec<(String, String, Section)> = Vec::new();
    for (id, r) in log.records(SECTION) {
        let identities: Vec<ProjectIdentity> = r
            .get("projects")
            .and_then(|p| serde_json::from_value(p.clone()).ok())
            .unwrap_or_default();
        let mut project_ids = Vec::new();
        let mut missing = Vec::new();
        for i in identities {
            match st.projects.iter().find(|p| same_project(&p.identity, &i)) {
                Some(p) if !project_ids.contains(&p.id) => project_ids.push(p.id.clone()),
                Some(_) => {}
                None => missing.push(i),
            }
        }
        // Projects without an identity are this member's alone, and stay
        // in the section that had them.
        if let Some(old) = st.sections.iter().find(|s| s.id == id) {
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
        let owner = r
            .get("workspace")
            .and_then(Value::as_str)
            .filter(|w| workspaces.iter().any(|x| x.id == *w))
            .unwrap_or(&workspaces[0].id)
            .to_string();
        let order = r
            .get("order")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let section = Section {
            name: text(&r, "name", DEFAULT_SECTION),
            view: r
                .get("view")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default(),
            created_at: number(&r, "created_at"),
            project_ids,
            missing,
            id: id.clone(),
        };
        placed.push((owner, order, section));
    }
    placed.sort_by(|a, b| (&a.1, &a.2.id).cmp(&(&b.1, &b.2.id)));
    for (owner, _, s) in &placed {
        if let Some(w) = workspaces.iter_mut().find(|w| &w.id == owner) {
            w.section_ids.push(s.id.clone());
        }
    }
    st.workspaces = workspaces;
    st.sections = placed.into_iter().map(|(_, _, s)| s).collect();

    // A shared project no section holds any more was removed on another
    // member, and goes here too, unless it still has live sessions here.
    let dropped: Vec<String> = st
        .projects
        .iter()
        .filter(|p| {
            p.identity.root.is_some() && !st.sections.iter().any(|s| s.project_ids.contains(&p.id))
        })
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
            workspace_id: Some(book.list_workspaces()[0].id.clone()),
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
        assert_eq!(
            std::fs::read_to_string(h2.path().join("account.json.bad")).unwrap(),
            "{ not json"
        );
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
        // Exactly what another member lacks.
        assert_eq!(sent, mini.account_changes_for(&book.account_version()));
    }
}
