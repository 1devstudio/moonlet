//! A host's Git settings (X55): `~/.moonlet/git.toml`, read and written
//! by the daemon for Settings › Git.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use moonlet_proto::types::GitSettings;
#[cfg(test)]
use moonlet_proto::types::StartFrom;

pub fn path() -> PathBuf {
    crate::paths::home().join("git.toml")
}

/// The settings in `file`. A missing file, or one that does not parse,
/// gives the defaults.
pub fn load(file: &Path) -> GitSettings {
    let Ok(text) = std::fs::read_to_string(file) else {
        return GitSettings::default();
    };
    toml::from_str(&text).unwrap_or_else(|e| {
        tracing::warn!("{} does not parse, using the defaults: {e}", file.display());
        GitSettings::default()
    })
}

/// Why git would reject branches named `<prefix>…`, if it would.
pub fn prefix_error(p: &str) -> Option<&'static str> {
    if p.chars()
        .any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c))
    {
        return Some("Branch names cannot hold spaces or ~ ^ : ? * [ \\");
    }
    if p.contains("..") || p.contains("//") || p.contains("@{") {
        return Some("Branch names cannot hold .., // or @{");
    }
    if p.starts_with(['/', '.', '-']) {
        return Some("Start with a letter or digit.");
    }
    None
}

/// One update at a time, so two quick changes both land.
static WRITE: Mutex<()> = Mutex::new(());

/// Applies `patch` (some of the settings, as JSON) over the saved ones and
/// saves the result.
pub fn update(file: &Path, patch: serde_json::Value) -> Result<GitSettings> {
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut merged = serde_json::to_value(load(file))?;
    if let (Some(to), Some(from)) = (merged.as_object_mut(), patch.as_object()) {
        to.extend(from.clone());
    } else {
        anyhow::bail!("Git settings must be an object");
    }
    let settings: GitSettings = serde_json::from_value(merged).context("invalid Git settings")?;
    if let Some(e) = prefix_error(&settings.branch_prefix) {
        anyhow::bail!(e);
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("toml.tmp");
    std::fs::write(&tmp, toml::to_string(&settings)?)?;
    std::fs::rename(&tmp, file).with_context(|| format!("cannot save {}", file.display()))?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_missing_file_gives_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let s = load(&dir.path().join("git.toml"));
        assert!(s.stage_all);
        assert!(!s.draft_prs);
    }

    #[test]
    fn keys_missing_from_the_file_take_their_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("git.toml");
        std::fs::write(&file, "draft_prs = true\n").unwrap();
        let s = load(&file);
        assert!(s.draft_prs);
        assert!(s.stage_all);
    }

    #[test]
    fn a_file_that_does_not_parse_gives_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("git.toml");
        std::fs::write(&file, "stage_all = [\n").unwrap();
        assert_eq!(load(&file), GitSettings::default());
    }

    #[test]
    fn an_update_changes_only_what_it_names_and_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("git.toml");
        update(&file, json!({"stage_all": false})).unwrap();
        let s = update(&file, json!({"draft_prs": true})).unwrap();
        assert!(!s.stage_all);
        assert!(s.draft_prs);
        assert_eq!(load(&file), s);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("draft_prs = true"), "{text}");
    }

    #[test]
    fn new_branches_are_prefixed_moonlet_and_start_from_the_local_base() {
        let s = GitSettings::default();
        assert_eq!(s.branch_prefix, "moonlet/");
        assert_eq!(s.start_from, StartFrom::Local);
    }

    #[test]
    fn a_prefix_git_would_reject_says_why() {
        for ok in ["", "moonlet/", "marcin/", "feat/", "a.b-c_d/"] {
            assert_eq!(prefix_error(ok), None, "{ok}");
        }
        let chars = Some("Branch names cannot hold spaces or ~ ^ : ? * [ \\");
        for bad in ["my prefix/", "a~", "a^", "a:", "a?", "a*", "a[", "a\\b"] {
            assert_eq!(prefix_error(bad), chars, "{bad}");
        }
        let seqs = Some("Branch names cannot hold .., // or @{");
        for bad in ["a..b/", "a//", "a@{"] {
            assert_eq!(prefix_error(bad), seqs, "{bad}");
        }
        for bad in ["/a", ".a", "-a"] {
            assert_eq!(
                prefix_error(bad),
                Some("Start with a letter or digit."),
                "{bad}"
            );
        }
    }

    #[test]
    fn an_invalid_prefix_is_not_saved() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("git.toml");
        let e = update(&file, json!({"branch_prefix": "my prefix/"})).unwrap_err();
        assert_eq!(
            e.to_string(),
            "Branch names cannot hold spaces or ~ ^ : ? * [ \\"
        );
        assert!(!file.exists());
    }

    #[test]
    fn an_update_of_the_wrong_type_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("git.toml");
        assert!(update(&file, json!({"stage_all": "yes"})).is_err());
        assert!(!file.exists());
    }
}
