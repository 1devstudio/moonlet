//! Where design systems live (X64, ADR 0013): `~/.moonlet/design/<workspace
//! id>/systems/<slug>/`. What the sync agent may edit is in the system's
//! folder, `config.toml` among it; what moonlet trusts (the source folders,
//! the commits of the last sync, the agent's chat) is in
//! `<workspace>/.records/<slug>.toml`, outside the agent's reach.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use moonlet_proto::types::ProjectIdentity;
use serde::{Deserialize, Serialize};

use super::check;
use super::{anchor, card, foundations, fsx, manifest, readme};

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

/// `config.toml`, which the sync agent may edit (the scope, per-card settings).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemConfig {
    pub name: String,
    pub created_at: u64,
    /// What the user chose to cover when creating it, so the agent does not ask.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<Cover>,
    /// Per-card settings, by card path.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub cards: BTreeMap<String, CardSettings>,
}

/// What a design system covers (X64).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cover {
    /// The 20 to 40 components that matter most.
    Core,
    All,
    /// None yet: honest floor cards only.
    None,
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

/// What moonlet trusts about a design system, kept where its agent cannot
/// write: the sync agent's `--add-dir` folders and deny rules come from here,
/// and Sync sends its prompt only to the chat named here.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_at: Option<u64>,
    /// The chat of its sync agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<u32>,
    /// What that chat was started with (its folders and settings): it is
    /// reused only while a new start would be the same.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_launch: Option<String>,
    /// The cards the last sync changed, for "Changed by this sync".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub last_sync: Vec<SyncChange>,
    /// The cards as they were when the sync not yet recorded started
    /// ([`Store::begin_sync`]): its changes are told against them, so a card
    /// the user changed before it is not among them. Kept until the sync is
    /// recorded, so a retry after it stopped midway still knows them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_start: Option<BTreeMap<String, anchor::CardRender>>,
    /// The orphaned cards the user keeps for now: not asked about again
    /// while they stay orphaned. A sync drops each one that is no longer
    /// orphaned or no longer there, and removing a card drops it.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub kept: BTreeSet<String>,
}

