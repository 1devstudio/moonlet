//! A session's copied files between members (X74): files git ignores that
//! moonlet copies, `.env` by default. The member that runs a session sends
//! them to the central host's copy of it (X72), and a Mac with a live copy
//! of a session the central host runs (X60) asks for them. Either way the
//! owner's versions win: the other side's are put in its leftovers first,
//! so no version of a secret is lost.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
use base64::Engine;
use moonlet_core::copied_files::{self as files, Entry, MAX_TOTAL};
use moonlet_proto::methods as m;

/// How many bytes of copied files go in one message; the rest go in the
/// next round.
const BUDGET: u64 = 4 * 1024 * 1024;

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

pub fn to_wire(e: Entry) -> m::CopiedFile {
    m::CopiedFile {
        path: e.path,
        sha: e.sha,
        content: e.bytes.map(|b| b64().encode(b)),
    }
}

pub fn from_wire(f: m::CopiedFile) -> Entry {
    Entry {
        path: f.path,
        sha: f.sha,
        bytes: f.content.and_then(|c| b64().decode(c).ok()),
    }
}

/// The copied files of worktree `dir`, with the bytes of those whose hash
/// differs from `known`'s.
pub async fn manifest(
    dir: &Path,
    patterns: &[String],
    known: &BTreeMap<String, String>,
) -> Result<Vec<Entry>> {
    files::manifest(
        dir,
        patterns,
        |path, sha| known.get(path).map(String::as_str) != Some(sha),
        BUDGET.min(MAX_TOTAL),
    )
    .await
}

/// The copied files each copy last had from its owner, by copy (`copy:`
/// or `live:` and the session): the owner deleting one of them deletes it
/// here too. A file only a copy has is left alone.
fn received() -> &'static std::sync::Mutex<BTreeMap<String, std::collections::BTreeSet<String>>> {
    static RECEIVED: std::sync::OnceLock<
        std::sync::Mutex<BTreeMap<String, std::collections::BTreeSet<String>>>,
    > = std::sync::OnceLock::new();
    RECEIVED.get_or_init(Default::default)
}

/// Makes copy `copy`'s copied files, in `dir`, those of `manifest`, the
/// owner's. A version of this side's that is replaced or removed is saved
/// under `$MOONLET_HOME/sync-leftovers/<label>-<when>/` first (X60's
/// folder), made only when one is. Gives the paths whose bytes did not come
/// along.
pub async fn take(
    home: &Path,
    label: &str,
    copy: &str,
    dir: &Path,
    patterns: &[String],
    manifest: &[Entry],
) -> Result<Vec<String>> {
    let mut folder: Option<PathBuf> = None;
    let keep = |path: &str, bytes: &[u8]| -> Result<()> {
        if folder.is_none() {
            folder = Some(crate::sync::make_leftovers_folder(
                &home.join("sync-leftovers"),
                label,
            )?);
        }
        let folder = folder.as_ref().expect("made above");
        files::write(folder, path, bytes)?;
        tracing::info!(
            "{label}: kept this side's {path} in {} before replacing it",
            folder.display()
        );
        Ok(())
    };
    let had = received()
        .lock()
        .unwrap()
        .get(copy)
        .cloned()
        .unwrap_or_default();
    let want = files::apply(dir, patterns, manifest, &had, keep)
        .await?
        .want;
    let now = manifest
        .iter()
        .map(|e| e.path.clone())
        .filter(|p| !want.contains(p))
        .chain(had.into_iter().filter(|p| want.contains(p)))
        .collect();
    received().lock().unwrap().insert(copy.to_string(), now);
    Ok(want)
}

/// What `have` lacks of `dir`'s copied files, for `session.files_fetch`.
pub async fn answer(
    dir: &Path,
    patterns: &[String],
    have: &BTreeMap<String, String>,
) -> Result<Vec<m::CopiedFile>> {
    Ok(manifest(dir, patterns, have)
        .await?
        .into_iter()
        .map(to_wire)
        .collect())
}
