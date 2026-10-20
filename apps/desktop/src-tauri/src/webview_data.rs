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
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        entries.push((
            entry.file_name().to_string_lossy().into_owned(),
            entry.file_type()?,
        ));
    }
    // Databases first: a snapshot replaces the database's WAL files.
    let mut snapshots = Vec::new();
    for (name, kind) in &entries {
        if kind.is_file() && is_database(name) && snapshot(&from.join(name), &to.join(name)) {
            snapshots.push(name.clone());
        }
    }
    for (name, kind) in &entries {
        let (src, dst) = (from.join(name), to.join(name));
        let wal_of = name
            .strip_suffix("-wal")
            .or_else(|| name.strip_suffix("-shm"));
        if snapshots.contains(name) || wal_of.is_some_and(|db| snapshots.iter().any(|s| s == db)) {
            continue;
        }
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

/// WebKit's SQLite databases (localStorage, IndexedDB and others).
fn is_database(name: &str) -> bool {
    name.ends_with(".sqlite3") || name.ends_with(".db")
}

/// A consistent copy of a database jaunt.app may still be writing to, WAL
/// included, through SQLite's backup. False when that is not possible; the
/// files are then copied as they are.
fn snapshot(src: &Path, dst: &Path) -> bool {
    let dst_text = dst.to_string_lossy();
    if dst_text.contains('\'') {
        return false;
    }
    std::process::Command::new("/usr/bin/sqlite3")
        .arg("-readonly")
        .arg(src)
        .arg(format!(".backup '{dst_text}'"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
        && dst.exists()
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

    /// jaunt.app may still be running and writing its settings: each
    /// database is copied as a consistent snapshot, without its WAL files.
    #[test]
    fn databases_open_in_jaunt_are_copied_as_snapshots() {
        use std::io::{BufRead, Write};
        let webkit = tempfile::tempdir().unwrap();
        let old = webkit.path().join("dev.onedevstudio.jaunt");
        let new = webkit.path().join("dev.onedevstudio.moonlet");
        let store = old.join("LocalStorage");
        std::fs::create_dir_all(&store).unwrap();
        let db = store.join("localstorage.sqlite3");
        // A live writer: its rows sit in the WAL while it stays open.
        let mut writer = std::process::Command::new("/usr/bin/sqlite3")
            .arg(&db)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = writer.stdin.as_mut().unwrap();
        writeln!(stdin, "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ItemTable (key TEXT, value BLOB); INSERT INTO ItemTable VALUES ('moonlet.settings', 'dark'); SELECT 'ready';").unwrap();
        stdin.flush().unwrap();
        // The WAL fills before the INSERT commits; the writer's answer to the
        // last statement means every row before it is in.
        let stdout = std::io::BufReader::new(writer.stdout.take().unwrap());
        assert!(
            stdout.lines().map(Result::unwrap).any(|l| l == "ready"),
            "the writer quit"
        );
        assert!(
            std::fs::metadata(store.join("localstorage.sqlite3-wal")).is_ok_and(|m| m.len() > 0),
            "the row waits in the WAL"
        );

        assert!(copy_if_missing(&old, &new).unwrap());
        drop(writer.stdin.take());
        let _ = writer.wait();

        let copied = new.join("LocalStorage");
        assert!(!copied.join("localstorage.sqlite3-wal").exists());
        assert!(!copied.join("localstorage.sqlite3-shm").exists());
        let out = std::process::Command::new("/usr/bin/sqlite3")
            .arg(copied.join("localstorage.sqlite3"))
            .arg("SELECT value FROM ItemTable WHERE key = 'moonlet.settings';")
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "dark\n");
    }
}
