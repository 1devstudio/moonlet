//! A workspace design's history (X65): snapshots of its `pages/` and
//! `assets/`, each in `history/<n>/` with a record of when it was taken,
//! what took it, what changed and its files.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use moonlet_proto::types::{DesignSnapshot, SnapshotFrom, SnapshotKind};

use super::fsx;
use super::store::Store;
use crate::hash::sha256_hex;

/// The folder of a design's snapshots.
pub const HISTORY_DIR: &str = "history";

/// A snapshot's record, in its folder.
pub const RECORD_FILE: &str = "snapshot.json";

/// How many snapshots a design keeps: the newest. X65 puts it in
/// `~/.moonlet/settings.toml` as `[design] snapshot_keep`, a file moonlet
/// does not have yet, so it is this constant until it does.
pub const SNAPSHOT_KEEP: usize = 50;

/// The folders a snapshot keeps.
const KEPT: [&str; 2] = ["pages", "assets"];

/// A snapshot a design does not have (any more).
#[derive(Debug, thiserror::Error)]
#[error("no snapshot {0}")]
pub struct NoSnapshot(pub u32);

/// What takes a snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Take {
    /// The design's agent ended a turn.
    AgentTurn,
    /// Edits by hand stopped for a while; what each did, as the app said
    /// with its saves (`moved section m24`).
    EditsByHand(Vec<String>),
}

/// `history/<n>/snapshot.json`: the snapshot as listed, and its files with
/// the SHA-256 of each, in hex, by their paths in the design's folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Record {
    n: u32,
    time: u64,
    #[serde(rename = "type")]
    kind: SnapshotKind,
    #[serde(default)]
    summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    from: Option<SnapshotFrom>,
    #[serde(default)]
    files: BTreeMap<String, String>,
}

impl Record {
    fn listed(&self) -> DesignSnapshot {
        DesignSnapshot {
            n: self.n,
            time: self.time,
            kind: self.kind,
            summary: self.summary.clone(),
            from: self.from,
            pages: page_names(self.files.keys()),
        }
    }
}

impl Store {
    /// Takes a snapshot of a design's `pages/` and `assets/` when anything
    /// in them changed since the last one, compared by the SHA-256 of each
    /// file; `None` when nothing did. The newest [`SNAPSHOT_KEEP`] are kept.
    /// Read and written through the designs folder as a handle, never
    /// through a link. The daemon takes one snapshot of a design at a time.
    pub fn take_snapshot(
        &self,
        workspace: &str,
        slug: &str,
        take: Take,
        now: u64,
    ) -> Result<Option<DesignSnapshot>> {
        let designs = self.designs_of(workspace, slug)?;
        let files = current_files(&designs, slug)?;
        let hashes = hashes_of(&files);
        let records = records(&designs, slug)?;
        let last = records.last().map(|r| &r.files);
        if last.unwrap_or(&BTreeMap::new()) == &hashes {
            return Ok(None);
        }
        let summary = match &take {
            Take::EditsByHand(edits) if !edits.is_empty() => edits_summary(edits),
            _ => files_summary(last, &hashes),
        };
        let kind = match take {
            Take::AgentTurn => SnapshotKind::AgentTurn,
            Take::EditsByHand(_) => SnapshotKind::EditsByHand,
        };
        let record = Record {
            n: next_n(&designs, slug)?,
            time: now,
            kind,
            summary,
            from: None,
            files: hashes,
        };
        write_snapshot(&designs, slug, &record, &files)?;
        rotate(&designs, slug, SNAPSHOT_KEEP)?;
        Ok(Some(record.listed()))
    }

