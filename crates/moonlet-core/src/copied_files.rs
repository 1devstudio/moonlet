//! Files copied between members although git ignores them (X74): a
//! project's list of patterns, `.env` and `.env.*` by default, and which of
//! a worktree's files it names. They travel outside git, so they never
//! enter an object store.

use std::path::Path;

use anyhow::{Result, bail};
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

/// The files of worktree `dir` that git does not track: untracked ones, and
/// ignored ones not inside an ignored folder (`node_modules/` is never
/// walked).
pub async fn untracked(dir: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
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
        let bytes = crate::git::git(dir, args).await?;
        out.extend(
            bytes
                .split(|b| *b == 0)
                .filter(|p| !p.is_empty() && !p.ends_with(b"/"))
                .filter_map(|p| std::str::from_utf8(p).ok().map(str::to_string)),
        );
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
