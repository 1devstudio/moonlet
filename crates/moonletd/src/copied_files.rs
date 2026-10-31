//! A session's copied files between members (X74): files git ignores that
//! moonlet copies, `.env` by default. The member that runs a session sends
//! them to the central host's copy of it (X72), and a Mac with a live copy
//! of a session the central host runs (X60) asks for them. Either way the
//! owner's versions win: the other side's are put in its leftovers first,
//! so no version of a secret is lost.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use base64::Engine;
use moonlet_core::copied_files::{self as files, Entry, MAX_TOTAL, Version};
use moonlet_proto::methods as m;

/// On a cloud machine: the central host's list for each session it has a
/// routed copy of, as last fetched.
pub fn lists() -> &'static std::sync::Mutex<BTreeMap<String, Vec<String>>> {
    static LISTS: std::sync::OnceLock<std::sync::Mutex<BTreeMap<String, Vec<String>>>> =
        std::sync::OnceLock::new();
    LISTS.get_or_init(Default::default)
}

/// Tells this Mac's app that a version of a copied file went to leftovers
/// (X74), for its toast.
pub type Kept = std::sync::Arc<dyn Fn(m::FilesKept) + Send + Sync>;

fn kept_hook() -> &'static std::sync::OnceLock<Kept> {
    static KEPT: std::sync::OnceLock<Kept> = std::sync::OnceLock::new();
    &KEPT
}

/// Sets what hears of kept versions, once, as the daemon starts.
pub fn on_kept(f: Kept) {
    let _ = kept_hook().set(f);
}

fn kept(label: &str, path: &str, folder: &Path) {
    if let Some(f) = kept_hook().get() {
        f(m::FilesKept {
            label: label.to_string(),
            path: path.to_string(),
            folder: folder.display().to_string(),
        });
    }
}

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
        bytes: f.content.as_deref().and_then(decode),
    }
}

/// The bytes of base64 `c`; none when they could not be a copied file, over
/// [`files::MAX_FILE`].
fn decode(c: &str) -> Option<Vec<u8>> {
    if c.len() as u64 > files::MAX_FILE.div_ceil(3) * 4 {
        return None;
    }
    b64()
        .decode(c)
        .ok()
        .filter(|b| b.len() as u64 <= files::MAX_FILE)
}

/// How many bytes base64 `c` holds, its `=` padding not counted.
fn decoded_len(c: &str) -> u64 {
    let pad = c.bytes().rev().take(2).filter(|b| *b == b'=').count();
    (c.len() / 4 * 3).saturating_sub(pad) as u64
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

/// Where the copied files each copy last had from its owner are kept, by
/// copy (`copy:` or `live:` and the session), in `$MOONLET_HOME`, mode
/// 0600: the owner deleting one of them deletes it here too, also after
/// this daemon restarted. A file only a copy has is left alone. It holds
/// paths, never contents.
const RECEIVED: &str = "copied-files-received.json";

type Received = BTreeMap<String, std::collections::BTreeSet<String>>;

fn load_received(home: &Path) -> Received {
    match files::read(home, RECEIVED) {
        Ok(Some(bytes)) => serde_json::from_slice(&bytes).unwrap_or_default(),
        _ => Received::default(),
    }
}

/// Held while [`RECEIVED`] is read and written again.
fn received_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    &LOCK
}

