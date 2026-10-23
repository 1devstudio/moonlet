//! Heavy commands (X62): which Bash calls of an agent may run on another
//! machine. A project lists command prefixes under `[heavy]` in its
//! `.moonlet/config.toml`; a call is routable when its words start with an
//! approved entry's words and nothing in it would make a shell expand,
//! chain or redirect.

use moonlet_proto::types::{HeavyConfig, HeavyOs};

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
    if let Some(script) = &heavy.machine_setup {
        let path = std::path::Path::new(script.trim());
        let inside = !path.is_absolute()
            && path.components().all(|c| matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir))
            && path.components().any(|c| matches!(c, std::path::Component::Normal(_)));
        if !inside {
            return Err(format!("machine_setup: `{script}` is not a file in the repository"));
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

/// Where a candidate worker runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A Mac or remote host linked to the central host (X41, X61).
    Linked,
    /// The central host itself.
    Central,
    /// A cloud machine of the project (X63).
    Cloud,
}

/// A machine that might run a heavy command.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub kind: Kind,
    /// `macos` or `linux`.
    pub os: String,
    pub cores: u32,
    /// The 1-minute load average.
    pub load: f64,
    /// How many routed commands it runs at once.
    pub slots: u32,
    /// How many it runs now.
    pub used: u32,
    pub rtt_ms: Option<u64>,
}

impl Candidate {
    /// At least 0.7 × its cores busy.
    pub fn busy(&self) -> bool {
        self.load >= 0.7 * f64::from(self.cores.max(1))
    }

    fn per_core(&self) -> f64 {
        self.load / f64::from(self.cores.max(1))
    }

    fn fits(&self, os: HeavyOs) -> bool {
        let os_ok = match os {
            HeavyOs::Any => true,
            HeavyOs::Macos => self.os == "macos",
            HeavyOs::Linux => self.os == "linux",
        };
        os_ok && self.used < self.slots && !self.busy()
    }
}

/// The free candidate a heavy command goes to, or `None` when none is free
/// and it runs on the central host anyway. Linked machines come first by
/// lowest load per core, then the shortest round trip, then id; then the
/// central host; then cloud machines by lowest load per core. A session
/// that asked for the cloud tries cloud machines first.
pub fn pick(candidates: &[Candidate], os: HeavyOs, cloud_first: bool) -> Option<&Candidate> {
    let rank = |c: &Candidate| match (c.kind, cloud_first) {
        (Kind::Cloud, true) => 0,
        (Kind::Linked, _) => 1,
        (Kind::Central, _) => 2,
        (Kind::Cloud, false) => 3,
    };
    candidates.iter().filter(|c| c.fits(os)).min_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then(a.per_core().total_cmp(&b.per_core()))
            // A round trip not measured yet counts as the longest.
            .then(
                a.rtt_ms
                    .unwrap_or(u64::MAX)
                    .cmp(&b.rtt_ms.unwrap_or(u64::MAX)),
            )
            .then(a.id.cmp(&b.id))
    })
}

/// Replaces paths in a run's output as it streams (X62): a routing copy's
/// path becomes the session's, also when a chunk ends inside it.
pub struct Rewriter {
    /// Longest first, so a longer path wins over one it contains.
    pairs: Vec<(Vec<u8>, Vec<u8>)>,
    /// The end of the last chunk, which may be the start of a path.
    held: Vec<u8>,
}

impl Rewriter {
    pub fn new(pairs: &[(&str, &str)]) -> Self {
        let mut pairs: Vec<(Vec<u8>, Vec<u8>)> = pairs
            .iter()
            .filter(|(from, to)| !from.is_empty() && from != to)
            .map(|(from, to)| (from.as_bytes().to_vec(), to.as_bytes().to_vec()))
            .collect();
        pairs.sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));
        Self {
            pairs,
            held: Vec::new(),
        }
    }

    /// The output of `data` that can be given now.
    pub fn push(&mut self, data: &[u8]) -> Vec<u8> {
        self.held.extend_from_slice(data);
        let (out, rest) = self.replace(false);
        self.held.drain(..rest);
        out
    }

    /// Everything held back, at the end of the stream.
    pub fn finish(&mut self) -> Vec<u8> {
        let (out, _) = self.replace(true);
        self.held.clear();
        out
    }

    /// The replaced output of `held`, and how much of it was used: all of
    /// it, but for an end that could still become a path.
    fn replace(&self, last: bool) -> (Vec<u8>, usize) {
        let h = &self.held;
        let mut out = Vec::with_capacity(h.len());
        let mut i = 0;
        'scan: while i < h.len() {
            for (from, to) in &self.pairs {
                if h[i..].starts_with(from) {
                    out.extend_from_slice(to);
                    i += from.len();
                    continue 'scan;
                }
            }
            let rest = &h[i..];
            if !last
                && self
                    .pairs
                    .iter()
                    .any(|(from, _)| from.len() > rest.len() && from.starts_with(rest))
            {
                return (out, i);
            }
            out.push(h[i]);
            i += 1;
        }
        (out, i)
    }
}

