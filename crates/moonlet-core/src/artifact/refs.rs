//! Live references (X114): the artifacts a session refers to, in
//! `<home>/artifacts/refs/<session id>.toml`, and their read-only copies
//! in `<home>/artifacts/refs/<session id>/<name>/`, which moonlet keeps up
//! to date from their homes.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// One artifact a session refers to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ref {
    pub id: String,
    /// Its copy's folder name in the session's reference folder.
    pub name: String,
    pub attached_at: u64,
    /// The version of it the session's agent was last given or told of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SessionRefs {
    #[serde(default)]
    refs: Vec<Ref>,
}

/// The references of a host's sessions.
pub struct Refs {
    root: PathBuf,
    lock: Mutex<()>,
}

impl Refs {
    /// The references kept under `home` (`~/.moonlet`).
    pub fn new(home: &Path) -> Self {
        Self {
            root: home.join("artifacts").join("refs"),
            lock: Mutex::new(()),
        }
    }

    /// The folder holding session `session`'s copies.
    pub fn session_dir(&self, session: &str) -> PathBuf {
        self.root.join(session)
    }

    /// Refers session `session` to artifact `id`, its copy in the folder
    /// `name`; a reference already there stays as it was. Returns the
    /// copy's folder.
    pub fn add(&self, session: &str, id: &str, name: &str, at: u64) -> Result<PathBuf> {
        anyhow::ensure!(
            super::safe_name(session) && super::safe_name(name),
            "not a safe session or folder name"
        );
        let _held = self.lock.lock().unwrap();
        let mut refs = self.read(session)?;
        if !refs.refs.iter().any(|r| r.id == id) {
            refs.refs.push(Ref {
                id: id.to_string(),
                name: name.to_string(),
                attached_at: at,
                seen: None,
            });
            self.write(session, &refs)?;
        }
        Ok(self.session_dir(session).join(name))
    }

    /// The artifacts session `session` refers to.
    pub fn of(&self, session: &str) -> Vec<Ref> {
        if !super::safe_name(session) {
            return Vec::new();
        }
        self.read(session).map(|r| r.refs).unwrap_or_default()
    }

    /// The sessions that refer to artifact `id`.
    pub fn referrers(&self, id: &str) -> Vec<String> {
        let Ok(rd) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        rd.flatten()
            .filter_map(|e| {
                e.file_name()
                    .to_str()
                    .and_then(|n| n.strip_suffix(".toml"))
                    .map(String::from)
            })
            .filter(|s| super::safe_name(s) && self.of(s).iter().any(|r| r.id == id))
            .collect()
    }

    /// Every artifact some session refers to, each once.
    pub fn ids(&self) -> Vec<String> {
        self.all().into_keys().collect()
    }


    /// Notes that session `session`'s agent was given or told of version
    /// `version` of artifact `id`. Returns whether that version is new to it.
    pub fn see(&self, session: &str, id: &str, version: &str) -> Result<bool> {
        anyhow::ensure!(super::safe_name(session), "not a safe session id");
        let _held = self.lock.lock().unwrap();
        let mut refs = self.read(session)?;
        let r = refs
            .refs
            .iter_mut()
            .find(|r| r.id == id)
            .with_context(|| format!("{session} does not refer to {id}"))?;
        if r.seen.as_deref() == Some(version) {
            return Ok(false);
        }
        r.seen = Some(version.to_string());
        self.write(session, &refs)?;
        Ok(true)
    }

    /// Notes `before` as the version of artifact `id` session `session`
    /// has seen again: the copy of a newer one was never put in place, so
    /// the next refresh copies it again.
    pub fn unsee(&self, session: &str, id: &str, before: Option<&str>) -> Result<()> {
        anyhow::ensure!(super::safe_name(session), "not a safe session id");
        let _held = self.lock.lock().unwrap();
        let mut refs = self.read(session)?;
        if let Some(r) = refs.refs.iter_mut().find(|r| r.id == id) {
            r.seen = before.map(String::from);
            self.write(session, &refs)?;
        }
        Ok(())
    }

    /// Every artifact referred to, each with the sessions referring to it.
    pub fn all(&self) -> std::collections::BTreeMap<String, Vec<String>> {
        let mut all: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for session in self.sessions() {
            for r in self.of(&session) {
                all.entry(r.id).or_default().push(session.clone());
            }
        }
        for sessions in all.values_mut() {
            sessions.sort();
        }
        all
    }

