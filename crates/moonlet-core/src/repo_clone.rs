//! Adding a project from GitHub (X59): looking a repository up with gh or
//! git, the user's repositories, where a clone goes, and the clone itself
//! with git's progress.

use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use moonlet_proto::types::{CloneStep, CloneTarget, GhStatus, RepoInfo, RepoSummary};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::git::{self, run_raw};
use crate::terminal::expand_home;
use serde_json::Value;

/// `owner/name` when `repo` is one: letters, digits, `.`, `-` and `_`,
/// not starting with `-`, so it can never become an option of gh or git.
pub fn checked_repo(repo: &str) -> Result<&str> {
    let part = |p: &str| {
        !p.is_empty()
            && !p.starts_with('-')
            && p.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    match repo.split_once('/') {
        Some((owner, name)) if part(owner) && part(name) => Ok(repo),
        _ => bail!("not a GitHub repository: {repo}"),
    }
}

/// The SSH address the user typed for `repo`, when it is
/// `git@github.com:<repo>` with or without `.git`.
pub fn checked_ssh<'a>(ssh: &'a str, repo: &str) -> Result<&'a str> {
    let path = ssh.strip_prefix("git@github.com:");
    match path.map(|p| p.strip_suffix(".git").unwrap_or(p)) {
        Some(p) if p == repo && checked_repo(p).is_ok() => Ok(ssh),
        _ => bail!("not an SSH address of {repo}: {ssh}"),
    }
}

/// The active github.com account in `gh auth status`'s output: the one
/// marked active, or with older gh, which marks none, the first. `None`
/// when no account is signed in.
pub fn parse_login(status: &str) -> Option<String> {
    let mut accounts: Vec<(bool, String)> = Vec::new();
    for line in status
        .lines()
        .map(|l| l.trim().trim_start_matches(['✓', '-', ' ']))
    {
        if let Some(rest) = line.strip_prefix("Logged in to github.com account ") {
            let login = rest.split_whitespace().next().unwrap_or_default();
            accounts.push((false, login.to_string()));
        } else if line == "Active account: true"
            && let Some(a) = accounts.last_mut()
        {
            a.0 = true;
        }
    }
    let active = accounts.iter().find(|a| a.0).or(accounts.first())?;
    Some(active.1.clone())
}

/// The JSON fields `gh repo view` is asked for.
pub const VIEW_FIELDS: &str =
    "name,nameWithOwner,description,isPrivate,defaultBranchRef,pushedAt,diskUsage";

/// A repository's details from `gh repo view --json VIEW_FIELDS`.
pub fn parse_repo_view(json: &[u8]) -> Result<RepoInfo> {
    let v: Value = serde_json::from_slice(json).context("gh repo view gave no JSON")?;
    let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(String::from);
    Ok(RepoInfo {
        repo: text(&v["nameWithOwner"]).context("gh repo view gave no nameWithOwner")?,
        private: v["isPrivate"].as_bool(),
        description: text(&v["description"]),
        default_branch: text(&v["defaultBranchRef"]["name"]),
        pushed_at: text(&v["pushedAt"]),
        disk_kb: v["diskUsage"].as_u64(),
    })
}

/// A repository found through `git ls-remote --symref <url> HEAD`, which
/// gh's absence leaves as the only way to look a public one up.
pub fn parse_ls_remote(repo: &str, out: &str) -> RepoInfo {
    let default_branch = out.lines().find_map(|l| {
        let (target, name) = l.strip_prefix("ref: refs/heads/")?.split_once('\t')?;
        (name == "HEAD").then(|| target.to_string())
    });
    RepoInfo {
        repo: repo.into(),
        private: None,
        description: None,
        default_branch,
        pushed_at: None,
        disk_kb: None,
    }
}

/// What `gh api` is asked for to list the user's repositories, most
/// recently pushed first, and the `--jq` that trims each to what the list
/// shows.
pub const LIST_PATH: &str =
    "user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100";
pub const LIST_JQ: &str = "[.[] | {full_name, description, private, pushed_at}]";

