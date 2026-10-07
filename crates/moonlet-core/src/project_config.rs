//! Reading and writing a project's `.jaunt/config.toml` for the Project
//! settings dialog (X8). Writes edit the file in place with `toml_edit`, so
//! comments, key order and unknown keys survive.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use anyhow::{Context, Result, bail};
use moonlet_proto::types::{ProjectConfig, ProjectConfigFile};
use toml_edit::{DocumentMut, Item, Table, TableLike, Value};

/// Agents moonlet knows without `[agents]`.
const BUILTIN_AGENTS: [&str; 2] = ["claude", "codex"];
/// Top-level string keys, in the order new ones are added.
const SCRIPT_KEYS: [&str; 5] = ["setup", "run", "archive", "default_agent", "base_branch"];

/// The message `save` fails with when the file changed since it was read.
pub const STALE: &str = "config changed on disk";

pub fn path(repo: &Path) -> PathBuf {
    repo.join(".jaunt").join("config.toml")
}

/// Reads the file. A missing file gives an empty config; one that does not
/// parse gives the default config and `error`.
pub fn load(repo: &Path, default_branch: String) -> ProjectConfigFile {
    let p = path(repo);
    let mut file = ProjectConfigFile {
        path: p.display().to_string(),
        exists: false,
        version: String::new(),
        config: ProjectConfig::default(),
        error: None,
        default_branch,
    };
    match std::fs::read(&p) {
        Ok(bytes) => {
            file.exists = true;
            file.version = version(&bytes);
            match parse(&bytes) {
                Ok(config) => file.config = config,
                Err(e) => file.error = Some(e),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => file.error = Some(format!("cannot read {}: {e}", p.display())),
    }
    file
}

/// Validates `config` and writes it over the file read at `expected`
/// version. Keys that are blank in `config` are removed.
pub fn save(repo: &Path, expected: &str, config: &ProjectConfig) -> Result<()> {
    // The version check and the write must not interleave with another
    // save of the same file, or both could pass the check.
    let lock = lock_for(&path(repo));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    save_unlocked(repo, expected, config)
}

/// One lock per config file; saves of different projects stay independent.
fn lock_for(p: &Path) -> Arc<Mutex<()>> {
    static LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
        LazyLock::new(Default::default);
    let mut locks = LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    locks.entry(p.to_path_buf()).or_default().clone()
}

fn save_unlocked(repo: &Path, expected: &str, config: &ProjectConfig) -> Result<()> {
    let config = normalize(config);
    validate(&config)?;
    let dir = repo.join(".jaunt");
    let p = path(repo);
    for link in [&dir, &p] {
        if std::fs::symlink_metadata(link).is_ok_and(|m| m.file_type().is_symlink()) {
            bail!("{} is a symlink; edit it by hand", link.display());
        }
    }
    let current = match std::fs::read(&p) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e).with_context(|| format!("cannot read {}", p.display())),
    };
    let found = current.as_deref().map(version).unwrap_or_default();
    if found != expected {
        bail!(STALE);
    }
    let text = match &current {
        Some(bytes) => {
            parse(bytes).map_err(|e| anyhow::anyhow!(e))?;
            String::from_utf8_lossy(bytes).into_owned()
        }
        None => String::new(),
    };
    let mut doc: DocumentMut = text
        .parse()
        .context(".jaunt/config.toml is not valid TOML")?;
    apply(&mut doc, &config);
    std::fs::create_dir_all(&dir)?;
    write_atomic(&p, &doc.to_string())
}

/// Writes through a fresh temp file and renames it over `path`. The temp
/// file is created with `create_new`, so a symlink planted in `.jaunt/`
/// (it is part of the repo) is never followed.
fn write_atomic(path: &Path, text: &str) -> Result<()> {
    use std::io::Write;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".config.toml.{}-{nanos}.tmp", std::process::id()));
    let result = (|| -> Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        if let Ok(m) = std::fs::symlink_metadata(path) {
            std::fs::set_permissions(&tmp, m.permissions())?;
        }
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.with_context(|| format!("cannot write {}", path.display()))
}

