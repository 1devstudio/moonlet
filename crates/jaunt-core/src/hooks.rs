//! Agent hook integration (A1, A2).
//!
//! * [`map_claude_event`] / [`map_codex_event`] turn hook payloads into agent
//!   states; `jaunt hook claude|codex` forwards them to the daemon.
//! * [`install`] / [`uninstall`] / [`status`] edit `~/.claude/settings.json`
//!   and `~/.codex/config.toml`, preserving everything that is not ours and
//!   writing a backup first.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use jaunt_proto::types::AgentState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Claude Code hook events jaunt listens to.
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
}

pub struct HookPaths {
    pub claude_settings: PathBuf,
    pub codex_config: PathBuf,
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
        }
    }

    pub fn default_paths() -> Self {
        Self::for_home(&dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")))
    }
}

/// Exactly a jaunt hook command: a program named `jaunt` (optionally
/// quoted, any directory) followed by `hook claude` or `hook codex`.
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
    basename == "jaunt" && matches!(args.as_slice(), ["hook", "claude" | "codex"])
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
            "{}.jaunt-backup-{ts}",
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
    let tmp = path.with_extension("jaunt-tmp");
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
    let (codex_installed, codex_conflict) = codex_notify(paths)?;
    Ok(HookStatus {
        claude_settings: paths.claude_settings.display().to_string(),
        claude_installed: missing.is_empty(),
        claude_missing_events: missing,
        codex_config: paths.codex_config.display().to_string(),
        codex_installed,
        codex_conflict,
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

/// Installs hooks that call `<jaunt_bin> hook claude|codex`. Idempotent.
pub fn install(
    paths: &HookPaths,
    jaunt_bin: &Path,
    claude: bool,
    codex: bool,
) -> Result<HookStatus> {
    if claude {
        let mut settings = read_json(&paths.claude_settings)?;
        let Some(obj) = settings.as_object_mut() else {
            bail!("{} is not a JSON object", paths.claude_settings.display())
        };
        let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
        let Some(hooks) = hooks.as_object_mut() else {
            bail!("\"hooks\" in Claude settings is not an object")
        };
        let command = format!("{} hook claude", quote(jaunt_bin));
        let mut changed = false;
        for event in CLAUDE_EVENTS {
            let groups = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
            let Some(groups) = groups.as_array_mut() else {
                continue;
            };
            // Drop stale jaunt entries (e.g. an old binary path), keep everything else.
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
        let (installed, conflict) = codex_notify(paths)?;
        if let Some(other) = conflict {
            bail!(
                "Codex already runs `{other}` on notify; jaunt will not replace it. Remove it from {} and retry.",
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
            arr.push(jaunt_bin.display().to_string());
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
    status(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(dir: &Path) -> HookPaths {
        HookPaths {
            claude_settings: dir.join("claude/settings.json"),
            codex_config: dir.join("codex/config.toml"),
        }
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

        let bin = Path::new("/Applications/jaunt.app/Contents/MacOS/jaunt");
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
        install(&p, Path::new("/Users/me/jaunt/bin/jaunt"), true, false).unwrap();
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
        assert!(install(&p, Path::new("/x/jaunt"), false, true).is_err());
        assert_eq!(
            status(&p).unwrap().codex_conflict.as_deref(),
            Some("terminal-notifier")
        );
    }

    #[test]
    fn only_jaunt_hook_commands_are_ours() {
        assert!(is_ours("/usr/local/bin/jaunt hook claude"));
        assert!(is_ours("'/Users/a b/.jaunt/bin/jaunt' hook codex"));
        assert!(is_ours("jaunt hook claude"));
        assert!(is_ours(&format!("{} hook claude", quote(Path::new("/Users/O'Brien/bin/jaunt")))));
        assert!(!is_ours("~/scripts/jaunty-notify hook x"));
        assert!(!is_ours("/bin/jaunt-helper hook claude"));
        assert!(!is_ours("jaunt hook claude && rm -rf ~"));
    }
}
