//! Claude profiles (X33): a Claude Code config folder per workspace, passed
//! to Claude as `CLAUDE_CONFIG_DIR`.

use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
pub use moonlet_proto::types::ProfileAccount;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatus {
    #[serde(default)]
    logged_in: bool,
    email: Option<String>,
    org_name: Option<String>,
    subscription_type: Option<String>,
}

/// Parses `claude auth status --json`.
pub fn parse_auth_status(text: &str) -> Result<ProfileAccount> {
    let s: AuthStatus = serde_json::from_str(text).context("unreadable `claude auth status` output")?;
    Ok(ProfileAccount {
        logged_in: s.logged_in,
        email: s.email.filter(|_| s.logged_in),
        org_name: s.org_name.filter(|_| s.logged_in),
        subscription: s.subscription_type.filter(|_| s.logged_in),
    })
}

/// The variable Claude Code reads its config folder from.
pub const CONFIG_DIR_VAR: &str = "CLAUDE_CONFIG_DIR";

/// Creates a profile folder, private as Claude keeps settings and history in
/// it. An existing folder is left as it is.
pub fn ensure_folder(dir: &Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    if dir.is_dir() {
        return Ok(());
    }
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .with_context(|| format!("cannot create {}", dir.display()))
}

/// Who `claude` is signed in as with config folder `dir` (`None`: the
/// default), from `claude auth status --json`.
pub async fn account(env: &std::collections::BTreeMap<String, String>, dir: Option<&str>) -> Result<ProfileAccount> {
    let mut env = env.clone();
    if let Some(d) = dir {
        env.insert(CONFIG_DIR_VAR.into(), d.into());
    }
    let exe = crate::chat::runtime::resolve("claude", &env).context("claude not found on PATH")?;
    let run = tokio::process::Command::new(exe)
        .args(["auth", "status", "--json"])
        .env_clear()
        .envs(&env)
        .stdin(std::process::Stdio::null())
        .output();
    let out = tokio::time::timeout(std::time::Duration::from_secs(15), run)
        .await
        .context("`claude auth status` timed out")??;
    parse_auth_status(&String::from_utf8_lossy(&out.stdout))
}

/// What a profile folder is checked against.
pub struct FolderRules<'a> {
    pub home: &'a Path,
    /// `~/.claude`, and the daemon's own `CLAUDE_CONFIG_DIR` when set.
    pub defaults: Vec<PathBuf>,
    /// Folders of the other profiles.
    pub taken: &'a [PathBuf],
    /// Project folders: a profile is never kept inside a repo.
    pub projects: &'a [PathBuf],
    pub exists: &'a dyn Fn(&Path) -> bool,
}

/// The folder for a new profile: `path` when given (`~` expands), else
/// `~/.claude-<slug of name>`, made unique.
pub fn profile_folder(path: Option<&str>, name: &str, r: &FolderRules) -> Result<PathBuf> {
    let dir = match path.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => {
            let p = match p.strip_prefix('~') {
                Some(rest) => r.home.join(rest.trim_start_matches('/')),
                None => PathBuf::from(p),
            };
            if !p.is_absolute() {
                bail!("the folder must be an absolute path");
            }
            normalize(&p)
        }
        None => {
            let slug = crate::git::slug(name);
            let base = r.home.join(format!(".claude-{}", if slug.is_empty() { "profile" } else { &slug }));
            let free = |p: &Path| !(r.exists)(p) && !r.taken.iter().any(|t| t == p);
            let mut dir = base.clone();
            let mut n = 2;
            while !free(&dir) {
                dir = PathBuf::from(format!("{}-{n}", base.display()));
                n += 1;
            }
            dir
        }
    };
    if r.defaults.iter().any(|d| normalize(d) == dir) {
        bail!("{} is the default profile", dir.display());
    }
    if r.taken.iter().any(|t| normalize(t) == dir) {
        bail!("another profile uses {}", dir.display());
    }
    if r.projects.iter().any(|p| dir.starts_with(normalize(p))) {
        bail!("{} is inside a project", dir.display());
    }
    Ok(dir)
}

