//! A failing daemon test keeps its daemons' logs; a passing one leaves
//! nothing behind (tests/common/logs.rs).
//!
//! Each test here runs a probe: a thread named as a test would be, which
//! starts daemons and then panics or returns.

mod common;

use std::path::PathBuf;
use std::sync::Mutex;

use common::Daemon;
use common::logs::{self, Private};
use serde_json::json;

/// The probes share the folder of hard links: one at a time.
static ONE: Mutex<()> = Mutex::new(());

/// Runs `body` on a thread named `test`, as libtest runs a test; gives
/// whether it passed.
fn probe<F>(test: &str, body: F) -> bool
where
    F: FnOnce() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> + Send + 'static,
{
    std::thread::Builder::new()
        .name(test.to_string())
        .spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(body())
        })
        .unwrap()
        .join()
        .is_ok()
}

/// A daemon whose worker is called `name`.
async fn named(name: &str) -> Daemon {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("link.json"),
        json!({ "central": null, "worker": { "id": "0f6c2a9e-9d2b-4f5e-8f1a-2b3c4d5e6f70", "name": name, "enabled": false } })
            .to_string(),
    )
    .unwrap();
    Daemon::start(home, &[]).await
}


#[test]
fn a_failing_test_keeps_each_daemons_log_and_all_of_them_in_time_order() {
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let homes = std::sync::Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let seen = homes.clone();
    let passed = probe("a_probe_with_two_daemons_that_fails", move || {
        Box::pin(async move {
            let mini = named("studio-mini").await;
            let book = named("MacBook").await;
            // At the test level a request the daemon answered is a line.
            let _: serde_json::Value = mini
                .call("workspace.create", json!({ "name": "Acme", "color": "clay" }))
                .await;
            seen.lock().unwrap().extend([mini.home.path().to_path_buf(), book.home.path().to_path_buf()]);
            panic!("the probe fails");
        })
    });
    assert!(!passed);

    let dir = logs::kept_dir("a_probe_with_two_daemons_that_fails");
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    files.sort();
    assert_eq!(files, ["MacBook.log", "all.log", "studio-mini.log"]);

    let mini = std::fs::read_to_string(dir.join("studio-mini.log")).unwrap();
    assert!(mini.contains("INFO moonletd: moonletd listening"), "{mini}");
    assert!(mini.contains(r#"DEBUG moonletd::daemon: answered client=moonlet-app"#), "{mini}");
    assert!(mini.contains(r#"method="workspace.create""#), "{mini}");
    let all = std::fs::read_to_string(dir.join("all.log")).unwrap();
    let starts: Vec<&str> = all
        .lines()
        .filter(|l| l.contains("moonletd listening"))
        .map(|l| l.split_whitespace().nth(1).unwrap())
        .collect();
    assert_eq!(starts, ["studio-mini", "MacBook"], "{all}");
    // A message's next lines carry no time of their own.
    let stamps: Vec<&str> = all
        .lines()
        .map(|l| l.split(' ').next().unwrap())
        .filter(|s| !s.is_empty())
        .collect();
    assert!(stamps.windows(2).all(|w| w[0] <= w[1]), "{all}");

    // The scratch homes went with the test, and so did the links.
    for home in homes.lock().unwrap().iter() {
        assert!(!home.exists(), "{} was left", home.display());
    }
    assert_eq!(logs::links_left(), 0);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_daemon_let_go_before_the_test_failed_still_has_its_log_kept() {
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let passed = probe("a_probe_that_lets_its_daemon_go_and_then_fails", || {
        Box::pin(async {
            let first = named("studio-mini").await;
            drop(first);
            // A second daemon of the same name.
            let _second = named("studio-mini").await;
            panic!("the probe fails");
        })
    });
    assert!(!passed);
    let dir = logs::kept_dir("a_probe_that_lets_its_daemon_go_and_then_fails");
    for name in ["studio-mini.log", "studio-mini-2.log"] {
        let log = std::fs::read_to_string(dir.join(name)).unwrap();
        assert!(log.contains("moonletd listening"), "{name}: {log}");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_passing_test_leaves_no_logs_behind() {
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let passed = probe("a_probe_that_passes", || {
        Box::pin(async {
            let d = named("studio-mini").await;
            let _: serde_json::Value = d.call("daemon.info", json!({})).await;
        })
    });
    assert!(passed);
    assert!(!logs::kept_dir("a_probe_that_passes").exists());
    assert_eq!(logs::links_left(), 0);
}

#[test]
fn two_logs_are_merged_by_time_each_line_tagged_with_its_daemon() {
    let mini = "2026-11-19T13:12:23.100000Z  INFO moonletd::link: linked\n\
                2026-11-19T13:12:23.300000Z DEBUG moonletd::sync: a sync round\n\
                its second line\n";
    let book = "2026-11-19T13:12:23.200000Z  INFO moonletd::link: linking\n";
    let all = logs::merge(&[("studio-mini".into(), mini.into()), ("MacBook".into(), book.into())]);
    assert_eq!(
        all,
        "2026-11-19T13:12:23.100000Z studio-mini  INFO moonletd::link: linked\n\
         2026-11-19T13:12:23.200000Z MacBook      INFO moonletd::link: linking\n\
         2026-11-19T13:12:23.300000Z studio-mini DEBUG moonletd::sync: a sync round\n                            studio-mini its second line\n"
    );
}

#[test]
fn a_kept_log_names_no_home_folder_or_host_of_this_machine() {
    let private = Private::of(vec![
        ("/Users/alex".into(), "~"),
        ("alexs-mac".into(), "this-host"),
        ("Alex's MacBook Pro".into(), "this-host"),
    ]);
    assert_eq!(
        private.scrub("git -C /Users/alex/src/shop on alexs-mac (Alex's MacBook Pro)"),
        "git -C ~/src/shop on this-host (this-host)"
    );
}

#[test]
fn the_end_of_a_long_log_is_its_last_lines_within_the_bound() {
    assert_eq!(logs::tail("a\nb\nc\nd\n", 2, 100), "c\nd");
    assert_eq!(logs::tail("aaaa\nbbbb\ncccc\n", 10, 10), "bbbb\ncccc");
}
