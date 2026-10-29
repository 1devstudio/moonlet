//! Files copied between members although git ignores them (X74): a
//! project's list of patterns, `.env` and `.env.*` by default, and which of
//! a worktree's files it names. They travel outside git, so they never
//! enter an object store.

use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result, bail};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, DirBuilder, DirBuilderExt, MetadataExt, OpenOptions, OpenOptionsExt};
use ignore::gitignore::GitignoreBuilder;

/// A project's patterns when it has none of its own.
pub const DEFAULT: [&str; 2] = [".env", ".env.*"];
/// A file over this many bytes stays on its member.
pub const MAX_FILE: u64 = 1024 * 1024;
/// At most this many files go per worktree…
pub const MAX_FILES: usize = 200;
/// …and this many bytes in all.
pub const MAX_TOTAL: u64 = 16 * 1024 * 1024;

/// Refuses a pattern that is not one `.gitignore` line naming files inside
/// the worktree: a `!` line, `..`, a line break, or nothing.
pub fn check_pattern(p: &str) -> Result<()> {
    let t = p.trim();
    if t.is_empty() {
        bail!("an empty pattern");
    }
    if t.starts_with('!') {
        bail!("{t}: a pattern cannot take files back (!)");
    }
    if t.contains('\n') || t.contains('\r') {
        bail!("{t}: one line per pattern");
    }
    if t.split('/').any(|part| part == "..") {
        bail!("{t}: a pattern stays inside the worktree (..)");
    }
    if t.starts_with("//") || t.starts_with('~') {
        bail!("{t}: a pattern is relative to the worktree");
    }
    Ok(())
}

/// What the list names in a worktree.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Matched {
    /// Paths to copy, with their sizes, in path order.
    pub files: Vec<(String, u64)>,
    /// Paths left out, with why, in path order.
    pub skipped: Vec<(String, String)>,
}

/// Which of `candidates` (paths relative to the worktree, files git does
/// not track) the `patterns` name, and which of those go: in path order, no
/// link, nothing under `.git/`, none over [`MAX_FILE`], and up to
/// [`MAX_FILES`] files and [`MAX_TOTAL`] bytes. `size_of` gives a path's
/// size, or `None` for a link or anything that is not a plain file.
pub fn select(
    patterns: &[String],
    candidates: &[String],
    size_of: impl Fn(&str) -> Option<u64>,
) -> Result<Matched> {
    let mut builder = GitignoreBuilder::new("/");
    for p in patterns {
        check_pattern(p)?;
        builder.add_line(None, p.trim())?;
    }
    let matcher = builder.build()?;
    let mut named: Vec<&String> = candidates
        .iter()
        .filter(|c| !c.starts_with(".git/") && *c != ".git")
        .filter(|c| {
            matcher
                .matched_path_or_any_parents(Path::new("/").join(c), false)
                .is_ignore()
        })
        .collect();
    named.sort();
    named.dedup();
    let mut out = Matched::default();
    let mut total = 0u64;
    let mut full = false;
    for path in named {
        let Some(size) = size_of(path) else {
            out.skipped
                .push((path.clone(), "is not a plain file".into()));
            continue;
        };
        if size > MAX_FILE {
            out.skipped.push((path.clone(), "is over 1 MiB".into()));
            continue;
        }
        if full || out.files.len() >= MAX_FILES || total + size > MAX_TOTAL {
            full = true;
            out.skipped.push((
                path.clone(),
                "is past the 200 files or 16 MiB copied per worktree".into(),
            ));
            continue;
        }
        total += size;
        out.files.push((path.clone(), size));
    }
    Ok(out)
}

/// Folders never looked into for copied files: build output each member
/// makes with its setup command, and git's own.
const NEVER_WALKED: [&str; 3] = ["node_modules", "target", ".git"];
/// At most this many entries are looked at inside ignored folders, nearest
/// the root first, so a big ignored folder cannot slow every scan down.
const MAX_WALKED: usize = 20_000;