/// Makes copy `copy`'s copied files, in `dir`, those of `manifest`, the
/// owner's. A version of this side's that is replaced or removed is saved
/// under `$MOONLET_HOME/sync-leftovers/<label>-<when>/` first (X60's
/// folder), made only when one is. With `only_sent`, on a cloud machine,
/// a file it had from the owner that `manifest` no longer names is removed
/// whatever the list now says, and kept nowhere: a secret taken off the
/// list, or no longer let go to cloud machines, leaves it. Gives the paths
/// whose bytes did not come along.
pub async fn take(
    home: &Path,
    label: &str,
    copy: &str,
    dir: &Path,
    patterns: &[String],
    manifest: &[Entry],
    only_sent: bool,
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
        kept(label, path, folder);
        Ok(())
    };
    let had = {
        let _one = received_lock().lock().unwrap();
        load_received(home).remove(copy).unwrap_or_default()
    };
    let want = files::apply(dir, patterns, manifest, &had, keep)
        .await?
        .want;
    if only_sent {
        let gone: Vec<String> = had
            .iter()
            .filter(|p| !manifest.iter().any(|e| &e.path == *p))
            .cloned()
            .collect();
        let tracked = files::tracked(dir, &gone).await?;
        for path in gone.iter().filter(|p| !tracked.contains(*p)) {
            files::remove(dir, path)?;
        }
    }
    let now = manifest
        .iter()
        .map(|e| e.path.clone())
        .filter(|p| !want.contains(p))
        .chain(had.into_iter().filter(|p| want.contains(p)))
        .collect();
    let _one = received_lock().lock().unwrap();
    let mut all = load_received(home);
    all.insert(copy.to_string(), now);
    files::write(home, RECEIVED, &serde_json::to_vec(&all)?)?;
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

/// How far ahead of this host's clock a member's change may be stamped; one
/// further ahead would win every conflict from then on.
const AHEAD_MS: u64 = 24 * 60 * 60 * 1000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The key of a project identity, as in the account state; `None` for a
/// project without a root commit.
pub fn identity_key(i: &moonlet_proto::types::ProjectIdentity) -> Option<String> {
    Some(format!(
        "{}|{}",
        i.origin.as_deref().unwrap_or(""),
        i.root.as_deref()?
    ))
}

/// What this member knows of its checkouts' copied files, kept in
/// `$MOONLET_HOME/copied-files.json`, mode 0600. It holds hashes and
/// stamps, never contents.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct Tables {
    /// By project identity key: each path's last change.
    #[serde(default)]
    checkouts: BTreeMap<String, BTreeMap<String, Version>>,
    /// On a member, by project identity key: the hash of each path the
    /// central host has from it.
    #[serde(default)]
    sent: BTreeMap<String, BTreeMap<String, String>>,
    /// On a member, by project identity key: the central host's versions
    /// it would not take, listed in each exchange so they are not sent
    /// again.
    #[serde(default)]
    refused: BTreeMap<String, BTreeMap<String, Refused>>,
}

/// A version of a path a member would not take: its hash, none for a
/// deletion, and its size.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct Refused {
    sha: Option<String>,
    size: u64,
}

/// Each member's checkout of a project is kept in step through the central
/// host (X74): a member sends what changed in its checkout, the central
/// host takes the changes that came after its own, and answers its own
/// that came after the member's. The later change of a file wins; the
/// losing version goes to that side's leftovers.
pub struct Checkouts {
    home: PathBuf,
    tables: std::sync::Mutex<Tables>,
    one: tokio::sync::Mutex<()>,
}

impl Checkouts {
    pub fn new(home: &Path) -> Checkouts {
        let tables = files::read(home, FILE)
            .ok()
            .flatten()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Checkouts {
            home: home.to_path_buf(),
            tables: std::sync::Mutex::new(tables),
            one: tokio::sync::Mutex::new(()),
        }
    }

    fn save(&self, t: &Tables) {
        let written = serde_json::to_vec(t)
            .map_err(anyhow::Error::from)
            .and_then(|b| files::write(&self.home, FILE, &b));
        if let Err(e) = written {
            tracing::warn!("cannot save {FILE}: {e:#}");
        }
    }

    /// Records what changed in checkout `dir` since the last look, as
    /// noticed now by member `me`; gives each copied file's bytes.
    async fn look(
        &self,
        key: &str,
        dir: &Path,
        patterns: &[String],
        me: &str,
    ) -> Result<BTreeMap<String, Vec<u8>>> {
        let bytes: BTreeMap<String, Vec<u8>> =
            files::manifest(dir, patterns, |_, _| true, MAX_TOTAL)
                .await?
                .into_iter()
                .filter_map(|e| Some((e.path, e.bytes?)))
                .collect();
        // A file is stamped with when it changed, not when it was seen, so
        // a change made while the link was down keeps its place in time.
        let now = bytes
            .iter()
            .map(|(p, b)| {
                let at = std::fs::symlink_metadata(dir.join(p))
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or_else(now_ms, |d| d.as_millis() as u64);
                (p.clone(), (files::sha(b), at))
            })
            .collect();
        let mut t = self.tables.lock().unwrap();
        let table = t.checkouts.entry(key.to_string()).or_default();
        // A path the list no longer names is no longer kept in step; it
        // stays on each side as it is.
        let paths: Vec<String> = table.keys().cloned().collect();
        let named = files::named(patterns, &paths)?;
        let before = table.len();
        table.retain(|p, _| named.contains(p));
        let pruned = table.len() != before;
        // A file still there but no longer copied, grown past 1 MiB or now
        // tracked by git, is not deleted on the other side.
        let still_there = |p: &str| std::fs::symlink_metadata(dir.join(p)).is_ok();
        if !files::notice(table, &now, still_there, now_ms(), me).is_empty() || pruned {
            self.save(&t);
        }
        Ok(bytes)
    }

