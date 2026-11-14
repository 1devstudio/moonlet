//! How many git processes one `git.status` runs (X102). Git's own trace2
//! log counts them: every git process writes a `start` event to it. This is
//! the binary's only test, so setting the variable races with nothing.

use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[tokio::test]
async fn a_status_against_the_base_runs_two_git_processes() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "Test"],
        vec!["config", "commit.gpgsign", "false"],
    ] {
        git(&repo, &args);
    }
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    git(&repo, &["checkout", "-qb", "feature"]);
    std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();

    let trace = dir.path().join("trace.json");
    // SAFETY: the runtime of this binary's only test has one thread, and
    // nothing else reads the environment while it is set.
    unsafe { std::env::set_var("GIT_TRACE2_EVENT", &trace) };
    // The first status also finds the worktree's root.
    moonlet_core::git::status(&repo, Some("main"))
        .await
        .unwrap();
    std::fs::write(&trace, "").unwrap();
    let st = moonlet_core::git::status(&repo, Some("main"))
        .await
        .unwrap();
    unsafe { std::env::remove_var("GIT_TRACE2_EVENT") };

    assert_eq!(st.files.len(), 1);
    let log = std::fs::read_to_string(&trace).unwrap();
    let started: Vec<&str> = log
        .lines()
        .filter(|l| l.contains(r#""event":"start""#))
        .collect();
    assert_eq!(
        started.len(),
        2,
        "git processes started:\n{}",
        started.join("\n")
    );
}