    /// Makes snapshot `n` the design's `pages/` and `assets/`, after keeping
    /// what is not kept yet as `unkept` takes it: its files written exactly
    /// as kept, through the designs folder as a handle, and
    /// every other file there that is not hidden removed (a link as a
    /// link). Then records a **Restored snapshot** entry holding them, so
    /// the next snapshot compares with what was restored. A snapshot whose
    /// files no longer match its record is refused before anything is
    /// written. The daemon takes no snapshot and saves no page meanwhile.
    pub fn restore_snapshot(
        &self,
        workspace: &str,
        slug: &str,
        n: u32,
        unkept: Take,
        now: u64,
    ) -> Result<DesignSnapshot> {
        let designs = self.designs_of(workspace, slug)?;
        let from = records(&designs, slug)?
            .into_iter()
            .find(|r| r.n == n)
            .ok_or(NoSnapshot(n))?;
        let kept = snapshot_rel(slug, n);
        let mut files = BTreeMap::new();
        for (path, hash) in &from.files {
            let bytes = fsx::read_file_inside(&designs, &kept.join(path))?;
            if &sha256_hex(&bytes) != hash {
                bail!("snapshot {n}'s {path} is not as it was kept");
            }
            files.insert(path.clone(), bytes);
        }
        // Snapshot n is read first: keeping what is not kept yet may rotate
        // it out of the newest 50.
        self.take_snapshot(workspace, slug, unkept, now)?;
        // Its number before any file is written: none left writes nothing.
        let n_restored = next_n(&designs, slug)?;
        for folder in KEPT {
            let prefix = format!("{folder}/");
            let inside: BTreeMap<String, Vec<u8>> = files
                .iter()
                .filter_map(|(p, b)| Some((p.strip_prefix(&prefix)?.to_string(), b.clone())))
                .collect();
            fsx::write_tree(&designs, Path::new(slug), Path::new(folder), &inside, true)?;
        }
        let record = Record {
            n: n_restored,
            time: now,
            kind: SnapshotKind::Restored,
            summary: String::new(),
            from: Some(SnapshotFrom {
                n: from.n,
                time: from.time,
            }),
            files: from.files.clone(),
        };
        write_snapshot(&designs, slug, &record, &files)?;
        rotate(&designs, slug, SNAPSHOT_KEEP)?;
        Ok(record.listed())
    }

    /// A design's snapshots, newest first. One whose record cannot be read
    /// is left out.
    pub fn history(&self, workspace: &str, slug: &str) -> Result<Vec<DesignSnapshot>> {
        let designs = self.designs_of(workspace, slug)?;
        Ok(records(&designs, slug)?
            .iter()
            .rev()
            .map(Record::listed)
            .collect())
    }
}

/// Where `design.file` finds a file of a snapshot the canvas previews:
/// `designs/<slug>@<n>/<pages or assets>/…`, as deep as the design's own
/// folder, so a page's relative links (`../assets/`, and
/// `../../../systems/<system>/styles.css`) resolve as they do for the
/// design's own pages, is `designs/<slug>/history/<n>/…`. `None` for any
/// other path; an error for a `<slug>@…` that is not one of a snapshot's
/// files. The app builds it (`snapshotPageUrl` in `lib/designView.ts`).
pub fn snapshot_file(rel: &str) -> Result<Option<String>> {
    let mut parts = rel.split('/');
    let (Some("designs"), Some(folder)) = (parts.next(), parts.next()) else {
        return Ok(None);
    };
    let Some((slug, n)) = folder.split_once('@') else {
        return Ok(None);
    };
    let rest: Vec<&str> = parts.collect();
    let numbered = is_number(n);
    // Only down into the snapshot's pages or assets, never out of them.
    let kept = rest.len() >= 2
        && KEPT.contains(&rest[0])
        && rest
            .iter()
            .all(|p| !p.is_empty() && *p != "." && *p != "..");
    if !super::store::is_name(slug) || !numbered || !kept {
        bail!("{rel} is no file of a snapshot");
    }
    Ok(Some(format!(
        "designs/{slug}/{HISTORY_DIR}/{n}/{}",
        rest.join("/")
    )))
}

/// `<slug>/history`, inside the designs folder.
fn history_rel(slug: &str) -> PathBuf {
    Path::new(slug).join(HISTORY_DIR)
}

/// `<slug>/history/<n>`, snapshot `n`'s folder inside the designs folder.
fn snapshot_rel(slug: &str, n: u32) -> PathBuf {
    history_rel(slug).join(n.to_string())
}

/// A snapshot's number as its folder names it: digits only, at least one,
/// with no leading zero (`0` only on its own) and within a `u32`, so each
/// number has one folder, never `01` beside `1`.
fn is_number(text: &str) -> bool {
    text.parse::<u32>().is_ok_and(|n| n.to_string() == text)
}

/// The design's `pages/` and `assets/` files, by their paths in its folder.
fn current_files(designs: &Path, slug: &str) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut out = BTreeMap::new();
    for folder in KEPT {
        for (path, bytes) in fsx::read_tree(designs, &Path::new(slug).join(folder))? {
            out.insert(format!("{folder}/{path}"), bytes);
        }
    }
    Ok(out)
}

