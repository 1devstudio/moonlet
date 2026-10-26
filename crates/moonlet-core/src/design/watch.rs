//! `design.changed` (X64): what changed under `~/.moonlet/design`, by
//! workspace and design system, so Design mode updates while an agent works.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// The files that changed in one design system, or in a workspace's other
/// design files (`system` is `None`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    pub workspace: String,
    pub system: Option<String>,
    /// The workspace design they are in (X65), its slug.
    pub design: Option<String>,
    /// Relative to the system's or the design's folder (or the
    /// workspace's), sorted, each once.
    pub paths: Vec<String>,
}

/// Groups changed paths under `root` (`~/.moonlet/design`), by design system
/// and by workspace design. A change to a system's or a design's record
/// counts as a change to it, with no path.
/// moonlet's own temporary files are left out.
pub fn group(root: &Path, paths: &[PathBuf]) -> Vec<Change> {
    use std::collections::{BTreeMap, BTreeSet};
    let mut by: BTreeMap<(String, Option<String>, Option<String>), BTreeSet<String>> =
        BTreeMap::new();
    for p in paths {
        let Ok(rel) = p.strip_prefix(root) else {
            continue;
        };
        let parts: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        if parts.last().is_some_and(|name| is_temp(name)) {
            continue;
        }
        let [workspace, rest @ ..] = parts.as_slice() else {
            continue;
        };
        let (system, design, path) = match rest {
            // The system's folder itself (made or removed) counts for the system.
            [kind, slug, inner @ ..] if kind == "systems" => {
                (Some(slug.clone()), None, inner.join("/"))
            }
            [kind, file] if kind == ".records" => (
                file.strip_suffix(".toml").map(String::from),
                None,
                String::new(),
            ),
            // So does a design's (X65), and its record.
            [kind, slug, inner @ ..] if kind == "designs" => {
                (None, Some(slug.clone()), inner.join("/"))
            }
            [kind, designs, file] if kind == ".records" && designs == "designs" => (
                None,
                file.strip_suffix(".toml").map(String::from),
                String::new(),
            ),
            _ => (None, None, rest.join("/")),
        };
        let paths = by.entry((workspace.clone(), system, design)).or_default();
        if !path.is_empty() {
            paths.insert(path);
        }
    }
    by.into_iter()
        .map(|((workspace, system, design), paths)| Change {
            workspace,
            system,
            design,
            paths: paths.into_iter().collect(),
        })
        .collect()
}

/// The files that changed in one session design of a worktree (X65), by
/// their paths in its folder (`pages/index.html`) or in its folder under
/// `.moonlet/design/` (`comments.json`, `history/3/snapshot.json`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionChange {
    pub design: String,
    pub paths: Vec<String>,
}

/// Groups changed paths of a worktree by its session designs: those in
/// its design folder `folder` and in `.moonlet/design/`, by any slug a
/// session design's listing takes. The design's folder itself (made or
/// removed) counts for it, with no path, but a file beside the designs
/// (a README, the `.gitignore`) is none; anything else, and moonlet's own
/// temporary files, is left out.
pub fn group_session(worktree: &Path, folder: &str, paths: &[PathBuf]) -> Vec<SessionChange> {
    use std::collections::{BTreeMap, BTreeSet};
    let mut by: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for p in paths {
        let Ok(rel) = p.strip_prefix(worktree) else {
            continue;
        };
        let (Ok(inner) | Err(inner)) = rel
            .strip_prefix(folder)
            .or_else(|_| rel.strip_prefix(super::session::SIDE_DIR))
            .map_err(|_| Path::new(""));
        let parts: Vec<String> = inner
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let [slug, rest @ ..] = parts.as_slice() else {
            continue;
        };
        let beside = rest.is_empty() && std::fs::symlink_metadata(p).is_ok_and(|m| m.is_file());
        if super::place::check_slug(slug).is_err()
            || beside
            || parts.last().is_some_and(|name| is_temp(name))
        {
            continue;
        }
        let paths = by.entry(slug.clone()).or_default();
        if !rest.is_empty() {
            paths.insert(rest.join("/"));
        }
    }
    by.into_iter()
        .map(|(design, paths)| SessionChange {
            design,
            paths: paths.into_iter().collect(),
        })
        .collect()
}

