//! Reading and writing a project's `.moonlet/config.toml` for the Project
//! settings dialog (X8). Writes edit the file in place with `toml_edit`, so
//! comments, key order and unknown keys survive.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use anyhow::{Context, Result, bail};
use moonlet_proto::types::{HeavyConfig, HeavyOs, ProjectConfig, ProjectConfigFile};
use toml_edit::{DocumentMut, Item, Table, TableLike, Value};

/// Agents moonlet knows without `[agents]`.
const BUILTIN_AGENTS: [&str; 2] = ["claude", "codex"];
/// Top-level string keys, in the order new ones are added.
const SCRIPT_KEYS: [&str; 6] = ["setup", "run", "archive", "default_agent", "base_branch", "branch_prefix"];

/// The message `save` fails with when the file changed since it was read.
pub const STALE: &str = "config changed on disk";

/// The project's config: `.moonlet/config.toml`, or jaunt's
/// `.jaunt/config.toml` while only that one exists (X27).
pub fn path(repo: &Path) -> PathBuf {
    let (new, legacy) = (repo.join(".moonlet/config.toml"), repo.join(".jaunt/config.toml"));
    if std::fs::symlink_metadata(&new).is_err() && std::fs::symlink_metadata(&legacy).is_ok() {
        legacy
    } else {
        new
    }
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
    let lock = lock_for(&repo.join(".moonlet/config.toml"));
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
    edit_unlocked(repo, Some(expected), |doc| apply(doc, &config))
}

/// Writes `heavy` as the `[heavy]` table (X62) and leaves the rest of the
/// file as it is. An empty `heavy` removes the table.
pub fn set_heavy(repo: &Path, heavy: &HeavyConfig) -> Result<()> {
    let trim = |v: &[String]| -> Vec<String> {
        v.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
    };
    let heavy = HeavyConfig {
        commands: trim(&heavy.commands),
        os: heavy.os,
        env: trim(&heavy.env),
        outputs: heavy.outputs.iter().map(|s| s.trim().to_string()).collect(),
        // Not written here: the file's own stays.
        machine_setup: None,
    };
    crate::heavy::check(&heavy).map_err(anyhow::Error::msg)?;
    let lock = lock_for(&repo.join(".moonlet/config.toml"));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    edit_unlocked(repo, None, |doc| apply_heavy(doc, &heavy))
}

/// Edits the file with `f`: only when it is still at version `expected`,
/// if one is given.
fn edit_unlocked(
    repo: &Path,
    expected: Option<&str>,
    f: impl FnOnce(&mut DocumentMut),
) -> Result<()> {
    // Reads jaunt's file while it is the only one, and always writes
    // moonlet's (X27).
    let src = path(repo);
    let dir = repo.join(".moonlet");
    let p = dir.join("config.toml");
    let legacy_dir = repo.join(".jaunt");
    let mut links = vec![&dir, &p];
    if src != p {
        links.extend([&legacy_dir, &src]);
    }
    for link in links {
        if std::fs::symlink_metadata(link).is_ok_and(|m| m.file_type().is_symlink()) {
            bail!("{} is a symlink; edit it by hand", link.display());
        }
    }
    let current = match std::fs::read(&src) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e).with_context(|| format!("cannot read {}", src.display())),
    };
    let found = current.as_deref().map(version).unwrap_or_default();
    if expected.is_some_and(|e| e != found) {
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
        .with_context(|| format!("{} is not valid TOML", src.display()))?;
    f(&mut doc);
    std::fs::create_dir_all(&dir)?;
    write_atomic(&p, &doc.to_string())?;
    if src != p {
        std::fs::remove_file(&src)?;
        // Only if empty: anything else in it is the user's.
        let _ = std::fs::remove_dir(&legacy_dir);
    }
    Ok(())
}

