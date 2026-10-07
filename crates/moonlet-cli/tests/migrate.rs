//! X27: the first moonlet binary to run moves jaunt's `~/.jaunt` to
//! `~/.moonlet` and leaves a symlink behind.

use std::process::Command;

#[test]
fn the_cli_moves_the_jaunt_folder_on_start() {
    let user = tempfile::tempdir().unwrap();
    let legacy = user.path().join(".jaunt");
    std::fs::create_dir_all(legacy.join("logs")).unwrap();
    std::fs::write(legacy.join("state.json"), r#"{"sessions":[]}"#).unwrap();

    // `project ls` with no daemon fails, after the move.
    let _ = Command::new(env!("CARGO_BIN_EXE_moonlet"))
        .args(["project", "ls"])
        .env("HOME", user.path())
        .env_remove("MOONLET_HOME")
        .env_remove("JAUNT_HOME")
        .env_remove("MOONLET_SOCK")
        .env_remove("JAUNT_SOCK")
        .output()
        .unwrap();

    let moved = user.path().join(".moonlet/state.json");
    assert_eq!(
        std::fs::read_to_string(moved).unwrap(),
        r#"{"sessions":[]}"#
    );
    assert!(
        std::fs::symlink_metadata(&legacy)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
