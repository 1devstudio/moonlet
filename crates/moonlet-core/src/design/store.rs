//! Where design systems live (X64, ADR 0013): `~/.moonlet/design/<workspace
//! id>/systems/<slug>/`, each with a `config.toml` naming its sources.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use moonlet_proto::types::ProjectIdentity;
use serde::{Deserialize, Serialize};

use super::check::{self, html_files};
use super::{anchor, foundations, manifest, readme};

/// One project a design system is built from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    /// The moonlet project's id.
    pub project: String,
    /// Its folder on this Mac.
    pub path: String,
    /// What makes it the same project elsewhere (X41), when known.
    #[serde(default, skip_serializing_if = "is_unknown")]
    pub identity: ProjectIdentity,
    /// A folder of the repository the system covers, such as `apps/mobile`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subdir: Option<String>,
    /// `HEAD` at the last sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

fn is_unknown(i: &ProjectIdentity) -> bool {
    i.origin.is_none() && i.root.is_none()
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
    /// Per-card settings, by card path.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub cards: BTreeMap<String, CardSettings>,
}

/// A card's exceptions to the defaults (X64).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardSettings {
    /// Leave the component out of the design system.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub skip: bool,
    /// `column` or `single` instead of the grid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// `WxH` instead of the marker's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<String>,
}

impl SystemConfig {
    /// Each card's settings as the text that joins its `source_key`.
    pub fn exceptions(&self) -> BTreeMap<String, String> {
        self.cards
            .iter()
            .map(|(p, c)| {
                (
                    p.clone(),
                    toml::to_string(c).unwrap_or_default().trim().to_string(),
                )
            })
            .collect()
    }
}

