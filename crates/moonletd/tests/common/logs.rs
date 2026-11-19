//! A failing test keeps the logs of every daemon it started.
//!
//! Each test daemon's command goes through [`KeepLogs::keep_logs`]: it logs
//! at [`LEVEL`], its stderr goes to `logs/stderr.log` beside its
//! `logs/moonletd.log`, and both files get a hard link outside its home, so
//! they outlive a scratch home a test let go of before it failed. When a
//! test panics, a panic hook copies its daemons' logs to
//! `target/tmp/test-logs/<test file>/<test>/`: one file per daemon, named as
//! the test names it (the worker name in its `link.json`, else `daemon`),
//! and `all.log`, every daemon's lines in time order, each tagged with its
//! daemon's name. The tail of `all.log` goes to the test's own output. A
//! passing test leaves nothing: its links go when its thread ends.
//!
//! Kept logs are uploaded by CI, so the copy takes out this machine's home
//! folder, host name and computer name (the repository is public).
#![allow(dead_code)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, Once};
use std::thread::ThreadId;

/// The daemon's own crates at debug, everything else at info: enough to
/// follow a link, a sync round, a routed run and a session move. A
/// `MOONLET_LOG` the test or its command sets wins.
pub const LEVEL: &str = "info,moonletd=debug,moonlet_core=debug,moonlet_link=debug,moonlet_cloud=debug";

/// A `tailscale` that is not there.
const NO_TAILSCALE: &str = "/nonexistent/tailscale";

/// How much of `all.log` a failing test prints.
const TAIL_LINES: usize = 200;
const TAIL_BYTES: usize = 48 * 1024;
/// How much of each daemon's log is kept: its last part, if larger.
const KEEP_BYTES: u64 = 8 * 1024 * 1024;

/// One daemon a test started.
struct Started {
    /// The test's name: libtest names each test's thread after it.
    test: String,
    thread: ThreadId,
    name: String,
    home: PathBuf,
    /// Hard links to its `moonletd.log` and `stderr.log` outside its home,
    /// or the home's own files where no link could be made.
    log: PathBuf,
    stderr: PathBuf,
    /// Whether `log` and `stderr` are links, which go with the test.
    linked: bool,
}

static STARTED: Mutex<Vec<Started>> = Mutex::new(Vec::new());
/// Folders whose subfolders' `home` gets a daemon the test did not start
/// itself, such as the fake cloud provider's machines (X63).
static FOLDERS: Mutex<Vec<(String, ThreadId, PathBuf)>> = Mutex::new(Vec::new());
static KEPT: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static HOOK: Once = Once::new();

/// Gives each test thread's links back when the thread ends, which libtest
/// does once the test is over, passed or failed.
struct Forget;
impl Drop for Forget {
    fn drop(&mut self) {
        let me = std::thread::current().id();
        FOLDERS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(_, t, _)| *t != me);
        let mut started = STARTED.lock().unwrap_or_else(|e| e.into_inner());
        started.retain(|s| {
            if s.thread != me {
                return true;
            }
            // Never the home's own files: only the links.
            if s.linked {
                let _ = std::fs::remove_file(&s.log);
                let _ = std::fs::remove_file(&s.stderr);
            }
            false
        });
    }
}
thread_local! {
    static FORGET: Forget = const { Forget };
}

/// Where failing tests' logs go: `MOONLET_TEST_LOGS`, for runs of one
/// test side by side, or `target/tmp/test-logs`.
pub fn root() -> PathBuf {
    std::env::var_os("MOONLET_TEST_LOGS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("test-logs"))
}

/// Where the logs of `test` in this test file go if it fails, under its
/// package (moonletd and moonlet-cli both have `tests/exec.rs`). A test in
/// a module gets `module.test`: CI artifacts take no `:` in a path.
pub fn kept_dir(test: &str) -> PathBuf {
    let test: String = test
        .replace("::", ".")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '-' })
        .collect();
    root().join(env!("CARGO_PKG_NAME")).join(env!("CARGO_CRATE_NAME")).join(test)
}