/// The files of worktree `dir` that git does not track: untracked ones, and
/// ignored ones, also inside an ignored folder. Folders named in
/// [`NEVER_WALKED`] are never looked into, and links are never followed.
pub async fn untracked(dir: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut ignored_dirs = std::collections::VecDeque::new();
    for args in [
        &["ls-files", "--others", "--exclude-standard", "-z"][..],
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ][..],
    ] {
        let walk_folders = args.contains(&"--ignored");
        let bytes = crate::git::git(dir, args).await?;
        for p in bytes.split(|b| *b == 0).filter(|p| !p.is_empty()) {
            let Ok(p) = std::str::from_utf8(p) else {
                continue;
            };
            match p.strip_suffix('/') {
                Some(folder) if walk_folders => ignored_dirs.push_back(folder.to_string()),
                Some(_) => {}
                None => out.push(p.to_string()),
            }
        }
    }
    // Breadth first, so a file near the root is found before the walk
    // limit, whatever lies deep in another ignored folder.
    let mut walked = 0;
    while let Some(folder) = ignored_dirs.pop_front() {
        let name = folder.rsplit('/').next().unwrap_or(&folder);
        if NEVER_WALKED.contains(&name) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(dir.join(&folder)) else {
            continue;
        };
        let mut entries: Vec<_> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| Some((e.file_name().into_string().ok()?, e.file_type().ok()?)))
            .collect();
        // Another repository or worktree inside an ignored folder is not
        // this worktree's.
        if entries.iter().any(|(n, _)| n == ".git") {
            continue;
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, kind) in entries {
            if walked >= MAX_WALKED {
                return Ok(out);
            }
            walked += 1;
            let path = format!("{folder}/{name}");
            if kind.is_dir() {
                ignored_dirs.push_back(path);
            } else {
                out.push(path);
            }
        }
    }
    Ok(out)
}

/// Which of `paths` git tracks in worktree `dir`: those are git's to
/// carry, never written or removed as copied files.
pub async fn tracked(dir: &Path, paths: &[String]) -> Result<std::collections::BTreeSet<String>> {
    if paths.is_empty() {
        return Ok(Default::default());
    }
    let specs: Vec<String> = paths.iter().map(|p| format!(":(literal){p}")).collect();
    let mut args = vec!["ls-files", "--cached", "-z", "--"];
    args.extend(specs.iter().map(String::as_str));
    let bytes = crate::git::git(dir, &args).await?;
    Ok(bytes
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .filter_map(|p| std::str::from_utf8(p).ok().map(str::to_string))
        .collect())
}

/// Of the files another member sent, by path with the size of the bytes
/// that came along (0 when none did), those this side takes: plain paths
/// inside the worktree, named by its own list, within its limits, and not
/// tracked by its git. A path the list does not name is refused; one over
/// the limits or tracked here is left out.
pub async fn receivable(
    dir: &Path,
    patterns: &[String],
    sent: &[(String, u64)],
) -> Result<std::collections::BTreeSet<String>> {
    for (path, _) in sent {
        check_path(path)?;
    }
    let paths: Vec<String> = sent.iter().map(|(p, _)| p.clone()).collect();
    let picked = select(patterns, &paths, |p| {
        sent.iter().find(|(q, _)| q == p).map(|(_, n)| *n)
    })?;
    let named: std::collections::BTreeSet<&str> = picked
        .files
        .iter()
        .map(|(p, _)| p.as_str())
        .chain(picked.skipped.iter().map(|(p, _)| p.as_str()))
        .collect();
    if let Some(p) = paths.iter().find(|p| !named.contains(p.as_str())) {
        bail!("{p} is not a copied file here");
    }
    let tracked = tracked(dir, &paths).await?;
    Ok(picked
        .files
        .into_iter()
        .map(|(p, _)| p)
        .filter(|p| !tracked.contains(p))
        .collect())
}

/// What the list names in worktree `dir`, sized from the disk.
pub async fn in_worktree(dir: &Path, patterns: &[String]) -> Result<Matched> {
    let candidates = untracked(dir).await?;
    select(patterns, &candidates, |p| {
        std::fs::symlink_metadata(dir.join(p))
            .ok()
            .filter(|m| m.file_type().is_file())
            .map(|m| m.len())
    })
}

/// Refuses a path another member sent that is not a plain path inside the
/// worktree: absolute, with `..`, empty, or under `.git/`.
pub fn check_path(rel: &str) -> Result<()> {
    let path = Path::new(rel);
    if rel.is_empty() || !path.components().all(|c| matches!(c, Component::Normal(_))) {
        bail!("{rel:?} is not a path inside the worktree");
    }
    if path.components().next() == Some(Component::Normal(".git".as_ref())) {
        bail!("{rel:?} is git's own");
    }
    Ok(())
}

