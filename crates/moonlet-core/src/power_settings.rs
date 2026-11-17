//! A host's power settings (X73): `~/.moonlet/power.toml`, read and written
//! by the daemon for Settings › General. Each host keeps its own; they do
//! not sync between members.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use moonlet_proto::types::PowerSettings;

/// The file beside `claude.toml` in `home`.
pub fn path_in(home: &Path) -> PathBuf {
    home.join("power.toml")
}

pub fn path() -> PathBuf {
    path_in(&crate::paths::home())
}

/// The settings in `file`. A missing file, or one that does not parse,
/// gives the defaults: the Mac kept awake while agents work.
pub fn load(file: &Path) -> PowerSettings {
    let Ok(text) = std::fs::read_to_string(file) else {
        return PowerSettings::default();
    };
    toml::from_str(&text).unwrap_or_else(|e| {
        tracing::warn!("{} does not parse, using the defaults: {e}", file.display());
        PowerSettings::default()
    })
}

/// One update at a time, so two quick changes both land.
static WRITE: Mutex<()> = Mutex::new(());

/// Applies `patch` (some of the settings, as JSON) over the saved ones and
/// saves the result.
pub fn update(file: &Path, patch: serde_json::Value) -> Result<PowerSettings> {
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut merged = serde_json::to_value(load(file))?;
    let (Some(to), Some(from)) = (merged.as_object_mut(), patch.as_object()) else {
        anyhow::bail!("power settings must be an object");
    };
    to.extend(from.clone());
    let settings: PowerSettings = serde_json::from_value(merged).context("invalid power settings")?;
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
    fn keeping_the_mac_awake_is_on_without_a_file_and_off_once_turned_off() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("power.toml");
        assert!(load(&file).keep_awake);
        std::fs::write(&file, "keep_awake = [\n").unwrap();
        assert!(load(&file).keep_awake);
        assert!(!update(&file, json!({"keep_awake": false})).unwrap().keep_awake);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep_awake = false\n");
        assert!(!load(&file).keep_awake);
        assert!(update(&file, json!({"keep_awake": "no"})).is_err());
        assert!(!load(&file).keep_awake);
    }
}