fn links_dir() -> PathBuf {
    std::env::temp_dir().join("moonlet-test-logs")
}

/// This process's links that are still there: none once every test that
/// started a daemon has ended.
pub fn links_left() -> usize {
    let mine = format!("{}-", std::process::id());
    std::fs::read_dir(links_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&mine))
        .count()
}

/// Which daemon a test started is whose is known by the thread that started
/// it: a daemon started from another thread (a `tokio::spawn` task on a
/// worker thread) is not kept.
pub trait KeepLogs {
    /// Makes this daemon command, whose `MOONLET_HOME` is `home`, one whose
    /// logs a failing test keeps. Call it last before spawning: it sets
    /// stderr. Unless the command names a `tailscale`, the daemon gets
    /// none, so it never runs this machine's own (X39), and no tailnet
    /// address or peer of it can reach a kept log.
    fn keep_logs(&mut self, home: &Path) -> &mut Self;
}

impl KeepLogs for Command {
    fn keep_logs(&mut self, home: &Path) -> &mut Self {
        if !self.get_envs().any(|(k, _)| k == "MOONLET_LOG") && std::env::var_os("MOONLET_LOG").is_none() {
            self.env("MOONLET_LOG", LEVEL);
        }
        if !self.get_envs().any(|(k, _)| k == "MOONLET_TAILSCALE") {
            self.env("MOONLET_TAILSCALE", NO_TAILSCALE);
        }
        match started(home) {
            Some(stderr) => self.stderr(stderr),
            None => self,
        }
    }
}

impl KeepLogs for tokio::process::Command {
    fn keep_logs(&mut self, home: &Path) -> &mut Self {
        if !self.as_std().get_envs().any(|(k, _)| k == "MOONLET_LOG") && std::env::var_os("MOONLET_LOG").is_none() {
            self.env("MOONLET_LOG", LEVEL);
        }
        if !self.as_std().get_envs().any(|(k, _)| k == "MOONLET_TAILSCALE") {
            self.env("MOONLET_TAILSCALE", NO_TAILSCALE);
        }
        match started(home) {
            Some(stderr) => self.stderr(stderr),
            None => self,
        }
    }
}

/// Keeps, with the test's own daemons, those of `<dir>/<machine>/home`,
/// each named `machine-<machine>`, as the fake cloud provider starts them.
pub fn machines_in(dir: &Path) {
    install_hook();
    FORGET.with(|_| {});
    let thread = std::thread::current();
    FOLDERS.lock().unwrap_or_else(|e| e.into_inner()).push((
        thread.name().unwrap_or("").to_string(),
        thread.id(),
        dir.to_path_buf(),
    ));
}

fn install_hook() {
    HOOK.call_once(|| {
        let before = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            before(info);
            keep_current();
        }));
    });
}

/// Notes a daemon started on `home`; gives its stderr file.
fn started(home: &Path) -> Option<Stdio> {
    install_hook();
    let logs = home.join("logs");
    if !logs.exists() {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&logs)
            .ok()?;
    }
    let open = |p: &Path| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .ok()
    };
    let log = logs.join("moonletd.log");
    open(&log)?;
    let stderr = open(&logs.join("stderr.log"))?;

    let thread = std::thread::current();
    let test = thread.name().unwrap_or("").to_string();
    let mut all = STARTED.lock().unwrap_or_else(|e| e.into_inner());
    let again = all.iter().any(|s| s.home == home);
    if !again {
        if !all.iter().any(|s| s.test == test) {
            // A test run again starts without the logs of a failed run.
            let _ = std::fs::remove_dir_all(kept_dir(&test));
        }
        FORGET.with(|_| {});
        let base = name_in(home);
        let mut name = base.clone();
        let mut n = 1;
        while all.iter().any(|s| s.test == test && s.name == name) {
            n += 1;
            name = format!("{base}-{n}");
        }
        let dir = links_dir();
        let _ = std::fs::create_dir_all(&dir);
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let stem = format!("{}-{seq}", std::process::id());
        let link = |from: &Path, ext: &str| {
            let to = dir.join(format!("{stem}.{ext}"));
            let _ = std::fs::remove_file(&to);
            std::fs::hard_link(from, &to).ok().map(|()| to)
        };
        let err = logs.join("stderr.log");
        // Another file system (no hard link): the home's own files are
        // read, while the home is there.
        let (log, stderr, linked) = match (link(&log, "log"), link(&err, "stderr")) {
            (Some(l), Some(e)) => (l, e, true),
            (l, e) => {
                for p in [l, e].into_iter().flatten() {
                    let _ = std::fs::remove_file(p);
                }
                (log, err, false)
            }
        };
        all.push(Started {
            test,
            thread: thread.id(),
            name,
            home: home.to_path_buf(),
            log,
            stderr,
            linked,
        });
    }
    Some(Stdio::from(stderr))
}

