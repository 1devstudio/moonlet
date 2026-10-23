//! Heavy commands (X62): which Bash calls of an agent may run on another
//! machine. A project lists command prefixes under `[heavy]` in its
//! `.moonlet/config.toml`; a call is routable when its words start with an
//! approved entry's words and nothing in it would make a shell expand,
//! chain or redirect.

use moonlet_proto::types::HeavyConfig;

/// Characters that make a shell expand, chain, redirect or glob. A command
/// with any of them outside single quotes is never routed.
const SHELL_CHARS: &[char] = &[
    ';', '&', '|', '<', '>', '(', ')', '$', '`', '*', '?', '[', '{', '~', '#',
];

/// The words of `command` when it starts with the words of one of
/// `entries` and a shell would run it as one plain command; `None`
/// otherwise.
pub fn route(command: &str, entries: &[String]) -> Option<Vec<String>> {
    let words = split(command)?;
    if words
        .first()
        .is_some_and(|w| SHELL_WORDS.contains(&w.as_str()))
    {
        return None;
    }
    let starts =
        |entry: &String| split(entry).is_some_and(|e| !e.is_empty() && words.starts_with(&e));
    entries.iter().any(starts).then_some(words)
}

/// Bash keywords, and builtins with no program of their own: Bash runs
/// them itself, and a worker runs a command without a shell.
const SHELL_WORDS: &[&str] = &[
    "!",
    "time",
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "case",
    "esac",
    "for",
    "select",
    "while",
    "until",
    "do",
    "done",
    "in",
    "function",
    "coproc",
    "[[",
    "]]",
    ".",
    "source",
    "alias",
    "unalias",
    "bg",
    "fg",
    "jobs",
    "disown",
    "bind",
    "break",
    "continue",
    "builtin",
    "caller",
    "cd",
    "pushd",
    "popd",
    "dirs",
    "command",
    "declare",
    "typeset",
    "local",
    "readonly",
    "export",
    "unset",
    "enable",
    "eval",
    "exec",
    "exit",
    "logout",
    "return",
    "fc",
    "history",
    "getopts",
    "hash",
    "let",
    "mapfile",
    "readarray",
    "read",
    "set",
    "shift",
    "shopt",
    "suspend",
    "trap",
    "type",
    "ulimit",
    "umask",
    "wait",
];

/// Splits `command` into words as a POSIX shell would, or `None` when it
/// has anything beyond words, spaces and quotes: a shell character outside
/// single quotes, a newline, an unclosed quote, or a leading assignment.
pub fn split(command: &str) -> Option<Vec<String>> {
    if command.contains(['\n', '\r']) {
        return None;
    }
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' => words.extend(word.take()),
            '\'' => {
                let w = word.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '\'' => break,
                        c => w.push(c),
                    }
                }
            }
            '"' => {
                let w = word.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => match chars.next()? {
                            c @ ('"' | '\\') => w.push(c),
                            c if SHELL_CHARS.contains(&c) => return None,
                            c => {
                                w.push('\\');
                                w.push(c);
                            }
                        },
                        c if SHELL_CHARS.contains(&c) => return None,
                        c => w.push(c),
                    }
                }
            }
            '\\' => match chars.next()? {
                c if SHELL_CHARS.contains(&c) => return None,
                c => word.get_or_insert_with(String::new).push(c),
            },
            c if SHELL_CHARS.contains(&c) => return None,
            c => word.get_or_insert_with(String::new).push(c),
        }
    }
    words.extend(word);
    let assignment = words.first().is_some_and(|w| {
        w.split_once('=').is_some_and(|(name, _)| {
            name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    });
    (!assignment).then_some(words)
}

/// A `deny` or `ask` rule for Bash in Claude Code's settings, as far as
/// moonlet reads it. A routed call runs without Claude Code's prompt for
/// the original command, so any such rule that may match keeps the call
/// where it is.
#[derive(Debug, Clone, PartialEq)]
pub enum BashRule {
    /// Matches every command: `Bash`, `Bash(*)`, or a settings file that
    /// cannot be read.
    All,
    /// `Bash(pnpm build:*)`, `Bash(pnpm build *)` or `Bash(pnpm build)`:
    /// commands that start with it, compared both as text and word by
    /// word (the last word as a text prefix), so neither spacing nor
    /// quoting slips past it.
    Prefix(String),
    /// A pattern moonlet cannot read, such as `Bash(pnpm * --coverage)`:
    /// every command with its first word.
    FirstWord(String),
}

/// The Bash `deny` and `ask` rules in Claude Code settings `files`. A
/// missing file has none.
pub fn claude_rules(files: &[std::path::PathBuf]) -> Vec<BashRule> {
    let mut rules = Vec::new();
    for f in files {
        let text = match std::fs::read_to_string(f) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                rules.push(BashRule::All);
                continue;
            }
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
            rules.push(BashRule::All);
            continue;
        };
        for list in ["deny", "ask"] {
            let entries = json
                .pointer(&format!("/permissions/{list}"))
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str());
            rules.extend(entries.filter_map(bash_rule));
        }
    }
    rules
}