    /// Puts version `v` of `path` in project `name`'s checkout `dir`, the
    /// version there kept in leftovers first.
    fn put(
        &self,
        name: &str,
        folder: &mut Option<PathBuf>,
        dir: &Path,
        path: &str,
        bytes: Option<&[u8]>,
    ) -> Result<()> {
        let label = crate::sync::segment(&format!("{name}-checkout"));
        if let Some(old) = files::read(dir, path)? {
            if bytes.is_some_and(|b| b == old.as_slice()) {
                return Ok(());
            }
            if folder.is_none() {
                *folder = Some(crate::sync::make_leftovers_folder(
                    &self.home.join("sync-leftovers"),
                    &label,
                )?);
            }
            let kept_in = folder.as_ref().expect("made above");
            files::write(kept_in, path, &old)?;
            kept(name, path, kept_in);
        }
        match bytes {
            Some(b) => files::write(dir, path, b),
            None => files::remove(dir, path),
        }
    }

    /// On a member: the versions of checkout `dir` it refused that it
    /// still would not take, for the central host to leave out. One taken
    /// off its git, under its limits now, or newly on its list is dropped,
    /// so the central host sends it again.
    async fn still_refused(
        &self,
        key: &str,
        dir: &Path,
        patterns: &[String],
    ) -> Result<Vec<m::RefusedFile>> {
        let mut refused = self
            .tables
            .lock()
            .unwrap()
            .refused
            .get(key)
            .cloned()
            .unwrap_or_default();
        if refused.is_empty() {
            return Ok(Vec::new());
        }
        let paths: Vec<String> = refused.keys().cloned().collect();
        let named = files::named(patterns, &paths)?;
        let tracked = files::tracked(dir, &paths).await?;
        let before = refused.len();
        refused
            .retain(|p, r| !named.contains(p) || tracked.contains(p) || r.size > files::MAX_FILE);
        if refused.len() != before {
            let mut t = self.tables.lock().unwrap();
            t.refused.insert(key.to_string(), refused.clone());
            self.save(&t);
        }
        Ok(refused
            .into_iter()
            .map(|(path, r)| m::RefusedFile { path, sha: r.sha })
            .collect())
    }

