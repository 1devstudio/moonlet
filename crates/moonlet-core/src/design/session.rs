//! Session designs (X65): a design made inside a session, which the
//! session's own agent writes. Its `design.toml`, `pages/`, `assets/` and a
//! pinned copy of its design system's styles in `system/` live in the
//! worktree under the project's design folder (`docs/design/<slug>/` unless
//! `.moonlet/config.toml` sets `[design] dir`), and are committed. Its
//! comments, history, built screenshots and a full copy of the design system
//! for the agent to read live in `<worktree>/.moonlet/design/<slug>/`, which
//! a `.gitignore` of `*` keeps out of git.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result, bail};
use moonlet_proto::methods::{DesignCardChange, DesignSystemUpdated};
use moonlet_proto::types::{DesignInfo, DesignKind};

use super::designs::{DESIGN_FILE, DesignConfig, NoSystem};
use super::fsx;
use super::place::DesignAt;
use super::store::Store;

/// Where a project's session designs live when its config names no folder.
pub const DEFAULT_DIR: &str = "docs/design";

/// The folder in a worktree that holds every session design's comments,
/// history and copy of its design system, which git ignores.
pub const SIDE_DIR: &str = ".moonlet/design";

/// A session design's copies of its design system: `system/` beside its
/// pages and in its folder under [`SIDE_DIR`].
const SYSTEM_DIR: &str = "system";

impl Store {
    /// Makes a session design named `name` on the workspace's design system
    /// `system` in the worktree's design folder `folder`, and returns it:
    /// `design.toml` with the anchor its system was copied at, `pages/`,
    /// `assets/` and the system's styles pinned in `system/`; then its
    /// comments, history and the whole system for its agent to read in
    /// `.moonlet/design/<slug>/`. A name already used in the folder gets a
    /// ` 2` (` 3`, …). Every write goes through the worktree as a handle.
    #[allow(clippy::too_many_arguments)]
    pub fn create_session_design(
        &self,
        workspace: &str,
        system: &str,
        session: &str,
        worktree: &Path,
        folder: &str,
        name: &str,
        brief: &str,
        now: u64,
    ) -> Result<DesignAt> {
        let config = DesignConfig {
            name: name.trim().to_string(),
            system: system.to_string(),
            anchor: None,
            brief: brief.to_string(),
            viewport: super::designs::desktop(),
            created_at: now,
            session: None,
            pages: BTreeMap::new(),
        };
        self.make_session_design(workspace, config, session, worktree, folder, |_| Ok(()))
    }

    /// Makes a session design from `config` (its name numbered when the
    /// folder has it already, the anchor its system is copied at recorded)
    /// with its folders and copies, then has `fill` write into it; one that
    /// fails is removed whole.
    fn make_session_design(
        &self,
        workspace: &str,
        mut config: DesignConfig,
        session: &str,
        worktree: &Path,
        folder: &str,
        fill: impl FnOnce(&DesignAt) -> Result<()>,
    ) -> Result<DesignAt> {
        if config.name.is_empty() {
            bail!("a design needs a name");
        }
        check_folder(folder)?;
        let Ok(system_dir) = self.system_dir(workspace, &config.system) else {
            return Err(NoSystem(config.system).into());
        };
        config.anchor = self.system_anchor(workspace, &config.system)?;
        let (name_n, slug) =
            fsx::create_numbered_inside(worktree, Path::new(folder), &config.name, "design")?;
        config.name = name_n;
        let at = session_at(session, worktree, folder, &slug);
        let written = (|| -> Result<()> {
            for sub in ["pages", "assets"] {
                fsx::make_dirs_inside(&at.root, &at.in_dir(sub))?;
            }
            fsx::write_inside(
                &at.root,
                &at.root.join(at.in_dir(DESIGN_FILE)),
                toml::to_string(&config)?.as_bytes(),
            )?;
            make_side(&at)?;
            copy_system(&at, &system_dir)?;
            fill(&at)
        })();
        // A creation that fails leaves nothing behind, so its name is free again.
        if let Err(e) = written {
            let _ = fsx::remove_dir_inside(&at.root, &at.folder());
            let _ = fsx::remove_dir_inside(&at.root, &at.root.join(&at.side));
            return Err(e);
        }
        Ok(at)
    }

