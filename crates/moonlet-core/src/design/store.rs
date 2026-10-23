//! Where design systems live (X64, ADR 0013): `~/.moonlet/design/<workspace
//! id>/systems/<slug>/`, each with a `config.toml` naming its sources.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use super::check::{self, html_files};
use super::{anchor, manifest};

/// One project a design system is built from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    /// The moonlet project's id.
    pub project: String,
    /// Its folder on this Mac.
    pub path: String,
    /// What makes it the same project elsewhere (X41), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    /// A folder of the repository the system covers, such as `apps/mobile`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subdir: Option<String>,
    /// `HEAD` at the last sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

/// `config.toml`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemConfig {
    pub name: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_at: Option<u64>,
    #[serde(default)]
    pub sources: Vec<Source>,
}

/// The design folders of one moonlet home.
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// The store under `home` (`~/.moonlet`).
    pub fn new(home: &Path) -> Self {
        Store {
            root: home.join("design"),
        }
    }

    /// Creates a design system and returns its slug. A name already used in
    /// the workspace gets a ` 2` (` 3`, …) suffix.
    pub fn create_system(
        &self,
        workspace: &str,
        name: &str,
        sources: Vec<Source>,
        now: u64,
    ) -> Result<String> {
        let systems = self.workspace(workspace)?.join("systems");
        let name = name.trim();
        if name.is_empty() {
            bail!("a design system needs a name");
        }
        let (mut name_n, mut n) = (name.to_string(), 1);
        while systems.join(slug(&name_n)).exists() {
            n += 1;
            name_n = format!("{name} {n}");
        }
        let slug = slug(&name_n);
        let dir = systems.join(&slug);
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("cannot create {}", dir.display()))?;
        let config = SystemConfig {
            name: name_n,
            created_at: now,
            synced_at: None,
            sources,
        };
        std::fs::write(dir.join(CONFIG), toml::to_string(&config)?)?;
        Ok(slug)
    }

    /// The workspace's design systems, by name.
    pub fn systems(&self, workspace: &str) -> Result<Vec<SystemSummary>> {
        let Ok(entries) = std::fs::read_dir(self.workspace(workspace)?.join("systems")) else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for e in entries.flatten() {
            let dir = e.path();
            let Ok(config) = read_config(&dir) else {
                continue;
            };
            let cards = manifest::build(&dir)?.cards;
            let roots: Vec<PathBuf> = config
                .sources
                .iter()
                .map(|s| PathBuf::from(&s.path))
                .collect();
            let status = anchor::status(&dir, &roots)?;
            let mut changed: Vec<String> = status
                .iter()
                .flat_map(|s| s.changed_sources.clone())
                .collect();
            changed.sort();
            changed.dedup();
            let proposed = html_files(&dir)
                .iter()
                .filter(|p| p.to_string_lossy().ends_with(".proposed.html"))
                .count();
            out.push(SystemSummary {
                slug: e.file_name().to_string_lossy().into_owned(),
                name: config.name,
                sources: config.sources.iter().map(|s| s.path.clone()).collect(),
                synced_at: config.synced_at,
                synced_commit: config.sources.first().and_then(|s| s.commit.clone()),
                cards: cards
                    .iter()
                    .filter(|c| c.path.starts_with("components/"))
                    .count(),
                layouts: cards
                    .iter()
                    .filter(|c| c.path.starts_with("ui_kits/"))
                    .count(),
                changed_sources: changed,
                check_problems: check::check(&dir)?.len(),
                to_settle: proposed + status.iter().filter(|s| s.orphaned).count(),
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// The folder of an existing design system.
    pub fn system_dir(&self, workspace: &str, slug: &str) -> Result<PathBuf> {
        if !is_name(slug) {
            bail!("bad design system \"{slug}\"");
        }
        let dir = self.workspace(workspace)?.join("systems").join(slug);
        if !dir.join(CONFIG).is_file() {
            bail!("no design system \"{slug}\"");
        }
        Ok(dir)
    }

    /// Deletes a design system. Designs that use it keep their pages.
    pub fn remove_system(&self, workspace: &str, slug: &str) -> Result<()> {
        let dir = self.system_dir(workspace, slug)?;
        std::fs::remove_dir_all(&dir).with_context(|| format!("cannot remove {}", dir.display()))
    }

    /// Records a finished sync: each source's commit, the time, and the anchor
    /// (written last).
    pub fn synced(
        &self,
        workspace: &str,
        slug: &str,
        commits: &[(String, String)],
        now: u64,
    ) -> Result<()> {
        let dir = self.system_dir(workspace, slug)?;
        let mut config = read_config(&dir)?;
        for s in &mut config.sources {
            if let Some((_, c)) = commits.iter().find(|(p, _)| *p == s.project) {
                s.commit = Some(c.clone());
            }
        }
        config.synced_at = Some(now);
        std::fs::write(dir.join(CONFIG), toml::to_string(&config)?)?;
        let roots: Vec<PathBuf> = config
            .sources
            .iter()
            .map(|s| PathBuf::from(&s.path))
            .collect();
        anchor::write(&dir, &roots)
    }

    /// A file under the workspace's design folder (`design.file`): never one
    /// outside it, through `..`, an absolute path or a symlink.
    pub fn resolve(&self, workspace: &str, rel: &str) -> Result<PathBuf> {
        let base = self.workspace(workspace)?;
        let Some(path) = inside_dir(&base, rel) else {
            bail!("{rel} is outside the design folder");
        };
        let (real, real_base) = (std::fs::canonicalize(&path)?, std::fs::canonicalize(&base)?);
        if !real.starts_with(&real_base) {
            bail!("{rel} is outside the design folder");
        }
        Ok(path)
    }

    /// `~/.moonlet/design/<workspace>`, refusing an id that is not one folder name.
    fn workspace(&self, workspace: &str) -> Result<PathBuf> {
        if !is_name(workspace) {
            bail!("bad workspace id \"{workspace}\"");
        }
        crate::paths::ensure_private_dir(&self.root)?;
        Ok(self.root.join(workspace))
    }
}

/// What Design mode shows of a design system.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemSummary {
    pub slug: String,
    pub name: String,
    /// The source projects' folders.
    pub sources: Vec<String>,
    pub synced_at: Option<u64>,
    /// The first source's commit at the last sync.
    pub synced_commit: Option<String>,
    /// Component cards (not foundations or layouts).
    pub cards: usize,
    pub layouts: usize,
    /// Source files changed since the sync, each once.
    pub changed_sources: Vec<String>,
    pub check_problems: usize,
    /// Proposed changes and orphaned cards waiting for the user.
    pub to_settle: usize,
}

/// One folder name: not empty, not `.` or `..`, no separator.
fn is_name(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\'])
}

/// `base/rel` with `.` and `..` worked out, or `None` when it leaves `base`.
fn inside_dir(base: &Path, rel: &str) -> Option<PathBuf> {
    use std::path::Component;
    let mut out = base.to_path_buf();
    let mut depth = 0usize;
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(p) => {
                out.push(p);
                depth += 1;
            }
            Component::CurDir => {}
            Component::ParentDir if depth > 0 => {
                out.pop();
                depth -= 1;
            }
            _ => return None,
        }
    }
    Some(out)
}