/// The design folders of one moonlet home.
#[derive(Clone)]
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
        std::fs::create_dir_all(&systems)
            .with_context(|| format!("cannot create {}", systems.display()))?;
        let name = name.trim();
        if name.is_empty() {
            bail!("a design system needs a name");
        }
        // `create_dir` fails when the folder exists, even when another request
        // made it a moment ago, so two creations never share a slug.
        let mut n = 1;
        let (name_n, slug) = loop {
            let name_n = if n == 1 {
                name.to_string()
            } else {
                format!("{name} {n}")
            };
            let slug = slug(&name_n);
            match std::fs::create_dir(systems.join(&slug)) {
                Ok(()) => break (name_n, slug),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
                Err(e) => {
                    return Err(e).with_context(|| {
                        format!("cannot create {}", systems.join(&slug).display())
                    });
                }
            }
        };
        let config = SystemConfig {
            name: name_n,
            created_at: now,
            synced_at: None,
            sources,
            cards: BTreeMap::new(),
        };
        std::fs::write(systems.join(&slug).join(CONFIG), toml::to_string(&config)?)?;
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
            let slug = e.file_name().to_string_lossy().into_owned();
            // A system that cannot be read still lists, with its error, so
            // one broken folder never hides the others.
            out.push(
                summary(&dir, slug.clone(), &config).unwrap_or_else(|err| SystemSummary {
                    slug,
                    name: config.name.clone(),
                    sources: config.sources.iter().map(|s| s.path.clone()).collect(),
                    synced_at: config.synced_at,
                    synced_commit: config.sources.first().and_then(|s| s.commit.clone()),
                    cards: 0,
                    layouts: 0,
                    changed_sources: Vec::new(),
                    check_problems: 0,
                    to_settle: 0,
                    step: None,
                    step_summary: None,
                    error: Some(format!("{err:#}")),
                    agent: read_agent(&dir),
                }),
            );
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

    /// A design system's `config.toml`.
    pub fn config(&self, workspace: &str, slug: &str) -> Result<SystemConfig> {
        read_config(&self.system_dir(workspace, slug)?)
    }

    /// Deletes a design system. Designs that use it keep their pages.
    pub fn remove_system(&self, workspace: &str, slug: &str) -> Result<()> {
        let dir = self.system_dir(workspace, slug)?;
        std::fs::remove_dir_all(&dir).with_context(|| format!("cannot remove {}", dir.display()))
    }

    /// The chat of the system's sync agent, kept for the app's Open agent
    /// and across daemon restarts (chats restore themselves).
    pub fn set_agent(&self, workspace: &str, slug: &str, terminal: u32) -> Result<()> {
        let dir = self.system_dir(workspace, slug)?;
        std::fs::create_dir_all(dir.join(".cache"))?;
        std::fs::write(dir.join(AGENT), format!("terminal = {terminal}\n"))?;
        Ok(())
    }

    pub fn agent(&self, workspace: &str, slug: &str) -> Result<Option<u32>> {
        Ok(read_agent(&self.system_dir(workspace, slug)?))
    }

    /// What a running sync reports as it goes (`design.system.progress`).
    pub fn progress(
        &self,
        workspace: &str,
        slug: &str,
        step: &str,
        summary: Option<&str>,
    ) -> Result<()> {
        if !STEPS.contains(&step) {
            bail!(
                "unknown step \"{step}\"; the steps are {}",
                STEPS.join(", ")
            );
        }
        let dir = self.system_dir(workspace, slug)?;
        std::fs::create_dir_all(dir.join(".cache"))?;
        let p = Progress {
            step: step.into(),
            summary: summary.map(String::from),
        };
        std::fs::write(dir.join(PROGRESS), toml::to_string(&p)?)?;
        Ok(())
    }

    /// Records a finished sync: each source's commit, the time, and the anchor
    /// (written last).
    pub fn synced(
        &self,
        workspace: &str,
        slug: &str,
        commits: &[(String, Option<String>)],
        now: u64,
    ) -> Result<()> {
        let dir = self.system_dir(workspace, slug)?;
        let mut config = read_config(&dir)?;
        // The anchor first: until it is written the sync is not done, and
        // config.toml and the progress still say so.
        anchor::write(&dir, &source_roots(&config), &config.exceptions())?;
        for s in &mut config.sources {
            if let Some((_, c)) = commits.iter().find(|(p, _)| *p == s.project) {
                // A HEAD that could not be read leaves no commit, not a stale one.
                s.commit = c.clone();
            }
        }
        config.synced_at = Some(now);
        std::fs::write(dir.join(CONFIG), toml::to_string(&config)?)?;
        let _ = std::fs::remove_file(dir.join(PROGRESS));
        Ok(())
    }

    /// A file under the workspace's design folder (`design.file`): never one
    /// outside it, through `..`, an absolute path or a symlink.
    pub fn resolve(&self, workspace: &str, rel: &str) -> Result<PathBuf> {
        let base = self.workspace(workspace)?;
        let Some(path) = inside_dir(&base, rel) else {
            bail!("{rel} is outside the design folder");
        };
        // Against the design folder itself, so a linked workspace folder does
        // not move the bounds with it.
        let real_root = std::fs::canonicalize(&self.root)?;
        if !std::fs::canonicalize(&path)?.starts_with(real_root.join(workspace)) {
            bail!("{rel} is outside the design folder");
        }
        Ok(path)
    }

    /// Rewrites the generated files (foundation cards, `_ds_manifest.json`,
    /// `README.md`) and returns every problem of the system, by file and line.
    pub fn check_system(&self, workspace: &str, slug: &str) -> Result<Vec<check::Problem>> {
        let dir = self.system_dir(workspace, slug)?;
        let config = read_config(&dir)?;
        foundations::write(&dir)?;
        manifest::write(&dir)?;
        let mut problems = readme::write(&dir, &config.name)?;
        problems.extend(check::check(&dir)?);
        problems.sort_by(|a, b| (&a.path, a.line).cmp(&(&b.path, b.line)));
        Ok(problems)
    }

    /// Settles a card the user is asked about after a sync (X64).
    pub fn settle(&self, workspace: &str, slug: &str, card: &str, choice: Settle) -> Result<()> {
        let dir = self.system_dir(workspace, slug)?;
        // A card is `components/<group>/<name>/<name>.html` or
        // `ui_kits/<kit>/<screen>.html`, named with no `.` or `..`, and
        // reached through no symlink.
        let parts: Vec<&str> = card.split('/').collect();
        let shape = match parts.first() {
            Some(&"components") => parts.len() == 4,
            Some(&"ui_kits") => parts.len() == 3,
            _ => false,
        };
        let plain = parts
            .iter()
            .all(|p| !p.is_empty() && *p != "." && *p != "..");
        let html = card.ends_with(".html") && !card.ends_with(".proposed.html");
        if !(shape && plain && html) {
            bail!("{card} is not a card of {slug}");
        }
        let path = dir.join(card);
        let folder = path.parent().unwrap_or(&dir).to_path_buf();
        let real_dir = std::fs::canonicalize(&dir)?;
        if std::fs::canonicalize(&folder).map_or(true, |f| !f.starts_with(&real_dir)) {
            bail!("{card} is not a card of {slug}");
        }
        let proposed = path.with_extension("proposed.html");
        match choice {
            Settle::Mine => std::fs::remove_file(&proposed)?,
            Settle::Synced => std::fs::rename(&proposed, &path)?,
            Settle::Remove if parts[0] == "components" => std::fs::remove_dir_all(&folder)?,
            Settle::Remove => {
                std::fs::remove_file(&path)?;
                let _ = std::fs::remove_file(&proposed);
            }
            Settle::Keep => {}
        }
        Ok(())
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
    /// The step a running sync reported last: `inventory`, `tokens`, `cards` or `layouts`.
    pub step: Option<String>,
    pub step_summary: Option<String>,
    /// Why the system could not be read, when it could not.
    pub error: Option<String>,
    /// The chat of its sync agent, once one was started.
    pub agent: Option<u32>,
}

