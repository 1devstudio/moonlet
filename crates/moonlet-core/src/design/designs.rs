//! Workspace designs (X65): prototypes built on one design system, each in
//! `~/.moonlet/design/<workspace id>/designs/<slug>/` with `design.toml`,
//! `pages/`, `assets/`, `comments.json` and `history/`. Its agent may edit
//! all of that, `design.toml` included; what moonlet trusts (the agent's
//! chat) is in `<workspace>/.records/designs/<slug>.toml`, outside its
//! folders, so it cannot change it without the user approving the edit.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use moonlet_proto::types::{DesignInfo, DesignKind, DesignPage};

use super::check::{Kind, Problem};
use super::fsx;
use super::store::Store;

/// A design asked for on a design system the workspace does not have.
#[derive(Debug, thiserror::Error)]
#[error("no design system \"{0}\"")]
pub struct NoSystem(pub String);

/// A viewport that is not a width and a height in px.
#[derive(Debug, thiserror::Error)]
#[error("bad viewport \"{0}\": give a width and a height in px, such as 390x844")]
pub struct BadViewport(pub String);

/// A design's settings file.
pub const DESIGN_FILE: &str = "design.toml";

/// `design.toml`, which the design's agent may edit (it labels its pages).
/// Every field but the name and the design system has a default, so a file
/// written before a field existed still loads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesignConfig {
    pub name: String,
    /// The design system's slug.
    pub system: String,
    /// What the user asked for when creating it: the agent's first prompt.
    #[serde(default)]
    pub brief: String,
    /// The viewport last used, `WxH`.
    #[serde(default = "desktop")]
    pub viewport: String,
    #[serde(default)]
    pub created_at: u64,
    /// The session it was built in (Build it, X65 entry 12).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// Each page's label, by its name (`index` for `pages/index.html`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub pages: BTreeMap<String, PageConfig>,
}

/// The viewport a new design opens at: Desktop.
fn desktop() -> String {
    "1440x900".into()
}

/// `[pages.<name>]` in `design.toml`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageConfig {
    #[serde(default)]
    pub label: String,
}

/// What moonlet trusts about a design, outside its agent's folders: the agent
/// cannot change it without the user approving the edit.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesignRecord {
    /// The chat of its agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<u32>,
}

impl Store {
    /// Creates a workspace design on the design system `system` and returns
    /// its slug. A name already used in the workspace gets a ` 2` (` 3`, …)
    /// suffix, as a design system's does.
    pub fn create_design(
        &self,
        workspace: &str,
        name: &str,
        system: &str,
        brief: &str,
        now: u64,
    ) -> Result<String> {
        let name = name.trim();
        if name.is_empty() {
            bail!("a design needs a name");
        }
        // Only on a design system the workspace has.
        if self.system_dir(workspace, system).is_err() {
            return Err(NoSystem(system.to_string()).into());
        }
        let designs = self.designs_dir(workspace, true)?;
        let (name_n, slug) = super::store::create_numbered(&designs, name, "design")?;
        let dir = designs.join(&slug);
        let config = DesignConfig {
            name: name_n,
            system: system.to_string(),
            brief: brief.to_string(),
            viewport: desktop(),
            created_at: now,
            session: None,
            pages: BTreeMap::new(),
        };
        let written = (|| -> Result<()> {
            for folder in ["pages", "assets", "history"] {
                std::fs::create_dir(dir.join(folder))
                    .with_context(|| format!("cannot create {folder} in {}", dir.display()))?;
            }
            fsx::write_inside(&dir, &dir.join("comments.json"), b"[]\n")?;
            fsx::write_inside(
                &dir,
                &dir.join(DESIGN_FILE),
                toml::to_string(&config)?.as_bytes(),
            )
        })();
        // A creation that fails leaves nothing behind, so its name is free again.
        if let Err(e) = written {
            let _ = fsx::remove_dir_inside(&designs, &dir);
            return Err(e);
        }
        Ok(slug)
    }

