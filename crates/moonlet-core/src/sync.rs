//! Live copies of a session's worktree (X60): snapshots of a worktree as git
//! trees, reconciling two sides against the base they last agreed on, and
//! applying the result. Plain git plumbing; the daemons move the trees.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Result, bail};

use crate::git::{git_with, run_raw_env};

/// Files over this size stay on their own machine.
pub const MAX_FILE: u64 = 100 * 1024 * 1024;

/// A worktree's state under git's rules, as a tree in its repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub tree: String,
    /// Paths left out for being over the size limit, sorted.
    pub too_big: Vec<String>,
    /// Paths whose names are not text (only Linux allows them), left out:
    /// carried as text they would be renamed. Shown with U+FFFD, sorted.
    pub bad_names: Vec<String>,
}

/// How long one git call may take: snapshots of big worktrees and packs
/// take a while.
const GIT_TIMEOUT: Duration = Duration::from_secs(300);

/// Runs git in `cwd` with `env`, failing on a non-zero exit.
async fn git_env(
    cwd: &Path,
    env: &[(&str, &str)],
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Result<Vec<u8>> {
    git_with(cwd, env, args, stdin, GIT_TIMEOUT).await
}

/// `GIT_INDEX_FILE` pointing at an index of moonlet's own.
struct IndexFile(String);

impl IndexFile {
    fn new(path: &Path) -> Self {
        Self(path.to_string_lossy().into_owned())
    }

    fn env(&self) -> [(&str, &str); 1] {
        [("GIT_INDEX_FILE", self.0.as_str())]
    }
}

/// The worktree's git dir, where moonlet keeps its own files beside git's.
async fn git_dir(worktree: &Path) -> Result<PathBuf> {
    let dir = git_env(worktree, &[], &["rev-parse", "--absolute-git-dir"], None).await?;
    Ok(PathBuf::from(String::from_utf8_lossy(&dir).trim()))
}

/// The git dir every worktree of the repository shares, where its refs
/// live; it outlasts a removed worktree.
pub async fn common_dir(worktree: &Path) -> Result<PathBuf> {
    let dir = git_env(
        worktree,
        &[],
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        None,
    )
    .await?;
    Ok(PathBuf::from(String::from_utf8_lossy(&dir).trim()))
}

/// Untracked files that never sync, whatever `.gitignore` says, since an
/// agent on the other side can edit `.gitignore`: files that usually hold
/// secrets. Both sides apply this list in place of the user's own global
/// excludes, which differ between machines, so they still agree.
pub const NEVER_SYNCED: &str = "\
.env
.env.local
.env.*.local
*.pem
*.key
id_rsa*
id_ed25519*
id_ecdsa*
.npmrc
.netrc
";

/// Whether `path`'s file name matches a [`NEVER_SYNCED`] pattern. The
/// patterns are file names with `*`, so this holds whatever a
/// `.gitignore` lets back in with `!`.
fn never_synced(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    NEVER_SYNCED
        .lines()
        .any(|p| glob_match(p.as_bytes(), name.as_bytes()))
}

/// `*` matches any run of bytes; everything else matches itself.
fn glob_match(pattern: &[u8], name: &[u8]) -> bool {
    match pattern.split_first() {
        None => name.is_empty(),
        Some((b'*', rest)) => (0..=name.len()).any(|i| glob_match(rest, &name[i..])),
        Some((c, rest)) => name.first() == Some(c) && glob_match(rest, &name[1..]),
    }
}

/// The private index a worktree's snapshots go through, beside its own
/// index: the session's staging area is never touched.
async fn private_index(worktree: &Path) -> Result<PathBuf> {
    Ok(git_dir(worktree).await?.join("moonlet-sync-index"))
}

/// NUL-separated pathspecs for `--pathspec-from-file=- --pathspec-file-nul`,
/// so any number of paths fits whatever the command line allows.
fn pathspecs(specs: impl IntoIterator<Item = String>) -> Vec<u8> {
    let mut out = Vec::new();
    for spec in specs {
        out.extend_from_slice(spec.as_bytes());
        out.push(0);
    }
    out
}

/// Snapshots `worktree`: tracked files and the untracked ones that
/// `.gitignore`, `.git/info/exclude` and [`NEVER_SYNCED`] don't ignore. The
/// user's global excludes are not applied, so two machines agree whatever
/// theirs say.
/// A file leaves the snapshot only once it is gone from disk. One that
/// becomes ignored, and that HEAD doesn't track, stays at the version an
/// earlier snapshot took: the other side never reads it as deleted, and
/// nothing new of it leaves this machine. So does a file over `max_file`
/// bytes ([`MAX_FILE`] outside tests), or it stays out if no snapshot took
/// it yet.
pub async fn snapshot(worktree: &Path, max_file: u64) -> Result<Snapshot> {
    let index = private_index(worktree).await?;
    let file = IndexFile::new(&index);
    let env = file.env();
    let excludes = git_dir(worktree).await?.join("moonlet-sync-excludes");
    if std::fs::read_to_string(&excludes).ok().as_deref() != Some(NEVER_SYNCED) {
        std::fs::write(&excludes, NEVER_SYNCED)?;
    }
    let excludes_opt = format!("core.excludesFile={}", excludes.display());
    let our_excludes = ["-c", excludes_opt.as_str()];
    let has_head = git_env(
        worktree,
        &[],
        &["rev-parse", "-q", "--verify", "HEAD"],
        None,
    )
    .await
    .is_ok();
    if !index.exists() {
        // Start from HEAD, so tracked files that match an ignore rule stay
        // in, as they do for git.
        let from = if has_head { "HEAD" } else { "--empty" };
        git_env(worktree, &env, &["read-tree", from], None).await?;
    }

    let head: std::collections::HashSet<String> = if has_head {
        let out = git_env(
            worktree,
            &[],
            &["ls-tree", "-r", "-z", "--name-only", "HEAD"],
            None,
        )
        .await?;
        split_z(&out).collect()
    } else {
        Default::default()
    };

    // Files an earlier snapshot took that the rules now ignore, and that
    // HEAD doesn't track: they stay as they were while they exist.
    let mut ignored = our_excludes.to_vec();
    ignored.extend([
        "ls-files",
        "-z",
        "--cached",
        "--ignored",
        "--exclude-standard",
    ]);
    let frozen: std::collections::HashSet<String> =
        split_z(&git_env(worktree, &env, &ignored, None).await?)
            .filter(|p| !head.contains(p))
            .filter(|p| std::fs::symlink_metadata(worktree.join(p)).is_ok())
            .collect();
    // Their entries as they are now, put back after `add`: a pathspec that
    // names an ignored file makes `add` refuse.
    let mut kept = Vec::new();
    if !frozen.is_empty() {
        let staged = git_env(worktree, &env, &["ls-files", "-z", "-s"], None).await?;
        for line in split_z(&staged) {
            // `<mode> <oid> <stage>\t<path>`
            if let Some((meta, path)) = line.split_once('\t')
                && frozen.contains(path)
            {
                let mut fields = meta.split(' ');
                if let (Some(mode), Some(oid)) = (fields.next(), fields.next()) {
                    kept.extend_from_slice(format!("{mode} {oid}\t{path}").as_bytes());
                    kept.push(0);
                }
            }
        }
    }

    // What `add` would hash: untracked files, and files changed since the
    // last snapshot. Only those can have grown past the limit.
    let mut candidates = Vec::new();
    for listing in [
        &["ls-files", "-z", "--others", "--exclude-standard"][..],
        &["ls-files", "-z", "--modified"][..],
    ] {
        let args: Vec<&str> = our_excludes.iter().chain(listing).copied().collect();
        let out = git_env(worktree, &env, &args, None).await?;
        candidates.extend(split_z(&out));
    }
    let mut too_big: Vec<String> = candidates
        .into_iter()
        .filter(|p| !never_synced(p))
        .filter(|p| {
            std::fs::symlink_metadata(worktree.join(p))
                .is_ok_and(|m| m.is_file() && m.len() > max_file)
        })
        .collect();
    too_big.sort();
    too_big.dedup();

    // `add -A` follows the files already in the snapshot and drops those
    // gone from disk; the big ones it leaves as they were. Secrets are
    // never even hashed, whatever a `.gitignore` says.
    let specs = pathspecs(
        std::iter::once(".".to_string())
            .chain(too_big.iter().map(|p| format!(":(exclude,literal){p}")))
            .chain(
                NEVER_SYNCED
                    .lines()
                    .map(|p| format!(":(exclude,glob)**/{p}")),
            ),
    );
    let mut add: Vec<&str> = our_excludes.iter().copied().collect();
    add.extend(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"]);
    git_env(worktree, &env, &add, Some(&specs)).await?;
    if !kept.is_empty() {
        git_env(
            worktree,
            &env,
            &["update-index", "-z", "--index-info"],
            Some(&kept),
        )
        .await?;
    }

    // Secrets already in the snapshot follow their edits if HEAD tracks
    // them, and leave it otherwise.
    let cached = git_env(worktree, &env, &["ls-files", "-z", "--cached"], None).await?;
    let cached: std::collections::HashSet<String> = split_z(&cached).collect();
    let (secrets_kept, secrets_dropped): (Vec<&String>, Vec<&String>) = cached
        .iter()
        .filter(|p| never_synced(p))
        .partition(|p| head.contains(*p));
    if !secrets_kept.is_empty() {
        let specs = pathspecs(secrets_kept.iter().map(|p| format!(":(literal){p}")));
        git_env(
            worktree,
            &env,
            &["add", "-u", "--pathspec-from-file=-", "--pathspec-file-nul"],
            Some(&specs),
        )
        .await?;
    }
    if !secrets_dropped.is_empty() {
        let paths: Vec<u8> = secrets_dropped
            .iter()
            .flat_map(|p| p.bytes().chain([0]))
            .collect();
        git_env(
            worktree,
            &env,
            &["update-index", "--force-remove", "-z", "--stdin"],
            Some(&paths),
        )
        .await?;
    }

    // Files HEAD tracks are in even when ignored, also those committed
    // after the snapshot's index was first made.
    let mut missing: Vec<String> = head
        .iter()
        .filter(|p| !cached.contains(*p) && !too_big.contains(p))
        .filter(|p| std::fs::symlink_metadata(worktree.join(p)).is_ok())
        .cloned()
        .collect();
    // Held to the size limit like the rest.
    let (big, fits): (Vec<String>, Vec<String>) = missing.into_iter().partition(|p| {
        std::fs::symlink_metadata(worktree.join(p)).is_ok_and(|m| m.is_file() && m.len() > max_file)
    });
    missing = fits;
    too_big.extend(big);
    too_big.sort();
    too_big.dedup();
    if !missing.is_empty() {
        let specs = pathspecs(missing.iter().map(|p| format!(":(literal){p}")));
        git_env(
            worktree,
            &env,
            &["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"],
            Some(&specs),
        )
        .await?;
    }
    // Names that are not text leave the snapshot, wherever they came from.
    let listed = git_env(worktree, &env, &["ls-files", "-z", "--cached"], None).await?;
    let bad = bad_names_z(&listed);
    if !bad.is_empty() {
        let mut stdin = Vec::new();
        for name in &bad {
            stdin.extend_from_slice(name);
            stdin.push(0);
        }
        git_env(
            worktree,
            &env,
            &["update-index", "-z", "--force-remove", "--stdin"],
            Some(&stdin),
        )
        .await?;
    }
    let mut bad_names: Vec<String> = bad
        .iter()
        .map(|n| String::from_utf8_lossy(n).into_owned())
        .collect();
    bad_names.sort();
    let tree = git_env(worktree, &env, &["write-tree"], None).await?;
    Ok(Snapshot {
        tree: String::from_utf8_lossy(&tree).trim().to_string(),
        too_big,
        bad_names,
    })
}

/// A file in a tree: its mode (`100644`, `100755`, `120000` for a symlink,
/// `160000` for a submodule) and object id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub mode: String,
    pub oid: String,
}

/// Every file of a tree, by path.
pub type Files = std::collections::BTreeMap<String, Entry>;

/// What reconciling gives each side, and the new base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reconciled<T> {
    pub base: T,
    pub central: T,
    pub worker: T,
    /// Paths changed differently on the two sides, sorted. Each side keeps
    /// its own version, and the base keeps the old one, so they go on
    /// differing until the user picks one.
    pub differs: Vec<String>,
}