    /// The sessions that refer to anything.
    fn sessions(&self) -> Vec<String> {
        let Ok(rd) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        rd.flatten()
            .filter_map(|e| {
                e.file_name()
                    .to_str()
                    .and_then(|n| n.strip_suffix(".toml"))
                    .map(String::from)
            })
            .filter(|s| super::safe_name(s))
            .collect()
    }

    /// Artifact `from` is now `to` (it moved): every reference to it follows.
    pub fn rename_id(&self, from: &str, to: &str) -> Result<()> {
        let _held = self.lock.lock().unwrap();
        for session in self.sessions() {
            let mut refs = self.read(&session)?;
            let mut changed = false;
            for r in refs.refs.iter_mut().filter(|r| r.id == from) {
                r.id = to.to_string();
                changed = true;
            }
            if changed {
                // One referring to both keeps one.
                let mut seen = std::collections::HashSet::new();
                refs.refs.retain(|r| seen.insert(r.id.clone()));
                self.write(&session, &refs)?;
            }
        }
        Ok(())
    }

    /// Ends every reference of session `session` and removes its copies:
    /// an archived session refers to nothing.
    pub fn forget_session(&self, session: &str) -> Result<()> {
        anyhow::ensure!(super::safe_name(session), "not a safe session id");
        let _held = self.lock.lock().unwrap();
        match std::fs::remove_file(self.root.join(format!("{session}.toml"))) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        remove_tree(&self.session_dir(session))
    }

    fn read(&self, session: &str) -> Result<SessionRefs> {
        match std::fs::read_to_string(self.root.join(format!("{session}.toml"))) {
            Ok(t) => Ok(toml::from_str(&t)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SessionRefs::default()),
            Err(e) => Err(e.into()),
        }
    }

    fn write(&self, session: &str, refs: &SessionRefs) -> Result<()> {
        crate::paths::ensure_private_dir(&self.root)?;
        let tmp = self.root.join(format!(".{session}.toml.tmp"));
        std::fs::write(&tmp, toml::to_string(refs)?)?;
        std::fs::rename(&tmp, self.root.join(format!("{session}.toml")))?;
        Ok(())
    }
}

/// A copy built beside its folder, not in place yet, and the version it holds.
pub struct Staged {
    pub next: PathBuf,
    pub version: String,
}

/// Builds the copy of a plan's text, version `version`, beside `folder`.
pub fn stage_plan(folder: &Path, text: &str, version: &str) -> Result<Staged> {
    let next = fresh(folder)?;
    write_read_only(&next.join("plan.md"), text.as_bytes())?;
    Ok(Staged {
        next,
        version: version.to_string(),
    })
}

/// Builds the copy of a design beside `folder`: its `design.toml`, `pages/`,
/// `assets/` and `system/`, read only, links left out. Its version is that
/// of what was copied, so a change made meanwhile is never taken for one
/// the copy has.
pub fn stage_design(design: &Path, folder: &Path) -> Result<Staged> {
    let next = fresh(folder)?;
    let toml = design.join("design.toml");
    if std::fs::symlink_metadata(&toml).is_ok_and(|m| m.is_file()) {
        write_read_only(&next.join("design.toml"), &std::fs::read(&toml)?)?;
    }
    for part in ["pages", "assets", "system"] {
        copy_tree(&design.join(part), &next.join(part))?;
    }
    let version = design_version(&next);
    Ok(Staged { next, version })
}

/// Puts a staged copy in place of what `folder` held.
pub fn commit(staged: &Staged, folder: &Path) -> Result<()> {
    swap(&staged.next, folder)
}

/// Writes a plan's text as `plan.md` in `folder`, read only.
pub fn mirror_plan(folder: &Path, text: &str) -> Result<()> {
    commit(&stage_plan(folder, text, "")?, folder)
}

/// Copies a design into `folder`, read only, in place of what it held
/// (see [`stage_design`]).
pub fn mirror_design(design: &Path, folder: &Path) -> Result<()> {
    commit(&stage_design(design, folder)?, folder)
}