/// The user's repositories from `gh api LIST_PATH --jq LIST_JQ`. `added`
/// are the `owner/name`s of this host's projects, in any case.
pub fn parse_repo_list(json: &[u8], added: &[String]) -> Result<Vec<RepoSummary>> {
    let v: Value = serde_json::from_slice(json).context("gh api gave no JSON")?;
    let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(String::from);
    Ok(v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let repo = text(&r["full_name"])?;
            Some(RepoSummary {
                added: added.iter().any(|a| a.eq_ignore_ascii_case(&repo)),
                description: text(&r["description"]),
                private: r["private"].as_bool().unwrap_or(false),
                pushed_at: text(&r["pushed_at"]),
                repo,
            })
        })
        .collect())
}

/// One progress report of `git clone --progress`.
#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    pub step: CloneStep,
    pub current: u64,
    pub total: u64,
    pub size: Option<String>,
    pub speed: Option<String>,
}

/// A segment of git's progress output, between two `\r` or `\n`:
/// `remote: Counting objects:  42% (1233/2935)`,
/// `Receiving objects:  64% (8213/12840), 21.40 MiB | 6.20 MiB/s` or
/// `Resolving deltas: 100% (8381/8381), done.`. Other lines give `None`.
pub fn parse_progress(segment: &str) -> Option<Progress> {
    let line = segment.trim();
    let (step, rest) = [
        ("remote: Counting objects:", CloneStep::Counting),
        ("Receiving objects:", CloneStep::Receiving),
        ("Resolving deltas:", CloneStep::Resolving),
    ]
    .into_iter()
    .find_map(|(label, step)| Some((step, line.strip_prefix(label)?)))?;
    // `  64% (8213/12840), 21.40 MiB | 6.20 MiB/s, done.`
    let (counts, tail) = rest.split_once('(')?.1.split_once(')')?;
    let (current, total) = counts.split_once('/')?;
    let transfer = tail
        .trim_start_matches(", ")
        .trim_end_matches("done.")
        .trim_end_matches(", ");
    let (size, speed) = match transfer.split_once(" | ") {
        Some((size, speed)) => (
            Some(size.trim().to_string()),
            Some(speed.trim().to_string()),
        ),
        None => (None, None),
    };
    Some(Progress {
        step,
        current: current.parse().ok()?,
        total: total.parse().ok()?,
        size,
        speed,
    })
}

/// The `owner/name` of a github.com remote URL: https, `ssh://` or
/// scp-like `git@github.com:owner/name.git`.
pub fn origin_repo(url: &str) -> Option<String> {
    let url = url.trim();
    let path = match url.strip_prefix("git@github.com:") {
        Some(path) => path,
        None => {
            let rest = url.split_once("://")?.1;
            let (authority, path) = rest.split_once('/')?;
            if authority.rsplit('@').next()? != "github.com" {
                return None;
            }
            path
        }
    };
    let path = path.trim_end_matches('/');
    let repo = path.strip_suffix(".git").unwrap_or(path);
    checked_repo(repo).ok().map(String::from)
}

/// The folder `parent`/`name` a clone of `repo` would go to. `parent`
/// may start with `~`, and must then be a full path; `name` is one folder.
pub fn clone_dest(parent: &str, name: &str) -> Result<PathBuf> {
    let parent = expand_home(parent.trim());
    if !parent.is_absolute() {
        bail!("Clone into needs a full path, like ~/moonlet");
    }
    match name.trim() {
        "" => bail!("The folder name cannot be empty"),
        "." | ".." => bail!("The folder name cannot be . or .."),
        n if n.contains('/') => bail!("The folder name cannot hold /"),
        n => Ok(parent.join(n)),
    }
}

/// What is at the folder a clone of `repo` would go to.
pub async fn clone_target(repo: &str, parent: &str, name: &str) -> Result<CloneTarget> {
    let path = clone_dest(parent, name)?;
    let exists = path.exists();
    // Only a repository's own top folder counts, not a folder inside one.
    let own_repo = match git::toplevel(&path).await {
        Ok(top) if exists => same_folder(&top, &path),
        _ => false,
    };
    let (same_repo, branch) = if own_repo {
        let origin = git::origin_url(&path).await;
        let same = origin
            .and_then(|u| origin_repo(&u))
            .is_some_and(|r| r.eq_ignore_ascii_case(repo));
        (
            same,
            git::git_text(&path, &["symbolic-ref", "--short", "HEAD"])
                .await
                .ok(),
        )
    } else {
        (false, None)
    };
    let name = name.trim();
    let free_name = std::iter::once(name.to_string())
        .chain((2..).map(|n| format!("{name}-{n}")))
        .find(|n| !path.with_file_name(n).exists())
        .unwrap_or_default();
    Ok(CloneTarget {
        path: path.display().to_string(),
        exists,
        same_repo,
        branch,
        free_name,
    })
}