/// Reconciles the central host's and a worker's files against their base,
/// path by path (X60, "Keeping it in sync").
pub fn reconcile(base: &Files, central: &Files, worker: &Files) -> Reconciled<Files> {
    let paths: std::collections::BTreeSet<&String> = base
        .keys()
        .chain(central.keys())
        .chain(worker.keys())
        .collect();
    let mut differs: std::collections::BTreeSet<String> = paths
        .iter()
        .filter(|p| {
            let (b, c, w) = (base.get(**p), central.get(**p), worker.get(**p));
            c != w && c != b && w != b
        })
        .map(|p| (*p).clone())
        .collect();
    // A file where the other side now has a folder of that name can't sit
    // in one tree with it: both differ, until each side is a valid tree.
    loop {
        let r = merge(&paths, &differs, base, central, worker);
        let clashes: Vec<String> = [&r.base, &r.central, &r.worker]
            .into_iter()
            .flat_map(|t| folder_clashes(t).into_iter().chain(case_clashes(t, base)))
            .filter(|p| !differs.contains(p))
            .collect();
        if clashes.is_empty() {
            return r;
        }
        differs.extend(clashes);
    }
}

fn merge(
    paths: &std::collections::BTreeSet<&String>,
    differs: &std::collections::BTreeSet<String>,
    base: &Files,
    central: &Files,
    worker: &Files,
) -> Reconciled<Files> {
    let mut r = Reconciled {
        base: Files::new(),
        central: Files::new(),
        worker: Files::new(),
        differs: differs.iter().cloned().collect(),
    };
    for p in paths {
        let (b, c, w) = (base.get(*p), central.get(*p), worker.get(*p));
        let (nb, nc, nw) = if differs.contains(*p) {
            (b, c, w)
        } else {
            // The side that changed wins; unchanged on both, or changed
            // alike, gives the same.
            let x = if c == b { w } else { c };
            (x, x, x)
        };
        for (out, e) in [(&mut r.base, nb), (&mut r.central, nc), (&mut r.worker, nw)] {
            if let Some(e) = e {
                out.insert((*p).clone(), e.clone());
            }
        }
    }
    r
}

/// Paths of `files` new against `base` that a Mac's disk would fold into
/// another path: `README.md` beside `Readme.md`, or `docs/y.md` beside
/// `Docs/x.md`. One would overwrite the other, so they differ instead.
/// Names that already sat side by side in the base are left alone.
fn case_clashes(files: &Files, base: &Files) -> Vec<String> {
    use std::collections::{BTreeMap, BTreeSet};
    // Every path and folder, by its lowercase form.
    let mut spellings: BTreeMap<String, BTreeSet<&str>> = BTreeMap::new();
    for p in files.keys() {
        let mut end = 0;
        for part in p.split('/') {
            end += part.len();
            let prefix = &p[..end];
            spellings
                .entry(prefix.to_lowercase())
                .or_default()
                .insert(prefix);
            end += 1;
        }
    }
    let folded: BTreeSet<&str> = spellings
        .values()
        .filter(|s| s.len() > 1)
        .flatten()
        .copied()
        .collect();
    files
        .keys()
        .filter(|p| !base.contains_key(*p))
        .filter(|p| {
            let mut end = 0;
            p.split('/').any(|part| {
                end += part.len();
                let hit = folded.contains(&p[..end]);
                end += 1;
                hit
            })
        })
        .cloned()
        .collect()
}

/// Paths that are both a file and a folder's prefix in `files`: `a` and
/// `a/x`, say. Both are returned.
fn folder_clashes(files: &Files) -> Vec<String> {
    let mut out = Vec::new();
    for p in files.keys() {
        let prefix = format!("{p}/");
        let under: Vec<&String> = files
            .range(prefix.clone()..)
            .take_while(|(k, _)| k.starts_with(&prefix))
            .map(|(k, _)| k)
            .collect();
        if !under.is_empty() {
            out.push(p.clone());
            out.extend(under.into_iter().cloned());
        }
    }
    out
}

/// The files of `tree` in `repo`.
/// Whether `id` is a full object id, SHA-1 or SHA-256: the only form an id
/// from the other side may take before it reaches git.
pub fn is_object_id(id: &str) -> bool {
    matches!(id.len(), 40 | 64) && id.bytes().all(|b| b.is_ascii_hexdigit())
}

pub async fn read_files(repo: &Path, tree: &str) -> Result<Files> {
    let out = git_env(
        repo,
        &[],
        &[
            "ls-tree",
            "-r",
            "-z",
            "--full-tree",
            "--end-of-options",
            tree,
        ],
        None,
    )
    .await?;
    parse_ls_tree(&out)
}

/// The files of `git ls-tree -r -z` output.
fn parse_ls_tree(out: &[u8]) -> Result<Files> {
    let mut files = Files::new();
    for line in out.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        let Ok(line) = std::str::from_utf8(line) else {
            bail!(
                "a file name that is not text: {}",
                String::from_utf8_lossy(line)
            )
        };
        // `<mode> <type> <oid>\t<path>`
        let Some((meta, path)) = line.split_once('\t') else {
            bail!("unexpected ls-tree line {line:?}")
        };
        let mut meta = meta.split(' ');
        let (Some(mode), Some(_), Some(oid)) = (meta.next(), meta.next(), meta.next()) else {
            bail!("unexpected ls-tree line {line:?}")
        };
        files.insert(
            path.to_string(),
            Entry {
                mode: mode.to_string(),
                oid: oid.to_string(),
            },
        );
    }
    Ok(files)
}

/// Whether a refused `read-tree -m -u` refused because of the worktree: a
/// file edited since the snapshot, or an untracked one in the way.
fn worktree_changed(stderr: &str) -> bool {
    stderr.contains("not uptodate") || stderr.contains("would be overwritten")
}

/// Writes `files` as a tree in `repo` and returns its id. Every object must
/// already be in the repository.
pub async fn write_files(repo: &Path, files: &Files) -> Result<String> {
    let index = git_dir(repo)
        .await?
        .join(format!("moonlet-sync-tmp-{}", uuid::Uuid::new_v4()));
    let file = IndexFile::new(&index);
    let env = file.env();
    let mut info = Vec::new();
    for (path, e) in files {
        info.extend_from_slice(format!("{} {}\t{path}\0", e.mode, e.oid).as_bytes());
    }
    let written = async {
        git_env(repo, &env, &["read-tree", "--empty"], None).await?;
        git_env(
            repo,
            &env,
            &["update-index", "-z", "--index-info"],
            Some(&info),
        )
        .await?;
        git_env(repo, &env, &["write-tree"], None).await
    }
    .await;
    let _ = std::fs::remove_file(&index);
    Ok(String::from_utf8_lossy(&written?).trim().to_string())
}

/// [`reconcile`] over trees in `repo`: the result's trees are written there.
pub async fn reconcile_trees(
    repo: &Path,
    base: &str,
    central: &str,
    worker: &str,
) -> Result<Reconciled<String>> {
    let r = reconcile(
        &read_files(repo, base).await?,
        &read_files(repo, central).await?,
        &read_files(repo, worker).await?,
    );
    Ok(Reconciled {
        base: write_files(repo, &r.base).await?,
        central: write_files(repo, &r.central).await?,
        worker: write_files(repo, &r.worker).await?,
        differs: r.differs,
    })
}

/// Why [`apply`] did nothing.
#[derive(Debug, thiserror::Error)]
pub enum ApplyError {
    /// The worktree changed since the snapshot `apply` started from, where
    /// the target changes it too. Snapshot again and reconcile.
    #[error("the worktree changed: {0}")]
    Changed(String),
    /// The target would write outside the worktree.
    #[error("a path outside the worktree: {0}")]
    Unsafe(String),
    #[error(transparent)]
    Git(#[from] anyhow::Error),
}

/// The first path in `files` that would write outside the worktree: one
/// with an empty, `.`, `..` or `.git` part, or one under a symlink of the
/// same tree. Like git's own `verify_path`, a part counts as `.git` in any
/// of the spellings macOS or Windows read as `.git`, and a `.gitmodules`
/// may not be a symlink.
pub fn unsafe_path(files: &Files) -> Option<String> {
    files
        .iter()
        .find(|(path, entry)| {
            let parts: Vec<&str> = path.split('/').collect();
            parts
                .iter()
                .any(|p| p.is_empty() || *p == "." || *p == ".." || reads_as(p, ".git"))
                || (entry.mode == "120000"
                    && parts.last().is_some_and(|p| reads_as(p, ".gitmodules")))
                || (1..parts.len()).any(|n| {
                    files
                        .get(&parts[..n].join("/"))
                        .is_some_and(|e| e.mode == "120000")
                })
        })
        .map(|(path, _)| path.clone())
}

/// Whether a path part names `dotname` (`.git`, `.gitmodules`) on a Mac or
/// on Windows: case aside, macOS ignores some invisible characters, and
/// Windows ignores trailing dots and spaces and knows the short name
/// `git~1` (`gitmod~1`).
fn reads_as(part: &str, dotname: &str) -> bool {
    // The code points HFS+ ignores in names, as git's `is_hfs_dot_generic`.
    let ignored = |c: &char| matches!(*c as u32, 0x200c..=0x200f | 0x202a..=0x202e | 0x206a..=0x206f | 0xfeff);
    let name: String = part
        .chars()
        .filter(|c| !ignored(c))
        .collect::<String>()
        .to_lowercase();
    let name = name.trim_end_matches(['.', ' ']);
    let short = match dotname {
        ".git" => "git~1",
        _ => "gitmod~1",
    };
    name == dotname || name == short
}

/// Turns `worktree` from `from`, a fresh snapshot of it, into `to`. Only
/// what differs between the two is written. Nothing is written when a
/// file `to` changes was edited since the snapshot, or when an untracked
/// file is in the way: [`ApplyError::Changed`].
pub async fn apply(worktree: &Path, from: &str, to: &str) -> Result<(), ApplyError> {
    if let Some(path) = unsafe_path(&read_files(worktree, to).await?) {
        return Err(ApplyError::Unsafe(path));
    }
    let index = private_index(worktree).await?;
    let file = IndexFile::new(&index);
    let env = file.env();
    git_env(worktree, &env, &["read-tree", from], None).await?;
    // Fresh stat data, so files unchanged since the snapshot count as such.
    // It exits 1 when some did change; read-tree then refuses those.
    run_raw_env(
        "git",
        worktree,
        &["update-index", "-q", "--refresh"],
        &env,
        None,
        GIT_TIMEOUT,
    )
    .await?;
    let out = run_raw_env(
        "git",
        worktree,
        &["read-tree", "-m", "-u", from, to],
        &env,
        None,
        GIT_TIMEOUT,
    )
    .await?;
    if out.status == 0 {
        return Ok(());
    }
    // Leave the private index at `from`, as the worktree still is.
    let _ = git_env(worktree, &env, &["read-tree", from], None).await;
    if worktree_changed(&out.stderr) {
        Err(ApplyError::Changed(out.stderr))
    } else {
        Err(ApplyError::Git(anyhow::anyhow!(
            "git read-tree: {}",
            out.stderr
        )))
    }
}

/// Keeps `oid` (a copy's base) and everything it reaches from `git gc`,
/// under `refs/moonlet/sync/<copy>`.
pub async fn set_base_ref(repo: &Path, copy: &str, oid: &str) -> Result<()> {
    git_env(repo, &[], &["update-ref", &base_ref(copy)?, oid], None).await?;
    Ok(())
}

fn base_ref(copy: &str) -> Result<String> {
    if copy.is_empty() || !copy.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        bail!("invalid copy id {copy:?}");
    }
    Ok(format!("refs/moonlet/sync/{copy}"))
}