    /// On a member: one exchange of checkout `dir` of project `identity`
    /// with the central host.
    pub async fn exchange(
        &self,
        host: &moonlet_link::Host,
        identity: &moonlet_proto::types::ProjectIdentity,
        name: &str,
        dir: &Path,
        patterns: &[String],
        me: &str,
    ) -> Result<()> {
        let Some(key) = identity_key(identity) else {
            return Ok(());
        };
        let _one = self.one.lock().await;
        let bytes = self.look(&key, dir, patterns, me).await?;
        let (table, sent) = {
            let t = self.tables.lock().unwrap();
            (
                t.checkouts.get(&key).cloned().unwrap_or_default(),
                t.sent.get(&key).cloned().unwrap_or_default(),
            )
        };
        let refused = self.still_refused(&key, dir, patterns).await?;
        let mut budget = BUDGET;
        let mut with_bytes = Vec::new();
        let files: Vec<m::CheckoutFile> = table
            .iter()
            .map(|(path, v)| {
                let content = v
                    .sha
                    .as_ref()
                    .filter(|sha| sent.get(path) != Some(*sha))
                    .and_then(|_| bytes.get(path))
                    .filter(|b| b.len() as u64 <= budget)
                    .map(|b| {
                        budget -= b.len() as u64;
                        with_bytes.push(path.clone());
                        b64().encode(b)
                    });
                m::CheckoutFile {
                    path: path.clone(),
                    sha: v.sha.clone(),
                    stamp: v.stamp,
                    by: v.by.clone(),
                    content,
                }
            })
            .collect();
        let answer = host
            .request(
                m::FILES_CHECKOUT,
                serde_json::to_value(m::FilesCheckout {
                    identity: identity.clone(),
                    files,
                    refused,
                })?,
            )
            .await
            .map_err(|e| anyhow::anyhow!("{}: {}", e.code, e.message))?;
        let answer: m::FilesCheckedOut = serde_json::from_value(answer)?;
        // Only what this side's own list names, within its limits, and not
        // tracked by its git.
        // A path its list no longer names, or does not name yet, is left
        // out, not refused, so the others still go.
        let paths: Vec<String> = answer.files.iter().map(|f| f.path.clone()).collect();
        let named = files::named(patterns, &paths)?;
        let sizes: Vec<(String, u64)> = answer
            .files
            .iter()
            .filter(|f| named.contains(&f.path))
            .map(|f| (f.path.clone(), f.content.as_deref().map_or(0, decoded_len)))
            .collect();
        let takes = files::receivable(dir, patterns, &sizes).await?;
        let mut folder = None;
        let mut t = self.tables.lock().unwrap();
        let Tables {
            checkouts,
            sent,
            refused,
        } = &mut *t;
        let sent = sent.entry(key.clone()).or_default();
        let table = checkouts.entry(key.clone()).or_default();
        let refused = refused.entry(key.clone()).or_default();
        for path in with_bytes {
            if let Some(sha) = table.get(&path).and_then(|v| v.sha.clone()) {
                sent.insert(path, sha);
            }
        }
        for path in &answer.want {
            sent.remove(path);
        }
        for f in answer.files {
            if !takes.contains(&f.path) {
                let size = f.content.as_deref().map_or(0, decoded_len);
                refused.insert(f.path, Refused { sha: f.sha, size });
                continue;
            }
            refused.remove(&f.path);
            let content = f.content.as_deref().and_then(decode);
            if f.sha.is_some() && content.as_deref().map(files::sha) != f.sha {
                // Its bytes come next time.
                continue;
            }
            self.put(name, &mut folder, dir, &f.path, content.as_deref())?;
            match &f.sha {
                Some(sha) => sent.insert(f.path.clone(), sha.clone()),
                None => sent.remove(&f.path),
            };
            table.insert(
                f.path,
                Version {
                    sha: f.sha,
                    stamp: f.stamp,
                    by: f.by,
                },
            );
        }
        self.save(&t);
        Ok(())
    }

