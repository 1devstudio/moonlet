//! Agent hook integration (A1, A2).
//!
//! * [`map_claude_event`] / [`map_codex_event`] turn hook payloads into agent
//!   states; `moonlet hook claude|codex` forwards them to the daemon.
//! * [`install`] / [`uninstall`] / [`status`] edit `~/.claude/settings.json`
//!   and `~/.codex/config.toml`, preserving everything that is not ours and
//!   writing a backup first. They also manage the `moonlet` skill (X22) in
//!   `~/.claude/skills/moonlet` and `~/.codex/skills/moonlet`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use moonlet_proto::types::AgentState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Claude Code hook events moonlet listens to.
pub const CLAUDE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "SessionEnd",
];

/// Maps a Claude Code hook payload (JSON on stdin) to a state and message.
pub fn map_claude_event(payload: &Value) -> Option<(AgentState, Option<String>)> {
    let event = payload.get("hook_event_name")?.as_str()?;
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .map(String::from);
    match event {
        "SessionStart" => Some((AgentState::Idle, None)),
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" => Some((AgentState::Working, None)),
        "PermissionRequest" => {
            let tool = payload
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or("a tool");
            Some((
                AgentState::Blocked,
                Some(format!("Permission needed for {tool}")),
            ))
        }
        "Notification" => {
            let kind = payload
                .get("notification_type")
                .and_then(Value::as_str)
                .unwrap_or("");
            let text = message.clone().unwrap_or_default();
            let idle = kind == "idle_prompt" || text.contains("waiting for your input");
            if idle {
                // Claude finished earlier and is waiting; keep it "done".
                Some((AgentState::Done, message))
            } else {
                Some((AgentState::Blocked, message))
            }
        }
        "Stop" => Some((AgentState::Done, None)),
        "SessionEnd" => Some((AgentState::Idle, None)),
        _ => None,
    }
}

