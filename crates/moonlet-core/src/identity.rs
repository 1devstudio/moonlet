//! A project's identity (X41): its normalized origin plus its root commit,
//! so every machine recognises the same repository whatever its path.

use std::path::Path;

use moonlet_proto::types::ProjectIdentity;

/// The identity of the repository holding `path`. Fields that cannot be
/// read are `None`.
pub async fn identity(path: &Path) -> ProjectIdentity {
    ProjectIdentity {
        origin: origin(path).await.flatten(),
        root: root(path).await,
    }
}

/// The normalized origin of the repository holding `path`: `Some(None)`
/// when it has no `origin` remote, `None` when the repository cannot be
/// read at all.
pub async fn origin(path: &Path) -> Option<Option<String>> {
    crate::git::git_text(path, &["rev-parse", "--git-dir"])
        .await
        .ok()?;
    Some(
        crate::git::origin_url(path)
            .await
            .and_then(|u| normalize_origin(&u)),
    )
}

/// The root commit of the repository holding `path`, or `None`.
pub async fn root(path: &Path) -> Option<String> {
    // A shallow clone's boundary commits look like roots but are not.
    let shallow = crate::git::git_text(path, &["rev-parse", "--is-shallow-repository"]).await;
    match shallow.as_deref() {
        Ok("false") => {
            crate::git::git_text(path, &["log", "--max-parents=0", "--format=%H %ct", "HEAD"])
                .await
                .ok()
                .and_then(|log| pick_root(&log))
        }
        _ => None,
    }
}

/// Whether two identities are the same project: equal roots that are known,
/// and equal origins (two missing origins are equal).
pub fn same_project(a: &ProjectIdentity, b: &ProjectIdentity) -> bool {
    a.root.is_some() && a.root == b.root && a.origin == b.origin
}

/// `host[:port]/path` of a remote URL: no scheme, user, credentials, query
/// or fragment, the host lowercased, a port only when not the scheme's
/// default, no trailing `.git` or `/`. A local path (or `file://`) has none.
pub fn normalize_origin(url: &str) -> Option<String> {
    let url = url.trim();
    // A query or fragment is no part of the repository, and may carry a
    // token (`?access_token=…`), in either URL form.
    let url = url.split(['?', '#']).next().unwrap_or(url);
    let (scheme, rest) = match url.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r),
        None => {
            // scp-like `user@host:path`; a colon after a slash is a path.
            let colon = url.find(':')?;
            if url.starts_with(['/', '.', '~']) || url[..colon].contains('/') {
                return None;
            }
            let (auth, path) = url.split_at(colon);
            return join(&host_only(auth).to_ascii_lowercase(), &path[1..]);
        }
    };
    if scheme == "file" {
        return None;
    }
    let (auth, path) = rest.split_once('/').unwrap_or((rest, ""));
    let hostport = host_only(auth).to_ascii_lowercase();
    let default = match scheme.as_str() {
        "https" => "443",
        "http" => "80",
        "ssh" | "git+ssh" | "ssh+git" => "22",
        "git" => "9418",
        _ => "",
    };
    let host = match hostport.rsplit_once(':') {
        Some((h, port)) if port == default || port.is_empty() => h.to_string(),
        _ => hostport,
    };
    join(&host, path)
}

/// The root commit from `git log --max-parents=0 --format='%H %ct'`: the
/// oldest by committer date, ties broken by the smallest hash.
pub fn pick_root(log: &str) -> Option<String> {
    log.lines()
        .filter_map(|l| {
            let (hash, time) = l.trim().split_once(' ')?;
            Some((time.trim().parse::<u64>().ok()?, hash))
        })
        .min()
        .map(|(_, hash)| hash.to_string())
}

/// `auth` without its `user[:password]@`.
fn host_only(auth: &str) -> &str {
    auth.rsplit_once('@').map_or(auth, |(_, h)| h)
}