    /// The session designs in a worktree's design folder `folder`, by name,
    /// each with its session; one whose `design.toml` cannot be read lists
    /// with its error. A worktree without the folder has none.
    pub fn session_designs(
        &self,
        session: &str,
        worktree: &Path,
        folder: &str,
    ) -> Result<Vec<DesignInfo>> {
        check_folder(folder)?;
        if !fsx::is_dir_inside(worktree, Path::new(folder))? {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for e in std::fs::read_dir(worktree.join(folder))?.flatten() {
            // A link is not a design, wherever it points.
            if !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let slug = e.file_name().to_string_lossy().into_owned();
            if super::place::check_slug(&slug).is_err() {
                continue;
            }
            let at = session_at(session, worktree, folder, &slug);
            // Only a folder with a design.toml is a design.
            if std::fs::symlink_metadata(at.root.join(at.in_dir(DESIGN_FILE))).is_err() {
                continue;
            }
            let mut info = match super::designs::read_design_config(&at) {
                Ok(config) => super::designs::summary(&at, &config, None),
                Err(err) => DesignInfo {
                    name: slug.clone(),
                    slug,
                    kind: DesignKind::Session,
                    system: String::new(),
                    path: at.folder().display().to_string(),
                    brief: String::new(),
                    viewport: String::new(),
                    pages: Vec::new(),
                    updated_at: 0,
                    open_comments: 0,
                    agent: None,
                    agent_state: None,
                    needs_you: None,
                    error: Some(format!("{err:#}")),
                    session: None,
                    project: None,
                    built_in: None,
                    system_updated: false,
                },
            };
            info.session = Some(session.to_string());
            out.push(info);
        }
        out.sort_by_key(|d| (d.name.to_lowercase(), d.slug.clone()));
        Ok(out)
    }

    /// The design system's sync anchor: the SHA-256 of its `_ds_sync.json`
    /// in hex; none before its first sync.
    pub fn system_anchor(&self, workspace: &str, system: &str) -> Result<Option<String>> {
        let dir = self.system_dir(workspace, system)?;
        let file = Path::new(super::anchor::FILE);
        if std::fs::symlink_metadata(dir.join(file))
            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(None);
        }
        let bytes = fsx::read_file_inside(&dir, file)?;
        Ok(Some(crate::hash::sha256_hex(&bytes)))
    }
}

impl Store {
    /// Whether the design system was synced since the session design
    /// pinned it: its anchor now is not the one in `design.toml`.
    pub fn session_system_updated(&self, at: &DesignAt, workspace: &str) -> Result<bool> {
        let config = self.design_config(at)?;
        Ok(self.system_anchor(workspace, &config.system)? != config.anchor)
    }

    /// Replaces both copies of a session design's design system with the
    /// system as it is now, records its anchor in `design.toml` (the rest of
    /// the file as it was), and lists the cards that changed since the copy.
    pub fn update_session_system(
        &self,
        at: &DesignAt,
        workspace: &str,
    ) -> Result<DesignSystemUpdated> {
        let config = self.design_config(at)?;
        let Ok(system_dir) = self.system_dir(workspace, &config.system) else {
            return Err(NoSystem(config.system).into());
        };
        let anchor = self.system_anchor(workspace, &config.system)?;
        let before = fsx::read_tree(&at.root, &at.in_side(SYSTEM_DIR))?;
        copy_system(at, &system_dir)?;
        let after = fsx::read_tree(&at.root, &at.in_side(SYSTEM_DIR))?;
        fsx::update_inside(&at.root, &at.in_dir(DESIGN_FILE), |text| {
            let mut doc: toml_edit::DocumentMut = text
                .parse()
                .with_context(|| format!("cannot read {DESIGN_FILE}"))?;
            match &anchor {
                Some(a) => doc["anchor"] = toml_edit::value(a.as_str()),
                None => {
                    doc.remove("anchor");
                }
            }
            Ok(doc.to_string())
        })?;
        Ok(DesignSystemUpdated {
            anchor,
            cards: changed_cards(&before, &after),
        })
    }
}