/// Removes the ref [`set_base_ref`] made, when the copy goes.
pub async fn delete_base_ref(repo: &Path, copy: &str) -> Result<()> {
    git_env(repo, &[], &["update-ref", "-d", &base_ref(copy)?], None).await?;
    Ok(())
}

/// A git pack of the objects `new` (trees or commits) reach and none of
/// `not` does: what the other side, which has `not`, lacks. Empty when it
/// lacks nothing.
pub async fn pack_objects(repo: &Path, new: &[&str], not: &[&str]) -> Result<Vec<u8>> {
    // Ids only, and through stdin: some come from the other side, and any
    // number of them fits.
    if let Some(bad) = new.iter().chain(not).find(|id| !is_object_id(id)) {
        bail!("not an object id: {bad:?}");
    }
    let mut revs = String::new();
    for id in new {
        revs.push_str(id);
        revs.push('\n');
    }
    // `^<id>`, not a `--not` line: git 2.55 refuses options in --stdin
    // mode ("options not supported in --stdin mode").
    for id in not {
        revs.push('^');
        revs.push_str(id);
        revs.push('\n');
    }
    let objects = git_env(
        repo,
        &[],
        &["rev-list", "--objects", "--stdin"],
        Some(revs.as_bytes()),
    )
    .await?;
    if objects.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }
    // `<oid> <path>` lines: pack-objects uses the paths to pick deltas.
    git_env(
        repo,
        &[],
        &["pack-objects", "--stdout", "-q"],
        Some(&objects),
    )
    .await
}

/// The tree of `commit` in `repo`.
pub async fn commit_tree(repo: &Path, commit: &str) -> Result<String> {
    if !is_object_id(commit) {
        bail!("not an object id: {commit:?}");
    }
    let tree = git_env(
        repo,
        &[],
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{commit}^{{tree}}"),
        ],
        None,
    )
    .await?;
    Ok(String::from_utf8_lossy(&tree).trim().to_string())
}

/// Which of `oids` are objects in `repo`, in their order: what another
/// side says it has can only be left out of a pack if this side has it too.
pub async fn present(repo: &Path, oids: &[String]) -> Result<Vec<String>> {
    let ids: Vec<&String> = oids
        .iter()
        .filter(|o| o.len() >= 40 && o.chars().all(|c| c.is_ascii_hexdigit()))
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let input: String = ids.iter().map(|o| format!("{o}\n")).collect();
    let out = git_env(
        repo,
        &[],
        &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        Some(input.as_bytes()),
    )
    .await?;
    let found: std::collections::HashSet<String> = String::from_utf8_lossy(&out)
        .lines()
        .filter(|l| !l.ends_with(" missing"))
        .filter_map(|l| l.split(' ').next().map(String::from))
        .collect();
    Ok(ids
        .into_iter()
        .filter(|o| found.contains(*o))
        .cloned()
        .collect())
}

/// Why [`unpack`] stored nothing.
#[derive(Debug, thiserror::Error)]
pub enum UnpackError {
    /// A tree in the pack has a path git would refuse to write, such as a
    /// `..` or `.git` entry.
    #[error("a path outside the worktree: {0}")]
    Unsafe(String),
    /// Git found another broken object in the pack.
    #[error("git refused the pack: {0}")]
    Refused(String),
    #[error(transparent)]
    Git(#[from] anyhow::Error),
}

/// Stores the objects of a pack from [`pack_objects`] in `repo`. The other
/// side may be hostile, so the pack is checked as git checks a fetch with
/// `transfer.fsckObjects`: a broken object, or a tree with a `.git` or `..`
/// entry, refuses the whole pack and stores nothing.
pub async fn unpack(repo: &Path, pack: &[u8]) -> Result<(), UnpackError> {
    if pack.is_empty() {
        return Ok(());
    }
    let out = run_raw_env(
        "git",
        repo,
        &["index-pack", "--stdin", "--fix-thin", "--strict"],
        &[],
        Some(pack),
        GIT_TIMEOUT,
    )
    .await?;
    if out.status == 0 {
        // Each pack stays a file of its own; past git's limit `gc --auto`
        // repacks them, so they don't pile up one per sync.
        let repo = repo.to_path_buf();
        tokio::spawn(async move {
            let _ = git_env(&repo, &[], &["gc", "--auto", "--quiet"], None).await;
        });
        return Ok(());
    }
    // `error: object <oid>: <fsck id>: <message>`, then `fatal: fsck error`.
    let why = out
        .stderr
        .lines()
        .find(|l| l.starts_with("error: object "))
        .unwrap_or(out.stderr.trim())
        .to_string();
    // The fsck ids of names that would write outside the worktree.
    let unsafe_ids = [
        ": hasDot:",
        ": hasDotdot:",
        ": hasDotgit:",
        ": gitmodulesSymlink:",
        ": fullPathname:",
        ": emptyName:",
    ];
    if unsafe_ids.iter().any(|id| why.contains(id)) {
        Err(UnpackError::Unsafe(why))
    } else if out.stderr.contains("fsck error") {
        Err(UnpackError::Refused(why))
    } else {
        Err(UnpackError::Git(anyhow::anyhow!(
            "git index-pack: {}",
            out.stderr
        )))
    }
}

/// `url` without a password or token, for another machine to clone from
/// with its own credentials. An `http(s)` URL loses its whole user part,
/// which is often a token itself; other schemes keep the user name, and
/// `git@host:path` stays as it is.
pub fn scrub_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    let Some((user, host)) = authority.rsplit_once('@') else {
        return url.to_string();
    };
    let web = scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https");
    let user = match user.split_once(':') {
        _ if web => None,
        Some((name, _)) => Some(name),
        None => Some(user),
    };
    match user {
        Some(u) if !u.is_empty() => format!("{scheme}://{u}@{host}{path}"),
        _ => format!("{scheme}://{host}{path}"),
    }
}

/// The commit `HEAD` is at in `worktree`.
pub async fn head(worktree: &Path) -> Result<String> {
    let out = git_env(worktree, &[], &["rev-parse", "HEAD"], None).await?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// The branch `worktree` is on, or `None` with a detached `HEAD`.
pub async fn branch(worktree: &Path) -> Result<Option<String>> {
    let out = run_raw_env(
        "git",
        worktree,
        &["symbolic-ref", "-q", "--short", "HEAD"],
        &[],
        None,
        Duration::from_secs(30),
    )
    .await?;
    Ok(parse_branch(out.status, &out.stdout))
}

/// The branch `git symbolic-ref -q --short HEAD` printed, given its exit
/// status: `None` for a detached `HEAD`, which exits 1 printing nothing.
pub fn parse_branch(status: i32, stdout: &[u8]) -> Option<String> {
    let name = String::from_utf8_lossy(stdout).trim().to_string();
    (status == 0 && !name.is_empty()).then_some(name)
}

/// How one side's branch follows the central host's commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadMove {
    /// Both are at the same commit.
    Same,
    /// The side's commit is in the central host's history: it moves up.
    Up,
    /// The central host's commit is in the side's history: the side's
    /// next offer brings its commits.
    Ahead,
    /// Each has commits the other lacks.
    Diverged,
}

/// Where `own` stands against `central`, from whether each is in the
/// other's history.
pub fn head_move(own: &str, central: &str, own_in_central: bool, central_in_own: bool) -> HeadMove {
    if own == central {
        HeadMove::Same
    } else if own_in_central {
        HeadMove::Up
    } else if central_in_own {
        HeadMove::Ahead
    } else {
        HeadMove::Diverged
    }
}

fn commit_id(oid: &str) -> Result<()> {
    if matches!(oid.len(), 40 | 64) && oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        bail!("not a commit id: {oid}")
    }
}

/// Whether commit `a` is `b` or in its history.
pub async fn is_ancestor(repo: &Path, a: &str, b: &str) -> Result<bool> {
    commit_id(a)?;
    commit_id(b)?;
    let out = run_raw_env(
        "git",
        repo,
        &["merge-base", "--is-ancestor", "--end-of-options", a, b],
        &[],
        None,
        Duration::from_secs(60),
    )
    .await?;
    match out.status {
        0 => Ok(true),
        1 => Ok(false),
        _ => bail!("git merge-base: {}", out.stderr),
    }
}

/// How many commits `to` has that `from` lacks.
pub async fn count(repo: &Path, from: &str, to: &str) -> Result<u32> {
    commit_id(from)?;
    commit_id(to)?;
    let range = format!("{from}..{to}");
    let out = git_env(
        repo,
        &[],
        &["rev-list", "--count", "--end-of-options", &range],
        None,
    )
    .await?;
    Ok(String::from_utf8_lossy(&out).trim().parse()?)
}

/// Moves `branch` from `from` up to `to`, and when `worktree` still has it
/// checked out, resets the staging area to it; the files stay as they are.
/// Fails, moving nothing, when the branch is no longer at `from`.
pub async fn fast_forward(worktree: &Path, branch: &str, from: &str, to: &str) -> Result<()> {
    commit_id(from)?;
    commit_id(to)?;
    let r = format!("refs/heads/{branch}");
    git_env(worktree, &[], &["update-ref", &r, to, from], None).await?;
    if self::branch(worktree).await?.as_deref() == Some(branch) {
        git_env(worktree, &[], &["reset", "-q"], None).await?;
    }
    Ok(())
}

/// Moves the branch checked out in `worktree` from `from` to `to`, and
/// resets the staging area to it; the files stay as they are. Fails,
/// moving nothing, when `HEAD` is no longer at `from`: a commit made since,
/// or another branch checked out.
pub async fn reset_branch(worktree: &Path, from: &str, to: &str) -> Result<()> {
    commit_id(from)?;
    commit_id(to)?;
    git_env(worktree, &[], &["update-ref", "HEAD", to, from], None).await?;
    git_env(worktree, &[], &["reset", "-q"], None).await?;
    Ok(())
}

/// Makes branch `name` at commit `at`; fails if it exists.
pub async fn create_branch(repo: &Path, name: &str, at: &str) -> Result<()> {
    commit_id(at)?;
    let r = format!("refs/heads/{name}");
    git_env(repo, &[], &["update-ref", &r, at, ""], None).await?;
    Ok(())
}

/// Deletes branch `name` from `repo` while it is still at `at`.
pub async fn delete_branch(repo: &Path, name: &str, at: &str) -> Result<()> {
    commit_id(at)?;
    let r = format!("refs/heads/{name}");
    git_env(repo, &[], &["update-ref", "-d", &r, at], None).await?;
    Ok(())
}

/// Whether branch `name` exists in `repo`.
pub async fn branch_exists(repo: &Path, name: &str) -> bool {
    let r = format!("refs/heads/{name}");
    run_raw_env(
        "git",
        repo,
        &["show-ref", "--verify", "-q", &r],
        &[],
        None,
        Duration::from_secs(30),
    )
    .await
    .is_ok_and(|o| o.status == 0)
}

