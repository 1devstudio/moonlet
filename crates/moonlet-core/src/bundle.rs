//! A Mac app bundle's version, read from its `Info.plist` (X69): the daemon
//! checks an update's bundle with it, and the app compares the bundle on disk
//! with itself after another Mac updated this one.

use std::path::Path;

/// `CFBundleShortVersionString` of an `Info.plist`.
pub fn short_version(plist: &str) -> Option<String> {
    let after = &plist[plist.find("<key>CFBundleShortVersionString</key>")?..];
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")?;
    Some(after[start..start + end].trim().to_string())
}

/// The version of the bundle that holds binary `exe`
/// (`<app>/Contents/MacOS/<exe>`); `None` outside a bundle, as for a dev build.
pub fn version_of(exe: &Path) -> Option<String> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    if macos.file_name()? != "MacOS" || contents.file_name()? != "Contents" {
        return None;
    }
    short_version(&std::fs::read_to_string(contents.join("Info.plist")).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Info.plist` as Tauri writes it, trimmed.
    const PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>moonlet</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.34</string>
	<key>CFBundleVersion</key>
	<string>0.1.34</string>
</dict>
</plist>
"#;

    #[test]
    fn the_short_version_string_is_the_version() {
        assert_eq!(short_version(PLIST).as_deref(), Some("0.1.34"));
        assert_eq!(short_version("<plist><dict></dict></plist>"), None);
    }

    #[test]
    fn a_binary_in_a_bundle_has_its_bundle_version_and_others_none() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("moonlet.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/Info.plist"), PLIST).unwrap();
        assert_eq!(version_of(&app.join("Contents/MacOS/moonlet")).as_deref(), Some("0.1.34"));
        assert_eq!(version_of(&dir.path().join("target/debug/moonlet")), None);
    }
}