    /// On the central host: takes member `worker`'s changes to its checkout
    /// of a project, this host's being `dir`, and answers its own that came
    /// after.
    pub async fn take(
        &self,
        worker: &str,
        me: &str,
        r: m::FilesCheckout,
        name: &str,
        dir: &Path,
        patterns: &[String],
    ) -> Result<m::FilesCheckedOut> {
        let key = identity_key(&r.identity).context("a project without a root commit")?;
        let _one = self.one.lock().await;
        let bytes = self.look(&key, dir, patterns, me).await?;
        let paths: Vec<String> = r.files.iter().map(|f| f.path.clone()).collect();
        let named = files::named(patterns, &paths)?;
        let sizes: Vec<(String, u64)> = r
            .files
            .iter()
            .filter(|f| named.contains(&f.path))
            .map(|f| (f.path.clone(), f.content.as_deref().map_or(0, decoded_len)))
            .collect();
        let takes = files::receivable(dir, patterns, &sizes).await?;
        let mut folder = None;
        let mut out = m::FilesCheckedOut::default();
        let mut t = self.tables.lock().unwrap();
        let table = t.checkouts.entry(key).or_default();
        let latest = now_ms() + AHEAD_MS;
        // The member would not take these versions; they are not sent again.
        let refused: BTreeMap<String, Option<String>> =
            r.refused.into_iter().map(|f| (f.path, f.sha)).collect();
        let answered = |path: &str, mine: &Version| refused.get(path) != Some(&mine.sha);
        let mut seen = std::collections::BTreeSet::new();
        for f in r.files {
            seen.insert(f.path.clone());
            if !takes.contains(&f.path) {
                continue;
            }
            // A change is the member's own, and never stamped far ahead.
            let theirs = Version {
                sha: f.sha.clone(),
                stamp: f.stamp.min(latest),
                by: worker.to_string(),
            };
            let mine = table.get(&f.path).cloned();
            match mine {
                Some(mine) if mine.sha == theirs.sha => {}
                Some(mine) if !theirs.after(&mine) && !answered(&f.path, &mine) => {}
                Some(mine) if !theirs.after(&mine) => out.files.push(m::CheckoutFile {
                    content: mine
                        .sha
                        .as_ref()
                        .and_then(|_| bytes.get(&f.path))
                        .map(|b| b64().encode(b)),
                    path: f.path.clone(),
                    sha: mine.sha,
                    stamp: mine.stamp,
                    by: mine.by,
                }),
                _ => {
                    let content = f.content.as_deref().and_then(decode);
                    if theirs.sha.is_some() && content.as_deref().map(files::sha) != theirs.sha {
                        out.want.push(f.path.clone());
                        continue;
                    }
                    self.put(name, &mut folder, dir, &f.path, content.as_deref())?;
                    table.insert(f.path.clone(), theirs);
                }
            }
        }
        // What the member has never heard of.
        for (path, mine) in table
            .iter()
            .filter(|(p, v)| !seen.contains(*p) && answered(p, v))
        {
            out.files.push(m::CheckoutFile {
                path: path.clone(),
                sha: mine.sha.clone(),
                stamp: mine.stamp,
                by: mine.by.clone(),
                content: mine
                    .sha
                    .as_ref()
                    .and_then(|_| bytes.get(path))
                    .map(|b| b64().encode(b)),
            });
        }
        self.save(&t);
        Ok(out)
    }
}

/// Where [`Checkouts`] keeps its tables, in `$MOONLET_HOME`.
const FILE: &str = "copied-files.json";

#[cfg(test)]
mod tests {
    use super::*;

    /// A git checkout of `shop` holding `.env` with `text`.
    fn checkout(text: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let out = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir.path())
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(out.status.success());
        std::fs::write(dir.path().join(".env"), text).unwrap();
        dir
    }

    fn request(refused: Vec<m::RefusedFile>) -> m::FilesCheckout {
        m::FilesCheckout {
            identity: moonlet_proto::types::ProjectIdentity {
                origin: Some("github.com/acme/shop".into()),
                root: Some("1111111".into()),
            },
            files: Vec::new(),
            refused,
        }
    }

    /// The paths of `answer`'s files, with their bytes in base64.
    fn sent(answer: &m::FilesCheckedOut) -> Vec<(String, Option<String>)> {
        answer
            .files
            .iter()
            .map(|f| (f.path.clone(), f.content.clone()))
            .collect()
    }

    #[tokio::test]
    async fn a_file_the_member_refused_is_not_sent_again_until_it_changes() {
        let home = tempfile::tempdir().unwrap();
        let dir = checkout("A=1\n");
        let patterns = vec![".env".to_string()];
        let checkouts = Checkouts::new(home.path());
        let take = |refused| {
            checkouts.take(
                "MacBook",
                "studio-mini",
                request(refused),
                "shop",
                dir.path(),
                &patterns,
            )
        };
        let first = take(Vec::new()).await.unwrap();
        assert_eq!(sent(&first), [(".env".into(), Some("QT0xCg==".into()))]);
        // The MacBook's git tracks its .env, so it would not take it.
        let refused = vec![m::RefusedFile {
            path: ".env".into(),
            sha: first.files[0].sha.clone(),
        }];
        let again = take(refused.clone()).await.unwrap();
        assert_eq!(sent(&again), []);
        // A new version goes again.
        std::fs::write(dir.path().join(".env"), "A=2\n").unwrap();
        let changed = take(refused).await.unwrap();
        assert_eq!(sent(&changed), [(".env".into(), Some("QT0yCg==".into()))]);
    }
}
