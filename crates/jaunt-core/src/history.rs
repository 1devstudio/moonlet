//! Shell history for input suggestions (T6). Read on the host that owns the
//! terminal, so remote shells suggest from their own history.

use std::path::{Path, PathBuf};

pub const MAX_ENTRIES: usize = 5000;

/// zsh: plain lines or extended `: <time>:<elapsed>;<command>`; a trailing
/// backslash continues the command on the next line.
pub fn parse_zsh(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let line = match &current {
            Some(_) => line.to_string(),
            None => match line
                .strip_prefix(": ")
                .and_then(|rest| rest.split_once(';'))
            {
                Some((_, cmd)) => cmd.to_string(),
                None => line.to_string(),
            },
        };
        let (body, continued) = match line.strip_suffix('\\') {
            Some(b) => (b.to_string(), true),
            None => (line, false),
        };
        let acc = current
            .take()
            .map(|c| format!("{c}\n{body}"))
            .unwrap_or(body);
        if continued {
            current = Some(acc);
        } else {
            out.push(acc);
        }
    }
    if let Some(c) = current {
        out.push(c);
    }
    out
}

/// bash: one command per line; `#<digits>` lines are timestamps.
pub fn parse_bash(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| {
            !(l.starts_with('#') && l[1..].chars().all(|c| c.is_ascii_digit()) && l.len() > 1)
        })
        .map(String::from)
        .collect()
}

/// fish: `- cmd: <command>` entries (with `\n` and `\\` escapes).
pub fn parse_fish(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| l.strip_prefix("- cmd: "))
        .map(|c| c.replace("\\n", "\n").replace("\\\\", "\\"))
        .collect()
}

/// Trims, drops empties and keeps only the newest copy of each command.
pub fn dedup(entries: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for e in entries.into_iter().rev() {
        let e = e.trim().to_string();
        if e.is_empty() || !seen.insert(e.clone()) {
            continue;
        }
        out.push(e);
        if out.len() >= MAX_ENTRIES {
            break;
        }
    }
    out.reverse();
    out
}

fn history_file(shell: &str, home: &Path) -> PathBuf {
    match shell {
        "bash" => std::env::var_os("HISTFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".bash_history")),
        "fish" => home.join(".local/share/fish/fish_history"),
        _ => {
            if let Some(f) = std::env::var_os("HISTFILE") {
                return PathBuf::from(f);
            }
            let zdot = std::env::var_os("ZDOTDIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.to_path_buf());
            let primary = zdot.join(".zsh_history");
            if primary.exists() {
                primary
            } else {
                home.join(".histfile")
            }
        }
    }
}

/// History of `shell` (zsh, bash or fish; defaults to the login shell),
/// oldest first, de-duplicated. Missing files give an empty list.
pub fn read(shell: Option<&str>) -> Vec<String> {
    let login = crate::pty::user_shell();
    let name = shell
        .map(String::from)
        .unwrap_or_else(|| login.rsplit('/').next().unwrap_or("zsh").to_string());
    let home = dirs::home_dir().unwrap_or_default();
    let file = history_file(&name, &home);
    // zsh history may contain non-UTF-8 "metafied" bytes; decode lossily.
    let Ok(bytes) = std::fs::read(&file) else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    let entries = match name.as_str() {
        "bash" => parse_bash(&text),
        "fish" => parse_fish(&text),
        _ => parse_zsh(&text),
    };
    dedup(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zsh_extended_plain_and_continuations() {
        let text = ": 1700000000:0;git status\n: 1700000001:0;echo a \\\nb\nls -la\n: 1700000002:3;git status\n";
        assert_eq!(
            parse_zsh(text),
            vec!["git status", "echo a \nb", "ls -la", "git status"]
        );
        assert_eq!(
            dedup(parse_zsh(text)),
            vec!["echo a \nb", "ls -la", "git status"]
        );
    }

    #[test]
    fn bash_skips_timestamps() {
        assert_eq!(
            parse_bash("#1700000000\nmake test\n#notatime\ncargo build\n"),
            vec!["make test", "#notatime", "cargo build"]
        );
    }

    #[test]
    fn fish_entries() {
        let text =
            "- cmd: cd ~/code\n  when: 1700000000\n- cmd: echo one\\ntwo\n  when: 1700000001\n";
        assert_eq!(parse_fish(text), vec!["cd ~/code", "echo one\ntwo"]);
    }

    #[test]
    fn dedup_keeps_newest_and_caps() {
        let many: Vec<String> = (0..MAX_ENTRIES + 10).map(|i| format!("cmd {i}")).collect();
        let d = dedup(many);
        assert_eq!(d.len(), MAX_ENTRIES);
        assert_eq!(d.last().unwrap(), &format!("cmd {}", MAX_ENTRIES + 9));
        assert_eq!(
            dedup(vec!["a".into(), " ".into(), "b".into(), "a".into()]),
            vec!["b", "a"]
        );
    }
}
