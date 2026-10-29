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

/// Copies the files the list names in checkout `from` into new worktree
/// `to`, leaving any `to` already has; the paths copied.
pub async fn seed(from: &Path, to: &Path, patterns: &[String]) -> Result<Vec<String>> {
    let mut copied = Vec::new();
    for (rel, _) in in_worktree(from, patterns).await?.files {
        if read(to, &rel).ok().flatten().is_some() {
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