/// Watches a worktree's session designs, its design folder `folder` and
/// `.moonlet/design/`, and calls `emit` with their changes, gathered over
/// 150 ms. Either folder may come later, as the first session design makes
/// `.moonlet/design/`: until it is there, the nearest folder above it in
/// the worktree is watched for it, and once it is, it is watched whole, the
/// designs already in it reported as changed. Watching stops when the
/// returned watcher is dropped.
pub fn start_session(
    worktree: &Path,
    folder: &str,
    emit: impl Fn(Vec<SessionChange>) + Send + 'static,
) -> anyhow::Result<Watching> {
    let (worktree, folder) = (worktree.to_path_buf(), folder.to_string());
    let real = worktree.canonicalize()?;
    let roots = [
        worktree.join(&folder),
        worktree.join(super::session::SIDE_DIR),
    ];
    let top = worktree.clone();
    let arm = move |armed: &mut Armed| -> anyhow::Result<Vec<PathBuf>> {
        let mut made = Vec::new();
        for root in &roots {
            if root.is_dir() {
                if armed.watch(root, true)? {
                    // What it has came before its watch: count it.
                    for e in std::fs::read_dir(root)?.flatten() {
                        made.push(e.path());
                    }
                }
                continue;
            }
            // Gone, or not made yet: watched for from the nearest folder
            // above it, the worktree at the top.
            armed.unwatch(root);
            if let Some(above) = root
                .ancestors()
                .skip(1)
                .take_while(|a| a.starts_with(&top))
                .find(|a| a.is_dir())
            {
                armed.watch(above, false)?;
            }
        }
        Ok(made)
    };
    watch_with(arm, move |batch| {
        // Each path as under the worktree as given, also when the watch
        // reports it with its links resolved.
        let batch: Vec<PathBuf> = batch
            .iter()
            .filter_map(|p| under(&[&worktree, &real], p))
            .collect();
        let changes = group_session(&worktree, &folder, &batch);
        if !changes.is_empty() {
            emit(changes);
        }
    })
}

/// A watcher and the folders it is on, each whole or only its own entries.
struct Armed {
    watcher: notify::RecommendedWatcher,
    on: std::collections::BTreeMap<PathBuf, bool>,
}

impl Armed {
    /// Watches `dir`, whole (`recursive`) or only its own entries; true
    /// when it was not watched so before.
    fn watch(&mut self, dir: &Path, recursive: bool) -> notify::Result<bool> {
        use notify::Watcher;
        if self.on.get(dir) == Some(&recursive) {
            return Ok(false);
        }
        self.unwatch(dir);
        let mode = if recursive {
            notify::RecursiveMode::Recursive
        } else {
            notify::RecursiveMode::NonRecursive
        };
        self.watcher.watch(dir, mode)?;
        self.on.insert(dir.to_path_buf(), recursive);
        Ok(true)
    }

    /// Stops watching `dir`, if it was.
    fn unwatch(&mut self, dir: &Path) {
        use notify::Watcher;
        if self.on.remove(dir).is_some() {
            let _ = self.watcher.unwatch(dir);
        }
    }
}

/// Watches what `arm` puts the watcher on, and calls `on` with each batch
/// of changed paths, gathered over 150 ms. `arm` runs first, and again
/// before each batch, so a folder made meanwhile is watched from then on;
/// the paths it gives (what a folder it newly watches has) join the batch,
/// but for its first run's.
fn watch_with(
    mut arm: impl FnMut(&mut Armed) -> anyhow::Result<Vec<PathBuf>> + Send + 'static,
    on: impl Fn(Vec<PathBuf>) + Send + 'static,
) -> anyhow::Result<Watching> {
    let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                let _ = tx.send(p);
            }
        }
    })?;
    let mut armed = Armed {
        watcher,
        on: Default::default(),
    };
    arm(&mut armed)?;
    let armed = std::sync::Arc::new(std::sync::Mutex::new(armed));
    // Only the returned watcher keeps it: once that is dropped, so is the
    // watch's sender, and this thread ends.
    let weak = std::sync::Arc::downgrade(&armed);
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(150);
            while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
                match rx.recv_timeout(left) {
                    Ok(p) => batch.push(p),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                    Err(_) => return,
                }
            }
            let Some(armed) = weak.upgrade() else { return };
            match arm(&mut armed.lock().unwrap()) {
                Ok(made) => batch.extend(made),
                Err(e) => tracing::warn!("cannot watch a design folder: {e:#}"),
            }
            drop(armed);
            on(batch);
        }
    });
    Ok(Watching(armed))
}

/// moonlet's own temporary files: `.<name>.moonlet-<pid>-<n>` (design
/// writes) and `.<name>.<pid>-<n>.moonlet-tmp` (file writes).
fn is_temp(name: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !name.starts_with('.') {
        return false;
    }
    if name.ends_with(".moonlet-tmp") {
        return true;
    }
    name.rsplit_once(".moonlet-")
        .and_then(|(_, tail)| tail.split_once('-'))
        .is_some_and(|(pid, n)| digits(pid) && digits(n))
}