#[cfg(test)]
mod tests {

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
                machine_setup: None,
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
    fn machine_setup_is_a_path_in_the_repository() {
        let with = |p: &str| HeavyConfig {
            machine_setup: Some(p.into()),
            ..HeavyConfig::default()
        };
        assert_eq!(check(&with("scripts/ci-deps.sh")), Ok(()));
        for bad in ["../ci.sh", "/etc/ci.sh", "scripts/../../ci.sh", ""] {
            assert_eq!(
                check(&with(bad)),
                Err(format!("machine_setup: `{bad}` is not a file in the repository")),
                "{bad}"
            );
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

    fn mac(id: &str, load: f64, cores: u32, used: u32) -> Candidate {
        Candidate {
            id: id.into(),
            kind: Kind::Linked,
            os: "macos".into(),
            cores,
            load,
            slots: 2,
            used,
            rtt_ms: Some(6),
        }
    }

    fn central(load: f64, cores: u32, used: u32) -> Candidate {
        Candidate {
            kind: Kind::Central,
            rtt_ms: None,
            ..mac("studio-mini", load, cores, used)
        }
    }

    fn cloud(id: &str, load: f64, cores: u32, used: u32) -> Candidate {
        Candidate {
            kind: Kind::Cloud,
            os: "linux".into(),
            ..mac(id, load, cores, used)
        }
    }

    /// X62's order table: load / cores, slots used of 2.
    #[test]
    fn picks_as_in_the_order_table() {
        let any = HeavyOs::Any;
        let rows: [(Vec<Candidate>, Option<&str>); 6] = [
            (
                vec![mac("macbook", 1.0, 10, 0), central(0.5, 10, 0)],
                Some("macbook"),
            ),
            (
                vec![mac("macbook", 7.2, 10, 0), central(4.3, 10, 1)],
                Some("studio-mini"),
            ),
            (
                vec![mac("macbook", 1.0, 10, 2), central(1.0, 10, 0)],
                Some("studio-mini"),
            ),
            (
                vec![
                    mac("a", 3.0, 10, 0),
                    mac("b", 1.0, 8, 0),
                    central(0.1, 10, 0),
                ],
                Some("b"),
            ),
            (
                vec![central(9.0, 10, 2), cloud("moonlet-shop-7k2q", 0.1, 8, 0)],
                Some("moonlet-shop-7k2q"),
            ),
            (vec![central(9.0, 10, 2)], None),
        ];
        for (i, (candidates, want)) in rows.into_iter().enumerate() {
            assert_eq!(
                pick(&candidates, any, false).map(|c| c.id.as_str()),
                want,
                "row {}",
                i + 1
            );
        }
        // Ties go to the shorter round trip, then the id.
        let mut far = mac("a", 1.0, 10, 0);
        far.rtt_ms = Some(40);
        let near = mac("z", 1.0, 10, 0);
        assert_eq!(pick(&[far.clone(), near], any, false).unwrap().id, "z");
        assert_eq!(
            pick(&[far, mac("b", 1.0, 10, 0)], any, false).unwrap().id,
            "b"
        );
        // A session that asked for the cloud tries cloud machines first.
        let both = [
            mac("macbook", 0.1, 10, 0),
            cloud("moonlet-shop-7k2q", 2.0, 8, 0),
        ];
        assert_eq!(pick(&both, any, true).unwrap().id, "moonlet-shop-7k2q");
    }

    #[test]
    fn a_worker_with_no_round_trip_yet_ranks_after_a_measured_one() {
        let unmeasured = Candidate {
            rtt_ms: None,
            ..mac("a", 1.0, 10, 0)
        };
        let measured = mac("b", 1.0, 10, 0);
        assert_eq!(
            pick(&[unmeasured, measured], HeavyOs::Any, false).map(|c| c.id.as_str()),
            Some("b")
        );
    }

    #[test]
    fn a_worker_on_another_os_is_skipped() {
        let both = [
            mac("macbook", 0.1, 10, 0),
            cloud("moonlet-shop-7k2q", 0.1, 8, 0),
        ];
        assert_eq!(
            pick(&both, HeavyOs::Linux, false).unwrap().id,
            "moonlet-shop-7k2q"
        );
        assert_eq!(pick(&both, HeavyOs::Macos, true).unwrap().id, "macbook");
    }

    #[test]
    fn a_worker_at_seven_tenths_of_its_cores_is_busy() {
        assert_eq!(
            pick(&[mac("macbook", 6.9, 10, 0)], HeavyOs::Any, false)
                .unwrap()
                .id,
            "macbook"
        );
        assert!(pick(&[mac("macbook", 7.0, 10, 0)], HeavyOs::Any, false).is_none());
    }

    #[test]
    fn replaces_the_copys_path_split_across_two_chunks() {
        let copy = "/Users/alex/.moonlet/runs/studio-mini/shop/fix-cart";
        let session = "/Users/alex/.moonlet/worktrees/shop/fix-cart";
        let mut r = Rewriter::new(&[(copy, session)]);
        let mut out = r.push(b"FAIL /Users/alex/.moonlet/runs/studio-");
        out.extend(r.push(b"mini/shop/fix-cart/src/cart.ts:12\n"));
        out.extend(r.finish());
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "FAIL /Users/alex/.moonlet/worktrees/shop/fix-cart/src/cart.ts:12\n"
        );
        // Nothing held back when nothing could be the start of the path.
        let mut r = Rewriter::new(&[(copy, session)]);
        assert_eq!(r.push(b"ok\n"), b"ok\n");
        // The canonical form of the copy's path too, longest first.
        let mut r = Rewriter::new(&[
            ("/var/x/runs/c", "/var/x/worktrees/s"),
            ("/private/var/x/runs/c", "/var/x/worktrees/s"),
        ]);
        let mut out = r.push(b"cd /private/var/x/runs/c && ls /var/x/runs/c/a");
        out.extend(r.finish());
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "cd /var/x/worktrees/s && ls /var/x/worktrees/s/a"
        );
    }
}
