//! `_ds_sync.json` (X64), the re-sync anchor, as design-sync's: per card, a
//! hash of each source file it was made from and a hash of its HTML without
//! the marker line, and (moonlet's own) a hash of a component's `.css` and
//! `.prompt.md`. Comparing it with the folder and the sources now tells
//! which cards are out of date, edited by hand, orphaned or new.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::card;
use super::check::{html_files, rel};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardAnchor {
    /// A hash of the card's sources and their hashes: the grade contract.
    pub source_key: String,
    /// A hash of the card's HTML after its first line, so a regroup keeps it.
    pub render_hash: String,
    /// A hash of the component's `<name>.css` and `<name>.prompt.md` beside
    /// the card; empty when it has neither (a layout has neither).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub companion_hash: String,
    /// Each source file, relative to its project, and its hash.
    pub sources: BTreeMap<String, String>,
    /// With a `<name>.proposed.html` waiting beside the card: each source
    /// the proposal's marker names, and its hash when the sync made it.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub proposed_sources: BTreeMap<String, String>,
}

impl CardAnchor {
    /// Every source it names was gone when the anchor was made.
    pub fn orphaned(&self) -> bool {
        !self.sources.is_empty() && self.sources.values().all(String::is_empty)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anchor {
    pub cards: BTreeMap<String, CardAnchor>,
    /// `styles.css`, `components.css`, `tokens/` and `fonts/`: a change here
    /// keeps every card's grade.
    #[serde(default)]
    pub style_sha: String,
    /// `README.md` and `guidelines/`.
    #[serde(default)]
    pub aux_sha: String,
    /// Every file of the system but `.cache/` and the anchor itself.
    #[serde(default)]
    pub files: BTreeMap<String, String>,
}

/// Writes `_ds_sync.json` for the design system in `root`, made from the
/// projects at `sources` (a card's source path is looked up in each, in order).
pub fn write(
    root: &Path,
    sources: &[PathBuf],
    exceptions: &BTreeMap<String, String>,
) -> Result<()> {
    save(root, &compute(root, sources, exceptions)?)
}

/// Writes `anchor` as the `_ds_sync.json` of the design system in `root`,
/// replacing the old one whole.
pub fn save(root: &Path, anchor: &Anchor) -> Result<()> {
    let json = serde_json::to_string_pretty(anchor)?;
    super::fsx::write_inside(root, &root.join(FILE), (json + "\n").as_bytes())
}

/// The anchor of the design system in `root`, read without following a link
/// out of it; `None` before the first sync.
fn load(root: &Path) -> Result<Option<Anchor>> {
    match super::fsx::read_inside(root, &root.join(FILE)) {
        Ok(text) => Ok(Some(
            serde_json::from_str(&text).with_context(|| format!("parsing {FILE}"))?,
        )),
        Err(e)
            if e.downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// Records that `card` now holds the sync's version, taken by the user (X64):
/// its HTML, `.css` and `.prompt.md` are the anchored ones, and each source
/// its marker names keeps the hash the sync recorded for its proposal (one
/// the sync did not record is unknown, so it shows as changed). So the next
/// look finds it up to date, unless a source changed since the sync. Every
/// other card stays as it is; with no anchor, or no entry for the card,
/// nothing changes.
pub fn take(root: &Path, card: &str, exceptions: &BTreeMap<String, String>) -> Result<()> {
    let Some(mut anchor) = load(root)? else {
        return Ok(());
    };
    let Some(then) = anchor.cards.get(card) else {
        return Ok(());
    };
    let text = super::fsx::read_inside(root, &root.join(card))?;
    let files: BTreeMap<String, String> = card::parse_marker(&text)
        .map(|m| m.source)
        .unwrap_or_default()
        .into_iter()
        .map(|s| {
            let hash = then
                .proposed_sources
                .get(&s)
                .or_else(|| then.sources.get(&s))
                .cloned()
                .unwrap_or_else(|| UNKNOWN.to_string());
            (s, hash)
        })
        .collect();
    let entry = CardAnchor {
        source_key: source_key(&files, exceptions.get(card).map(String::as_str)),
        render_hash: render_hash(&text),
        companion_hash: companion_hash(root, card),
        sources: files,
        proposed_sources: BTreeMap::new(),
    };
    anchor.cards.insert(card.to_string(), entry);
    save(root, &anchor)
}

/// Forgets `card`, removed by the user (X64): a card written at its path
/// later is new. Every other card stays as it is.
pub fn forget(root: &Path, card: &str) -> Result<()> {
    let Some(mut anchor) = load(root)? else {
        return Ok(());
    };
    if anchor.cards.remove(card).is_none() {
        return Ok(());
    }
    save(root, &anchor)
}

/// The anchor written by the last sync, if there is one that reads.
pub fn read(root: &Path) -> Option<Anchor> {
    load(root).ok().flatten()
}

/// The anchor as it would be written now.
/// `exceptions` holds each card's settings in `config.toml`, by card path:
/// a change to them changes the card's `source_key`.
pub fn compute(
    root: &Path,
    sources: &[PathBuf],
    exceptions: &BTreeMap<String, String>,
) -> Result<Anchor> {
    let mut cards = BTreeMap::new();
    for (rel_path, card) in renders(root)? {
        // A card whose marker broke stays in the anchor, with no sources, so
        // its status still shows what it was made from.
        let files: BTreeMap<String, String> = card
            .sources
            .iter()
            .map(|s| (s.clone(), source_hash(sources, s).unwrap_or_default()))
            .collect();
        let key = source_key(&files, exceptions.get(&rel_path).map(String::as_str));
        let proposed_sources = proposed_sources(root, &rel_path, sources);
        cards.insert(
            rel_path,
            CardAnchor {
                source_key: key,
                render_hash: card.render_hash,
                companion_hash: card.companion_hash,
                sources: files,
                proposed_sources,
            },
        );
    }
    let all = all_files(root);
    let set_sha = |keep: &dyn Fn(&str) -> bool| {
        let mut bytes = Vec::new();
        for (p, b) in all.iter().filter(|(p, _)| keep(p)) {
            bytes.extend_from_slice(p.as_bytes());
            bytes.push(0);
            bytes.extend_from_slice(b);
        }
        sha16(&bytes)
    };
    let style_sha = set_sha(&|p| {
        p == "styles.css"
            || p == "components.css"
            || p.starts_with("tokens/")
            || p.starts_with("fonts/")
    });
    let aux_sha = set_sha(&|p| p == "README.md" || p.starts_with("guidelines/"));
    let files = all.iter().map(|(p, b)| (p.clone(), sha16(b))).collect();
    Ok(Anchor {
        cards,
        style_sha,
        aux_sha,
        files,
    })
}

/// A card as it is: what a sync's changes are told against (X64).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardRender {
    /// As [`CardAnchor::render_hash`].
    pub render_hash: String,
    /// As [`CardAnchor::companion_hash`]: its `.css` and `.prompt.md`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub companion_hash: String,
    /// The source files its marker names, relative to their project, sorted.
    pub sources: Vec<String>,
}

/// Every card of the system in `root` (`components/` and `ui_kits/`, not a
/// proposal), by path, without reading its sources.
pub fn renders(root: &Path) -> Result<BTreeMap<String, CardRender>> {
    let mut cards = BTreeMap::new();
    for path in html_files(root) {
        let rel_path = rel(root, &path);
        if !(rel_path.starts_with("components/") || rel_path.starts_with("ui_kits/"))
            || rel_path.ends_with(".proposed.html")
        {
            continue;
        }
        let text = std::fs::read_to_string(&path)?;
        let mut sources = card::parse_marker(&text)
            .map(|m| m.source)
            .unwrap_or_default();
        sources.sort();
        sources.dedup();
        let companion = companion_hash(root, &rel_path);
        cards.insert(
            rel_path,
            CardRender {
                render_hash: render_hash(&text),
                companion_hash: companion,
                sources,
            },
        );
    }
    Ok(cards)
}

/// Every file of the system, by path, but `.cache/` and the anchor itself.
fn all_files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut todo = vec![root.to_path_buf()];
    while let Some(dir) = todo.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            // `file_type` does not follow symlinks: a linked folder is never
            // entered, so it cannot loop or reach outside the system.
            let Ok(kind) = e.file_type() else { continue };
            let p = e.path();
            if kind.is_dir() {
                if e.file_name() != ".cache" {
                    todo.push(p);
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let r = rel(root, &p);
            if r != FILE
                && let Ok(b) = std::fs::read(&p)
            {
                out.insert(r, b);
            }
        }
    }
    out
}

/// What a card needs since the last sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CardStatus {
    pub path: String,
    /// Its source files that changed or are gone: the card is out of date.
    pub changed_sources: Vec<String>,
    /// Its HTML after the marker changed since the sync.
    pub edited_by_hand: bool,
    /// Every one of its source files is gone.
    pub orphaned: bool,
    /// The anchor does not know it.
    pub new: bool,
    /// Its settings in `config.toml` changed: it is out of date too.
    pub exceptions_changed: bool,
}

/// The cards that changed since `_ds_sync.json` was written, by path. With no
/// anchor every card is new; one that cannot be read or parsed is an error.
pub fn status(
    root: &Path,
    sources: &[PathBuf],
    exceptions: &BTreeMap<String, String>,
) -> Result<Vec<CardStatus>> {
    let path = root.join(FILE);
    let anchored: Anchor = match std::fs::read_to_string(&path) {
        Ok(text) => {
            serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?
        }
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            return Err(e).with_context(|| format!("reading {}", path.display()));
        }
        Err(_) => Anchor {
            cards: BTreeMap::new(),
            style_sha: String::new(),
            aux_sha: String::new(),
            files: BTreeMap::new(),
        },
    };
    let mut out = Vec::new();
    for (path, now) in compute(root, sources, exceptions)?.cards {
        let mut st = CardStatus {
            path: path.clone(),
            changed_sources: Vec::new(),
            edited_by_hand: false,
            orphaned: false,
            new: false,
            exceptions_changed: false,
        };
        match anchored.cards.get(&path) {
            None => st.new = true,
            Some(then) => {
                // Sources whose hash moved or that are gone, and those the
                // card no longer names.
                let mut changed: Vec<String> = now
                    .sources
                    .iter()
                    .filter(|(p, h)| then.sources.get(*p) != Some(*h))
                    .map(|(p, _)| p.clone())
                    .collect();
                changed.extend(
                    then.sources
                        .keys()
                        .filter(|p| !now.sources.contains_key(*p))
                        .cloned(),
                );
                changed.sort();
                st.changed_sources = changed;
                st.edited_by_hand = now.render_hash != then.render_hash
                    || now.companion_hash != then.companion_hash;
                st.exceptions_changed = st.changed_sources.is_empty()
                    && now.sources == then.sources
                    && now.source_key != then.source_key;
                // A card whose marker broke names no sources now: the ones
                // it had at the sync tell whether it is orphaned.
                let named: Vec<&String> = if now.sources.is_empty() {
                    then.sources.keys().collect()
                } else {
                    now.sources.keys().collect()
                };
                st.orphaned =
                    !named.is_empty() && named.iter().all(|p| source_hash(sources, p).is_none());
            }
        }
        if !st.changed_sources.is_empty()
            || st.edited_by_hand
            || st.orphaned
            || st.new
            || st.exceptions_changed
        {
            out.push(st);
        }
    }
    Ok(out)
}