/// `p` under the first of `roots`, when it is under any of them: the watch
/// may report the path as given or with its symlinks resolved.
pub fn under(roots: &[&Path], p: &Path) -> Option<PathBuf> {
    let first = roots.first()?;
    roots
        .iter()
        .find_map(|r| p.strip_prefix(r).ok())
        .map(|rel| first.join(rel))
}

/// Watches `root` and calls `emit` with the changes, gathered over 150 ms.
/// Watching stops when the returned watcher is dropped.
pub fn start(root: &Path, emit: impl Fn(Vec<Change>) + Send + 'static) -> anyhow::Result<Watching> {
    // Events may arrive with the path as given or with its symlinks resolved
    // (`/private/var` for `/var` on macOS, a linked home on Linux): both count.
    let (given, real) = (root.to_path_buf(), root.canonicalize()?);
    let watched = given.clone();
    let arm = move |armed: &mut Armed| {
        armed
            .watch(&watched, true)
            .map(|_| Vec::new())
            .map_err(Into::into)
    };
    watch_with(arm, move |batch| {
        let batch: Vec<PathBuf> = batch
            .iter()
            .filter_map(|p| under(&[&given, &real], p))
            .collect();
        let changes = group(&given, &batch);
        if !changes.is_empty() {
            emit(changes);
        }
    })
}