/// Maps a Codex `notify` payload (JSON passed as the last argument).
pub fn map_codex_event(payload: &Value) -> Option<(AgentState, Option<String>)> {
    let kind = payload.get("type")?.as_str()?;
    let message = payload
        .get("last-assistant-message")
        .and_then(Value::as_str)
        .map(|m| m.chars().take(200).collect::<String>());
    match kind {
        "agent-turn-complete" => Some((AgentState::Done, message)),
        "approval-requested" | "exec-approval-request" | "apply-patch-approval-request" => Some((
            AgentState::Blocked,
            message.or(Some("Approval requested".into())),
        )),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HookStatus {
    pub claude_settings: String,
    pub claude_installed: bool,
    pub claude_missing_events: Vec<String>,
    pub codex_config: String,
    pub codex_installed: bool,
    /// Another `notify` program is configured for Codex; we do not replace it.
    pub codex_conflict: Option<String>,
    /// The current `moonlet` skill is in place (X22). `*_installed` include it.
    #[serde(default)]
    pub claude_skill: bool,
    #[serde(default)]
    pub codex_skill: bool,
}

/// The `moonlet` skill (X22), the same file for Claude Code and Codex.
pub const SKILL: &str = include_str!("skill/SKILL.md");

/// Marks a skill file as ours, so uninstall never removes a user's own.
const SKILL_MARKER: &str = "Installed by moonlet";
/// The same mark in the `jaunt` skill, installed before the rename (X27).
const JAUNT_SKILL_MARKER: &str = "Installed by jaunt";

/// The moonlet-design skill (X64): its steps, the card formats it reads in
/// its Cards step, and the design rules a design's agent follows (X65).
pub const DESIGN_SKILL_FILES: [(&str, &str); 3] = [
    ("SKILL.md", include_str!("skill/moonlet-design/SKILL.md")),
    ("cards.md", include_str!("skill/moonlet-design/cards.md")),
    ("designs.md", crate::design::agent::DESIGN_RULES),
];

/// Every file of moonlet's skills for one agent, given the `moonlet` skill's
/// path (`<agent>/skills/moonlet/SKILL.md`), with what it should hold. A
/// `moonlet-design` folder whose `SKILL.md` is the user's own is theirs
/// whole: none of its files is listed, so none is written or removed.
fn skill_files(path: &Path) -> Vec<(PathBuf, &'static str)> {
    let skills = path.parent().and_then(Path::parent).unwrap_or(Path::new(""));
    let design = skills.join("moonlet-design");
    let mut files = vec![(path.to_path_buf(), SKILL)];
    if !users_own(&design.join("SKILL.md")) {
        files.extend(DESIGN_SKILL_FILES.iter().map(|(name, text)| (design.join(name), *text)));
    }
    files
}

/// A file at a skill path that moonlet does not own: the user's, kept.
fn users_own(path: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|s| !s.contains(SKILL_MARKER))
}

/// moonlet's own `moonlet` skill is current, and every other file of its
/// skills is current or the user's own.
fn skill_installed(path: &Path) -> bool {
    skill_files(path)
        .iter()
        .all(|(p, text)| std::fs::read_to_string(p).is_ok_and(|s| s == *text) || (p != path && users_own(p)))
}

fn write_skill(path: &Path) -> Result<()> {
    for (p, text) in skill_files(path) {
        let current = std::fs::read_to_string(&p).is_ok_and(|s| s == text);
        // A file of the same name that is the user's own stays as it is.
        if !current && (p == path || !users_own(&p)) {
            write_atomic(&p, text).with_context(|| format!("cannot write {}", p.display()))?;
        }
    }
    remove_skill(&jaunt_skill(path), JAUNT_SKILL_MARKER)
}

/// Brings moonlet's skills up to date wherever its `moonlet` skill is
/// installed (X31): a file that differs from this version's is rewritten, and
/// a skill this version adds is written (X64), so a new moonlet teaches
/// agents its new commands. A file without our marker is the user's and is
/// left alone, and so is an agent whose `moonlet` skill is not ours.
/// Returns the files written.
pub fn refresh_skills(paths: &HookPaths) -> Result<Vec<PathBuf>> {
    let mut rewritten = Vec::new();
    for path in [&paths.claude_skill, &paths.codex_skill] {
        if !std::fs::read_to_string(path).is_ok_and(|t| t.contains(SKILL_MARKER)) {
            continue;
        }
        for (p, text) in skill_files(path) {
            let ours = match std::fs::read_to_string(&p) {
                Ok(t) => t != text && t.contains(SKILL_MARKER),
                Err(_) => true,
            };
            if ours {
                write_atomic(&p, text).with_context(|| format!("cannot write {}", p.display()))?;
                rewritten.push(p);
            }
        }
    }
    Ok(rewritten)
}

/// `skills/jaunt/SKILL.md` next to `skills/moonlet/SKILL.md`.
fn jaunt_skill(path: &Path) -> PathBuf {
    let skills = path.parent().and_then(Path::parent).unwrap_or(Path::new(""));
    skills.join("jaunt/SKILL.md")
}

fn remove_skill(path: &Path, marker: &str) -> Result<()> {
    if std::fs::read_to_string(path).is_ok_and(|s| s.contains(marker)) {
        std::fs::remove_file(path)?;
        if let Some(dir) = path.parent() {
            // Only if empty: anything else in it is the user's.
            let _ = std::fs::remove_dir(dir);
        }
    }
    Ok(())
}

pub struct HookPaths {
    pub claude_settings: PathBuf,
    pub codex_config: PathBuf,
    pub claude_skill: PathBuf,
    pub codex_skill: PathBuf,
}

impl HookPaths {
    pub fn for_home(home: &Path) -> Self {
        let claude_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"));
        let codex_dir = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        HookPaths {
            claude_settings: claude_dir.join("settings.json"),
            codex_config: codex_dir.join("config.toml"),
            claude_skill: claude_dir.join("skills/moonlet/SKILL.md"),
            codex_skill: codex_dir.join("skills/moonlet/SKILL.md"),
        }
    }

    /// The same paths with Claude's in a profile folder (X33).
    pub fn with_claude_dir(mut self, dir: &Path) -> Self {
        self.claude_settings = dir.join("settings.json");
        self.claude_skill = dir.join("skills/moonlet/SKILL.md");
        self
    }

    pub fn default_paths() -> Self {
        Self::for_home(&dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")))
    }
}

/// Exactly a moonlet hook command: a program named `moonlet` (or `jaunt`,
/// its name before the rename; optionally quoted, any directory) followed by
/// `hook claude` or `hook codex`.
fn is_ours(command: &str) -> bool {
    let s = command.trim();
    // The program, as `quote` writes it: bare, or single-quoted with `'\''`
    // standing for an apostrophe.
    let (program, rest) = if let Some(body) = s.strip_prefix('\'') {
        let mut prog = String::new();
        let mut rest = body;
        loop {
            let Some(end) = rest.find('\'') else { return false };
            prog.push_str(&rest[..end]);
            rest = &rest[end + 1..];
            if let Some(after) = rest.strip_prefix("\\''") {
                prog.push('\'');
                rest = after;
            } else {
                break;
            }
        }
        (prog, rest)
    } else {
        let end = s.find(char::is_whitespace).unwrap_or(s.len());
        (s[..end].to_string(), &s[end..])
    };
    let basename = program.rsplit('/').next().unwrap_or("");
    let args: Vec<&str> = rest.split_whitespace().collect();
    matches!(basename, "moonlet" | "jaunt") && matches!(args.as_slice(), ["hook", "claude" | "codex"])
}

fn quote(path: &Path) -> String {
    let s = path.display().to_string();
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c))
    {
        s
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

fn read_json(path: &Path) -> Result<Value> {
    match std::fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Ok(json!({})),
        Ok(s) => serde_json::from_str(&s)
            .with_context(|| format!("{} is not valid JSON", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}

fn backup(path: &Path) -> Result<()> {
    if path.exists() {
        let ts = crate::paths::now_ms();
        let name = format!(
            "{}.moonlet-backup-{ts}",
            path.file_name().unwrap().to_string_lossy()
        );
        std::fs::copy(path, path.with_file_name(name))?;
    }
    Ok(())
}

fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("moonlet-tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn claude_events_installed(settings: &Value) -> Vec<String> {
    let mut found = Vec::new();
    if let Some(hooks) = settings.get("hooks").and_then(Value::as_object) {
        for (event, groups) in hooks {
            let has = groups.as_array().into_iter().flatten().any(|g| {
                g.get("hooks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .any(|h| {
                        h.get("command")
                            .and_then(Value::as_str)
                            .is_some_and(is_ours)
                    })
            });
            if has {
                found.push(event.clone());
            }
        }
    }
    found
}

pub fn status(paths: &HookPaths) -> Result<HookStatus> {
    let settings = read_json(&paths.claude_settings).unwrap_or(json!({}));
    let found = claude_events_installed(&settings);
    let missing: Vec<String> = CLAUDE_EVENTS
        .iter()
        .filter(|e| !found.iter().any(|f| f == *e))
        .map(|e| e.to_string())
        .collect();
    let (codex_notify, codex_conflict) = codex_notify(paths)?;
    let (claude_skill, codex_skill) = (skill_installed(&paths.claude_skill), skill_installed(&paths.codex_skill));
    Ok(HookStatus {
        claude_settings: paths.claude_settings.display().to_string(),
        claude_installed: missing.is_empty() && claude_skill,
        claude_missing_events: missing,
        codex_config: paths.codex_config.display().to_string(),
        codex_installed: codex_notify && codex_skill,
        codex_conflict,
        claude_skill,
        codex_skill,
    })
}

fn codex_notify(paths: &HookPaths) -> Result<(bool, Option<String>)> {
    let text = match std::fs::read_to_string(&paths.codex_config) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((false, None)),
        Err(e) => {
            return Err(e).with_context(|| format!("cannot read {}", paths.codex_config.display()));
        }
    };
    let doc: toml_edit::DocumentMut = text
        .parse()
        .with_context(|| format!("{} is not valid TOML", paths.codex_config.display()))?;
    let Some(notify) = doc.get("notify").and_then(|i| i.as_array()) else {
        return Ok((false, None));
    };
    let joined: Vec<String> = notify
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    let line = joined.join(" ");
    if is_ours(&line) {
        Ok((true, None))
    } else {
        Ok((false, Some(line)))
    }
}

/// Installs hooks that call `<moonlet_bin> hook claude|codex`. Idempotent.
pub fn install(
    paths: &HookPaths,
    moonlet_bin: &Path,
    claude: bool,
    codex: bool,
) -> Result<HookStatus> {
    if claude {
        write_skill(&paths.claude_skill)?;
        let mut settings = read_json(&paths.claude_settings)?;
        let Some(obj) = settings.as_object_mut() else {
            bail!("{} is not a JSON object", paths.claude_settings.display())
        };
        let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
        let Some(hooks) = hooks.as_object_mut() else {
            bail!("\"hooks\" in Claude settings is not an object")
        };
        let command = format!("{} hook claude", quote(moonlet_bin));
        let mut changed = false;
        for event in CLAUDE_EVENTS {
            let groups = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
            let Some(groups) = groups.as_array_mut() else {
                continue;
            };
            // Drop stale moonlet entries (e.g. an old binary path), keep everything else.
            for g in groups.iter_mut() {
                if let Some(list) = g.get_mut("hooks").and_then(Value::as_array_mut) {
                    let before = list.len();
                    list.retain(|h| {
                        let c = h.get("command").and_then(Value::as_str).unwrap_or("");
                        !is_ours(c) || c == command
                    });
                    changed |= list.len() != before;
                }
            }
            groups.retain(|g| {
                g.get("hooks")
                    .and_then(Value::as_array)
                    .is_none_or(|l| !l.is_empty())
            });
            let present = groups.iter().any(|g| {
                g.get("hooks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .any(|h| h.get("command").and_then(Value::as_str) == Some(&command))
            });
            if !present {
                let mut entry =
                    json!({ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] });
                if matches!(*event, "PreToolUse" | "PostToolUse" | "PermissionRequest") {
                    entry["matcher"] = json!("*");
                }
                groups.push(entry);
                changed = true;
            }
        }
        if changed {
            backup(&paths.claude_settings)?;
            write_atomic(
                &paths.claude_settings,
                &(serde_json::to_string_pretty(&settings)? + "\n"),
            )?;
        }
    }
    if codex {
        // The skill does not depend on `notify`, so a conflict there keeps it.
        write_skill(&paths.codex_skill)?;
        let (installed, conflict) = codex_notify(paths)?;
        if let Some(other) = conflict {
            bail!(
                "Codex already runs `{other}` on notify; moonlet will not replace it. Remove it from {} and retry.",
                paths.codex_config.display()
            );
        }
        if !installed {
            // Only a missing file starts empty; an unreadable one must not be
            // replaced by a file holding just our `notify`.
            let text = match std::fs::read_to_string(&paths.codex_config) {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(e) => {
                    return Err(e)
                        .with_context(|| format!("cannot read {}", paths.codex_config.display()));
                }
            };
            let mut doc: toml_edit::DocumentMut = text.parse()?;
            let mut arr = toml_edit::Array::new();
            arr.push(moonlet_bin.display().to_string());
            arr.push("hook");
            arr.push("codex");
            // `notify` must be a top-level key, i.e. before any [table].
            doc.insert("notify", toml_edit::value(arr));
            backup(&paths.codex_config)?;
            write_atomic(&paths.codex_config, &doc.to_string())?;
        }
    }
    status(paths)
}

pub fn uninstall(paths: &HookPaths) -> Result<HookStatus> {
    let mut settings = read_json(&paths.claude_settings)?;
    let mut changed = false;
    if let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) {
        for groups in hooks.values_mut() {
            if let Some(groups) = groups.as_array_mut() {
                for g in groups.iter_mut() {
                    if let Some(list) = g.get_mut("hooks").and_then(Value::as_array_mut) {
                        let before = list.len();
                        list.retain(|h| {
                            !h.get("command")
                                .and_then(Value::as_str)
                                .is_some_and(is_ours)
                        });
                        changed |= before != list.len();
                    }
                }
                groups.retain(|g| {
                    g.get("hooks")
                        .and_then(Value::as_array)
                        .is_none_or(|l| !l.is_empty())
                });
            }
        }
        hooks.retain(|_, v| v.as_array().is_none_or(|a| !a.is_empty()));
    }
    if changed {
        backup(&paths.claude_settings)?;
        write_atomic(
            &paths.claude_settings,
            &(serde_json::to_string_pretty(&settings)? + "\n"),
        )?;
    }
    if let (true, _) = codex_notify(paths)? {
        let text = std::fs::read_to_string(&paths.codex_config)?;
        let mut doc: toml_edit::DocumentMut = text.parse()?;
        doc.remove("notify");
        backup(&paths.codex_config)?;
        write_atomic(&paths.codex_config, &doc.to_string())?;
    }
    for skill in [&paths.claude_skill, &paths.codex_skill] {
        for (p, _) in skill_files(skill) {
            remove_skill(&p, SKILL_MARKER)?;
        }
        remove_skill(&jaunt_skill(skill), JAUNT_SKILL_MARKER)?;
    }
    status(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(dir: &Path) -> HookPaths {
        HookPaths {
            claude_settings: dir.join("claude/settings.json"),
            codex_config: dir.join("codex/config.toml"),
            claude_skill: dir.join("claude/skills/moonlet/SKILL.md"),
            codex_skill: dir.join("codex/skills/moonlet/SKILL.md"),
        }
    }

    /// X22: the skill that teaches agents `moonlet session new`.
    #[test]
    fn install_writes_the_moonlet_skill_for_both_agents_and_uninstall_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        let mine = dir.path().join("claude/skills/mine/SKILL.md");
        std::fs::create_dir_all(mine.parent().unwrap()).unwrap();
        std::fs::write(&mine, "---\nname: mine\n---\n").unwrap();

        let bin = Path::new("/Applications/moonlet.app/Contents/MacOS/moonlet");
        let st = install(&p, bin, true, true).unwrap();
        assert!(st.claude_skill && st.codex_skill, "{st:?}");
        assert!(st.claude_installed && st.codex_installed, "{st:?}");
        for skill in [&p.claude_skill, &p.codex_skill] {
            let text = std::fs::read_to_string(skill).unwrap();
            assert!(text.starts_with("---\nname: moonlet\n"), "{text}");
            assert!(text.contains(r#""$MOONLET_BIN" session new <project> "<prompt>""#), "{text}");
        }

        // Hooks without the skill (installed by an older moonlet) still need an install.
        std::fs::remove_file(&p.claude_skill).unwrap();
        let st = status(&p).unwrap();
        assert!(!st.claude_skill && !st.claude_installed, "{st:?}");
        install(&p, bin, true, false).unwrap();
        assert!(p.claude_skill.exists());

        let st = uninstall(&p).unwrap();
        assert!(!st.claude_skill && !st.codex_skill, "{st:?}");
        assert!(!dir.path().join("claude/skills/moonlet").exists());
        assert!(!dir.path().join("codex/skills/moonlet").exists());
        assert_eq!(std::fs::read_to_string(&mine).unwrap(), "---\nname: mine\n---\n", "other skills kept");
    }

    /// X64: the moonlet-design skill and its card formats install, report and
    /// uninstall with the moonlet skill.
    #[test]
    fn install_writes_the_moonlet_design_skill_beside_the_moonlet_skill() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        let bin = Path::new("/Applications/moonlet.app/Contents/MacOS/moonlet");
        install(&p, bin, true, true).unwrap();
        for agent in ["claude", "codex"] {
            let skill = std::fs::read_to_string(dir.path().join(agent).join("skills/moonlet-design/SKILL.md")).unwrap();
            assert!(skill.starts_with("---\nname: moonlet-design\n"), "{skill}");
            let cards = std::fs::read_to_string(dir.path().join(agent).join("skills/moonlet-design/cards.md")).unwrap();
            assert!(cards.contains("# Cards, snippets and `.prompt.md`"), "{cards}");
            // The design rules a design's agent follows (X65).
            let rules = std::fs::read_to_string(dir.path().join(agent).join("skills/moonlet-design/designs.md")).unwrap();
            assert!(rules.contains("# Design rules"), "{rules}");
        }
        // Without it, the skills are not current and an install is due.
        std::fs::remove_file(dir.path().join("claude/skills/moonlet-design/cards.md")).unwrap();
        let st = status(&p).unwrap();
        assert!(!st.claude_skill && st.codex_skill, "{st:?}");
        uninstall(&p).unwrap();
        assert!(!dir.path().join("claude/skills/moonlet-design").exists());
        assert!(!dir.path().join("codex/skills/moonlet-design").exists());
    }

    /// X64: a skill of the user's own that shares a name with moonlet's is
    /// never overwritten, refreshed or removed, and does not keep moonlet's
    /// skills from counting as installed.
    #[test]
    fn a_users_own_moonlet_design_skill_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        let theirs = dir.path().join("claude/skills/moonlet-design/SKILL.md");
        std::fs::create_dir_all(theirs.parent().unwrap()).unwrap();
        std::fs::write(&theirs, "---\nname: moonlet-design\n---\nmy own\n").unwrap();
        let st = install(&p, Path::new("/bin/moonlet"), true, false).unwrap();
        assert!(st.claude_skill, "{st:?}");
        assert_eq!(std::fs::read_to_string(&theirs).unwrap(), "---\nname: moonlet-design\n---\nmy own\n");
        refresh_skills(&p).unwrap();
        uninstall(&p).unwrap();
        assert_eq!(std::fs::read_to_string(&theirs).unwrap(), "---\nname: moonlet-design\n---\nmy own\n");
    }

    /// X64: a skill folder whose `SKILL.md` is the user's own gains no file
    /// of moonlet's on install or refresh, and loses none on uninstall.
    #[test]
    fn a_users_own_moonlet_design_skill_gains_or_loses_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        let theirs = dir.path().join("claude/skills/moonlet-design");
        std::fs::create_dir_all(&theirs).unwrap();
        std::fs::write(theirs.join("SKILL.md"), "---\nname: moonlet-design\n---\nmy own\n").unwrap();
        install(&p, Path::new("/bin/moonlet"), true, false).unwrap();
        assert!(!theirs.join("cards.md").exists(), "install wrote into the user's skill");
        assert_eq!(refresh_skills(&p).unwrap(), Vec::<PathBuf>::new());
        assert!(!theirs.join("cards.md").exists(), "refresh wrote into the user's skill");

        let marked = "<!-- Installed by moonlet (`moonlet hooks install`); reinstalling overwrites this file. -->\nmy notes\n";
        std::fs::write(theirs.join("cards.md"), marked).unwrap();
        uninstall(&p).unwrap();
        assert_eq!(std::fs::read_to_string(theirs.join("cards.md")).unwrap(), marked);
    }

    /// X22: a `moonlet` skill the user wrote is not moonlet's, so an install
    /// is still due (and would put moonlet's in its place).
    #[test]
    fn a_moonlet_skill_the_user_wrote_does_not_count_as_installed() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        install(&p, Path::new("/bin/moonlet"), true, true).unwrap();
        std::fs::write(&p.claude_skill, "---\nname: moonlet\n---\nmy own notes\n").unwrap();
        let st = status(&p).unwrap();
        assert!(!st.claude_skill && !st.claude_installed, "{st:?}");
        assert!(st.codex_skill && st.codex_installed, "{st:?}");
    }

    /// X64: a moonlet that ships a new skill adds it on start wherever its
    /// older skills are installed.
    #[test]
    fn refresh_adds_the_moonlet_design_skill_where_the_moonlet_skill_is() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        std::fs::create_dir_all(p.claude_skill.parent().unwrap()).unwrap();
        std::fs::write(&p.claude_skill, SKILL).unwrap();
        let rewritten = refresh_skills(&p).unwrap();
        assert_eq!(
            rewritten,
            vec![
                dir.path().join("claude/skills/moonlet-design/SKILL.md"),
                dir.path().join("claude/skills/moonlet-design/cards.md"),
                dir.path().join("claude/skills/moonlet-design/designs.md")
            ]
        );
        assert!(!dir.path().join("codex/skills/moonlet-design").exists(), "no moonlet skill there, nothing added");
        assert!(status(&p).unwrap().claude_skill);
    }

    /// X64: the card the skill shows as its example passes moonlet's check,
    /// so the skill never teaches a format the check refuses.
    #[test]
    fn the_skills_example_card_passes_the_design_check() {
        let cards = DESIGN_SKILL_FILES.iter().find(|(f, _)| *f == "cards.md").unwrap().1;
        let html = cards.split("```html\n").nth(1).and_then(|r| r.split("\n```").next()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let card = dir.path().join("components/buttons/button/button.html");
        std::fs::create_dir_all(card.parent().unwrap()).unwrap();
        std::fs::write(&card, format!("{html}\n")).unwrap();
        std::fs::write(dir.path().join("styles.css"), "@import \"components.css\";\n").unwrap();
        std::fs::write(dir.path().join("components.css"), ".btn {}\n.btn--primary {}\n").unwrap();
        assert_eq!(crate::design::check::check(dir.path()).unwrap(), vec![]);
    }

    /// X31: an installed skill from an older moonlet is brought up to date
    /// when the daemon starts; nothing else is written.
    #[test]
    fn refresh_updates_only_outdated_skills_moonlet_installed() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        let old = "---\nname: moonlet\n---\n<!-- Installed by moonlet (`moonlet hooks install`); reinstalling overwrites this file. -->\nold text\n";
        std::fs::create_dir_all(p.claude_skill.parent().unwrap()).unwrap();
        std::fs::write(&p.claude_skill, old).unwrap();

        let design = dir.path().join("claude/skills/moonlet-design");
        assert_eq!(
            refresh_skills(&p).unwrap(),
            vec![p.claude_skill.clone(), design.join("SKILL.md"), design.join("cards.md"), design.join("designs.md")]
        );
        let text = std::fs::read_to_string(&p.claude_skill).unwrap();
        assert!(text.contains(r#""$MOONLET_BIN" term read <id>"#), "{text}");
        assert!(!p.codex_skill.exists(), "a skill never installed stays absent");
        assert_eq!(refresh_skills(&p).unwrap(), Vec::<PathBuf>::new(), "current skills are left alone");

        let users = "---\nname: moonlet\n---\nmy own notes\n";
        std::fs::create_dir_all(p.codex_skill.parent().unwrap()).unwrap();
        std::fs::write(&p.codex_skill, users).unwrap();
        assert_eq!(refresh_skills(&p).unwrap(), Vec::<PathBuf>::new());
        assert_eq!(std::fs::read_to_string(&p.codex_skill).unwrap(), users, "a file without the marker is the user's");
    }

    #[test]
    fn maps_claude_events() {
        let p = json!({"hook_event_name": "Notification", "message": "Claude needs your permission to use Bash"});
        assert_eq!(
            map_claude_event(&p),
            Some((
                AgentState::Blocked,
                Some("Claude needs your permission to use Bash".into())
            ))
        );
        let idle = json!({"hook_event_name": "Notification", "notification_type": "idle_prompt", "message": "Claude is waiting for your input"});
        assert_eq!(map_claude_event(&idle).unwrap().0, AgentState::Done);
        assert_eq!(
            map_claude_event(&json!({"hook_event_name": "Stop"}))
                .unwrap()
                .0,
            AgentState::Done
        );
        assert_eq!(
            map_claude_event(&json!({"hook_event_name": "PreToolUse"}))
                .unwrap()
                .0,
            AgentState::Working
        );
        assert_eq!(
            map_claude_event(&json!({"hook_event_name": "PreCompact"})),
            None
        );
    }

    #[test]
    fn maps_codex_events() {
        let p = json!({"type": "agent-turn-complete", "last-assistant-message": "All tests pass"});
        assert_eq!(
            map_codex_event(&p),
            Some((AgentState::Done, Some("All tests pass".into())))
        );
    }

    #[test]
    fn install_preserves_user_settings_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        std::fs::create_dir_all(p.claude_settings.parent().unwrap()).unwrap();
        std::fs::write(
            &p.claude_settings,
            r#"{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(p.codex_config.parent().unwrap()).unwrap();
        std::fs::write(
            &p.codex_config,
            "model = \"gpt-5\"\n\n[tui]\nnotifications = true\n",
        )
        .unwrap();

        let bin = Path::new("/Applications/moonlet.app/Contents/MacOS/moonlet");
        let st = install(&p, bin, true, true).unwrap();
        assert!(st.claude_installed && st.codex_installed, "{st:?}");
        let first = std::fs::read_to_string(&p.claude_settings).unwrap();
        install(&p, bin, true, true).unwrap();
        assert_eq!(
            first,
            std::fs::read_to_string(&p.claude_settings).unwrap(),
            "second install is a no-op"
        );

        let v: Value = serde_json::from_str(&first).unwrap();
        assert_eq!(v["model"], "opus");
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert!(
            stop.iter().any(|g| g["hooks"][0]["command"] == "say done"),
            "user hook kept"
        );
        let toml = std::fs::read_to_string(&p.codex_config).unwrap();
        assert!(toml.contains("model = \"gpt-5\"") && toml.contains("[tui]"));
        let doc: toml::Table = toml.parse().unwrap();
        assert!(doc.contains_key("notify"), "notify is top-level: {toml}");

        // Moving the app replaces the stale command instead of duplicating it.
        install(&p, Path::new("/Users/me/moonlet/bin/moonlet"), true, false).unwrap();
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(&p.claude_settings).unwrap()).unwrap();
        let ours: Vec<_> = v["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|g| g["hooks"].as_array().unwrap().clone())
            .filter(|h| is_ours(h["command"].as_str().unwrap()))
            .collect();
        assert_eq!(ours.len(), 1);

        let st = uninstall(&p).unwrap();
        assert!(!st.claude_installed && !st.codex_installed);
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(&p.claude_settings).unwrap()).unwrap();
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");
        assert!(v["hooks"].get("PreToolUse").is_none());
    }

    #[test]
    fn refuses_to_replace_foreign_codex_notify() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        std::fs::create_dir_all(p.codex_config.parent().unwrap()).unwrap();
        std::fs::write(&p.codex_config, "notify = [\"terminal-notifier\"]\n").unwrap();
        assert!(install(&p, Path::new("/x/moonlet"), false, true).is_err());
        assert_eq!(
            status(&p).unwrap().codex_conflict.as_deref(),
            Some("terminal-notifier")
        );
    }

    #[test]
    fn only_moonlet_hook_commands_are_ours() {
        assert!(is_ours("/usr/local/bin/moonlet hook claude"));
        assert!(is_ours("'/Users/a b/.moonlet/bin/moonlet' hook codex"));
        assert!(is_ours("moonlet hook claude"));
        assert!(is_ours(&format!("{} hook claude", quote(Path::new("/Users/O'Brien/bin/moonlet")))));
        assert!(!is_ours("~/scripts/moonlety-notify hook x"));
        assert!(!is_ours("/bin/moonlet-helper hook claude"));
        assert!(!is_ours("moonlet hook claude && rm -rf ~"));
    }

    #[test]
    fn install_replaces_hooks_written_by_jaunt() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        std::fs::create_dir_all(p.claude_settings.parent().unwrap()).unwrap();
        std::fs::write(
            &p.claude_settings,
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/Applications/jaunt.app/Contents/MacOS/jaunt hook claude"}]}]}}"#,
        )
        .unwrap();

        install(&p, Path::new("/Applications/moonlet.app/Contents/MacOS/moonlet"), true, false).unwrap();

        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(&p.claude_settings).unwrap()).unwrap();
        let commands: Vec<_> = v["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|g| g["hooks"].as_array().unwrap())
            .map(|h| h["command"].as_str().unwrap())
            .collect();
        assert_eq!(commands, ["/Applications/moonlet.app/Contents/MacOS/moonlet hook claude"]);
    }

    /// X27: the skill jaunt installed goes; a `jaunt` skill the user wrote
    /// stays.
    #[test]
    fn install_removes_the_skill_jaunt_installed() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        let jaunts = dir.path().join("claude/skills/jaunt/SKILL.md");
        std::fs::create_dir_all(jaunts.parent().unwrap()).unwrap();
        std::fs::write(&jaunts, "---\nname: jaunt\n---\n\n<!-- Installed by jaunt (`jaunt hooks install`); reinstalling overwrites this file. -->\n").unwrap();
        let users = dir.path().join("codex/skills/jaunt/SKILL.md");
        std::fs::create_dir_all(users.parent().unwrap()).unwrap();
        std::fs::write(&users, "---\nname: jaunt\n---\nmy own notes\n").unwrap();

        install(&p, Path::new("/Applications/moonlet.app/Contents/MacOS/moonlet"), true, true).unwrap();

        assert!(!dir.path().join("claude/skills/jaunt").exists());
        assert_eq!(std::fs::read_to_string(&users).unwrap(), "---\nname: jaunt\n---\nmy own notes\n");
        assert!(p.claude_skill.exists() && p.codex_skill.exists());
    }
}