fn same_folder(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// What a failed clone or lookup says: git's last `fatal:` line without
/// the prefix, else its last line.
pub fn failure(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    lines
        .iter()
        .rev()
        .find_map(|l| l.strip_prefix("fatal: "))
        .or(lines.last().copied())
        .unwrap_or("it ended without saying why")
        .to_string()
}

/// gh on this host: installed, and the signed-in account.
pub async fn gh_status() -> GhStatus {
    let args = ["auth", "status", "--hostname", "github.com"];
    match run_raw("gh", Path::new("/"), &args, None, Duration::from_secs(30)).await {
        // gh before 2.40 prints it to stderr.
        Ok(out) => GhStatus {
            installed: true,
            login: parse_login(&format!(
                "{}\n{}",
                String::from_utf8_lossy(&out.stdout),
                out.stderr
            )),
        },
        Err(_) => GhStatus {
            installed: false,
            login: None,
        },
    }
}

fn https_url(repo: &str) -> String {
    format!("https://github.com/{repo}.git")
}

/// `repo`'s details: from gh when it is signed in, else whether git can
/// read it (a public repository, or one the SSH address reaches).
pub async fn lookup(repo: &str, ssh: Option<&str>) -> Result<RepoInfo> {
    checked_repo(repo)?;
    if let Some(ssh) = ssh {
        checked_ssh(ssh, repo)?;
    }
    let timeout = Duration::from_secs(60);
    if gh_status().await.login.is_some() {
        let out = run_raw(
            "gh",
            Path::new("/"),
            &["repo", "view", repo, "--json", VIEW_FIELDS],
            None,
            timeout,
        )
        .await?;
        if out.status != 0 {
            bail!("{}", failure(&out.stderr));
        }
        return parse_repo_view(&out.stdout);
    }
    let url = ssh.map_or_else(|| https_url(repo), String::from);
    let out = run_raw(
        "git",
        Path::new("/"),
        &["ls-remote", "--symref", &url, "HEAD"],
        None,
        timeout,
    )
    .await?;
    if out.status != 0 {
        bail!("{}", failure(&out.stderr));
    }
    Ok(parse_ls_remote(repo, &String::from_utf8_lossy(&out.stdout)))
}

/// The `owner/name` each folder's `origin` points at, for those on GitHub.
pub async fn folder_repos(folders: &[String]) -> Vec<String> {
    let mut repos = Vec::new();
    for folder in folders {
        if let Some(repo) = git::origin_url(Path::new(folder))
            .await
            .and_then(|u| origin_repo(&u))
        {
            repos.push(repo);
        }
    }
    repos
}

/// The signed-in user's repositories, most recently pushed first. `added`
/// as in `parse_repo_list`.
pub async fn list(added: &[String]) -> Result<Vec<RepoSummary>> {
    let args = ["api", LIST_PATH, "--jq", LIST_JQ];
    let out = run_raw("gh", Path::new("/"), &args, None, Duration::from_secs(60)).await?;
    if out.status != 0 {
        bail!("{}", failure(&out.stderr));
    }
    parse_repo_list(&out.stdout, added)
}

/// The program and arguments that clone `repo` into `dest`.
pub fn clone_command(repo: &str, ssh: Option<&str>, gh_signed_in: bool, dest: &str) -> (&'static str, Vec<String>) {
    match ssh {
        None if gh_signed_in => ("gh", ["repo", "clone", repo, dest, "--", "--progress"].map(String::from).to_vec()),
        _ => {
            let url = ssh.map_or_else(|| https_url(repo), String::from);
            ("git", vec!["clone".into(), "--progress".into(), url, dest.into()])
        }
    }
}

/// Kills the clone's process group when dropped: gh runs git as its own
/// child, which killing gh alone would leave writing into the folder.
struct Group(Option<u32>);

impl Drop for Group {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
    }
}