impl Store {
    /// Copies the workspace design `from` into the worktree as a session
    /// design of session `session` (Build it): the pages in `pages` (each
    /// must be one of its pages) with their labels, linking the copy's
    /// pinned styles, all of `assets/`, and its design system copied as a
    /// new session design's is. Returns the session design.
    #[allow(clippy::too_many_arguments)]
    pub fn copy_to_session(
        &self,
        from: &DesignAt,
        pages: &[String],
        session: &str,
        worktree: &Path,
        folder: &str,
        now: u64,
    ) -> Result<DesignAt> {
        let workspace = from
            .workspace
            .as_deref()
            .context("only a workspace design is copied into a session")?;
        let config = self.design_config(from)?;
        // Its pages read first: one it does not have refuses the copy before
        // anything is made.
        let link = super::designs::styles_link(from, &config.system);
        let mut kept = BTreeMap::new();
        for page in pages {
            if !super::pages::is_page_name(page) {
                return Err(super::pages::BadPage(page.clone()).into());
            }
            let rel = from.in_dir(Path::new("pages").join(format!("{page}.html")));
            let bytes = fsx::read_file_inside(&from.root, &rel)
                .map_err(|_| super::pages::BadPage(page.clone()))?;
            let text =
                String::from_utf8_lossy(&bytes).replace(&link, super::designs::SESSION_STYLES);
            kept.insert(format!("{page}.html"), text.into_bytes());
        }
        let assets = fsx::read_tree(&from.root, &from.in_dir("assets"))?;
        let copy = DesignConfig {
            anchor: None,
            created_at: now,
            session: None,
            pages: config
                .pages
                .iter()
                .filter(|(name, _)| pages.contains(name))
                .map(|(n, p)| (n.clone(), p.clone()))
                .collect(),
            ..config
        };
        let at = self.make_session_design(workspace, copy, session, worktree, folder, |at| {
            fsx::write_tree(&at.root, &at.dir, Path::new("pages"), &kept, true)?;
            fsx::write_tree(&at.root, &at.dir, Path::new("assets"), &assets, true)
        })?;
        // The design it came from records where it is built.
        fsx::update_inside(&from.root, &from.in_dir(DESIGN_FILE), |text| {
            let mut doc: toml_edit::DocumentMut = text
                .parse()
                .with_context(|| format!("cannot read {DESIGN_FILE}"))?;
            doc["session"] = toml_edit::value(session);
            Ok(doc.to_string())
        })?;
        Ok(at)
    }
}

/// The cards (`.html` files of a card folder, never a proposal) that are
/// new, changed or removed in `after` against `before`, by path.
fn changed_cards(
    before: &BTreeMap<String, Vec<u8>>,
    after: &BTreeMap<String, Vec<u8>>,
) -> Vec<DesignCardChange> {
    let is_card = |path: &str| {
        super::check::CARD_DIRS
            .iter()
            .any(|d| path.starts_with(&format!("{d}/")))
            && path.ends_with(".html")
            && !path.ends_with(".proposed.html")
    };
    let paths: std::collections::BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    paths
        .into_iter()
        .filter(|p| is_card(p))
        .filter_map(|p| {
            let change = match (before.get(p), after.get(p)) {
                (None, Some(_)) => "new",
                (Some(_), None) => "removed",
                (Some(a), Some(b)) if a != b => "changed",
                _ => return None,
            };
            Some(DesignCardChange {
                path: p.clone(),
                change: change.into(),
            })
        })
        .collect()
}

/// The folder of a project's session designs in its worktrees: its
/// config's `[design] dir`, else [`DEFAULT_DIR`]. One that is not a folder
/// inside the worktree is refused.
pub fn design_folder(config: &moonlet_proto::types::ProjectConfig) -> Result<String> {
    let folder = config.design.dir.as_deref().unwrap_or(DEFAULT_DIR);
    check_folder(folder)?;
    Ok(folder.to_string())
}

/// The session design `slug` of session `session`, whose worktree is
/// `worktree` and design folder `folder`: it must have a `design.toml` of
/// its own, reached through no link from the worktree.
pub fn session_design(
    session: &str,
    worktree: &Path,
    folder: &str,
    slug: &str,
) -> Result<DesignAt> {
    super::place::check_slug(slug)?;
    check_folder(folder)?;
    let at = session_at(session, worktree, folder, slug);
    if fsx::read_file_inside(&at.root, &at.in_dir(DESIGN_FILE)).is_err() {
        bail!("no design \"{slug}\" in {}", at.folder().display());
    }
    Ok(at)
}

/// A session design's address: `<folder>/<slug>/` in the worktree, its
/// comments and history in `.moonlet/design/<slug>/`.
fn session_at(session: &str, worktree: &Path, folder: &str, slug: &str) -> DesignAt {
    DesignAt {
        root: worktree.to_path_buf(),
        dir: Path::new(folder).join(slug),
        side: Path::new(SIDE_DIR).join(slug),
        slug: slug.to_string(),
        kind: DesignKind::Session,
        workspace: None,
        session: Some(session.to_string()),
        key: format!("s/{session}/{slug}"),
    }
}