/// The folder `rel` inside `root`, reached through folders of its own,
/// never a link; with `create`, missing ones are made, mode 0700. `None`
/// when one is missing and not made.
fn folder(root: &Path, rel: &Path, create: bool) -> Result<Option<Dir>> {
    let mut dir = Dir::open_ambient_dir(root, ambient_authority())
        .with_context(|| format!("cannot open {}", root.display()))?;
    for part in rel.components() {
        let Component::Normal(name) = part else {
            bail!("{} is not a path inside its folder", rel.display());
        };
        if create {
            match dir.create_dir_with(name, DirBuilder::new().mode(0o700)) {
                Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e.into()),
                _ => {}
            }
        }
        let look = match dir.symlink_metadata(name) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if !look.is_dir() {
            bail!(
                "{} is not a folder (a link is refused)",
                name.to_string_lossy()
            );
        }
        let opened = dir.open_dir(name)?;
        let now = opened.dir_metadata()?;
        if (look.dev(), look.ino()) != (now.dev(), now.ino()) {
            bail!("{} changed while it was opened", name.to_string_lossy());
        }
        dir = opened;
    }
    Ok(Some(dir))
}

/// The bytes of file `rel` inside `root`; `None` when it is missing. A
/// link, at the file or on its way, is refused, never followed.
pub fn read(root: &Path, rel: &str) -> Result<Option<Vec<u8>>> {
    use std::io::Read;
    check_path(rel)?;
    let path = Path::new(rel);
    let name = path.file_name().context("a file needs a name")?;
    let Some(dir) = folder(root, path.parent().unwrap_or(Path::new("")), false)? else {
        return Ok(None);
    };
    let look = match dir.symlink_metadata(name) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !look.is_file() {
        bail!("{rel} is not a file (a link is refused)");
    }
    let mut file = dir.open_with(
        name,
        OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW),
    )?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

static NEXT: AtomicU64 = AtomicU64::new(0);