/// A design's version (X114): a fingerprint of what its copy holds, each
/// file's path and contents, so any change to a page, an asset, its styles
/// or its `design.toml` is a new version, and the same files the same one.
pub fn design_version(design: &Path) -> String {
    let mut seen: Vec<String> = Vec::new();
    let mut note = |rel: &str, path: &Path| {
        if let Ok(bytes) = std::fs::read(path) {
            seen.push(format!("{rel}\0{}", crate::hash::sha256_hex(&bytes)));
        }
    };
    if std::fs::symlink_metadata(design.join("design.toml")).is_ok_and(|m| m.is_file()) {
        note("design.toml", &design.join("design.toml"));
    }
    fn walk(dir: &Path, rel: &str, note: &mut dyn FnMut(&str, &Path)) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let Ok(kind) = e.file_type() else { continue };
            let rel = format!("{rel}/{}", e.file_name().to_string_lossy());
            if kind.is_dir() {
                walk(&e.path(), &rel, note);
            } else if kind.is_file() {
                note(&rel, &e.path());
            }
        }
    }
    for part in ["pages", "assets", "system"] {
        walk(&design.join(part), part, &mut note);
    }
    seen.sort();
    crate::hash::sha256_hex(seen.join("\n").as_bytes())
}


/// A hidden name beside `folder` no other copy uses: `.<name>.<what>-<n>`.
fn beside(folder: &Path, what: &str) -> Result<PathBuf> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let parent = folder.parent().context("a copy needs a parent folder")?;
    let name = folder
        .file_name()
        .context("a copy needs a name")?
        .to_string_lossy();
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Ok(parent.join(format!(".{name}.{what}-{}-{n}", std::process::id())))
}

/// An empty folder beside `folder`, its own, to build its next copy in.
fn fresh(folder: &Path) -> Result<PathBuf> {
    crate::paths::ensure_private_dir(folder.parent().context("a copy needs a parent folder")?)?;
    let next = beside(folder, "next")?;
    remove_tree(&next)?;
    std::fs::create_dir(&next)?;
    Ok(next)
}

/// Puts the copy built in `next` in place of `folder`.
fn swap(next: &Path, folder: &Path) -> Result<()> {
    // The old copy goes aside first, so the folder is missing only between
    // two renames, never while a copy is deleted.
    let old = beside(folder, "old")?;
    if folder.exists() {
        std::fs::rename(folder, &old)?;
    }
    std::fs::rename(next, folder)?;
    remove_tree(&old)
}

/// Throws a staged copy away: the copy in place already holds its version.
pub fn discard(staged: Staged) -> Result<()> {
    remove_tree(&staged.next)
}

/// Removes `dir` and everything in it, read-only files too.
fn remove_tree(dir: &Path) -> Result<()> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("removing {}", dir.display())),
    }
}

fn write_read_only(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, bytes)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o444))?;
    Ok(())
}