/// A session design's whole copy of its design system, in its folder under
/// [`SIDE_DIR`]: a folder of its own on a path with no link.
pub(super) fn system_copy(at: &DesignAt) -> Result<std::path::PathBuf> {
    let rel = at.in_side(SYSTEM_DIR);
    if !fsx::is_dir_inside(&at.root, &rel)? {
        bail!("{} has no copy of its design system", at.slug);
    }
    Ok(at.root.join(rel))
}

/// A design folder: a path inside the worktree, made only of folder names.
fn check_folder(folder: &str) -> Result<()> {
    let plain = Path::new(folder)
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)));
    if folder.is_empty() || !plain {
        bail!("the design folder {folder:?} is not a folder inside the worktree");
    }
    Ok(())
}

/// The design's folder under [`SIDE_DIR`], made afresh (one left by a
/// design of the same name before is removed), and the `.gitignore` of `*`
/// that keeps that folder out of git.
fn make_side(at: &DesignAt) -> Result<()> {
    let side = Path::new(SIDE_DIR);
    fsx::make_dirs_inside(&at.root, side)?;
    fsx::write_inside(&at.root, &at.root.join(side.join(".gitignore")), b"*\n")?;
    fsx::remove_dir_inside(&at.root, &at.root.join(&at.side))?;
    fsx::make_dirs_inside(&at.root, &at.in_side(super::history::HISTORY_DIR))?;
    fsx::write_inside(
        &at.root,
        &at.root.join(at.in_side(super::comments::COMMENTS_FILE)),
        b"[]\n",
    )
}

/// A file of a design system a page needs to render: `styles.css`,
/// `components.css` and the component stylesheets it imports, its tokens and
/// its fonts. Never a proposal waiting for the user (X64).
fn is_style(path: &str) -> bool {
    let component_css = path.starts_with("components/")
        && path.ends_with(".css")
        && !path.ends_with(".proposed.css");
    matches!(path, "styles.css" | "components.css")
        || path.starts_with("tokens/")
        || path.starts_with("fonts/")
        || component_css
}