    /// The workspace's designs, by name. A design whose `design.toml` cannot
    /// be read still lists, with its error, so it never hides the others.
    /// A workspace with no designs folder has none; a folder that is there
    /// but cannot be read fails the listing with the reason.
    pub fn designs(&self, workspace: &str) -> Result<Vec<DesignInfo>> {
        let folder = self.designs_dir(workspace, false)?;
        let entries = match std::fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e).with_context(|| format!("cannot read {}", folder.display())),
        };
        let mut out = Vec::new();
        for e in entries.flatten() {
            // A link is not a design, wherever it points.
            if !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let slug = e.file_name().to_string_lossy().into_owned();
            let dir = e.path();
            // A record that cannot be read lists as the design's error, as a
            // broken `design.toml` does, not as a design with no agent.
            let record = self
                .design_record(workspace, &slug)
                .context("cannot read the design's record");
            let agent = record.as_ref().ok().and_then(|r| r.agent);
            out.push(match read_design_config(&dir) {
                Ok(config) => DesignInfo {
                    error: record.err().map(|err| format!("{err:#}")),
                    ..summary(&dir, slug, &config, agent)
                },
                Err(err) => DesignInfo {
                    name: slug.clone(),
                    slug,
                    kind: DesignKind::Workspace,
                    system: String::new(),
                    path: dir.display().to_string(),
                    brief: String::new(),
                    viewport: String::new(),
                    pages: Vec::new(),
                    updated_at: 0,
                    open_comments: 0,
                    agent,
                    agent_state: None,
                    needs_you: None,
                    error: Some(format!("{err:#}")),
                },
            });
        }
        // By name, whatever its case, as the sidebar lists them.
        out.sort_by_key(|d| (d.name.to_lowercase(), d.slug.clone()));
        Ok(out)
    }

    /// What moonlet trusts about a design (see [`DesignRecord`]).
    pub fn design_record(&self, workspace: &str, slug: &str) -> Result<DesignRecord> {
        super::store::read_record(&self.design_record_path(workspace, slug)?)
    }

    fn design_record_path(&self, workspace: &str, slug: &str) -> Result<PathBuf> {
        if !super::store::is_name(slug) {
            bail!("bad design \"{slug}\"");
        }
        Ok(self
            .workspace(workspace)?
            .join(".records/designs")
            .join(format!("{slug}.toml")))
    }

    /// The folder of an existing design.
    pub fn design_dir(&self, workspace: &str, slug: &str) -> Result<PathBuf> {
        if !super::store::is_name(slug) {
            bail!("bad design \"{slug}\"");
        }
        let dir = self.designs_dir(workspace, false)?.join(slug);
        super::store::not_a_link(&dir)?;
        // Its own file: a link, which would take reads elsewhere, is not one.
        if !std::fs::symlink_metadata(dir.join(DESIGN_FILE)).is_ok_and(|m| m.is_file()) {
            bail!("no design \"{slug}\"");
        }
        Ok(dir)
    }

    /// A design's `design.toml`.
    pub fn design_config(&self, workspace: &str, slug: &str) -> Result<DesignConfig> {
        read_design_config(&self.design_dir(workspace, slug)?)
    }

    /// One design as `design.list` shows it.
    pub fn design(&self, workspace: &str, slug: &str) -> Result<DesignInfo> {
        let dir = self.design_dir(workspace, slug)?;
        let config = read_design_config(&dir)?;
        let agent = self.design_record(workspace, slug)?.agent;
        Ok(summary(&dir, slug.to_string(), &config, agent))
    }

    /// Records the chat of the design's agent, which removing it stops.
    pub fn set_design_agent(&self, workspace: &str, slug: &str, terminal: u32) -> Result<()> {
        self.design_dir(workspace, slug)?;
        let mut record = self.design_record(workspace, slug)?;
        record.agent = Some(terminal);
        let path = self.design_record_path(workspace, slug)?;
        // Replaced whole, so a reader never sees half of one.
        fsx::write_inside(
            &self.workspace(workspace)?,
            &path,
            toml::to_string(&record)?.as_bytes(),
        )
    }

    /// Forgets the design's agent: one whose start failed.
    pub fn clear_design_agent(&self, workspace: &str, slug: &str) -> Result<()> {
        self.design_dir(workspace, slug)?;
        let mut record = self.design_record(workspace, slug)?;
        record.agent = None;
        let path = self.design_record_path(workspace, slug)?;
        fsx::write_inside(
            &self.workspace(workspace)?,
            &path,
            toml::to_string(&record)?.as_bytes(),
        )
    }

    /// Saves the viewport the design was last shown at (`WxH`, in px) in its
    /// `design.toml`, leaving the rest of the file as the agent wrote it, also
    /// when the agent writes it while the viewport is saved.
    pub fn set_design_viewport(&self, workspace: &str, slug: &str, viewport: &str) -> Result<()> {
        if parse_viewport(viewport).is_none() {
            return Err(BadViewport(viewport.to_string()).into());
        }
        // An existing design, its folder no link.
        self.design_dir(workspace, slug)?;
        // Through the designs folder, so a design folder swapped for a link
        // after that check is not followed; and the agent may label a page
        // meanwhile: its edit is kept.
        let designs = self.designs_dir(workspace, false)?;
        fsx::update_inside(&designs, &Path::new(slug).join(DESIGN_FILE), |text| {
            let mut doc: toml_edit::DocumentMut = text
                .parse()
                .with_context(|| format!("cannot read {DESIGN_FILE}"))?;
            doc["viewport"] = toml_edit::value(viewport);
            Ok(doc.to_string())
        })
    }

    /// Deletes a design: its folder and its record.
    pub fn remove_design(&self, workspace: &str, slug: &str) -> Result<()> {
        let dir = self.design_dir(workspace, slug)?;
        let designs = self.designs_dir(workspace, false)?;
        // Through handles opened from the designs folder, so a folder swapped
        // for a link on the way is refused, not followed.
        fsx::remove_dir_inside(&designs, &dir)
            .with_context(|| format!("cannot remove {}", dir.display()))?;
        let _ = fsx::remove_file_inside(
            &self.workspace(workspace)?,
            &self.design_record_path(workspace, slug)?,
        );
        Ok(())
    }

    /// Checks a design's pages (X65): every element of each page's body has
    /// a `data-mid` of its own, and each links no stylesheet but its design
    /// system's `styles.css`. With `fix`, the missing and repeated ids get
    /// the next free numbers first, and the pages are saved.
    pub fn check_design(&self, workspace: &str, slug: &str, fix: bool) -> Result<Vec<Problem>> {
        let dir = self.design_dir(workspace, slug)?;
        let config = read_design_config(&dir)?;
        let styles = styles_link(&config.system);
        let mut problems = Vec::new();
        for (name, _) in pages(&dir) {
            let file = format!("{name}.html");
            let (rel, path) = (format!("pages/{file}"), dir.join("pages").join(&file));
            let mut html = fsx::read_inside(&dir, &path)?;
            if fix {
                let fixed = super::mid::fix_page(&html);
                if fixed != html {
                    fsx::write_inside(&dir, &path, fixed.as_bytes())?;
                    html = fixed;
                }
            }
            problems.extend(stylesheets(&rel, &html, &styles));
            problems.extend(super::mid::check_page(&rel, &html));
        }
        problems.sort_by(|a, b| (&a.path, a.line).cmp(&(&b.path, b.line)));
        Ok(problems)
    }

    /// `<workspace>/designs`, never through a link; with `create`, made
    /// (with the workspace's folder) when missing.
    fn designs_dir(&self, workspace: &str, create: bool) -> Result<PathBuf> {
        self.kind_dir(workspace, "designs", create)
    }
}