/// Each source's folder: the repository, or its sub-folder when it names one.
/// Card sources are relative to it.
fn source_roots(config: &SystemConfig) -> Vec<PathBuf> {
    config
        .sources
        .iter()
        .map(|s| match &s.subdir {
            Some(sub) => Path::new(&s.path).join(sub),
            None => PathBuf::from(&s.path),
        })
        .collect()
}

/// What the list shows of one design system.
fn summary(dir: &Path, slug: String, config: &SystemConfig) -> Result<SystemSummary> {
    let progress: Option<Progress> = std::fs::read_to_string(dir.join(PROGRESS))
        .ok()
        .and_then(|t| toml::from_str(&t).ok());
    let cards = manifest::build(dir)?.cards;
    let status = anchor::status(dir, &source_roots(config), &config.exceptions())?;
    let mut changed: Vec<String> = status
        .iter()
        .flat_map(|s| s.changed_sources.clone())
        .collect();
    changed.sort();
    changed.dedup();
    let proposed = html_files(dir)
        .iter()
        .filter(|p| p.to_string_lossy().ends_with(".proposed.html"))
        .count();
    Ok(SystemSummary {
        slug,
        name: config.name.clone(),
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
        check_problems: check::check(dir)?.len(),
        to_settle: proposed + status.iter().filter(|s| s.orphaned).count(),
        step: progress.as_ref().map(|p| p.step.clone()),
        step_summary: progress.and_then(|p| p.summary),
        error: None,
        agent: read_agent(dir),
    })
}

/// What the user picks for a card under Needs you (X64).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Settle {
    /// Keep the card as edited by hand; drop the sync's proposal.
    Mine,
    /// Replace the card with the sync's proposal.
    Synced,
    /// Delete an orphaned card.
    Remove,
    /// Leave an orphaned card until the next sync.
    Keep,
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

/// The sync's steps, in order (X64).
pub const STEPS: [&str; 4] = ["inventory", "tokens", "cards", "layouts"];
const PROGRESS: &str = ".cache/progress.toml";
const AGENT: &str = ".cache/agent.toml";

fn read_agent(dir: &Path) -> Option<u32> {
    #[derive(Deserialize)]
    struct Agent {
        terminal: u32,
    }
    let text = std::fs::read_to_string(dir.join(AGENT)).ok()?;
    toml::from_str::<Agent>(&text).ok().map(|a| a.terminal)
}

#[derive(Serialize, Deserialize)]
struct Progress {
    step: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
}

/// The content type the app serves a design file with.
pub fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
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
            identity: ProjectIdentity {
                origin: Some("github.com/1devstudio/moonlet".into()),
                root: Some("9c1e0a2".into()),
            },
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