/// Files on disk that the worktree's last [`snapshot`] does not carry as
/// they are, so only this machine has them: untracked secrets
/// ([`NEVER_SYNCED`]), and files kept at their last synced version because
/// they became ignored or grew past the limit and changed since. Plain
/// ignored files, such as build output, are not among them. Sorted.
pub async fn local_only(worktree: &Path) -> Result<Vec<String>> {
    let index = private_index(worktree).await?;
    let file = IndexFile::new(&index);
    let env = file.env();
    // Files whose content matches the snapshot only lack fresh stat data.
    let _ = git_env(worktree, &env, &["update-index", "-q", "--refresh"], None).await;
    let changed = git_env(
        worktree,
        &env,
        &["diff-files", "-z", "--name-only", "--ignore-submodules"],
        None,
    )
    .await?;
    let excludes = git_dir(worktree).await?.join("moonlet-sync-excludes");
    let excludes_opt = format!("--exclude-from={}", excludes.display());
    let secrets = git_env(
        worktree,
        &env,
        &["ls-files", "-z", "--others", "--ignored", &excludes_opt],
        None,
    )
    .await?;
    let mut paths: Vec<String> = split_z(&changed)
        .chain(split_z(&secrets).filter(|p| never_synced(p)))
        .filter(|p| std::fs::symlink_metadata(worktree.join(p)).is_ok())
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// Removes worktree `dir` of `repo`, with whatever is in it; its branch
/// stays.
pub async fn remove_worktree(repo: &Path, dir: &Path) -> Result<()> {
    let dir = dir.to_string_lossy().to_string();
    git_env(
        repo,
        &[],
        &[
            "worktree",
            "remove",
            // Twice: once for changed files, once for a locked worktree.
            "--force",
            "--force",
            "--end-of-options",
            &dir,
        ],
        None,
    )
    .await?;
    Ok(())
}

/// Forgets `repo`'s worktrees whose folders are gone.
pub async fn prune_worktrees(repo: &Path) -> Result<()> {
    git_env(repo, &[], &["worktree", "prune"], None).await?;
    Ok(())
}

/// Clones `url` into `dir` with this machine's own credentials. The error
/// is git's own message, such as `repository '…' not found`.
pub async fn clone(url: &str, dir: &Path) -> std::result::Result<(), String> {
    if !clonable_url(url) {
        return Err(format!("only https and ssh origins are cloned: {url}"));
    }
    // Never into, nor away with, a folder this clone didn't make.
    let made = match std::fs::read_dir(dir) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                return Err(format!("{} is in the way", dir.display()));
            }
            false
        }
        Err(_) => true,
    };
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let dir_s = dir.to_string_lossy().to_string();
    let cwd = dir.parent().unwrap_or(Path::new("/"));
    let out = run_raw_env(
        "git",
        cwd,
        &["clone", "-q", "--", url, &dir_s],
        &origin_env(),
        None,
        Duration::from_secs(1800),
    )
    .await
    .map_err(|e| format!("{e:#}"))?;
    if out.status == 0 {
        return Ok(());
    }
    if made {
        let _ = std::fs::remove_dir_all(dir);
    }
    Err(clone_error(&out.stderr))
}

/// Whether `url` is one a copy clones from: `https://`, `ssh://` or
/// scp-like `[user@]host:path`. Never a local path, `file://` or another
/// transport: the URL comes from the central host, and a local one would
/// copy this Mac's own repositories into the clone.
pub fn clonable_url(url: &str) -> bool {
    if let Some((scheme, rest)) = url.split_once("://") {
        return matches!(scheme, "https" | "ssh") && !rest.is_empty();
    }
    // scp-like: a host before the first `:`, and no `/` before it.
    match url.split_once(':') {
        Some((host, path)) => {
            let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
            // `<transport>::<address>` is a remote helper, not a host.
            host.len() > 1
                && !path.is_empty()
                && !path.starts_with(':')
                && !url.starts_with(['-', '/', '.'])
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
        }
        None => false,
    }
}

/// Test-only: `MOONLET_SYNC_LOCAL_ORIGINS=1` lets git reach an https
/// origin that a `url.insteadOf` rule turns into a local path, as the
/// daemon tests' origins are.
fn local_origins() -> bool {
    std::env::var_os("MOONLET_SYNC_LOCAL_ORIGINS").is_some_and(|v| v == "1")
}

/// What git may use to reach an origin: https and ssh only.
fn origin_env() -> Vec<(&'static str, &'static str)> {
    if local_origins() {
        Vec::new()
    } else {
        vec![("GIT_ALLOW_PROTOCOL", "https:ssh")]
    }
}

/// The line of a failed clone's output that says why: the server's own
/// (`remote: Repository not found.`), else git's first `fatal:` one.
fn clone_error(stderr: &str) -> String {
    let lines = || stderr.lines().map(str::trim);
    lines()
        .find_map(|l| l.strip_prefix("remote: "))
        .or_else(|| lines().find_map(|l| l.strip_prefix("fatal: ")))
        .or_else(|| lines().rfind(|l| !l.is_empty()))
        .unwrap_or("git clone failed")
        .to_string()
}

/// Fetches origin, so only what it lacks needs to come from the central
/// host. A failed fetch only means more comes from there.
pub async fn fetch_origin(repo: &Path) {
    let _ = run_raw_env(
        "git",
        repo,
        &["fetch", "-q", "--no-tags", "origin"],
        &origin_env(),
        None,
        Duration::from_secs(600),
    )
    .await;
}

/// The commits `repo`'s branches, remote-tracking branches and copy bases
/// point at: what a pack sent to it can leave out.
pub async fn have(repo: &Path) -> Vec<String> {
    let out = git_env(
        repo,
        &[],
        &[
            "for-each-ref",
            "--format=%(objectname)",
            "refs/heads",
            "refs/remotes",
            "refs/moonlet",
        ],
        None,
    )
    .await
    .unwrap_or_default();
    let mut ids: Vec<String> = String::from_utf8_lossy(&out)
        .lines()
        .map(String::from)
        .collect();
    ids.sort();
    ids.dedup();
    // A repository with thousands of branches only makes a pack a little
    // smaller with all of them; the other side checks each one it is sent.
    ids.truncate(MAX_HAVE);
    ids
}

/// The most commits [`have`] names.
const MAX_HAVE: usize = 2000;

/// The worktree of `repo`, the main one included, that has `branch`
/// checked out.
pub async fn checked_out(repo: &Path, branch: &str) -> Option<PathBuf> {
    let out = git_env(repo, &[], &["worktree", "list", "--porcelain"], None)
        .await
        .ok()?;
    let want = format!("branch refs/heads/{branch}");
    String::from_utf8_lossy(&out)
        .split("\n\n")
        .find(|entry| entry.lines().any(|l| l == want))
        .and_then(|entry| entry.lines().find_map(|l| l.strip_prefix("worktree ")))
        .map(PathBuf::from)
}

/// Adds a worktree of `repo` at `dir` on `branch`, set to `head` first.
/// Why [`add_worktree`] made nothing.
#[derive(Debug)]
pub enum WorktreeError {
    /// The branch name or commit id is not one git takes as it is.
    Invalid(String),
    /// The branch exists here with commits the given one lacks.
    Ahead,
    Git(anyhow::Error),
}

impl std::fmt::Display for WorktreeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorktreeError::Invalid(why) => f.write_str(why),
            WorktreeError::Ahead => f.write_str("the branch has commits of its own"),
            WorktreeError::Git(e) => write!(f, "{e:#}"),
        }
    }
}

impl From<anyhow::Error> for WorktreeError {
    fn from(e: anyhow::Error) -> Self {
        WorktreeError::Git(e)
    }
}

impl From<std::io::Error> for WorktreeError {
    fn from(e: std::io::Error) -> Self {
        WorktreeError::Git(e.into())
    }
}

/// Makes worktree `dir` of `repo` on `branch` at commit `head`, both from
/// the central host. A branch already here is used when it is at `head`,
/// moved up to it when behind, and never moved back: with commits of its
/// own it is left alone and nothing is made.
pub async fn add_worktree(
    repo: &Path,
    dir: &Path,
    branch: &str,
    head: &str,
) -> Result<(), WorktreeError> {
    let valid_name = !branch.starts_with('-')
        && run_raw_env(
            "git",
            repo,
            &["check-ref-format", "--branch", branch],
            &[],
            None,
            Duration::from_secs(30),
        )
        .await
        .is_ok_and(|o| o.status == 0);
    if !valid_name {
        return Err(WorktreeError::Invalid(format!(
            "invalid branch name: {branch}"
        )));
    }
    if !is_object_id(head) {
        return Err(WorktreeError::Invalid(format!("not a commit id: {head}")));
    }
    let r = format!("refs/heads/{branch}");
    let here = git_env(
        repo,
        &[],
        &[
            "rev-parse",
            "--verify",
            "-q",
            "--end-of-options",
            &format!("{r}^{{commit}}"),
        ],
        None,
    )
    .await
    .ok()
    .map(|o| String::from_utf8_lossy(&o).trim().to_string());
    match here {
        // Made only if still missing.
        None => {
            git_env(repo, &[], &["update-ref", &r, head, ""], None).await?;
        }
        Some(here) if here == head => {}
        Some(here) => {
            let behind = run_raw_env(
                "git",
                repo,
                &[
                    "merge-base",
                    "--is-ancestor",
                    "--end-of-options",
                    &here,
                    head,
                ],
                &[],
                None,
                Duration::from_secs(60),
            )
            .await?
            .status
                == 0;
            if !behind {
                return Err(WorktreeError::Ahead);
            }
            // Moved only from where it was seen.
            git_env(repo, &[], &["update-ref", &r, head, &here], None).await?;
        }
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let dir_s = dir.to_string_lossy().to_string();
    git_env(
        repo,
        &[],
        &["worktree", "add", "-q", "--end-of-options", &dir_s, branch],
        None,
    )
    .await?;
    Ok(())
}

/// The NUL-separated names of `out` that are text. Names that aren't are
/// skipped, never carried with a replacement character: see [`bad_names_z`].
fn split_z(out: &[u8]) -> impl Iterator<Item = String> + '_ {
    out.split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .filter_map(|s| String::from_utf8(s.to_vec()).ok())
}