/// The anchor's file name.
pub const FILE: &str = "_ds_sync.json";

/// The first 16 hex digits of the SHA-256, as design-sync's hashes.
fn sha16(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The card after its first line: the marker can change (a regroup) without
/// the card counting as edited.
fn render_hash(html: &str) -> String {
    sha16(
        html.split_once('\n')
            .map_or("", |(_, rest)| rest)
            .as_bytes(),
    )
}

/// The hash a source gets in a taken card when the sync recorded none: it
/// matches no file, so the source shows as changed.
const UNKNOWN: &str = "unknown";

/// The sources the `<name>.proposed.html` beside `card` names, with their
/// hashes now; empty with no proposal (or a link in its place).
fn proposed_sources(root: &Path, card: &str, sources: &[PathBuf]) -> BTreeMap<String, String> {
    let Some(stem) = card.strip_suffix(".html") else {
        return BTreeMap::new();
    };
    let path = root.join(format!("{stem}.proposed.html"));
    if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) {
        return BTreeMap::new();
    }
    let Ok(text) = std::fs::read_to_string(&path) else {
        return BTreeMap::new();
    };
    card::parse_marker(&text)
        .map(|m| m.source)
        .unwrap_or_default()
        .into_iter()
        .map(|s| {
            let hash = source_hash(sources, &s).unwrap_or_default();
            (s, hash)
        })
        .collect()
}

