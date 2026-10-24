//! `_ds_sync.json` (X64), the re-sync anchor, as design-sync's: per card, a
//! hash of each source file it was made from and a hash of its HTML without
//! the marker line. Comparing it with the folder and the sources now tells
//! which cards are out of date, edited by hand, orphaned or new.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
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
    /// Each source file, relative to its project, and its hash.
    pub sources: BTreeMap<String, String>,
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
pub fn write(root: &Path, sources: &[PathBuf]) -> Result<()> {
    let json = serde_json::to_string_pretty(&compute(root, sources)?)?;
    std::fs::write(root.join(FILE), json + "\n")?;
    Ok(())
}

/// The anchor as it would be written now.
pub fn compute(root: &Path, sources: &[PathBuf]) -> Result<Anchor> {
    let mut cards = BTreeMap::new();
    for path in html_files(root) {
        let rel_path = rel(root, &path);
        if !(rel_path.starts_with("components/") || rel_path.starts_with("ui_kits/"))
            || rel_path.ends_with(".proposed.html")
        {
            continue;
        }
        let text = std::fs::read_to_string(&path)?;
        // A card whose marker broke stays in the anchor, with no sources, so
        // its status still shows what it was made from.
        let source = card::parse_marker(&text)
            .map(|m| m.source)
            .unwrap_or_default();
        let files: BTreeMap<String, String> = source
            .iter()
            .map(|s| (s.clone(), source_hash(sources, s).unwrap_or_default()))
            .collect();
        cards.insert(
            rel_path,
            CardAnchor {
                source_key: source_key(&files),
                render_hash: render_hash(&text),
                sources: files,
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
}

/// The cards that changed since `_ds_sync.json` was written, by path.
pub fn status(root: &Path, sources: &[PathBuf]) -> Result<Vec<CardStatus>> {
    let anchored: Anchor = match std::fs::read_to_string(root.join(FILE)) {
        Ok(text) => serde_json::from_str(&text)?,
        Err(_) => Anchor {
            cards: BTreeMap::new(),
            style_sha: String::new(),
            aux_sha: String::new(),
            files: BTreeMap::new(),
        },
    };
    let mut out = Vec::new();
    for (path, now) in compute(root, sources)?.cards {
        let mut st = CardStatus {
            path: path.clone(),
            changed_sources: Vec::new(),
            edited_by_hand: false,
            orphaned: false,
            new: false,
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
                st.edited_by_hand = now.render_hash != then.render_hash;
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
        if !st.changed_sources.is_empty() || st.edited_by_hand || st.orphaned || st.new {
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

fn source_key(files: &BTreeMap<String, String>) -> String {
    let lines: String = files.iter().map(|(p, h)| format!("{p} {h}\n")).collect();
    sha16(lines.as_bytes())
}

/// The hash of `path` in the first source project that has it.
fn source_hash(sources: &[PathBuf], path: &str) -> Option<String> {
    sources
        .iter()
        .find_map(|root| std::fs::read(root.join(path)).ok())
        .map(|b| sha16(&b))
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
        write(system.path(), &[project.path().to_path_buf()]).unwrap();
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
        write(system.path(), &sources).unwrap();
        assert_eq!(status(system.path(), &sources).unwrap(), vec![]);

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
            };
        assert_eq!(
            status(system.path(), &sources).unwrap(),
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
        write(system.path(), &sources).unwrap();
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
            compute(system.path(), &sources).unwrap().style_sha,
            "f9da201cb900b445"
        );
        assert_eq!(status(system.path(), &sources).unwrap(), vec![]);
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
        write(system.path(), &sources).unwrap();
        assert!(
            !compute(system.path(), &sources)
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
        let got: Vec<(String, Vec<String>, bool)> = status(system.path(), &sources)
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
        write(system.path(), &sources).unwrap();

        files(
            system.path(),
            &[(
                "components/buttons/button/button.html",
                "<!-- @dsCard Buttons -->\n<!doctype html>\n<button class=\"btn\">Run</button>\n",
            )],
        );
        std::fs::remove_file(project.path().join("src/ui.tsx")).unwrap();
        assert_eq!(
            status(system.path(), &sources).unwrap(),
            vec![CardStatus {
                path: "components/buttons/button/button.html".into(),
                changed_sources: vec!["src/ui.tsx".into()],
                edited_by_hand: false,
                orphaned: true,
                new: false,
            }]
        );
    }
}
