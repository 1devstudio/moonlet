//! A project's identity (X41): its normalized origin plus its root commit,
//! so every machine recognises the same repository whatever its path.

use std::path::Path;

use moonlet_proto::types::ProjectIdentity;

/// The identity of the repository holding `path`. Fields that cannot be
/// read are `None`.
pub async fn identity(path: &Path) -> ProjectIdentity {
    let origin = crate::git::origin_url(path)
        .await
        .and_then(|u| normalize_origin(&u));
    // A shallow clone's boundary commits look like roots but are not.
    let shallow = crate::git::git_text(path, &["rev-parse", "--is-shallow-repository"]).await;
    let root = match shallow.as_deref() {
        Ok("false") => {
            crate::git::git_text(path, &["log", "--max-parents=0", "--format=%H %ct", "HEAD"])
                .await
                .ok()
                .and_then(|log| pick_root(&log))
        }
        _ => None,
    };
    ProjectIdentity { origin, root }
}

/// Whether two identities are the same project: equal roots that are known,
/// and equal origins (two missing origins are equal).
pub fn same_project(a: &ProjectIdentity, b: &ProjectIdentity) -> bool {
    a.root.is_some() && a.root == b.root && a.origin == b.origin
}

/// `host[:port]/path` of a remote URL: no scheme, user or credentials, the
/// host lowercased, a port only when not the scheme's default, no trailing
/// `.git` or `/`. A local path (or `file://`) has none.
pub fn normalize_origin(url: &str) -> Option<String> {
    let url = url.trim();
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
        let two = "9c1e5a7d3b2f4e6a8c0d1e2f3a4b5c6d7e8f9a0b 1790970000\n\
                   4171b03ff0d2bd434751f17bc9d34da784f97e72 1790968896\n";
        assert_eq!(
            pick_root(two).as_deref(),
            Some("4171b03ff0d2bd434751f17bc9d34da784f97e72")
        );
        let tie = "9c1e5a7d3b2f4e6a8c0d1e2f3a4b5c6d7e8f9a0b 1790968896\n\
                   4171b03ff0d2bd434751f17bc9d34da784f97e72 1790968896\n";
        assert_eq!(
            pick_root(tie).as_deref(),
            Some("4171b03ff0d2bd434751f17bc9d34da784f97e72")
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

    #[tokio::test]
    async fn a_repository_has_its_origin_and_root_and_a_shallow_or_empty_one_no_root() {
        let repo = crate::git::tests::repo().await;
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
        let root = crate::git::git_text(repo.path(), &["rev-parse", "HEAD"])
            .await
            .unwrap();
        let got = identity(repo.path()).await;
        assert_eq!(got.origin.as_deref(), Some("github.com/acme/shop"));
        assert_eq!(got.root, Some(root));

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