fn join(host: &str, path: &str) -> Option<String> {
    let path = path.trim_matches('/');
    let path = path
        .strip_suffix(".git")
        .unwrap_or(path)
        .trim_end_matches('/');
    (!host.is_empty() && !path.is_empty()).then(|| format!("{host}/{path}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_normalize_as_in_the_worked_examples() {
        for (url, want) in [
            (
                "https://github.com/1devstudio/moonlet.git",
                Some("github.com/1devstudio/moonlet"),
            ),
            (
                "git@github.com:1devstudio/moonlet.git",
                Some("github.com/1devstudio/moonlet"),
            ),
            (
                "ssh://git@github.com/1devstudio/moonlet",
                Some("github.com/1devstudio/moonlet"),
            ),
            (
                "ssh://git@github.com:22/1devstudio/moonlet.git/",
                Some("github.com/1devstudio/moonlet"),
            ),
            (
                "https://user:token@GitHub.com/1devstudio/moonlet.git",
                Some("github.com/1devstudio/moonlet"),
            ),
            (
                "https://gitlab.example.com:8443/team/app.git",
                Some("gitlab.example.com:8443/team/app"),
            ),
            (
                "https://github.com/acme/shop.git?access_token=secret",
                Some("github.com/acme/shop"),
            ),
            (
                "https://github.com/acme/shop#readme",
                Some("github.com/acme/shop"),
            ),
            (
                "git@github.com:acme/shop.git?access_token=secret",
                Some("github.com/acme/shop"),
            ),
            ("/Users/alex/src/app", None),
        ] {
            assert_eq!(normalize_origin(url).as_deref(), want, "{url}");
        }
    }

    #[test]
    fn the_root_is_the_oldest_root_commit() {
        // Captured from this repository.
        let one = "4171b03ff0d2bd434751f17bc9d34da784f97e72 1790968896\n";
        assert_eq!(
            pick_root(one).as_deref(),
            Some("4171b03ff0d2bd434751f17bc9d34da784f97e72")
        );
        // Captured from a scratch repository whose `main` (2026-10-01) merged
        // an unrelated `docs` history (2026-10-02):
        // `git log --max-parents=0 --format='%H %ct' HEAD`.
        let two = "01d614ada9e863900d71c7e541ce267013860e99 1790935200\n\
                   c8452e9128b48944c123f0e7b84cc63d39528faa 1790848800\n";
        assert_eq!(
            pick_root(two).as_deref(),
            Some("c8452e9128b48944c123f0e7b84cc63d39528faa")
        );
        // Constructed: the same two roots at one time.
        let tie = "01d614ada9e863900d71c7e541ce267013860e99 1790848800\n\
                   c8452e9128b48944c123f0e7b84cc63d39528faa 1790848800\n";
        assert_eq!(
            pick_root(tie).as_deref(),
            Some("01d614ada9e863900d71c7e541ce267013860e99")
        );
        assert_eq!(pick_root(""), None);
    }

    fn id(origin: Option<&str>, root: Option<&str>) -> ProjectIdentity {
        ProjectIdentity {
            origin: origin.map(Into::into),
            root: root.map(Into::into),
        }
    }

    #[test]
    fn same_project_needs_a_known_root_and_the_same_origin() {
        let shop = Some("github.com/acme/shop");
        let root = Some("4171b03ff0d2bd434751f17bc9d34da784f97e72");
        assert!(same_project(&id(shop, root), &id(shop, root)));
        assert!(!same_project(&id(shop, root), &id(None, root)));
        assert!(same_project(&id(None, root), &id(None, root)));
        assert!(!same_project(&id(shop, None), &id(shop, None)));
    }

    async fn git(dir: &Path, args: &[&str]) {
        crate::git::git(dir, args).await.unwrap();
    }

    /// A repository whose one commit has a fixed hash, `d58b7092…`: the same
    /// author, date and content always give the same commit.
    fn fixed_repo() -> tempfile::TempDir {
        let repo = tempfile::tempdir().unwrap();
        std::fs::write(repo.path().join("shop.txt"), "a\n").unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["add", "shop.txt"],
            &["commit", "-q", "-m", "shop"],
        ] {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(repo.path())
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_AUTHOR_NAME", "Alex")
                .env("GIT_AUTHOR_EMAIL", "alex@example.com")
                .env("GIT_COMMITTER_NAME", "Alex")
                .env("GIT_COMMITTER_EMAIL", "alex@example.com")
                .env("GIT_AUTHOR_DATE", "2026-10-01T10:00:00Z")
                .env("GIT_COMMITTER_DATE", "2026-10-01T10:00:00Z")
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?}");
        }
        repo
    }

    #[tokio::test]
    async fn a_repository_has_its_origin_and_root_and_a_shallow_or_empty_one_no_root() {
        let repo = fixed_repo();
        git(
            repo.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://user:token@github.com/acme/shop.git",
            ],
        )
        .await;
        let got = identity(repo.path()).await;
        assert_eq!(got.origin.as_deref(), Some("github.com/acme/shop"));
        assert_eq!(
            got.root.as_deref(),
            Some("d58b7092fc34407c273d5e62e56187a91d04ff3e")
        );

        git(repo.path(), &["commit", "-q", "--allow-empty", "-m", "two"]).await;
        let parent = tempfile::tempdir().unwrap();
        let shallow = parent.path().join("shallow");
        let src = format!("file://{}", repo.path().display());
        git(
            parent.path(),
            &["clone", "-q", "--depth", "1", &src, "shallow"],
        )
        .await;
        assert_eq!(identity(&shallow).await.root, None);

        let empty = tempfile::tempdir().unwrap();
        git(empty.path(), &["init", "-q"]).await;
        assert_eq!(identity(empty.path()).await, id(None, None));
    }
}
