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
    /// Relative to the system's folder (or the workspace's), sorted, each once.
    pub paths: Vec<String>,
}

/// Groups changed paths under `root` (`~/.moonlet/design`). A change to a
/// system's record counts as a change to that system, with no path.
/// moonlet's own temporary files are left out.
pub fn group(root: &Path, paths: &[PathBuf]) -> Vec<Change> {
    use std::collections::{BTreeMap, BTreeSet};
    let mut by: BTreeMap<(String, Option<String>), BTreeSet<String>> = BTreeMap::new();
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
        let (system, path) = match rest {
            // The system's folder itself (made or removed) counts for the system.
            [kind, slug, inner @ ..] if kind == "systems" => (Some(slug.clone()), inner.join("/")),
            [kind, file] if kind == ".records" => {
                (file.strip_suffix(".toml").map(String::from), String::new())
            }
            _ => (None, rest.join("/")),
        };
        let paths = by.entry((workspace.clone(), system)).or_default();
        if !path.is_empty() {
            paths.insert(path);
        }
    }
    by.into_iter()
        .map(|((workspace, system), paths)| Change {
            workspace,
            system,
            paths: paths.into_iter().collect(),
        })
        .collect()
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
    use notify::Watcher;
    let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                let _ = tx.send(p);
            }
        }
    })?;
    watcher.watch(root, notify::RecursiveMode::Recursive)?;
    // Events may arrive with the path as given or with its symlinks resolved
    // (`/private/var` for `/var` on macOS, a linked home on Linux): both count.
    let (given, real) = (root.to_path_buf(), root.canonicalize()?);
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
            let batch: Vec<PathBuf> = batch
                .iter()
                .filter_map(|p| under(&[&given, &real], p))
                .collect();
            let changes = group(&given, &batch);
            if !changes.is_empty() {
                emit(changes);
            }
        }
    });
    Ok(Watching(watcher))
}

/// A running watch of the design folder; dropping it stops the watch.
pub struct Watching(#[allow(dead_code)] notify::RecommendedWatcher);

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
                change("w2", None, &["designs/settings-page/pages/index.html"]),
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
}
