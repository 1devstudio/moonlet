//! Git operations, run with the git CLI on the host that owns the work tree
//! (D1, D2, A4). The same code serves local and remote hosts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use moonlet_proto::types::{
    BasePull, BaseStatus, CheckRun, Commit, FileChange, FileVersions, GitStatus, PrStack,
    PullRequest, StackPr, UnpushedFile, UnpushedWork,
};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Hash of the empty tree; diff base for repositories without commits.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_TEXT: u64 = 2 * 1024 * 1024;

pub struct Output {
    pub status: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

pub(crate) async fn run_raw(
    program: &str,
    cwd: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<Output> {
    run_raw_env(program, cwd, args, &[], stdin, timeout).await
}

/// [`run_raw`], with variables set after the inherited ones are cleared,
/// such as a private `GIT_INDEX_FILE` (X60).
pub(crate) async fn run_raw_env(
    program: &str,
    cwd: &Path,
    args: &[&str],
    env: &[(&str, &str)],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<Output> {
    let mut cmd = Command::new(program);
    // Repository-location variables inherited from whoever started the
    // daemon (a git hook, say) would point every call at another repo.
    for var in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
        "GIT_NAMESPACE",
        "GIT_CEILING_DIRECTORIES",
        "GIT_PREFIX",
    ] {
        cmd.env_remove(var);
    }
    cmd.envs(env.iter().copied());
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(if stdin.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .with_context(|| format!("cannot run {program}"))?;
    // The input is written beside reading the output, not before it: a
    // program that answers as it reads would otherwise fill its output
    // pipe and wait on us while we wait on it. Both count to the timeout.
    let writer = match (stdin, child.stdin.take()) {
        (Some(data), Some(mut pipe)) => {
            let data = data.to_vec();
            Some(tokio::spawn(async move {
                let written = pipe.write_all(&data).await;
                drop(pipe);
                written
            }))
        }
        _ => None,
    };
    let out = tokio::time::timeout(timeout, async {
        let out = child.wait_with_output().await?;
        if let Some(writer) = writer {
            // A program that exits before reading all of its input closes
            // the pipe; its exit status says what went wrong.
            let _ = writer.await;
        }
        anyhow::Ok(out)
    })
    .await
    .with_context(|| format!("{program} {} timed out", args.join(" ")))??;
    Ok(Output {
        status: out.status.code().unwrap_or(-1),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

/// Runs git and fails on a non-zero exit.
pub async fn git(cwd: &Path, args: &[&str]) -> Result<Vec<u8>> {
    git_with(cwd, &[], args, None, Duration::from_secs(60)).await
}

/// [`git`] with environment variables, input and a timeout of its own.
pub(crate) async fn git_with(
    cwd: &Path,
    env: &[(&str, &str)],
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<Vec<u8>> {
    let out = run_raw_env("git", cwd, args, env, stdin, timeout).await?;
    if out.status != 0 {
        bail!("git {}: {}", args.join(" "), out.stderr);
    }
    Ok(out.stdout)
}

pub async fn git_text(cwd: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8_lossy(&git(cwd, args).await?)
        .trim_end()
        .to_string())
}

async fn git_stdin(cwd: &Path, args: &[&str], stdin: &[u8]) -> Result<()> {
    git_with(cwd, &[], args, Some(stdin), Duration::from_secs(60)).await?;
    Ok(())
}

pub async fn toplevel(path: &Path) -> Result<PathBuf> {
    Ok(PathBuf::from(
        git_text(path, &["rev-parse", "--show-toplevel"])
            .await
            .context("not a git repository")?,
    ))
}

/// The URL of the repository's `origin` remote, or `None` without one (spec X15).
pub async fn origin_url(repo: &Path) -> Option<String> {
    git_text(repo, &["remote", "get-url", "origin"])
        .await
        .ok()
        .filter(|u| !u.is_empty())
}

/// The repository's main branch: `origin/HEAD`, else `main`/`master`, else the current branch.
pub async fn default_branch(repo: &Path) -> String {
    if let Ok(r) = git_text(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .await
        && let Some(b) = r.strip_prefix("origin/")
    {
        return b.to_string();
    }
    for b in ["main", "master", "develop", "trunk"] {
        if git(
            repo,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{b}"),
            ],
        )
        .await
        .is_ok()
        {
            return b.to_string();
        }
    }
    git_text(repo, &["branch", "--show-current"])
        .await
        .ok()
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| "main".into())
}

async fn has_head(cwd: &Path) -> bool {
    git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .await
        .is_ok()
}

/// Ref to diff against: the merge-base with `base` when given, else HEAD.
pub async fn resolve_against(cwd: &Path, base: Option<&str>) -> String {
    resolve_base(cwd, base).await.0
}

/// Like [`resolve_against`], also returning the base name when it was given
/// but could not be resolved (the result then falls back to HEAD).
pub async fn resolve_base(cwd: &Path, base: Option<&str>) -> (String, Option<String>) {
    if !has_head(cwd).await {
        return (EMPTY_TREE.into(), None);
    }
    if let Some(base) = base.filter(|b| !b.is_empty() && *b != "HEAD") {
        for candidate in [base.to_string(), format!("origin/{base}")] {
            if let Ok(mb) = git_text(cwd, &["merge-base", "HEAD", &candidate]).await {
                return (mb, None);
            }
        }
        tracing::warn!(base, cwd = %cwd.display(), "diff base not found; using HEAD");
        return ("HEAD".into(), Some(base.to_string()));
    }
    ("HEAD".into(), None)
}

struct Porcelain {
    branch: Option<String>,
    head: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    /// path -> (staged, unstaged, conflicted)
    entries: HashMap<String, (bool, bool, bool)>,
    untracked: Vec<String>,
}

fn parse_porcelain(raw: &[u8]) -> Porcelain {
    let mut p = Porcelain {
        branch: None,
        head: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        entries: HashMap::new(),
        untracked: Vec::new(),
    };
    let mut fields = raw
        .split(|b| *b == 0)
        .map(|f| String::from_utf8_lossy(f).into_owned());
    while let Some(line) = fields.next() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            p.branch = (rest != "(detached)").then(|| rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.oid ") {
            p.head = (rest != "(initial)").then(|| rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            p.upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for part in rest.split(' ') {
                if let Some(a) = part.strip_prefix('+') {
                    p.ahead = a.parse().unwrap_or(0);
                } else if let Some(b) = part.strip_prefix('-') {
                    p.behind = b.parse().unwrap_or(0);
                }
            }
        } else if let Some(path) = line.strip_prefix("? ") {
            p.untracked.push(path.to_string());
        } else if line.starts_with("1 ") || line.starts_with("2 ") || line.starts_with("u ") {
            let kind = line.as_bytes()[0];
            let xy: Vec<char> = line[2..4].chars().collect();
            // Path is the last space-separated field (9 fields for "1", 10 for "2", 11 for "u").
            let n = match kind {
                b'1' => 8,
                b'2' => 9,
                _ => 10,
            };
            let path = line.splitn(n + 1, ' ').nth(n).unwrap_or("").to_string();
            if kind == b'2' {
                fields.next(); // original path
            }
            let conflicted = kind == b'u';
            p.entries.insert(
                path,
                (
                    xy[0] != '.' && !conflicted,
                    xy[1] != '.' && !conflicted,
                    conflicted,
                ),
            );
        }
    }
    p
}

fn count_lines(path: &Path) -> (u32, bool) {
    match std::fs::read(path) {
        Ok(data) if data.len() as u64 <= MAX_TEXT => {
            if is_binary(&data) {
                (0, true)
            } else {
                (
                    data.iter().filter(|b| **b == b'\n').count() as u32
                        + u32::from(!data.is_empty() && *data.last().unwrap() != b'\n'),
                    false,
                )
            }
        }
        Ok(_) => (0, true),
        Err(_) => (0, false),
    }
}

pub fn is_binary(data: &[u8]) -> bool {
    data[..data.len().min(8000)].contains(&0)
}

pub async fn status(path: &Path, base: Option<&str>) -> Result<GitStatus> {
    let root = toplevel(path).await?;
    let porcelain = parse_porcelain(
        &git(
            &root,
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
            ],
        )
        .await?,
    );
    let (against, base_missing) = resolve_base(&root, base).await;

    // Status letters against the diff base (covers committed and uncommitted work).
    let mut files: Vec<FileChange> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let names = git(&root, &["diff", "--name-status", "-z", "-M", &against]).await?;
    let mut it = names
        .split(|b| *b == 0)
        .map(|f| String::from_utf8_lossy(f).into_owned());
    while let Some(code) = it.next() {
        if code.is_empty() {
            continue;
        }
        let letter = code.chars().next().unwrap();
        let (old_path, path) = if letter == 'R' || letter == 'C' {
            let old = it.next().unwrap_or_default();
            (Some(old), it.next().unwrap_or_default())
        } else {
            (None, it.next().unwrap_or_default())
        };
        let status = match letter {
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            'C' => "added",
            'U' => "conflicted",
            _ => "modified",
        };
        index.insert(path.clone(), files.len());
        files.push(FileChange {
            path,
            old_path,
            status: status.into(),
            staged: false,
            unstaged: false,
            additions: 0,
            deletions: 0,
            binary: false,
        });
    }
    let numstat = git(&root, &["diff", "--numstat", "-z", "-M", &against]).await?;
    let mut it = numstat
        .split(|b| *b == 0)
        .map(|f| String::from_utf8_lossy(f).into_owned());
    while let Some(rec) = it.next() {
        let mut parts = rec.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let path = if p.is_empty() {
            it.next();
            it.next().unwrap_or_default()
        } else {
            p.to_string()
        };
        if let Some(&i) = index.get(&path) {
            let f = &mut files[i];
            f.binary = a == "-";
            f.additions = a.parse().unwrap_or(0);
            f.deletions = d.parse().unwrap_or(0);
        }
    }
    for path in &porcelain.untracked {
        let (lines, binary) = count_lines(&root.join(path));
        index.insert(path.clone(), files.len());
        files.push(FileChange {
            path: path.clone(),
            old_path: None,
            status: "untracked".into(),
            staged: false,
            unstaged: true,
            additions: lines,
            deletions: 0,
            binary,
        });
    }
    for (path, (staged, unstaged, conflicted)) in &porcelain.entries {
        if let Some(&i) = index.get(path) {
            files[i].staged = *staged;
            files[i].unstaged = *unstaged;
            if *conflicted {
                files[i].status = "conflicted".into();
            }
        } else if *conflicted {
            files.push(FileChange {
                path: path.clone(),
                old_path: None,
                status: "conflicted".into(),
                staged: false,
                unstaged: true,
                additions: 0,
                deletions: 0,
                binary: false,
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let additions = files.iter().map(|f| f.additions).sum();
    let deletions = files.iter().map(|f| f.deletions).sum();
    Ok(GitStatus {
        branch: porcelain.branch,
        head: porcelain.head,
        upstream: porcelain.upstream,
        ahead: porcelain.ahead,
        behind: porcelain.behind,
        against,
        base_missing,
        files,
        additions,
        deletions,
    })
}

async fn show(root: &Path, spec: &str) -> Option<Vec<u8>> {
    git(root, &["show", spec]).await.ok()
}

fn to_text(data: Option<Vec<u8>>) -> (Option<String>, bool) {
    match data {
        Some(d) if is_binary(&d) || d.len() as u64 > MAX_TEXT => (None, true),
        Some(d) => (Some(String::from_utf8_lossy(&d).into_owned()), false),
        None => (None, false),
    }
}

/// Both sides of a file for the diff viewer.
pub async fn file_versions(
    path: &Path,
    file: &str,
    base: Option<&str>,
    staged: bool,
) -> Result<FileVersions> {
    let root = toplevel(path).await?;
    let rel = safe_relative(file)?;
    let (orig, modified) = if staged {
        let head = if has_head(&root).await {
            show(&root, &format!("HEAD:{rel}")).await
        } else {
            None
        };
        (head, show(&root, &format!(":{rel}")).await)
    } else {
        let against = resolve_against(&root, base).await;
        // Follow a rename back to the old name on the base side.
        let st = status(&root, base).await?;
        let old = st
            .files
            .iter()
            .find(|f| f.path == rel)
            .and_then(|f| f.old_path.clone())
            .unwrap_or_else(|| rel.clone());
        let base_side = if against == EMPTY_TREE {
            None
        } else {
            show(&root, &format!("{against}:{old}")).await
        };
        (base_side, std::fs::read(root.join(&rel)).ok())
    };
    let (original, b1) = to_text(orig);
    let (modified, b2) = to_text(modified);
    Ok(FileVersions {
        original,
        modified,
        binary: b1 || b2,
    })
}

/// Unified diff of one file (or everything when `file` is empty).
pub async fn diff(path: &Path, file: &str, base: Option<&str>, staged: bool) -> Result<String> {
    let root = toplevel(path).await?;
    let mut args: Vec<String> = vec!["diff".into(), "--no-color".into(), "--no-ext-diff".into()];
    if staged {
        args.push("--cached".into());
    } else {
        args.push(resolve_against(&root, base).await);
    }
    if !file.is_empty() {
        let rel = safe_relative(file)?;
        let tracked = git(&root, &["ls-files", "--error-unmatch", "--", &rel])
            .await
            .is_ok();
        if !tracked && !staged {
            let out = run_raw(
                "git",
                &root,
                &["diff", "--no-color", "--no-index", "--", "/dev/null", &rel],
                None,
                Duration::from_secs(30),
            )
            .await?;
            return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
        }
        args.push("--".into());
        args.push(rel);
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    Ok(String::from_utf8_lossy(&git(&root, &refs).await?).into_owned())
}

/// Rejects absolute paths and `..` so RPC callers stay inside the work tree.
pub fn safe_relative(file: &str) -> Result<String> {
    let p = Path::new(file);
    if p.is_absolute()
        || p.components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        bail!("path must be relative to the work tree: {file}");
    }
    Ok(file.to_string())
}

fn rels(files: &[String]) -> Result<Vec<String>> {
    files.iter().map(|f| safe_relative(f)).collect()
}

pub async fn stage(path: &Path, files: &[String]) -> Result<()> {
    let root = toplevel(path).await?;
    let files = rels(files)?;
    let mut args = vec!["add", "-A", "--"];
    args.extend(files.iter().map(String::as_str));
    git(&root, &args).await?;
    Ok(())
}

pub async fn unstage(path: &Path, files: &[String]) -> Result<()> {
    let root = toplevel(path).await?;
    let files = rels(files)?;
    let mut args = if has_head(&root).await {
        vec!["restore", "--staged", "--"]
    } else {
        vec!["rm", "--cached", "-r", "-q", "--"]
    };
    args.extend(files.iter().map(String::as_str));
    git(&root, &args).await?;
    Ok(())
}

/// Discards changes to files: tracked files go back to HEAD, untracked files are deleted.
pub async fn revert(path: &Path, files: &[String]) -> Result<()> {
    let root = toplevel(path).await?;
    let files = rels(files)?;
    let st = status(&root, None).await?;
    let mut tracked = Vec::new();
    for f in &files {
        match st.files.iter().find(|c| &c.path == f) {
            Some(c) if c.status == "untracked" => {
                std::fs::remove_file(root.join(f)).with_context(|| format!("remove {f}"))?
            }
            Some(c) if c.status == "added" => {
                git(&root, &["rm", "-f", "-q", "--", f]).await?;
            }
            _ => tracked.push(f.as_str()),
        }
    }
    if !tracked.is_empty() {
        let mut args = vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"];
        args.extend(tracked);
        git(&root, &args).await?;
    }
    Ok(())
}

/// Applies a patch (one hunk or more) to the index or the work tree.
pub async fn apply_patch(path: &Path, patch: &str, cached: bool, reverse: bool) -> Result<()> {
    let root = toplevel(path).await?;
    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-");
    git_stdin(&root, &args, patch.as_bytes()).await
}

pub async fn commit(path: &Path, message: &str, all: bool) -> Result<String> {
    let root = toplevel(path).await?;
    if message.trim().is_empty() {
        bail!("commit message is empty");
    }
    if all {
        git(&root, &["add", "-A"]).await?;
    }
    git_stdin(&root, &["commit", "-F", "-"], message.as_bytes()).await?;
    git_text(&root, &["rev-parse", "HEAD"]).await
}

pub async fn log(path: &Path, base: Option<&str>) -> Result<Vec<Commit>> {
    let root = toplevel(path).await?;
    if !has_head(&root).await {
        return Ok(Vec::new());
    }
    let against = resolve_against(&root, base).await;
    let range = if against == "HEAD" {
        "HEAD".to_string()
    } else {
        format!("{against}..HEAD")
    };
    let raw = git_text(
        &root,
        &[
            "log",
            "--format=%H%x1f%s%x1f%an%x1f%ct",
            "-n",
            "200",
            &range,
        ],
    )
    .await?;
    Ok(parse_commits(&raw))
}

/// The checked-out branch; fails on a detached HEAD.
pub async fn current_branch(path: &Path) -> Result<String> {
    git_text(path, &["symbolic-ref", "--short", "HEAD"]).await
}

pub async fn branches(path: &Path) -> Result<Vec<String>> {
    let raw = git_text(
        path,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "--sort=-committerdate",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .await?;
    Ok(raw
        .lines()
        .filter(|l| !l.ends_with("/HEAD") && !l.is_empty())
        .map(String::from)
        .collect())
}

/// Commit lines as `log --format=%H%x1f%s%x1f%an%x1f%ct` prints them.
fn parse_commits(raw: &str) -> Vec<Commit> {
    raw.lines()
        .filter_map(|l| {
            let mut p = l.split('\x1f');
            Some(Commit {
                sha: p.next()?.into(),
                subject: p.next()?.into(),
                author: p.next()?.into(),
                time: p.next()?.parse().ok()?,
            })
        })
        .collect()
}

/// The work tree that has `branch` checked out, from
/// `git worktree list --porcelain`. Prunable entries (directory gone) do
/// not count.
fn checkout_of(porcelain: &str, branch: &str) -> Option<String> {
    let want = format!("branch refs/heads/{branch}");
    porcelain.split("\n\n").find_map(|entry| {
        let lines: Vec<&str> = entry.lines().collect();
        if !lines.contains(&want.as_str()) || lines.iter().any(|l| l.starts_with("prunable")) {
            return None;
        }
        lines
            .iter()
            .find_map(|l| l.strip_prefix("worktree "))
            .map(String::from)
    })
}

/// The linked work trees in `git worktree list --porcelain`, with their
/// branch (`None` when detached). The first entry, the main checkout, and
/// prunable entries (directory gone) are left out.
fn linked_worktrees(porcelain: &str) -> Vec<(String, Option<String>)> {
    porcelain
        .split("\n\n")
        .skip(1)
        .filter_map(|entry| {
            let lines: Vec<&str> = entry.lines().collect();
            if lines.iter().any(|l| l.starts_with("prunable")) {
                return None;
            }
            let path = lines.iter().find_map(|l| l.strip_prefix("worktree "))?;
            let branch = lines
                .iter()
                .find_map(|l| l.strip_prefix("branch refs/heads/"))
                .map(String::from);
            Some((path.to_string(), branch))
        })
        .collect()
}

/// The project's linked work trees (X45), with the time of their last
/// commit, so ones made outside moonlet can show on their task.
pub async fn worktrees(repo: &Path) -> Result<Vec<moonlet_proto::types::Worktree>> {
    let root = toplevel(repo).await?;
    let out = git_text(&root, &["worktree", "list", "--porcelain"]).await?;
    let mut list = Vec::new();
    for (path, branch) in linked_worktrees(&out) {
        let last = git_text(Path::new(&path), &["log", "-1", "--format=%ct"]).await;
        let last_commit_ms = last
            .ok()
            .and_then(|t| t.trim().parse::<u64>().ok())
            .unwrap_or(0)
            * 1000;
        list.push(moonlet_proto::types::Worktree {
            path,
            branch,
            last_commit_ms,
        });
    }
    Ok(list)
}

/// Rejects branch names git could read as an option or that are not
/// branch names at all.
async fn check_branch(root: &Path, branch: &str) -> Result<()> {
    if branch.starts_with('-')
        || git(root, &["check-ref-format", "--branch", branch])
            .await
            .is_err()
    {
        bail!("invalid branch name: {branch}");
    }
    Ok(())
}

/// The project's base branch against `origin/<branch>` (spec X13), or
/// `None` when either ref is missing. `fetch` updates the remote-tracking
/// branch first; a failed fetch is reported, not fatal.
pub async fn base_status(repo: &Path, branch: &str, fetch: bool) -> Result<Option<BaseStatus>> {
    let root = toplevel(repo).await?;
    check_branch(&root, branch).await?;
    let fetch_error = if fetch {
        git(&root, &["fetch", "--quiet", "--no-tags", "origin", branch])
            .await
            .err()
            .map(|e| e.to_string())
    } else {
        None
    };
    let (local, upstream) = (
        format!("refs/heads/{branch}"),
        format!("refs/remotes/origin/{branch}"),
    );
    for r in [&local, &upstream] {
        if git(&root, &["rev-parse", "--verify", "--quiet", r])
            .await
            .is_err()
        {
            return Ok(None);
        }
    }
    let counts = git_text(
        &root,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{local}...{upstream}"),
        ],
    )
    .await?;
    let mut n = counts.split_whitespace().map(|x| x.parse().unwrap_or(0));
    let (ahead, behind) = (n.next().unwrap_or(0), n.next().unwrap_or(0));
    let commits = parse_commits(
        &git_text(
            &root,
            &[
                "log",
                "--format=%H%x1f%s%x1f%an%x1f%ct",
                "-n",
                "20",
                &format!("{local}..{upstream}"),
            ],
        )
        .await?,
    );
    Ok(Some(BaseStatus {
        branch: branch.into(),
        upstream: format!("origin/{branch}"),
        ahead,
        behind,
        commits,
        checkout: checkout_of(
            &git_text(&root, &["worktree", "list", "--porcelain"]).await?,
            branch,
        ),
        fetch_error,
    }))
}

/// Fast-forwards the base branch to the `origin/<branch>` already fetched
/// (spec X13). Where the branch is checked out, the merge runs in that work
/// tree so its files follow; elsewhere only the ref moves. A diverged
/// branch is left alone.
pub async fn pull_base(repo: &Path, branch: &str) -> Result<BasePull> {
    let root = toplevel(repo).await?;
    let st = base_status(&root, branch, false)
        .await?
        .with_context(|| format!("{branch} has no origin/{branch} to pull from"))?;
    let local = format!("refs/heads/{branch}");
    let old = git_text(&root, &["rev-parse", &local]).await?;
    if st.behind == 0 {
        return Ok(BasePull {
            pulled: 0,
            head: old,
        });
    }
    if st.ahead > 0 {
        bail!(
            "cannot fast-forward {branch}: it has {} commit(s) that are not on {}",
            st.ahead,
            st.upstream
        );
    }
    let upstream = format!("refs/remotes/origin/{branch}");
    let new = git_text(&root, &["rev-parse", &upstream]).await?;
    match &st.checkout {
        Some(dir) => {
            git(Path::new(dir), &["merge", "--ff-only", "--quiet", &new]).await?;
        }
        None => {
            // Compare-and-swap: fails if the branch moved since `old`.
            let msg = format!("moonlet: fast-forward {branch} to {}", st.upstream);
            git(&root, &["update-ref", "-m", &msg, &local, &new, &old]).await?;
        }
    }
    Ok(BasePull {
        pulled: st.behind,
        head: new,
    })
}

pub async fn worktree_add(
    repo: &Path,
    dir: &Path,
    branch: &str,
    from: &str,
    existing: bool,
) -> Result<()> {
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let dir_s = dir.display().to_string();
    if existing {
        git(repo, &["worktree", "add", &dir_s, branch]).await?;
    } else {
        // A branch started from `origin/<base>` (X55) must not track it:
        // its upstream is set when it is first pushed.
        git(repo, &["worktree", "add", "--no-track", "-b", branch, &dir_s, from]).await?;
    }
    Ok(())
}

/// Fetches `branch` from origin, so `origin/<branch>` is current.
/// The name comes from the repo's config: it must be a branch name, never
/// an option.
pub async fn fetch_branch(repo: &Path, branch: &str) -> Result<()> {
    check_branch(repo, branch).await?;
    git(repo, &["fetch", "--quiet", "--no-tags", "--", "origin", branch]).await?;
    Ok(())
}

pub async fn worktree_remove(repo: &Path, dir: &Path) -> Result<()> {
    let dir_s = dir.display().to_string();
    if git(repo, &["worktree", "remove", "--force", &dir_s])
        .await
        .is_err()
    {
        // Already gone from disk: drop the stale registration.
        git(repo, &["worktree", "prune"]).await?;
    }
    Ok(())
}

/// `git status --porcelain=v1 -z` as one letter per file: the index's
/// change, else the work tree's; `?` for untracked (X55).
pub fn parse_short_status(out: &str) -> Vec<UnpushedFile> {
    let mut files = Vec::new();
    let mut entries = out.split('\0').filter(|e| !e.is_empty());
    while let Some(e) = entries.next() {
        let (Some(xy), Some(path)) = (e.get(..2), e.get(3..)) else { continue };
        let (x, y) = (&xy[..1], &xy[1..]);
        let status = if xy == "??" { "?" } else if x != " " { x } else { y };
        // A rename or copy is followed by the path it came from.
        if matches!(x, "R" | "C") {
            entries.next();
        }
        files.push(UnpushedFile { status: status.into(), path: path.into() });
    }
    files
}

/// What in `dir` is only on this machine (X55): uncommitted files, and the
/// commits that removing the folder and deleting `branch` (the session's,
/// else the checked-out one) would lose. `merged_head` is the head commit of
/// the branch's merged PR: GitHub keeps it and what it contains, even after
/// a squash merge and once the branch is deleted.
pub async fn unpushed(dir: &Path, branch: Option<&str>, merged_head: Option<&str>) -> Result<UnpushedWork> {
    let status = git_text(dir, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]).await?;
    let own = match branch {
        Some(b) => known_branch(dir, b).await,
        // The full name: `--short` reads `heads/<b>` when a tag shares it.
        None => match git_text(dir, &["symbolic-ref", "-q", "HEAD"]).await {
            Ok(r) => known_branch(dir, r.strip_prefix("refs/heads/").unwrap_or_default()).await,
            Err(_) => None,
        },
    };
    let upstream = match &own {
        Some(b) => git_text(dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", &format!("{b}@{{upstream}}")])
            .await
            .ok()
            .filter(|u| !u.is_empty()),
        None => None,
    };
    let merged_head = known_commit(dir, merged_head).await;
    // Commits on the branch, or a detached HEAD, that no other branch or
    // remote has. A HEAD on another branch is kept with that branch.
    // `--branches` takes the short name.
    let own_ref = own.as_ref().map(|b| format!("refs/heads/{b}"));
    let exclude = own.as_ref().map(|b| format!("--exclude={b}"));
    let mut args = vec!["rev-list", "--count", "HEAD"];
    args.extend(own_ref.as_deref());
    args.push("--not");
    args.extend(merged_head);
    args.extend(exclude.as_deref());
    args.extend(["--branches", "--remotes"]);
    let count = git_text(dir, &args).await?;
    Ok(UnpushedWork { files: parse_short_status(&status), commits: count.trim().parse().unwrap_or(0), upstream })
}

/// `id` when it is a commit id this clone has: anything else would fail a
/// `rev-list`, or be read as an option.
async fn known_commit<'a>(dir: &Path, id: Option<&'a str>) -> Option<&'a str> {
    let id = id.filter(|m| m.len() >= 7 && m.chars().all(|c| c.is_ascii_hexdigit()))?;
    git(dir, &["cat-file", "-e", &format!("{id}^{{commit}}")]).await.ok().map(|_| id)
}

/// `branch` when it is a local branch git can be given safely. `git
/// update-ref` makes a branch named like an option, which `git branch`
/// refuses: such a name is never passed on.
async fn known_branch(dir: &Path, branch: &str) -> Option<String> {
    if branch.is_empty() || branch.starts_with('-') {
        return None;
    }
    git(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])
        .await
        .ok()
        .map(|_| branch.to_string())
}

/// `git push -u origin <branch>`, the session's branch when git knows it,
/// else HEAD as Create pull request does. Refuses while a detached HEAD has
/// commits that neither a branch nor the merged PR's head has: the push
/// would not save them.
pub async fn push(dir: &Path, branch: Option<&str>, merged_head: Option<&str>) -> Result<()> {
    let target = match branch {
        Some(b) => known_branch(dir, b).await.map(|b| format!("refs/heads/{b}:refs/heads/{b}")),
        None => None,
    };
    if target.is_some() && current_branch(dir).await.is_err() {
        let mut args = vec!["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes"];
        args.extend(known_commit(dir, merged_head).await);
        let n: u32 = git_text(dir, &args).await?.parse().unwrap_or(0);
        if n > 0 {
            let (what, verb, it) = if n == 1 { ("commit", "is", "it") } else { ("commits", "are", "them") };
            bail!("{n} {what} on a detached HEAD {verb} on no branch. Put {it} on a branch first.");
        }
    }
    git(dir, &["push", "-u", "origin", target.as_deref().unwrap_or("HEAD")]).await?;
    Ok(())
}

/// Deletes `branch` on origin, as GitHub's "Delete branch" would (X55).
pub async fn delete_remote_branch(repo: &Path, branch: &str) -> Result<()> {
    git(repo, &["push", "--quiet", "--delete", "--", "origin", branch]).await?;
    Ok(())
}

pub async fn delete_branch(repo: &Path, branch: &str) -> Result<()> {
    git(repo, &["branch", "-D", branch]).await?;
    Ok(())
}

/// Turns a task name into a branch-safe slug.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out
        .trim_end_matches('-')
        .chars()
        .take(48)
        .collect::<String>();
    if out.is_empty() { "task".into() } else { out }
}

// --- GitHub via the gh CLI -------------------------------------------------

async fn gh(cwd: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = run_raw("gh", cwd, args, None, Duration::from_secs(120)).await?;
    if out.status != 0 {
        bail!("gh {}: {}", args.join(" "), out.stderr);
    }
    Ok(out.stdout)
}

pub async fn pr_create(
    path: &Path,
    title: &str,
    body: &str,
    base: Option<&str>,
    draft: bool,
) -> Result<PullRequest> {
    let root = toplevel(path).await?;
    git(&root, &["push", "-u", "origin", "HEAD"]).await?;
    let mut args = vec!["pr", "create", "--title", title, "--body", body];
    if let Some(b) = base {
        args.push("--base");
        args.push(b);
    }
    if draft {
        args.push("--draft");
    }
    let out = gh(&root, &args).await?;
    // By number: the branch name may also head an older, merged PR.
    let number = created_pr_number(&out).context("gh pr create printed no PR URL")?;
    pr_view(&root, Some(number))
        .await?
        .context("pull request was created but cannot be read back")
}

/// The PR number in the URL `gh pr create` prints last.
fn created_pr_number(stdout: &[u8]) -> Option<u64> {
    let out = String::from_utf8_lossy(stdout);
    let url = out.lines().rev().find(|l| !l.trim().is_empty())?.trim();
    url.rsplit_once("/pull/")?.1.parse().ok()
}

/// Head branch of a pull request, fetched locally so a worktree can use it.
pub async fn pr_head_branch(repo: &Path, number: u64) -> Result<String> {
    let n = number.to_string();
    let out = gh(
        repo,
        &[
            "pr",
            "view",
            &n,
            "--json",
            "headRefName",
            "-q",
            ".headRefName",
        ],
    )
    .await?;
    if String::from_utf8_lossy(&out).trim().is_empty() {
        bail!("pull request #{number} has no head branch");
    }
    // A name in moonlet's own branch namespace: the PR's headRefName may
    // collide with a local branch (fork PRs from `main`), and a plain
    // `pr/<n>` could be the user's own branch.
    let branch = format!("moonlet/pr-{number}");
    let fetched = git(
        repo,
        &["fetch", "origin", &format!("+pull/{number}/head:{branch}")],
    )
    .await;
    if let Err(e) = fetched {
        // Only the "checked out in a worktree" refusal is tolerated (an open
        // session of this PR keeps its branch); a network error or a deleted
        // PR must not silently reuse an old branch.
        let msg = format!("{e:#}");
        if !(msg.contains("checked out") || msg.contains("refusing to fetch into")) {
            return Err(e);
        }
        tracing::warn!("{branch} is checked out in a session; not refreshing it");
    }
    Ok(branch)
}

/// Open issues (`kind = "issue"`) or pull requests (`"pr"`) for the composer.
pub async fn gh_list(repo: &Path, kind: &str) -> Result<Vec<moonlet_proto::types::IssueRef>> {
    let fields = if kind == "pr" {
        "number,title,body,url,headRefName"
    } else {
        "number,title,body,url"
    };
    let sub = if kind == "pr" { "pr" } else { "issue" };
    let out = gh(
        repo,
        &[
            sub, "list", "--state", "open", "--limit", "50", "--json", fields,
        ],
    )
    .await?;
    let v: Vec<serde_json::Value> = serde_json::from_slice(&out)?;
    Ok(v.into_iter()
        .map(|x| moonlet_proto::types::IssueRef {
            number: x["number"].as_u64().unwrap_or(0),
            title: x["title"].as_str().unwrap_or("").into(),
            body: cut_body(&x["body"]),
            url: x["url"].as_str().unwrap_or("").into(),
            head_branch: x["headRefName"].as_str().map(String::from),
        })
        .collect())
}

/// The most a PR's attachment sends (X54): its description, reviews and
/// comments together.
const PR_CONTEXT_MAX: usize = 8000;
/// The most one review or comment adds to it.
const PR_ITEM_MAX: usize = 1000;

/// Whose words a PR's attachment sends: people with a role in the
/// repository. A CONTRIBUTOR is anyone with one merged PR, so not them.
const TRUSTED: [&str; 3] = ["OWNER", "MEMBER", "COLLABORATOR"];

/// `s` trimmed and cut to `max` characters, the ellipsis included.
fn shorten(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>().trim_end())
    }
}

/// The elements of a JSON array, none for anything else.
fn json_items(v: &serde_json::Value) -> impl Iterator<Item = &serde_json::Value> {
    v.as_array().into_iter().flatten()
}

/// A JSON string, empty for anything else.
fn json_str(v: &serde_json::Value) -> &str {
    v.as_str().unwrap_or("")
}

/// What a picked PR's attachment sends (X54): its description, then its
/// reviews (author, state and body), its conversation comments and its
/// comments on lines of code (author, `path:line` and body). The text goes
/// to the agent, so only the PR's author's and those of people with a role
/// in the repository come, and minimised comments don't; a last line says
/// how many were left out. `view` is `gh pr view <n> --json
/// author,body,reviews,comments`, `lines` is `gh api
/// repos/{owner}/{repo}/pulls/<n>/comments`.
pub fn pr_context_text(view: &serde_json::Value, lines: &serde_json::Value) -> String {
    // One item per line, its body's own lines indented under it.
    let item = |head: String, body: &str| -> String {
        let body = shorten(body, PR_ITEM_MAX);
        if body.is_empty() {
            format!("- {head}")
        } else {
            format!("- {head}: {}", body.replace('\n', "\n  "))
        }
    };
    let login = |v: &serde_json::Value| v.as_str().unwrap_or("someone").to_string();
    let author = view["author"]["login"].as_str();
    let left_out = std::cell::Cell::new(0);
    // Whether a review or comment is sent; one that is not counts as left out.
    let sent = |who: &serde_json::Value, association: &serde_json::Value, minimised: bool| {
        let ok = !minimised && ((author.is_some() && who.as_str() == author) || TRUSTED.contains(&json_str(association)));
        if !ok {
            left_out.set(left_out.get() + 1);
        }
        ok
    };
    let mut parts = vec![shorten(json_str(&view["body"]), PR_CONTEXT_MAX)];

    // A review in COMMENTED state with no body only holds line comments,
    // which come below.
    let reviews: Vec<String> = json_items(&view["reviews"])
        .filter_map(|r| {
            let body = json_str(&r["body"]);
            let state = match json_str(&r["state"]) {
                "APPROVED" => "approved",
                "CHANGES_REQUESTED" => "changes requested",
                "DISMISSED" => "dismissed",
                _ if body.trim().is_empty() => return None,
                _ => "commented",
            };
            sent(&r["author"]["login"], &r["authorAssociation"], false).then(|| item(format!("@{}, {state}", login(&r["author"]["login"])), body))
        })
        .collect();
    if !reviews.is_empty() {
        parts.push(format!("Reviews:\n{}", reviews.join("\n")));
    }
    let comments: Vec<String> = json_items(&view["comments"])
        .filter(|c| sent(&c["author"]["login"], &c["authorAssociation"], c["isMinimized"].as_bool().unwrap_or(false)))
        .map(|c| item(format!("@{}", login(&c["author"]["login"])), json_str(&c["body"])))
        .collect();
    if !comments.is_empty() {
        parts.push(format!("Comments:\n{}", comments.join("\n")));
    }
    // An outdated comment has no `line` any more: its `original_line` says
    // where it was.
    let on_lines: Vec<String> = json_items(lines)
        .filter(|c| sent(&c["user"]["login"], &c["author_association"], false))
        .map(|c| {
            let path = json_str(&c["path"]);
            let place = match c["line"].as_u64().or_else(|| c["original_line"].as_u64()) {
                Some(n) => format!("{path}:{n}"),
                None => path.to_string(),
            };
            let reply = if c["in_reply_to_id"].is_u64() { ", replying" } else { "" };
            item(format!("@{} on {place}{reply}", login(&c["user"]["login"])), json_str(&c["body"]))
        })
        .collect();
    if !on_lines.is_empty() {
        parts.push(format!("Review comments:\n{}", on_lines.join("\n")));
    }
    // The count goes last and is never cut off.
    let note = match left_out.get() {
        0 => String::new(),
        1 => "1 review or comment is left out: minimised, or by someone without a role in the repository.".into(),
        n => format!("{n} reviews and comments are left out: minimised, or by people without a role in the repository."),
    };
    let room = PR_CONTEXT_MAX - if note.is_empty() { 0 } else { note.chars().count() + 2 };
    let body = shorten(&parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n"), room);
    [body, note].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n")
}

/// A PR's description, reviews and comments for its attachment (X54).
/// Without its line comments (an old `gh`, a fork) the rest still comes.
pub async fn gh_pr_context(repo: &Path, number: u64) -> Result<String> {
    let n = number.to_string();
    let view = gh(repo, &["pr", "view", &n, "--json", "author,body,reviews,comments"]).await?;
    let view: serde_json::Value = serde_json::from_slice(&view)?;
    let path = format!("repos/{{owner}}/{{repo}}/pulls/{n}/comments?per_page=100");
    let lines = match gh(repo, &["api", &path]).await {
        Ok(out) => serde_json::from_slice(&out).unwrap_or(serde_json::Value::Null),
        Err(e) => {
            tracing::warn!("no line comments for PR #{number}: {e:#}");
            serde_json::Value::Null
        }
    };
    Ok(pr_context_text(&view, &lines))
}

/// An issue or PR body, at most 4000 characters.
fn cut_body(body: &serde_json::Value) -> String {
    body.as_str().unwrap_or("").chars().take(4000).collect()
}

const GH_TASK_FIELDS: &str =
    "number,title,body,url,state,stateReason,assignees,labels,updatedAt,closedByPullRequestsReferences";

/// The repository's issues for Tasks mode (X44): the 100 most recently
/// updated, open and closed, so recently closed ones fill the Done column.
pub async fn gh_tasks(repo: &Path, mine: bool) -> Result<Vec<moonlet_proto::types::GhTask>> {
    let mut args = vec![
        "issue", "list", "--state", "all", "--limit", "100", "--search", "sort:updated-desc",
    ];
    if mine {
        args.extend(["--assignee", "@me"]);
    }
    args.extend(["--json", GH_TASK_FIELDS]);
    parse_gh_tasks(&gh(repo, &args).await?)
}

/// The GitHub login `gh` is signed in as (X44). Fails with gh's own message,
/// such as "please run: gh auth login", when it is not.
pub async fn gh_whoami() -> Result<String> {
    let out = gh(Path::new("/"), &["api", "user", "--jq", ".login"]).await?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Assigns issue `number` to the user, closes it as completed or reopens it (X46).
pub async fn gh_task_update(repo: &Path, number: u64, assign_me: bool, close: bool, reopen: bool) -> Result<()> {
    let n = number.to_string();
    if assign_me {
        gh(repo, &["issue", "edit", &n, "--add-assignee", "@me"]).await?;
    }
    if close {
        gh(repo, &["issue", "close", &n, "--reason", "completed"]).await?;
    }
    if reopen {
        gh(repo, &["issue", "reopen", &n]).await?;
    }
    Ok(())
}

/// `repo` as a GitHub `owner/name`, checked before gh is run with it: it can
/// come from the clipboard or a board's settings.
pub(crate) fn check_repo(repo: &str) -> Result<&str> {
    let part = |s: &str| !s.is_empty() && !s.starts_with(['-', '.']) && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    match repo.split_once('/') {
        Some((owner, name)) if part(owner) && part(name) => Ok(repo),
        _ => anyhow::bail!("{repo} is not a GitHub repository"),
    }
}

/// One issue of `owner/name` by its number, for a key pasted into the link
/// dialog (X46). `repo` comes from the clipboard, so it is checked first.
pub async fn gh_task(dir: &Path, repo: &str, number: u64) -> Result<moonlet_proto::types::GhTask> {
    check_repo(repo)?;
    let n = number.to_string();
    let out = gh(dir, &["issue", "view", &n, "--repo", repo, "--json", GH_TASK_FIELDS]).await?;
    let one: serde_json::Value = serde_json::from_slice(&out)?;
    parse_gh_tasks(serde_json::json!([one]).to_string().as_bytes())?
        .pop()
        .context("gh printed no issue")
}

/// `gh issue list --json <GH_TASK_FIELDS>` as tasks.
pub(crate) fn parse_gh_tasks(raw: &[u8]) -> Result<Vec<moonlet_proto::types::GhTask>> {
    let list: Vec<serde_json::Value> = serde_json::from_slice(raw)?;
    let names = |v: &serde_json::Value, field: &str| -> Vec<String> {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x[field].as_str().map(String::from))
            .collect()
    };
    Ok(list
        .into_iter()
        .map(|x| {
            let url = x["url"].as_str().unwrap_or("").to_string();
            // https://github.com/<owner>/<repo>/issues/<n>
            let repo = match url.split('/').collect::<Vec<_>>()[..] {
                [_, _, _, owner, name, ..] => format!("{owner}/{name}"),
                _ => String::new(),
            };
            let closing_prs = x["closedByPullRequestsReferences"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|pr| {
                    let r = &pr["repository"];
                    // GitHub names compare case-insensitively.
                    format!("{}/{}", r["owner"]["login"].as_str().unwrap_or(""), r["name"].as_str().unwrap_or(""))
                        .eq_ignore_ascii_case(&repo)
                })
                .filter_map(|pr| pr["number"].as_u64())
                .collect();
            moonlet_proto::types::GhTask {
                number: x["number"].as_u64().unwrap_or(0),
                title: x["title"].as_str().unwrap_or("").into(),
                body: cut_body(&x["body"]),
                closed: x["state"].as_str().is_some_and(|s| s.eq_ignore_ascii_case("closed")),
                state_reason: x["stateReason"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_ascii_lowercase),
                assignees: names(&x["assignees"], "login"),
                labels: names(&x["labels"], "name"),
                updated_ms: x["updatedAt"].as_str().and_then(utc_ms).unwrap_or(0),
                closing_prs,
                url,
                repo,
            }
        })
        .collect())
}

/// One `statusCheckRollup` entry as a check run. GitHub Actions report a
/// `CheckRun` (`status` + `conclusion`); bots like CodeRabbit post a commit
/// status (`StatusContext`) with only a `state`, so a finished state maps to
/// `completed` plus that state as the conclusion.
fn check_run(c: &serde_json::Value) -> CheckRun {
    let lower = |key: &str| {
        c[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase())
    };
    let (status, conclusion) = match lower("state") {
        Some(state) if c["status"].is_null() => match state.as_str() {
            "pending" | "expected" => (state, None),
            _ => ("completed".to_string(), Some(state)),
        },
        _ => (lower("status").unwrap_or_default(), lower("conclusion")),
    };
    CheckRun {
        name: c["name"]
            .as_str()
            .or(c["context"].as_str())
            .unwrap_or("check")
            .into(),
        status,
        conclusion,
        url: c["detailsUrl"]
            .as_str()
            .or(c["targetUrl"].as_str())
            .filter(|s| !s.is_empty())
            .map(String::from),
    }
}

/// The PR whose head is the checked-out branch: the newest one with that
/// branch name, so possibly one from an earlier branch of the same name.
/// Sessions use [`pr_view`] and [`session_pr`] instead.
pub async fn pr_status(path: &Path) -> Result<Option<PullRequest>> {
    pr_view(path, None).await
}

/// PR `number`, or the checked-out branch's PR when `None`.
pub async fn pr_view(path: &Path, number: Option<u64>) -> Result<Option<PullRequest>> {
    let root = toplevel(path).await?;
    let n = number.map(|n| n.to_string());
    let mut args = vec!["pr", "view"];
    args.extend(n.as_deref());
    args.extend(["--json", PR_FIELDS]);
    let out = run_raw("gh", &root, &args, None, Duration::from_secs(60)).await?;
    if out.status != 0 {
        if out.stderr.contains("no pull requests found") {
            return Ok(None);
        }
        bail!("gh pr view: {}", out.stderr);
    }
    Ok(Some(parse_pr(&serde_json::from_slice(&out.stdout)?)))
}

/// Every PR, in any state, whose head branch is named `branch`.
pub async fn pr_list_head(path: &Path, branch: &str) -> Result<serde_json::Value> {
    let root = toplevel(path).await?;
    let out = gh(
        &root,
        &[
            "pr", "list", "--head", branch, "--state", "all", "--limit", "20", "--json",
            PR_FIELDS,
        ],
    )
    .await?;
    Ok(serde_json::from_slice(&out)?)
}

/// Fields `parse_pr` reads, plus `createdAt` for `session_pr`.
const PR_FIELDS: &str = "number,url,state,title,isDraft,reviewDecision,statusCheckRollup,headRefOid,createdAt";

/// Maps one PR object from `gh pr view` or `gh pr list`.
fn parse_pr(v: &serde_json::Value) -> PullRequest {
    let checks = v["statusCheckRollup"]
        .as_array()
        .into_iter()
        .flatten()
        .map(check_run)
        .collect();
    PullRequest {
        number: v["number"].as_u64().unwrap_or(0),
        url: v["url"].as_str().unwrap_or("").into(),
        state: v["state"].as_str().unwrap_or("").to_lowercase(),
        title: v["title"].as_str().unwrap_or("").into(),
        checks,
        review_decision: v["reviewDecision"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(String::from),
        draft: v["isDraft"].as_bool().unwrap_or(false),
        head_oid: v["headRefOid"].as_str().filter(|s| !s.is_empty()).map(String::from),
    }
}

/// Picks a session's PR from [`pr_list_head`] output. Branch names get
/// reused, so a PR counts only when it is open (a push would update it) or
/// was created after the session (`since_ms`); an older closed or merged one
/// belongs to an earlier branch of the same name. Only numbers above `after`
/// count; the newest wins.
pub fn session_pr(list: &serde_json::Value, since_ms: u64, after: u64) -> Option<PullRequest> {
    list.as_array()?
        .iter()
        .filter(|v| {
            v["state"].as_str().is_some_and(|s| s.eq_ignore_ascii_case("open"))
                || v["createdAt"]
                    .as_str()
                    .and_then(utc_ms)
                    .is_some_and(|t| t >= since_ms)
        })
        .map(parse_pr)
        .filter(|pr| pr.number > after)
        .max_by_key(|pr| pr.number)
}

/// Milliseconds since the epoch for a `YYYY-MM-DDTHH:MM:SSZ` timestamp.
fn utc_ms(s: &str) -> Option<u64> {
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    if s.len() != 20 || !s.ends_with('Z') {
        return None;
    }
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    // Days from 1970-01-01 to the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(((days * 24 + hh) * 60 + mm) * 60 + ss).ok().map(|t| t * 1000)
}

/// The GitHub stack PR `number` belongs to, or `None` when it is not stacked.
pub async fn pr_stack(path: &Path, number: u64) -> Result<Option<PrStack>> {
    let root = toplevel(path).await?;
    let pull = format!("repos/{{owner}}/{{repo}}/pulls/{number}");
    let out = gh(&root, &["api", &pull, "--jq", ".stack.number // empty"]).await?;
    let stack = String::from_utf8_lossy(&out).trim().to_string();
    if stack.is_empty() {
        return Ok(None);
    }
    let stack: u64 = stack.parse().context("stack number")?;
    let out = gh(
        &root,
        &["api", &format!("repos/{{owner}}/{{repo}}/stacks/{stack}")],
    )
    .await?;
    Ok(parse_stack(&serde_json::from_slice(&out)?, number))
}

/// Maps a `GET /repos/{owner}/{repo}/stacks/{number}` response.
fn parse_stack(v: &serde_json::Value, current: u64) -> Option<PrStack> {
    let prs: Vec<StackPr> = v["pull_requests"]
        .as_array()?
        .iter()
        .map(|p| StackPr {
            number: p["number"].as_u64().unwrap_or(0),
            title: p["title"].as_str().unwrap_or("").into(),
            url: p["html_url"].as_str().unwrap_or("").into(),
            state: if !p["merged_at"].is_null() {
                "merged".into()
            } else {
                p["state"].as_str().unwrap_or("").to_lowercase()
            },
            draft: p["draft"].as_bool().unwrap_or(false),
            branch: p["head"]["ref"].as_str().unwrap_or("").into(),
        })
        .collect();
    let position = prs.iter().position(|p| p.number == current)? as u64 + 1;
    Some(PrStack {
        number: v["number"].as_u64().unwrap_or(0),
        base: v["base"]["ref"].as_str().unwrap_or("").into(),
        position,
        size: prs.len() as u64,
        prs,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[tokio::test]
    async fn a_long_input_and_a_long_answer_never_wait_on_each_other() {
        // `cat-file --batch-check` answers each line as it reads it: with
        // input and output both past a pipe's buffer, writing all of the
        // input before reading any output would wait forever.
        let dir = repo().await;
        let p = dir.path();
        std::fs::write(p.join("f"), "x").unwrap();
        let blob = git_text(p, &["hash-object", "-w", "f"]).await.unwrap();
        let input: Vec<u8> = format!("{blob}\n").repeat(20_000).into_bytes();
        let out = tokio::time::timeout(
            Duration::from_secs(30),
            run_raw_env(
                "git",
                p,
                &["cat-file", "--batch-check"],
                &[],
                Some(&input),
                Duration::from_secs(20),
            ),
        )
        .await
        .expect("git and its input waited on each other")
        .unwrap();
        assert_eq!(out.status, 0);
        assert_eq!(out.stdout.iter().filter(|b| **b == b'\n').count(), 20_000);
    }

    pub async fn repo() -> tempfile::TempDir {
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
        std::fs::write(p.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(p.join("old.md"), "# Title\n\nbody\n").unwrap();
        git(p, &["add", "-A"]).await.unwrap();
        git(p, &["commit", "-q", "-m", "init"]).await.unwrap();
        dir
    }

    #[tokio::test]
    async fn status_against_head_and_base() {
        let dir = repo().await;
        let p = dir.path();
        git(p, &["checkout", "-q", "-b", "feature"]).await.unwrap();
        std::fs::write(p.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
        git(p, &["commit", "-qam", "edit a"]).await.unwrap();
        git(p, &["mv", "old.md", "new.md"]).await.unwrap();
        std::fs::write(p.join("untracked.txt"), "x\ny\n").unwrap();
        std::fs::write(p.join("bin.dat"), [0u8, 1, 2]).unwrap();

        let head = status(p, None).await.unwrap();
        assert_eq!(head.branch.as_deref(), Some("feature"));
        let paths: Vec<_> = head
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str()))
            .collect();
        assert_eq!(
            paths,
            vec![
                ("bin.dat", "untracked"),
                ("new.md", "renamed"),
                ("untracked.txt", "untracked")
            ]
        );
        let renamed = head.files.iter().find(|f| f.path == "new.md").unwrap();
        assert_eq!(renamed.old_path.as_deref(), Some("old.md"));
        assert!(renamed.staged);
        assert!(
            head.files
                .iter()
                .find(|f| f.path == "bin.dat")
                .unwrap()
                .binary
        );
        assert_eq!(
            head.files
                .iter()
                .find(|f| f.path == "untracked.txt")
                .unwrap()
                .additions,
            2
        );

        let vs_main = status(p, Some("main")).await.unwrap();
        let a = vs_main
            .files
            .iter()
            .find(|f| f.path == "a.txt")
            .expect("committed change visible against base");
        assert_eq!((a.additions, a.deletions), (2, 1));
        assert_ne!(vs_main.against, "HEAD");
        assert!(vs_main.base_missing.is_none());
        let typo = status(p, Some("mian")).await.unwrap();
        assert_eq!(typo.against, "HEAD");
        assert_eq!(typo.base_missing.as_deref(), Some("mian"));
    }

    #[tokio::test]
    async fn versions_diff_stage_revert_commit() {
        let dir = repo().await;
        let p = dir.path();
        std::fs::write(p.join("a.txt"), "one\n2\nthree\n").unwrap();
        let v = file_versions(p, "a.txt", None, false).await.unwrap();
        assert_eq!(v.original.as_deref(), Some("one\ntwo\nthree\n"));
        assert_eq!(v.modified.as_deref(), Some("one\n2\nthree\n"));

        let d = diff(p, "a.txt", None, false).await.unwrap();
        assert!(d.contains("-two") && d.contains("+2"));

        // Stage the hunk via a patch, then unstage, then stage the file.
        apply_patch(p, &d, true, false).await.unwrap();
        assert!(status(p, None).await.unwrap().files[0].staged);
        unstage(p, &["a.txt".into()]).await.unwrap();
        assert!(!status(p, None).await.unwrap().files[0].staged);
        stage(p, &["a.txt".into()]).await.unwrap();
        let sha = commit(p, "change two", false).await.unwrap();
        assert_eq!(sha.len(), 40);
        assert_eq!(log(p, None).await.unwrap()[0].subject, "change two");

        std::fs::write(p.join("a.txt"), "garbage\n").unwrap();
        std::fs::write(p.join("new.txt"), "n\n").unwrap();
        revert(p, &["a.txt".into(), "new.txt".into()])
            .await
            .unwrap();
        assert!(status(p, None).await.unwrap().files.is_empty());

        let untracked = {
            std::fs::write(p.join("u.txt"), "hello\n").unwrap();
            diff(p, "u.txt", None, false).await.unwrap()
        };
        assert!(untracked.contains("+hello"));
        assert!(diff(p, "../etc/passwd", None, false).await.is_err());
    }

    #[tokio::test]
    async fn fetching_a_branch_named_like_an_option_runs_nothing() {
        let dir = repo().await;
        let p = dir.path();
        let origin = tempfile::tempdir().unwrap();
        git(origin.path(), &["init", "-q", "--bare"]).await.unwrap();
        git(p, &["remote", "add", "origin", origin.path().to_str().unwrap()])
            .await
            .unwrap();
        let marker = origin.path().join("ran");
        let branch = format!("--upload-pack=touch {};git-upload-pack", marker.display());
        assert!(fetch_branch(p, &branch).await.is_err());
        assert!(!marker.exists(), "the branch name ran a command");
    }

    #[test]
    fn short_status_gives_a_letter_per_file() {
        // `git status --porcelain=v1 -z --untracked-files=all`, captured.
        let out = " M a.txt\0R  c.txt\0b.txt\0A  staged.ts\0?? src/new.ts\0";
        let files: Vec<_> = parse_short_status(out).into_iter().map(|f| (f.status, f.path)).collect();
        assert_eq!(
            files,
            [("M", "a.txt"), ("R", "c.txt"), ("A", "staged.ts"), ("?", "src/new.ts")].map(|(s, p)| (s.to_string(), p.to_string()))
        );
    }

    #[tokio::test]
    async fn unpushed_work_counts_files_and_commits_ahead_of_the_upstream() {
        let dir = repo().await;
        let p = dir.path();
        let origin = tempfile::tempdir().unwrap();
        git(origin.path(), &["init", "-q", "--bare"]).await.unwrap();
        git(p, &["remote", "add", "origin", origin.path().to_str().unwrap()]).await.unwrap();
        git(p, &["checkout", "-q", "-b", "moonlet/fix"]).await.unwrap();
        git(p, &["push", "-q", "-u", "origin", "HEAD"]).await.unwrap();
        for n in ["one", "two"] {
            git(p, &["commit", "-q", "--allow-empty", "-m", n]).await.unwrap();
        }
        std::fs::write(p.join("a.txt"), "changed\n").unwrap();
        std::fs::write(p.join("new.ts"), "n\n").unwrap();
        let w = unpushed(p, None, None).await.unwrap();
        assert_eq!(w.commits, 2);
        assert_eq!(w.upstream.as_deref(), Some("origin/moonlet/fix"));
        let files: Vec<_> = w.files.iter().map(|f| (f.status.as_str(), f.path.as_str())).collect();
        assert_eq!(files, [("M", "a.txt"), ("?", "new.ts")]);

        push(p, None, None).await.unwrap();
        assert_eq!(unpushed(p, None, None).await.unwrap().commits, 0);
    }

    #[tokio::test]
    async fn without_an_upstream_commits_on_no_other_branch_are_unpushed() {
        let dir = repo().await;
        let p = dir.path();
        git(p, &["checkout", "-q", "-b", "moonlet/new"]).await.unwrap();
        git(p, &["commit", "-q", "--allow-empty", "-m", "mine"]).await.unwrap();
        let w = unpushed(p, None, None).await.unwrap();
        assert_eq!((w.commits, w.upstream, w.files.len()), (1, None, 0));
    }

    #[tokio::test]
    async fn commits_on_a_branch_the_worktree_moved_to_are_not_lost() {
        // An agent checked out another branch in the session's worktree:
        // archiving deletes the session's branch, the other one stays.
        let dir = repo().await;
        let p = dir.path();
        git(p, &["checkout", "-q", "-b", "moonlet/session"]).await.unwrap();
        git(p, &["checkout", "-q", "-b", "refactor/lint"]).await.unwrap();
        git(p, &["commit", "-q", "--allow-empty", "-m", "lint"]).await.unwrap();
        let w = unpushed(p, Some("moonlet/session"), None).await.unwrap();
        assert_eq!((w.commits, w.upstream), (0, None));
    }

    #[tokio::test]
    async fn the_session_branch_is_read_when_another_is_checked_out() {
        let dir = repo().await;
        let p = dir.path();
        let origin = tempfile::tempdir().unwrap();
        git(origin.path(), &["init", "-q", "--bare"]).await.unwrap();
        git(p, &["remote", "add", "origin", origin.path().to_str().unwrap()]).await.unwrap();
        git(p, &["checkout", "-q", "-b", "moonlet/session"]).await.unwrap();
        git(p, &["push", "-q", "-u", "origin", "HEAD"]).await.unwrap();
        git(p, &["commit", "-q", "--allow-empty", "-m", "mine"]).await.unwrap();
        git(p, &["checkout", "-q", "main"]).await.unwrap();
        let w = unpushed(p, Some("moonlet/session"), None).await.unwrap();
        assert_eq!((w.commits, w.upstream.as_deref()), (1, Some("origin/moonlet/session")));
        // A branch git does not know reads as none: only the checked-out one counts.
        assert_eq!(unpushed(p, Some("--output=x"), None).await.unwrap().commits, 0);
    }

    #[tokio::test]
    async fn a_squash_merged_prs_commits_are_not_lost() {
        // GitHub squashed the PR into main and deleted its branch, so its
        // commits are on no remote, but GitHub keeps the PR's head.
        let dir = repo().await;
        let p = dir.path();
        git(p, &["checkout", "-q", "-b", "moonlet/session"]).await.unwrap();
        for n in ["one", "two"] {
            git(p, &["commit", "-q", "--allow-empty", "-m", n]).await.unwrap();
        }
        let head = git_text(p, &["rev-parse", "HEAD"]).await.unwrap();
        git(p, &["commit", "-q", "--allow-empty", "-m", "after the merge"]).await.unwrap();
        assert_eq!(unpushed(p, Some("moonlet/session"), None).await.unwrap().commits, 3);
        assert_eq!(unpushed(p, Some("moonlet/session"), Some(&head)).await.unwrap().commits, 1);
        // A head this clone never had, or not a commit id, changes nothing.
        let unknown = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(unpushed(p, Some("moonlet/session"), Some(unknown)).await.unwrap().commits, 3);
        assert_eq!(unpushed(p, Some("moonlet/session"), Some("--all")).await.unwrap().commits, 3);
    }

    #[tokio::test]
    async fn push_sends_the_session_branch_not_the_checked_out_one() {
        let dir = repo().await;
        let p = dir.path();
        let origin = tempfile::tempdir().unwrap();
        git(origin.path(), &["init", "-q", "--bare"]).await.unwrap();
        git(p, &["remote", "add", "origin", origin.path().to_str().unwrap()]).await.unwrap();
        git(p, &["checkout", "-q", "-b", "moonlet/session"]).await.unwrap();
        git(p, &["commit", "-q", "--allow-empty", "-m", "mine"]).await.unwrap();
        git(p, &["checkout", "-q", "-b", "refactor/lint"]).await.unwrap();
        push(p, Some("moonlet/session"), None).await.unwrap();
        let heads = git_text(origin.path(), &["for-each-ref", "--format=%(refname)", "refs/heads"]).await.unwrap();
        assert_eq!(heads, "refs/heads/moonlet/session");
        let w = unpushed(p, Some("moonlet/session"), None).await.unwrap();
        assert_eq!((w.commits, w.upstream.as_deref()), (0, Some("origin/moonlet/session")));
    }

    #[tokio::test]
    async fn a_branch_named_like_an_option_is_not_passed_to_git() {
        // `git update-ref` makes such a branch; `git branch` would refuse it.
        let dir = repo().await;
        let p = dir.path();
        let origin = tempfile::tempdir().unwrap();
        git(origin.path(), &["init", "-q", "--bare"]).await.unwrap();
        git(p, &["remote", "add", "origin", origin.path().to_str().unwrap()]).await.unwrap();
        let bad = "--receive-pack=false";
        git(p, &["update-ref", &format!("refs/heads/{bad}"), "HEAD"]).await.unwrap();
        push(p, Some(bad), None).await.unwrap();
        let heads = git_text(origin.path(), &["for-each-ref", "--format=%(refname)", "refs/heads"]).await.unwrap();
        assert_eq!(heads, "refs/heads/main");
        let w = unpushed(p, Some("--all"), None).await;
        assert_eq!(w.unwrap().commits, 0);
    }

    #[tokio::test]
    async fn push_refuses_while_a_detached_head_has_commits_of_its_own() {
        // Pushing the session's branch would not save them, and the archive
        // after it removes the folder.
        let dir = repo().await;
        let p = dir.path();
        let origin = tempfile::tempdir().unwrap();
        git(origin.path(), &["init", "-q", "--bare"]).await.unwrap();
        git(p, &["remote", "add", "origin", origin.path().to_str().unwrap()]).await.unwrap();
        git(p, &["checkout", "-q", "-b", "moonlet/session"]).await.unwrap();
        git(p, &["checkout", "-q", "--detach"]).await.unwrap();
        git(p, &["commit", "-q", "--allow-empty", "-m", "detached"]).await.unwrap();
        assert_eq!(unpushed(p, Some("moonlet/session"), None).await.unwrap().commits, 1);
        let err = push(p, Some("moonlet/session"), None).await.unwrap_err();
        assert_eq!(err.to_string(), "1 commit on a detached HEAD is on no branch. Put it on a branch first.");
        let heads = git_text(origin.path(), &["for-each-ref", "--format=%(refname)", "refs/heads"]).await.unwrap();
        assert_eq!(heads, "");
    }

    #[tokio::test]
    async fn the_checked_out_branch_is_read_when_a_tag_shares_its_name() {
        // An older app sends no branch. `symbolic-ref --short` then reads
        // `heads/fix`, which is not the branch's name.
        let dir = repo().await;
        let p = dir.path();
        git(p, &["tag", "fix"]).await.unwrap();
        git(p, &["checkout", "-q", "-b", "fix"]).await.unwrap();
        git(p, &["commit", "-q", "--allow-empty", "-m", "mine"]).await.unwrap();
        assert_eq!(unpushed(p, None, None).await.unwrap().commits, 1);
    }

    #[tokio::test]
    async fn push_lets_a_detached_head_at_the_merged_prs_head_go() {
        // GitHub keeps the merged PR's head, so the push need not save it.
        let dir = repo().await;
        let p = dir.path();
        let origin = tempfile::tempdir().unwrap();
        git(origin.path(), &["init", "-q", "--bare"]).await.unwrap();
        git(p, &["remote", "add", "origin", origin.path().to_str().unwrap()]).await.unwrap();
        git(p, &["branch", "moonlet/session"]).await.unwrap();
        git(p, &["checkout", "-q", "--detach"]).await.unwrap();
        git(p, &["commit", "-q", "--allow-empty", "-m", "merged as #12"]).await.unwrap();
        let head = git_text(p, &["rev-parse", "HEAD"]).await.unwrap();
        push(p, Some("moonlet/session"), Some(&head)).await.unwrap();
        let heads = git_text(origin.path(), &["for-each-ref", "--format=%(refname)", "refs/heads"]).await.unwrap();
        assert_eq!(heads, "refs/heads/moonlet/session");
    }

    #[tokio::test]
    async fn worktrees_and_branches() {
        let dir = repo().await;
        let p = dir.path();
        assert_eq!(default_branch(p).await, "main");
        let wt = tempfile::tempdir().unwrap();
        let target = wt.path().join("ws");
        worktree_add(p, &target, "moonlet/fix-bug", "main", false)
            .await
            .unwrap();
        assert!(target.join("a.txt").exists());
        assert!(
            branches(p)
                .await
                .unwrap()
                .contains(&"moonlet/fix-bug".to_string())
        );
        worktree_remove(p, &target).await.unwrap();
        assert!(!target.exists());
        delete_branch(p, "moonlet/fix-bug").await.unwrap();
    }

    #[tokio::test]
    async fn fresh_repo_without_commits() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]).await.unwrap();
        std::fs::write(dir.path().join("f"), "x\n").unwrap();
        let st = status(dir.path(), Some("main")).await.unwrap();
        assert_eq!(st.files.len(), 1);
        assert_eq!(st.against, EMPTY_TREE);
    }

    #[tokio::test]
    async fn origin_url_of_a_project() {
        let dir = repo().await;
        assert_eq!(origin_url(dir.path()).await, None);
        git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                "git@github.com:1devstudio/jaunt.git",
            ],
        )
        .await
        .unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        assert_eq!(
            origin_url(&dir.path().join("sub")).await.as_deref(),
            Some("git@github.com:1devstudio/jaunt.git")
        );
    }

    /// A bare `origin`, a clone of it (the project) and a second clone
    /// standing in for GitHub merges.
    struct Remote {
        _dir: tempfile::TempDir,
        local: PathBuf,
        other: PathBuf,
    }

    async fn remote() -> Remote {
        let seed = repo().await;
        let dir = tempfile::tempdir().unwrap();
        let origin = dir.path().join("origin.git");
        let (local, other) = (dir.path().join("local"), dir.path().join("other"));
        let s = |p: &Path| p.display().to_string();
        git(
            dir.path(),
            &["clone", "-q", "--bare", &s(seed.path()), &s(&origin)],
        )
        .await
        .unwrap();
        for clone in [&local, &other] {
            git(dir.path(), &["clone", "-q", &s(&origin), &s(clone)])
                .await
                .unwrap();
            for args in [
                ["config", "user.email", "t@example.com"],
                ["config", "user.name", "Test"],
                ["config", "commit.gpgsign", "false"],
            ] {
                git(clone, &args).await.unwrap();
            }
        }
        Remote {
            _dir: dir,
            local,
            other,
        }
    }

    async fn commit_file(repo: &Path, file: &str, subject: &str) {
        std::fs::write(repo.join(file), subject).unwrap();
        git(repo, &["add", "-A"]).await.unwrap();
        git(repo, &["commit", "-qm", subject]).await.unwrap();
    }

    /// "Merges on GitHub": commits pushed to origin from the other clone.
    async fn merge_upstream(r: &Remote, subjects: &[&str]) {
        for (i, subject) in subjects.iter().enumerate() {
            commit_file(&r.other, &format!("up{i}.txt"), subject).await;
        }
        git(&r.other, &["push", "-q", "origin", "main"])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn base_behind_origin_lists_incoming_commits_after_fetch() {
        let r = remote().await;
        merge_upstream(&r, &["Open sessions from PRs", "Show PR state"]).await;

        let before = base_status(&r.local, "main", false).await.unwrap().unwrap();
        assert_eq!((before.ahead, before.behind), (0, 0));

        let st = base_status(&r.local, "main", true).await.unwrap().unwrap();
        assert_eq!(st.branch, "main");
        assert_eq!(st.upstream, "origin/main");
        assert_eq!((st.ahead, st.behind), (0, 2));
        let subjects: Vec<_> = st.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["Show PR state", "Open sessions from PRs"]);
        assert_eq!(st.commits[0].sha.len(), 40);
        assert_eq!(st.fetch_error, None);
    }

    #[tokio::test]
    async fn base_without_origin_branch_is_none_and_failed_fetch_is_reported() {
        let alone = repo().await;
        assert_eq!(base_status(alone.path(), "main", true).await.unwrap(), None);

        let r = remote().await;
        assert_eq!(base_status(&r.local, "develop", false).await.unwrap(), None);

        git(
            &r.local,
            &["remote", "set-url", "origin", "/nonexistent/origin.git"],
        )
        .await
        .unwrap();
        let st = base_status(&r.local, "main", true).await.unwrap().unwrap();
        assert_eq!((st.ahead, st.behind), (0, 0));
        assert!(st.fetch_error.unwrap().contains("/nonexistent/origin.git"));
    }

    #[tokio::test]
    async fn base_reports_divergence_checkout_and_rejects_option_like_names() {
        let r = remote().await;
        merge_upstream(&r, &["upstream one", "upstream two"]).await;
        commit_file(&r.local, "mine.txt", "local only").await;

        let st = base_status(&r.local, "main", true).await.unwrap().unwrap();
        assert_eq!((st.ahead, st.behind), (1, 2));
        let root = toplevel(&r.local).await.unwrap().display().to_string();
        assert_eq!(st.checkout.as_deref(), Some(root.as_str()));

        git(&r.local, &["checkout", "-q", "-b", "feature"])
            .await
            .unwrap();
        let st = base_status(&r.local, "main", false).await.unwrap().unwrap();
        assert_eq!(st.checkout, None);

        assert!(
            base_status(&r.local, "--upload-pack=touch x", false)
                .await
                .is_err()
        );
        assert!(base_status(&r.local, "a..b", false).await.is_err());
    }

    #[tokio::test]
    async fn pull_fast_forwards_the_checked_out_base_and_its_files() {
        let r = remote().await;
        merge_upstream(&r, &["upstream one", "upstream two"]).await;
        base_status(&r.local, "main", true).await.unwrap();
        let tip = git_text(&r.other, &["rev-parse", "HEAD"]).await.unwrap();

        let pulled = pull_base(&r.local, "main").await.unwrap();
        assert_eq!(
            pulled,
            BasePull {
                pulled: 2,
                head: tip.clone()
            }
        );
        assert_eq!(
            git_text(&r.local, &["rev-parse", "main"]).await.unwrap(),
            tip
        );
        assert!(r.local.join("up1.txt").exists());
        let st = base_status(&r.local, "main", false).await.unwrap().unwrap();
        assert_eq!((st.ahead, st.behind), (0, 0));

        let again = pull_base(&r.local, "main").await.unwrap();
        assert_eq!(
            again,
            BasePull {
                pulled: 0,
                head: tip
            }
        );
    }

    #[tokio::test]
    async fn pull_moves_a_base_branch_nobody_has_checked_out() {
        let r = remote().await;
        git(&r.local, &["checkout", "-q", "-b", "feature"])
            .await
            .unwrap();
        merge_upstream(&r, &["upstream one"]).await;
        base_status(&r.local, "main", true).await.unwrap();
        let tip = git_text(&r.other, &["rev-parse", "HEAD"]).await.unwrap();

        assert_eq!(pull_base(&r.local, "main").await.unwrap().pulled, 1);
        assert_eq!(
            git_text(&r.local, &["rev-parse", "main"]).await.unwrap(),
            tip
        );
        assert_eq!(
            git_text(&r.local, &["branch", "--show-current"])
                .await
                .unwrap(),
            "feature"
        );
        assert!(!r.local.join("up0.txt").exists());
    }

    #[tokio::test]
    async fn pull_refuses_a_diverged_base_and_changes_nothing() {
        let r = remote().await;
        merge_upstream(&r, &["upstream one"]).await;
        commit_file(&r.local, "mine.txt", "local only").await;
        base_status(&r.local, "main", true).await.unwrap();
        let mine = git_text(&r.local, &["rev-parse", "main"]).await.unwrap();

        let err = pull_base(&r.local, "main").await.unwrap_err().to_string();
        assert!(err.contains("cannot fast-forward"), "{err}");
        assert_eq!(
            git_text(&r.local, &["rev-parse", "main"]).await.unwrap(),
            mine
        );
    }

    #[test]
    fn worktree_with_branch_from_porcelain() {
        // `git worktree list --porcelain` from a moonlet checkout, 2026-10-04.
        let raw = "worktree /Users/me/Workspace/1devstudio/jaunt\n\
                   HEAD d2cbd2fff7abb00070689f3f1d54b872935ff77b\n\
                   branch refs/heads/main\n\
                   \n\
                   worktree /private/tmp/jaunt-vcheck/home/worktrees/moonlet/test\n\
                   HEAD 449191af3cf6b19bc796d73c10ad8d3f23248210\n\
                   branch refs/heads/moonlet/test\n\
                   prunable gitdir file points to non-existent location\n\
                   \n\
                   worktree /Users/me/.moonlet/worktrees/moonlet/analyze-the-design\n\
                   HEAD d2cbd2fff7abb00070689f3f1d54b872935ff77b\n\
                   branch refs/heads/moonlet/analyze-the-design\n";
        assert_eq!(
            checkout_of(raw, "main").as_deref(),
            Some("/Users/me/Workspace/1devstudio/jaunt")
        );
        assert_eq!(
            checkout_of(raw, "moonlet/analyze-the-design").as_deref(),
            Some("/Users/me/.moonlet/worktrees/moonlet/analyze-the-design")
        );
        // Its directory is gone, so nothing can be merged there.
        assert_eq!(checkout_of(raw, "moonlet/test"), None);
        assert_eq!(checkout_of(raw, "develop"), None);
    }

    #[test]
    fn linked_worktrees_from_porcelain() {
        // `git worktree list --porcelain` with a branch and a detached
        // worktree, captured 2026-10-14, with the prunable entry of the test
        // above spliced in.
        let raw = "worktree /private/tmp/wtcap/r\n\
                   HEAD a406ac3cb27e5460ee0336e4d8c3b2dc61566194\n\
                   branch refs/heads/main\n\
                   \n\
                   worktree /private/tmp/wtcap/detached\n\
                   HEAD a406ac3cb27e5460ee0336e4d8c3b2dc61566194\n\
                   detached\n\
                   \n\
                   worktree /private/tmp/moonlet-vcheck/home/worktrees/moonlet/test\n\
                   HEAD 449191af3cf6b19bc796d73c10ad8d3f23248210\n\
                   branch refs/heads/moonlet/test\n\
                   prunable gitdir file points to non-existent location\n\
                   \n\
                   worktree /private/tmp/wtcap/moon-149-host-health\n\
                   HEAD a406ac3cb27e5460ee0336e4d8c3b2dc61566194\n\
                   branch refs/heads/moon-149-host-health\n";
        assert_eq!(
            linked_worktrees(raw),
            vec![
                ("/private/tmp/wtcap/detached".to_string(), None),
                (
                    "/private/tmp/wtcap/moon-149-host-health".to_string(),
                    Some("moon-149-host-health".to_string())
                ),
            ]
        );
    }

    #[test]
    fn pr_context_holds_its_description_reviews_and_comments() {
        // Only the PR's author (sam-rivera) and people with a role in the
        // repository (MEMBER) are sent: review-bot, alex-kim and lee-moreno
        // are CONTRIBUTORs, whom anyone can become with one merged PR.
        // `gh pr view <n> --json author,body,reviews,comments` and `gh api
        // repos/{owner}/{repo}/pulls/<n>/comments` on cli/cli, 2026-10-19,
        // sanitised (tests/fixtures/README.md).
        let view: serde_json::Value = serde_json::from_slice(include_bytes!("../tests/fixtures/gh-pr-view.json")).unwrap();
        let lines: serde_json::Value = serde_json::from_slice(include_bytes!("../tests/fixtures/gh-pr-review-comments.json")).unwrap();
        assert_eq!(
            pr_context_text(&view, &lines),
            "Drops A/B Testing and Security from the side nav.\n\nFixes #279.\n\n\
             Reviews:\n\
             - @jo-park, changes requested: Keep Security in the nav for admins.\n\n\
             Comments:\n\
             - @jo-park: Does this also drop the A/B Testing route, or only its menu item?\n\
             - @sam-rivera: Only the item; the route goes in a follow-up.\n\n\
             Review comments:\n\
             - @sam-rivera on src/nav/SideNav.tsx:121, replying: Done in the next commit.\n\n\
             3 reviews and comments are left out: minimised, or by people without a role in the repository."
        );
    }

    #[test]
    fn pr_context_keeps_its_left_out_line_when_cut() {
        let view = serde_json::json!({
            "author": {"login": "sam-rivera"},
            "body": "x".repeat(9000),
            "reviews": [],
            "comments": [{"author": {"login": "drive-by"}, "authorAssociation": "NONE", "body": "Run this script first."}],
        });
        let text = pr_context_text(&view, &serde_json::Value::Null);
        assert!(text.ends_with("…\n\n1 review or comment is left out: minimised, or by someone without a role in the repository."), "{}", &text[text.len() - 120..]);
        assert!(text.chars().count() <= 8000, "{}", text.chars().count());
    }

    #[test]
    fn pr_context_counts_a_minimised_comment_as_left_out() {
        let view = serde_json::json!({
            "author": {"login": "sam-rivera"},
            "body": "Fixes #279.",
            "reviews": [],
            "comments": [{"author": {"login": "jo-park"}, "authorAssociation": "MEMBER", "isMinimized": true, "body": "Off topic."}],
        });
        assert_eq!(
            pr_context_text(&view, &serde_json::Value::Null),
            "Fixes #279.\n\n1 review or comment is left out: minimised, or by someone without a role in the repository."
        );
    }

    #[test]
    fn pr_context_without_line_comments_or_reviews_is_its_description() {
        let view = serde_json::json!({"body": "Fixes #279.", "reviews": [], "comments": []});
        assert_eq!(pr_context_text(&view, &serde_json::Value::Null), "Fixes #279.");
    }

    #[test]
    fn github_issues_as_tasks() {
        use moonlet_proto::types::GhTask;
        // `gh issue list --state all --limit 100 --search sort:updated-desc
        // --json <GH_TASK_FIELDS>` on cli/cli, 2026-10-14; people, bodies and
        // a spam title replaced.
        let raw = include_bytes!("../tests/fixtures/gh-issue-list.json");
        let tasks = parse_gh_tasks(raw).unwrap();
        assert_eq!(tasks.len(), 4);
        assert_eq!(
            tasks[0],
            GhTask {
                repo: "cli/cli".into(),
                number: 13876,
                title: "`gh skill install` can't find skills when there's no `skills/` directory but the `SKILL.md` files are nested".into(),
                body: "### Describe the bug\n\n`gh skill install` fails with `no skills found` for a repo that has no `skills/` directory and keeps its `SKILL.md` files in nested subdirectories like `<category>/<skill>/SKILL.md`.\n\n[android/skills](https://github.com/android/skills) is a public example. \nIts skills live unde".into(),
                url: "https://github.com/cli/cli/issues/13876".into(),
                closed: false,
                state_reason: None,
                assignees: vec!["sam-rivera".into()],
                labels: vec!["bug".into(), "priority-3".into(), "stale".into(), "gh-skill".into()],
                updated_ms: 1_789_528_295_000,
                closing_prs: vec![13894],
            }
        );
        assert_eq!((tasks[1].closed, tasks[1].assignees.len()), (false, 0));
        assert_eq!(
            (tasks[2].closed, tasks[2].state_reason.as_deref(), tasks[2].closing_prs.clone()),
            (true, Some("completed"), vec![14516])
        );
        assert_eq!((tasks[3].closed, tasks[3].state_reason.as_deref()), (true, Some("not_planned")));
    }

    #[test]
    fn only_pull_requests_of_the_issues_own_repository_close_it() {
        // Hand-written in the shape of the captured fixture above: a closing
        // PR in another repository of the same owner, and the issue's repository
        // written in mixed case as GitHub may.
        let raw = serde_json::json!([{
            "number": 7,
            "title": "Gift cards at checkout",
            "body": "x".repeat(5000),
            "url": "https://github.com/Acme/Web/issues/7",
            "state": "OPEN",
            "stateReason": "",
            "assignees": [],
            "labels": [],
            "updatedAt": "2026-10-14T09:00:00Z",
            "closedByPullRequestsReferences": [
                {"number": 12, "repository": {"name": "web", "owner": {"login": "acme"}}},
                {"number": 3, "repository": {"name": "api", "owner": {"login": "acme"}}}
            ]
        }]);
        let tasks = parse_gh_tasks(raw.to_string().as_bytes()).unwrap();
        assert_eq!(tasks[0].closing_prs, vec![12]);
        // Long bodies are cut to 4000 characters.
        assert_eq!(tasks[0].body.chars().count(), 4000);
    }

    #[test]
    fn stack_from_api() {
        let v = serde_json::json!({
            "number": 17,
            "base": {"ref": "main"},
            "pull_requests": [
                {"number": 1, "title": "one", "html_url": "https://github.com/o/r/pull/1",
                 "state": "closed", "merged_at": "2026-10-03T14:59:32Z", "draft": false,
                 "head": {"ref": "a"}},
                {"number": 2, "title": "two", "html_url": "https://github.com/o/r/pull/2",
                 "state": "closed", "merged_at": null, "draft": false, "head": {"ref": "b"}},
                {"number": 4, "title": "four", "state": "open", "draft": true,
                 "head": {"ref": "c"}}
            ]
        });
        let s = parse_stack(&v, 4).unwrap();
        assert_eq!((s.number, s.base.as_str()), (17, "main"));
        assert_eq!((s.position, s.size), (3, 3));
        let states: Vec<_> = s.prs.iter().map(|p| p.state.as_str()).collect();
        assert_eq!(states, ["merged", "closed", "open"]);
        assert_eq!(s.prs[0].url, "https://github.com/o/r/pull/1");
        assert_eq!(s.prs[1].branch, "b");
        assert!(s.prs[2].draft && s.prs[2].url.is_empty());
        assert_eq!(parse_stack(&v, 1).unwrap().position, 1);
        // A PR that left the stack between the two API calls.
        assert!(parse_stack(&v, 3).is_none());
        assert!(parse_stack(&serde_json::json!({}), 1).is_none());
    }

    /// `gh pr list --head moonlet/users-cotampanie-downloads-screenshot
    /// --state all` after an earlier session's branch of that name was
    /// merged and deleted (trimmed to the fields read).
    fn merged_pr_25() -> serde_json::Value {
        serde_json::json!([{
            "createdAt": "2026-10-04T07:05:08Z", "number": 25, "state": "MERGED",
            "title": "fix: answer Claude's AskUserQuestion from a question card",
            "url": "https://github.com/1devstudio/jaunt/pull/25",
            "reviewDecision": "", "statusCheckRollup": []
        }])
    }

    #[test]
    fn a_prs_head_commit_is_read() {
        // `gh pr list --head feature/how-often-do-we-check-if-there-is-a-new-version
        // --state all` on 1devstudio/moonlet (trimmed to the fields read).
        let list = serde_json::json!([{
            "createdAt": "2026-10-22T07:04:09Z", "headRefOid": "cd463af7f84581530cb97eafa5ccbc70c9be2646",
            "isDraft": false, "number": 328, "reviewDecision": "", "state": "MERGED",
            "title": "feat: check for app and Claude Code updates every hour (X35, X36)",
            "url": "https://github.com/1devstudio/moonlet/pull/328"
        }]);
        let pr = session_pr(&list, 0, 0).unwrap();
        assert_eq!(pr.head_oid.as_deref(), Some("cd463af7f84581530cb97eafa5ccbc70c9be2646"));
        assert_eq!(session_pr(&merged_pr_25(), 0, 0).unwrap().head_oid, None);
    }

    #[test]
    fn a_merged_pr_from_before_the_session_is_not_its_pr() {
        // Session created at 2026-10-04T18:00:00Z.
        assert_eq!(session_pr(&merged_pr_25(), 1791136800000, 0), None);
        // A session created at 06:00 that day did open #25.
        let pr = session_pr(&merged_pr_25(), 1791093600000, 0).unwrap();
        assert_eq!((pr.number, pr.state.as_str()), (25, "merged"));
    }

    #[test]
    fn a_draft_pr_says_so() {
        let list = serde_json::json!([
            {"createdAt": "2026-10-04T18:20:00Z", "number": 31, "state": "OPEN", "isDraft": true,
             "title": "fix: lowercase paths", "url": "https://github.com/1devstudio/jaunt/pull/31"}
        ]);
        assert!(session_pr(&list, 0, 0).unwrap().draft);
        assert!(!session_pr(&merged_pr_25(), 0, 0).unwrap().draft);
    }

    #[test]
    fn created_pr_number_comes_from_the_printed_url() {
        // `gh pr create` stdout when not on a terminal.
        let out = b"https://github.com/1devstudio/jaunt/pull/38\n";
        assert_eq!(created_pr_number(out), Some(38));
        assert_eq!(created_pr_number(b"Warning: 1 uncommitted change\n"), None);
    }

    #[test]
    fn a_session_takes_the_newest_pr_opened_on_its_branch() {
        let list = serde_json::json!([
            {"createdAt": "2026-10-04T18:20:00Z", "number": 31, "state": "OPEN",
             "title": "fix: lowercase paths", "url": "https://github.com/1devstudio/jaunt/pull/31"},
            {"createdAt": "2026-10-04T07:05:08Z", "number": 25, "state": "MERGED",
             "title": "fix: answer Claude's AskUserQuestion from a question card",
             "url": "https://github.com/1devstudio/jaunt/pull/25"}
        ]);
        let pr = session_pr(&list, 1791136800000, 0).unwrap();
        assert_eq!((pr.number, pr.state.as_str()), (31, "open"));
        assert_eq!(pr.url, "https://github.com/1devstudio/jaunt/pull/31");
    }

    #[test]
    fn an_open_pr_older_than_the_session_is_still_its_pr() {
        // A session opened on an existing branch whose PR is still open.
        let list = serde_json::json!([
            {"createdAt": "2026-10-01T09:00:00Z", "number": 12, "state": "OPEN",
             "title": "feat: stacks", "url": "https://github.com/1devstudio/jaunt/pull/12"}
        ]);
        assert_eq!(session_pr(&list, 1791136800000, 0).unwrap().number, 12);
    }

    #[test]
    fn a_closed_pr_gives_way_only_to_a_newer_one() {
        let list = serde_json::json!([
            {"createdAt": "2026-10-04T18:30:00Z", "number": 33, "state": "CLOSED",
             "title": "fix: first try", "url": "https://github.com/1devstudio/jaunt/pull/33"}
        ]);
        // #33 is the closed PR the session already has: nothing newer.
        assert_eq!(session_pr(&list, 1791136800000, 33), None);
        assert_eq!(session_pr(&list, 1791136800000, 0).unwrap().number, 33);
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Fix the Login bug!"), "fix-the-login-bug");
        assert_eq!(slug("***"), "task");
    }

    #[test]
    fn check_runs_and_commit_statuses() {
        let action = check_run(&serde_json::json!({
            "__typename": "CheckRun", "name": "Analyze", "status": "COMPLETED",
            "conclusion": "SUCCESS", "detailsUrl": "https://example.com/run"
        }));
        assert_eq!(action.status, "completed");
        assert_eq!(action.conclusion.as_deref(), Some("success"));
        assert_eq!(action.url.as_deref(), Some("https://example.com/run"));

        let running = check_run(&serde_json::json!({
            "__typename": "CheckRun", "name": "Build", "status": "IN_PROGRESS", "conclusion": ""
        }));
        assert_eq!(running.status, "in_progress");
        assert_eq!(running.conclusion, None);

        let status = |state: &str| {
            check_run(&serde_json::json!({
                "__typename": "StatusContext", "context": "CodeRabbit",
                "state": state, "targetUrl": ""
            }))
        };
        let done = status("SUCCESS");
        assert_eq!(done.name, "CodeRabbit");
        assert_eq!(done.status, "completed");
        assert_eq!(done.conclusion.as_deref(), Some("success"));
        assert_eq!(done.url, None);
        assert_eq!(status("FAILURE").conclusion.as_deref(), Some("failure"));
        assert_eq!(status("PENDING").status, "pending");
        assert_eq!(status("PENDING").conclusion, None);
    }
}
