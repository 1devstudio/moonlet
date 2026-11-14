//! A host's Claude settings (X103): `~/.moonlet/claude.toml`, read and
//! written by the daemon for Settings › Agents.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use moonlet_proto::types::ClaudeSettings;

/// The file beside `state.json`, chats and `git.toml` in `home`.
pub fn path_in(home: &Path) -> PathBuf {
    home.join("claude.toml")
}

pub fn path() -> PathBuf {
    path_in(&crate::paths::home())
}

/// The settings in `file`. A missing file, or one that does not parse,
/// gives the defaults.
pub fn load(file: &Path) -> ClaudeSettings {
    let Ok(text) = std::fs::read_to_string(file) else {
        return ClaudeSettings::default();
    };
    toml::from_str(&text).unwrap_or_else(|e| {
        tracing::warn!("{} does not parse, using the defaults: {e}", file.display());
        ClaudeSettings::default()
    })
}

/// One update at a time, so two quick changes both land.
static WRITE: Mutex<()> = Mutex::new(());

/// Applies `patch` (some of the settings, as JSON) over the saved ones and
/// saves the result.
pub fn update(file: &Path, patch: serde_json::Value) -> Result<ClaudeSettings> {
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut merged = serde_json::to_value(load(file))?;
    let (Some(to), Some(from)) = (merged.as_object_mut(), patch.as_object()) else {
        anyhow::bail!("Claude settings must be an object");
    };
    to.extend(from.clone());
    let settings: ClaudeSettings =
        serde_json::from_value(merged).context("invalid Claude settings")?;
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
    fn chrome_is_off_without_a_file_or_with_one_that_does_not_parse() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("claude.toml");
        assert!(!load(&file).chrome);
        std::fs::write(&file, "chrome = [\n").unwrap();
        assert!(!load(&file).chrome);
        std::fs::write(&file, "").unwrap();
        assert!(!load(&file).chrome);
    }

    #[test]
    fn turning_chrome_on_is_saved_in_claude_toml() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("claude.toml");
        assert!(update(&file, json!({"chrome": true})).unwrap().chrome);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "chrome = true\n");
        assert!(load(&file).chrome);
    }

    #[test]
    fn an_update_of_the_wrong_type_is_refused_and_not_saved() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("claude.toml");
        assert!(update(&file, json!({"chrome": "yes"})).is_err());
        assert!(update(&file, json!(true)).is_err());
        assert!(!file.exists());
    }
}