/// The component card `card`'s `<name>.css` and `<name>.prompt.md`, each
/// with its name, hashed together; empty for a layout or a card with
/// neither. A link is not read.
fn companion_hash(root: &Path, card: &str) -> String {
    let Some(stem) = card
        .strip_prefix("components/")
        .and_then(|c| c.strip_suffix(".html"))
    else {
        return String::new();
    };
    let mut bytes = Vec::new();
    for ext in ["css", "prompt.md"] {
        let path = root.join(format!("components/{stem}.{ext}"));
        if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let Ok(b) = std::fs::read(&path) else {
            continue;
        };
        bytes.extend_from_slice(ext.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&b);
        bytes.push(0);
    }
    if bytes.is_empty() {
        String::new()
    } else {
        sha16(&bytes)
    }
}

fn source_key(files: &BTreeMap<String, String>, exceptions: Option<&str>) -> String {
    let mut lines: String = files.iter().map(|(p, h)| format!("{p} {h}\n")).collect();
    if let Some(e) = exceptions {
        lines.push_str(&format!("exceptions {e}\n"));
    }
    sha16(lines.as_bytes())
}

/// The hash of `path` in the source projects. A path that more than one
/// project has could be any of them, so all their files count: a change in
/// either shows.
fn source_hash(sources: &[PathBuf], path: &str) -> Option<String> {
    let hashes: Vec<String> = sources
        .iter()
        .filter_map(|root| std::fs::read(root.join(path)).ok())
        .map(|b| sha16(&b))
        .collect();
    match hashes.as_slice() {
        [] => None,
        [one] => Some(one.clone()),
        many => Some(sha16(many.join("\n").as_bytes())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CARD: &str = "<!-- @dsCard group=\"Buttons\" name=\"Button\" source=\"src/ui.tsx\" -->\n<!doctype html>\n<button class=\"btn\">Run</button>\n";
    const UI: &str = "export const Button = () => null;\n";

    fn files(root: &Path, files: &[(&str, &str)]) {
        for (path, text) in files {
            let p = root.join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
    }

    #[test]
    fn the_anchor_records_each_cards_sources_and_body_hashes() {
        let (system, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        files(
            system.path(),
            &[("components/buttons/button/button.html", CARD)],
        );
        files(project.path(), &[("src/ui.tsx", UI)]);
        write(
            system.path(),
            &[project.path().to_path_buf()],
            &BTreeMap::new(),
        )
        .unwrap();
        let json: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(system.path().join("_ds_sync.json")).unwrap(),
        )
        .unwrap();
        // Hashes from `shasum -a 256 | cut -c1-16` of the source, the card
        // after its first line, and "src/ui.tsx <source hash>\n".
        assert_eq!(
            json["cards"]["components/buttons/button/button.html"],
            serde_json::json!({
                "source_key": "5ced44ca6deea951",
                "render_hash": "2a44852357b524ea",
                "sources": { "src/ui.tsx": "101086c04aac0612" }
            })
        );
    }

    #[test]
    fn a_cards_css_or_prompt_edited_by_hand_makes_it_edited_by_hand() {
        let (system, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        files(
            system.path(),
            &[
                ("components/buttons/button/button.html", CARD),
                (
                    "components/buttons/button/button.css",
                    ".btn { color: var(--color-accent); }\n",
                ),
                ("components/buttons/button/button.prompt.md", "A button.\n"),
            ],
        );
        files(project.path(), &[("src/ui.tsx", UI)]);
        let sources = [project.path().to_path_buf()];
        let edited = || {
            status(system.path(), &sources, &BTreeMap::new())
                .unwrap()
                .into_iter()
                .map(|s| (s.path, s.edited_by_hand))
                .collect::<Vec<_>>()
        };
        for (file, text) in [
            (
                "components/buttons/button/button.css",
                ".btn { color: red; }\n",
            ),
            (
                "components/buttons/button/button.prompt.md",
                "A button, mine.\n",
            ),
        ] {
            write(system.path(), &sources, &BTreeMap::new()).unwrap();
            assert_eq!(edited(), vec![]);
            files(system.path(), &[(file, text)]);
            assert_eq!(
                edited(),
                vec![("components/buttons/button/button.html".to_string(), true)],
                "{file} edited"
            );
        }
    }

    #[test]
    fn a_later_look_tells_out_of_date_edited_orphaned_and_new_cards_apart() {
        let (system, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let card = |group: &str, name: &str, source: &str, body: &str| {
            format!(
                "<!-- @dsCard group=\"{group}\" name=\"{name}\" source=\"{source}\" -->\n<!doctype html>\n{body}\n"
            )
        };
        files(
            system.path(),
            &[
                (
                    "components/buttons/button/button.html",
                    &card("Buttons", "Button", "src/ui.tsx", "<button>Run</button>"),
                ),
                (
                    "components/custom/session-row/session-row.html",
                    &card("Custom", "Session row", "src/Sidebar.tsx", "<div>row</div>"),
                ),
                (
                    "components/custom/toolbar/toolbar.html",
                    &card("Custom", "Toolbar", "src/Toolbar.tsx", "<div>bar</div>"),
                ),
                (
                    "components/forms/field/field.html",
                    &card("Forms", "Field", "src/field.tsx", "<input>"),
                ),
            ],
        );
        files(
            project.path(),
            &[
                ("src/ui.tsx", UI),
                ("src/Sidebar.tsx", "sidebar\n"),
                ("src/Toolbar.tsx", "toolbar\n"),
                ("src/field.tsx", "field\n"),
            ],
        );
        let sources = [project.path().to_path_buf()];
        write(system.path(), &sources, &BTreeMap::new()).unwrap();
        assert_eq!(
            status(system.path(), &sources, &BTreeMap::new()).unwrap(),
            vec![]
        );

        // The source of Button changed; Session row was edited by hand;
        // Toolbar's source is gone; Field moved to another group (only its
        // marker changed); Kbd is new.
        files(
            project.path(),
            &[("src/ui.tsx", "export const Button = () => \"run\";\n")],
        );
        std::fs::remove_file(project.path().join("src/Toolbar.tsx")).unwrap();
        files(
            system.path(),
            &[
                (
                    "components/custom/session-row/session-row.html",
                    &card(
                        "Custom",
                        "Session row",
                        "src/Sidebar.tsx",
                        "<div style=\"height:40px\">row</div>",
                    ),
                ),
                (
                    "components/forms/field/field.html",
                    &card("Inputs", "Field", "src/field.tsx", "<input>"),
                ),
                (
                    "components/forms/kbd/kbd.html",
                    &card("Forms", "Kbd", "src/ui.tsx", "<kbd>⌘K</kbd>"),
                ),
            ],
        );
        let s =
            |path: &str, changed: &[&str], edited: bool, orphaned: bool, new: bool| CardStatus {
                path: path.into(),
                changed_sources: changed.iter().map(|c| c.to_string()).collect(),
                edited_by_hand: edited,
                orphaned,
                new,
                exceptions_changed: false,
            };
        assert_eq!(
            status(system.path(), &sources, &BTreeMap::new()).unwrap(),
            vec![
                s(
                    "components/buttons/button/button.html",
                    &["src/ui.tsx"],
                    false,
                    false,
                    false
                ),
                s(
                    "components/custom/session-row/session-row.html",
                    &[],
                    true,
                    false,
                    false
                ),
                s(
                    "components/custom/toolbar/toolbar.html",
                    &["src/Toolbar.tsx"],
                    false,
                    true,
                    false
                ),
                s("components/forms/kbd/kbd.html", &[], false, false, true),
            ]
        );
    }

    #[test]
    fn the_anchor_hashes_styles_docs_and_files_and_a_style_change_keeps_the_cards() {
        let (system, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        files(
            system.path(),
            &[
                ("styles.css", "@import \"components.css\";\n"),
                ("components.css", ".btn { color: red; }\n"),
                ("components/buttons/button/button.html", CARD),
                (".cache/render-check.json", "{}\n"),
            ],
        );
        files(project.path(), &[("src/ui.tsx", UI)]);
        let sources = [project.path().to_path_buf()];
        write(system.path(), &sources, &BTreeMap::new()).unwrap();
        let json: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(system.path().join("_ds_sync.json")).unwrap(),
        )
        .unwrap();
        // From `shasum -a 256 | cut -c1-16`: style_sha of "components.css\0<bytes>styles.css\0<bytes>",
        // aux_sha of nothing, and each file's bytes.
        assert_eq!(json["style_sha"], "f9da201cb900b445");
        assert_eq!(json["aux_sha"], "e3b0c44298fc1c14");
        assert_eq!(json["files"]["styles.css"], "cac5bb5db4cc3541");
        assert_eq!(json["files"]["components.css"], "65387f643c7fbb93");
        assert_eq!(
            json["files"]["components/buttons/button/button.html"]
                .as_str()
                .map(str::len),
            Some(16)
        );
        assert!(json["files"].get(".cache/render-check.json").is_none());

        files(
            system.path(),
            &[("components.css", ".btn { color: blue; }\n")],
        );
        assert_ne!(
            compute(system.path(), &sources, &BTreeMap::new())
                .unwrap()
                .style_sha,
            "f9da201cb900b445"
        );
        assert_eq!(
            status(system.path(), &sources, &BTreeMap::new()).unwrap(),
            vec![]
        );
    }

    #[test]
    fn a_dropped_source_or_a_broken_marker_still_shows_and_symlinked_folders_are_not_followed() {
        let (system, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        files(
            system.path(),
            &[
                (
                    "components/buttons/button/button.html",
                    "<!-- @dsCard group=\"Buttons\" source=\"src/ui.tsx,src/icon.tsx\" -->\n<button>Run</button>\n",
                ),
                (
                    "components/forms/field/field.html",
                    "<!-- @dsCard group=\"Forms\" source=\"src/field.tsx\" -->\n<input>\n",
                ),
            ],
        );
        files(
            project.path(),
            &[
                ("src/ui.tsx", UI),
                ("src/icon.tsx", "icon\n"),
                ("src/field.tsx", "field\n"),
            ],
        );
        // A folder that links back to the system: scans must not loop through it.
        std::os::unix::fs::symlink(system.path(), system.path().join("components/loop")).unwrap();
        let sources = [project.path().to_path_buf()];
        write(system.path(), &sources, &BTreeMap::new()).unwrap();
        assert!(
            !compute(system.path(), &sources, &BTreeMap::new())
                .unwrap()
                .files
                .keys()
                .any(|k| k.starts_with("components/loop"))
        );

        files(
            system.path(),
            &[
                (
                    "components/buttons/button/button.html",
                    "<!-- @dsCard group=\"Buttons\" source=\"src/ui.tsx\" -->\n<button>Run</button>\n",
                ),
                (
                    "components/forms/field/field.html",
                    "<!-- @dsCard Forms -->\n<input>\n",
                ),
            ],
        );
        let got: Vec<(String, Vec<String>, bool)> =
            status(system.path(), &sources, &BTreeMap::new())
                .unwrap()
                .into_iter()
                .map(|s| (s.path, s.changed_sources, s.edited_by_hand))
                .collect();
        assert_eq!(
            got,
            vec![
                (
                    "components/buttons/button/button.html".into(),
                    vec!["src/icon.tsx".into()],
                    false
                ),
                (
                    "components/forms/field/field.html".into(),
                    vec!["src/field.tsx".into()],
                    false
                ),
            ]
        );
    }

    #[test]
    fn a_card_whose_marker_broke_and_whose_sources_are_gone_is_orphaned() {
        let (system, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        files(
            system.path(),
            &[("components/buttons/button/button.html", CARD)],
        );
        files(project.path(), &[("src/ui.tsx", UI)]);
        let sources = [project.path().to_path_buf()];
        write(system.path(), &sources, &BTreeMap::new()).unwrap();

        files(
            system.path(),
            &[(
                "components/buttons/button/button.html",
                "<!-- @dsCard Buttons -->\n<!doctype html>\n<button class=\"btn\">Run</button>\n",
            )],
        );
        std::fs::remove_file(project.path().join("src/ui.tsx")).unwrap();
        assert_eq!(
            status(system.path(), &sources, &BTreeMap::new()).unwrap(),
            vec![CardStatus {
                path: "components/buttons/button/button.html".into(),
                changed_sources: vec!["src/ui.tsx".into()],
                edited_by_hand: false,
                orphaned: true,
                new: false,
                exceptions_changed: false,
            }]
        );
    }

    #[test]
    fn a_missing_anchor_makes_every_card_new_and_an_unreadable_or_malformed_one_is_an_error() {
        let (system, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        files(
            system.path(),
            &[("components/buttons/button/button.html", CARD)],
        );
        files(project.path(), &[("src/ui.tsx", UI)]);
        let sources = [project.path().to_path_buf()];
        assert_eq!(
            status(system.path(), &sources, &BTreeMap::new()).unwrap(),
            vec![CardStatus {
                path: "components/buttons/button/button.html".into(),
                changed_sources: vec![],
                edited_by_hand: false,
                orphaned: false,
                new: true,
                exceptions_changed: false,
            }]
        );

        // An anchor that cannot be read is not one that was never written.
        std::fs::create_dir(system.path().join("_ds_sync.json")).unwrap();
        assert!(status(system.path(), &sources, &BTreeMap::new()).is_err());

        std::fs::remove_dir(system.path().join("_ds_sync.json")).unwrap();
        files(system.path(), &[("_ds_sync.json", "{\"cards\": ")]);
        assert!(status(system.path(), &sources, &BTreeMap::new()).is_err());
    }

    #[test]
    fn a_changed_card_exception_makes_the_card_out_of_date() {
        let (system, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        files(
            system.path(),
            &[("components/buttons/button/button.html", CARD)],
        );
        files(project.path(), &[("src/ui.tsx", UI)]);
        let sources = [project.path().to_path_buf()];
        let card = "components/buttons/button/button.html".to_string();
        let before = BTreeMap::from([(card.clone(), "mode = \"column\"".to_string())]);
        write(system.path(), &sources, &before).unwrap();
        assert_eq!(status(system.path(), &sources, &before).unwrap(), vec![]);
        let after = BTreeMap::from([(card.clone(), "mode = \"single\"".to_string())]);
        let got = status(system.path(), &sources, &after).unwrap();
        assert_eq!(got.len(), 1);
        assert!(
            got[0].exceptions_changed
                && got[0].changed_sources.is_empty()
                && !got[0].edited_by_hand
        );
        // With no exception at all, the key is the one `shasum` gave for the sources alone.
        assert_eq!(
            compute(system.path(), &sources, &BTreeMap::new())
                .unwrap()
                .cards[&card]
                .source_key,
            "5ced44ca6deea951"
        );
    }

    #[test]
    fn a_path_in_two_source_projects_is_out_of_date_when_either_changes() {
        let (system, web, admin) = (
            tempfile::tempdir().unwrap(),
            tempfile::tempdir().unwrap(),
            tempfile::tempdir().unwrap(),
        );
        files(
            system.path(),
            &[("components/buttons/button/button.html", CARD)],
        );
        files(web.path(), &[("src/ui.tsx", UI)]);
        files(
            admin.path(),
            &[("src/ui.tsx", "export const Button = () => \"admin\";\n")],
        );
        let sources = [web.path().to_path_buf(), admin.path().to_path_buf()];
        write(system.path(), &sources, &BTreeMap::new()).unwrap();
        assert_eq!(
            status(system.path(), &sources, &BTreeMap::new()).unwrap(),
            vec![]
        );
        files(
            admin.path(),
            &[("src/ui.tsx", "export const Button = () => \"admin 2\";\n")],
        );
        let got = status(system.path(), &sources, &BTreeMap::new()).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].changed_sources, vec!["src/ui.tsx".to_string()]);
    }
}