/// Writes through a fresh temp file and renames it over `path`. The temp
/// file is created with `create_new`, so a symlink planted in `.moonlet/`
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
    if let Some(e) = config.branch_prefix.as_deref().and_then(crate::git_settings::prefix_error) {
        bail!("branch prefix: {e}");
    }
    for t in &config.trackers {
        let ok = t
            .split_once('/')
            .is_some_and(|(conn, key)| conn.contains(':') && !key.is_empty());
        if !ok {
            bail!("tracker `{t}`: write it as connection/key, such as jira:acme.atlassian.net/ABC");
        }
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
        branch_prefix: s(&c.branch_prefix),
        agents: c
            .agents
            .iter()
            .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
            .collect(),
        trackers: c.trackers.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).fold(
            Vec::new(),
            |mut seen, t| {
                if !seen.iter().any(|s| s == t) {
                    seen.push(t.to_string());
                }
                seen
            },
        ),
        heavy: c.heavy.clone(),
    }
}

/// Writes `c` into `doc`. `[heavy]` is left as it is: only `heavy.set`
/// writes it (X62), so a client that does not know it never erases it.
fn apply(doc: &mut DocumentMut, c: &ProjectConfig) {
    let values = [
        &c.setup,
        &c.run,
        &c.archive,
        &c.default_agent,
        &c.base_branch,
        &c.branch_prefix,
    ];
    for (key, v) in SCRIPT_KEYS.into_iter().zip(values) {
        if v.is_none() {
            remove_top_level(doc, key);
        } else {
            set(doc.as_table_mut(), key, v.as_deref());
        }
    }
    set_trackers(doc, &c.trackers);
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

/// Sets or removes `trackers`; an unchanged list is left as written.
fn set_trackers(doc: &mut DocumentMut, trackers: &[String]) {
    if trackers.is_empty() {
        if doc.contains_key("trackers") {
            remove_top_level(doc, "trackers");
        }
        return;
    }
    let same = doc
        .get("trackers")
        .and_then(|i| i.as_array())
        .is_some_and(|a| a.iter().map(|v| v.as_str()).eq(trackers.iter().map(|t| Some(t.as_str()))));
    if !same {
        let list: toml_edit::Array = trackers.iter().map(String::as_str).collect();
        doc.insert("trackers", toml_edit::value(list));
    }
}

fn apply_heavy(doc: &mut DocumentMut, h: &HeavyConfig) {
    let empty = h.commands.is_empty() && h.env.is_empty() && h.outputs.is_empty() && h.os == HeavyOs::Any;
    // `machine_setup` (X63) is the file's own: it keeps the table.
    let keeps = doc
        .get("heavy")
        .and_then(|i| i.as_table())
        .is_some_and(|t| t.contains_key("machine_setup"));
    if empty && !keeps {
        doc.remove("heavy");
        return;
    }
    if !doc.get("heavy").is_some_and(|i| i.is_table()) {
        doc.insert("heavy", Item::Table(Table::new()));
    }
    let Some(t) = doc.get_mut("heavy").and_then(|i| i.as_table_mut()) else {
        return;
    };
    let os = match h.os {
        HeavyOs::Any => None,
        HeavyOs::Macos => Some("macos"),
        HeavyOs::Linux => Some("linux"),
    };
    let lists = [("commands", &h.commands), ("env", &h.env), ("outputs", &h.outputs)];
    for (key, list) in lists {
        if key == "env" {
            match os {
                Some(os) => set(t, "os", Some(os)),
                None => {
                    t.remove("os");
                }
            }
        }
        if list.is_empty() {
            t.remove(key);
            continue;
        }
        let same = t
            .get(key)
            .and_then(|i| i.as_array())
            .is_some_and(|a| a.iter().map(|v| v.as_str()).eq(list.iter().map(|s| Some(s.as_str()))));
        if !same {
            let array: toml_edit::Array = list.iter().map(String::as_str).collect();
            t.insert(key, toml_edit::value(array));
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

    #[test]
    fn saving_the_config_leaves_the_heavy_table_as_it_is() {
        // `[heavy]` is written only by `heavy.set` (X62): a save that does
        // not know it, or carries an old copy, neither erases nor blocks it.
        let text = "run = \"pnpm dev\"\n\n[heavy]\ncommands = [\"pnpm test\"]\noutputs = [\"../shared\"]\n";
        let dir = repo_with(Some(text));
        let file = load(dir.path(), "main".into());
        let config = ProjectConfig {
            run: Some("pnpm start".into()),
            ..ProjectConfig::default()
        };
        save(dir.path(), &file.version, &config).unwrap();
        assert_eq!(
            std::fs::read_to_string(path(dir.path())).unwrap(),
            "run = \"pnpm start\"\n\n[heavy]\ncommands = [\"pnpm test\"]\noutputs = [\"../shared\"]\n"
        );
        let mut stale = file.config.clone();
        stale.run = Some("pnpm serve".into());
        let file = load(dir.path(), "main".into());
        save(dir.path(), &file.version, &stale).unwrap();
        assert!(
            std::fs::read_to_string(path(dir.path()))
                .unwrap()
                .starts_with("run = \"pnpm serve\"\n")
        );
    }

    fn repo_with(text: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        if let Some(t) = text {
            std::fs::create_dir(dir.path().join(".moonlet")).unwrap();
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
    fn heavy_set_writes_the_heavy_table_and_keeps_the_rest() {
        use moonlet_proto::types::{HeavyConfig, HeavyOs};
        let dir = repo_with(Some("# shop\nsetup = \"pnpm install\" # deps\n\n[agents]\nyolo = \"claude --x\"\n"));
        let heavy = HeavyConfig {
            commands: vec!["pnpm test".into(), "pnpm build".into()],
            os: HeavyOs::Linux,
            env: vec!["CI".into()],
            outputs: vec!["coverage".into()],
            machine_setup: None,
        };
        set_heavy(dir.path(), &heavy).unwrap();
        assert_eq!(
            read(&dir),
            "# shop\nsetup = \"pnpm install\" # deps\n\n[agents]\nyolo = \"claude --x\"\n\n[heavy]\ncommands = [\"pnpm test\", \"pnpm build\"]\nos = \"linux\"\nenv = [\"CI\"]\noutputs = [\"coverage\"]\n"
        );
        assert_eq!(load(dir.path(), "main".into()).config.heavy, heavy);

        // The settings dialog (X8) knows nothing of [heavy] and keeps it.
        let v = load(dir.path(), "main".into()).version;
        save(dir.path(), &v, &cfg(|c| {
            c.setup = Some("pnpm i".into());
            c.agents.insert("yolo".into(), "claude --x".into());
        }))
        .unwrap();
        assert_eq!(load(dir.path(), "main".into()).config.heavy, heavy);

        // Any system is the default and is not written; an empty table goes.
        set_heavy(dir.path(), &HeavyConfig { commands: vec!["pnpm test".into()], ..HeavyConfig::default() }).unwrap();
        assert!(read(&dir).ends_with("[heavy]\ncommands = [\"pnpm test\"]\n"), "{}", read(&dir));
        set_heavy(dir.path(), &HeavyConfig::default()).unwrap();
        assert_eq!(read(&dir), "# shop\nsetup = \"pnpm i\" # deps\n\n[agents]\nyolo = \"claude --x\"\n");

        // An invalid table is refused and the file stays as it was.
        let bad = HeavyConfig { outputs: vec!["..".into()], ..HeavyConfig::default() };
        assert_eq!(set_heavy(dir.path(), &bad).unwrap_err().to_string(), "outputs: `..` is outside the worktree");
    }

    #[test]
    fn heavy_set_keeps_the_machine_setup() {
        use moonlet_proto::types::HeavyConfig;
        // Read-only in the app (X63): heavy.set never writes nor drops it.
        let dir = repo_with(Some("[heavy]\ncommands = [\"pnpm test\"]\nmachine_setup = \"scripts/ci-deps.sh\"\n"));
        assert_eq!(
            load(dir.path(), "main".into()).config.heavy.machine_setup.as_deref(),
            Some("scripts/ci-deps.sh")
        );
        set_heavy(dir.path(), &HeavyConfig { commands: vec!["pnpm build".into()], ..HeavyConfig::default() }).unwrap();
        assert_eq!(read(&dir), "[heavy]\ncommands = [\"pnpm build\"]\nmachine_setup = \"scripts/ci-deps.sh\"\n");
        set_heavy(dir.path(), &HeavyConfig::default()).unwrap();
        assert_eq!(read(&dir), "[heavy]\nmachine_setup = \"scripts/ci-deps.sh\"\n");
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
        std::fs::create_dir(empty.path().join(".moonlet")).unwrap();
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
        std::fs::create_dir(dir.path().join(".moonlet")).unwrap();
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
        std::os::unix::fs::symlink(&victim, dir.path().join(".moonlet/.config.toml.moonlet-tmp"))
            .unwrap();
        let v = load(dir.path(), "main".into()).version;
        save(dir.path(), &v, &cfg(|c| c.run = Some("y".into()))).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        assert_eq!(read(&dir), "run = \"y\"\n");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path().join(".moonlet"))
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

    /// X44: the tracker projects a project's sessions start from.
    #[test]
    fn keeps_the_tracker_projects_it_handles() {
        let dir = repo_with(Some("# moonlet settings\nrun = \"pnpm dev\"\n"));
        let v = load(dir.path(), "main".into()).version;
        let linked = cfg(|c| {
            c.run = Some("pnpm dev".into());
            c.trackers = vec![
                "jira:acme.atlassian.net/ABC".into(),
                " linear:acme/ENG ".into(),
                "jira:acme.atlassian.net/ABC".into(),
            ];
        });
        save(dir.path(), &v, &linked).unwrap();
        assert_eq!(
            read(&dir),
            "# moonlet settings\nrun = \"pnpm dev\"\ntrackers = [\"jira:acme.atlassian.net/ABC\", \"linear:acme/ENG\"]\n"
        );
        let file = load(dir.path(), "main".into());
        assert_eq!(
            file.config.trackers,
            ["jira:acme.atlassian.net/ABC", "linear:acme/ENG"]
        );
        save(dir.path(), &file.version, &cfg(|c| c.run = Some("pnpm dev".into()))).unwrap();
        assert_eq!(read(&dir), "# moonlet settings\nrun = \"pnpm dev\"\n");
        let err = |t: &str| {
            validate(&normalize(&cfg(|c| c.trackers = vec![t.into()])))
                .unwrap_err()
                .to_string()
        };
        assert!(err("ABC").contains("`ABC`"), "{}", err("ABC"));
        assert!(err("jira:acme.atlassian.net").contains("connection/key"));
    }

    /// X27: a project set up under jaunt keeps its config.
    #[test]
    fn reads_the_jaunt_config_when_there_is_no_moonlet_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".jaunt")).unwrap();
        std::fs::write(dir.path().join(".jaunt/config.toml"), "run = \"pnpm dev\"\n").unwrap();

        let file = load(dir.path(), "main".into());
        assert!(file.exists);
        assert_eq!(file.path, dir.path().join(".jaunt/config.toml").display().to_string());
        assert_eq!(file.config.run.as_deref(), Some("pnpm dev"));
        assert_eq!(crate::session::read_config(dir.path()).run.as_deref(), Some("pnpm dev"));
    }

    #[test]
    fn saving_moves_the_jaunt_config_to_moonlet() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".jaunt")).unwrap();
        std::fs::write(dir.path().join(".jaunt/config.toml"), "# ours\nrun = \"pnpm dev\"\n").unwrap();
        let before = load(dir.path(), "main".into());

        save(dir.path(), &before.version, &cfg(|c| c.run = Some("pnpm start".into()))).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join(".moonlet/config.toml")).unwrap(),
            "# ours\nrun = \"pnpm start\"\n"
        );
        assert!(!dir.path().join(".jaunt").exists(), "the emptied .jaunt/ goes");
        assert_eq!(load(dir.path(), "main".into()).path, dir.path().join(".moonlet/config.toml").display().to_string());
    }

    #[test]
    fn saving_keeps_other_files_in_jaunt() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".jaunt")).unwrap();
        std::fs::write(dir.path().join(".jaunt/config.toml"), "").unwrap();
        std::fs::write(dir.path().join(".jaunt/notes.md"), "mine").unwrap();
        let before = load(dir.path(), "main".into());

        save(dir.path(), &before.version, &cfg(|c| c.run = Some("make".into()))).unwrap();

        assert!(!dir.path().join(".jaunt/config.toml").exists());
        assert_eq!(std::fs::read_to_string(dir.path().join(".jaunt/notes.md")).unwrap(), "mine");
    }
}
