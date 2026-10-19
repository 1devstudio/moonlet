//! A host's Git settings (X55): `~/.moonlet/git.toml`, read and written
//! by the daemon for Settings › Git.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use moonlet_proto::types::GitSettings;

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
    fn an_update_of_the_wrong_type_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("git.toml");
        assert!(update(&file, json!({"stage_all": "yes"})).is_err());
        assert!(!file.exists());
    }
}