fn read_config(dir: &Path) -> Result<SystemConfig> {
    Ok(toml::from_str(&std::fs::read_to_string(dir.join(CONFIG))?)?)
}

/// A design system's settings file.
pub const CONFIG: &str = "config.toml";

/// `moonlet desktop` → `moonlet-desktop`.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "design-system".into()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> Source {
        Source {
            project: "p-moonlet".into(),
            path: "/Users/alex/Workspace/1devstudio/moonlet".into(),
            identity: Some("github.com/1devstudio/moonlet".into()),
            subdir: None,
            commit: None,
        }
    }

    #[test]
    fn a_new_design_system_gets_a_folder_and_a_config_and_a_used_name_gets_a_number() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        assert_eq!(
            store
                .create_system(
                    "w-1devstudio",
                    "moonlet desktop",
                    vec![source()],
                    1_761_200_000_000
                )
                .unwrap(),
            "moonlet-desktop"
        );
        assert_eq!(
            std::fs::read_to_string(
                home.path()
                    .join("design/w-1devstudio/systems/moonlet-desktop/config.toml")
            )
            .unwrap(),
            "name = \"moonlet desktop\"
created_at = 1761200000000

[[sources]]
project = \"p-moonlet\"
path = \"/Users/alex/Workspace/1devstudio/moonlet\"
identity = \"github.com/1devstudio/moonlet\"
"
        );
        assert_eq!(
            store
                .create_system("w-1devstudio", "moonlet desktop", vec![source()], 1)
                .unwrap(),
            "moonlet-desktop-2"
        );
        let second = std::fs::read_to_string(
            home.path()
                .join("design/w-1devstudio/systems/moonlet-desktop-2/config.toml"),
        )
        .unwrap();
        assert!(second.starts_with("name = \"moonlet desktop 2\"\n"));
    }

    fn put(dir: &Path, files: &[(&str, &str)]) {
        for (path, text) in files {
            let p = dir.join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
    }

    #[test]
    fn a_workspace_lists_its_design_systems_with_their_cards_and_what_needs_the_user() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        put(
            project.path(),
            &[("src/ui.tsx", "button\n"), ("src/Sidebar.tsx", "sidebar\n")],
        );
        let store = Store::new(home.path());
        let mut src = source();
        src.path = project.path().display().to_string();
        let slug = store
            .create_system("w1", "moonlet desktop", vec![src], 5)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        put(
            &dir,
            &[
                ("styles.css", "@import \"components.css\";\n"),
                ("components.css", ".btn { color: red; }\n"),
                (
                    "components/buttons/button/button.html",
                    "<!-- @dsCard group=\"Buttons\" source=\"src/ui.tsx\" -->\n<button class=\"btn\">Run</button>\n",
                ),
                (
                    "components/custom/row/row.html",
                    "<!-- @dsCard group=\"Custom\" source=\"src/Sidebar.tsx\" -->\n<div style=\"color: var(--missing)\">row</div>\n",
                ),
                (
                    "ui_kits/app/settings.html",
                    "<!-- @dsCard group=\"Layouts\" viewport=\"1440x900\" -->\n<main></main>\n",
                ),
            ],
        );
        store
            .synced("w1", &slug, &[("p-moonlet".into(), "4db5585".into())], 9)
            .unwrap();
        // After the sync: a source changes and a card waits to be settled.
        put(project.path(), &[("src/ui.tsx", "button with loading\n")]);
        put(
            &dir,
            &[(
                "components/custom/row/row.proposed.html",
                "<!-- @dsCard group=\"Custom\" -->\n",
            )],
        );
        let got = store.systems("w1").unwrap();
        assert_eq!(
            got,
            vec![SystemSummary {
                slug: "moonlet-desktop".into(),
                name: "moonlet desktop".into(),
                sources: vec![project.path().display().to_string()],
                synced_at: Some(9),
                synced_commit: Some("4db5585".into()),
                cards: 2,
                layouts: 1,
                changed_sources: vec!["src/ui.tsx".into()],
                check_problems: 1,
                to_settle: 1,
            }]
        );
        assert_eq!(store.systems("w-none").unwrap(), vec![]);
    }

    #[test]
    fn removing_a_system_deletes_its_folder_and_files_resolve_only_inside_the_workspace() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store.create_system("w1", "storefront", vec![], 1).unwrap();
        put(
            &home.path().join("design/w1/systems/storefront"),
            &[("styles.css", "")],
        );
        std::fs::write(home.path().join("secret.txt"), "no").unwrap();
        std::os::unix::fs::symlink(
            home.path().join("secret.txt"),
            home.path().join("design/w1/systems/storefront/link.css"),
        )
        .unwrap();
        assert_eq!(
            store
                .resolve("w1", "systems/storefront/styles.css")
                .unwrap(),
            home.path().join("design/w1/systems/storefront/styles.css")
        );
        for bad in [
            "systems/storefront/../../../../secret.txt",
            "/etc/hosts",
            "systems/storefront/link.css",
        ] {
            assert!(store.resolve("w1", bad).is_err(), "{bad} resolved");
        }
        store.remove_system("w1", &slug).unwrap();
        assert!(!home.path().join("design/w1/systems/storefront").exists());
        assert!(store.remove_system("w1", "..").is_err());
    }
}