/// A running watch of the design folder; dropping it stops the watch.
pub struct Watching(#[allow(dead_code)] std::sync::Arc<std::sync::Mutex<Armed>>);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_files_are_grouped_by_workspace_and_design_system() {
        let root = Path::new("/Users/alex/.moonlet/design");
        let paths: Vec<PathBuf> = [
            "w1/systems/storefront/components/buttons/button/button.html",
            "w1/systems/storefront/.cache/progress.toml",
            "w1/systems/storefront/components/buttons/button/.button.html.moonlet-41-3",
            "w1/systems/storefront/components/buttons/button/button.html",
            "w1/.records/storefront.toml",
            "w1/systems/pricing/styles.css",
            "w2/designs/settings-page/pages/index.html",
            "/Users/alex/elsewhere.txt",
        ]
        .iter()
        .map(|p| root.join(p))
        .collect();
        let change = |w: &str, s: Option<&str>, p: &[&str]| Change {
            workspace: w.into(),
            system: s.map(String::from),
            design: None,
            paths: p.iter().map(|x| x.to_string()).collect(),
        };
        assert_eq!(
            group(root, &paths),
            vec![
                change("w1", Some("pricing"), &["styles.css"]),
                change(
                    "w1",
                    Some("storefront"),
                    &[
                        ".cache/progress.toml",
                        "components/buttons/button/button.html"
                    ]
                ),
                Change {
                    workspace: "w2".into(),
                    system: None,
                    design: Some("settings-page".into()),
                    paths: vec!["pages/index.html".into()]
                },
            ]
        );
    }

    #[test]
    fn changed_files_of_a_design_are_grouped_by_design_with_its_record() {
        let root = Path::new("/Users/alex/.moonlet/design");
        let paths: Vec<PathBuf> = [
            "w1/designs/settings-page/pages/git-a.html",
            "w1/designs/settings-page/pages/.git-a.html.moonlet-41-3",
            "w1/designs/settings-page/design.toml",
            "w1/designs/onboarding",
            "w1/.records/designs/onboarding.toml",
            "w1/systems/settings-page/styles.css",
        ]
        .iter()
        .map(|p| root.join(p))
        .collect();
        let design = |d: &str, p: &[&str]| Change {
            workspace: "w1".into(),
            system: None,
            design: Some(d.into()),
            paths: p.iter().map(|x| x.to_string()).collect(),
        };
        assert_eq!(
            group(root, &paths),
            vec![
                design("onboarding", &[]),
                design("settings-page", &["design.toml", "pages/git-a.html"]),
                // A system and a design of one name stay apart.
                Change {
                    workspace: "w1".into(),
                    system: Some("settings-page".into()),
                    design: None,
                    paths: vec!["styles.css".into()]
                },
            ]
        );
    }

    #[test]
    fn a_system_folder_made_or_removed_counts_for_that_system_and_only_moonlets_temp_files_are_dropped()
     {
        let root = Path::new("/d");
        let paths: Vec<PathBuf> = [
            "w1/systems/pricing",
            "w1/systems/pricing/my.moonlet-notes.md",
            "w1/systems/pricing/.styles.css.moonlet-41-3",
        ]
        .iter()
        .map(|p| root.join(p))
        .collect();
        assert_eq!(
            group(root, &paths),
            vec![Change {
                workspace: "w1".into(),
                system: Some("pricing".into()),
                design: None,
                paths: vec!["my.moonlet-notes.md".into()]
            }]
        );
    }

    #[test]
    fn events_under_the_real_or_the_given_root_both_count() {
        let (given, real) = (
            Path::new("/home/me/.moonlet/design"),
            Path::new("/data/me/.moonlet/design"),
        );
        assert_eq!(
            under(&[given, real], &real.join("w1/systems/a/x.html")),
            Some(given.join("w1/systems/a/x.html"))
        );
        assert_eq!(
            under(&[given, real], &given.join("w1/systems/a/x.html")),
            Some(given.join("w1/systems/a/x.html"))
        );
        assert_eq!(under(&[given, real], Path::new("/tmp/x")), None);
    }

    #[test]
    fn changed_files_of_a_worktree_are_grouped_by_its_session_designs() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        // Files beside the designs.
        for file in ["docs/design/README.md", ".moonlet/design/.gitignore"] {
            std::fs::create_dir_all(worktree.join(file).parent().unwrap()).unwrap();
            std::fs::write(worktree.join(file), "x\n").unwrap();
        }
        let paths: Vec<PathBuf> = [
            "docs/design/settings-page/pages/index.html",
            "docs/design/settings-page/pages/.index.html.moonlet-41-3",
            "docs/design/settings-page/pages/index.html",
            ".moonlet/design/settings-page/comments.json",
            ".moonlet/design/settings-page/history/3/snapshot.json",
            ".moonlet/design/.gitignore",
            "docs/design/onboarding",
            "docs/design/README.md",
            "docs/specs/X66-settings.md",
            "src/main.rs",
            "/Users/alex/elsewhere.txt",
        ]
        .iter()
        .map(|p| worktree.join(p))
        .collect();
        let change = |d: &str, p: &[&str]| SessionChange {
            design: d.into(),
            paths: p.iter().map(|x| x.to_string()).collect(),
        };
        assert_eq!(
            group_session(worktree, "docs/design", &paths),
            vec![
                change("onboarding", &[]),
                change(
                    "settings-page",
                    &[
                        "comments.json",
                        "history/3/snapshot.json",
                        "pages/index.html"
                    ]
                ),
            ]
        );
    }

    #[test]
    fn a_session_design_of_any_slug_its_listing_takes_has_its_changes_reported() {
        let worktree = Path::new("/Users/alex/.moonlet/worktrees/shop/settings");
        let paths: Vec<PathBuf> = [
            "docs/design/Settings_Page/pages/index.html",
            ".moonlet/design/Settings_Page/comments.json",
            "docs/design/onboarding.v2/pages/index.html",
        ]
        .iter()
        .map(|p| worktree.join(p))
        .collect();
        let change = |d: &str, p: &[&str]| SessionChange {
            design: d.into(),
            paths: p.iter().map(|x| x.to_string()).collect(),
        };
        assert_eq!(
            group_session(worktree, "docs/design", &paths),
            vec![
                change("Settings_Page", &["comments.json", "pages/index.html"]),
                change("onboarding.v2", &["pages/index.html"]),
            ]
        );
    }

    #[test]
    fn a_side_folder_made_after_the_watch_started_has_its_changes_reported() {
        let worktree = tempfile::tempdir().unwrap();
        let wt = worktree.path();
        // The base branch's designs: the design folder is there, and no
        // `.moonlet/design/` yet.
        std::fs::create_dir_all(wt.join("docs/design/onboarding/pages")).unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<Vec<SessionChange>>();
        let _watching = start_session(wt, "docs/design", move |changes| {
            let _ = tx.send(changes);
        })
        .unwrap();
        // The first session design made here makes `.moonlet/design/`.
        std::fs::create_dir_all(wt.join(".moonlet/design/settings-page")).unwrap();
        let comments = |c: &SessionChange| {
            c.design == "settings-page" && c.paths.iter().any(|p| p == "comments.json")
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            std::fs::write(
                wt.join(".moonlet/design/settings-page/comments.json"),
                "[]\n",
            )
            .unwrap();
            if let Ok(changes) = rx.recv_timeout(std::time::Duration::from_millis(300))
                && changes.iter().any(comments)
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "comments.json in a .moonlet/design/ made after the watch started was never reported"
            );
        }
    }
}