/// The NUL-separated names of `out` that are not text, as they are.
fn bad_names_z(out: &[u8]) -> Vec<Vec<u8>> {
    out.split(|b| *b == 0)
        .filter(|s| !s.is_empty() && std::str::from_utf8(s).is_err())
        .map(<[u8]>::to_vec)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::git;

    /// A repository with the worked example's files (X60, "What syncs").
    async fn worked_example() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "Test"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            git(p, &args).await.unwrap();
        }
        std::fs::write(p.join(".gitignore"), "node_modules/\n.env\nvendor/\n").unwrap();
        std::fs::create_dir_all(p.join("src")).unwrap();
        std::fs::write(p.join("src/cart.ts"), "export const cart = [];\n").unwrap();
        std::fs::write(p.join("run.sh"), "#!/bin/sh\n").unwrap();
        set_mode(&p.join("run.sh"), 0o755);
        std::fs::create_dir_all(p.join("vendor")).unwrap();
        std::fs::write(p.join("vendor/keep.js"), "kept\n").unwrap();
        git(p, &["add", "-A"]).await.unwrap();
        git(p, &["add", "-f", "vendor/keep.js"]).await.unwrap();
        git(p, &["commit", "-q", "-m", "init"]).await.unwrap();

        std::fs::write(p.join("src/cart.ts"), "export const cart = [1];\n").unwrap();
        std::fs::write(p.join("src/new.ts"), "new\n").unwrap();
        std::fs::create_dir_all(p.join("node_modules/left-pad")).unwrap();
        std::fs::write(p.join("node_modules/left-pad/index.js"), "pad\n").unwrap();
        std::fs::write(p.join(".env"), "SECRET=1\n").unwrap();
        std::fs::write(p.join("scratch.txt"), "notes\n").unwrap();
        std::os::unix::fs::symlink("src/cart.ts", p.join("link")).unwrap();
        // The user's own excludes ignore scratch.txt. Set here rather than
        // in a global config, which `-c` overrides the same way.
        std::fs::write(p.join(".git/my-excludes"), "scratch.txt\n").unwrap();
        let excludes = p.join(".git/my-excludes");
        git(
            p,
            &["config", "core.excludesFile", excludes.to_str().unwrap()],
        )
        .await
        .unwrap();
        dir
    }

    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    async fn listing(repo: &Path, tree: &str) -> Vec<(String, String)> {
        let out = git(repo, &["ls-tree", "-r", "--full-tree", tree])
            .await
            .unwrap();
        String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| {
                let (meta, path) = l.split_once('\t').unwrap();
                (
                    path.to_string(),
                    meta.split(' ').next().unwrap().to_string(),
                )
            })
            .collect()
    }

    fn pairs(rows: &[(&str, &str)]) -> Vec<(String, String)> {
        rows.iter()
            .map(|(p, m)| (p.to_string(), m.to_string()))
            .collect()
    }

    #[tokio::test]
    async fn a_snapshot_follows_gits_rules_without_global_excludes() {
        let dir = worked_example().await;
        let p = dir.path();
        let snap = snapshot(p, MAX_FILE).await.unwrap();
        assert_eq!(
            listing(p, &snap.tree).await,
            pairs(&[
                (".gitignore", "100644"),
                ("link", "120000"),
                ("run.sh", "100755"),
                ("scratch.txt", "100644"),
                ("src/cart.ts", "100644"),
                ("src/new.ts", "100644"),
                ("vendor/keep.js", "100644"),
            ])
        );
        assert!(snap.too_big.is_empty());
        // The session's own staging area is untouched.
        let staged = git(p, &["diff", "--cached", "--name-only"]).await.unwrap();
        assert_eq!(String::from_utf8(staged).unwrap(), "");
    }

    fn paths(listing: Vec<(String, String)>) -> Vec<String> {
        listing.into_iter().map(|(p, _)| p).collect()
    }

    #[tokio::test]
    async fn untracked_secrets_stay_out_even_when_no_gitignore_says_so() {
        let dir = worked_example().await;
        let p = dir.path();
        // Committed on purpose: a tracked file still syncs.
        std::fs::create_dir_all(p.join("config")).unwrap();
        std::fs::write(p.join("config/dev.key"), "dev only\n").unwrap();
        git(p, &["add", "config/dev.key"]).await.unwrap();
        git(p, &["commit", "-q", "-m", "dev key"]).await.unwrap();
        for f in [
            ".env.local",
            ".env.production.local",
            "deploy.pem",
            "certs/server.key",
            "id_ed25519",
            "id_rsa.pub",
            ".npmrc",
            ".netrc",
        ] {
            let path = p.join(f);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "secret\n").unwrap();
        }
        let snap = snapshot(p, MAX_FILE).await.unwrap();
        assert_eq!(
            listing(p, &snap.tree).await,
            pairs(&[
                (".gitignore", "100644"),
                ("config/dev.key", "100644"),
                ("link", "120000"),
                ("run.sh", "100755"),
                ("scratch.txt", "100644"),
                ("src/cart.ts", "100644"),
                ("src/new.ts", "100644"),
                ("vendor/keep.js", "100644"),
            ])
        );
    }

    #[tokio::test]
    async fn secrets_stay_out_whatever_the_gitignore_lets_back_in() {
        let dir = worked_example().await;
        let p = dir.path();
        std::fs::create_dir_all(p.join("config")).unwrap();
        std::fs::write(p.join("config/dev.key"), "dev only\n").unwrap();
        git(p, &["add", "config/dev.key"]).await.unwrap();
        git(p, &["commit", "-q", "-m", "dev key"]).await.unwrap();
        // The project's own rules let the files back in.
        let mut gitignore = std::fs::read_to_string(p.join(".gitignore")).unwrap();
        gitignore.push_str("!.env.local\n!*.pem\n!.npmrc\n");
        std::fs::write(p.join(".gitignore"), gitignore).unwrap();
        for f in [".env.local", "deploy.pem", "sub/.npmrc", "notes.txt"] {
            let path = p.join(f);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "secret\n").unwrap();
        }
        std::fs::write(p.join("config/dev.key"), "dev only, rotated\n").unwrap();
        let snap = snapshot(p, MAX_FILE).await.unwrap();
        let names: Vec<String> = listing(p, &snap.tree)
            .await
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        assert_eq!(
            names,
            [
                ".gitignore",
                "config/dev.key",
                "link",
                "notes.txt",
                "run.sh",
                "scratch.txt",
                "src/cart.ts",
                "src/new.ts",
                "vendor/keep.js",
            ]
        );
        // A tracked secret still syncs its edits.
        let key = git(
            p,
            &["cat-file", "-p", &format!("{}:config/dev.key", snap.tree)],
        )
        .await
        .unwrap();
        assert_eq!(String::from_utf8(key).unwrap(), "dev only, rotated\n");

        // A synced file renamed to a secret's name leaves.
        std::fs::rename(p.join("notes.txt"), p.join("sub/.env.local")).unwrap();
        let snap = snapshot(p, MAX_FILE).await.unwrap();
        let names: Vec<String> = listing(p, &snap.tree)
            .await
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        assert!(
            !names
                .iter()
                .any(|n| n == "notes.txt" || n.ends_with(".env.local")),
            "{names:?}"
        );
    }

    #[tokio::test]
    async fn a_file_ignored_after_a_snapshot_stays_at_its_last_version() {
        let dir = worked_example().await;
        let p = dir.path();
        std::fs::create_dir_all(p.join("build")).unwrap();
        std::fs::write(p.join("build/out.js"), "built\n").unwrap();
        std::fs::write(p.join("notes.txt"), "mine\n").unwrap();
        let first = snapshot(p, MAX_FILE).await.unwrap();
        assert!(paths(listing(p, &first.tree).await).contains(&"build/out.js".to_string()));

        // Ignored on both sides through .gitignore, and on this side only
        // through .git/info/exclude, which doesn't sync. The other side
        // must not read either as deleted, and their new contents must not
        // leave this machine.
        std::fs::write(
            p.join(".gitignore"),
            "node_modules/\n.env\nvendor/\nbuild/\n",
        )
        .unwrap();
        std::fs::write(p.join(".git/info/exclude"), "notes.txt\n").unwrap();
        std::fs::write(p.join("build/out.js"), "built again\n").unwrap();
        std::fs::write(p.join("notes.txt"), "a secret now\n").unwrap();
        let second = snapshot(p, MAX_FILE).await.unwrap();
        assert_eq!(
            show(p, &second.tree, "build/out.js").await.as_deref(),
            Some("built\n")
        );
        assert_eq!(
            show(p, &second.tree, "notes.txt").await.as_deref(),
            Some("mine\n")
        );

        // An untracked file the rules already ignore never enters.
        std::fs::write(p.join("build/new.js"), "new\n").unwrap();
        let third = snapshot(p, MAX_FILE).await.unwrap();
        assert!(!paths(listing(p, &third.tree).await).contains(&"build/new.js".to_string()));

        // Gone from disk: gone from the snapshot.
        std::fs::remove_file(p.join("build/out.js")).unwrap();
        let fourth = snapshot(p, MAX_FILE).await.unwrap();
        assert!(!paths(listing(p, &fourth.tree).await).contains(&"build/out.js".to_string()));
    }

    #[test]
    fn only_full_hex_ids_are_object_ids() {
        assert!(is_object_id("4171b03ff0d2bd434751f17bc9d34da784f97e72"));
        assert!(is_object_id(&"ab".repeat(32)));
        for id in [
            "",
            "4171b03",
            "HEAD",
            "--output=/tmp/x",
            "4171b03ff0d2bd434751f17bc9d34da784f97e7g",
            "4171b03ff0d2bd434751f17bc9d34da784f97e72 ",
        ] {
            assert!(!is_object_id(id), "{id:?}");
        }
    }

    #[tokio::test]
    async fn a_file_head_tracks_is_in_even_when_force_added_later() {
        let dir = worked_example().await;
        let p = dir.path();
        snapshot(p, MAX_FILE).await.unwrap();
        // vendor/ is ignored; this file is committed past that.
        std::fs::write(p.join("vendor/later.js"), "later\n").unwrap();
        git(p, &["add", "-f", "vendor/later.js"]).await.unwrap();
        git(p, &["commit", "-q", "-m", "later"]).await.unwrap();
        let snap = snapshot(p, MAX_FILE).await.unwrap();
        assert_eq!(
            show(p, &snap.tree, "vendor/later.js").await.as_deref(),
            Some("later\n")
        );
    }

    #[tokio::test]
    async fn thousands_of_paths_fit_whatever_the_command_line_allows() {
        let dir = worked_example().await;
        let p = dir.path();
        // 6000 names of 200 bytes: 1.2 MB, past macOS's 1 MiB ARG_MAX.
        std::fs::create_dir_all(p.join("build")).unwrap();
        for i in 0..6000 {
            std::fs::write(p.join(format!("build/{i:05}{}", "x".repeat(195))), "ab").unwrap();
        }
        let snap = snapshot(p, 1).await.unwrap();
        assert_eq!(
            snap.too_big
                .iter()
                .filter(|p| p.starts_with("build/"))
                .count(),
            6000
        );
    }

    #[tokio::test]
    async fn a_file_over_the_limit_stays_on_its_machine_and_never_reads_as_deleted() {
        let dir = worked_example().await;
        let p = dir.path();
        std::fs::write(p.join("big.bin"), vec![7u8; 2048]).unwrap();
        std::fs::write(p.join("grows.bin"), vec![7u8; 10]).unwrap();
        let first = snapshot(p, 1024).await.unwrap();
        assert_eq!(first.too_big, ["big.bin"]);
        let listed = paths(listing(p, &first.tree).await);
        assert!(
            listed.contains(&"grows.bin".to_string()) && !listed.contains(&"big.bin".to_string())
        );
        let small = show(p, &first.tree, "grows.bin").await;

        std::fs::write(p.join("grows.bin"), vec![7u8; 2048]).unwrap();
        let second = snapshot(p, 1024).await.unwrap();
        assert_eq!(second.too_big, ["big.bin", "grows.bin"]);
        // Its last synced version stays in, so the other side keeps it.
        assert_eq!(show(p, &second.tree, "grows.bin").await, small);
        let r = reconcile_trees(p, &first.tree, &first.tree, &second.tree)
            .await
            .unwrap();
        assert_eq!(show(p, &r.central, "grows.bin").await, small);
    }

    #[tokio::test]
    async fn a_name_that_is_not_text_stays_out_of_the_snapshot() {
        use std::os::unix::ffi::OsStrExt;
        let dir = worked_example().await;
        let p = dir.path();
        let name = std::ffi::OsStr::from_bytes(b"bad\xff.txt");
        if std::fs::write(p.join(name), "x\n").is_err() {
            // macOS file systems refuse such names; only Linux has them.
            return;
        }
        let snap = snapshot(p, MAX_FILE).await.unwrap();
        assert_eq!(snap.bad_names, ["bad\u{fffd}.txt"]);
        let raw = git(p, &["ls-tree", "-r", "-z", "--name-only", &snap.tree])
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(raw.as_ref()).contains("bad"));
    }

    #[tokio::test]
    async fn a_file_committed_past_its_ignore_rule_is_still_held_to_the_size_limit() {
        let dir = worked_example().await;
        let p = dir.path();
        let first = snapshot(p, 1024).await.unwrap();
        std::fs::write(p.join("vendor/blob.bin"), vec![1u8; 10]).unwrap();
        git(p, &["add", "-f", "vendor/blob.bin"]).await.unwrap();
        git(p, &["commit", "-q", "-m", "blob"]).await.unwrap();
        // Grown past the limit before the next snapshot.
        std::fs::write(p.join("vendor/blob.bin"), vec![1u8; 2048]).unwrap();
        let snap = snapshot(p, 1024).await.unwrap();
        assert_eq!(snap.too_big, ["vendor/blob.bin"]);
        assert!(!paths(listing(p, &snap.tree).await).contains(&"vendor/blob.bin".to_string()));
        let _ = first;
    }

    fn files(rows: &[(&str, &str, &str)]) -> Files {
        rows.iter()
            .map(|(p, mode, oid)| {
                (
                    p.to_string(),
                    Entry {
                        mode: mode.to_string(),
                        oid: oid.to_string(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn reconciling_follows_the_worked_examples() {
        // One path per row of the spec's table: base, studio-mini, this Mac.
        let base = files(&[
            ("1", "100644", "a"),
            ("2", "100644", "a"),
            ("3", "100644", "a"),
            ("4", "100644", "a"),
            ("5", "100644", "a"),
            ("6", "100644", "a"),
            ("7", "100644", "a"),
            ("11", "100644", "a"),
            ("12", "100644", "a"),
            ("13", "100644", "a"),
        ]);
        let central = files(&[
            ("1", "100644", "a"),
            ("2", "100644", "b"),
            ("3", "100644", "b"),
            ("4", "100644", "b"),
            // 5 and 6: deleted on studio-mini.
            ("7", "100755", "a"),
            ("8", "100644", "a"),
            ("9", "100644", "a"),
            ("10", "100644", "a"),
            ("11", "100644", "b"),
            ("12", "100644", "a"),
            // 13: deleted on studio-mini.
        ]);
        let worker = files(&[
            ("1", "100644", "b"),
            ("2", "100644", "a"),
            ("3", "100644", "b"),
            ("4", "100644", "c"),
            ("5", "100644", "a"),
            ("6", "100644", "b"),
            ("7", "100644", "a"),
            // 8: none on this Mac.
            ("9", "100644", "a"),
            ("10", "100644", "b"),
            // 11, 12 and 13: deleted on this Mac.
        ]);
        let r = reconcile(&base, &central, &worker);
        assert_eq!(r.differs, ["10", "11", "4", "6"]);
        assert_eq!(
            r.central,
            files(&[
                ("1", "100644", "b"),
                ("10", "100644", "a"),
                ("11", "100644", "b"),
                ("2", "100644", "b"),
                ("3", "100644", "b"),
                ("4", "100644", "b"),
                ("7", "100755", "a"),
                ("8", "100644", "a"),
                ("9", "100644", "a"),
            ])
        );
        assert_eq!(
            r.worker,
            files(&[
                ("1", "100644", "b"),
                ("10", "100644", "b"),
                ("2", "100644", "b"),
                ("3", "100644", "b"),
                ("4", "100644", "c"),
                ("6", "100644", "b"),
                ("7", "100755", "a"),
                ("8", "100644", "a"),
                ("9", "100644", "a"),
            ])
        );
        assert_eq!(
            r.base,
            files(&[
                ("1", "100644", "b"),
                ("11", "100644", "a"),
                ("2", "100644", "b"),
                ("3", "100644", "b"),
                ("4", "100644", "a"),
                ("6", "100644", "a"),
                ("7", "100755", "a"),
                ("8", "100644", "a"),
                ("9", "100644", "a"),
            ])
        );
    }

    #[test]
    fn a_path_stops_differing_once_both_sides_match() {
        let base = files(&[("src/cart.ts", "100644", "a")]);
        let central = files(&[("src/cart.ts", "100644", "b")]);
        let worker = files(&[("src/cart.ts", "100644", "c")]);
        assert_eq!(reconcile(&base, &central, &worker).differs, ["src/cart.ts"]);
        // Kept this Mac's: both sides now have c, against the old base.
        let r = reconcile(&base, &worker, &worker);
        assert!(r.differs.is_empty());
        assert_eq!(r.base, worker);
    }

    #[test]
    fn names_that_differ_only_in_case_differ_when_new() {
        // A Mac's disk keeps one of the two, so one would overwrite the other.
        let base = files(&[("src/a.ts", "100644", "a")]);
        let central = files(&[("src/a.ts", "100644", "a"), ("Readme.md", "100644", "c")]);
        let worker = files(&[("src/a.ts", "100644", "a"), ("README.md", "100644", "w")]);
        let r = reconcile(&base, &central, &worker);
        assert_eq!(r.differs, ["README.md", "Readme.md"]);
        assert_eq!(
            r.central,
            files(&[("Readme.md", "100644", "c"), ("src/a.ts", "100644", "a")])
        );
        assert_eq!(
            r.worker,
            files(&[("README.md", "100644", "w"), ("src/a.ts", "100644", "a")])
        );
        assert_eq!(r.base, files(&[("src/a.ts", "100644", "a")]));

        // Folders too: `Docs/` on one side, `docs/` on the other.
        let central = files(&[("src/a.ts", "100644", "a"), ("Docs/x.md", "100644", "c")]);
        let worker = files(&[("src/a.ts", "100644", "a"), ("docs/y.md", "100644", "w")]);
        let r = reconcile(&base, &central, &worker);
        assert_eq!(r.differs, ["Docs/x.md", "docs/y.md"]);
    }

    #[test]
    fn a_file_against_a_folder_of_the_same_name_differs() {
        let base = Files::new();
        let central = files(&[("a", "100644", "f")]);
        let worker = files(&[("a/x", "100644", "g"), ("b", "100644", "h")]);
        let r = reconcile(&base, &central, &worker);
        assert_eq!(r.differs, ["a", "a/x"]);
        assert_eq!(
            r.central,
            files(&[("a", "100644", "f"), ("b", "100644", "h")])
        );
        assert_eq!(
            r.worker,
            files(&[("a/x", "100644", "g"), ("b", "100644", "h")])
        );
        assert_eq!(r.base, files(&[("b", "100644", "h")]));
    }

    async fn show(repo: &Path, tree: &str, path: &str) -> Option<String> {
        git(repo, &["show", &format!("{tree}:{path}")])
            .await
            .ok()
            .map(|b| String::from_utf8(b).unwrap())
    }

    #[tokio::test]
    async fn reconciling_trees_writes_each_sides_tree() {
        let dir = worked_example().await;
        let p = dir.path();
        let base = snapshot(p, MAX_FILE).await.unwrap().tree;
        std::fs::write(p.join("src/cart.ts"), "studio-mini's cart\n").unwrap();
        std::fs::write(p.join("src/new.ts"), "studio-mini's new\n").unwrap();
        let central = snapshot(p, MAX_FILE).await.unwrap().tree;
        std::fs::write(p.join("src/cart.ts"), "export const cart = [1];\n").unwrap();
        std::fs::write(p.join("src/new.ts"), "this Mac's new\n").unwrap();
        std::fs::remove_file(p.join("scratch.txt")).unwrap();
        let worker = snapshot(p, MAX_FILE).await.unwrap().tree;

        let r = reconcile_trees(p, &base, &central, &worker).await.unwrap();
        assert_eq!(r.differs, ["src/new.ts"]);
        for tree in [&r.central, &r.worker, &r.base] {
            assert_eq!(
                show(p, tree, "src/cart.ts").await.as_deref(),
                Some("studio-mini's cart\n")
            );
            assert_eq!(show(p, tree, "scratch.txt").await, None);
            assert_eq!(
                show(p, tree, "run.sh").await.as_deref(),
                Some("#!/bin/sh\n")
            );
        }
        assert_eq!(
            show(p, &r.central, "src/new.ts").await.as_deref(),
            Some("studio-mini's new\n")
        );
        assert_eq!(
            show(p, &r.worker, "src/new.ts").await.as_deref(),
            Some("this Mac's new\n")
        );
        assert_eq!(
            show(p, &r.base, "src/new.ts").await.as_deref(),
            Some("new\n")
        );
        assert_eq!(
            listing(p, &r.central)
                .await
                .iter()
                .find(|(p, _)| p == "link")
                .unwrap()
                .1,
            "120000"
        );
    }

    fn read(p: &Path, path: &str) -> Option<String> {
        std::fs::read_to_string(p.join(path)).ok()
    }

    #[tokio::test]
    async fn applying_writes_what_differs() {
        let dir = worked_example().await;
        let p = dir.path();
        let older = snapshot(p, MAX_FILE).await.unwrap().tree;
        std::fs::write(p.join("src/cart.ts"), "studio-mini's cart\n").unwrap();
        std::fs::remove_file(p.join("src/new.ts")).unwrap();
        std::fs::write(p.join("src/added.ts"), "added\n").unwrap();
        let newer = snapshot(p, MAX_FILE).await.unwrap().tree;

        apply(p, &newer, &older).await.unwrap();
        assert_eq!(
            read(p, "src/cart.ts").as_deref(),
            Some("export const cart = [1];\n")
        );
        assert_eq!(read(p, "src/new.ts").as_deref(), Some("new\n"));
        assert_eq!(read(p, "src/added.ts"), None);
        // Ignored files are not part of either tree, and stay.
        assert_eq!(read(p, ".env").as_deref(), Some("SECRET=1\n"));
        assert_eq!(snapshot(p, MAX_FILE).await.unwrap().tree, older);

        apply(p, &older, &newer).await.unwrap();
        assert_eq!(
            read(p, "src/cart.ts").as_deref(),
            Some("studio-mini's cart\n")
        );
        assert_eq!(snapshot(p, MAX_FILE).await.unwrap().tree, newer);
    }

    #[tokio::test]
    async fn an_edit_since_the_snapshot_is_never_overwritten() {
        let dir = worked_example().await;
        let p = dir.path();
        let older = snapshot(p, MAX_FILE).await.unwrap().tree;
        std::fs::write(p.join("src/cart.ts"), "studio-mini's cart\n").unwrap();
        std::fs::remove_file(p.join("src/new.ts")).unwrap();
        let newer = snapshot(p, MAX_FILE).await.unwrap().tree;

        // Edited after the snapshot, in a file the target changes.
        std::fs::write(p.join("src/cart.ts"), "typed just now\n").unwrap();
        let e = apply(p, &newer, &older).await.unwrap_err();
        assert!(matches!(e, ApplyError::Changed(_)), "{e}");
        assert_eq!(read(p, "src/cart.ts").as_deref(), Some("typed just now\n"));
        assert_eq!(read(p, "src/new.ts"), None);

        // An untracked file where the target puts one.
        std::fs::write(p.join("src/cart.ts"), "studio-mini's cart\n").unwrap();
        std::fs::write(p.join("src/new.ts"), "mine\n").unwrap();
        let e = apply(p, &newer, &older).await.unwrap_err();
        assert!(matches!(e, ApplyError::Changed(_)), "{e}");
        assert_eq!(read(p, "src/new.ts").as_deref(), Some("mine\n"));
    }

    #[test]
    fn paths_outside_the_worktree_are_found() {
        let ok = files(&[
            ("src/cart.ts", "100644", "a"),
            ("link", "120000", "b"),
            ("linked/x", "100644", "c"),
        ]);
        assert_eq!(unsafe_path(&ok), None);
        for (bad, path) in [
            (files(&[("../x", "100644", "a")]), "../x"),
            (files(&[("src/../../x", "100644", "a")]), "src/../../x"),
            (
                files(&[(".git/hooks/post-checkout", "100755", "a")]),
                ".git/hooks/post-checkout",
            ),
            (
                files(&[("sub/.GIT/config", "100644", "a")]),
                "sub/.GIT/config",
            ),
            (files(&[("/etc/passwd", "100644", "a")]), "/etc/passwd"),
            (
                files(&[("link", "120000", "a"), ("link/x", "100644", "b")]),
                "link/x",
            ),
        ] {
            assert_eq!(unsafe_path(&bad).as_deref(), Some(path));
        }
    }

    #[test]
    fn names_a_mac_or_windows_reads_as_git_are_found() {
        // What git's own verify_path refuses: macOS ignores some invisible
        // characters in names, and Windows reads `git~1` and a trailing dot
        // or space as `.git`.
        for path in [
            ".g\u{200c}it/hooks/post-checkout",
            "sub/\u{feff}.GIT/config",
            ".git\u{200d}/config",
            "GIT~1/config",
            "sub/git~1/config",
            ".git./config",
            ".git /config",
        ] {
            let bad = files(&[(path, "100644", "a")]);
            assert_eq!(unsafe_path(&bad).as_deref(), Some(path), "{path:?}");
        }
        // A symlinked .gitmodules, which git would follow when it reads it.
        for path in [".gitmodules", "sub/.GitModules", ".gitmodules\u{200c}"] {
            let bad = files(&[(path, "120000", "a")]);
            assert_eq!(unsafe_path(&bad).as_deref(), Some(path), "{path:?}");
        }
        // Names that only look alike are fine.
        let ok = files(&[
            (".gitmodules", "100644", "a"),
            (".github/workflows/ci.yml", "100644", "b"),
            ("git~2/x", "100644", "c"),
            ("my.git/x", "100644", "d"),
            (".gitignore", "120000", "e"),
        ]);
        assert_eq!(unsafe_path(&ok), None);
    }

    #[tokio::test]
    async fn a_tree_reaching_outside_is_not_applied() {
        let dir = worked_example().await;
        let p = dir.path();
        let here = snapshot(p, MAX_FILE).await.unwrap().tree;
        let blob = String::from_utf8(
            git(p, &["rev-parse", &format!("{here}:run.sh")])
                .await
                .unwrap(),
        )
        .unwrap();
        // `write_files` goes through git, which refuses such a path; build
        // the tree by hand as a hostile central host could.
        let inner = git_mktree(p, &format!("100644 blob {}\t..\n", blob.trim())).await;
        let e = apply(p, &here, &inner).await.unwrap_err();
        assert!(
            matches!(e, ApplyError::Unsafe(ref path) if path == ".."),
            "{e}"
        );
        assert_eq!(snapshot(p, MAX_FILE).await.unwrap().tree, here);
    }

    async fn git_mktree(repo: &Path, listing: &str) -> String {
        let out = git_env(repo, &[], &["mktree"], Some(listing.as_bytes()))
            .await
            .unwrap();
        String::from_utf8(out).unwrap().trim().to_string()
    }

    async fn exists(repo: &Path, oid: &str) -> bool {
        git(repo, &["cat-file", "-e", oid]).await.is_ok()
    }

    #[tokio::test]
    async fn a_copys_base_survives_gc_until_its_ref_goes() {
        let dir = worked_example().await;
        let p = dir.path();
        let base = snapshot(p, MAX_FILE).await.unwrap().tree;
        // src/new.ts is untracked: only the snapshot reaches its blob.
        let blob = String::from_utf8(
            git(p, &["rev-parse", &format!("{base}:src/new.ts")])
                .await
                .unwrap(),
        )
        .unwrap();
        let blob = blob.trim();
        let copy = "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37";
        set_base_ref(p, copy, &base).await.unwrap();
        // Nothing else may keep it: the file goes, and the next snapshot
        // no longer has it.
        std::fs::remove_file(p.join("src/new.ts")).unwrap();
        snapshot(p, MAX_FILE).await.unwrap();
        git(p, &["-c", "gc.reflogExpire=now", "gc", "-q", "--prune=now"])
            .await
            .unwrap();
        assert!(exists(p, blob).await);

        delete_base_ref(p, copy).await.unwrap();
        git(p, &["-c", "gc.reflogExpire=now", "gc", "-q", "--prune=now"])
            .await
            .unwrap();
        assert!(!exists(p, blob).await);

        assert!(set_base_ref(p, "../../HEAD", &base).await.is_err());
    }

    #[tokio::test]
    async fn a_pack_takes_any_number_of_ids_and_only_ids() {
        let dir = worked_example().await;
        let p = dir.path();
        let tree = snapshot(p, MAX_FILE).await.unwrap().tree;
        let head = String::from_utf8(git(p, &["rev-parse", "HEAD"]).await.unwrap()).unwrap();
        // 30 000 ids: past what a command line holds on macOS.
        let many: Vec<&str> = std::iter::repeat_n(head.trim(), 30_000).collect();
        let pack = pack_objects(p, &[&tree], &many).await.unwrap();
        assert!(!pack.is_empty());
        // An option where an id goes is refused, not passed to git.
        assert!(pack_objects(p, &[&tree], &["--all"]).await.is_err());
        assert!(pack_objects(p, &["--all"], &[head.trim()]).await.is_err());
    }

    #[tokio::test]
    async fn a_pack_carries_what_the_other_side_lacks() {
        let central = worked_example().await;
        let c = central.path();
        let copy = tempfile::tempdir().unwrap();
        let w = copy.path().join("shop");
        git(copy.path(), &["clone", "-q", c.to_str().unwrap(), "shop"])
            .await
            .unwrap();
        let theirs = snapshot(c, MAX_FILE).await.unwrap().tree;
        let mine = snapshot(&w, MAX_FILE).await.unwrap().tree;
        assert!(!exists(&w, &theirs).await);

        let pack = pack_objects(c, &[&theirs], &[&mine]).await.unwrap();
        unpack(&w, &pack).await.unwrap();
        apply(&w, &mine, &theirs).await.unwrap();
        assert_eq!(
            read(&w, "src/cart.ts").as_deref(),
            Some("export const cart = [1];\n")
        );
        assert_eq!(read(&w, "src/new.ts").as_deref(), Some("new\n"));
        assert_eq!(
            std::fs::read_link(w.join("link")).unwrap(),
            std::path::PathBuf::from("src/cart.ts")
        );

        // A commit, against the one both have.
        let old = String::from_utf8(git(c, &["rev-parse", "HEAD"]).await.unwrap()).unwrap();
        git(c, &["commit", "-qam", "cart"]).await.unwrap();
        let new = String::from_utf8(git(c, &["rev-parse", "HEAD"]).await.unwrap()).unwrap();
        let pack = pack_objects(c, &[new.trim()], &[old.trim()]).await.unwrap();
        unpack(&w, &pack).await.unwrap();
        assert!(exists(&w, new.trim()).await);

        // Nothing new: nothing to send.
        assert!(
            pack_objects(c, &[new.trim()], &[new.trim()])
                .await
                .unwrap()
                .is_empty()
        );
        unpack(&w, &[]).await.unwrap();
    }

    #[tokio::test]
    async fn a_pack_with_a_tree_git_would_refuse_is_not_stored() {
        let central = worked_example().await;
        let c = central.path();
        let copy = tempfile::tempdir().unwrap();
        let w = copy.path().join("shop");
        git(copy.path(), &["clone", "-q", c.to_str().unwrap(), "shop"])
            .await
            .unwrap();
        let blob = String::from_utf8(git(c, &["rev-parse", "HEAD:run.sh"]).await.unwrap()).unwrap();
        // A hostile central host's tree, with a `.git` entry that a checkout
        // would write into the copy's repository.
        let hooks = git_mktree(c, &format!("100755 blob {}\tpost-checkout\n", blob.trim())).await;
        let dotgit = git_mktree(c, &format!("040000 tree {hooks}\thooks\n")).await;
        let evil = git_mktree(c, &format!("040000 tree {dotgit}\t.git\n")).await;
        let pack = pack_objects(c, &[&evil], &[]).await.unwrap();

        let e = unpack(&w, &pack).await.unwrap_err();
        assert!(matches!(e, UnpackError::Unsafe(_)), "{e}");
        assert!(!exists(&w, &evil).await);

        let dotdot = git_mktree(c, &format!("100644 blob {}\t..\n", blob.trim())).await;
        let pack = pack_objects(c, &[&dotdot], &[]).await.unwrap();
        let e = unpack(&w, &pack).await.unwrap_err();
        assert!(matches!(e, UnpackError::Unsafe(_)), "{e}");
        assert!(!exists(&w, &dotdot).await);
    }

    #[test]
    fn a_url_loses_its_password_or_token_but_keeps_its_scheme_and_user() {
        for (url, want) in [
            (
                "git@github.com:acme/shop.git",
                "git@github.com:acme/shop.git",
            ),
            (
                "https://alex:ghp_x@github.com/acme/shop.git",
                "https://github.com/acme/shop.git",
            ),
            (
                "ssh://git@github.com/acme/shop.git",
                "ssh://git@github.com/acme/shop.git",
            ),
            (
                "https://ghp_x@github.com/acme/shop.git",
                "https://github.com/acme/shop.git",
            ),
            (
                "ssh://git:secret@github.com:22/acme/shop.git",
                "ssh://git@github.com:22/acme/shop.git",
            ),
            (
                "https://github.com/acme/shop.git",
                "https://github.com/acme/shop.git",
            ),
        ] {
            assert_eq!(scrub_url(url), want, "{url}");
        }
    }

    #[test]
    fn only_https_and_ssh_origins_are_cloned() {
        for url in [
            "https://github.com/acme/shop.git",
            "ssh://git@github.com/acme/shop.git",
            "git@github.com:acme/shop.git",
            "github.com:acme/shop.git",
        ] {
            assert!(clonable_url(url), "{url}");
        }
        for url in [
            "file:///Users/alex/src/secret",
            "/Users/alex/src/secret",
            "./secret",
            "git://github.com/acme/shop.git",
            "http://github.com/acme/shop.git",
            "ext::sh -c touch% /tmp/pwned",
            "-uhelp",
            "C:/repo",
        ] {
            assert!(!clonable_url(url), "{url}");
        }
    }

    #[tokio::test]
    async fn a_clone_never_removes_a_folder_it_did_not_make() {
        let dir = tempfile::tempdir().unwrap();
        let there = dir.path().join("acme");
        std::fs::create_dir_all(there.join("shop/repo")).unwrap();
        std::fs::write(there.join("notes.txt"), "mine\n").unwrap();
        let e = clone("https://git.invalid/acme.git", &there)
            .await
            .unwrap_err();
        assert_eq!(e, format!("{} is in the way", there.display()));
        assert_eq!(read(&there, "notes.txt").as_deref(), Some("mine\n"));
        assert!(there.join("shop/repo").is_dir());

        // A folder it makes for a clone that fails goes again.
        let new = dir.path().join("fresh/repo");
        assert!(clone("https://git.invalid/acme.git", &new).await.is_err());
        assert!(!new.exists());
    }

    #[test]
    fn a_failed_clone_says_why_in_one_line() {
        // Captured from git 2.54 against github.com and a local path.
        let github = "remote: Repository not found.\nfatal: repository 'https://github.com/1devstudio/no-such-repo-x60-check.git/' not found";
        assert_eq!(clone_error(github), "Repository not found.");
        let local = "fatal: '/tmp/missing.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.";
        assert_eq!(
            clone_error(local),
            "'/tmp/missing.git' does not appear to be a git repository"
        );
    }

    #[tokio::test]
    async fn a_branch_checked_out_anywhere_is_found_the_main_checkout_too() {
        let dir = worked_example().await;
        let p = dir.path();
        assert_eq!(
            checked_out(p, "main")
                .await
                .map(|d| std::fs::canonicalize(d).unwrap()),
            Some(std::fs::canonicalize(p).unwrap())
        );
        let head = head(p).await.unwrap();
        let other = tempfile::tempdir().unwrap();
        let w = other.path().join("fix-cart");
        add_worktree(p, &w, "fix-cart", &head).await.unwrap();
        assert_eq!(
            checked_out(p, "fix-cart")
                .await
                .map(|d| std::fs::canonicalize(d).unwrap()),
            Some(std::fs::canonicalize(&w).unwrap())
        );
        assert_eq!(checked_out(p, "nowhere").await, None);
    }

    #[tokio::test]
    async fn a_worktree_needs_a_branch_name_git_accepts_and_a_full_commit_id() {
        let dir = worked_example().await;
        let p = dir.path();
        let head = head(p).await.unwrap();
        let other = tempfile::tempdir().unwrap();
        for (branch, commit) in [
            ("-f", head.as_str()),
            ("fix..cart", head.as_str()),
            ("fix-cart", "HEAD"),
            ("fix-cart", &head[..12]),
            ("fix-cart", "--orphan"),
        ] {
            let e = add_worktree(p, &other.path().join("w"), branch, commit)
                .await
                .unwrap_err();
            assert!(
                matches!(e, WorktreeError::Invalid(_)),
                "{branch} {commit}: {e:?}"
            );
        }
        assert!(!other.path().join("w").exists());
        assert!(
            git(p, &["rev-parse", "--verify", "-q", "refs/heads/fix-cart"])
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_branch_already_here_moves_only_forward() {
        let dir = worked_example().await;
        let p = dir.path();
        let base = head(p).await.unwrap();
        git(p, &["commit", "-q", "--allow-empty", "-m", "theirs"])
            .await
            .unwrap();
        let theirs = head(p).await.unwrap();
        git(p, &["reset", "-q", "--soft", &base]).await.unwrap();
        let other = tempfile::tempdir().unwrap();

        // Behind: it moves up to their commit.
        git(p, &["branch", "behind", &base]).await.unwrap();
        add_worktree(p, &other.path().join("behind"), "behind", &theirs)
            .await
            .unwrap();
        assert_eq!(rev(p, "behind").await, theirs);

        // Its own commits: left alone.
        git(p, &["branch", "mine", &base]).await.unwrap();
        git(p, &["checkout", "-q", "mine"]).await.unwrap();
        git(p, &["commit", "-q", "--allow-empty", "-m", "mine"])
            .await
            .unwrap();
        let mine = head(p).await.unwrap();
        git(p, &["checkout", "-q", "main"]).await.unwrap();
        let e = add_worktree(p, &other.path().join("mine"), "mine", &theirs)
            .await
            .unwrap_err();
        assert!(matches!(e, WorktreeError::Ahead), "{e:?}");
        assert_eq!(rev(p, "mine").await, mine);
        assert!(!other.path().join("mine").exists());
    }

    #[tokio::test]
    async fn files_only_this_machine_has_are_the_secrets_and_those_that_stopped_syncing() {
        let dir = worked_example().await;
        let p = dir.path();
        snapshot(p, MAX_FILE).await.unwrap();
        // Stops syncing: ignored after it synced, then edited.
        std::fs::write(p.join(".git/info/exclude"), "scratch.txt\nsrc/new.ts\n").unwrap();
        std::fs::write(p.join("src/new.ts"), "edited here\n").unwrap();
        std::fs::write(p.join("key.pem"), "-----BEGIN-----\n").unwrap();
        let snap = snapshot(p, MAX_FILE).await.unwrap();
        assert_eq!(snap.too_big, Vec::<String>::new());
        assert_eq!(
            local_only(p).await.unwrap(),
            [".env", "key.pem", "src/new.ts"]
        );
    }

    #[tokio::test]
    async fn a_removed_worktree_leaves_its_branch_and_a_pruned_one_frees_it() {
        let dir = worked_example().await;
        let p = dir.path();
        git(p, &["commit", "-q", "-a", "-m", "more"]).await.unwrap();
        let commit = head(p).await.unwrap();
        let other = tempfile::tempdir().unwrap();
        let w = other.path().join("w");
        add_worktree(p, &w, "feature", &commit).await.unwrap();
        std::fs::write(w.join("untracked.txt"), "gone with it\n").unwrap();
        remove_worktree(p, &w).await.unwrap();
        assert!(!w.exists());
        assert_eq!(rev(p, "feature").await, commit);

        // A worktree whose folder was deleted holds its branch until pruned.
        let gone = other.path().join("gone");
        add_worktree(p, &gone, "other", &commit).await.unwrap();
        std::fs::remove_dir_all(&gone).unwrap();
        assert!(checked_out(p, "other").await.is_some());
        prune_worktrees(p).await.unwrap();
        assert_eq!(checked_out(p, "other").await, None);
    }

    #[test]
    fn a_branch_name_is_read_from_symbolic_ref() {
        // Captured from git 2.54: `git symbolic-ref -q --short HEAD` on a
        // branch, and with a detached HEAD (exit 1, nothing printed).
        assert_eq!(
            parse_branch(0, b"moonlet/fix-cart\n").as_deref(),
            Some("moonlet/fix-cart")
        );
        assert_eq!(parse_branch(1, b""), None);
    }

    #[test]
    fn a_head_moves_up_stays_ahead_or_diverges() {
        let (own, central) = ("a".repeat(40), "b".repeat(40));
        assert_eq!(head_move(&own, &own, true, true), HeadMove::Same);
        // Own commit is in the central host's history: move up.
        assert_eq!(head_move(&own, &central, true, false), HeadMove::Up);
        // The central host's commit is in this side's history: ahead.
        assert_eq!(head_move(&own, &central, false, true), HeadMove::Ahead);
        assert_eq!(head_move(&own, &central, false, false), HeadMove::Diverged);
    }

    /// `worked_example` with two commits on `main`: the first and the last.
    async fn two_commits() -> (tempfile::TempDir, String, String) {
        let dir = worked_example().await;
        let p = dir.path();
        let first = head(p).await.unwrap();
        git(p, &["commit", "-q", "--allow-empty", "-m", "second"])
            .await
            .unwrap();
        let second = head(p).await.unwrap();
        (dir, first, second)
    }

    #[tokio::test]
    async fn a_branch_moves_only_from_the_commit_it_was_read_at() {
        let (dir, first, second) = two_commits().await;
        let p = dir.path();
        git(p, &["commit", "-q", "--allow-empty", "-m", "third"])
            .await
            .unwrap();
        let third = head(p).await.unwrap();
        // Read at `second`, but a commit came in since: nothing moves.
        assert!(fast_forward(p, "main", &second, &first).await.is_err());
        assert!(reset_branch(p, &second, &first).await.is_err());
        assert_eq!(rev(p, "main").await, third);
        // From where it is, it moves.
        reset_branch(p, &third, &first).await.unwrap();
        assert_eq!(rev(p, "main").await, first);
    }

    #[tokio::test]
    async fn a_branch_moved_from_elsewhere_leaves_the_checkouts_staging_alone() {
        let (dir, first, second) = two_commits().await;
        let p = dir.path();
        git(p, &["branch", "behind", &first]).await.unwrap();
        // `main` is checked out, with something staged.
        std::fs::write(p.join("staged.txt"), "staged\n").unwrap();
        git(p, &["add", "staged.txt"]).await.unwrap();
        fast_forward(p, "behind", &first, &second).await.unwrap();
        assert_eq!(rev(p, "behind").await, second);
        let status = git(p, &["status", "--porcelain", "staged.txt"])
            .await
            .unwrap();
        assert_eq!(String::from_utf8(status).unwrap(), "A  staged.txt\n");
    }

    #[tokio::test]
    async fn branches_are_made_once_counted_and_found() {
        let (dir, first, second) = two_commits().await;
        let p = dir.path();
        assert!(!branch_exists(p, "mine").await);
        create_branch(p, "mine", &first).await.unwrap();
        assert!(branch_exists(p, "mine").await);
        assert!(create_branch(p, "mine", &second).await.is_err());
        assert_eq!(rev(p, "mine").await, first);
        assert_eq!(count(p, &first, &second).await.unwrap(), 1);
        assert_eq!(count(p, &second, &first).await.unwrap(), 0);
        assert_eq!(branch(p).await.unwrap().as_deref(), Some("main"));
    }

    async fn rev(p: &Path, name: &str) -> String {
        String::from_utf8(git(p, &["rev-parse", name]).await.unwrap())
            .unwrap()
            .trim()
            .to_string()
    }

    #[tokio::test]
    async fn only_the_objects_a_repository_has_are_present() {
        let dir = worked_example().await;
        let p = dir.path();
        let head = String::from_utf8(git(p, &["rev-parse", "HEAD"]).await.unwrap()).unwrap();
        let head = head.trim().to_string();
        let missing = "0123456789abcdef0123456789abcdef01234567".to_string();
        assert_eq!(
            present(p, &[missing.clone(), head.clone(), "not-an-id".into()])
                .await
                .unwrap(),
            vec![head]
        );
        assert!(present(p, &[missing]).await.unwrap().is_empty());
        assert!(present(p, &[]).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_submodule_is_its_commit_not_its_files() {
        let dir = worked_example().await;
        let p = dir.path();
        let sub = p.join("lib");
        std::fs::create_dir_all(&sub).unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "Test"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            git(&sub, &args).await.unwrap();
        }
        std::fs::write(sub.join("inner.txt"), "inner\n").unwrap();
        git(&sub, &["add", "-A"]).await.unwrap();
        git(&sub, &["commit", "-q", "-m", "inner"]).await.unwrap();
        let head = String::from_utf8(git(&sub, &["rev-parse", "HEAD"]).await.unwrap()).unwrap();

        let snap = snapshot(p, MAX_FILE).await.unwrap();
        let files = read_files(p, &snap.tree).await.unwrap();
        assert_eq!(
            files["lib"],
            Entry {
                mode: "160000".into(),
                oid: head.trim().into()
            }
        );
        assert!(!files.contains_key("lib/inner.txt"));
    }

    #[test]
    fn an_ls_tree_listing_reads_as_files() {
        // `git ls-tree -r -z --full-tree HEAD`, git 2.54, a repository with
        // a submodule, a symlink, a script and a file.
        let out = b"160000 commit 1231a766a2008e2b34e1ab18d115b8dc30f0e8bb\tlib\x00120000 blob 637ced4b407bfd4258c4839c49d91d64d4cb06e3\tlink\x00100755 blob 1a2485251c33a70432394c93fb89330ef214bfc9\trun.sh\x00100644 blob 587be6b4c3f93f93c489c0111bba5596147a26cb\tsrc/cart.ts\x00";
        assert_eq!(
            parse_ls_tree(out).unwrap(),
            files(&[
                ("lib", "160000", "1231a766a2008e2b34e1ab18d115b8dc30f0e8bb"),
                ("link", "120000", "637ced4b407bfd4258c4839c49d91d64d4cb06e3"),
                (
                    "run.sh",
                    "100755",
                    "1a2485251c33a70432394c93fb89330ef214bfc9"
                ),
                (
                    "src/cart.ts",
                    "100644",
                    "587be6b4c3f93f93c489c0111bba5596147a26cb"
                ),
            ])
        );
        assert!(parse_ls_tree(b"100644 blob\x00").is_err());
    }

    #[test]
    fn a_tree_naming_a_file_in_bytes_that_are_not_text_is_refused() {
        // A Linux machine allows such names; carrying them as text would
        // rename the file, or fold two names into one.
        let out = b"100644 blob 587be6b4c3f93f93c489c0111bba5596147a26cb\tbad\xff\x00";
        assert!(parse_ls_tree(out).is_err());
    }

    #[test]
    fn a_refused_read_tree_says_whether_the_worktree_changed() {
        // Stderr of `git read-tree -m -u` refusing, git 2.54.
        for changed in [
            "error: Entry 'src/cart.ts' not uptodate. Cannot merge.",
            "error: Untracked working tree file 'src/new.ts' would be overwritten by merge.",
        ] {
            assert!(worktree_changed(changed), "{changed}");
        }
        assert!(!worktree_changed(
            "fatal: failed to unpack tree object deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        ));
    }

    async fn packs(repo: &Path) -> usize {
        let out = String::from_utf8(git(repo, &["count-objects", "-v"]).await.unwrap()).unwrap();
        out.lines()
            .find_map(|l| l.strip_prefix("packs: "))
            .unwrap()
            .parse()
            .unwrap()
    }

    #[tokio::test]
    async fn packs_from_many_syncs_get_repacked() {
        let central = worked_example().await;
        let c = central.path();
        let copy = tempfile::tempdir().unwrap();
        let w = copy.path().join("shop");
        git(copy.path(), &["clone", "-q", c.to_str().unwrap(), "shop"])
            .await
            .unwrap();
        let mut have = snapshot(&w, MAX_FILE).await.unwrap().tree;
        for i in 0..60 {
            std::fs::write(c.join("src/cart.ts"), format!("edit {i}\n")).unwrap();
            let next = snapshot(c, MAX_FILE).await.unwrap().tree;
            unpack(&w, &pack_objects(c, &[&next], &[&have]).await.unwrap())
                .await
                .unwrap();
            have = next;
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while packs(&w).await >= 50 {
            assert!(
                std::time::Instant::now() < deadline,
                "{} packs",
                packs(&w).await
            );
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }
}