/// Clones `repo` into `dest`, which must not exist, handing each new
/// progress report to `on_progress`. With gh signed in and no SSH address
/// it runs `gh repo clone`, so private repositories clone with gh's
/// sign-in; else `git clone` of the SSH address or the https URL.
/// Dropping the future stops the clone; the caller removes the folder.
pub async fn clone(
    repo: &str,
    ssh: Option<&str>,
    gh_signed_in: bool,
    dest: &Path,
    mut on_progress: impl FnMut(Progress),
) -> Result<()> {
    checked_repo(repo)?;
    if let Some(ssh) = ssh {
        checked_ssh(ssh, repo)?;
    }
    if !dest.is_absolute() {
        bail!("{} is not a full path", dest.display());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("cannot create {}", parent.display()))?;
    }
    let (program, args) = clone_command(repo, ssh, gh_signed_in, &dest.display().to_string());
    let mut cmd = Command::new(program);
    cmd.args(args);
    for var in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_COMMON_DIR",
    ] {
        cmd.env_remove(var);
    }
    cmd.current_dir(dest.parent().unwrap_or(Path::new("/")))
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    let mut child = cmd.spawn().context("cannot run the clone")?;
    let _group = Group(child.id());
    let mut stderr = child.stderr.take().context("no stderr")?;
    let mut text = String::new();
    let mut buf = [0u8; 4096];
    let mut pending = String::new();
    let mut last: Option<Progress> = None;
    loop {
        let n = stderr.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let chunk = String::from_utf8_lossy(&buf[..n]);
        text.push_str(&chunk);
        pending.push_str(&chunk);
        // Hand on whole segments; keep the unfinished one for the next read.
        while let Some(end) = pending.find(['\r', '\n']) {
            let segment: String = pending.drain(..=end).collect();
            if let Some(p) = parse_progress(&segment)
                && last.as_ref() != Some(&p)
            {
                last = Some(p.clone());
                on_progress(p);
            }
        }
    }
    let status = child.wait().await?;
    if !status.success() {
        bail!("{}", failure(&text.replace('\r', "\n")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!(
            "{}/tests/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn accepts_only_plain_owner_and_name() {
        assert_eq!(checked_repo("acme/storefront").unwrap(), "acme/storefront");
        assert_eq!(
            checked_repo("sam-rivera/store_locator.js").unwrap(),
            "sam-rivera/store_locator.js"
        );
        for bad in [
            "storefront",
            "acme/store front",
            "-acme/storefront",
            "acme/-u",
            "acme/storefront/x",
            "acme/",
            "/storefront",
            "acme/st;rm",
            "",
        ] {
            assert_eq!(
                checked_repo(bad).unwrap_err().to_string(),
                format!("not a GitHub repository: {bad}"),
                "{bad}"
            );
        }
    }

    #[test]
    fn accepts_only_the_github_ssh_address_of_the_repository() {
        for ok in [
            "git@github.com:acme/storefront.git",
            "git@github.com:acme/storefront",
        ] {
            assert_eq!(checked_ssh(ok, "acme/storefront").unwrap(), ok);
        }
        for bad in [
            "git@github.com:acme/other.git",
            "git@gitlab.com:acme/storefront.git",
            "-oProxyCommand=x git@github.com:acme/storefront",
            "ssh://git@github.com/acme/storefront.git",
        ] {
            assert_eq!(
                checked_ssh(bad, "acme/storefront").unwrap_err().to_string(),
                format!("not an SSH address of acme/storefront: {bad}"),
                "{bad}"
            );
        }
    }

    #[test]
    fn reads_the_signed_in_login_from_gh_auth_status() {
        assert_eq!(
            parse_login(&fixture("gh-auth-status.txt")).as_deref(),
            Some("sam-rivera")
        );
        assert_eq!(parse_login(&fixture("gh-auth-status-signed-out.txt")), None);
        let two = "github.com\n  ✓ Logged in to github.com account old-one (keyring)\n  - Active account: false\n  ✓ Logged in to github.com account alex-kim (keyring)\n  - Active account: true\n";
        assert_eq!(parse_login(two).as_deref(), Some("alex-kim"));
    }

    #[test]
    fn reads_a_repository_from_gh_repo_view() {
        assert_eq!(
            parse_repo_view(fixture("gh-repo-view.json").as_bytes()).unwrap(),
            RepoInfo {
                repo: "acme/storefront".into(),
                private: Some(false),
                description: Some("Next.js storefront for the Acme shop".into()),
                default_branch: Some("main".into()),
                pushed_at: Some("2026-10-21T10:08:17Z".into()),
                disk_kb: Some(4911),
            }
        );
        // An empty repository: no branch, no description.
        assert_eq!(
            parse_repo_view(fixture("gh-repo-view-empty.json").as_bytes()).unwrap(),
            RepoInfo {
                repo: "acme/empty".into(),
                private: Some(true),
                description: None,
                default_branch: None,
                pushed_at: Some("2026-10-18T12:12:49Z".into()),
                disk_kb: Some(0),
            }
        );
    }

    #[test]
    fn reads_the_default_branch_from_git_ls_remote() {
        assert_eq!(
            parse_ls_remote("acme/storefront", &fixture("git-ls-remote-symref.txt")),
            RepoInfo {
                repo: "acme/storefront".into(),
                private: None,
                description: None,
                default_branch: Some("main".into()),
                pushed_at: None,
                disk_kb: None
            }
        );
        assert_eq!(parse_ls_remote("acme/empty", "").default_branch, None);
    }

    #[test]
    fn lists_the_users_repositories_and_marks_those_already_added() {
        let list = parse_repo_list(
            fixture("gh-user-repos.json").as_bytes(),
            &["ACME/Payments-API".into()],
        )
        .unwrap();
        let summary =
            |repo: &str, description: Option<&str>, private: bool, pushed_at: &str, added: bool| {
                RepoSummary {
                    repo: repo.into(),
                    description: description.map(String::from),
                    private,
                    pushed_at: Some(pushed_at.into()),
                    added,
                }
            };
        assert_eq!(
            list,
            [
                summary(
                    "acme/storefront",
                    Some("Next.js storefront for the Acme shop"),
                    true,
                    "2026-10-21T15:26:07Z",
                    false
                ),
                summary(
                    "acme/storefront-admin",
                    Some("Back office for orders and catalogue"),
                    true,
                    "2026-10-21T15:25:39Z",
                    false
                ),
                summary(
                    "acme/payments-api",
                    None,
                    true,
                    "2026-10-21T15:25:19Z",
                    true
                ),
                summary(
                    "sam-rivera/store-locator",
                    Some("Map widget for physical store finder"),
                    false,
                    "2026-10-21T15:13:16Z",
                    false
                ),
            ]
        );
    }

    #[test]
    fn reads_the_steps_of_git_clone_progress() {
        let out = fixture("git-clone-progress.txt");
        let all: Vec<Progress> = out.split(['\r', '\n']).filter_map(parse_progress).collect();
        let p = |step, current, total, size: Option<&str>, speed: Option<&str>| Progress {
            step,
            current,
            total,
            size: size.map(String::from),
            speed: speed.map(String::from),
        };
        assert_eq!(
            all.first(),
            Some(&p(CloneStep::Counting, 1, 2935, None, None))
        );
        assert!(all.contains(&p(CloneStep::Counting, 2935, 2935, None, None)));
        assert!(all.contains(&p(CloneStep::Receiving, 591, 11818, None, None)));
        assert!(all.contains(&p(
            CloneStep::Receiving,
            11818,
            11818,
            Some("5.20 MiB"),
            Some("10.82 MiB/s")
        )));
        assert_eq!(
            all.last(),
            Some(&p(CloneStep::Resolving, 8381, 8381, None, None))
        );
        // Compressing, the totals and git's own lines are not steps.
        for line in [
            "remote: Compressing objects: 100% (950/950), done.        ",
            "remote: Enumerating objects: 11818, done.        ",
            "Cloning into 'storefront'...",
            "remote: Total 11818 (delta 2155), reused 2001 (delta 1985), pack-reused 8883 (from 2)        ",
            "",
        ] {
            assert_eq!(parse_progress(line), None, "{line}");
        }
    }

    #[test]
    fn reads_the_repository_of_a_github_remote() {
        for url in [
            "https://github.com/acme/storefront.git",
            "https://github.com/acme/storefront",
            "git@github.com:acme/storefront.git",
            "ssh://git@github.com/acme/storefront.git",
            "https://x-access-token@github.com/acme/storefront/",
        ] {
            assert_eq!(
                origin_repo(url).as_deref(),
                Some("acme/storefront"),
                "{url}"
            );
        }
        for url in [
            "https://gitlab.com/acme/storefront.git",
            "/Users/alex/repos/storefront.git",
            "git@github.com:acme",
        ] {
            assert_eq!(origin_repo(url), None, "{url}");
        }
    }

    fn sh(dir: &Path, script: &str) {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{script}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn refuses_a_folder_that_is_not_one_name_under_a_full_path() {
        assert_eq!(
            clone_dest("/srv/code", "storefront").unwrap(),
            PathBuf::from("/srv/code/storefront")
        );
        assert_eq!(
            clone_dest("~/moonlet", "storefront").unwrap(),
            dirs::home_dir().unwrap().join("moonlet/storefront")
        );
        for (parent, name, error) in [
            (
                "code",
                "storefront",
                "Clone into needs a full path, like ~/moonlet",
            ),
            (
                "",
                "storefront",
                "Clone into needs a full path, like ~/moonlet",
            ),
            ("/srv/code", "", "The folder name cannot be empty"),
            ("/srv/code", "a/b", "The folder name cannot hold /"),
            ("/srv/code", "..", "The folder name cannot be . or .."),
        ] {
            assert_eq!(
                clone_dest(parent, name).unwrap_err().to_string(),
                error,
                "{parent} {name}"
            );
        }
    }

    #[tokio::test]
    async fn tells_a_free_folder_a_clone_of_the_repository_and_another_folder_apart() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().to_str().unwrap();
        let free = clone_target("acme/storefront", parent, "storefront")
            .await
            .unwrap();
        assert_eq!(
            free,
            CloneTarget {
                path: format!("{parent}/storefront"),
                exists: false,
                same_repo: false,
                branch: None,
                free_name: "storefront".into()
            }
        );

        sh(
            tmp.path(),
            "git init -q -b trunk storefront && git -C storefront remote add origin git@github.com:acme/storefront.git && mkdir storefront-2",
        );
        let clone = clone_target("acme/storefront", parent, "storefront")
            .await
            .unwrap();
        assert_eq!(
            clone,
            CloneTarget {
                path: format!("{parent}/storefront"),
                exists: true,
                same_repo: true,
                branch: Some("trunk".into()),
                free_name: "storefront-3".into()
            }
        );

        let other = clone_target("acme/payments-api", parent, "storefront")
            .await
            .unwrap();
        assert!(other.exists && !other.same_repo, "{other:?}");
        let plain = clone_target("acme/storefront", parent, "storefront-2")
            .await
            .unwrap();
        assert_eq!(
            plain,
            CloneTarget {
                path: format!("{parent}/storefront-2"),
                exists: true,
                same_repo: false,
                branch: None,
                free_name: "storefront-2-2".into()
            }
        );
    }

    #[test]
    fn says_why_a_clone_failed_in_gits_words() {
        // `git clone --progress` of a repository that does not exist.
        let missing = "Cloning into 'nf'...\nremote: Repository not found.\nfatal: repository 'https://github.com/acme/nope.git/' not found\n";
        assert_eq!(
            failure(missing),
            "repository 'https://github.com/acme/nope.git/' not found"
        );
        // `gh repo view` of a repository that does not exist.
        let gh =
            "GraphQL: Could not resolve to a Repository with the name 'acme/nope'. (repository)\n";
        assert_eq!(
            failure(gh),
            "GraphQL: Could not resolve to a Repository with the name 'acme/nope'. (repository)"
        );
        assert_eq!(failure(""), "it ended without saying why");
    }

    #[test]
    fn clones_with_gh_when_signed_in_else_with_git() {
        let dest = "/Users/alex/moonlet/storefront";
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(clone_command("acme/storefront", None, true, dest), ("gh", args(&["repo", "clone", "acme/storefront", dest, "--", "--progress"])));
        assert_eq!(
            clone_command("acme/storefront", None, false, dest),
            ("git", args(&["clone", "--progress", "https://github.com/acme/storefront.git", dest]))
        );
        // A typed SSH address is used as it is, signed in or not.
        for signed_in in [true, false] {
            assert_eq!(
                clone_command("acme/storefront", Some("git@github.com:acme/storefront.git"), signed_in, dest),
                ("git", args(&["clone", "--progress", "git@github.com:acme/storefront.git", dest]))
            );
        }
    }
}