fn bash_rule(rule: &str) -> Option<BashRule> {
    let rule = rule.trim();
    if rule == "Bash" {
        return Some(BashRule::All);
    }
    let inner = rule.strip_prefix("Bash(")?.strip_suffix(')')?.trim();
    let prefix = inner
        .strip_suffix(":*")
        .or_else(|| inner.strip_suffix(" *"))
        .unwrap_or(inner)
        .trim();
    if !prefix.contains('*') && split(prefix).is_some_and(|w| !w.is_empty()) {
        return Some(BashRule::Prefix(prefix.to_string()));
    }
    match inner.split_whitespace().next() {
        Some(first) if !first.contains('*') => Some(BashRule::FirstWord(first.to_string())),
        _ => Some(BashRule::All),
    }
}

/// Whether one of `rules` may match `command`, which splits into `words`.
pub fn rules_block(rules: &[BashRule], command: &str, words: &[String]) -> bool {
    let text = words.join(" ");
    rules.iter().any(|r| match r {
        BashRule::All => true,
        BashRule::Prefix(p) => {
            let by_words = split(p).is_some_and(|rule| {
                let Some((last, head)) = rule.split_last() else {
                    return true;
                };
                words.len() >= rule.len()
                    && words.starts_with(head)
                    && words[head.len()].starts_with(last.as_str())
            });
            by_words || text.starts_with(p.as_str()) || command.trim_start().starts_with(p.as_str())
        }
        BashRule::FirstWord(w) => words.first() == Some(w),
    })
}