/// Writes file `rel` inside `root`, mode 0600, through a temporary file in
/// its folder renamed over it, so a reader sees the old content or the new,
/// never half. Missing folders are made, mode 0700; a link on the way is
/// refused, and one at `rel` is replaced, never followed.
pub fn write(root: &Path, rel: &str, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    check_path(rel)?;
    let path = Path::new(rel);
    let name = path.file_name().context("a file needs a name")?;
    let dir = folder(root, path.parent().unwrap_or(Path::new("")), true)?
        .context("a folder went away")?;
    let tmp = format!(
        ".{}.moonlet-{}-{}",
        name.to_string_lossy(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let mut f = dir.open_with(
        &tmp,
        OpenOptions::new().write(true).create_new(true).mode(0o600),
    )?;
    let done = f
        .write_all(bytes)
        .and_then(|()| f.sync_all())
        .and_then(|()| dir.rename(&tmp, &dir, name));
    if done.is_err() {
        let _ = dir.remove_file(&tmp);
    }
    Ok(done?)
}

/// Removes file `rel` inside `root`; a missing one is fine, and a link on
/// the way is refused.
pub fn remove(root: &Path, rel: &str) -> Result<()> {
    check_path(rel)?;
    let path = Path::new(rel);
    let name = path.file_name().context("a file needs a name")?;
    let Some(dir) = folder(root, path.parent().unwrap_or(Path::new("")), false)? else {
        return Ok(());
    };
    match dir.remove_file(name) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// Whether anything is at `rel` inside `root`: a file, a link or a folder,
/// looked at without reading it or following a link at it. A link on the
/// way is refused.
fn present(root: &Path, rel: &str) -> Result<bool> {
    check_path(rel)?;
    let path = Path::new(rel);
    let name = path.file_name().context("a file needs a name")?;
    let Some(dir) = folder(root, path.parent().unwrap_or(Path::new("")), false)? else {
        return Ok(false);
    };
    match dir.symlink_metadata(name) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Copies the files the list names in checkout `from` into new worktree
/// `to`, leaving anything `to` already has at their paths, a link
/// included; the paths copied.
pub async fn seed(from: &Path, to: &Path, patterns: &[String]) -> Result<Vec<String>> {
    let mut copied = Vec::new();
    for (rel, _) in in_worktree(from, patterns).await?.files {
        if present(to, &rel)? {
            continue;
        }
        let Some(bytes) = read(from, &rel)? else {
            continue;
        };
        write(to, &rel, &bytes)?;
        copied.push(rel);
    }
    Ok(copied)
}

/// The SHA-256 of `bytes`, in hex: how two members compare a file.
pub fn sha(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A copied file as one member has it: its hash, and its bytes when they
/// go along.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub sha: String,
    pub bytes: Option<Vec<u8>>,
}

/// Every copied file of worktree `dir`, in path order, each with its hash,
/// and its bytes when `include` says so for its path and hash, until
/// `budget` bytes went along; the rest go another time.
pub async fn manifest(
    dir: &Path,
    patterns: &[String],
    include: impl Fn(&str, &str) -> bool,
    mut budget: u64,
) -> Result<Vec<Entry>> {
    let mut out = Vec::new();
    for (path, _) in in_worktree(dir, patterns).await?.files {
        let Some(bytes) = read(dir, &path)? else {
            continue;
        };
        let sha = sha(&bytes);
        let fits = (bytes.len() as u64) <= budget;
        let bytes = (include(&path, &sha) && fits).then(|| {
            budget -= bytes.len() as u64;
            bytes
        });
        out.push(Entry { path, sha, bytes });
    }
    Ok(out)
}

/// What [`apply`] did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Applied {
    /// Paths written or removed.
    pub changed: Vec<String>,
    /// Paths that differ whose bytes did not come along.
    pub want: Vec<String>,
}

/// Makes worktree `dir`'s copied files those of `manifest`, the session
/// owner's: each one that differs is written, and each one `manifest` lacks
/// that this side had from the owner before (`had`) is removed. A version of this side's that is replaced or removed goes to
/// `keep` first, so none is lost. A path that is not a plain path inside
/// the worktree, or that this side's own list does not name, is refused.
pub async fn apply(
    dir: &Path,
    patterns: &[String],
    manifest: &[Entry],
    had: &std::collections::BTreeSet<String>,
    mut keep: impl FnMut(&str, &[u8]) -> Result<()>,
) -> Result<Applied> {
    let sent: Vec<(String, u64)> = manifest
        .iter()
        .map(|e| {
            (
                e.path.clone(),
                e.bytes.as_ref().map_or(0, |b| b.len() as u64),
            )
        })
        .collect();
    let takes = receivable(dir, patterns, &sent).await?;
    let mut here = std::collections::BTreeMap::new();
    for (path, _) in in_worktree(dir, patterns).await?.files {
        if let Some(bytes) = read(dir, &path)? {
            here.insert(path, bytes);
        }
    }
    // What stays as it is counts toward the total first.
    let mut total: u64 = manifest
        .iter()
        .filter_map(|e| here.get(&e.path).filter(|b| sha(b) == e.sha))
        .map(|b| b.len() as u64)
        .sum();
    let mut done = Applied::default();
    for e in manifest {
        let old = here.remove(&e.path);
        if !takes.contains(&e.path) || old.as_deref().map(sha).as_deref() == Some(e.sha.as_str()) {
            continue;
        }
        match &e.bytes {
            Some(bytes) if sha(bytes) == e.sha => {
                if total + bytes.len() as u64 > MAX_TOTAL {
                    continue;
                }
                total += bytes.len() as u64;
                if let Some(old) = &old {
                    keep(&e.path, old)?;
                }
                write(dir, &e.path, bytes)?;
                done.changed.push(e.path.clone());
            }
            _ => done.want.push(e.path.clone()),
        }
    }
    // Only what the owner had and deleted goes: a file this side made
    // that the owner never had stays, such as a secret of its own.
    for (path, old) in here.into_iter().filter(|(p, _)| had.contains(p)) {
        keep(&path, &old)?;
        remove(dir, &path)?;
        done.changed.push(path);
    }
    Ok(done)
}

/// A checkout's copied file as one member last saw it change (X74): its
/// SHA-256, or none once deleted, and when and by which member the change
/// was noticed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Version {
    pub sha: Option<String>,
    /// Milliseconds since the epoch, on the member that noticed it.
    pub stamp: u64,
    /// That member's worker id.
    pub by: String,
}

impl Version {
    /// Whether this change came after `other`: the later stamp, and on the
    /// same stamp, the greater member id, so every member picks the same.
    pub fn after(&self, other: &Version) -> bool {
        (self.stamp, &self.by) > (other.stamp, &other.by)
    }
}

/// Records in `table` what changed in a checkout whose copied files are now
/// `now` (path to SHA-256 and the file's change time, in milliseconds): a
/// new or changed file at its change time, and a deleted one at `stamp`,
/// all by member `by`. Gives the paths that changed.
pub fn notice(
    table: &mut std::collections::BTreeMap<String, Version>,
    now: &std::collections::BTreeMap<String, (String, u64)>,
    stamp: u64,
    by: &str,
) -> Vec<String> {
    let mut changed = Vec::new();
    for (path, (sha, at)) in now {
        if table.get(path).and_then(|v| v.sha.as_ref()) != Some(sha) {
            table.insert(
                path.clone(),
                Version {
                    sha: Some(sha.clone()),
                    stamp: *at,
                    by: by.to_string(),
                },
            );
            changed.push(path.clone());
        }
    }
    for (path, v) in table.iter_mut() {
        if v.sha.is_some() && !now.contains_key(path) {
            *v = Version {
                sha: None,
                stamp,
                by: by.to_string(),
            };
            changed.push(path.clone());
        }
    }
    changed.sort();
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pats(p: &[&str]) -> Vec<String> {
        p.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_default_list_names_env_files_anywhere() {
        let candidates = pats(&[
            ".env",
            "apps/web/.env",
            ".env.production",
            ".envrc",
            "notes.md",
            "config/.env.local",
        ]);
        let m = select(&pats(&DEFAULT), &candidates, |_| Some(10)).unwrap();
        assert_eq!(
            m.files.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(),
            [
                ".env",
                ".env.production",
                "apps/web/.env",
                "config/.env.local"
            ]
        );
    }

    #[test]
    fn a_pattern_matches_as_one_gitignore_line() {
        let candidates = pats(&[
            ".env",
            "apps/web/.env",
            "config/dev.yaml",
            "config/x/dev.yaml",
        ]);
        let m = select(&pats(&["/.env", "config/*.yaml"]), &candidates, |_| {
            Some(10)
        })
        .unwrap();
        assert_eq!(
            m.files.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(),
            [".env", "config/dev.yaml"]
        );
    }

    #[test]
    fn a_negation_an_absolute_path_or_dotdot_is_refused() {
        for bad in ["!x", "../x", "a/../b", "x\ny", "", "~/x"] {
            assert!(check_pattern(bad).is_err(), "{bad:?}");
        }
        assert!(check_pattern("/.env").is_ok());
    }

    #[tokio::test]
    async fn a_tracked_file_is_left_to_git() {
        let dir = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q"]);
        std::fs::write(dir.path().join(".gitignore"), ".env.local\nnode_modules/\n").unwrap();
        std::fs::write(dir.path().join(".env"), "TRACKED=1\n").unwrap();
        run(&["add", ".env", ".gitignore"]);
        std::fs::write(dir.path().join(".env.local"), "IGNORED=1\n").unwrap();
        std::fs::write(dir.path().join(".env.test"), "UNTRACKED=1\n").unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/x")).unwrap();
        std::fs::write(dir.path().join("node_modules/x/.env"), "DEP=1\n").unwrap();
        let m = in_worktree(dir.path(), &pats(&DEFAULT)).await.unwrap();
        assert_eq!(
            m.files,
            vec![
                (".env.local".to_string(), 10),
                (".env.test".to_string(), 12)
            ]
        );
    }

    #[tokio::test]
    async fn a_file_inside_an_ignored_folder_is_copied_but_build_output_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let out = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir.path())
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(out.status.success());
        std::fs::write(
            dir.path().join(".gitignore"),
            "secrets/\nnode_modules/\ntarget/\n",
        )
        .unwrap();
        for (path, body) in [
            ("secrets/.env", "API_KEY=1\n"),
            ("secrets/deep/.env.local", "DEEP=1\n"),
            ("node_modules/x/.env", "DEP=1\n"),
            ("secrets/node_modules/y/.env", "DEP=1\n"),
            ("target/debug/.env", "BUILD=1\n"),
            ("secrets/other/.git", "gitdir: /elsewhere\n"),
            ("secrets/other/.env", "OTHER=1\n"),
        ] {
            let p = dir.path().join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        let m = in_worktree(dir.path(), &pats(&DEFAULT)).await.unwrap();
        assert_eq!(
            m.files,
            vec![
                ("secrets/.env".to_string(), 10),
                ("secrets/deep/.env.local".to_string(), 7)
            ]
        );
    }

    #[test]
    fn a_copied_file_is_written_0600_in_a_0700_folder_and_never_through_a_link() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mode = |p: &Path| std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777;
        write(root.path(), "apps/web/.env", b"A=1\n").unwrap();
        assert_eq!(
            std::fs::read(root.path().join("apps/web/.env")).unwrap(),
            b"A=1\n"
        );
        assert_eq!(mode(&root.path().join("apps/web/.env")), 0o600);
        assert_eq!(mode(&root.path().join("apps")), 0o700);
        // A link at the file is replaced, its target left alone.
        std::fs::write(outside.path().join("target"), "keep\n").unwrap();
        std::os::unix::fs::symlink(outside.path().join("target"), root.path().join(".env"))
            .unwrap();
        write(root.path(), ".env", b"B=2\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(outside.path().join("target")).unwrap(),
            "keep\n"
        );
        assert_eq!(std::fs::read(root.path().join(".env")).unwrap(), b"B=2\n");
        // A linked folder on the way is refused.
        std::os::unix::fs::symlink(outside.path(), root.path().join("config")).unwrap();
        assert!(write(root.path(), "config/.env", b"C=3\n").is_err());
        assert!(read(root.path(), "config/target").is_err());
        assert!(!outside.path().join(".env").exists());
        for bad in ["../x", "/etc/x", ".git/config", ""] {
            assert!(write(root.path(), bad, b"x").is_err(), "{bad}");
        }
        // No temporary file is left behind.
        let names: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 3, "{names:?}");
    }

    #[tokio::test]
    async fn a_link_the_new_worktree_already_has_is_left_alone() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let out = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(from.path())
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(out.status.success());
        std::fs::write(from.path().join(".gitignore"), ".env\n").unwrap();
        std::fs::write(from.path().join(".env"), "SECRET=1\n").unwrap();
        std::fs::write(from.path().join(".env.local"), "FLAG=1\n").unwrap();
        // The new worktree's branch has `.env` as a link, as git can track.
        std::fs::write(outside.path().join("shared.env"), "SHARED=1\n").unwrap();
        std::os::unix::fs::symlink(outside.path().join("shared.env"), to.path().join(".env"))
            .unwrap();
        let copied = seed(from.path(), to.path(), &pats(&DEFAULT)).await.unwrap();
        assert_eq!(copied, [".env.local"]);
        assert!(
            std::fs::symlink_metadata(to.path().join(".env"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            std::fs::read_to_string(to.path().join(".env")).unwrap(),
            "SHARED=1\n"
        );
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let out = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(out.status.success());
        dir
    }

    #[tokio::test]
    async fn the_owners_files_replace_this_sides_which_are_kept_first() {
        let owner = repo();
        let copy = repo();
        let o = owner.path();
        let c = copy.path();
        write(o, ".env", b"DB=owner\n").unwrap();
        write(o, "apps/web/.env.local", b"FLAG=1\n").unwrap();
        write(c, ".env", b"DB=copy\n").unwrap();
        write(c, ".env.test", b"ONLY=copy\n").unwrap();
        let list = pats(&DEFAULT);
        let m = manifest(o, &list, |_, _| true, MAX_TOTAL).await.unwrap();
        let mut kept = Vec::new();
        let none = std::collections::BTreeSet::new();
        let done = apply(c, &list, &m, &none, |p, b| {
            kept.push((p.to_string(), String::from_utf8(b.to_vec()).unwrap()));
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(done.changed, [".env", "apps/web/.env.local"]);
        assert!(done.want.is_empty());
        assert_eq!(
            std::fs::read_to_string(c.join(".env")).unwrap(),
            "DB=owner\n"
        );
        assert_eq!(
            std::fs::read_to_string(c.join("apps/web/.env.local")).unwrap(),
            "FLAG=1\n"
        );
        // A file of this side's that the owner never had stays.
        assert_eq!(
            std::fs::read_to_string(c.join(".env.test")).unwrap(),
            "ONLY=copy\n"
        );
        assert_eq!(kept, [(".env".to_string(), "DB=copy\n".to_string())]);
        // Once the same, nothing more is done.
        let again = apply(c, &list, &m, &none, |_, _| panic!("nothing to keep"))
            .await
            .unwrap();
        assert_eq!(again, Applied::default());
        // One the owner had and deleted goes, kept first.
        std::fs::remove_file(o.join(".env")).unwrap();
        let m = manifest(o, &list, |_, _| true, MAX_TOTAL).await.unwrap();
        let had: std::collections::BTreeSet<String> =
            [".env".to_string(), "apps/web/.env.local".to_string()].into();
        let mut kept = Vec::new();
        let done = apply(c, &list, &m, &had, |p, b| {
            kept.push((p.to_string(), String::from_utf8(b.to_vec()).unwrap()));
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(done.changed, [".env"]);
        assert_eq!(kept, [(".env".to_string(), "DB=owner\n".to_string())]);
        assert!(c.join(".env.test").exists());
    }

    #[tokio::test]
    async fn a_file_whose_bytes_did_not_come_along_is_asked_for() {
        let owner = repo();
        let copy = repo();
        write(owner.path(), ".env", b"A=1\n").unwrap();
        let list = pats(&DEFAULT);
        let m = manifest(owner.path(), &list, |_, _| false, MAX_TOTAL)
            .await
            .unwrap();
        assert_eq!(
            m,
            [Entry {
                path: ".env".into(),
                sha: A1.into(),
                bytes: None
            }]
        );
        let done = apply(copy.path(), &list, &m, &Default::default(), |_, _| Ok(()))
            .await
            .unwrap();
        assert_eq!(done.want, [".env"]);
        assert!(!copy.path().join(".env").exists());
    }

    #[tokio::test]
    async fn a_file_over_the_limits_is_never_written_whatever_the_other_side_sent() {
        let copy = repo();
        let big = vec![b'x'; MAX_FILE as usize + 1];
        let entry = |path: &str, bytes: Vec<u8>| Entry {
            path: path.into(),
            sha: sha(&bytes),
            bytes: Some(bytes),
        };
        let done = apply(
            copy.path(),
            &pats(&DEFAULT),
            &[entry(".env", big)],
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(done, Applied::default());
        assert!(!copy.path().join(".env").exists());
        // 17 files of 1 MiB: only 16 are written.
        let list: Vec<Entry> = (0..17)
            .map(|n| entry(&format!("a{n:02}/.env"), vec![b'y'; MAX_FILE as usize]))
            .collect();
        let done = apply(copy.path(), &pats(&DEFAULT), &list, |_, _| Ok(()))
            .await
            .unwrap();
        assert_eq!(done.changed.len(), 16);
        assert!(!copy.path().join("a16/.env").exists());
    }

    #[tokio::test]
    async fn a_file_git_tracks_on_this_side_is_never_written() {
        let copy = repo();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(copy.path())
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        std::fs::write(copy.path().join(".env.example"), "EXAMPLE=1\n").unwrap();
        run(&["add", ".env.example"]);
        let entry = Entry {
            path: ".env.example".into(),
            sha: sha(b"EVIL=1\n"),
            bytes: Some(b"EVIL=1\n".to_vec()),
        };
        let done = apply(copy.path(), &pats(&DEFAULT), &[entry], |_, _| Ok(()))
            .await
            .unwrap();
        assert_eq!(done, Applied::default());
        assert_eq!(
            std::fs::read_to_string(copy.path().join(".env.example")).unwrap(),
            "EXAMPLE=1\n"
        );
    }

    #[tokio::test]
    async fn a_path_this_sides_list_does_not_name_is_refused() {
        let copy = repo();
        let entry = |path: &str| Entry {
            path: path.into(),
            sha: sha(b"x"),
            bytes: Some(b"x".to_vec()),
        };
        for path in ["notes.txt", "../.env", ".git/.env"] {
            assert!(
                apply(
                    copy.path(),
                    &pats(&DEFAULT),
                    &[entry(path)],
                    &Default::default(),
                    |_, _| Ok(())
                )
                .await
                .is_err(),
                "{path}"
            );
        }
        assert!(!copy.path().join("notes.txt").exists());
    }

    /// `printf 'A=1\n' | shasum -a 256`.
    const A1: &str = "91d6a3d55e9fea7911c537afae6607c77fa8bc0f3a76c375e104ac5a8cfa84db";

    #[test]
    fn a_files_hash_is_its_sha256() {
        assert_eq!(sha(b"A=1\n"), A1);
    }

    #[test]
    fn a_conflict_on_a_checkout_goes_to_the_later_stamp() {
        let v = |stamp, by: &str| Version {
            sha: Some("a".into()),
            stamp,
            by: by.into(),
        };
        assert!(v(1_000, "book").after(&v(999, "mini")));
        assert!(!v(999, "mini").after(&v(1_000, "book")));
        // The same stamp: the greater member id, on every member alike.
        assert!(v(1_000, "mini").after(&v(1_000, "book")));
        assert!(!v(1_000, "book").after(&v(1_000, "mini")));
    }

    #[test]
    fn a_checkouts_new_changed_and_deleted_files_are_noticed() {
        let shas = |list: &[(&str, &str)]| {
            list.iter()
                .map(|(p, s)| (p.to_string(), (s.to_string(), 5)))
                .collect()
        };
        let mut table = std::collections::BTreeMap::new();
        assert_eq!(
            notice(
                &mut table,
                &shas(&[(".env", "a"), (".env.local", "b")]),
                10,
                "book"
            ),
            [".env", ".env.local"]
        );
        assert_eq!(
            notice(
                &mut table,
                &shas(&[(".env", "a"), (".env.local", "b")]),
                20,
                "book"
            ),
            Vec::<String>::new()
        );
        assert_eq!(
            notice(&mut table, &shas(&[(".env", "c")]), 30, "book"),
            [".env", ".env.local"]
        );
        // A change is stamped with the file's change time, a deletion when
        // it is noticed.
        assert_eq!(
            table[".env"],
            Version {
                sha: Some("c".into()),
                stamp: 5,
                by: "book".into()
            }
        );
        assert_eq!(
            table[".env.local"],
            Version {
                sha: None,
                stamp: 30,
                by: "book".into()
            }
        );
    }

    #[test]
    fn links_git_files_and_files_over_a_mebibyte_are_never_copied() {
        let candidates = pats(&[".env", ".env.big", ".env.link", ".git/.env"]);
        let m = select(&pats(&DEFAULT), &candidates, |p| match p {
            ".env.big" => Some(MAX_FILE + 1),
            ".env.link" => None,
            _ => Some(10),
        })
        .unwrap();
        assert_eq!(m.files, vec![(".env".to_string(), 10)]);
        assert_eq!(
            m.skipped,
            vec![
                (".env.big".to_string(), "is over 1 MiB".to_string()),
                (".env.link".to_string(), "is not a plain file".to_string()),
            ]
        );
    }

    #[test]
    fn matches_are_taken_in_path_order_before_the_limits() {
        let candidates: Vec<String> = (0..201).rev().map(|n| format!("e/{n:03}/.env")).collect();
        let m = select(&pats(&DEFAULT), &candidates, |_| Some(1)).unwrap();
        assert_eq!(m.files.len(), 200);
        assert_eq!(m.files[0].0, "e/000/.env");
        assert_eq!(
            m.skipped,
            vec![(
                "e/200/.env".to_string(),
                "is past the 200 files or 16 MiB copied per worktree".to_string()
            )]
        );
    }

    #[test]
    fn the_file_that_passes_sixteen_mebibytes_and_every_later_one_are_skipped() {
        // 17 files of 1 MiB: the 17th passes 16 MiB; a later small one too.
        let mut candidates: Vec<String> = (0..17).map(|n| format!("a{n:02}/.env")).collect();
        candidates.push("z/.env".into());
        let m = select(&pats(&DEFAULT), &candidates, |p| {
            Some(if p == "z/.env" { 1 } else { MAX_FILE })
        })
        .unwrap();
        assert_eq!(m.files.len(), 16);
        assert_eq!(
            m.skipped
                .iter()
                .map(|(p, _)| p.as_str())
                .collect::<Vec<_>>(),
            ["a16/.env", "z/.env"]
        );
    }
}