/// Checks agent names, commands and the default agent.
pub fn validate(config: &ProjectConfig) -> Result<()> {
    for (name, cmd) in &config.agents {
        if name.is_empty() {
            bail!("an agent has no name");
        }
        if BUILTIN_AGENTS.contains(&name.as_str()) {
            bail!("agent `{name}` is built in; pick another name");
        }
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            bail!("agent `{name}`: use only letters, digits, dots, dashes and underscores");
        }
        if cmd.is_empty() {
            bail!("agent `{name}` has no command");
        }
    }
    if let Some(a) = &config.default_agent
        && !BUILTIN_AGENTS.contains(&a.as_str())
        && !config.agents.contains_key(a)
    {
        bail!("default agent `{a}` is not an agent in this project");
    }
    Ok(())
}

fn parse(bytes: &[u8]) -> Result<ProjectConfig, String> {
    let text = std::str::from_utf8(bytes).map_err(|e| format!("not UTF-8: {e}"))?;
    toml::from_str(text).map_err(|e| e.to_string().trim_end().to_string())
}

/// Trims every value; blank strings become missing keys.
fn normalize(c: &ProjectConfig) -> ProjectConfig {
    let s = |v: &Option<String>| {
        v.as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(String::from)
    };
    ProjectConfig {
        setup: s(&c.setup),
        run: s(&c.run),
        archive: s(&c.archive),
        default_agent: s(&c.default_agent),
        base_branch: s(&c.base_branch),
        agents: c
            .agents
            .iter()
            .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
            .collect(),
    }
}

fn apply(doc: &mut DocumentMut, c: &ProjectConfig) {
    let values = [
        &c.setup,
        &c.run,
        &c.archive,
        &c.default_agent,
        &c.base_branch,
    ];
    for (key, v) in SCRIPT_KEYS.into_iter().zip(values) {
        if v.is_none() {
            remove_top_level(doc, key);
        } else {
            set(doc.as_table_mut(), key, v.as_deref());
        }
    }
    let has_table = doc
        .get("agents")
        .is_some_and(|i| i.as_table_like().is_some());
    if c.agents.is_empty() && !has_table {
        return;
    }
    if !has_table {
        doc.insert("agents", Item::Table(Table::new()));
    }
    let Some(agents) = doc.get_mut("agents").and_then(|i| i.as_table_like_mut()) else {
        return;
    };
    let stale: Vec<String> = agents
        .iter()
        .map(|(k, _)| k.to_string())
        .filter(|k| !c.agents.contains_key(k))
        .collect();
    for k in stale {
        agents.remove(&k);
    }
    for (name, cmd) in &c.agents {
        set(agents, name, Some(cmd));
    }
    // An emptied table goes, unless a comment is attached to its header.
    let commented = doc
        .get("agents")
        .and_then(|i| i.as_table())
        .and_then(|t| t.decor().prefix())
        .and_then(|p| p.as_str())
        .is_some_and(|p| p.contains('#'));
    if c.agents.is_empty() && !commented {
        doc.remove("agents");
    }
}

/// Removes a top-level key. Comment lines right above it go with it; a
/// block set apart by a blank line (a file header, say) moves to whatever
/// comes next.
fn remove_top_level(doc: &mut DocumentMut, key: &str) {
    let root = doc.as_table_mut();
    let prefix = root
        .key(key)
        .and_then(|k| k.leaf_decor().prefix())
        .and_then(|p| p.as_str())
        .unwrap_or_default();
    let kept = prefix
        .rfind("\n\n")
        .map(|i| prefix[..i + 2].to_string())
        .filter(|k| k.contains('#'));
    let next = root
        .iter()
        .map(|(k, _)| k.to_string())
        .skip_while(|k| k != key)
        .nth(1);
    root.remove(key);
    let Some(kept) = kept else { return };
    let join = |old: Option<&toml_edit::RawString>| {
        format!("{kept}{}", old.and_then(|p| p.as_str()).unwrap_or_default())
    };
    match next.as_deref().and_then(|n| root.get_mut(n)) {
        Some(Item::Table(t)) => {
            let p = join(t.decor().prefix());
            t.decor_mut().set_prefix(p);
        }
        Some(_) => {
            let n = next.unwrap();
            if let Some(mut k) = root.key_mut(&n) {
                let p = join(k.leaf_decor().prefix());
                k.leaf_decor_mut().set_prefix(p);
            }
        }
        None => {
            let t = join(Some(doc.trailing()));
            doc.set_trailing(t);
        }
    }
}