/// `WxH`, both whole px above 0.
fn parse_viewport(text: &str) -> Option<(u32, u32)> {
    let (w, h) = text.split_once('x')?;
    let px = |n: &str| {
        n.parse::<u32>()
            .ok()
            .filter(|v| *v > 0 && n.bytes().all(|b| b.is_ascii_digit()))
    };
    Some((px(w)?, px(h)?))
}

fn read_design_config(dir: &Path) -> Result<DesignConfig> {
    let text = fsx::read_inside(dir, &dir.join(DESIGN_FILE))?;
    toml::from_str(&text).with_context(|| format!("cannot read {DESIGN_FILE}"))
}

/// What the list shows of one design.
fn summary(dir: &Path, slug: String, config: &DesignConfig, agent: Option<u32>) -> DesignInfo {
    let pages = pages(dir);
    DesignInfo {
        slug,
        name: config.name.clone(),
        kind: DesignKind::Workspace,
        system: config.system.clone(),
        path: dir.display().to_string(),
        brief: config.brief.clone(),
        viewport: config.viewport.clone(),
        updated_at: pages
            .iter()
            .map(|(_, ms)| *ms)
            .max()
            .unwrap_or(config.created_at),
        pages: pages
            .into_iter()
            .map(|(name, _)| DesignPage {
                label: config
                    .pages
                    .get(&name)
                    .map(|p| p.label.clone())
                    .filter(|l| !l.is_empty()),
                name,
            })
            .collect(),
        open_comments: open_comments(dir),
        agent,
        agent_state: None,
        needs_you: None,
        error: None,
    }
}

/// A design's pages, `pages/<name>.html`, as their names and last changes in
/// ms: `index` first, then by name, so tabs keep their places.
fn pages(dir: &Path) -> Vec<(String, u64)> {
    let mut pages: Vec<(String, u64)> = std::fs::read_dir(dir.join("pages"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let name = e.file_name().to_str()?.strip_suffix(".html")?.to_string();
            let changed = e.metadata().ok()?.modified().ok()?;
            let ms = changed
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as u64;
            Some((name, ms))
        })
        .collect();
    pages.sort_by(|(a, _), (b, _)| (a != "index", a).cmp(&(b != "index", b)));
    pages
}