fn hashes_of(files: &BTreeMap<String, Vec<u8>>) -> BTreeMap<String, String> {
    files
        .iter()
        .map(|(path, bytes)| (path.clone(), sha256_hex(bytes)))
        .collect()
}

/// The numbers of the snapshot folders, `history/<n>`, ascending.
fn numbers(designs: &Path, slug: &str) -> Result<Vec<u32>> {
    let folder = designs.join(history_rel(slug));
    // A link is no history: never listed through.
    if std::fs::symlink_metadata(&folder).is_ok_and(|m| !m.is_dir()) {
        return Ok(Vec::new());
    }
    let entries = match std::fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("cannot read {}", folder.display())),
    };
    let mut out: Vec<u32> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            is_number(&name).then(|| name.parse().ok())?
        })
        .collect();
    out.sort_unstable();
    Ok(out)
}

/// The number after the highest snapshot folder's, so none is given twice;
/// an error once the highest is the last a `u32` holds, never 0 again.
fn next_n(designs: &Path, slug: &str) -> Result<u32> {
    match numbers(designs, slug)?.last() {
        None => Ok(1),
        Some(n) => n
            .checked_add(1)
            .with_context(|| format!("{slug} has no snapshot number left")),
    }
}

/// The snapshots whose record can be read, oldest first. The folder's
/// number is the snapshot's: a record naming another is damaged, and left
/// out as one that cannot be read is.
fn records(designs: &Path, slug: &str) -> Result<Vec<Record>> {
    let mut out = Vec::new();
    for n in numbers(designs, slug)? {
        let rel = snapshot_rel(slug, n).join(RECORD_FILE);
        let Ok(text) = fsx::read_file_inside(designs, &rel) else {
            continue;
        };
        match serde_json::from_slice::<Record>(&text) {
            Ok(record) if record.n == n => out.push(record),
            _ => {}
        }
    }
    Ok(out)
}

/// Writes snapshot `record` with `files` into `history/<n>/`, its record
/// last, so a snapshot cut short has none and is not listed.
fn write_snapshot(
    designs: &Path,
    slug: &str,
    record: &Record,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<()> {
    let rel = Path::new(HISTORY_DIR).join(record.n.to_string());
    let record_file = BTreeMap::from([(
        RECORD_FILE.to_string(),
        format!("{}\n", serde_json::to_string_pretty(record)?).into_bytes(),
    )]);
    // Never the design's folder itself: one removed meanwhile stays so.
    let design = Path::new(slug);
    let written = fsx::write_tree(designs, design, &rel, files, false)
        .and_then(|()| fsx::write_tree(designs, design, &rel, &record_file, false));
    if let Err(e) = written {
        let _ = fsx::remove_dir_inside(designs, &designs.join(snapshot_rel(slug, record.n)));
        return Err(e);
    }
    Ok(())
}

/// Removes all but the newest `keep` snapshots.
fn rotate(designs: &Path, slug: &str, keep: usize) -> Result<()> {
    let numbers = numbers(designs, slug)?;
    let old = numbers.len().saturating_sub(keep);
    for n in &numbers[..old] {
        fsx::remove_dir_inside(designs, &designs.join(snapshot_rel(slug, *n)))?;
    }
    Ok(())
}

/// The pages among a snapshot's files (`pages/<page>.html`), `index` first,
/// then by name.
fn page_names<'a>(paths: impl Iterator<Item = &'a String>) -> Vec<String> {
    let mut pages: Vec<String> = paths
        .filter_map(|p| p.strip_prefix("pages/")?.strip_suffix(".html"))
        .filter(|p| super::pages::is_page_name(p))
        .map(String::from)
        .collect();
    pages.sort_by(|a, b| (a != "index", a).cmp(&(b != "index", b)));
    pages
}

/// The first `most` of `items`, and how many more there are.
fn capped(items: &[String], most: usize) -> (&[String], usize) {
    let shown = &items[..items.len().min(most)];
    (shown, items.len() - shown.len())
}

/// `shown` joined with commas, then "and 2 more" when there are more.
fn with_more(shown: &[String], more: usize) -> String {
    format!("{} and {more} more", shown.join(", "))
}