/// Sets or removes one string key. An unchanged value is left as written;
/// a changed one keeps its trailing comment.
fn set(table: &mut dyn TableLike, key: &str, v: Option<&str>) {
    let Some(v) = v else {
        table.remove(key);
        return;
    };
    match table.get_mut(key).and_then(|i| i.as_value_mut()) {
        Some(old) if old.as_str() == Some(v) => {}
        Some(old) => {
            let decor = old.decor().clone();
            *old = Value::from(v);
            *old.decor_mut() = decor;
        }
        None => {
            table.insert(key, toml_edit::value(v));
        }
    }
}

/// FNV-1a over the file's bytes: stable across daemon restarts.
fn version(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn repo_with(text: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        if let Some(t) = text {
            std::fs::create_dir(dir.path().join(".jaunt")).unwrap();
            std::fs::write(path(dir.path()), t).unwrap();
        }
        dir
    }

    fn read(dir: &tempfile::TempDir) -> String {
        std::fs::read_to_string(path(dir.path())).unwrap()
    }

    fn cfg(f: impl FnOnce(&mut ProjectConfig)) -> ProjectConfig {
        let mut c = ProjectConfig::default();
        f(&mut c);
        c
    }

    #[test]
    fn creates_the_file_in_an_empty_repo() {
        let dir = repo_with(None);
        let before = load(dir.path(), "main".into());
        assert!(!before.exists);
        assert_eq!(before.version, "");
        save(
            dir.path(),
            "",
            &cfg(|c| {
                c.run = Some(" pnpm dev ".into());
                c.agents.insert("yolo".into(), "claude --x".into());
            }),
        )
        .unwrap();
        assert_eq!(
            read(&dir),
            "run = \"pnpm dev\"\n\n[agents]\nyolo = \"claude --x\"\n"
        );
        let after = load(dir.path(), "main".into());
        assert!(after.exists && after.error.is_none());
        assert_eq!(after.config.run.as_deref(), Some("pnpm dev"));
    }

    #[test]
    fn keeps_comments_order_and_unknown_keys() {
        let text = "# repo scripts\nsetup = \"pnpm i\"   # install\nrun = 'pnpm dev'\nextra = 1\n\n[agents]\n# fast one\nyolo = \"claude --x\"\nold = \"aider\"\n\n[foo]\nbar = true\n";
        let dir = repo_with(Some(text));
        let v = load(dir.path(), "main".into()).version;
        save(
            dir.path(),
            &v,
            &cfg(|c| {
                c.setup = Some("pnpm install".into());
                c.run = Some("pnpm dev".into());
                c.archive = Some("  ".into());
                c.base_branch = Some("develop".into());
                c.agents.insert("yolo".into(), "claude --x".into());
                c.agents.insert("new".into(), "codex --y".into());
            }),
        )
        .unwrap();
        assert_eq!(
            read(&dir),
            "# repo scripts\nsetup = \"pnpm install\"   # install\nrun = 'pnpm dev'\nextra = 1\nbase_branch = \"develop\"\n\n[agents]\n# fast one\nyolo = \"claude --x\"\nnew = \"codex --y\"\n\n[foo]\nbar = true\n"
        );
    }

    #[test]
    fn blank_fields_remove_keys_and_an_emptied_agents_table_goes() {
        let dir = repo_with(Some(
            "# header\n\n# the run command\nrun = \"x\"\nsetup = \"y\"\n\n[agents]\nyolo = \"claude\"\n",
        ));
        let v = load(dir.path(), "main".into()).version;
        save(dir.path(), &v, &cfg(|c| c.setup = Some("y".into()))).unwrap();
        assert_eq!(read(&dir), "# header\n\nsetup = \"y\"\n");
        // With nothing left, a header still survives.
        let v = load(dir.path(), "main".into()).version;
        save(dir.path(), &v, &cfg(|_| {})).unwrap();
        assert_eq!(read(&dir), "# header\n\n");
    }

    #[test]
    fn an_emptied_agents_table_with_a_comment_stays() {
        let dir = repo_with(Some(
            "run = \"x\"\n\n# extra agents\n[agents]\nyolo = \"claude\"\n",
        ));
        let v = load(dir.path(), "main".into()).version;
        save(dir.path(), &v, &cfg(|c| c.run = Some("x".into()))).unwrap();
        assert_eq!(read(&dir), "run = \"x\"\n\n# extra agents\n[agents]\n");
    }

    #[test]
    fn a_stale_version_writes_nothing() {
        let dir = repo_with(Some("run = \"x\"\n"));
        let v = load(dir.path(), "main".into()).version;
        std::fs::write(path(dir.path()), "run = \"y\"\n").unwrap();
        let err = save(dir.path(), &v, &cfg(|c| c.run = Some("z".into()))).unwrap_err();
        assert_eq!(err.to_string(), STALE);
        assert_eq!(read(&dir), "run = \"y\"\n");
        // A file created since a "missing" read is stale too.
        let empty = repo_with(None);
        std::fs::create_dir(empty.path().join(".jaunt")).unwrap();
        std::fs::write(path(empty.path()), "").unwrap();
        assert_eq!(
            save(empty.path(), "", &cfg(|_| {}))
                .unwrap_err()
                .to_string(),
            STALE
        );
    }

    #[test]
    fn an_invalid_file_is_reported_and_never_overwritten() {
        let dir = repo_with(Some("run = \nsetup = 5\n"));
        let f = load(dir.path(), "main".into());
        assert!(f.exists);
        assert!(
            f.error.as_deref().unwrap().contains("line 1"),
            "{:?}",
            f.error
        );
        assert_eq!(f.config, ProjectConfig::default());
        assert!(save(dir.path(), &f.version, &cfg(|_| {})).is_err());
        assert_eq!(read(&dir), "run = \nsetup = 5\n");
        // Valid TOML with a wrong type is refused the same way.
        let typed = repo_with(Some("run = 5\n"));
        let f = load(typed.path(), "main".into());
        assert!(f.error.is_some());
        assert!(save(typed.path(), &f.version, &cfg(|_| {})).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_config_is_refused() {
        let dir = repo_with(None);
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("c.toml"), "").unwrap();
        std::fs::create_dir(dir.path().join(".jaunt")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("c.toml"), path(dir.path())).unwrap();
        let v = load(dir.path(), "main".into()).version;
        let err = save(dir.path(), &v, &cfg(|c| c.run = Some("x".into()))).unwrap_err();
        assert!(err.to_string().contains("symlink"), "{err}");
        assert_eq!(
            std::fs::read_to_string(outside.path().join("c.toml")).unwrap(),
            ""
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_planted_in_moonlet_is_never_written_through() {
        let dir = repo_with(Some("run = \"x\"\n"));
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim");
        std::fs::write(&victim, "keep").unwrap();
        // The temp name the generic `fs::write` would have used.
        std::os::unix::fs::symlink(&victim, dir.path().join(".jaunt/.config.toml.moonlet-tmp"))
            .unwrap();
        let v = load(dir.path(), "main".into()).version;
        save(dir.path(), &v, &cfg(|c| c.run = Some("y".into()))).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        assert_eq!(read(&dir), "run = \"y\"\n");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path().join(".jaunt"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn concurrent_saves_of_one_version_let_exactly_one_through() {
        for round in 0..20 {
            let dir = repo_with(Some("run = \"x\"\n"));
            let v = load(dir.path(), "main".into()).version;
            let barrier = std::sync::Barrier::new(8);
            let ok = std::thread::scope(|s| {
                let handles: Vec<_> = (0..8)
                    .map(|i| {
                        let (dir, v, barrier) = (dir.path(), &v, &barrier);
                        s.spawn(move || {
                            barrier.wait();
                            save(dir, v, &cfg(|c| c.run = Some(format!("run {i}")))).is_ok()
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|h| h.join().unwrap())
                    .filter(|ok| *ok)
                    .count()
            });
            assert_eq!(ok, 1, "round {round}");
        }
    }

    #[test]
    fn validation_rules() {
        let agents = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let err = |c: ProjectConfig| validate(&normalize(&c)).unwrap_err().to_string();
        assert!(err(cfg(|c| c.agents = agents(&[("claude", "claude --x")]))).contains("built in"));
        assert!(err(cfg(|c| c.agents = agents(&[("my agent", "x")]))).contains("letters"));
        assert!(err(cfg(|c| c.agents = agents(&[("ok", "  ")]))).contains("no command"));
        assert!(err(cfg(|c| c.agents = agents(&[("  ", "x")]))).contains("no name"));
        assert!(err(cfg(|c| c.default_agent = Some("aider".into()))).contains("not an agent"));
        validate(&cfg(|c| {
            c.default_agent = Some("my.agent-2_x".into());
            c.agents = agents(&[("my.agent-2_x", "aider")]);
        }))
        .unwrap();
        validate(&cfg(|c| c.default_agent = Some("codex".into()))).unwrap();
    }
}