/// Copies the design system in `system_dir` into the design: its styles
/// pinned in `system/` beside the pages, and all of it in its folder under
/// [`SIDE_DIR`] for its agent to read (but its `config.toml`, the sync's
/// settings). Each copy is made exactly, so a file
/// the system no longer has goes too. Links and hidden files are left out.
fn copy_system(at: &DesignAt, system_dir: &Path) -> Result<()> {
    let mut all = fsx::read_tree(system_dir, Path::new(""))
        .with_context(|| format!("cannot read {}", system_dir.display()))?;
    // The sync's own settings: nothing a design is made from.
    all.remove(super::store::CONFIG);
    let styles: BTreeMap<String, Vec<u8>> = all
        .iter()
        .filter(|(path, _)| is_style(path))
        .map(|(p, b)| (p.clone(), b.clone()))
        .collect();
    fsx::write_tree(&at.root, &at.dir, Path::new(SYSTEM_DIR), &styles, true)?;
    fsx::write_tree(&at.root, &at.side, Path::new(SYSTEM_DIR), &all, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// A workspace `w1` with the design system `moonlet-desktop`, synced:
    /// its styles, a button's card and layout, and its anchor.
    pub(crate) fn store_with_synced_system() -> (tempfile::TempDir, Store) {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        store
            .create_system(
                "w1",
                "moonlet desktop",
                vec![],
                super::super::store::Cover::Core,
                1,
            )
            .unwrap();
        let system = home.path().join("design/w1/systems/moonlet-desktop");
        for (path, text) in SYSTEM {
            std::fs::create_dir_all(system.join(path).parent().unwrap()).unwrap();
            std::fs::write(system.join(path), text).unwrap();
        }
        (home, store)
    }

    pub(crate) const SYSTEM: [(&str, &str); 10] = [
        (
            "styles.css",
            "@import \"tokens/colors.css\";\n@import \"fonts/fonts.css\";\n@import \"components.css\";\n",
        ),
        (
            "components.css",
            "@import \"components/buttons/button/button.css\";\n",
        ),
        ("tokens/colors.css", ":root { --color-accent: #3b82f6; }\n"),
        (
            "fonts/fonts.css",
            "@font-face { font-family: Inter; src: url(\"Inter.woff2\"); }\n",
        ),
        (
            "components/buttons/button/button.css",
            ".btn { color: var(--color-accent); }\n",
        ),
        (
            "components/buttons/button/button.html",
            "<!-- @dsCard group=\"Buttons\" -->\n<button class=\"btn\">Run</button>\n",
        ),
        (
            "components/buttons/button/button.prompt.md",
            "Use .btn for every button.\n",
        ),
        (
            "ui_kits/app/settings.html",
            "<!-- @dsCard group=\"Layouts\" -->\n<main></main>\n",
        ),
        ("README.md", "# moonlet desktop\n"),
        ("_ds_sync.json", "{\"cards\":{}}\n"),
    ];

    /// Every file under `dir`, by its path in it, with its text.
    pub(crate) fn files(dir: &Path) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(at) = stack.pop() {
            for e in std::fs::read_dir(&at).unwrap().flatten() {
                if e.file_type().unwrap().is_dir() {
                    stack.push(e.path());
                } else {
                    let rel = e.path().strip_prefix(dir).unwrap().display().to_string();
                    out.insert(rel, std::fs::read_to_string(e.path()).unwrap());
                }
            }
        }
        out
    }

    #[test]
    fn a_session_design_is_made_under_the_worktrees_design_folder_with_its_systems_styles_pinned_at_its_anchor()
     {
        let (_home, store) = store_with_synced_system();
        let worktree = tempfile::tempdir().unwrap();
        let at = store
            .create_session_design(
                "w1",
                "moonlet-desktop",
                "s1",
                worktree.path(),
                "docs/design",
                "Settings page",
                "A settings page with General and Git sections",
                1_761_200_000_000,
            )
            .unwrap();
        assert_eq!(
            (at.slug.as_str(), at.folder()),
            (
                "settings-page",
                worktree.path().join("docs/design/settings-page")
            )
        );
        let dir = worktree.path().join("docs/design/settings-page");
        assert_eq!(
            std::fs::read_to_string(dir.join("design.toml")).unwrap(),
            "name = \"Settings page\"
system = \"moonlet-desktop\"
anchor = \"6f55dcc238ccfc8725b622913747cf8242355fe9bac58983b1541ddc901df4a4\"
brief = \"A settings page with General and Git sections\"
viewport = \"1440x900\"
created_at = 1761200000000
"
        );
        for folder in ["pages", "assets"] {
            assert!(dir.join(folder).is_dir(), "{folder}");
        }
        // Only the styles: what a page needs to render, nothing the agent reads.
        assert_eq!(
            files(&dir.join("system")).into_keys().collect::<Vec<_>>(),
            [
                "components.css",
                "components/buttons/button/button.css",
                "fonts/fonts.css",
                "styles.css",
                "tokens/colors.css",
            ]
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("system/tokens/colors.css")).unwrap(),
            ":root { --color-accent: #3b82f6; }\n"
        );
        // A name used in the folder gets a number, as a workspace design's does.
        let again = store
            .create_session_design(
                "w1",
                "moonlet-desktop",
                "s1",
                worktree.path(),
                "docs/design",
                "Settings page",
                "",
                2,
            )
            .unwrap();
        assert_eq!(again.slug, "settings-page-2");
    }

    /// `git` in `dir`, its output.
    fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
        String::from_utf8(out.stdout).unwrap()
    }

    #[test]
    fn a_session_designs_comments_history_and_whole_system_live_in_the_worktrees_moonlet_folder_which_git_ignores()
     {
        let (_home, store) = store_with_synced_system();
        let worktree = tempfile::tempdir().unwrap();
        git(worktree.path(), &["init", "-q", "-b", "main"]);
        store
            .create_session_design(
                "w1",
                "moonlet-desktop",
                "s1",
                worktree.path(),
                "docs/design",
                "Settings page",
                "",
                1,
            )
            .unwrap();
        // What git sees: the design, never its comments, history or copy.
        assert_eq!(
            git(
                worktree.path(),
                &["status", "--porcelain", "--untracked-files=all"]
            ),
            "?? docs/design/settings-page/design.toml
?? docs/design/settings-page/system/components.css
?? docs/design/settings-page/system/components/buttons/button/button.css
?? docs/design/settings-page/system/fonts/fonts.css
?? docs/design/settings-page/system/styles.css
?? docs/design/settings-page/system/tokens/colors.css
"
        );
        let moonlet = worktree.path().join(".moonlet/design");
        assert_eq!(
            std::fs::read_to_string(moonlet.join(".gitignore")).unwrap(),
            "*\n"
        );
        let side = moonlet.join("settings-page");
        assert_eq!(
            std::fs::read_to_string(side.join("comments.json")).unwrap(),
            "[]\n"
        );
        assert!(side.join("history").is_dir());
        // The whole design system, for the session's agent to read.
        assert_eq!(
            files(&side.join("system")),
            SYSTEM
                .iter()
                .map(|(p, t)| (p.to_string(), t.to_string()))
                .collect()
        );
    }

    #[test]
    fn the_design_folder_is_docs_design_unless_the_projects_config_sets_one_inside_the_worktree() {
        let repo = tempfile::tempdir().unwrap();
        let config = |text: Option<&str>| {
            std::fs::create_dir_all(repo.path().join(".moonlet")).unwrap();
            let file = repo.path().join(".moonlet/config.toml");
            match text {
                Some(t) => std::fs::write(&file, t).unwrap(),
                None => {
                    let _ = std::fs::remove_file(&file);
                }
            }
            design_folder(&crate::session::read_config(repo.path()))
        };
        assert_eq!(config(None).unwrap(), "docs/design");
        assert_eq!(config(Some("run = \"pnpm dev\"\n")).unwrap(), "docs/design");
        assert_eq!(
            config(Some("[design]\ndir = \"design/prototypes\"\n")).unwrap(),
            "design/prototypes"
        );
        for outside in ["../prototypes", "/tmp/prototypes", "design/../..", ""] {
            let text = format!("[design]\ndir = {outside:?}\n");
            assert!(config(Some(&text)).is_err(), "{outside}");
        }
    }

    #[test]
    fn a_session_design_is_found_in_its_worktree_but_never_through_a_link_or_outside_it() {
        let (_home, store) = store_with_synced_system();
        let worktree = tempfile::tempdir().unwrap();
        let made = store
            .create_session_design(
                "w1",
                "moonlet-desktop",
                "s1",
                worktree.path(),
                "docs/design",
                "Settings page",
                "",
                1,
            )
            .unwrap();
        let found = session_design("s1", worktree.path(), "docs/design", "settings-page").unwrap();
        assert_eq!(found, made);
        assert_eq!(
            (
                found.root.as_path(),
                found.dir.as_path(),
                found.side.as_path()
            ),
            (
                worktree.path(),
                Path::new("docs/design/settings-page"),
                Path::new(".moonlet/design/settings-page")
            )
        );
        // Names that are no design's, or that climb out.
        for slug in ["nope", "../settings-page", "settings-page@1", ""] {
            assert!(
                session_design("s1", worktree.path(), "docs/design", slug).is_err(),
                "{slug}"
            );
        }
        assert!(session_design("s1", worktree.path(), "../design", "settings-page").is_err());
        let outside = tempfile::tempdir().unwrap();
        // A design folder that is a link out of the worktree.
        std::os::unix::fs::symlink(outside.path(), worktree.path().join("linked")).unwrap();
        assert!(
            store
                .create_session_design(
                    "w1",
                    "moonlet-desktop",
                    "s1",
                    worktree.path(),
                    "linked/design",
                    "x",
                    "",
                    1
                )
                .is_err()
        );
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
        // A design that is a link to one outside.
        std::fs::create_dir_all(outside.path().join("evil")).unwrap();
        std::fs::write(
            outside.path().join("evil/design.toml"),
            "name = \"x\"\nsystem = \"y\"\n",
        )
        .unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("evil"),
            worktree.path().join("docs/design/evil"),
        )
        .unwrap();
        assert!(session_design("s1", worktree.path(), "docs/design", "evil").is_err());
        // A .moonlet that is a link out: nothing is written through it.
        let other = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), other.path().join(".moonlet")).unwrap();
        assert!(
            store
                .create_session_design(
                    "w1",
                    "moonlet-desktop",
                    "s2",
                    other.path(),
                    "docs/design",
                    "x",
                    "",
                    1
                )
                .is_err()
        );
        assert!(!outside.path().join("design").exists());
        assert!(!other.path().join("docs/design/x").exists());
    }

    #[test]
    fn updating_a_session_designs_system_replaces_both_copies_records_the_new_anchor_and_lists_the_changed_cards()
     {
        let (home, store) = store_with_synced_system();
        let worktree = tempfile::tempdir().unwrap();
        let at = store
            .create_session_design(
                "w1",
                "moonlet-desktop",
                "s1",
                worktree.path(),
                "docs/design",
                "Settings page",
                "b",
                1,
            )
            .unwrap();
        assert!(!store.session_system_updated(&at, "w1").unwrap());
        // The design system synced again.
        let system = home.path().join("design/w1/systems/moonlet-desktop");
        std::fs::write(
            system.join("tokens/colors.css"),
            ":root { --color-accent: #2563eb; }\n",
        )
        .unwrap();
        std::fs::write(
            system.join("components/buttons/button/button.html"),
            "<!-- @dsCard group=\"Buttons\" -->\n<button class=\"btn\">Run tests</button>\n",
        )
        .unwrap();
        std::fs::create_dir_all(system.join("components/forms/field")).unwrap();
        std::fs::write(
            system.join("components/forms/field/field.html"),
            "<!-- @dsCard group=\"Forms\" -->\n<input class=\"field\">\n",
        )
        .unwrap();
        std::fs::remove_file(system.join("ui_kits/app/settings.html")).unwrap();
        std::fs::write(
            system.join("_ds_sync.json"),
            "{\"cards\":{\"components/buttons/button/button.html\":{}}}\n",
        )
        .unwrap();
        assert!(store.session_system_updated(&at, "w1").unwrap());
        let updated = store.update_session_system(&at, "w1").unwrap();
        let change = |path: &str, change: &str| moonlet_proto::methods::DesignCardChange {
            path: path.into(),
            change: change.into(),
        };
        assert_eq!(
            updated,
            moonlet_proto::methods::DesignSystemUpdated {
                anchor: Some(
                    "c8927a57a423efa36791952c3c820cb62eccbc94a69cb2f6d8be80b7663e7ba6".into()
                ),
                cards: vec![
                    change("components/buttons/button/button.html", "changed"),
                    change("components/forms/field/field.html", "new"),
                    change("ui_kits/app/settings.html", "removed"),
                ],
            }
        );
        let dir = worktree.path().join("docs/design/settings-page");
        assert_eq!(
            std::fs::read_to_string(dir.join("system/tokens/colors.css")).unwrap(),
            ":root { --color-accent: #2563eb; }\n"
        );
        let side = worktree.path().join(".moonlet/design/settings-page/system");
        assert!(!side.join("ui_kits/app/settings.html").exists());
        assert_eq!(
            std::fs::read_to_string(side.join("components/forms/field/field.html")).unwrap(),
            "<!-- @dsCard group=\"Forms\" -->\n<input class=\"field\">\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("design.toml")).unwrap(),
            "name = \"Settings page\"
system = \"moonlet-desktop\"
anchor = \"c8927a57a423efa36791952c3c820cb62eccbc94a69cb2f6d8be80b7663e7ba6\"
brief = \"b\"
viewport = \"1440x900\"
created_at = 1
"
        );
        assert!(!store.session_system_updated(&at, "w1").unwrap());
    }

    #[test]
    fn a_session_designs_pages_comments_history_check_and_kit_are_read_and_written_in_its_worktree()
    {
        use super::super::history::Take;
        use moonlet_proto::types::CommentChange;
        let (_home, store) = store_with_synced_system();
        let worktree = tempfile::tempdir().unwrap();
        let at = store
            .create_session_design(
                "w1",
                "moonlet-desktop",
                "s1",
                worktree.path(),
                "docs/design",
                "Settings page",
                "",
                1,
            )
            .unwrap();
        let dir = worktree.path().join("docs/design/settings-page");
        let side = worktree.path().join(".moonlet/design/settings-page");
        let page = "<!doctype html>\n<link rel=\"stylesheet\" href=\"../system/styles.css\">\n<body data-mid=\"m1\"><button class=\"btn\" data-mid=\"m2\">Run</button></body>\n";
        std::fs::write(
            dir.join("pages/index.html"),
            "<body data-mid=\"m1\"></body>\n",
        )
        .unwrap();
        let read = store.page(&at, "index").unwrap();
        store.write_page(&at, "index", page, &read.version).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("pages/index.html")).unwrap(),
            page
        );
        // A page links its own pinned copy of the styles.
        assert_eq!(store.check_design(&at, false).unwrap(), vec![]);
        store
            .put_comment(
                &at,
                &CommentChange::New {
                    page: "index".into(),
                    mid: "m2".into(),
                    tag: "button".into(),
                    text: "Run".into(),
                    comment: "Say Run tests".into(),
                },
                5,
            )
            .unwrap();
        let comments = std::fs::read_to_string(side.join("comments.json")).unwrap();
        assert!(
            comments.contains("\"comment\": \"Say Run tests\""),
            "{comments}"
        );
        assert_eq!(store.design(&at).unwrap().open_comments, 1);
        store.take_snapshot(&at, Take::AgentTurn, 9).unwrap();
        assert_eq!(
            std::fs::read_to_string(side.join("history/1/pages/index.html")).unwrap(),
            page
        );
        assert_eq!(
            store.history(&at).unwrap()[0].summary,
            "Wrote index.html · 1 page"
        );
        // Its tokens and snippets come from its own copy of the system.
        let kit = store.design_kit(&at).unwrap();
        assert_eq!(
            (
                kit.system.as_str(),
                kit.tokens[0].name.as_str(),
                kit.tokens[0].value.as_str()
            ),
            ("moonlet-desktop", "--color-accent", "#3b82f6")
        );
    }

    #[test]
    fn a_workspace_design_copied_into_a_session_keeps_the_pages_chosen_linked_to_its_pinned_styles_and_records_the_session()
     {
        let (home, store) = store_with_synced_system();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "A left nav", 1)
            .unwrap();
        let from = store.workspace_design("w1", "settings-page").unwrap();
        store.set_design_viewport(&from, "390x844").unwrap();
        let design = home.path().join("design/w1/designs/settings-page");
        let page = |text: &str| {
            format!(
                "<!doctype html>\n<link rel=\"stylesheet\" href=\"../../../systems/moonlet-desktop/styles.css\">\n<body data-mid=\"m1\">{text}</body>\n"
            )
        };
        for (name, text) in [("index", "rows"), ("git-a", "cards"), ("git-b", "compact")] {
            std::fs::write(design.join(format!("pages/{name}.html")), page(text)).unwrap();
        }
        std::fs::write(design.join("assets/logo.svg"), "<svg></svg>\n").unwrap();
        let mut toml = std::fs::read_to_string(design.join("design.toml")).unwrap();
        toml.push_str("\n[pages.git-a]\nlabel = \"cards\"\n\n[pages.git-b]\nlabel = \"compact\"\n");
        std::fs::write(design.join("design.toml"), toml).unwrap();

        let worktree = tempfile::tempdir().unwrap();
        let at = store
            .copy_to_session(
                &from,
                &["index".into(), "git-a".into()],
                "s1",
                worktree.path(),
                "docs/design",
                1_761_300_000_000,
            )
            .unwrap();
        let dir = worktree.path().join("docs/design/settings-page");
        assert_eq!(at.folder(), dir);
        assert_eq!(
            files(&dir.join("pages")),
            BTreeMap::from([
                (
                    "git-a.html".to_string(),
                    "<!doctype html>\n<link rel=\"stylesheet\" href=\"../system/styles.css\">\n<body data-mid=\"m1\">cards</body>\n".to_string()
                ),
                (
                    "index.html".to_string(),
                    "<!doctype html>\n<link rel=\"stylesheet\" href=\"../system/styles.css\">\n<body data-mid=\"m1\">rows</body>\n".to_string()
                ),
            ])
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("assets/logo.svg")).unwrap(),
            "<svg></svg>\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("design.toml")).unwrap(),
            "name = \"Settings page\"
system = \"moonlet-desktop\"
anchor = \"6f55dcc238ccfc8725b622913747cf8242355fe9bac58983b1541ddc901df4a4\"
brief = \"A left nav\"
viewport = \"390x844\"
created_at = 1761300000000

[pages.git-a]
label = \"cards\"
"
        );
        assert!(dir.join("system/styles.css").is_file());
        assert!(
            worktree
                .path()
                .join(".moonlet/design/settings-page/system/README.md")
                .is_file()
        );
        // The workspace design records the session it is built in.
        assert_eq!(
            store.design_config(&from).unwrap().session.as_deref(),
            Some("s1")
        );
        // A page it does not have is refused, and nothing is made.
        let other = tempfile::tempdir().unwrap();
        assert!(
            store
                .copy_to_session(
                    &from,
                    &["nope".into()],
                    "s2",
                    other.path(),
                    "docs/design",
                    2
                )
                .is_err()
        );
        assert!(!other.path().join("docs/design/settings-page").exists());
    }
}
