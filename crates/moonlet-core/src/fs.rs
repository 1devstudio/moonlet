//! File tree, reading, light editing and live refresh (F1, F2, M1).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use moonlet_proto::Message;
use moonlet_proto::methods::{self, FsChanged};
use moonlet_proto::types::{DirEntry, FileContent};
use notify::{RecursiveMode, Watcher};

use crate::terminal::expand_home;

const DEFAULT_MAX_READ: u64 = 4 * 1024 * 1024;
/// Upper bound for `max_bytes` from a client.
const MAX_READ: u64 = 64 * 1024 * 1024;

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
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let p = expand_home(path);
    // Open without blocking (a FIFO would wait for a writer), then check the
    // type on the handle itself, so nothing can be swapped in between.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&p)
        .with_context(|| format!("cannot open {}", p.display()))?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        bail!("{} is not a regular file", p.display());
    }
    let size = meta.len();
    let max = max_bytes.unwrap_or(DEFAULT_MAX_READ).min(MAX_READ);
    let mut data = Vec::new();
    file.take(max).read_to_end(&mut data)?;
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

/// Saves a text file atomically, keeping its permissions and creating
/// missing folders.
pub fn write(path: &str, content: &str) -> Result<()> {
    let mut p = expand_home(path);
    // Write through a symlink to its target instead of replacing the link.
    if let Ok(real) = p.canonicalize() {
        p = real;
    }
    let perms = std::fs::metadata(&p).ok().map(|m| m.permissions());
    let tmp = p.with_file_name(format!(
        ".{}.moonlet-tmp",
        p.file_name().context("not a file path")?.to_string_lossy()
    ));
    let result = (|| -> Result<()> {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&tmp, content)?;
        if let Some(perms) = perms {
            std::fs::set_permissions(&tmp, perms)?;
        }
        std::fs::rename(&tmp, &p)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Saves a file the app creates inside `root`, such as a chat's context
/// file (X38). Missing folders are created. A symlink anywhere between
/// `root` and the file is refused, so a repository can't point the write at
/// another file, inside the worktree or outside it.
pub fn write_inside(root: &str, path: &str, content: &str) -> Result<()> {
    use std::io::Write;
    use std::path::Component;
    use std::sync::atomic::{AtomicU64, Ordering};
    static WRITES: AtomicU64 = AtomicU64::new(0);

    let root = expand_home(root);
    if !root.is_dir() {
        bail!("no such folder: {}", root.display());
    }
    let p = expand_home(path);
    let Ok(rel) = p.strip_prefix(&root) else {
        bail!("{} is outside {}", p.display(), root.display());
    };
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        bail!("{} is outside {}", p.display(), root.display());
    }
    let name = p.file_name().context("not a file path")?.to_string_lossy().to_string();
    // Each folder on the way is checked without following it, or created.
    let mut dir = root.clone();
    for c in rel.parent().into_iter().flat_map(Path::components) {
        dir.push(c);
        if let Err(e) = std::fs::create_dir(&dir) {
            // Another write may have just created it: check what is there.
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(e.into());
            }
        }
        let meta = std::fs::symlink_metadata(&dir)?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            bail!("{} is not a folder", dir.display());
        }
    }
    if std::fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
        bail!("{} is a symlink", p.display());
    }
    // A temporary name of its own per write, created exclusively: writes of
    // one file at once don't collide, and a planted symlink is never followed.
    let n = WRITES.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".{name}.{}-{n}.moonlet-tmp", std::process::id()));
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    let result = f.write_all(content.as_bytes()).and_then(|_| std::fs::rename(&tmp, &p));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(result?)
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
    fn read_refuses_special_files_and_write_follows_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read(&dir.path().display().to_string(), None).is_err(), "directory");
        let target = dir.path().join("real.txt");
        std::fs::write(&target, "old").unwrap();
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        write(&link.display().to_string(), "new").unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
    }

    #[test]
    fn write_creates_missing_folders() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".moonlet/context/chat-fix-login.md");
        write(&file.display().to_string(), "# Chat\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Chat\n");
    }

    #[test]
    fn write_inside_never_leaves_the_root_through_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("worktree");
        let outside = dir.path().join("home");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let s = |p: &Path| p.display().to_string();

        // An ordinary write creates the folders.
        let file = root.join(".moonlet/context/plan-x.md");
        write_inside(&s(&root), &s(&file), "# Plan\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Plan\n");

        // A file that is a symlink is refused, and its target is untouched.
        std::fs::write(outside.join(".zshrc"), "export A=1\n").unwrap();
        let link = root.join(".moonlet/context/.gitignore");
        std::os::unix::fs::symlink(outside.join(".zshrc"), &link).unwrap();
        assert!(write_inside(&s(&root), &s(&link), "*\n").is_err());
        assert_eq!(std::fs::read_to_string(outside.join(".zshrc")).unwrap(), "export A=1\n");

        // A folder that leads outside the root is refused, and nothing is written there.
        let other = dir.path().join("other");
        std::fs::create_dir_all(other.join(".moonlet")).unwrap();
        std::os::unix::fs::symlink(&outside, other.join(".moonlet/context")).unwrap();
        assert!(write_inside(&s(&other), &s(&other.join(".moonlet/context/chat-x.md")), "x").is_err());
        assert!(!outside.join("chat-x.md").exists());

        // A leftover temporary file, from a crash or a planted symlink, is
        // replaced: the write goes through and never follows it.
        std::fs::write(outside.join("victim"), "keep").unwrap();
        std::os::unix::fs::symlink(outside.join("victim"), root.join(".moonlet/context/.chat-y.md.moonlet-tmp")).unwrap();
        write_inside(&s(&root), &s(&root.join(".moonlet/context/chat-y.md")), "y").unwrap();
        assert_eq!(std::fs::read_to_string(outside.join("victim")).unwrap(), "keep");
        assert_eq!(std::fs::read_to_string(root.join(".moonlet/context/chat-y.md")).unwrap(), "y");
        std::fs::write(root.join(".moonlet/context/.chat-z.md.moonlet-tmp"), "half").unwrap();
        write_inside(&s(&root), &s(&root.join(".moonlet/context/chat-z.md")), "z").unwrap();
        assert_eq!(std::fs::read_to_string(root.join(".moonlet/context/chat-z.md")).unwrap(), "z");
    }

    #[test]
    fn write_inside_takes_writes_of_one_file_at_once() {
        // Two quick chip clicks both rewrite .moonlet/context/.gitignore.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().display().to_string();
        let file = dir.path().join(".moonlet/context/.gitignore").display().to_string();
        let writers: Vec<_> = (0..8)
            .map(|_| {
                let (root, file) = (root.clone(), file.clone());
                std::thread::spawn(move || (0..20).map(|_| write_inside(&root, &file, "*\n")).collect::<Result<Vec<_>>>())
            })
            .collect();
        for w in writers {
            w.join().unwrap().unwrap();
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "*\n");
    }

    #[test]
    fn write_inside_refuses_a_symlinked_folder_inside_the_root() {
        // A committed `.moonlet/context -> ../src` would overwrite src/.gitignore.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join(".moonlet")).unwrap();
        std::fs::write(root.join("src/.gitignore"), "target/\n").unwrap();
        std::os::unix::fs::symlink("../src", root.join(".moonlet/context")).unwrap();
        let file = root.join(".moonlet/context/.gitignore");
        assert!(write_inside(&root.display().to_string(), &file.display().to_string(), "*\n").is_err());
        assert_eq!(std::fs::read_to_string(root.join("src/.gitignore")).unwrap(), "target/\n");
    }

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
        // FSEvents can first deliver an earlier batch (the temp dir itself),
        // so wait for the event that names x.txt rather than take the first.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut seen = Vec::new();
        let found = loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let Ok(m) = rx.recv_timeout(left) else { break false };
            let Message::Event { name, data } = m else {
                panic!()
            };
            assert_eq!(name, methods::EV_FS_CHANGED);
            let ch: FsChanged = serde_json::from_value(data).unwrap();
            if ch.paths.iter().any(|p| p.ends_with("x.txt")) {
                break true;
            }
            seen.extend(ch.paths);
        };
        assert!(found, "no fs.changed named x.txt within 5s; saw {seen:?}");
        w.release_client(1);
    }

    #[test]
    fn git_noise_is_filtered() {
        assert!(relevant(Path::new("/r/src/a.rs")));
        assert!(relevant(Path::new("/r/.git/index")));
        assert!(!relevant(Path::new("/r/.git/objects/ab/cdef")));
    }
}