/// Copies the files and folders of `from` into `to`, never through a link.
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    let Ok(meta) = std::fs::symlink_metadata(from) else {
        return Ok(());
    };
    if !meta.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        let kind = e.file_type()?;
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if kind.is_dir() {
            copy_tree(&src, &dst)?;
        } else if kind.is_file() {
            write_read_only(&dst, &std::fs::read(&src)?)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn a_session_refers_to_an_artifact_once_and_its_referrers_are_known() {
        let home = tempfile::tempdir().unwrap();
        let refs = Refs::new(home.path());

        let folder = refs
            .add(
                "s-search",
                "plan:a1b2c3d4e5f6:search-plan",
                "plan-search-plan",
                1_000,
            )
            .unwrap();
        refs.add(
            "s-search",
            "plan:a1b2c3d4e5f6:search-plan",
            "plan-search-plan",
            2_000,
        )
        .unwrap();
        refs.add(
            "s-api",
            "plan:a1b2c3d4e5f6:search-plan",
            "plan-search-plan",
            3_000,
        )
        .unwrap();
        refs.add(
            "s-api",
            "design:workspace:w1:settings-page",
            "design-settings-page",
            4_000,
        )
        .unwrap();

        assert_eq!(
            folder,
            home.path().join("artifacts/refs/s-search/plan-search-plan")
        );
        assert_eq!(
            refs.of("s-search"),
            vec![Ref {
                id: "plan:a1b2c3d4e5f6:search-plan".into(),
                name: "plan-search-plan".into(),
                attached_at: 1_000,
                seen: None
            }]
        );
        let mut who = refs.referrers("plan:a1b2c3d4e5f6:search-plan");
        who.sort();
        assert_eq!(who, ["s-api", "s-search"]);
        assert!(refs.referrers("plan:nobody:x").is_empty());
    }

    #[test]
    fn every_artifact_referred_to_is_listed_once() {
        let home = tempfile::tempdir().unwrap();
        let refs = Refs::new(home.path());
        assert!(refs.ids().is_empty());
        refs.add("s-api", "plan:a1b2c3d4e5f6:search-plan", "plan-search-plan", 1_000).unwrap();
        refs.add("s-search", "plan:a1b2c3d4e5f6:search-plan", "plan-search-plan", 1_000).unwrap();
        refs.add("s-search", "design:library:settings-page", "design-settings-page", 1_000).unwrap();

        assert_eq!(refs.ids(), ["design:library:settings-page", "plan:a1b2c3d4e5f6:search-plan"]);
    }

    #[test]
    fn a_version_is_new_to_a_session_once() {
        let home = tempfile::tempdir().unwrap();
        let refs = Refs::new(home.path());
        refs.add(
            "s-api",
            "plan:a1b2c3d4e5f6:search-plan",
            "plan-search-plan",
            1_000,
        )
        .unwrap();

        assert!(
            refs.see("s-api", "plan:a1b2c3d4e5f6:search-plan", "v1")
                .unwrap()
        );
        assert!(
            !refs
                .see("s-api", "plan:a1b2c3d4e5f6:search-plan", "v1")
                .unwrap()
        );
        assert!(
            refs.see("s-api", "plan:a1b2c3d4e5f6:search-plan", "v2")
                .unwrap()
        );
        assert_eq!(refs.of("s-api")[0].seen.as_deref(), Some("v2"));
    }

    #[test]
    fn a_version_whose_copy_was_not_put_in_place_is_new_again() {
        let home = tempfile::tempdir().unwrap();
        let refs = Refs::new(home.path());
        let id = "plan:a1b2c3d4e5f6:search-plan";
        refs.add("s-api", id, "plan-search-plan", 1_000).unwrap();
        assert!(refs.see("s-api", id, "v1").unwrap());
        assert!(refs.see("s-api", id, "v2").unwrap());

        refs.unsee("s-api", id, Some("v1")).unwrap();

        assert_eq!(refs.of("s-api")[0].seen.as_deref(), Some("v1"));
        assert!(refs.see("s-api", id, "v2").unwrap());
    }

    #[test]
    fn two_copies_staged_at_once_are_built_apart_and_the_last_put_in_place_shows() {
        let home = tempfile::tempdir().unwrap();
        let folder = home.path().join("refs/s-api/plan-search-plan");

        let first = stage_plan(&folder, "# Search\n\nv1\n", "v1").unwrap();
        let second = stage_plan(&folder, "# Search\n\nv2\n", "v2").unwrap();
        commit(&first, &folder).unwrap();
        commit(&second, &folder).unwrap();

        assert_eq!(
            std::fs::read_to_string(folder.join("plan.md")).unwrap(),
            "# Search\n\nv2\n"
        );
        let left: Vec<_> = std::fs::read_dir(folder.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, ["plan-search-plan"]);
    }

    #[test]
    fn a_plans_copy_is_its_text_read_only_and_follows_it() {
        let home = tempfile::tempdir().unwrap();
        let folder = home.path().join("refs/s-api/plan-search-plan");

        mirror_plan(&folder, "# Search\n\nv1\n").unwrap();
        mirror_plan(&folder, "# Search\n\nv2\n").unwrap();

        assert_eq!(
            std::fs::read_to_string(folder.join("plan.md")).unwrap(),
            "# Search\n\nv2\n"
        );
        assert_eq!(
            std::fs::metadata(folder.join("plan.md"))
                .unwrap()
                .permissions()
                .mode()
                & 0o222,
            0,
            "read only"
        );
    }

    #[test]
    fn a_designs_copy_has_its_pages_assets_and_system_read_only_and_nothing_else() {
        let home = tempfile::tempdir().unwrap();
        let design = home.path().join("designs/settings-page");
        for (path, text) in [
            ("design.toml", "name = \"Settings page\"\n"),
            ("pages/index.html", "<p>v1</p>"),
            ("assets/logo.svg", "<svg/>"),
            ("system/styles.css", "@import \"tokens.css\";"),
            ("notes.txt", "not part of the design"),
        ] {
            std::fs::create_dir_all(design.join(path).parent().unwrap()).unwrap();
            std::fs::write(design.join(path), text).unwrap();
        }
        std::os::unix::fs::symlink("/etc/hosts", design.join("pages/linked.html")).unwrap();
        let folder = home.path().join("refs/s-api/design-settings-page");

        mirror_design(&design, &folder).unwrap();
        std::fs::write(design.join("pages/index.html"), "<p>v2</p>").unwrap();
        std::fs::remove_file(design.join("assets/logo.svg")).unwrap();
        mirror_design(&design, &folder).unwrap();

        assert_eq!(
            std::fs::read_to_string(folder.join("pages/index.html")).unwrap(),
            "<p>v2</p>"
        );
        assert_eq!(
            std::fs::read_to_string(folder.join("system/styles.css")).unwrap(),
            "@import \"tokens.css\";"
        );
        assert!(folder.join("design.toml").is_file());
        assert!(
            !folder.join("assets/logo.svg").exists(),
            "a file gone from the design is gone from its copy"
        );
        assert!(!folder.join("notes.txt").exists());
        assert!(
            !folder.join("pages/linked.html").exists(),
            "links are left out"
        );
        assert_eq!(
            std::fs::metadata(folder.join("pages/index.html"))
                .unwrap()
                .permissions()
                .mode()
                & 0o222,
            0,
            "read only"
        );
    }

    #[test]
    fn a_designs_version_changes_with_any_page_and_only_then() {
        let home = tempfile::tempdir().unwrap();
        let design = home.path().join("settings-page");
        std::fs::create_dir_all(design.join("pages")).unwrap();
        std::fs::write(design.join("design.toml"), "name = \"Settings page\"\n").unwrap();
        std::fs::write(design.join("pages/index.html"), "<p>v1</p>").unwrap();
        std::fs::write(design.join("notes.txt"), "not part of the design").unwrap();
        let first = design_version(&design);
        assert_eq!(design_version(&design), first, "nothing changed");
        std::fs::write(design.join("notes.txt"), "still not part of it").unwrap();
        assert_eq!(
            design_version(&design),
            first,
            "a file outside the copy is no change"
        );
        std::fs::write(design.join("pages/index.html"), "<p>v22</p>").unwrap();
        let second = design_version(&design);
        assert_ne!(second, first);
        std::fs::write(design.join("pages/empty.html"), "").unwrap();
        assert_ne!(design_version(&design), second, "a new page is a change");
    }

    #[test]
    fn a_staged_design_copy_says_the_version_it_holds_and_shows_only_once_committed() {
        let home = tempfile::tempdir().unwrap();
        let design = home.path().join("settings-page");
        std::fs::create_dir_all(design.join("pages")).unwrap();
        std::fs::write(design.join("pages/index.html"), "<p>v1</p>").unwrap();
        let folder = home.path().join("refs/s-api/design-settings-page");
        mirror_design(&design, &folder).unwrap();
        let v1 = design_version(&folder);

        std::fs::write(design.join("pages/index.html"), "<p>v2</p>").unwrap();
        let staged = stage_design(&design, &folder).unwrap();
        assert_ne!(staged.version, v1);
        assert_eq!(
            std::fs::read_to_string(folder.join("pages/index.html")).unwrap(),
            "<p>v1</p>",
            "not in place yet"
        );
        commit(&staged, &folder).unwrap();
        assert_eq!(
            std::fs::read_to_string(folder.join("pages/index.html")).unwrap(),
            "<p>v2</p>"
        );
        assert_eq!(
            design_version(&folder),
            staged.version,
            "the version of what it holds"
        );
        assert_eq!(
            stage_design(&design, &folder).unwrap().version,
            staged.version,
            "the same files, the same version"
        );
    }

    #[test]
    fn references_follow_an_artifact_that_moved_and_all_are_listed_with_their_sessions() {
        let home = tempfile::tempdir().unwrap();
        let refs = Refs::new(home.path());
        refs.add(
            "s-api",
            "design:session:s1:checkout-flow",
            "design-checkout-flow",
            1_000,
        )
        .unwrap();
        refs.add(
            "s-copy",
            "design:session:s1:checkout-flow",
            "design-checkout-flow",
            2_000,
        )
        .unwrap();
        refs.add("s-copy", "plan:s1:search", "plan-search", 3_000)
            .unwrap();

        refs.rename_id(
            "design:session:s1:checkout-flow",
            "design:workspace:w1:checkout-flow",
        )
        .unwrap();

        assert_eq!(
            refs.referrers("design:session:s1:checkout-flow"),
            Vec::<String>::new()
        );
        let all = refs.all();
        assert_eq!(
            all.get("design:workspace:w1:checkout-flow"),
            Some(&vec!["s-api".to_string(), "s-copy".to_string()])
        );
        assert_eq!(all.get("plan:s1:search"), Some(&vec!["s-copy".to_string()]));
        assert_eq!(all.len(), 2);
        assert_eq!(
            refs.of("s-api")[0].name,
            "design-checkout-flow",
            "its copy stays where it is"
        );
    }
}