/// The test's name for the daemon on `home`: its worker's name.
fn name_in(home: &Path) -> String {
    std::fs::read(home.join("link.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["worker"]["name"].as_str().map(str::to_string))
        .filter(|n| !n.is_empty())
        .map(|n| n.replace(['/', '\\', ' '], "-"))
        .unwrap_or_else(|| "daemon".to_string())
}

/// Keeps the logs of the test whose thread is panicking.
fn keep_current() {
    let Some(test) = std::thread::current().name().map(str::to_string) else {
        return;
    };
    {
        let mut kept = KEPT.lock().unwrap_or_else(|e| e.into_inner());
        if !kept.get_or_insert_with(HashSet::new).insert(test.clone()) {
            return;
        }
    }
    let mut daemons: Vec<(String, PathBuf, PathBuf)> = STARTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|s| s.test == test)
        .map(|s| (s.name.clone(), s.log.clone(), s.stderr.clone()))
        .collect();
    let folders: Vec<PathBuf> = FOLDERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|(t, _, _)| *t == test)
        .map(|(_, _, d)| d.clone())
        .collect();
    for dir in folders {
        let mut found: Vec<PathBuf> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.join("home/logs/moonletd.log").exists())
            .collect();
        found.sort();
        for m in found {
            let id = m.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let logs = m.join("home/logs");
            daemons.push((format!("machine-{id}"), logs.join("moonletd.log"), logs.join("stderr.log")));
        }
    }
    if daemons.is_empty() {
        return;
    }
    let dir = kept_dir(&test);
    let _ = std::fs::remove_dir_all(&dir);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let private = Private::of_this_machine();
    let mut logs = Vec::new();
    let mut stderrs = Vec::new();
    for (name, log, stderr) in &daemons {
        let text = private.scrub(&tail_of(log, KEEP_BYTES));
        let _ = std::fs::write(dir.join(format!("{name}.log")), &text);
        let err = private.scrub(&tail_of(stderr, KEEP_BYTES));
        if !err.trim().is_empty() {
            let _ = std::fs::write(dir.join(format!("{name}.stderr.log")), &err);
            stderrs.push((name.clone(), err));
        }
        logs.push((name.clone(), text));
    }
    let all = merge(&logs);
    let _ = std::fs::write(dir.join("all.log"), &all);

    // Through eprint!, so libtest shows it with the test's own output.
    let names: Vec<&str> = logs.iter().map(|(n, _)| n.as_str()).collect();
    let mut out = format!(
        "\n---- logs of {} kept in {} ({}) ----\n",
        if names.len() == 1 { "its daemon" } else { "its daemons" },
        dir.display(),
        names.join(", ")
    );
    for (name, err) in &stderrs {
        out.push_str(&format!("---- {name}'s stderr, its end:\n{}\n", tail(err, 40, 8 * 1024)));
    }
    out.push_str(&format!("---- all.log, its end:\n{}\n", tail(&all, TAIL_LINES, TAIL_BYTES)));
    out.push_str("---- end of the kept logs ----\n");
    eprint!("{out}");
}