/// One card a sync changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncChange {
    pub path: String,
    /// `new`, `rewritten` or `removed`.
    pub change: String,
    /// The source files it was made from.
    pub sources: Vec<String>,
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

    /// `~/.moonlet/design`, created when missing.
    pub fn root(&self) -> Result<&Path> {
        crate::paths::ensure_private_dir(&self.root)?;
        Ok(&self.root)
    }

    /// Creates a design system and returns its slug. A name already used in
    /// the workspace gets a ` 2` (` 3`, …) suffix.
    pub fn create_system(
        &self,
        workspace: &str,
        name: &str,
        sources: Vec<Source>,
        cover: Cover,
        now: u64,
    ) -> Result<String> {
        let systems = self.systems_dir(workspace, true)?;
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
            cover: Some(cover),
            cards: BTreeMap::new(),
        };
        let dir = systems.join(&slug);
        let written = fsx::write_inside(
            &dir,
            &dir.join(CONFIG),
            toml::to_string(&config)?.as_bytes(),
        )
        .and_then(|()| {
            self.write_record(
                workspace,
                &slug,
                &Record {
                    sources,
                    ..Record::default()
                },
            )
        });
        // A creation that fails leaves nothing behind, so its name is free
        // again and no hidden half-made folder stays.
        if let Err(e) = written {
            let _ = fsx::remove_dir_inside(&systems, &dir);
            if let Ok(record) = self.record_path(workspace, &slug) {
                let _ = std::fs::remove_file(record);
            }
            return Err(e);
        }
        Ok(slug)
    }

    /// The workspace's design systems, by name.
    pub fn systems(&self, workspace: &str) -> Result<Vec<SystemSummary>> {
        let Ok(entries) = std::fs::read_dir(self.systems_dir(workspace, false)?) else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for e in entries.flatten() {
            // A link is not a system, wherever it points.
            if !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let dir = e.path();
            let Ok(config) = read_config(&dir) else {
                continue;
            };
            let slug = e.file_name().to_string_lossy().into_owned();
            // A system that cannot be read still lists, with its error, so
            // one broken folder never hides the others.
            let (record, read) = match self.record(workspace, &slug) {
                Ok(r) => (r, Ok(())),
                Err(e) => (Record::default(), Err(e.context("cannot read its record"))),
            };
            out.push(
                read.and_then(|()| summary(&dir, slug.clone(), &config, &record))
                    .unwrap_or_else(|err| SystemSummary {
                        slug,
                        name: config.name.clone(),
                        sources: record.sources.iter().map(|s| s.path.clone()).collect(),
                        synced_at: record.synced_at,
                        synced_commit: record.sources.first().and_then(|s| s.commit.clone()),
                        cards: 0,
                        layouts: 0,
                        changed_sources: Vec::new(),
                        check_problems: 0,
                        to_settle: 0,
                        step: None,
                        step_summary: None,
                        steps: Vec::new(),
                        error: Some(format!("{err:#}")),
                        agent: record.agent,
                        last_sync: record.last_sync.clone(),
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
        let dir = self.systems_dir(workspace, false)?.join(slug);
        not_a_link(&dir)?;
        // Its own file: a link, which would take reads and writes elsewhere,
        // is not one.
        if !std::fs::symlink_metadata(dir.join(CONFIG)).is_ok_and(|m| m.is_file()) {
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
        // Through handles opened from the design folder, so a folder swapped
        // for a link on the way is refused, not followed.
        fsx::remove_dir_inside(&self.root, &dir)
            .with_context(|| format!("cannot remove {}", dir.display()))?;
        let _ = fsx::remove_file_inside(&self.root, &self.record_path(workspace, slug)?);
        Ok(())
    }

    /// What moonlet trusts about a system (see [`Record`]).
    pub fn record(&self, workspace: &str, slug: &str) -> Result<Record> {
        let path = self.record_path(workspace, slug)?;
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(toml::from_str(&text)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Record::default()),
            Err(e) => Err(e).with_context(|| format!("cannot read {}", path.display())),
        }
    }

    /// A new file renamed over the old record: a write cut short leaves the
    /// old record whole, and a reader never sees half of one.
    fn write_record(&self, workspace: &str, slug: &str, record: &Record) -> Result<()> {
        let path = self.record_path(workspace, slug)?;
        fsx::write_inside(
            &self.workspace(workspace)?,
            &path,
            toml::to_string(record)?.as_bytes(),
        )
    }

    fn record_path(&self, workspace: &str, slug: &str) -> Result<PathBuf> {
        if !is_name(slug) {
            bail!("bad design system \"{slug}\"");
        }
        Ok(self
            .workspace(workspace)?
            .join(".records")
            .join(format!("{slug}.toml")))
    }

    /// The chat of the system's sync agent, kept for the app's Open agent
    /// and across daemon restarts (chats restore themselves).
    pub fn set_agent(
        &self,
        workspace: &str,
        slug: &str,
        terminal: u32,
        launch: &str,
    ) -> Result<()> {
        self.system_dir(workspace, slug)?;
        let mut record = self.record(workspace, slug)?;
        record.agent = Some(terminal);
        record.agent_launch = Some(launch.to_string());
        self.write_record(workspace, slug, &record)
    }

    pub fn agent(&self, workspace: &str, slug: &str) -> Result<Option<u32>> {
        Ok(self.record(workspace, slug)?.agent)
    }

    /// The recorded agent, when it was started with `launch`.
    pub fn agent_for(&self, workspace: &str, slug: &str, launch: &str) -> Result<Option<u32>> {
        let record = self.record(workspace, slug)?;
        Ok(record
            .agent
            .filter(|_| record.agent_launch.as_deref() == Some(launch)))
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
        // The steps before this one stay; this one is replaced, and any after
        // it go (a sync that starts over).
        let at = step_index(step);
        let mut p = read_progress(&dir);
        p.steps.retain(|r| step_index(&r.step) < at);
        p.steps.push(StepReport {
            step: step.into(),
            summary: summary.map(String::from),
        });
        fsx::write_inside(&dir, &dir.join(PROGRESS), toml::to_string(&p)?.as_bytes())?;
        Ok(())
    }

    /// Records a finished sync: each source's commit, the time, and the
    /// anchor. Either both the record and the anchor say the sync is done, or
    /// neither does and its progress stays.
    pub fn synced(
        &self,
        workspace: &str,
        slug: &str,
        commits: &[(String, Option<String>)],
        now: u64,
    ) -> Result<()> {
        let dir = self.system_dir(workspace, slug)?;
        let config = read_config(&dir)?;
        let old = self.record(workspace, slug)?;
        // The anchor is worked out first: reading every card and source is
        // what usually fails, and then nothing is written.
        let anchor = anchor::compute(&dir, &source_roots(&old), &config.exceptions())?;
        let mut record = old.clone();
        // What the sync changed: against the cards as they were when it
        // started, or, with no start recorded, as the last anchor has them.
        let before = record.sync_start.take().unwrap_or_else(|| {
            anchor::read(&dir)
                .map(|a| {
                    a.cards
                        .into_iter()
                        .map(|(path, c)| {
                            let render = anchor::CardRender {
                                render_hash: c.render_hash,
                                companion_hash: c.companion_hash,
                                sources: c.sources.into_keys().collect(),
                            };
                            (path, render)
                        })
                        .collect()
                })
                .unwrap_or_default()
        });
        record.last_sync = sync_changes(&before, &anchor);
        for s in &mut record.sources {
            if let Some((_, c)) = commits.iter().find(|(p, _)| *p == s.project) {
                // A HEAD that could not be read leaves no commit, not a stale one.
                s.commit = c.clone();
            }
        }
        record.synced_at = Some(now);
        record
            .kept
            .retain(|card| anchor.cards.get(card).is_some_and(|c| c.orphaned()));
        // Then the record, and the anchor last; an anchor that cannot be
        // written puts the old record back. Both are replaced whole.
        self.write_record(workspace, slug, &record)?;
        if let Err(e) = anchor::save(&dir, &anchor) {
            let _ = self.write_record(workspace, slug, &old);
            return Err(e);
        }
        let _ = fsx::remove_file_inside(&dir, &dir.join(PROGRESS));
        Ok(())
    }

    /// Records that a sync starts: the cards as they are now, which the
    /// changes [`Store::synced`] records are told against. A start while an
    /// earlier one is not yet recorded (a build or sync asked for again)
    /// keeps the earlier cards, so nothing that sync changed is lost.
    pub fn begin_sync(&self, workspace: &str, slug: &str) -> Result<()> {
        let dir = self.system_dir(workspace, slug)?;
        let mut record = self.record(workspace, slug)?;
        if record.sync_start.is_some() {
            return Ok(());
        }
        record.sync_start = Some(anchor::renders(&dir)?);
        self.write_record(workspace, slug, &record)
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

    /// A design system's cards for the design system view and the card page
    /// (X64): each as its marker says, with its check problems (its own
    /// files' too: a component's `.css` and `.prompt.md`) and the sources
    /// changed since the last sync. A card whose marker does not parse is
    /// listed in the group "Without a marker", with its problem. Sorted by
    /// group and name.
    pub fn cards(&self, workspace: &str, slug: &str) -> Result<Vec<CardInfo>> {
        let dir = self.system_dir(workspace, slug)?;
        let config = read_config(&dir)?;
        let record = self.record(workspace, slug)?;
        let mut problems = check::check(&dir)?;
        let status = anchor::status(&dir, &source_roots(&record), &config.exceptions())?;
        let files: BTreeSet<String> = check::files(&dir)
            .iter()
            .map(|f| check::rel(&dir, f))
            .collect();
        let mut out = Vec::new();
        for file in check::html_files(&dir) {
            let path = check::rel(&dir, &file);
            if !check::CARD_DIRS
                .iter()
                .any(|d| path.starts_with(&format!("{d}/")))
                || path.ends_with(".proposed.html")
            {
                continue;
            }
            let text = fsx::read_inside(&dir, &file)?;
            let stem = file
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let (group, name, viewport, source) = match card::parse_marker(&text) {
                Ok(m) => (m.group, m.name.unwrap_or(stem), m.viewport, m.source),
                Err(_) => ("Without a marker".to_string(), stem, (900, 700), Vec::new()),
            };
            // A component card's own `.css` and `.prompt.md`, beside it, are
            // its files too; nothing else in its folder is.
            let own: Vec<String> = match path.strip_suffix(".html") {
                Some(stem) if path.starts_with("components/") => {
                    vec![format!("{stem}.css"), format!("{stem}.prompt.md")]
                }
                _ => Vec::new(),
            };
            let (mine, rest): (Vec<_>, Vec<_>) = problems
                .into_iter()
                .partition(|p| p.path == path || own.contains(&p.path));
            problems = rest;
            let st = status.iter().find(|s| s.path == path);
            let changed_sources = st.map(|s| s.changed_sources.clone()).unwrap_or_default();
            // The sync's version of each of its files, beside it.
            let base = &path[..path.len() - ".html".len()];
            let mut proposals: Vec<String> = PROPOSED
                .iter()
                .map(|ext| format!("{base}.proposed.{ext}"))
                .filter(|p| files.contains(p))
                .collect();
            proposals.sort();
            let orphaned = st.is_some_and(|s| s.orphaned);
            let kept = orphaned && record.kept.contains(&path);
            out.push(CardInfo {
                group,
                name,
                path,
                viewport,
                source,
                snippets: card::snippets(&text),
                marker: text.lines().next().unwrap_or_default().to_string(),
                problems: mine,
                changed_sources,
                proposals,
                edited_by_hand: st.is_some_and(|s| s.edited_by_hand),
                orphaned,
                kept,
            });
        }
        out.sort_by(|a, b| (&a.group, &a.name).cmp(&(&b.group, &b.name)));
        Ok(out)
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
        // Through handles opened from the system's folder: nothing lands
        // outside it, whatever links are in the way.
        let path = dir.join(card);
        let folder = path.parent().unwrap_or(&dir).to_path_buf();
        // The sync's version of each of the card's files it changed, beside
        // the file it would replace: settled together.
        let stem = card[..card.len() - ".html".len()]
            .rsplit('/')
            .next()
            .unwrap_or("");
        let proposals: Vec<(PathBuf, PathBuf)> = PROPOSED
            .iter()
            .map(|ext| {
                (
                    folder.join(format!("{stem}.proposed.{ext}")),
                    folder.join(format!("{stem}.{ext}")),
                )
            })
            .collect();
        match choice {
            Settle::Mine => {
                for (proposed, _) in &proposals {
                    fsx::remove_file_inside(&dir, proposed)?;
                }
            }
            Settle::Synced => {
                let mut took = false;
                for (proposed, live) in &proposals {
                    took |= fsx::rename_inside(&dir, proposed, live)?;
                }
                if !took {
                    bail!("{card} has no proposal to take");
                }
                // What the user took is what the sync made: the next look
                // finds it up to date, not edited by hand.
                anchor::take(&dir, card, &read_config(&dir)?.exceptions())?;
            }
            Settle::Remove => {
                if parts[0] == "components" {
                    fsx::remove_dir_inside(&dir, &folder)?;
                } else {
                    fsx::remove_file_inside(&dir, &path)?;
                    for (proposed, _) in &proposals {
                        fsx::remove_file_inside(&dir, proposed)?;
                    }
                }
                anchor::forget(&dir, card)?;
                let mut record = self.record(workspace, slug)?;
                if record.kept.remove(card) {
                    self.write_record(workspace, slug, &record)?;
                }
            }
            Settle::Keep => {
                let mut record = self.record(workspace, slug)?;
                let status = anchor::status(
                    &dir,
                    &source_roots(&record),
                    &read_config(&dir)?.exceptions(),
                )?;
                if !status.iter().any(|s| s.path == card && s.orphaned) {
                    bail!("{card} is not orphaned");
                }
                record.kept.insert(card.to_string());
                self.write_record(workspace, slug, &record)?;
            }
        }
        Ok(())
    }

    /// `~/.moonlet/design/<workspace>`, refusing an id that is not one folder
    /// name, and a folder that is a link (it would take writes elsewhere).
    fn workspace(&self, workspace: &str) -> Result<PathBuf> {
        if !is_name(workspace) {
            bail!("bad workspace id \"{workspace}\"");
        }
        crate::paths::ensure_private_dir(&self.root)?;
        let dir = self.root.join(workspace);
        not_a_link(&dir)?;
        Ok(dir)
    }

    /// `<workspace>/systems`, never through a link; with `create`, made
    /// (with the workspace's folder) when missing.
    fn systems_dir(&self, workspace: &str, create: bool) -> Result<PathBuf> {
        let ws = self.workspace(workspace)?;
        let systems = ws.join("systems");
        if create {
            for dir in [&ws, &systems] {
                match std::fs::create_dir(dir) {
                    Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => {
                        return Err(e).with_context(|| format!("cannot create {}", dir.display()));
                    }
                    _ => not_a_link(dir)?,
                }
            }
        }
        not_a_link(&systems)?;
        Ok(systems)
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
    /// Every step the running sync reported, in the order of [`STEPS`], each
    /// with its last summary; empty with no sync running.
    pub steps: Vec<StepReport>,
    /// Why the system could not be read, when it could not.
    pub error: Option<String>,
    /// The chat of its sync agent, once one was started.
    pub agent: Option<u32>,
    /// The cards the last sync changed.
    pub last_sync: Vec<SyncChange>,
}

/// Each source's folder: the repository, or its sub-folder when it names one.
/// Card sources are relative to it.
pub fn source_roots(record: &Record) -> Vec<PathBuf> {
    record
        .sources
        .iter()
        .map(|s| match &s.subdir {
            Some(sub) => Path::new(&s.path).join(sub),
            None => PathBuf::from(&s.path),
        })
        .collect()
}

/// A source's folder as a real path (no links): the project, or its
/// sub-folder, which must be a folder inside the project: named with no
/// `..` and not absolute, and not a link out of it. Sync agents get only
/// such folders.
pub fn source_root(source: &Source) -> Result<PathBuf> {
    use std::path::Component;
    let project = std::fs::canonicalize(&source.path)
        .with_context(|| format!("cannot reach {}", source.path))?;
    let Some(sub) = &source.subdir else {
        return Ok(project);
    };
    let outside = || anyhow::anyhow!("{sub} is not a folder inside {}", source.path);
    let plain = Path::new(sub)
        .components()
        .all(|c| matches!(c, Component::Normal(_)));
    if sub.is_empty() || !plain {
        return Err(outside());
    }
    let root = std::fs::canonicalize(project.join(sub)).map_err(|_| outside())?;
    if !root.starts_with(&project) || !root.is_dir() {
        return Err(outside());
    }
    Ok(root)
}

/// The cards that differ between `before` and the new anchor, by path.
fn sync_changes(
    before: &BTreeMap<String, anchor::CardRender>,
    after: &anchor::Anchor,
) -> Vec<SyncChange> {
    let (b, a) = (before, &after.cards);
    let mut out = Vec::new();
    for (path, now) in a {
        let change = match b.get(path) {
            None => "new",
            // Its HTML, or its `.css` or `.prompt.md` alone.
            Some(then)
                if then.render_hash != now.render_hash
                    || then.companion_hash != now.companion_hash =>
            {
                "rewritten"
            }
            Some(_) => continue,
        };
        out.push(SyncChange {
            path: path.clone(),
            change: change.into(),
            sources: now.sources.keys().cloned().collect(),
        });
    }
    for (path, then) in b.iter().filter(|(p, _)| !a.contains_key(*p)) {
        out.push(SyncChange {
            path: path.clone(),
            change: "removed".into(),
            sources: then.sources.clone(),
        });
    }
    out.sort_by(|x, y| x.path.cmp(&y.path));
    out
}

/// One card of a design system, as the app shows it (`design.cards`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CardInfo {
    pub group: String,
    pub name: String,
    /// Relative to the design system's folder.
    pub path: String,
    /// Width and height.
    pub viewport: (u32, u32),
    /// The source files it was made from, relative to their project.
    pub source: Vec<String>,
    /// Its snippets' ids, in page order.
    pub snippets: Vec<String>,
    /// Its `@dsCard` line.
    pub marker: String,
    pub problems: Vec<check::Problem>,
    /// Its sources changed since the last sync.
    pub changed_sources: Vec<String>,
    /// The sync's proposals beside it (`<name>.proposed.html`, `.css`,
    /// `.prompt.md`), relative to the design system's folder, sorted.
    pub proposals: Vec<String>,
    /// Its HTML, `.css` or `.prompt.md` changed since the sync.
    pub edited_by_hand: bool,
    /// Every one of its source files is gone.
    pub orphaned: bool,
    /// Orphaned, and kept for now: it waits for no choice.
    pub kept: bool,
}

/// What the list shows of one design system.
fn summary(
    dir: &Path,
    slug: String,
    config: &SystemConfig,
    record: &Record,
) -> Result<SystemSummary> {
    let steps = read_progress(dir).steps;
    let last = steps.last();
    let cards = manifest::build(dir)?.cards;
    let status = anchor::status(dir, &source_roots(record), &config.exceptions())?;
    let mut changed: Vec<String> = status
        .iter()
        .flat_map(|s| s.changed_sources.clone())
        .collect();
    changed.sort();
    changed.dedup();
    let proposed = proposed_cards(dir).len();
    Ok(SystemSummary {
        slug,
        name: config.name.clone(),
        sources: record.sources.iter().map(|s| s.path.clone()).collect(),
        synced_at: record.synced_at,
        synced_commit: record.sources.first().and_then(|s| s.commit.clone()),
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
        to_settle: proposed
            + status
                .iter()
                .filter(|s| s.orphaned && !record.kept.contains(&s.path))
                .count(),
        step: last.map(|r| r.step.clone()),
        step_summary: last.and_then(|r| r.summary.clone()),
        steps,
        error: None,
        agent: record.agent,
        last_sync: record.last_sync.clone(),
    })
}

/// The kinds of a card's files a sync may propose a new version of, as
/// `<name>.proposed.<kind>` beside `<name>.<kind>` (X64).
const PROPOSED: [&str; 3] = ["html", "css", "prompt.md"];

/// Each card with a proposal waiting to be settled, as its folder and name:
/// once, however many of its files are proposed.
fn proposed_cards(dir: &Path) -> std::collections::BTreeSet<PathBuf> {
    check::files(dir)
        .into_iter()
        .filter_map(|p| {
            let name = p.file_name()?.to_str()?;
            let stem = PROPOSED
                .iter()
                .find_map(|ext| name.strip_suffix(&format!(".proposed.{ext}")))?;
            Some(p.with_file_name(stem))
        })
        .collect()
}

/// What the user picks for a card under Needs you (X64).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Settle {
    /// Keep the card as edited by hand; drop every file the sync proposed.
    Mine,
    /// Replace each of the card's files with the sync's proposal of it.
    Synced,
    /// Delete an orphaned card.
    Remove,
    /// Leave an orphaned card until the next sync.
    Keep,
}

/// Refuses `dir` when it is there but not a folder of its own: a link
/// (even to a folder) or a file.
fn not_a_link(dir: &Path) -> Result<()> {
    match std::fs::symlink_metadata(dir) {
        Ok(m) if !m.is_dir() => bail!("{} is not a folder (a link is refused)", dir.display()),
        _ => Ok(()),
    }
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
    Ok(toml::from_str(&fsx::read_inside(dir, &dir.join(CONFIG))?)?)
}

/// The sync's steps, in order (X64).
pub const STEPS: [&str; 4] = ["inventory", "tokens", "cards", "layouts"];
const PROGRESS: &str = ".cache/progress.toml";

#[derive(Default, Serialize, Deserialize)]
struct Progress {
    #[serde(default)]
    steps: Vec<StepReport>,
}

/// One step a running sync reported, with its summary (X64).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepReport {
    pub step: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// The running sync's progress; none when it cannot be read.
fn read_progress(dir: &Path) -> Progress {
    fsx::read_inside(dir, &dir.join(PROGRESS))
        .ok()
        .and_then(|t| toml::from_str(&t).ok())
        .unwrap_or_default()
}

/// Where `step` comes in [`STEPS`]; an unknown one after them all.
fn step_index(step: &str) -> usize {
    STEPS.iter().position(|s| *s == step).unwrap_or(STEPS.len())
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

    // The app's New design system dialog shows the folder with the same
    // cases (apps/desktop/src/lib/design.test.ts).
    #[test]
    fn a_slug_is_lowercase_letters_and_digits_joined_by_dashes() {
        assert_eq!(slug("moonlet desktop"), "moonlet-desktop");
        assert_eq!(slug("  Moonlet Desktop! "), "moonlet-desktop");
        assert_eq!(slug("Café UI"), "caf-ui");
        assert_eq!(slug("App 2.0"), "app-2-0");
        assert_eq!(slug("---"), "design-system");
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
                    Cover::Core,
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
            "name = \"moonlet desktop\"\ncreated_at = 1761200000000\ncover = \"core\"\n"
        );
        // The sources are moonlet's, outside the folder the agent edits.
        assert_eq!(
            std::fs::read_to_string(
                home.path()
                    .join("design/w-1devstudio/.records/moonlet-desktop.toml")
            )
            .unwrap(),
            "[[sources]]
project = \"p-moonlet\"
path = \"/Users/alex/Workspace/1devstudio/moonlet\"

[sources.identity]
origin = \"github.com/1devstudio/moonlet\"
root = \"9c1e0a2\"
"
        );
        assert_eq!(
            store
                .create_system(
                    "w-1devstudio",
                    "moonlet desktop",
                    vec![source()],
                    Cover::Core,
                    1
                )
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
            .create_system("w1", "moonlet desktop", vec![src], Cover::Core, 5)
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
                steps: vec![],
                error: None,
                agent: None,
                last_sync: vec![
                    SyncChange {
                        path: "components/buttons/button/button.html".into(),
                        change: "new".into(),
                        sources: vec!["src/ui.tsx".into()]
                    },
                    SyncChange {
                        path: "components/custom/row/row.html".into(),
                        change: "new".into(),
                        sources: vec!["src/Sidebar.tsx".into()]
                    },
                    SyncChange {
                        path: "ui_kits/app/settings.html".into(),
                        change: "new".into(),
                        sources: vec![]
                    },
                ],
            }]
        );
        assert_eq!(store.systems("w-none").unwrap(), vec![]);
    }

    #[test]
    fn removing_a_system_deletes_its_folder_and_files_resolve_only_inside_the_workspace() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
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
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
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
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
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
    fn settling_a_card_takes_or_drops_its_proposed_html_css_and_prompt_together() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        let row = "components/custom/row/row.html";
        let mine = [
            (
                row,
                "<!-- @dsCard group=\"Custom\" -->\n<div class=\"row\">mine</div>\n",
            ),
            (
                "components/custom/row/row.css",
                ".row { color: var(--mine); }\n",
            ),
            (
                "components/custom/row/row.prompt.md",
                "A row, as I wrote it.\n",
            ),
        ];
        let proposals = [
            (
                "components/custom/row/row.proposed.html",
                "<!-- @dsCard group=\"Custom\" -->\n<div class=\"row\">synced</div>\n",
            ),
            (
                "components/custom/row/row.proposed.css",
                ".row { color: var(--synced); }\n",
            ),
            (
                "components/custom/row/row.proposed.prompt.md",
                "A row, as the code has it.\n",
            ),
        ];
        put(&dir, &mine);
        put(&dir, &proposals);
        assert_eq!(store.systems("w1").unwrap()[0].to_settle, 1, "one card");

        store.settle("w1", &slug, row, Settle::Mine).unwrap();
        for (path, text) in mine {
            assert_eq!(std::fs::read_to_string(dir.join(path)).unwrap(), text);
        }
        for (path, _) in proposals {
            assert!(!dir.join(path).exists(), "{path} left behind");
        }
        assert_eq!(store.systems("w1").unwrap()[0].to_settle, 0);

        put(&dir, &proposals);
        store.settle("w1", &slug, row, Settle::Synced).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(row)).unwrap(),
            "<!-- @dsCard group=\"Custom\" -->\n<div class=\"row\">synced</div>\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("components/custom/row/row.css")).unwrap(),
            ".row { color: var(--synced); }\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("components/custom/row/row.prompt.md")).unwrap(),
            "A row, as the code has it.\n"
        );
        for (path, _) in proposals {
            assert!(!dir.join(path).exists(), "{path} left behind");
        }

        // A sync that changed only the styling proposes only that.
        put(
            &dir,
            &[(
                "components/custom/row/row.proposed.css",
                ".row { color: red; }\n",
            )],
        );
        assert_eq!(store.systems("w1").unwrap()[0].to_settle, 1);
        store.settle("w1", &slug, row, Settle::Synced).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("components/custom/row/row.css")).unwrap(),
            ".row { color: red; }\n"
        );
        assert!(
            store.settle("w1", &slug, row, Settle::Synced).is_err(),
            "nothing left to take"
        );
    }

    #[test]
    fn an_orphan_kept_for_now_waits_no_more_until_it_is_orphaned_again() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        put(
            project.path(),
            &[("src/Row.tsx", "row\n"), ("src/Chip.tsx", "chip\n")],
        );
        let store = Store::new(home.path());
        let mut src = source();
        src.path = project.path().display().to_string();
        let slug = store
            .create_system("w1", "storefront", vec![src], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        let (row, chip) = (
            "components/custom/row/row.html",
            "components/custom/chip/chip.html",
        );
        let row_card = "<!-- @dsCard group=\"Custom\" source=\"src/Row.tsx\" -->\n<div>row</div>\n";
        let chip_card =
            "<!-- @dsCard group=\"Custom\" source=\"src/Chip.tsx\" -->\n<div>chip</div>\n";
        put(&dir, &[(row, row_card), (chip, chip_card)]);
        store.synced("w1", &slug, &[], 2).unwrap();
        let to_settle = || store.systems("w1").unwrap()[0].to_settle;

        // A card that is not orphaned cannot be kept for now.
        assert!(store.settle("w1", &slug, row, Settle::Keep).is_err());
        assert_eq!(to_settle(), 0);

        std::fs::remove_file(project.path().join("src/Row.tsx")).unwrap();
        std::fs::remove_file(project.path().join("src/Chip.tsx")).unwrap();
        assert_eq!(to_settle(), 2, "two orphans");
        store.settle("w1", &slug, row, Settle::Keep).unwrap();
        store.settle("w1", &slug, chip, Settle::Keep).unwrap();
        assert_eq!(to_settle(), 0, "both kept");
        assert_eq!(std::fs::read_to_string(dir.join(row)).unwrap(), row_card);

        // A sync that leaves them orphaned keeps them kept.
        store.synced("w1", &slug, &[], 3).unwrap();
        assert_eq!(to_settle(), 0);

        // The row's source comes back and a sync records it: kept no more,
        // so when it goes again the row waits again.
        put(project.path(), &[("src/Row.tsx", "row\n")]);
        store.synced("w1", &slug, &[], 4).unwrap();
        std::fs::remove_file(project.path().join("src/Row.tsx")).unwrap();
        assert_eq!(to_settle(), 1);

        // A kept card removed is kept no more: one written there later
        // and orphaned waits.
        store.settle("w1", &slug, chip, Settle::Remove).unwrap();
        put(project.path(), &[("src/Chip.tsx", "chip\n")]);
        put(&dir, &[(chip, chip_card)]);
        store.synced("w1", &slug, &[], 5).unwrap();
        std::fs::remove_file(project.path().join("src/Chip.tsx")).unwrap();
        assert_eq!(to_settle(), 2);

        // A kept card deleted by hand before a sync is kept no more either.
        store.settle("w1", &slug, chip, Settle::Keep).unwrap();
        std::fs::remove_dir_all(dir.join("components/custom/chip")).unwrap();
        store.synced("w1", &slug, &[], 6).unwrap();
        put(project.path(), &[("src/Chip.tsx", "chip\n")]);
        put(&dir, &[(chip, chip_card)]);
        store.synced("w1", &slug, &[], 7).unwrap();
        std::fs::remove_file(project.path().join("src/Chip.tsx")).unwrap();
        assert_eq!(to_settle(), 2);
    }

    #[test]
    fn a_settled_card_is_up_to_date_on_the_next_look_and_a_removed_one_comes_back_new() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        put(
            project.path(),
            &[("src/Sidebar.tsx", "sidebar\n"), ("src/Row.tsx", "row\n")],
        );
        let store = Store::new(home.path());
        let mut src = source();
        src.path = project.path().display().to_string();
        let slug = store
            .create_system("w1", "storefront", vec![src], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        let row = "components/custom/row/row.html";
        let look = || {
            let roots = source_roots(&store.record("w1", &slug).unwrap());
            anchor::status(&dir, &roots, &BTreeMap::new()).unwrap()
        };
        put(
            &dir,
            &[(
                row,
                "<!-- @dsCard group=\"Custom\" source=\"src/Sidebar.tsx\" -->\n<div>row</div>\n",
            )],
        );
        store.synced("w1", &slug, &[], 2).unwrap();

        // Edited by hand; the sync proposes its version, from one more
        // source, and is recorded.
        let mine =
            "<!-- @dsCard group=\"Custom\" source=\"src/Sidebar.tsx\" -->\n<div>mine</div>\n";
        let proposal = "<!-- @dsCard group=\"Custom\" source=\"src/Sidebar.tsx,src/Row.tsx\" -->\n<div>synced</div>\n";
        put(
            &dir,
            &[
                (row, mine),
                ("components/custom/row/row.proposed.html", proposal),
            ],
        );
        store.synced("w1", &slug, &[], 3).unwrap();
        assert_eq!(look(), vec![]);
        store.settle("w1", &slug, row, Settle::Synced).unwrap();
        assert_eq!(look(), vec![], "the synced card is the anchored one");

        // Keep mine: the sync recorded the user's card, so it stays up to date.
        put(
            &dir,
            &[
                (row, mine),
                ("components/custom/row/row.proposed.html", proposal),
            ],
        );
        store.synced("w1", &slug, &[], 4).unwrap();
        store.settle("w1", &slug, row, Settle::Mine).unwrap();
        assert_eq!(look(), vec![]);

        // A source that changed after the sync still shows after taking it.
        put(
            &dir,
            &[("components/custom/row/row.proposed.html", proposal)],
        );
        store.synced("w1", &slug, &[], 5).unwrap();
        put(project.path(), &[("src/Sidebar.tsx", "sidebar, wider\n")]);
        store.settle("w1", &slug, row, Settle::Synced).unwrap();
        assert_eq!(
            look(),
            vec![anchor::CardStatus {
                path: row.into(),
                changed_sources: vec!["src/Sidebar.tsx".into()],
                edited_by_hand: false,
                orphaned: false,
                new: false,
                exceptions_changed: false,
            }]
        );

        // An orphan removed is forgotten: a card written there later is new.
        std::fs::remove_dir_all(project.path().join("src")).unwrap();
        store.settle("w1", &slug, row, Settle::Remove).unwrap();
        assert_eq!(look(), vec![]);
        put(
            &dir,
            &[(
                row,
                "<!-- @dsCard group=\"Custom\" source=\"src/Sidebar.tsx\" -->\n<div>row</div>\n",
            )],
        );
        let again = look();
        assert!(again.len() == 1 && again[0].new, "{again:?}");
    }

    #[test]
    fn taking_a_proposed_css_and_prompt_leaves_the_card_up_to_date() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        put(project.path(), &[("src/Row.tsx", "row\n")]);
        let store = Store::new(home.path());
        let mut src = source();
        src.path = project.path().display().to_string();
        let slug = store
            .create_system("w1", "storefront", vec![src], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        let row = "components/custom/row/row.html";
        put(
            &dir,
            &[
                (
                    row,
                    "<!-- @dsCard group=\"Custom\" source=\"src/Row.tsx\" -->\n<div class=\"row\">row</div>\n",
                ),
                ("components/custom/row/row.css", ".row { color: red; }\n"),
                ("components/custom/row/row.prompt.md", "A row, mine.\n"),
                (
                    "components/custom/row/row.proposed.css",
                    ".row { color: var(--color-row-text); }\n",
                ),
                ("components/custom/row/row.proposed.prompt.md", "A row.\n"),
            ],
        );
        store.synced("w1", &slug, &[], 2).unwrap();
        store.settle("w1", &slug, row, Settle::Synced).unwrap();
        let roots = source_roots(&store.record("w1", &slug).unwrap());
        assert_eq!(
            anchor::status(&dir, &roots, &BTreeMap::new()).unwrap(),
            vec![]
        );
    }

    #[test]
    fn a_source_the_proposal_names_that_changed_before_it_was_taken_shows_after() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        put(
            project.path(),
            &[("src/Sidebar.tsx", "sidebar\n"), ("src/Row.tsx", "row\n")],
        );
        let store = Store::new(home.path());
        let mut src = source();
        src.path = project.path().display().to_string();
        let slug = store
            .create_system("w1", "storefront", vec![src], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        let row = "components/custom/row/row.html";
        put(
            &dir,
            &[
                (
                    row,
                    "<!-- @dsCard group=\"Custom\" source=\"src/Sidebar.tsx\" -->\n<div>mine</div>\n",
                ),
                (
                    "components/custom/row/row.proposed.html",
                    "<!-- @dsCard group=\"Custom\" source=\"src/Sidebar.tsx,src/Row.tsx\" -->\n<div>synced</div>\n",
                ),
            ],
        );
        store.synced("w1", &slug, &[], 2).unwrap();
        // While the proposal waits, a source only it names changes.
        put(project.path(), &[("src/Row.tsx", "row, taller\n")]);
        store.settle("w1", &slug, row, Settle::Synced).unwrap();
        let roots = source_roots(&store.record("w1", &slug).unwrap());
        assert_eq!(
            anchor::status(&dir, &roots, &BTreeMap::new()).unwrap(),
            vec![anchor::CardStatus {
                path: row.into(),
                changed_sources: vec!["src/Row.tsx".into()],
                edited_by_hand: false,
                orphaned: false,
                new: false,
                exceptions_changed: false,
            }]
        );
    }

    #[test]
    fn sync_progress_shows_in_the_list_until_the_sync_is_recorded() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
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
    fn a_sync_keeps_every_step_it_reported_and_a_step_reported_again_starts_over_from_it() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        let report =
            |step: &str, summary: &str| store.progress("w1", &slug, step, Some(summary)).unwrap();
        let steps = || {
            let s = store.systems("w1").unwrap().remove(0);
            let steps: Vec<(String, Option<String>)> =
                s.steps.into_iter().map(|r| (r.step, r.summary)).collect();
            (s.step, s.step_summary, steps)
        };
        let pair = |step: &str, summary: &str| (step.to_string(), Some(summary.to_string()));
        assert_eq!(steps(), (None, None, vec![]));

        report("inventory", "3 changed, 1 new, 1 gone");
        report("tokens", "no change");
        report("cards", "1 of 3");
        report("cards", "2 of 3");
        assert_eq!(
            steps(),
            (
                Some("cards".into()),
                Some("2 of 3".into()),
                vec![
                    pair("inventory", "3 changed, 1 new, 1 gone"),
                    pair("tokens", "no change"),
                    pair("cards", "2 of 3"),
                ]
            )
        );

        // A sync that goes back to an earlier step drops the later ones.
        report("tokens", "1 changed");
        assert_eq!(
            steps(),
            (
                Some("tokens".into()),
                Some("1 changed".into()),
                vec![
                    pair("inventory", "3 changed, 1 new, 1 gone"),
                    pair("tokens", "1 changed"),
                ]
            )
        );
        store.progress("w1", &slug, "cards", None).unwrap();
        assert_eq!(
            steps().2,
            vec![
                pair("inventory", "3 changed, 1 new, 1 gone"),
                pair("tokens", "1 changed"),
                ("cards".to_string(), None),
            ]
        );

        store.synced("w1", &slug, &[], 2).unwrap();
        assert_eq!(steps(), (None, None, vec![]));
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
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
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
            .create_system("w1", "moonlet mobile", vec![src], Cover::Core, 1)
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
            .create_system("w1", "storefront", vec![src], Cover::Core, 1)
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
        let a = store
            .create_system("w1", "alpha", vec![], Cover::Core, 1)
            .unwrap();
        store
            .create_system("w1", "beta", vec![], Cover::Core, 1)
            .unwrap();
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
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        assert_eq!(store.agent("w1", &slug).unwrap(), None);
        store.set_agent("w1", &slug, 42, "l").unwrap();
        assert_eq!(store.agent("w1", &slug).unwrap(), Some(42));
        assert_eq!(store.systems("w1").unwrap()[0].agent, Some(42));
    }

    #[test]
    fn what_the_agent_can_edit_never_changes_the_sources_or_its_chat() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![source()], Cover::Core, 1)
            .unwrap();
        store.set_agent("w1", &slug, 7, "l").unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        // The agent works in `dir` and may write anything there.
        put(
            &dir,
            &[
                (
                    "config.toml",
                    "name = \"storefront\"\ncreated_at = 1\n\n[[sources]]\nproject = \"x\"\npath = \"/etc\"\n",
                ),
                (".cache/agent.toml", "terminal = 3\n"),
                (".records/storefront.toml", "agent = 3\n"),
            ],
        );
        let record = store.record("w1", &slug).unwrap();
        assert_eq!(record.sources, vec![source()]);
        assert_eq!(record.agent, Some(7));
        assert!(!store.record_path("w1", &slug).unwrap().starts_with(&dir));
    }

    // Review fixes (#347).

    #[test]
    fn writing_generated_files_never_follows_a_link_the_agent_left() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        put(
            outside.path(),
            &[("record.toml", "trusted\n"), ("dir/keep.txt", "keep\n")],
        );
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        put(
            &dir,
            &[
                ("styles.css", "@import \"tokens/c.css\";\n"),
                ("tokens/c.css", ":root { --color-bg: #fff; }\n"),
            ],
        );
        for (link, to) in [
            ("README.md", outside.path().join("record.toml")),
            ("_ds_manifest.json", outside.path().join("record.toml")),
            ("foundations", outside.path().join("dir")),
            (".cache", outside.path().join("dir")),
        ] {
            std::os::unix::fs::symlink(&to, dir.join(link)).unwrap();
        }
        let _ = store.check_system("w1", &slug);
        let _ = store.progress("w1", &slug, "cards", None);
        assert_eq!(
            std::fs::read_to_string(outside.path().join("record.toml")).unwrap(),
            "trusted\n"
        );
        let left: Vec<String> = std::fs::read_dir(outside.path().join("dir"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec!["keep.txt".to_string()]);
    }

    #[test]
    fn a_record_that_cannot_be_read_lists_the_system_with_its_error() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![source()], Cover::Core, 1)
            .unwrap();
        std::fs::write(
            home.path()
                .join("design/w1/.records")
                .join(format!("{slug}.toml")),
            "sources = 3 = 4\n",
        )
        .unwrap();
        let s = &store.systems("w1").unwrap()[0];
        assert!(
            s.error.as_deref().is_some_and(|e| e.contains("record")),
            "{:?}",
            s.error
        );
    }

    // Review fixes (#343, on #347).

    #[test]
    fn a_linked_workspace_or_systems_folder_is_refused_and_nothing_outside_changes() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        put(
            outside.path(),
            &[
                (
                    "storefront/config.toml",
                    "name = \"storefront\"\ncreated_at = 1\n",
                ),
                ("storefront/keep.txt", "keep\n"),
            ],
        );
        let store = Store::new(home.path());
        // `design/w1/systems` links out.
        std::fs::create_dir_all(home.path().join("design/w1")).unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join("design/w1/systems")).unwrap();
        assert!(store.remove_system("w1", "storefront").is_err());
        assert!(store.config("w1", "storefront").is_err());
        assert!(store.check_system("w1", "storefront").is_err());
        assert!(
            store
                .create_system("w1", "pricing", vec![], Cover::Core, 1)
                .is_err()
        );
        assert!(store.systems("w1").is_err());
        // `design/w2` links out.
        std::os::unix::fs::symlink(outside.path(), home.path().join("design/w2")).unwrap();
        assert!(
            store
                .create_system("w2", "pricing", vec![], Cover::Core, 1)
                .is_err()
        );
        // A system folder that is a link.
        store
            .create_system("w3", "alpha", vec![], Cover::Core, 1)
            .unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("storefront"),
            home.path().join("design/w3/systems/storefront"),
        )
        .unwrap();
        assert!(store.remove_system("w3", "storefront").is_err());
        let mut left: Vec<String> = std::fs::read_dir(outside.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["storefront".to_string()]);
        assert_eq!(
            std::fs::read_to_string(outside.path().join("storefront/keep.txt")).unwrap(),
            "keep\n"
        );
    }

    #[test]
    fn a_linked_config_is_refused_and_a_sync_never_changes_files_outside_through_a_link() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = "name = \"theirs\"\ncreated_at = 1\n";
        put(
            outside.path(),
            &[
                ("config.toml", theirs),
                ("progress.toml", "step = \"cards\"\n"),
            ],
        );
        let store = Store::new(home.path());
        let a = store
            .create_system("w1", "alpha", vec![], Cover::Core, 1)
            .unwrap();
        let b = store
            .create_system("w1", "beta", vec![], Cover::Core, 1)
            .unwrap();
        let systems = home.path().join("design/w1/systems");
        // alpha's config.toml links out: alpha is not read, nor written.
        std::fs::remove_file(systems.join(&a).join(CONFIG)).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("config.toml"),
            systems.join(&a).join(CONFIG),
        )
        .unwrap();
        assert!(store.config("w1", &a).is_err());
        assert!(store.synced("w1", &a, &[], 2).is_err());
        assert!(store.progress("w1", &a, "cards", None).is_err());
        assert!(store.check_system("w1", &a).is_err());
        assert!(store.set_agent("w1", &a, 3, "l").is_err());
        // beta's `.cache` links out: its sync leaves the file there alone.
        std::os::unix::fs::symlink(outside.path(), systems.join(&b).join(".cache")).unwrap();
        store.synced("w1", &b, &[], 2).unwrap();
        assert_eq!(
            std::fs::read_to_string(outside.path().join("config.toml")).unwrap(),
            theirs
        );
        assert_eq!(
            std::fs::read_to_string(outside.path().join("progress.toml")).unwrap(),
            "step = \"cards\"\n"
        );
        assert_eq!(
            store
                .systems("w1")
                .unwrap()
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            vec!["beta"]
        );
    }

    #[test]
    fn a_creation_that_fails_leaves_no_folder_and_its_name_free() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        store
            .create_system("w1", "alpha", vec![], Cover::Core, 1)
            .unwrap();
        // The record cannot be written: `.records` is a file.
        let records = home.path().join("design/w1/.records");
        std::fs::remove_dir_all(&records).unwrap();
        std::fs::write(&records, "").unwrap();
        assert!(
            store
                .create_system("w1", "storefront", vec![source()], Cover::Core, 1)
                .is_err()
        );
        assert!(!home.path().join("design/w1/systems/storefront").exists());
        std::fs::remove_file(&records).unwrap();
        assert_eq!(
            store
                .create_system("w1", "storefront", vec![source()], Cover::Core, 1)
                .unwrap(),
            "storefront"
        );
    }

    #[test]
    fn a_record_is_replaced_whole_so_a_reader_never_sees_it_half_written() {
        use std::io::Read;
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![source()], Cover::Core, 1)
            .unwrap();
        let records = home.path().join("design/w1/.records");
        // Opened before the write, as by a read that the write interrupts.
        let mut reader = std::fs::File::open(records.join("storefront.toml")).unwrap();
        store.set_agent("w1", &slug, 7, "l").unwrap();
        let mut seen = String::new();
        reader.read_to_string(&mut seen).unwrap();
        assert_eq!(
            seen,
            "[[sources]]
project = \"p-moonlet\"
path = \"/Users/alex/Workspace/1devstudio/moonlet\"

[sources.identity]
origin = \"github.com/1devstudio/moonlet\"
root = \"9c1e0a2\"
"
        );
        assert_eq!(store.agent("w1", &slug).unwrap(), Some(7));
        let left: Vec<String> = std::fs::read_dir(&records)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec!["storefront.toml".to_string()]);
    }

    #[test]
    fn a_sync_that_cannot_be_recorded_leaves_the_anchor_and_the_record_as_they_were() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path, m: u32| {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap()
        };
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let mut src = source();
        src.commit = Some("old1234".into());
        let slug = store
            .create_system("w1", "storefront", vec![src], Cover::Core, 1)
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
        let unfinished = |store: &Store| {
            let s = &store.systems("w1").unwrap()[0];
            (s.synced_at, s.synced_commit.clone(), s.step.clone())
        };
        let before = (
            None,
            Some("old1234".to_string()),
            Some("layouts".to_string()),
        );
        let sync = |store: &Store| {
            store.synced(
                "w1",
                &slug,
                &[("p-moonlet".into(), Some("new5678".into()))],
                9,
            )
        };
        // The record cannot be written: the anchor stays unwritten.
        let records = home.path().join("design/w1/.records");
        mode(&records, 0o555);
        mode(&records.join("storefront.toml"), 0o444);
        let failed = sync(&store);
        mode(&records, 0o755);
        mode(&records.join("storefront.toml"), 0o644);
        assert!(failed.is_err());
        assert!(!dir.join("_ds_sync.json").exists());
        assert_eq!(unfinished(&store), before);
        // The anchor cannot be written: the record is as it was.
        mode(&dir, 0o555);
        let failed = sync(&store);
        mode(&dir, 0o755);
        assert!(failed.is_err());
        assert!(!dir.join("_ds_sync.json").exists());
        assert_eq!(unfinished(&store), before);
        sync(&store).unwrap();
        assert!(dir.join("_ds_sync.json").is_file());
        assert_eq!(
            unfinished(&store),
            (Some(9), Some("new5678".to_string()), None)
        );
    }

    #[test]
    fn a_sources_folder_is_a_real_folder_inside_its_project() {
        let repo = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        put(
            repo.path(),
            &[("apps/mobile/src/a.tsx", ""), ("README.md", "")],
        );
        std::os::unix::fs::symlink(outside.path(), repo.path().join("apps/out")).unwrap();
        let real = repo.path().canonicalize().unwrap();
        let with = |subdir: Option<&str>| Source {
            path: repo.path().display().to_string(),
            subdir: subdir.map(String::from),
            ..source()
        };
        assert_eq!(source_root(&with(None)).unwrap(), real);
        assert_eq!(
            source_root(&with(Some("apps/mobile"))).unwrap(),
            real.join("apps/mobile")
        );
        for bad in [
            "/etc",
            "..",
            "apps/../..",
            "apps/mobile/../../..",
            "apps/out",
            "apps/missing",
            "README.md",
            "",
        ] {
            assert!(source_root(&with(Some(bad))).is_err(), "{bad} accepted");
        }
    }

    #[test]
    fn checking_never_writes_or_removes_through_a_linked_foundation_family() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        put(
            outside.path(),
            &[
                ("colours/colours.html", "theirs\n"),
                ("type/type.html", "theirs\n"),
            ],
        );
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        put(
            &dir,
            &[
                ("styles.css", "@import \"tokens/c.css\";\n"),
                ("tokens/c.css", ":root { --color-bg: #fff; }\n"),
            ],
        );
        // `colours` has tokens (its card is written), `type` has none (its
        // folder is removed).
        std::fs::create_dir_all(dir.join("foundations")).unwrap();
        for family in ["colours", "type"] {
            std::os::unix::fs::symlink(
                outside.path().join(family),
                dir.join("foundations").join(family),
            )
            .unwrap();
        }
        let _ = store.check_system("w1", &slug);
        for family in ["colours", "type"] {
            assert_eq!(
                std::fs::read_to_string(outside.path().join(format!("{family}/{family}.html")))
                    .unwrap(),
                "theirs\n"
            );
        }
    }

    #[test]
    fn a_recorded_agent_is_reused_only_with_the_launch_it_was_started_with() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        store.set_agent("w1", &slug, 7, "settings A").unwrap();
        assert_eq!(store.agent_for("w1", &slug, "settings A").unwrap(), Some(7));
        assert_eq!(store.agent_for("w1", &slug, "settings B").unwrap(), None);
        assert_eq!(store.agent("w1", &slug).unwrap(), Some(7));
    }

    #[test]
    fn a_recorded_sync_keeps_what_it_changed() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        put(project.path(), &[("src/ui.tsx", "button\n")]);
        let store = Store::new(home.path());
        let mut src = source();
        src.path = project.path().display().to_string();
        let slug = store
            .create_system("w1", "storefront", vec![src], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        let card = |body: &str| {
            format!("<!-- @dsCard group=\"Buttons\" source=\"src/ui.tsx\" -->\n{body}\n")
        };
        put(
            &dir,
            &[
                (
                    "components/buttons/button/button.html",
                    &card("<button>Run</button>"),
                ),
                ("components/forms/old/old.html", &card("<p>old</p>")),
            ],
        );
        store.synced("w1", &slug, &[], 2).unwrap();
        let first = store.record("w1", &slug).unwrap().last_sync;
        assert_eq!(
            first
                .iter()
                .map(|c| (c.path.as_str(), c.change.as_str()))
                .collect::<Vec<_>>(),
            [
                ("components/buttons/button/button.html", "new"),
                ("components/forms/old/old.html", "new"),
            ]
        );

        put(
            &dir,
            &[
                (
                    "components/buttons/button/button.html",
                    &card("<button>Run</button><button disabled>Run</button>"),
                ),
                ("components/forms/kbd/kbd.html", &card("<kbd>K</kbd>")),
            ],
        );
        std::fs::remove_dir_all(dir.join("components/forms/old")).unwrap();
        store.synced("w1", &slug, &[], 3).unwrap();
        let second = store.record("w1", &slug).unwrap().last_sync;
        assert_eq!(
            second,
            vec![
                SyncChange {
                    path: "components/buttons/button/button.html".into(),
                    change: "rewritten".into(),
                    sources: vec!["src/ui.tsx".into()]
                },
                SyncChange {
                    path: "components/forms/kbd/kbd.html".into(),
                    change: "new".into(),
                    sources: vec!["src/ui.tsx".into()]
                },
                SyncChange {
                    path: "components/forms/old/old.html".into(),
                    change: "removed".into(),
                    sources: vec!["src/ui.tsx".into()]
                },
            ]
        );
        assert_eq!(store.systems("w1").unwrap()[0].last_sync, second);
    }

    #[test]
    fn a_cards_own_files_problems_are_its_own_and_a_card_without_a_marker_is_listed() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        put(
            &dir,
            &[
                ("styles.css", "@import \"components.css\";\n"),
                (
                    "components.css",
                    "@import \"components/buttons/button/button.css\";\n",
                ),
                (
                    "components/buttons/button/button.html",
                    "<!-- @dsCard group=\"Buttons\" name=\"Button\" -->\n<button class=\"btn\">Run</button>\n",
                ),
                (
                    "components/buttons/button/button.css",
                    ".btn {\n  color: var(--color-nope);\n}\n",
                ),
                (
                    "components/forms/field/field.html",
                    "<input class=\"field\">\n",
                ),
            ],
        );
        let cards = store.cards("w1", &slug).unwrap();
        let got: Vec<_> = cards
            .iter()
            .map(|c| {
                (
                    c.group.as_str(),
                    c.name.as_str(),
                    c.path.as_str(),
                    c.problems
                        .iter()
                        .map(|p| (p.path.as_str(), p.line, p.kind.clone()))
                        .collect::<Vec<_>>(),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    "Buttons",
                    "Button",
                    "components/buttons/button/button.html",
                    vec![(
                        "components/buttons/button/button.css",
                        2,
                        check::Kind::UnknownToken
                    )],
                ),
                (
                    "Without a marker",
                    "field",
                    "components/forms/field/field.html",
                    vec![("components/forms/field/field.html", 1, check::Kind::Marker)],
                ),
            ]
        );
    }

    #[test]
    fn a_card_claims_only_its_own_files_problems_never_another_cards_beside_or_under_it() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        let card = |name: &str, token: &str| {
            format!(
                "<!-- @dsCard group=\"Buttons\" name=\"{name}\" -->\n<p style=\"color: var({token})\">x</p>\n"
            )
        };
        put(
            &dir,
            &[
                ("styles.css", "\n"),
                (
                    "components/buttons/button/button.html",
                    &card("Button", "--one"),
                ),
                (
                    "components/buttons/button/inner/inner.html",
                    &card("Inner", "--two"),
                ),
            ],
        );
        let got: Vec<(String, Vec<String>)> = store
            .cards("w1", &slug)
            .unwrap()
            .into_iter()
            .map(|c| (c.name, c.problems.into_iter().map(|p| p.path).collect()))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    "Button".to_string(),
                    vec!["components/buttons/button/button.html".to_string()]
                ),
                (
                    "Inner".to_string(),
                    vec!["components/buttons/button/inner/inner.html".to_string()]
                ),
            ]
        );
    }

    #[test]
    fn a_systems_cards_come_with_their_marker_problems_and_changed_sources() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        put(
            project.path(),
            &[("src/ui.tsx", "button\n"), ("src/form.tsx", "input\n")],
        );
        let store = Store::new(home.path());
        let mut src = source();
        src.path = project.path().display().to_string();
        let slug = store
            .create_system("w1", "storefront", vec![src], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        let head = "<!doctype html>\n<html><head><meta charset=\"utf-8\"><link rel=\"stylesheet\" href=\"../../../styles.css\"></head>\n";
        put(
            &dir,
            &[
                ("styles.css", "@import \"components.css\";\n"),
                ("components.css", ".btn {}\n.field {}\n"),
                (
                    "components/buttons/button/button.html",
                    &format!(
                        "<!-- @dsCard group=\"Buttons\" name=\"Button\" source=\"src/ui.tsx\" viewport=\"320x140\" -->\n{head}<body><section data-snippet=\"buttons/button/primary\"><button class=\"btn\">Run</button></section>\n<section data-snippet=\"buttons/button/ghost\"><button class=\"btn\">Cancel</button></section></body></html>\n"
                    ),
                ),
                (
                    "components/forms/field/field.html",
                    &format!(
                        "<!-- @dsCard group=\"Forms\" name=\"Field\" source=\"src/form.tsx\" -->\n{head}<body><section data-snippet=\"forms/field/default\"><input class=\"field\" style=\"color: var(--color-nope)\"></section></body></html>\n"
                    ),
                ),
            ],
        );
        store.synced("w1", &slug, &[], 2).unwrap();
        put(project.path(), &[("src/ui.tsx", "button, now primary\n")]);

        let cards = store.cards("w1", &slug).unwrap();
        let got: Vec<_> = cards
            .iter()
            .map(|c| {
                (
                    c.group.as_str(),
                    c.name.as_str(),
                    c.path.as_str(),
                    c.viewport,
                    c.source.clone(),
                    c.snippets.clone(),
                    c.changed_sources.clone(),
                    c.problems
                        .iter()
                        .map(|p| (p.line, p.kind.clone()))
                        .collect::<Vec<_>>(),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    "Buttons",
                    "Button",
                    "components/buttons/button/button.html",
                    (320, 140),
                    vec!["src/ui.tsx".to_string()],
                    vec![
                        "buttons/button/primary".to_string(),
                        "buttons/button/ghost".to_string()
                    ],
                    vec!["src/ui.tsx".to_string()],
                    vec![],
                ),
                (
                    "Forms",
                    "Field",
                    "components/forms/field/field.html",
                    (900, 700),
                    vec!["src/form.tsx".to_string()],
                    vec!["forms/field/default".to_string()],
                    vec![],
                    vec![(4, check::Kind::UnknownToken)],
                ),
            ]
        );
        assert_eq!(
            cards[0].marker,
            "<!-- @dsCard group=\"Buttons\" name=\"Button\" source=\"src/ui.tsx\" viewport=\"320x140\" -->"
        );
    }

    #[test]
    fn a_systems_cards_say_what_each_waits_for_its_proposals_an_edit_by_hand_or_an_orphan_kept() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        put(
            project.path(),
            &[
                ("src/Row.tsx", "row\n"),
                ("src/Chip.tsx", "chip\n"),
                ("src/ui.tsx", "button\n"),
                ("src/form.tsx", "input\n"),
            ],
        );
        let store = Store::new(home.path());
        let mut src = source();
        src.path = project.path().display().to_string();
        let slug = store
            .create_system("w1", "storefront", vec![src], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        put(
            &dir,
            &[
                (
                    "components/custom/row/row.html",
                    "<!-- @dsCard group=\"Custom\" name=\"Row\" source=\"src/Row.tsx\" -->\n<div>row</div>\n",
                ),
                (
                    "components/custom/chip/chip.html",
                    "<!-- @dsCard group=\"Custom\" name=\"Chip\" source=\"src/Chip.tsx\" -->\n<span>chip</span>\n",
                ),
                (
                    "components/buttons/button/button.html",
                    "<!-- @dsCard group=\"Buttons\" name=\"Button\" source=\"src/ui.tsx\" -->\n<button>Run</button>\n",
                ),
                (
                    "components/forms/field/field.html",
                    "<!-- @dsCard group=\"Forms\" name=\"Field\" source=\"src/form.tsx\" -->\n<input>\n",
                ),
            ],
        );
        store.synced("w1", &slug, &[], 2).unwrap();
        // The user edits the row; the next sync proposes its HTML and CSS.
        put(
            &dir,
            &[
                (
                    "components/custom/row/row.html",
                    "<!-- @dsCard group=\"Custom\" name=\"Row\" source=\"src/Row.tsx\" -->\n<div>mine</div>\n",
                ),
                (
                    "components/custom/row/row.proposed.html",
                    "<!-- @dsCard group=\"Custom\" name=\"Row\" source=\"src/Row.tsx\" -->\n<div>synced</div>\n",
                ),
                ("components/custom/row/row.proposed.css", ".row {}\n"),
            ],
        );
        // The chip's and the button's sources go; the chip is kept for now.
        std::fs::remove_file(project.path().join("src/Chip.tsx")).unwrap();
        std::fs::remove_file(project.path().join("src/ui.tsx")).unwrap();
        store
            .settle(
                "w1",
                &slug,
                "components/custom/chip/chip.html",
                Settle::Keep,
            )
            .unwrap();

        let got: Vec<_> = store
            .cards("w1", &slug)
            .unwrap()
            .into_iter()
            .map(|c| (c.path, c.proposals, c.edited_by_hand, c.orphaned, c.kept))
            .collect();
        let s = |v: &[&str]| v.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        assert_eq!(
            got,
            vec![
                (
                    "components/buttons/button/button.html".to_string(),
                    vec![],
                    false,
                    true,
                    false
                ),
                (
                    "components/custom/chip/chip.html".to_string(),
                    vec![],
                    false,
                    true,
                    true
                ),
                (
                    "components/custom/row/row.html".to_string(),
                    s(&[
                        "components/custom/row/row.proposed.css",
                        "components/custom/row/row.proposed.html"
                    ]),
                    true,
                    false,
                    false
                ),
                (
                    "components/forms/field/field.html".to_string(),
                    vec![],
                    false,
                    false,
                    false
                ),
            ]
        );
    }

    #[test]
    fn a_card_whose_css_or_prompt_alone_the_sync_rewrote_is_among_its_changes() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        put(
            &dir,
            &[
                (
                    "components/forms/button/button.html",
                    "<!-- @dsCard group=\"Forms\" -->\n<button class=\"btn\">Run</button>\n",
                ),
                (
                    "components/forms/button/button.css",
                    ".btn { color: red; }\n",
                ),
                (
                    "components/forms/input/input.html",
                    "<!-- @dsCard group=\"Forms\" -->\n<input>\n",
                ),
                ("components/forms/input/input.prompt.md", "An input.\n"),
            ],
        );
        store.synced("w1", &slug, &[], 2).unwrap();
        store.begin_sync("w1", &slug).unwrap();
        put(
            &dir,
            &[
                (
                    "components/forms/button/button.css",
                    ".btn { color: blue; }\n",
                ),
                ("components/forms/input/input.prompt.md", "A text input.\n"),
            ],
        );
        store.synced("w1", &slug, &[], 3).unwrap();
        let got: Vec<(String, String)> = store
            .record("w1", &slug)
            .unwrap()
            .last_sync
            .into_iter()
            .map(|c| (c.path, c.change))
            .collect();
        assert_eq!(
            got,
            [
                (
                    "components/forms/button/button.html".to_string(),
                    "rewritten".to_string()
                ),
                (
                    "components/forms/input/input.html".to_string(),
                    "rewritten".to_string()
                ),
            ]
        );
    }

    #[test]
    fn cards_the_user_changed_before_a_sync_started_are_not_among_its_changes() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        put(project.path(), &[("src/ui.tsx", "button\n")]);
        let store = Store::new(home.path());
        let mut src = source();
        src.path = project.path().display().to_string();
        let slug = store
            .create_system("w1", "storefront", vec![src], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        let card = |body: &str| {
            format!("<!-- @dsCard group=\"Forms\" source=\"src/ui.tsx\" -->\n{body}\n")
        };
        put(
            &dir,
            &[
                (
                    "components/forms/button/button.html",
                    &card("<button>Run</button>"),
                ),
                ("components/forms/input/input.html", &card("<input>")),
                ("components/forms/old/old.html", &card("<p>old</p>")),
                ("components/forms/gone/gone.html", &card("<p>gone</p>")),
            ],
        );
        store.synced("w1", &slug, &[], 2).unwrap();

        // By hand, before the sync: one card edited, one made, one deleted.
        put(
            &dir,
            &[
                (
                    "components/forms/button/button.html",
                    &card("<button>Go</button>"),
                ),
                ("components/forms/mine/mine.html", &card("<p>mine</p>")),
            ],
        );
        std::fs::remove_dir_all(dir.join("components/forms/old")).unwrap();
        store.begin_sync("w1", &slug).unwrap();
        // The sync keeps the edited card (its proposal is no card), rewrites
        // one, adds one and removes one.
        put(
            &dir,
            &[
                (
                    "components/forms/button/button.proposed.html",
                    &card("<button>Run!</button>"),
                ),
                (
                    "components/forms/input/input.html",
                    &card("<input disabled>"),
                ),
                ("components/forms/kbd/kbd.html", &card("<kbd>K</kbd>")),
            ],
        );
        std::fs::remove_dir_all(dir.join("components/forms/gone")).unwrap();
        store.synced("w1", &slug, &[], 3).unwrap();
        assert_eq!(
            store.record("w1", &slug).unwrap().last_sync,
            vec![
                SyncChange {
                    path: "components/forms/gone/gone.html".into(),
                    change: "removed".into(),
                    sources: vec!["src/ui.tsx".into()]
                },
                SyncChange {
                    path: "components/forms/input/input.html".into(),
                    change: "rewritten".into(),
                    sources: vec!["src/ui.tsx".into()]
                },
                SyncChange {
                    path: "components/forms/kbd/kbd.html".into(),
                    change: "new".into(),
                    sources: vec!["src/ui.tsx".into()]
                },
            ]
        );
    }

    #[test]
    fn a_sync_retried_after_it_stopped_midway_keeps_its_change_list() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems").join(&slug);
        store.begin_sync("w1", &slug).unwrap();
        put(
            &dir,
            &[(
                "components/buttons/button/button.html",
                "<!-- @dsCard group=\"Buttons\" -->\n<button>Run</button>\n",
            )],
        );
        // As if a sync stopped after writing the anchor, before finishing its record.
        anchor::write(&dir, &[], &BTreeMap::new()).unwrap();
        // The retry finds nothing new against the anchor, and keeps the list.
        store.synced("w1", &slug, &[], 2).unwrap();
        assert_eq!(
            store.record("w1", &slug).unwrap().last_sync,
            vec![SyncChange {
                path: "components/buttons/button/button.html".into(),
                change: "new".into(),
                sources: vec![]
            }]
        );
        // A later sync with no change says so.
        store.synced("w1", &slug, &[], 3).unwrap();
        assert_eq!(store.record("w1", &slug).unwrap().last_sync, vec![]);
    }
}
