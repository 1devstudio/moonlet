//! The webview keeps the app's settings (localStorage) in a folder named
//! after the bundle identifier. The rename to moonlet changed the identifier,
//! so the first launch copies jaunt's folder over (X27).

use std::path::Path;

const JAUNT_IDENTIFIER: &str = "dev.onedevstudio.jaunt";
const MOONLET_IDENTIFIER: &str = "dev.onedevstudio.moonlet";

/// Copies jaunt's webview data for the app with `identifier`, before its
/// window opens. Only the released identifier takes jaunt's settings: the
/// e2e build keeps its own.
pub fn carry_over(identifier: &str) {
    if identifier != MOONLET_IDENTIFIER || !cfg!(target_os = "macos") {
        return;
    }
    let Some(home) = dirs::home_dir() else { return };
    let webkit = home.join("Library/WebKit");
    match copy_if_missing(
        &webkit.join(JAUNT_IDENTIFIER),
        &webkit.join(MOONLET_IDENTIFIER),
    ) {
        Ok(true) => tracing::info!("copied jaunt's app settings"),
        Ok(false) => {}
        Err(e) => tracing::warn!("cannot copy jaunt's app settings: {e}"),
    }
}

/// Copies the folder `old` to `new` when `new` does not exist yet. The copy
/// goes to a temporary sibling first, so a half-finished one never counts
/// as done. Returns whether it copied.
fn copy_if_missing(old: &Path, new: &Path) -> std::io::Result<bool> {
    if std::fs::symlink_metadata(new).is_ok() {
        return Ok(false);
    }
    match std::fs::symlink_metadata(old) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    }
    let mut tmp = new.as_os_str().to_owned();
    tmp.push(format!(".copy-{}", std::process::id()));
    let tmp = std::path::PathBuf::from(tmp);
    let _ = std::fs::remove_dir_all(&tmp);
    copy_dir(old, &tmp)?;
    std::fs::rename(&tmp, new)?;
    Ok(true)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&src, &dst)?;
        } else if kind.is_symlink() {
            std::os::unix::fs::symlink(std::fs::read_link(&src)?, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_jaunts_webview_data_once() {
        let webkit = tempfile::tempdir().unwrap();
        let old = webkit.path().join("dev.onedevstudio.jaunt");
        let new = webkit.path().join("dev.onedevstudio.moonlet");
        let store = old.join("WebsiteData/Default/salt/LocalStorage");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("localstorage.sqlite3"), b"settings").unwrap();

        assert!(copy_if_missing(&old, &new).unwrap());
        assert_eq!(
            std::fs::read(new.join("WebsiteData/Default/salt/LocalStorage/localstorage.sqlite3"))
                .unwrap(),
            b"settings"
        );
        assert!(
            store.join("localstorage.sqlite3").exists(),
            "jaunt keeps its own copy"
        );

        std::fs::write(
            new.join("WebsiteData/Default/salt/LocalStorage/localstorage.sqlite3"),
            b"newer",
        )
        .unwrap();
        assert!(
            !copy_if_missing(&old, &new).unwrap(),
            "never overwrites moonlet's data"
        );
        assert_eq!(
            std::fs::read(new.join("WebsiteData/Default/salt/LocalStorage/localstorage.sqlite3"))
                .unwrap(),
            b"newer"
        );
        assert!(
            !copy_if_missing(&webkit.path().join("missing"), &webkit.path().join("x")).unwrap()
        );
    }
}