/// `a/./b/../c/` → `a/c`, without touching the disk.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `claude auth status --json` (Claude Code 2.1.292) for a signed-in
    /// profile, with the account details replaced.
    const SIGNED_IN: &str = r#"{
 "loggedIn": true,
 "authMethod": "claude.ai",
 "apiProvider": "firstParty",
 "analyticsDisabled": false,
 "projectsDirectory": "/Users/jane/.claude-work/projects",
 "configDirectory": "/Users/jane/.claude-work",
 "email": "jane@acme.com",
 "orgId": "00000000-0000-4000-8000-000000000000",
 "orgName": "Acme",
 "subscriptionType": "team"
}"#;

    /// The same for an empty config folder.
    const SIGNED_OUT: &str = r#"{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty",
  "analyticsDisabled": false,
  "projectsDirectory": "/tmp/moonlet-profile-spike.PqXb/projects",
  "configDirectory": "/tmp/moonlet-profile-spike.PqXb"
}"#;

    #[test]
    fn reads_the_account_of_a_signed_in_profile() {
        assert_eq!(
            parse_auth_status(SIGNED_IN).unwrap(),
            ProfileAccount {
                logged_in: true,
                email: Some("jane@acme.com".into()),
                org_name: Some("Acme".into()),
                subscription: Some("team".into()),
            }
        );
    }

    fn rules<'a>(taken: &'a [PathBuf], projects: &'a [PathBuf]) -> FolderRules<'a> {
        FolderRules {
            home: Path::new("/Users/jane"),
            defaults: vec![PathBuf::from("/Users/jane/.claude")],
            taken,
            projects,
            exists: &|p: &Path| p == Path::new("/Users/jane/.claude-work"),
        }
    }

    #[test]
    fn a_new_profile_gets_a_claude_folder_named_after_it() {
        let none: [PathBuf; 0] = [];
        assert_eq!(profile_folder(None, "Personal stuff", &rules(&none, &none)).unwrap(), PathBuf::from("/Users/jane/.claude-personal-stuff"));
        // ~/.claude-work is on disk already, so the next free name is used.
        assert_eq!(profile_folder(None, "Work", &rules(&none, &none)).unwrap(), PathBuf::from("/Users/jane/.claude-work-2"));
    }

    #[test]
    fn an_existing_folder_can_be_used_with_a_home_relative_path() {
        let none: [PathBuf; 0] = [];
        assert_eq!(profile_folder(Some("~/.claude-work"), "Work", &rules(&none, &none)).unwrap(), PathBuf::from("/Users/jane/.claude-work"));
        assert_eq!(profile_folder(Some("/Volumes/x/claude/"), "X", &rules(&none, &none)).unwrap(), PathBuf::from("/Volumes/x/claude"));
    }

    #[test]
    fn refuses_the_default_folder_a_taken_one_a_project_and_relative_paths() {
        let taken = [PathBuf::from("/Users/jane/.claude-work")];
        let projects = [PathBuf::from("/Users/jane/src/api")];
        let err = |p: &str| profile_folder(Some(p), "X", &rules(&taken, &projects)).unwrap_err().to_string();
        assert_eq!(err("~/.claude"), "/Users/jane/.claude is the default profile");
        assert_eq!(err("/Users/jane/.claude-work"), "another profile uses /Users/jane/.claude-work");
        assert_eq!(err("/Users/jane/src/api/.claude"), "/Users/jane/src/api/.claude is inside a project");
        assert_eq!(err("claude-x"), "the folder must be an absolute path");
    }

    #[test]
    fn a_signed_out_profile_has_no_account() {
        assert_eq!(
            parse_auth_status(SIGNED_OUT).unwrap(),
            ProfileAccount { logged_in: false, email: None, org_name: None, subscription: None }
        );
        assert!(parse_auth_status("not json").is_err());
    }
}