/// Why `[heavy]` cannot be used as written, checked when the config is
/// read or saved.
pub fn check(heavy: &HeavyConfig) -> Result<(), String> {
    for c in &heavy.commands {
        if split(c).is_none_or(|w| w.is_empty()) {
            return Err(format!("commands: `{c}` is not a plain command"));
        }
    }
    for name in &heavy.env {
        let ok = name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !ok {
            return Err(format!("env: `{name}` is not a variable name"));
        }
    }
    for out in &heavy.outputs {
        let path = std::path::Path::new(out.trim());
        let escapes = path.is_absolute()
            || path
                .components()
                .any(|c| c == std::path::Component::ParentDir);
        if escapes {
            return Err(format!("outputs: `{out}` is outside the worktree"));
        }
        let named = path
            .components()
            .any(|c| matches!(c, std::path::Component::Normal(_)));
        let reserved = path.components().any(|c| match c {
            std::path::Component::Normal(n) => {
                let n = n.to_string_lossy();
                crate::sync::reads_as(&n, ".git") || crate::sync::reads_as(&n, ".moonlet")
            }
            _ => false,
        });
        if named && reserved {
            return Err(format!("outputs: `{out}` is git's or moonlet's own"));
        }
        if !named {
            return Err(format!(
                "outputs: `{out}` is the whole worktree; name a folder or file in it"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use moonlet_proto::types::HeavyOs;

    use super::*;
    use crate::project_config;

    #[test]
    fn heavy_table_reads_commands_os_env_and_outputs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".moonlet")).unwrap();
        std::fs::write(
            dir.path().join(".moonlet/config.toml"),
            "setup = \"pnpm install\"\n\n[heavy]\ncommands = [\"pnpm test\", \"pnpm build\"]\nos = \"linux\"\nenv = [\"CI\", \"NPM_TOKEN\"]\noutputs = [\"coverage\"]\n",
        )
        .unwrap();
        let file = project_config::load(dir.path(), "main".into());
        assert_eq!(file.error, None);
        assert_eq!(
            file.config.heavy,
            HeavyConfig {
                commands: vec!["pnpm test".into(), "pnpm build".into()],
                os: HeavyOs::Linux,
                env: vec!["CI".into(), "NPM_TOKEN".into()],
                outputs: vec!["coverage".into()],
            }
        );
        // No table reads as no heavy commands, on any system.
        std::fs::write(
            dir.path().join(".moonlet/config.toml"),
            "setup = \"pnpm install\"\n",
        )
        .unwrap();
        let file = project_config::load(dir.path(), "main".into());
        assert_eq!(file.config.heavy, HeavyConfig::default());
        assert_eq!(file.config.heavy.os, HeavyOs::Any);
    }

    fn words(w: &[&str]) -> Option<Vec<String>> {
        Some(w.iter().map(|s| s.to_string()).collect())
    }

    /// X62's table of which Bash commands are routed, for the entries
    /// `pnpm test` and `cargo test`.
    #[test]
    fn routes_exactly_the_worked_examples() {
        let entries = vec!["pnpm test".to_string(), "cargo test".to_string()];
        let cases: [(&str, Option<Vec<String>>); 14] = [
            ("pnpm test", words(&["pnpm", "test"])),
            (
                "pnpm test src/cart.test.ts --run",
                words(&["pnpm", "test", "src/cart.test.ts", "--run"]),
            ),
            ("pnpm  test", words(&["pnpm", "test"])),
            ("\"pnpm\" test", words(&["pnpm", "test"])),
            ("pnpm testing", None),
            ("pnpm test && git status", None),
            ("pnpm test 2>&1 | tail -50", None),
            ("cd web && pnpm test", None),
            ("NODE_ENV=test pnpm test", None),
            ("pnpm test $(cat files.txt)", None),
            ("pnpm test \"$FILE\"", None),
            ("cargo test 'a b'", words(&["cargo", "test", "a b"])),
            ("pnpm test src/*.ts", None),
            ("pnpm test # all", None),
        ];
        for (command, expected) in cases {
            assert_eq!(route(command, &entries), expected, "{command}");
        }
        // A newline is a second command.
        assert_eq!(route("pnpm test\nrm -rf /", &entries), None);
    }

    #[test]
    fn shell_keywords_and_builtins_are_never_routed() {
        // Approved or not, Bash runs these itself, and a worker runs no shell.
        let entries: Vec<String> = ["time pnpm test", "! pnpm test", "cd", "export", "source"]
            .iter()
            .map(|e| e.to_string())
            .collect();
        for command in [
            "time pnpm test",
            "! pnpm test",
            "cd web",
            "export CI",
            "source env.sh",
        ] {
            assert_eq!(route(command, &entries), None, "{command}");
        }
        // A command with a program of its own still routes.
        let entries = vec!["echo".to_string()];
        assert_eq!(route("echo ok", &entries), words(&["echo", "ok"]));
    }

    fn settings(dir: &std::path::Path, name: &str, json: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, json).unwrap();
        p
    }

    fn blocked_by(files: &[std::path::PathBuf], command: &str) -> bool {
        rules_block(&claude_rules(files), command, &split(command).unwrap())
    }

    #[test]
    fn deny_and_ask_rules_stop_routing_in_each_form() {
        let dir = tempfile::tempdir().unwrap();
        let user = settings(
            dir.path(),
            "claude/settings.json",
            r#"{
  "permissions": {
    "allow": ["Bash(pnpm test:*)", "Read(~/notes/**)"],
    "deny": ["Bash(pnpm build:*)", "Read(./.env)", "WebFetch"]
  },
  "hooks": {}
}"#,
        );
        let project = settings(
            dir.path(),
            "repo/.claude/settings.json",
            r#"{"permissions": {"ask": ["Bash(cargo test)"]}}"#,
        );
        let local = settings(
            dir.path(),
            "repo/.claude/settings.local.json",
            r#"{"permissions": {"ask": ["Bash(pnpm lint *)"]}}"#,
        );
        let missing = dir.path().join("profile/settings.json");
        let files = [user, project, local, missing];
        // `:*` prefix in the user's deny list.
        assert!(blocked_by(&files, "pnpm build"));
        assert!(blocked_by(&files, "pnpm build --watch"));
        // A bare command in the project's ask list counts as a prefix.
        assert!(blocked_by(&files, "cargo test -p moonlet-core"));
        // ` *` prefix in the local ask list.
        assert!(blocked_by(&files, "pnpm lint src"));
        // A rule matches however the command or the rule is spaced or
        // quoted.
        assert!(blocked_by(&files, "\"pnpm\" build"));
        assert!(blocked_by(&files, "pnpm   build --watch"));
        let spaced = settings(
            dir.path(),
            "spaced/settings.json",
            r#"{"permissions": {"deny": ["Bash(pnpm   build:*)"]}}"#,
        );
        assert!(blocked_by(&[spaced], "pnpm build"));
        // Allow rules and other tools' rules stop nothing.
        assert!(!blocked_by(&files, "pnpm test"));
        assert!(!blocked_by(&files, "cat .env"));

        // `Bash` and `Bash(*)` cover every command.
        for rule in ["Bash", "Bash(*)"] {
            let all = settings(
                dir.path(),
                "all/settings.json",
                &format!(r#"{{"permissions": {{"deny": ["{rule}"]}}}}"#),
            );
            assert!(blocked_by(&[all], "pnpm test"), "{rule}");
        }
    }

    #[test]
    fn a_rule_moonlet_cannot_read_stops_routing_for_its_first_word() {
        let dir = tempfile::tempdir().unwrap();
        let mid = settings(
            dir.path(),
            "a/settings.json",
            r#"{"permissions": {"ask": ["Bash(pnpm * --coverage)"]}}"#,
        );
        assert!(blocked_by(&[mid.clone()], "pnpm test"));
        assert!(blocked_by(&[mid.clone()], "pnpm build"));
        assert!(!blocked_by(&[mid], "cargo test"));
        // A rule that starts with a wildcard has no first word to go by.
        let lead = settings(
            dir.path(),
            "b/settings.json",
            r#"{"permissions": {"deny": ["Bash(* --version)"]}}"#,
        );
        assert!(blocked_by(&[lead], "cargo test"));
        // A settings file that is not JSON could hold any rule.
        let broken = settings(dir.path(), "c/settings.json", "{ not json");
        assert!(blocked_by(&[broken], "cargo test"));
    }

    fn with_outputs(outputs: &[&str]) -> HeavyConfig {
        HeavyConfig {
            commands: vec!["pnpm test".into()],
            outputs: outputs.iter().map(|s| s.to_string()).collect(),
            ..HeavyConfig::default()
        }
    }

    #[test]
    fn an_outputs_path_outside_the_worktree_is_refused() {
        assert_eq!(check(&with_outputs(&["coverage", "web/dist"])), Ok(()));
        assert_eq!(
            check(&with_outputs(&["../shared"])),
            Err("outputs: `../shared` is outside the worktree".to_string())
        );
        assert_eq!(
            check(&with_outputs(&["coverage/../../x"])),
            Err("outputs: `coverage/../../x` is outside the worktree".to_string())
        );
        assert_eq!(
            check(&with_outputs(&["/tmp/out"])),
            Err("outputs: `/tmp/out` is outside the worktree".to_string())
        );
    }

    #[test]
    fn git_and_moonlet_folders_are_refused_as_outputs_paths() {
        for path in [
            ".git",
            ".git/hooks",
            ".moonlet",
            "./.moonlet/config.toml",
            "web/.git",
            // As a Mac or Windows reads them: any case, invisible
            // characters, trailing dots, short names.
            ".GIT/hooks",
            ".Moonlet",
            ".git.",
            "GIT~1",
            ".g\u{200c}it",
            "MOONLE~1",
        ] {
            assert_eq!(
                check(&with_outputs(&[path])),
                Err(format!("outputs: `{path}` is git's or moonlet's own")),
                "{path}"
            );
        }
        assert_eq!(
            check(&with_outputs(&[".gitignored", "coverage/.github"])),
            Ok(())
        );
    }

    #[test]
    fn the_worktree_root_is_refused_as_an_outputs_path() {
        for root in [".", "./", "", " "] {
            assert_eq!(
                check(&with_outputs(&[root])),
                Err(format!(
                    "outputs: `{root}` is the whole worktree; name a folder or file in it"
                )),
                "{root:?}"
            );
        }
    }
}
