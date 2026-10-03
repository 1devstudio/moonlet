//! File tree, reading, light editing and live refresh (F1, F2, M1).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use jaunt_proto::Message;
use jaunt_proto::methods::{self, FsChanged};
use jaunt_proto::types::{DirEntry, FileContent};
use notify::{RecursiveMode, Watcher};

use crate::terminal::expand_home;

const DEFAULT_MAX_READ: u64 = 4 * 1024 * 1024;

/// Lists one directory (the tree loads lazily), dirs first, `.gitignore`-aware.
pub fn list(path: &str, show_ignored: bool) -> Result<Vec<DirEntry>> {
    let dir = expand_home(path);
    let meta = std::fs::metadata(&dir).with_context(|| format!("cannot open {}", dir.display()))?;
    if !meta.is_dir() {
        bail!("{} is not a directory", dir.display());
    }
    let visible: HashSet<PathBuf> = ignore::WalkBuilder::new(&dir)
        .max_depth(Some(1))
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .require_git(false)
        .build()
        .filter_map(|e| e.ok())
        .map(|e| e.into_path())
        .collect();
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" || name == ".DS_Store" {
            continue;
        }
        let path = entry.path();
        let ignored = !visible.contains(&path);
        if ignored && !show_ignored {
            continue;
        }
        let meta = std::fs::metadata(&path).or_else(|_| entry.metadata());
        let (is_dir, size) = meta.map(|m| (m.is_dir(), m.len())).unwrap_or((false, 0));
        out.push(DirEntry {
            name,
            path: path.display().to_string(),
            is_dir,
            size,
            ignored,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Every non-ignored file under `root`, relative to it, for `@` mentions
/// and quick open. Capped at `limit` entries.
pub fn files(root: &str, limit: usize) -> Result<Vec<String>> {
    let dir = expand_home(root);
    if !dir.is_dir() {
        bail!("{} is not a directory", dir.display());
    }
    let mut out: Vec<String> = ignore::WalkBuilder::new(&dir)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .filter_map(|e| e.path().strip_prefix(&dir).ok().map(|p| p.display().to_string()))
        .take(limit)
        .collect();
    out.sort();
    Ok(out)
}

pub fn read(path: &str, max_bytes: Option<u64>) -> Result<FileContent> {
    let p = expand_home(path);
    let size = std::fs::metadata(&p)
        .with_context(|| format!("cannot open {}", p.display()))?
        .len();
    let max = max_bytes.unwrap_or(DEFAULT_MAX_READ);
    let mut data = Vec::new();
    {
        use std::io::Read;
        std::fs::File::open(&p)?.take(max).read_to_end(&mut data)?;
    }
    let binary = crate::git::is_binary(&data);
    Ok(FileContent {
        path: p.display().to_string(),
        content: if binary {
            String::new()
        } else {
            String::from_utf8_lossy(&data).into_owned()
        },
        binary,
        truncated: size > max,
        size,
    })
}

/// Saves a text file atomically, keeping its permissions.
pub fn write(path: &str, content: &str) -> Result<()> {
    let p = expand_home(path);
    let perms = std::fs::metadata(&p).ok().map(|m| m.permissions());
    let tmp = p.with_file_name(format!(
        ".{}.jaunt-tmp",
        p.file_name().context("not a file path")?.to_string_lossy()
    ));
    std::fs::write(&tmp, content)?;
    if let Some(perms) = perms {
        std::fs::set_permissions(&tmp, perms)?;
    }
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

struct Watch {
    _watcher: notify::RecommendedWatcher,
    clients: HashSet<u64>,
}

/// Shared filesystem watchers, one per root, reference-counted by client.
/// Changes are debounced and broadcast as `fs.changed` events.
pub struct Watchers {
    watches: Mutex<HashMap<PathBuf, Watch>>,
    emit: Arc<dyn Fn(Message) + Send + Sync>,
}

impl Watchers {
    pub fn new(emit: Arc<dyn Fn(Message) + Send + Sync>) -> Arc<Self> {
        Arc::new(Self {
            watches: Mutex::new(HashMap::new()),
            emit,
        })
    }

    pub fn watch(&self, path: &str, client: u64) -> Result<()> {
        let root = expand_home(path).canonicalize()?;
        let mut watches = self.watches.lock().unwrap();
        if let Some(w) = watches.get_mut(&root) {
            w.clients.insert(client);
            return Ok(());
        }
        let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(ev) = res {
                    for p in ev.paths {
                        let _ = tx.send(p);
                    }
                }
            })?;
        watcher.watch(&root, RecursiveMode::Recursive)?;
        let emit = self.emit.clone();
        let root_s = root.display().to_string();
        std::thread::spawn(move || debounce(rx, &root_s, emit));
        watches.insert(
            root,
            Watch {
                _watcher: watcher,
                clients: HashSet::from([client]),
            },
        );
        Ok(())
    }

    pub fn unwatch(&self, path: &str, client: u64) {
        let Ok(root) = expand_home(path).canonicalize() else {
            return;
        };
        let mut watches = self.watches.lock().unwrap();
        if let Some(w) = watches.get_mut(&root) {
            w.clients.remove(&client);
            if w.clients.is_empty() {
                watches.remove(&root);
            }
        }
    }

    pub fn release_client(&self, client: u64) {
        let mut watches = self.watches.lock().unwrap();
        watches.retain(|_, w| {
            w.clients.remove(&client);
            !w.clients.is_empty()
        });
    }
}

/// Paths inside `.git` that matter for git status; the rest is noise.
fn relevant(p: &Path) -> bool {
    let s = p.to_string_lossy();
    match s.find("/.git/") {
        None => !s.ends_with("/.git"),
        Some(i) => {
            let rest = &s[i + 6..];
            rest == "HEAD" || rest == "index" || rest.starts_with("refs/heads")
        }
    }
}

fn debounce(
    rx: std::sync::mpsc::Receiver<PathBuf>,
    root: &str,
    emit: Arc<dyn Fn(Message) + Send + Sync>,
) {
    // Ends when the watcher (and with it the sender) is dropped.
    while let Ok(first) = rx.recv() {
        let mut batch: HashSet<PathBuf> = HashSet::from([first]);
        let deadline = std::time::Instant::now() + Duration::from_millis(150);
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(p) => {
                    batch.insert(p);
                }
                Err(_) => break,
            }
        }
        let mut paths: Vec<String> = batch
            .iter()
            .filter(|p| relevant(p))
            .map(|p| p.display().to_string())
            .collect();
        if paths.is_empty() {
            continue;
        }
        paths.sort();
        paths.truncate(500);
        emit(Message::event(
            methods::EV_FS_CHANGED,
            FsChanged {
                root: root.to_string(),
                paths,
            },
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_are_relative_and_skip_ignored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::create_dir_all(dir.path().join("target")).unwrap();
        std::fs::write(dir.path().join(".gitignore"), "target/\n").unwrap();
        std::fs::write(dir.path().join("src/main.rs"), "").unwrap();
        std::fs::write(dir.path().join("target/out"), "").unwrap();
        let f = files(&dir.path().display().to_string(), 100).unwrap();
        assert_eq!(f, vec![".gitignore", "src/main.rs"]);
    }

    #[test]
    fn lists_with_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::create_dir(p.join(".git")).unwrap();
        std::fs::write(p.join(".gitignore"), "target/\n*.log\n").unwrap();
        std::fs::create_dir(p.join("src")).unwrap();
        std::fs::create_dir(p.join("target")).unwrap();
        std::fs::write(p.join("README.md"), "hi").unwrap();
        std::fs::write(p.join("debug.log"), "x").unwrap();
        let names: Vec<_> = list(&p.display().to_string(), false)
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["src", ".gitignore", "README.md"]);
        let all = list(&p.display().to_string(), true).unwrap();
        assert!(all.iter().any(|e| e.name == "target" && e.ignored));
    }

    #[test]
    fn reads_and_writes() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("note.md");
        write(&f.display().to_string(), "# hi\n").unwrap();
        let c = read(&f.display().to_string(), None).unwrap();
        assert_eq!(c.content, "# hi\n");
        assert!(!c.binary && !c.truncated);
        let c = read(&f.display().to_string(), Some(2)).unwrap();
        assert!(c.truncated);
        std::fs::write(dir.path().join("b"), [0u8, 159, 146]).unwrap();
        assert!(
            read(&dir.path().join("b").display().to_string(), None)
                .unwrap()
                .binary
        );
    }

    #[test]
    fn watch_emits_debounced_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = Mutex::new(tx);
        let w = Watchers::new(Arc::new(move |m| {
            let _ = tx.lock().unwrap().send(m);
        }));
        w.watch(&dir.path().display().to_string(), 1).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(dir.path().join("x.txt"), "1").unwrap();
        std::fs::write(dir.path().join("y.txt"), "2").unwrap();
        let m = rx.recv_timeout(Duration::from_secs(5)).expect("fs.changed");
        let Message::Event { name, data } = m else {
            panic!()
        };
        assert_eq!(name, methods::EV_FS_CHANGED);
        let ch: FsChanged = serde_json::from_value(data).unwrap();
        assert!(ch.paths.iter().any(|p| p.ends_with("x.txt")));
        w.release_client(1);
    }

    #[test]
    fn git_noise_is_filtered() {
        assert!(relevant(Path::new("/r/src/a.rs")));
        assert!(relevant(Path::new("/r/.git/index")));
        assert!(!relevant(Path::new("/r/.git/objects/ab/cdef")));
    }
}
