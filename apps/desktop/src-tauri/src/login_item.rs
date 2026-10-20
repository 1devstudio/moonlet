//! The daemon's login item (X56): a launch agent that ships inside
//! `moonlet.app` and that the app registers with `SMAppService`.

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::process::Command;

    /// A key of the bundled agent plist, as `plutil` reads it.
    fn key(path: &str) -> String {
        let plist = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("launchd/dev.onedevstudio.moonlet.moonletd.plist");
        let out = Command::new("plutil")
            .args(["-extract", path, "raw", "-o", "-"])
            .arg(&plist)
            .output()
            .expect("plutil runs");
        assert!(out.status.success(), "{path}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    #[test]
    fn the_bundled_agent_runs_the_bundles_moonletd_as_moonlet() {
        assert_eq!(key("Label"), "dev.onedevstudio.moonlet.moonletd");
        assert_eq!(key("BundleProgram"), "Contents/MacOS/moonletd");
        assert_eq!(key("ProgramArguments.0"), "moonletd");
        assert_eq!(key("ProgramArguments.1"), "daemon");
        assert_eq!(key("RunAtLoad"), "true");
        assert_eq!(key("KeepAlive.SuccessfulExit"), "false");
        assert_eq!(key("ProcessType"), "Interactive");
        assert_eq!(key("AssociatedBundleIdentifiers.0"), "dev.onedevstudio.moonlet");
    }
}