/// How a page in `pages/` links its design system's `styles.css`: relative,
/// so it loads from the host the page was framed on, whichever it is (X65).
pub fn styles_link(system: &str) -> String {
    format!("../../../systems/{system}/styles.css")
}

/// Each stylesheet a page links, or imports in its `<style>`, that is not
/// `styles` (X65).
fn stylesheets(path_rel: &str, html: &str, styles: &str) -> Vec<Problem> {
    let other = |line: usize, url: &str| Problem {
        path: path_rel.to_string(),
        line,
        kind: Kind::Stylesheet,
        message: format!("{url} is not the design system's styles.css: link {styles}"),
    };
    let found = std::cell::RefCell::new(Vec::new());
    let line_of = |byte: usize| html[..byte.min(html.len())].matches('\n').count() + 1;
    let settings = lol_html::Settings::new().append_element_content_handler(lol_html::element!(
        "link[rel][href]",
        |el| {
            let rel = el.get_attribute("rel").unwrap_or_default().to_lowercase();
            let href = el.get_attribute("href").unwrap_or_default();
            if rel.split_whitespace().any(|r| r == "stylesheet") && href != styles {
                found
                    .borrow_mut()
                    .push(other(line_of(el.source_location().bytes().start), &href));
            }
            Ok(())
        }
    ));
    let _ = lol_html::rewrite_str(html, settings);
    let mut found = found.into_inner();
    for (line, url) in super::check::style_imports(html) {
        if url != styles {
            found.push(other(line, &url));
        }
    }
    found
}