/// The last `max` bytes of the file at `path`, from a line's start.
fn tail_of(path: &Path, max: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut cut = false;
    if len > max {
        let _ = f.seek(SeekFrom::Start(len - max));
        cut = true;
    }
    let mut bytes = Vec::new();
    let _ = f.read_to_end(&mut bytes);
    let text = String::from_utf8_lossy(&bytes).into_owned();
    match (cut, text.find('\n')) {
        (true, Some(i)) => text[i + 1..].to_string(),
        _ => text,
    }
}

/// The last `lines` lines of `text`, at most `bytes` of them.
pub fn tail(text: &str, lines: usize, bytes: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    let mut start = all.len().saturating_sub(lines);
    let mut size: usize = all[start..].iter().map(|l| l.len() + 1).sum();
    while size > bytes && start < all.len() {
        size -= all[start].len() + 1;
        start += 1;
    }
    all[start..].join("\n")
}

/// A tracing line's timestamp, such as `2026-11-19T13:12:23.653421Z`.
fn stamp(line: &str) -> Option<&str> {
    let s = line.split(' ').next()?;
    let b = s.as_bytes();
    (b.len() >= 20 && b[4] == b'-' && b[10] == b'T' && b.ends_with(b"Z") && b[0].is_ascii_digit())
        .then_some(s)
}

/// Every daemon's log lines in time order, each tagged with its daemon's
/// name. A line with no timestamp (a message's next lines) stays with the
/// line before it; lines of one instant keep each log's order.
pub fn merge(logs: &[(String, String)]) -> String {
    let width = logs.iter().map(|(n, _)| n.len()).max().unwrap_or(0);
    let mut entries: Vec<(&str, usize, usize, String)> = Vec::new();
    for (d, (name, text)) in logs.iter().enumerate() {
        let mut last = "";
        for (i, line) in text.lines().enumerate() {
            let tagged = match stamp(line) {
                Some(ts) => {
                    last = ts;
                    format!("{ts} {name:<width$} {}", line.get(ts.len() + 1..).unwrap_or(""))
                }
                None => format!("{:<w$} {name:<width$} {line}", "", w = 27),
            };
            entries.push((last, d, i, tagged));
        }
    }
    entries.sort_by(|a, b| (a.0, a.1, a.2).cmp(&(b.0, b.1, b.2)));
    let mut out = String::new();
    for (_, _, _, line) in entries {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// What of this machine must not reach a kept log.
pub struct Private(Vec<(String, &'static str)>);

impl Private {
    pub fn of_this_machine() -> Private {
        let mut found = Vec::new();
        if let Ok(home) = std::env::var("HOME") {
            found.push((home, "~"));
        }
        // The temp folder's path names this Mac's user by a number.
        let tmp = std::env::temp_dir();
        let tmp = tmp.to_string_lossy().trim_end_matches('/').to_string();
        if let Ok(real) = std::fs::canonicalize(&tmp) {
            found.push((real.to_string_lossy().into_owned(), "$TMPDIR"));
        }
        found.push((tmp, "$TMPDIR"));
        let host = moonlet_core::paths::hostname();
        found.push((host.trim_end_matches(".local").to_string(), "this-host"));
        found.push((host, "this-host"));
        for key in ["ComputerName", "LocalHostName"] {
            if let Ok(out) = Command::new("scutil").args(["--get", key]).output()
                && out.status.success()
            {
                found.push((String::from_utf8_lossy(&out.stdout).trim().to_string(), "this-host"));
            }
        }
        Private::of(found)
    }

    /// `found` values, each with what stands in for it.
    pub fn of(found: Vec<(String, &'static str)>) -> Private {
        let mut found: Vec<_> = found
            .into_iter()
            .filter(|(v, _)| v.len() >= 3 && v != "localhost")
            .collect();
        // The longest first, so a host name inside a path goes with it.
        found.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        Private(found)
    }

    pub fn scrub(&self, text: &str) -> String {
        let mut text = text.to_string();
        for (value, stand_in) in &self.0 {
            if text.contains(value.as_str()) {
                text = text.replace(value.as_str(), stand_in);
            }
        }
        text
    }
}