/// "a", "a and b", "a, b and c"; past `most`, "a, b, c and 2 more".
fn listing(items: &[String], most: usize) -> String {
    match capped(items, most) {
        (shown, more) if more > 0 => with_more(shown, more),
        ([], _) => String::new(),
        ([one], _) => one.clone(),
        (shown, _) => format!(
            "{} and {}",
            shown[..shown.len() - 1].join(", "),
            shown[shown.len() - 1]
        ),
    }
}

/// `text` with its first letter in capitals.
fn capitalised(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// What an agent's turn changed, from the files of the snapshot before it
/// (`before`) and its own: "Wrote git-a.html and git-b.html · 3 pages",
/// with the pages removed and the assets changed.
fn files_summary(
    before: Option<&BTreeMap<String, String>>,
    after: &BTreeMap<String, String>,
) -> String {
    let empty = BTreeMap::new();
    let before = before.unwrap_or(&empty);
    let in_pages = |p: &String| p.strip_prefix("pages/").map(String::from);
    let written: Vec<String> = after
        .iter()
        .filter(|(p, h)| before.get(*p) != Some(h))
        .filter_map(|(p, _)| in_pages(p))
        .collect();
    let removed: Vec<String> = before
        .keys()
        .filter(|p| !after.contains_key(*p))
        .filter_map(in_pages)
        .collect();
    let assets = after
        .iter()
        .filter(|(p, h)| p.starts_with("assets/") && before.get(*p) != Some(h))
        .count()
        + before
            .keys()
            .filter(|p| p.starts_with("assets/") && !after.contains_key(*p))
            .count();
    let mut parts = Vec::new();
    if !written.is_empty() {
        parts.push(format!("wrote {}", listing(&written, 3)));
    }
    if !removed.is_empty() {
        parts.push(format!("removed {}", listing(&removed, 3)));
    }
    if assets > 0 {
        parts.push(format!(
            "changed {assets} {}",
            if assets == 1 { "asset" } else { "assets" }
        ));
    }
    let pages = page_names(after.keys()).len();
    format!(
        "{} · {pages} {}",
        capitalised(&parts.join(", ")),
        if pages == 1 { "page" } else { "pages" }
    )
}

/// How long one edit's description may be, in characters.
const EDIT_MAX: usize = 120;

/// What edits by hand did, from what the app said each did: "Moved section
/// m24, restyled h2 m25, text of m30", each once, at most five then how
/// many more.
pub fn edits_summary(edits: &[String]) -> String {
    let mut seen: Vec<String> = Vec::new();
    for e in edits {
        let e: String = e
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(EDIT_MAX)
            .collect();
        if !e.is_empty() && !seen.contains(&e) {
            seen.push(e);
        }
    }
    let shown = match capped(&seen, 5) {
        (shown, more) if more > 0 => with_more(shown, more),
        (shown, _) => shown.join(", "),
    };
    capitalised(&shown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use moonlet_proto::types::SnapshotKind;
    use std::path::{Path, PathBuf};

    /// A workspace with a design, `settings-page`, and its folder.
    fn store_with_design() -> (tempfile::TempDir, Store, PathBuf) {
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
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        let dir = home.path().join("design/w1/designs/settings-page");
        (home, store, dir)
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    const INDEX: &str =
        "<!doctype html>\n<body data-mid=\"m1\"><h1 data-mid=\"m2\">Settings</h1></body>\n";

    #[test]
    fn a_snapshot_is_taken_only_when_pages_or_assets_changed_since_the_last() {
        let (_home, store, dir) = store_with_design();
        // A new design has nothing to keep.
        assert_eq!(
            store
                .take_snapshot("w1", "settings-page", Take::AgentTurn, 1000)
                .unwrap(),
            None
        );
        write(&dir, "pages/index.html", INDEX);
        let first = store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 2000)
            .unwrap()
            .expect("a snapshot of the new page");
        assert_eq!(
            (first.n, first.time, first.kind, first.pages.clone()),
            (1, 2000, SnapshotKind::AgentTurn, vec!["index".to_string()])
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("history/1/pages/index.html")).unwrap(),
            INDEX
        );
        // Nothing changed since: none.
        assert_eq!(
            store
                .take_snapshot("w1", "settings-page", Take::AgentTurn, 3000)
                .unwrap(),
            None
        );
        // A file written again as it was is no change either.
        write(&dir, "pages/index.html", INDEX);
        assert_eq!(
            store
                .take_snapshot("w1", "settings-page", Take::EditsByHand(vec![]), 3500)
                .unwrap(),
            None
        );
        // An asset is.
        write(&dir, "assets/logo.svg", "<svg/>");
        let second = store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 4000)
            .unwrap()
            .expect("a snapshot of the new asset");
        assert_eq!(second.n, 2);
        assert_eq!(
            std::fs::read_to_string(dir.join("history/2/assets/logo.svg")).unwrap(),
            "<svg/>"
        );
        let listed: Vec<(u32, u64)> = store
            .history("w1", "settings-page")
            .unwrap()
            .iter()
            .map(|s| (s.n, s.time))
            .collect();
        assert_eq!(listed, [(2, 4000), (1, 2000)]);
    }

    #[test]
    fn the_newest_50_snapshots_are_kept_and_a_number_is_never_given_again() {
        let (_home, store, dir) = store_with_design();
        for i in 1..=51u64 {
            write(
                &dir,
                "pages/index.html",
                &format!("<p data-mid=\"m1\">{i}</p>"),
            );
            store
                .take_snapshot("w1", "settings-page", Take::AgentTurn, i * 1000)
                .unwrap()
                .expect("a change");
        }
        let listed: Vec<u32> = store
            .history("w1", "settings-page")
            .unwrap()
            .iter()
            .map(|s| s.n)
            .collect();
        assert_eq!(listed, (2..=51).rev().collect::<Vec<u32>>());
        assert!(!dir.join("history/1").exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("history/2/pages/index.html")).unwrap(),
            "<p data-mid=\"m1\">2</p>"
        );
        write(&dir, "pages/index.html", "<p data-mid=\"m1\">52</p>");
        let next = store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 52_000)
            .unwrap()
            .unwrap();
        assert_eq!(next.n, 52);
        assert_eq!(store.history("w1", "settings-page").unwrap().len(), 50);
    }

    #[test]
    fn an_agent_turn_says_which_pages_it_wrote_and_edits_by_hand_say_what_each_did() {
        let (_home, store, dir) = store_with_design();
        let summary = |take: Take, now: u64| {
            store
                .take_snapshot("w1", "settings-page", take, now)
                .unwrap()
                .expect("a change")
                .summary
        };
        write(&dir, "pages/index.html", INDEX);
        assert_eq!(summary(Take::AgentTurn, 1), "Wrote index.html · 1 page");
        write(&dir, "pages/git-a.html", "<p>rows</p>");
        write(&dir, "pages/git-b.html", "<p>cards</p>");
        assert_eq!(
            summary(Take::AgentTurn, 2),
            "Wrote git-a.html and git-b.html · 3 pages"
        );
        std::fs::remove_file(dir.join("pages/git-b.html")).unwrap();
        write(&dir, "assets/logo.svg", "<svg/>");
        assert_eq!(
            summary(Take::AgentTurn, 3),
            "Removed git-b.html, changed 1 asset · 2 pages"
        );
        write(&dir, "pages/index.html", "<p>moved</p>");
        let edits = [
            "moved section m24",
            "restyled h2 m25",
            "moved section m24",
            "text of m30",
        ]
        .map(String::from);
        assert_eq!(
            summary(Take::EditsByHand(edits.to_vec()), 4),
            "Moved section m24, restyled h2 m25, text of m30"
        );
        // An app that said nothing: the files changed.
        write(&dir, "pages/index.html", "<p>again</p>");
        assert_eq!(
            summary(Take::EditsByHand(vec![]), 5),
            "Wrote index.html · 2 pages"
        );
        write(&dir, "pages/index.html", "<p>many</p>");
        let many = [
            "deleted p m1",
            "deleted p m2",
            "deleted p m3",
            "deleted p m4",
            "deleted p m5",
            "deleted p m6",
            "deleted p m7",
        ]
        .map(String::from);
        assert_eq!(
            summary(Take::EditsByHand(many.to_vec()), 6),
            "Deleted p m1, deleted p m2, deleted p m3, deleted p m4, deleted p m5 and 2 more"
        );
        let kinds: Vec<SnapshotKind> = store
            .history("w1", "settings-page")
            .unwrap()
            .iter()
            .map(|s| s.kind)
            .collect();
        assert_eq!(
            kinds[..3],
            [
                SnapshotKind::EditsByHand,
                SnapshotKind::EditsByHand,
                SnapshotKind::EditsByHand
            ]
        );
        assert_eq!(kinds[3], SnapshotKind::AgentTurn);
    }

    #[test]
    fn restoring_a_snapshot_writes_its_files_exactly_and_records_a_restored_entry() {
        let (_home, store, dir) = store_with_design();
        let v1 = "<!doctype html>\r\n<body data-mid=m1>\r\n<h1 data-mid=\"m2\">Settings &amp; more</h1>\r\n</body>";
        write(&dir, "pages/index.html", v1);
        write(&dir, "assets/img/a.svg", "<svg>a</svg>");
        store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 1000)
            .unwrap()
            .unwrap();
        write(&dir, "pages/index.html", "<p>v2</p>");
        write(&dir, "pages/git-a.html", "<p>rows</p>");
        std::fs::remove_file(dir.join("assets/img/a.svg")).unwrap();
        write(&dir, "assets/b.svg", "<svg>b</svg>");
        store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 2000)
            .unwrap()
            .unwrap();

        let restored = store
            .restore_snapshot("w1", "settings-page", 1, Take::EditsByHand(vec![]), 5000)
            .unwrap();
        assert_eq!(
            restored,
            DesignSnapshot {
                n: 3,
                time: 5000,
                kind: SnapshotKind::Restored,
                summary: String::new(),
                from: Some(moonlet_proto::types::SnapshotFrom { n: 1, time: 1000 }),
                pages: vec!["index".into()],
            }
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("pages/index.html")).unwrap(),
            v1
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("assets/img/a.svg")).unwrap(),
            "<svg>a</svg>"
        );
        assert!(!dir.join("pages/git-a.html").exists());
        assert!(!dir.join("assets/b.svg").exists());
        let listed: Vec<(u32, SnapshotKind)> = store
            .history("w1", "settings-page")
            .unwrap()
            .iter()
            .map(|s| (s.n, s.kind))
            .collect();
        assert_eq!(
            listed,
            [
                (3, SnapshotKind::Restored),
                (2, SnapshotKind::AgentTurn),
                (1, SnapshotKind::AgentTurn)
            ]
        );
        // As it is now: the next turn that changes nothing takes none.
        assert_eq!(
            store
                .take_snapshot("w1", "settings-page", Take::AgentTurn, 6000)
                .unwrap(),
            None
        );
        let err = store
            .restore_snapshot("w1", "settings-page", 9, Take::EditsByHand(vec![]), 7000)
            .unwrap_err();
        assert!(err.is::<NoSnapshot>(), "{err:#}");
    }

    #[test]
    fn a_snapshot_never_follows_a_link_into_or_out_of_the_design() {
        let (_home, store, dir) = store_with_design();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.html");
        std::fs::write(&secret, "secret").unwrap();
        write(&dir, "pages/index.html", INDEX);
        // A page and the assets folder that are links out of the design.
        std::os::unix::fs::symlink(&secret, dir.join("pages/linked.html")).unwrap();
        std::fs::remove_dir(dir.join("assets")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.join("assets")).unwrap();
        let taken = store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 1000)
            .unwrap()
            .unwrap();
        assert_eq!(taken.pages, ["index"]);
        assert!(!dir.join("history/1/pages/linked.html").exists());
        assert!(!dir.join("history/1/assets").exists());

        // Restoring replaces a page made a link, never writing through it,
        // and refuses to write into an assets folder that is a link.
        std::fs::remove_file(dir.join("assets")).unwrap();
        std::fs::create_dir(dir.join("assets")).unwrap();
        std::fs::remove_file(dir.join("pages/index.html")).unwrap();
        std::os::unix::fs::symlink(&secret, dir.join("pages/index.html")).unwrap();
        store
            .restore_snapshot("w1", "settings-page", 1, Take::EditsByHand(vec![]), 2000)
            .unwrap();
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "secret");
        assert!(
            !std::fs::symlink_metadata(dir.join("pages/index.html"))
                .unwrap()
                .is_symlink()
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("pages/index.html")).unwrap(),
            INDEX
        );
        // The link not in the snapshot is gone, as a link: its target stays.
        assert!(std::fs::symlink_metadata(dir.join("pages/linked.html")).is_err());
        assert!(secret.exists());

        // A history folder swapped for a link out of the design: nothing is
        // written there.
        let history = dir.join("history");
        std::fs::rename(&history, dir.join(".history")).unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), &history).unwrap();
        write(&dir, "pages/index.html", "<p>changed</p>");
        assert!(
            store
                .take_snapshot("w1", "settings-page", Take::AgentTurn, 3000)
                .is_err()
        );
        assert_eq!(std::fs::read_dir(elsewhere.path()).unwrap().count(), 0);
        assert_eq!(store.history("w1", "settings-page").unwrap(), []);
    }

    #[test]
    fn a_snapshots_files_are_served_at_its_designs_depth_so_its_links_resolve_as_the_pages_do() {
        let (_home, store, dir) = store_with_design();
        write(&dir, "pages/index.html", INDEX);
        write(&dir, "assets/logo.svg", "<svg/>");
        store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 1000)
            .unwrap()
            .unwrap();
        let real = |p: &Path| p.canonicalize().unwrap();
        // `designs/<slug>@<n>/` is snapshot n's folder, as deep as the
        // design's own: a page's `../assets/` and `../../../systems/` work.
        assert_eq!(
            real(
                &store
                    .resolve("w1", "designs/settings-page@1/pages/index.html")
                    .unwrap()
            ),
            real(&dir.join("history/1/pages/index.html"))
        );
        assert_eq!(
            real(
                &store
                    .resolve("w1", "designs/settings-page@1/assets/logo.svg")
                    .unwrap()
            ),
            real(&dir.join("history/1/assets/logo.svg"))
        );
        for bad in [
            "designs/settings-page@1/design.toml",
            "designs/settings-page@1/snapshot.json",
            "designs/settings-page@x/pages/index.html",
            "designs/settings-page@1/../../outside",
            "designs/@1/pages/index.html",
        ] {
            assert!(store.resolve("w1", bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_oldest_of_50_snapshots_is_restored_after_what_was_not_kept_is_kept() {
        let (_home, store, dir) = store_with_design();
        for i in 1..=50u64 {
            write(&dir, "pages/index.html", &format!("<p>{i}</p>"));
            store
                .take_snapshot("w1", "settings-page", Take::AgentTurn, i * 1000)
                .unwrap()
                .expect("a change");
        }
        write(&dir, "pages/index.html", "<p>by hand</p>");
        let edits = ["text of m1".to_string()];
        let restored = store
            .restore_snapshot(
                "w1",
                "settings-page",
                1,
                Take::EditsByHand(edits.to_vec()),
                60_000,
            )
            .unwrap();
        assert_eq!(
            (restored.n, restored.from),
            (
                52,
                Some(moonlet_proto::types::SnapshotFrom { n: 1, time: 1000 })
            )
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("pages/index.html")).unwrap(),
            "<p>1</p>"
        );
        let listed: Vec<(u32, SnapshotKind, String)> = store
            .history("w1", "settings-page")
            .unwrap()
            .into_iter()
            .map(|s| (s.n, s.kind, s.summary))
            .collect();
        assert_eq!(listed.len(), 50);
        assert_eq!(
            listed[..2],
            [
                (52, SnapshotKind::Restored, String::new()),
                (51, SnapshotKind::EditsByHand, "Text of m1".to_string())
            ]
        );
    }

    #[test]
    fn a_snapshot_folder_is_one_only_under_its_numbers_own_name() {
        let (_home, store, dir) = store_with_design();
        write(&dir, "pages/index.html", INDEX);
        store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 1000)
            .unwrap()
            .unwrap();
        // The same snapshot again under names that also read as 1 and 0.
        let record = std::fs::read_to_string(dir.join("history/1/snapshot.json")).unwrap();
        for other in ["01", "001", "00"] {
            write(&dir, &format!("history/{other}/pages/index.html"), INDEX);
            write(&dir, &format!("history/{other}/snapshot.json"), &record);
        }
        let listed = |store: &Store| -> Vec<u32> {
            store
                .history("w1", "settings-page")
                .unwrap()
                .iter()
                .map(|s| s.n)
                .collect()
        };
        assert_eq!(listed(&store), [1]);
        // Nor is it served as one.
        assert!(
            store
                .resolve("w1", "designs/settings-page@01/pages/index.html")
                .is_err()
        );
        // 50 more: snapshot 1 is rotated out, and the others are left alone.
        for i in 2..=51u64 {
            write(&dir, "pages/index.html", &format!("<p>{i}</p>"));
            store
                .take_snapshot("w1", "settings-page", Take::AgentTurn, i * 1000)
                .unwrap()
                .expect("a change");
        }
        assert_eq!(listed(&store), (2..=51).rev().collect::<Vec<u32>>());
        assert!(!dir.join("history/1").exists());
        for other in ["01", "001", "00"] {
            assert!(dir.join("history").join(other).exists(), "{other}");
        }
    }

    #[test]
    fn a_snapshot_after_the_last_number_fails_rather_than_wrap_to_zero() {
        let (_home, store, dir) = store_with_design();
        write(&dir, "pages/index.html", INDEX);
        store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 1000)
            .unwrap()
            .unwrap();
        write(&dir, "pages/index.html", "<p>changed</p>");
        store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 2000)
            .unwrap()
            .unwrap();
        // Snapshot 2 made the last number there is.
        let record = std::fs::read_to_string(dir.join("history/2/snapshot.json")).unwrap();
        std::fs::rename(dir.join("history/2"), dir.join("history/4294967295")).unwrap();
        write(
            &dir,
            "history/4294967295/snapshot.json",
            &record.replace("\"n\": 2,", "\"n\": 4294967295,"),
        );
        // Nothing changed: no number is needed.
        assert_eq!(
            store
                .take_snapshot("w1", "settings-page", Take::AgentTurn, 3000)
                .unwrap(),
            None
        );
        write(&dir, "pages/index.html", "<p>third</p>");
        let err = store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 4000)
            .unwrap_err();
        assert_eq!(err.to_string(), "settings-page has no snapshot number left");
        // A restore with nothing to keep first writes nothing either.
        write(&dir, "pages/index.html", "<p>changed</p>");
        let err = store
            .restore_snapshot("w1", "settings-page", 1, Take::AgentTurn, 5000)
            .unwrap_err();
        assert_eq!(err.to_string(), "settings-page has no snapshot number left");
        assert_eq!(
            std::fs::read_to_string(dir.join("pages/index.html")).unwrap(),
            "<p>changed</p>"
        );
        let mut folders: Vec<String> = std::fs::read_dir(dir.join("history"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        folders.sort();
        assert_eq!(folders, ["1", "4294967295"]);
    }

    #[test]
    fn a_record_naming_another_number_than_its_folders_is_not_listed() {
        let (_home, store, dir) = store_with_design();
        write(&dir, "pages/index.html", INDEX);
        store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 1000)
            .unwrap()
            .unwrap();
        write(&dir, "pages/index.html", "<p>two</p>");
        store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 2000)
            .unwrap()
            .unwrap();
        // Snapshot 2's record, damaged, says it is snapshot 1.
        let record = std::fs::read_to_string(dir.join("history/2/snapshot.json")).unwrap();
        write(
            &dir,
            "history/2/snapshot.json",
            &record.replace("\"n\": 2,", "\"n\": 1,"),
        );
        let listed: Vec<(u32, u64)> = store
            .history("w1", "settings-page")
            .unwrap()
            .iter()
            .map(|s| (s.n, s.time))
            .collect();
        assert_eq!(listed, [(1, 1000)]);
        // Restoring 1 restores folder 1's files.
        store
            .restore_snapshot("w1", "settings-page", 1, Take::AgentTurn, 3000)
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("pages/index.html")).unwrap(),
            INDEX
        );
    }

    #[test]
    fn an_at_sign_names_no_page_or_design_and_a_snapshots_path_never_climbs_out() {
        let (_home, store, dir) = store_with_design();
        write(&dir, "pages/index.html", INDEX);
        store
            .take_snapshot("w1", "settings-page", Take::AgentTurn, 1000)
            .unwrap()
            .unwrap();
        // `<slug>@<n>` is a snapshot's folder: no design or page is named so.
        assert!(!super::super::pages::is_page_name("git@2"));
        assert!(store.page("w1", "settings-page", "git@2").is_err());
        std::fs::create_dir_all(dir.with_file_name("settings-page@1")).unwrap();
        std::fs::write(
            dir.with_file_name("settings-page@1/design.toml"),
            "name = \"x\"\nsystem = \"moonlet-desktop\"\n",
        )
        .unwrap();
        assert!(store.design_dir("w1", "settings-page@1").is_err());
        for climbing in [
            "designs/settings-page@1/pages/../../snapshot.json",
            "designs/settings-page@1/assets/../pages/index.html",
        ] {
            assert!(store.resolve("w1", climbing).is_err(), "{climbing}");
        }
    }
}