/// The pins of `comments.json` whose `state` is `open`; none when it cannot be read.
fn open_comments(dir: &Path) -> usize {
    fsx::read_inside(dir, &dir.join("comments.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<serde_json::Value>>(&t).ok())
        .map_or(0, |pins| {
            pins.iter().filter(|p| p["state"] == "open").count()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A workspace with one empty design system, `moonlet-desktop`.
    fn store_with_system() -> (tempfile::TempDir, Store) {
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
        (home, store)
    }

    #[test]
    fn a_new_design_gets_its_folder_and_design_toml_and_a_used_name_gets_a_number() {
        let (home, store) = store_with_system();
        let slug = store
            .create_design(
                "w1",
                "Settings page",
                "moonlet-desktop",
                "A settings page with General and Git sections",
                1_761_200_000_000,
            )
            .unwrap();
        assert_eq!(slug, "settings-page");
        let dir = home.path().join("design/w1/designs/settings-page");
        assert_eq!(
            std::fs::read_to_string(dir.join("design.toml")).unwrap(),
            "name = \"Settings page\"
system = \"moonlet-desktop\"
brief = \"A settings page with General and Git sections\"
viewport = \"1440x900\"
created_at = 1761200000000
"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("comments.json")).unwrap(),
            "[]\n"
        );
        for folder in ["pages", "assets", "history"] {
            assert!(dir.join(folder).is_dir(), "{folder}");
        }
        assert_eq!(
            store
                .create_design("w1", "Settings page", "moonlet-desktop", "Again", 2)
                .unwrap(),
            "settings-page-2"
        );
        let second = std::fs::read_to_string(
            home.path()
                .join("design/w1/designs/settings-page-2/design.toml"),
        )
        .unwrap();
        assert!(
            second.starts_with("name = \"Settings page 2\"\n"),
            "{second}"
        );
    }

    /// Sets the time `path` was last changed, in ms.
    fn touch(path: &Path, ms: u64) {
        let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(at)
            .unwrap();
    }

    #[test]
    fn a_workspace_lists_its_designs_with_their_pages_labels_and_last_change() {
        let (home, store) = store_with_system();
        store
            .create_design(
                "w1",
                "Settings page",
                "moonlet-desktop",
                "Settings",
                1_761_200_000_000,
            )
            .unwrap();
        store
            .create_design(
                "w1",
                "Onboarding",
                "moonlet-desktop",
                "Welcome",
                1_761_300_000_000,
            )
            .unwrap();
        let dir = home.path().join("design/w1/designs/settings-page");
        for page in ["git-b", "index", "git-a"] {
            std::fs::write(
                dir.join(format!("pages/{page}.html")),
                "<body data-mid=\"m1\"></body>",
            )
            .unwrap();
        }
        touch(&dir.join("pages/index.html"), 1_761_250_000_000);
        touch(&dir.join("pages/git-a.html"), 1_761_260_000_000);
        touch(&dir.join("pages/git-b.html"), 1_761_255_000_000);
        // Not a page: only `.html` files are.
        std::fs::write(dir.join("pages/notes.txt"), "x").unwrap();
        let text = std::fs::read_to_string(dir.join("design.toml")).unwrap();
        std::fs::write(
            dir.join("design.toml"),
            format!("{text}\n[pages.index]\nlabel = \"rows\"\n\n[pages.git-a]\nlabel = \"cards\"\n\n[pages.gone]\nlabel = \"no file\"\n"),
        )
        .unwrap();
        std::fs::write(
            dir.join("comments.json"),
            r#"[{"n": 1, "state": "open"}, {"n": 2, "state": "resolved"}, {"n": 3, "state": "open"}]"#,
        )
        .unwrap();
        let page = |name: &str, label: Option<&str>| DesignPage {
            name: name.into(),
            label: label.map(String::from),
        };
        assert_eq!(
            store.designs("w1").unwrap(),
            vec![
                DesignInfo {
                    slug: "onboarding".into(),
                    name: "Onboarding".into(),
                    kind: DesignKind::Workspace,
                    system: "moonlet-desktop".into(),
                    path: home
                        .path()
                        .join("design/w1/designs/onboarding")
                        .display()
                        .to_string(),
                    brief: "Welcome".into(),
                    viewport: "1440x900".into(),
                    pages: vec![],
                    updated_at: 1_761_300_000_000,
                    open_comments: 0,
                    agent: None,
                    agent_state: None,
                    needs_you: None,
                    error: None,
                },
                DesignInfo {
                    slug: "settings-page".into(),
                    name: "Settings page".into(),
                    kind: DesignKind::Workspace,
                    system: "moonlet-desktop".into(),
                    path: dir.display().to_string(),
                    brief: "Settings".into(),
                    viewport: "1440x900".into(),
                    pages: vec![
                        page("index", Some("rows")),
                        page("git-a", Some("cards")),
                        page("git-b", None)
                    ],
                    updated_at: 1_761_260_000_000,
                    open_comments: 2,
                    agent: None,
                    agent_state: None,
                    needs_you: None,
                    error: None,
                },
            ]
        );
        // A workspace with no designs yet lists none.
        assert_eq!(store.designs("w2").unwrap(), vec![]);
    }

    #[test]
    fn a_designs_viewport_is_saved_in_its_design_toml_and_listed_with_its_brief() {
        let (home, store) = store_with_system();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "A left nav", 1)
            .unwrap();
        let file = home
            .path()
            .join("design/w1/designs/settings-page/design.toml");
        // The agent labelled a page, with a comment of its own.
        let text = std::fs::read_to_string(&file).unwrap();
        std::fs::write(
            &file,
            format!("{text}\n# variants\n[pages.index]\nlabel = \"rows\"\n"),
        )
        .unwrap();
        store
            .set_design_viewport("w1", "settings-page", "390x844")
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "name = \"Settings page\"
system = \"moonlet-desktop\"
brief = \"A left nav\"
viewport = \"390x844\"
created_at = 1

# variants
[pages.index]
label = \"rows\"
"
        );
        let listed = &store.designs("w1").unwrap()[0];
        assert_eq!(
            (listed.brief.as_str(), listed.viewport.as_str()),
            ("A left nav", "390x844")
        );
        // Only a width and a height in px are a viewport.
        for bad in ["phone", "0x844", "390x", "390x844x2", "-1x5"] {
            assert!(
                store
                    .set_design_viewport("w1", "settings-page", bad)
                    .is_err(),
                "{bad}"
            );
        }
        assert!(store.set_design_viewport("w1", "nope", "390x844").is_err());
    }

    #[test]
    fn a_label_the_agent_writes_while_the_viewport_is_saved_is_kept() {
        let (home, store) = store_with_system();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        let file = home
            .path()
            .join("design/w1/designs/settings-page/design.toml");
        // The agent labels a page after the save read the file, before it
        // replaced it.
        let agent = file.clone();
        fsx::BEFORE_REPLACE.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                let text = std::fs::read_to_string(&agent).unwrap();
                std::fs::write(&agent, format!("{text}\n[pages.index]\nlabel = \"rows\"\n"))
                    .unwrap();
            }))
        });
        store
            .set_design_viewport("w1", "settings-page", "390x844")
            .unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("viewport = \"390x844\""), "{text}");
        assert!(text.contains("[pages.index]\nlabel = \"rows\""), "{text}");
    }

    #[test]
    fn a_viewport_save_never_writes_through_a_design_folder_swapped_for_a_link() {
        let (home, store) = store_with_system();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = "name = \"Theirs\"\nsystem = \"x\"\nviewport = \"1440x900\"\n";
        std::fs::write(outside.path().join("design.toml"), theirs).unwrap();
        let designs = home.path().join("design/w1/designs");
        // A design folder that is a link is refused outright.
        std::os::unix::fs::symlink(outside.path(), designs.join("linked")).unwrap();
        assert!(
            store
                .set_design_viewport("w1", "linked", "390x844")
                .is_err()
        );
        // One swapped for a link after the save found it is not followed.
        let (dir, target) = (designs.join("settings-page"), outside.path().to_path_buf());
        let moved = designs.join(".moved");
        fsx::BEFORE_REPLACE.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                std::fs::rename(&dir, &moved).unwrap();
                std::os::unix::fs::symlink(&target, &dir).unwrap();
            }))
        });
        let _ = store.set_design_viewport("w1", "settings-page", "390x844");
        assert_eq!(
            std::fs::read_to_string(outside.path().join("design.toml")).unwrap(),
            theirs
        );
    }

    #[test]
    fn a_design_whose_design_toml_cannot_be_read_lists_with_its_error_beside_the_others() {
        let (home, store) = store_with_system();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        store
            .create_design("w1", "Broken", "moonlet-desktop", "", 2)
            .unwrap();
        std::fs::write(
            home.path().join("design/w1/designs/broken/design.toml"),
            "name = \n",
        )
        .unwrap();
        let list = store.designs("w1").unwrap();
        let seen: Vec<(&str, &str, bool)> = list
            .iter()
            .map(|d| (d.slug.as_str(), d.name.as_str(), d.error.is_some()))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("broken", "broken", true),
                ("settings-page", "Settings page", false)
            ]
        );
        assert!(
            list[0]
                .error
                .as_deref()
                .unwrap()
                .starts_with("cannot read design.toml"),
            "{:?}",
            list[0].error
        );
    }

    #[test]
    fn a_design_whose_record_cannot_be_read_lists_with_its_error_beside_the_others() {
        let (home, store) = store_with_system();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        store
            .create_design("w1", "Pricing", "moonlet-desktop", "", 2)
            .unwrap();
        store.set_design_agent("w1", "pricing", 7).unwrap();
        std::fs::write(
            home.path().join("design/w1/.records/designs/pricing.toml"),
            "agent = \n",
        )
        .unwrap();
        let list = store.designs("w1").unwrap();
        let seen: Vec<(&str, &str, Option<u32>, bool)> = list
            .iter()
            .map(|d| (d.slug.as_str(), d.name.as_str(), d.agent, d.error.is_some()))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("pricing", "Pricing", None, true),
                ("settings-page", "Settings page", None, false)
            ]
        );
        assert!(
            list[0]
                .error
                .as_deref()
                .unwrap()
                .starts_with("cannot read the design's record"),
            "{:?}",
            list[0].error
        );
    }

    #[test]
    fn a_designs_folder_that_cannot_be_read_fails_the_listing_with_its_reason() {
        use std::os::unix::fs::PermissionsExt;
        let (home, store) = store_with_system();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        let designs = home.path().join("design/w1/designs");
        std::fs::set_permissions(&designs, std::fs::Permissions::from_mode(0o000)).unwrap();
        let listed = store.designs("w1");
        std::fs::set_permissions(&designs, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = format!("{:#}", listed.unwrap_err());
        assert!(
            err.starts_with(&format!("cannot read {}", designs.display()))
                && err.contains("Permission denied"),
            "{err}"
        );
    }

    #[test]
    fn a_design_toml_written_before_its_newer_fields_still_loads() {
        let (home, store) = store_with_system();
        let dir = home.path().join("design/w1/designs/pricing");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("design.toml"),
            "name = \"Pricing\"\nsystem = \"moonlet-desktop\"\n",
        )
        .unwrap();
        let list = store.designs("w1").unwrap();
        assert_eq!(
            (
                list[0].name.as_str(),
                list[0].system.as_str(),
                &list[0].pages,
                list[0].updated_at,
                &list[0].error
            ),
            ("Pricing", "moonlet-desktop", &vec![], 0, &None)
        );
        assert_eq!(
            store.design_config("w1", "pricing").unwrap(),
            DesignConfig {
                name: "Pricing".into(),
                system: "moonlet-desktop".into(),
                brief: String::new(),
                viewport: "1440x900".into(),
                created_at: 0,
                session: None,
                pages: BTreeMap::new(),
            }
        );
    }

    #[test]
    fn a_design_needs_a_design_system_the_workspace_has() {
        let (home, store) = store_with_system();
        let e = store
            .create_design("w1", "Settings page", "storefront", "", 1)
            .unwrap_err();
        assert_eq!(format!("{e}"), "no design system \"storefront\"");
        assert!(!home.path().join("design/w1/designs/settings-page").exists());
    }

    #[test]
    fn removing_a_design_deletes_its_folder_and_record_and_leaves_the_others() {
        let (home, store) = store_with_system();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        store
            .create_design("w1", "Onboarding", "moonlet-desktop", "", 2)
            .unwrap();
        store.set_design_agent("w1", "settings-page", 7).unwrap();
        assert_eq!(
            store.design_record("w1", "settings-page").unwrap().agent,
            Some(7)
        );
        store.remove_design("w1", "settings-page").unwrap();
        assert!(!home.path().join("design/w1/designs/settings-page").exists());
        assert!(
            !home
                .path()
                .join("design/w1/.records/designs/settings-page.toml")
                .exists()
        );
        let left: Vec<String> = store
            .designs("w1")
            .unwrap()
            .into_iter()
            .map(|d| d.slug)
            .collect();
        assert_eq!(left, vec!["onboarding"]);
        // A design that is not there, or a name that is no folder's, is refused.
        assert!(store.remove_design("w1", "settings-page").is_err());
        assert!(store.remove_design("w1", "../systems").is_err());
    }

    #[test]
    fn checking_a_design_reports_ids_and_stylesheets_and_fix_gives_the_missing_ids() {
        let (home, store) = store_with_system();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        let pages = home.path().join("design/w1/designs/settings-page/pages");
        std::fs::write(
            pages.join("index.html"),
            "<!doctype html>
<html><head><link rel=\"stylesheet\" href=\"../../../systems/moonlet-desktop/styles.css\"></head>
<body data-mid=\"m1\">
<main data-mid=\"m2\"><h1>Settings</h1></main>
</body></html>
",
        )
        .unwrap();
        std::fs::write(
            pages.join("git-a.html"),
            "<!doctype html>
<html><head><link rel=\"stylesheet\" href=\"https://cdn.example.com/kit.css\">
<link rel=\"stylesheet\" href=\"../../../systems/storefront/styles.css\"><link rel=\"icon\" href=\"x.png\"></head>
<body data-mid=\"m1\"><p data-mid=\"m1\">Git</p></body></html>
",
        )
        .unwrap();
        let seen = |problems: Vec<Problem>| -> Vec<(String, usize, Kind, String)> {
            problems
                .into_iter()
                .map(|p| (p.path, p.line, p.kind, p.message))
                .collect()
        };
        let other = "is not the design system's styles.css: link ../../../systems/moonlet-desktop/styles.css";
        assert_eq!(
            seen(store.check_design("w1", "settings-page", false).unwrap()),
            vec![
                (
                    "pages/git-a.html".into(),
                    2,
                    Kind::Stylesheet,
                    format!("https://cdn.example.com/kit.css {other}")
                ),
                (
                    "pages/git-a.html".into(),
                    3,
                    Kind::Stylesheet,
                    format!("../../../systems/storefront/styles.css {other}")
                ),
                (
                    "pages/git-a.html".into(),
                    4,
                    Kind::DuplicateMid,
                    "<p> repeats data-mid=\"m1\"".into()
                ),
                (
                    "pages/index.html".into(),
                    4,
                    Kind::MissingMid,
                    "<h1> has no data-mid".into()
                ),
            ]
        );
        // The check alone changes nothing; the fix numbers the ids and leaves
        // what it cannot fix.
        assert!(
            !std::fs::read_to_string(pages.join("index.html"))
                .unwrap()
                .contains("m3")
        );
        assert_eq!(
            seen(store.check_design("w1", "settings-page", true).unwrap()),
            vec![
                (
                    "pages/git-a.html".into(),
                    2,
                    Kind::Stylesheet,
                    format!("https://cdn.example.com/kit.css {other}")
                ),
                (
                    "pages/git-a.html".into(),
                    3,
                    Kind::Stylesheet,
                    format!("../../../systems/storefront/styles.css {other}")
                ),
            ]
        );
        assert!(
            std::fs::read_to_string(pages.join("index.html"))
                .unwrap()
                .contains("<main data-mid=\"m2\"><h1 data-mid=\"m3\">Settings</h1></main>")
        );
        assert!(
            std::fs::read_to_string(pages.join("git-a.html"))
                .unwrap()
                .contains("<body data-mid=\"m1\"><p data-mid=\"m2\">Git</p></body>")
        );
    }

    #[test]
    fn a_page_that_imports_another_stylesheet_in_its_style_is_reported_like_a_link() {
        let (home, store) = store_with_system();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        let pages = home.path().join("design/w1/designs/settings-page/pages");
        std::fs::write(
            pages.join("index.html"),
            "<html><head><style>
@import \"../../../systems/moonlet-desktop/styles.css\";
@import url('https://fonts.example.com/inter.css');
/* @import \"commented.css\"; */
.x { color: red }
</style></head>
<body data-mid=\"m1\"></body></html>
",
        )
        .unwrap();
        let got: Vec<(String, usize, Kind, String)> = store
            .check_design("w1", "settings-page", false)
            .unwrap()
            .into_iter()
            .map(|p| (p.path, p.line, p.kind, p.message))
            .collect();
        assert_eq!(
            got,
            vec![(
                "pages/index.html".into(),
                3,
                Kind::Stylesheet,
                "https://fonts.example.com/inter.css is not the design system's styles.css: link ../../../systems/moonlet-desktop/styles.css".into()
            )]
        );
    }

    #[test]
    fn an_import_whose_url_is_on_the_next_line_is_reported_on_the_line_of_its_import() {
        let (home, store) = store_with_system();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        let pages = home.path().join("design/w1/designs/settings-page/pages");
        std::fs::write(
            pages.join("index.html"),
            "<html><head>
<link rel=\"stylesheet\" href=\"../../../systems/moonlet-desktop/styles.css\">
<style>
.x { color: red }
@import
  url(\"https://fonts.example.com/inter.css\");
</style></head>
<body data-mid=\"m1\"></body></html>
",
        )
        .unwrap();
        let got: Vec<(String, usize, Kind, String)> = store
            .check_design("w1", "settings-page", false)
            .unwrap()
            .into_iter()
            .map(|p| (p.path, p.line, p.kind, p.message))
            .collect();
        assert_eq!(
            got,
            vec![(
                "pages/index.html".into(),
                5,
                Kind::Stylesheet,
                "https://fonts.example.com/inter.css is not the design system's styles.css: link ../../../systems/moonlet-desktop/styles.css".into()
            )]
        );
    }

    #[test]
    fn an_import_with_no_space_before_its_url_is_reported() {
        let (home, store) = store_with_system();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        let pages = home.path().join("design/w1/designs/settings-page/pages");
        std::fs::write(
            pages.join("index.html"),
            "<html><head>
<link rel=\"stylesheet\" href=\"../../../systems/moonlet-desktop/styles.css\">
<style>@import\"https://cdn.example.com/kit.css\";@import'x.css';
@importurl(https://fonts.example.com/inter.css);</style>
</head>
<body data-mid=\"m1\"></body></html>
",
        )
        .unwrap();
        let got: Vec<(usize, String)> = store
            .check_design("w1", "settings-page", false)
            .unwrap()
            .into_iter()
            .map(|p| (p.line, p.message))
            .collect();
        assert_eq!(
            got,
            vec![
                (3, "https://cdn.example.com/kit.css is not the design system's styles.css: link ../../../systems/moonlet-desktop/styles.css".into()),
                (3, "x.css is not the design system's styles.css: link ../../../systems/moonlet-desktop/styles.css".into()),
                (4, "https://fonts.example.com/inter.css is not the design system's styles.css: link ../../../systems/moonlet-desktop/styles.css".into()),
            ]
        );
    }

    #[test]
    fn an_import_written_as_text_outside_a_style_is_not_reported() {
        let (home, store) = store_with_system();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        let pages = home.path().join("design/w1/designs/settings-page/pages");
        std::fs::write(
            pages.join("index.html"),
            "<html><head>
<link rel=\"stylesheet\" href=\"../../../systems/moonlet-desktop/styles.css\">
<script>const tip = \"@import 'https://cdn.example.com/kit.css';\";</script>
</head>
<body data-mid=\"m1\">
<p data-mid=\"m2\">Fonts load with @import url(https://fonts.example.com/inter.css).</p>
<pre data-mid=\"m3\"><code data-mid=\"m4\">@import \"https://cdn.example.com/theme.css\";</code></pre>
</body></html>
",
        )
        .unwrap();
        assert_eq!(
            store.check_design("w1", "settings-page", false).unwrap(),
            vec![]
        );
    }
}