[sources.identity]
origin = \"github.com/1devstudio/moonlet\"
root = \"9c1e0a2\"
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
            .synced(
                "w1",
                &slug,
                &[("p-moonlet".into(), Some("4db5585".into()))],
                9,
            )
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
                step: None,
                step_summary: None,
                error: None,
                agent: None,
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

    #[test]
    fn checking_a_system_writes_its_generated_files_and_returns_every_problem() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store.create_system("w1", "storefront", vec![], 1).unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        put(
            &dir,
            &[
                (
                    "styles.css",
                    "@import \"tokens/colors.css\";\n@import \"components.css\";\n",
                ),
                ("tokens/colors.css", ":root { --color-bg: #fff; }\n"),
                ("components.css", ".btn { background: var(--color-bg); }\n"),
                ("conventions.md", "Use `.btn` and `.chip`.\n"),
                (
                    "components/buttons/button/button.html",
                    "<!-- @dsCard group=\"Buttons\" -->\n<button class=\"btn\" style=\"color: var(--color-fg)\">Pay</button>\n",
                ),
            ],
        );
        let got: Vec<(String, usize, check::Kind)> = store
            .check_system("w1", &slug)
            .unwrap()
            .into_iter()
            .map(|p| (p.path, p.line, p.kind))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    "components/buttons/button/button.html".into(),
                    2,
                    check::Kind::UnknownToken
                ),
                ("conventions.md".into(), 1, check::Kind::UnknownName),
            ]
        );
        for generated in [
            "README.md",
            "_ds_manifest.json",
            "foundations/colours/colours.html",
        ] {
            assert!(dir.join(generated).is_file(), "{generated} not written");
        }
        assert!(
            std::fs::read_to_string(dir.join("README.md"))
                .unwrap()
                .contains("# storefront\n")
        );
    }

    #[test]
    fn settling_a_card_keeps_mine_uses_the_synced_one_or_removes_it() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store.create_system("w1", "storefront", vec![], 1).unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        let mine = "<!-- @dsCard group=\"Custom\" -->\n<div>mine</div>\n";
        let synced = "<!-- @dsCard group=\"Custom\" -->\n<div>synced</div>\n";
        let row = "components/custom/row/row.html";
        put(
            &dir,
            &[
                (row, mine),
                ("components/custom/row/row.proposed.html", synced),
            ],
        );
        store.settle("w1", &slug, row, Settle::Mine).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(row)).unwrap(), mine);
        assert!(!dir.join("components/custom/row/row.proposed.html").exists());

        put(&dir, &[("components/custom/row/row.proposed.html", synced)]);
        store.settle("w1", &slug, row, Settle::Synced).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(row)).unwrap(), synced);
        assert!(!dir.join("components/custom/row/row.proposed.html").exists());

        store.settle("w1", &slug, row, Settle::Remove).unwrap();
        assert!(!dir.join("components/custom/row").exists());
        assert!(
            store
                .settle("w1", &slug, "styles.css", Settle::Remove)
                .is_err()
        );
        assert!(
            store
                .settle("w1", &slug, "components/../../config.toml", Settle::Remove)
                .is_err()
        );
    }

    #[test]
    fn sync_progress_shows_in_the_list_until_the_sync_is_recorded() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store.create_system("w1", "storefront", vec![], 1).unwrap();
        store
            .progress("w1", &slug, "cards", Some("1 of 3"))
            .unwrap();
        let s = &store.systems("w1").unwrap()[0];
        assert_eq!(
            (s.step.as_deref(), s.step_summary.as_deref()),
            (Some("cards"), Some("1 of 3"))
        );
        assert!(store.progress("w1", &slug, "painting", None).is_err());
        store.synced("w1", &slug, &[], 2).unwrap();
        assert_eq!(store.systems("w1").unwrap()[0].step, None);
    }

    #[test]
    fn a_file_has_a_content_type_from_its_extension() {
        assert_eq!(
            content_type(Path::new("a/b/card.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            content_type(Path::new("styles.css")),
            "text/css; charset=utf-8"
        );
        assert_eq!(content_type(Path::new("fonts/Inter.woff2")), "font/woff2");
        assert_eq!(content_type(Path::new("assets/logo.svg")), "image/svg+xml");
        assert_eq!(content_type(Path::new("assets/x.png")), "image/png");
        assert_eq!(
            content_type(Path::new("README")),
            "application/octet-stream"
        );
    }
    // Review fixes (#343).

    #[test]
    fn settling_never_touches_files_outside_the_system_through_a_link_or_dots() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        put(
            outside.path(),
            &[
                ("row/row.html", "theirs"),
                ("row/row.proposed.html", "proposal"),
            ],
        );
        let store = Store::new(home.path());
        let slug = store.create_system("w1", "storefront", vec![], 1).unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        put(
            &dir,
            &[(
                "components/buttons/button/button.html",
                "<!-- @dsCard group=\"Buttons\" -->\n",
            )],
        );
        std::os::unix::fs::symlink(outside.path(), dir.join("components/custom")).unwrap();
        for choice in [Settle::Mine, Settle::Synced, Settle::Remove] {
            assert!(
                store
                    .settle("w1", &slug, "components/custom/row/row.html", choice)
                    .is_err(),
                "{choice:?} went through the link"
            );
        }
        assert!(
            outside.path().join("row/row.proposed.html").is_file()
                && outside.path().join("row/row.html").is_file()
        );
        for card in [
            "components/../x.html",
            "components/buttons.html",
            "components/buttons/button/../../../config.toml",
        ] {
            assert!(
                store.settle("w1", &slug, card, Settle::Remove).is_err(),
                "{card} was removed"
            );
        }
        assert!(
            dir.join(CONFIG).is_file()
                && dir.join("components/buttons/button/button.html").is_file()
        );
    }

    #[test]
    fn a_linked_workspace_folder_does_not_widen_what_files_resolve() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        put(outside.path(), &[("systems/x/styles.css", "")]);
        std::fs::create_dir_all(home.path().join("design")).unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join("design/w1")).unwrap();
        assert!(
            Store::new(home.path())
                .resolve("w1", "systems/x/styles.css")
                .is_err()
        );
    }

    #[test]
    fn a_source_with_a_subfolder_reads_card_sources_inside_it() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        put(repo.path(), &[("apps/mobile/src/Button.tsx", "one\n")]);
        let store = Store::new(home.path());
        let mut src = source();
        src.path = repo.path().display().to_string();
        src.subdir = Some("apps/mobile".into());
        let slug = store
            .create_system("w1", "moonlet mobile", vec![src], 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        put(
            &dir,
            &[
                ("styles.css", ""),
                (
                    "components/buttons/button/button.html",
                    "<!-- @dsCard group=\"Buttons\" source=\"src/Button.tsx\" -->\n<button></button>\n",
                ),
            ],
        );
        store
            .synced(
                "w1",
                &slug,
                &[("p-moonlet".into(), Some("abc1234".into()))],
                2,
            )
            .unwrap();
        put(repo.path(), &[("apps/mobile/src/Button.tsx", "two\n")]);
        assert_eq!(
            store.systems("w1").unwrap()[0].changed_sources,
            vec!["src/Button.tsx".to_string()]
        );
    }

    #[test]
    fn a_sync_whose_anchor_cannot_be_written_stays_unfinished_and_a_lost_head_is_cleared() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let mut src = source();
        src.commit = Some("old1234".into());
        let slug = store
            .create_system("w1", "storefront", vec![src], 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        put(
            &dir,
            &[(
                "components/buttons/button/button.html",
                "<!-- @dsCard group=\"Buttons\" -->\n",
            )],
        );
        store.progress("w1", &slug, "layouts", None).unwrap();
        let card = dir.join("components/buttons/button/button.html");
        std::fs::set_permissions(&card, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert!(
            store
                .synced(
                    "w1",
                    &slug,
                    &[("p-moonlet".into(), Some("new5678".into()))],
                    9
                )
                .is_err()
        );
        std::fs::set_permissions(&card, std::fs::Permissions::from_mode(0o644)).unwrap();
        let s = &store.systems("w1").unwrap()[0];
        assert_eq!(
            (s.synced_at, s.synced_commit.as_deref(), s.step.as_deref()),
            (None, Some("old1234"), Some("layouts"))
        );
        // A source whose HEAD could not be read has no commit, not a stale one.
        store
            .synced("w1", &slug, &[("p-moonlet".into(), None)], 10)
            .unwrap();
        assert_eq!(store.systems("w1").unwrap()[0].synced_commit, None);
    }

    #[test]
    fn one_broken_system_still_lists_with_its_error_beside_the_others() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let a = store.create_system("w1", "alpha", vec![], 1).unwrap();
        store.create_system("w1", "beta", vec![], 1).unwrap();
        put(
            &home.path().join("design/w1/systems").join(&a),
            &[("_ds_sync.json", "{ not json")],
        );
        let got: Vec<(String, bool)> = store
            .systems("w1")
            .unwrap()
            .into_iter()
            .map(|s| (s.name, s.error.is_some()))
            .collect();
        assert_eq!(got, vec![("alpha".into(), true), ("beta".into(), false)]);
    }

    #[test]
    fn a_system_remembers_its_agents_chat() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store.create_system("w1", "storefront", vec![], 1).unwrap();
        assert_eq!(store.agent("w1", &slug).unwrap(), None);
        store.set_agent("w1", &slug, 42).unwrap();
        assert_eq!(store.agent("w1", &slug).unwrap(), Some(42));
        assert_eq!(store.systems("w1").unwrap()[0].agent, Some(42));
    }
}
