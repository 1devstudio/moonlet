//! Git operations, run with the git CLI on the host that owns the work tree
//! (D1, D2, A4). The same code serves local and remote hosts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use jaunt_proto::types::{CheckRun, Commit, FileChange, FileVersions, GitStatus, PullRequest};
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

async fn run_raw(
    program: &str,
    cwd: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<Output> {
    let mut cmd = Command::new(program);
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
    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(data).await?;
        drop(pipe);
    }
    let out = tokio::time::timeout(timeout, child.wait_with_output())
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
    let out = run_raw("git", cwd, args, None, Duration::from_secs(60)).await?;
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
    let out = run_raw("git", cwd, args, Some(stdin), Duration::from_secs(60)).await?;
    if out.status != 0 {
        bail!("git {}: {}", args.join(" "), out.stderr);
    }
    Ok(())
}

pub async fn toplevel(path: &Path) -> Result<PathBuf> {
    Ok(PathBuf::from(
        git_text(path, &["rev-parse", "--show-toplevel"])
            .await
            .context("not a git repository")?,
    ))
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
    if !has_head(cwd).await {
        return EMPTY_TREE.into();
    }
    if let Some(base) = base.filter(|b| !b.is_empty() && *b != "HEAD") {
        for candidate in [base.to_string(), format!("origin/{base}")] {
            if let Ok(mb) = git_text(cwd, &["merge-base", "HEAD", &candidate]).await {
                return mb;
            }
        }
    }
    "HEAD".into()
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
    let against = resolve_against(&root, base).await;

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
    Ok(raw
        .lines()
        .filter_map(|l| {
            let mut p = l.split('\x1f');
            Some(Commit {
                sha: p.next()?.into(),
                subject: p.next()?.into(),
                author: p.next()?.into(),
                time: p.next()?.parse().ok()?,
            })
        })
        .collect())
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
        git(repo, &["worktree", "add", "-b", branch, &dir_s, from]).await?;
    }
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
    gh(&root, &args).await?;
    pr_status(&root)
        .await?
        .context("pull request was created but cannot be read back")
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
    let branch = String::from_utf8_lossy(&out).trim().to_string();
    if branch.is_empty() {
        bail!("pull request #{number} has no head branch");
    }
    if git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .await
    .is_err()
    {
        git(
            repo,
            &["fetch", "origin", &format!("pull/{number}/head:{branch}")],
        )
        .await?;
    }
    Ok(branch)
}

/// Open issues (`kind = "issue"`) or pull requests (`"pr"`) for the composer.
pub async fn gh_list(repo: &Path, kind: &str) -> Result<Vec<jaunt_proto::types::IssueRef>> {
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
        .map(|x| jaunt_proto::types::IssueRef {
            number: x["number"].as_u64().unwrap_or(0),
            title: x["title"].as_str().unwrap_or("").into(),
            body: x["body"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(4000)
                .collect(),
            url: x["url"].as_str().unwrap_or("").into(),
            head_branch: x["headRefName"].as_str().map(String::from),
        })
        .collect())
}

pub async fn pr_status(path: &Path) -> Result<Option<PullRequest>> {
    let root = toplevel(path).await?;
    let out = run_raw(
        "gh",
        &root,
        &[
            "pr",
            "view",
            "--json",
            "number,url,state,title,reviewDecision,statusCheckRollup",
        ],
        None,
        Duration::from_secs(60),
    )
    .await?;
    if out.status != 0 {
        if out.stderr.contains("no pull requests found") {
            return Ok(None);
        }
        bail!("gh pr view: {}", out.stderr);
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)?;
    let checks = v["statusCheckRollup"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| CheckRun {
            name: c["name"]
                .as_str()
                .or(c["context"].as_str())
                .unwrap_or("check")
                .into(),
            status: c["status"]
                .as_str()
                .or(c["state"].as_str())
                .unwrap_or("")
                .to_lowercase(),
            conclusion: c["conclusion"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| s.to_lowercase()),
            url: c["detailsUrl"]
                .as_str()
                .or(c["targetUrl"].as_str())
                .map(String::from),
        })
        .collect();
    Ok(Some(PullRequest {
        number: v["number"].as_u64().unwrap_or(0),
        url: v["url"].as_str().unwrap_or("").into(),
        state: v["state"].as_str().unwrap_or("").to_lowercase(),
        title: v["title"].as_str().unwrap_or("").into(),
        checks,
        review_decision: v["reviewDecision"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(String::from),
    }))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

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
    async fn worktrees_and_branches() {
        let dir = repo().await;
        let p = dir.path();
        assert_eq!(default_branch(p).await, "main");
        let wt = tempfile::tempdir().unwrap();
        let target = wt.path().join("ws");
        worktree_add(p, &target, "jaunt/fix-bug", "main", false)
            .await
            .unwrap();
        assert!(target.join("a.txt").exists());
        assert!(
            branches(p)
                .await
                .unwrap()
                .contains(&"jaunt/fix-bug".to_string())
        );
        worktree_remove(p, &target).await.unwrap();
        assert!(!target.exists());
        delete_branch(p, "jaunt/fix-bug").await.unwrap();
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

    #[test]
    fn slugs() {
        assert_eq!(slug("Fix the Login bug!"), "fix-the-login-bug");
        assert_eq!(slug("***"), "task");
    }
}
