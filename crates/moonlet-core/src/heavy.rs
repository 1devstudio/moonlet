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
    listed(&words, entries).then_some(words)
}

/// Whether `words` start with the words of one of `entries`.
pub fn listed(words: &[String], entries: &[String]) -> bool {
    entries
        .iter()
        .any(|e| split(e).is_some_and(|e| !e.is_empty() && words.starts_with(&e)))
}

/// Whether a routed run of `argv` may run again on the session's host when
/// the machine running it goes away mid-run: only when the project lists it
/// under `[heavy] rerun`. A run given up on may have run in part, or still
/// be going, so by default it is not run again.
pub fn runs_again(argv: &[String], heavy: &HeavyConfig) -> bool {
    listed(argv, &heavy.rerun)
}

/// Why a line is not routed, in words for the agent and the Jobs tab.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal(pub String);

fn refuse<T>(why: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal(why.into()))
}

const SECOND: &str = "it runs a second command";
const REDIRECTION: &str = "it has a redirection moonlet does not route";

/// A line moonlet can route (X62 › Lines moonlet routes): one command,
/// with what the agent's own shell runs around it. Only the command runs
/// through `moonlet exec`, with the line's variables given to it alone;
/// `cd`, `timeout`, redirections and filters stay in the agent's shell,
/// around `moonlet exec`.
///
/// ```text
/// line     = [ "cd" DIR "&&" ] command { "|" filter }
/// command  = { NAME=VALUE } [ "env" NAME=VALUE { NAME=VALUE } ]
///            [ "timeout" DURATION ] WORD { WORD | redirect }
/// filter   = ( "tail" | "head" ) [ "-N" | "-n" N | "-nN" ] { redirect }
///          | "grep" { option } PATTERN { redirect }
/// redirect = [ "1" | "2" ] ( ">" | ">>" ) PATH | [ "1" | "2" ] ">&" ( "1" | "2" )
/// ```
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Line {
    /// The folder of `cd <dir> &&`, as written.
    pub cd: Option<String>,
    /// `NAME=value` before the command, from `env` too.
    pub assigns: Vec<(String, String)>,
    /// The duration of `timeout <duration>`.
    pub timeout: Option<String>,
    /// The command's words.
    pub words: Vec<String>,
    /// The command's redirections, in order.
    pub redirects: Vec<Redirect>,
    /// Filters the command's output goes through, in order.
    pub filters: Vec<Filter>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Redirect {
    /// `>` or `>>` to a file; `fd` is 1 or 2.
    File { fd: u8, append: bool, path: String },
    /// `2>&1`, `>&2`: `fd` and `to` are 1 or 2.
    Dup { fd: u8, to: u8 },
}

/// `tail`, `head` or `grep` reading the command's output.
#[derive(Debug, Clone, PartialEq)]
pub struct Filter {
    pub words: Vec<String>,
    pub redirects: Vec<Redirect>,
}

impl Line {
    /// Nothing around the command: the line is the command alone.
    pub fn is_bare(&self) -> bool {
        self.cd.is_none()
            && self.assigns.is_empty()
            && self.timeout.is_none()
            && self.redirects.is_empty()
            && self.filters.is_empty()
    }

    /// What the agent's shell runs before `moonlet exec`, ending in a
    /// space when there is any. A relative folder starts with `./`, so
    /// `CDPATH` never takes `cd` elsewhere.
    pub fn before(&self) -> String {
        let mut s = String::new();
        if let Some(dir) = &self.cd {
            let dir = if dir.starts_with('/') || dir.starts_with("./") {
                dir.clone()
            } else {
                format!("./{dir}")
            };
            s.push_str(&format!("cd {} && ", quote(&dir)));
        }
        if let Some(t) = &self.timeout {
            s.push_str(&format!("timeout {t} "));
        }
        s
    }

    /// `moonlet exec`'s options before `--`, ending in a space when there
    /// is any: the line's variables, which reach the command only, never
    /// `timeout` or `moonlet exec` itself.
    pub fn exec_args(&self) -> String {
        self.assigns
            .iter()
            .map(|(name, value)| format!("--env {} ", quote(&format!("{name}={value}"))))
            .collect()
    }

    /// The command, each word quoted as it was parsed.
    pub fn command(&self) -> String {
        words_text(&self.words)
    }

    /// What follows the command in the agent's shell: its redirections and
    /// filters, starting with a space when there is any.
    pub fn after(&self) -> String {
        let mut s = redirects_text(&self.redirects);
        for f in &self.filters {
            s.push_str(&format!(" | {}{}", words_text(&f.words), redirects_text(&f.redirects)));
        }
        s
    }

    /// The files the line writes, as written.
    pub fn files(&self) -> Vec<&str> {
        self.redirects
            .iter()
            .chain(self.filters.iter().flat_map(|f| &f.redirects))
            .filter_map(|r| match r {
                Redirect::File { path, .. } => Some(path.as_str()),
                Redirect::Dup { .. } => None,
            })
            .collect()
    }

    /// Every simple command the agent's shell runs, as words, for the
    /// user's deny and ask rules.
    pub fn parts(&self) -> Vec<Vec<String>> {
        let mut parts = Vec::new();
        if let Some(dir) = &self.cd {
            parts.push(vec!["cd".to_string(), dir.clone()]);
        }
        if let Some(t) = &self.timeout {
            let mut w = vec!["timeout".to_string(), t.clone()];
            w.extend(self.words.iter().cloned());
            parts.push(w);
        }
        parts.push(self.words.clone());
        parts.extend(self.filters.iter().map(|f| f.words.clone()));
        parts
    }
}

fn words_text(words: &[String]) -> String {
    words.iter().map(|w| quote(w)).collect::<Vec<_>>().join(" ")
}

fn redirects_text(redirects: &[Redirect]) -> String {
    redirects
        .iter()
        .map(|r| match r {
            Redirect::File { fd, append, path } => {
                let fd = if *fd == 2 { "2" } else { "" };
                let op = if *append { ">>" } else { ">" };
                format!(" {fd}{op} {}", quote(path))
            }
            Redirect::Dup { fd, to } => {
                let fd = if *fd == 2 { "2" } else { "" };
                format!(" {fd}>&{to}")
            }
        })
        .collect()
}

/// `w` as one word for a POSIX shell or zsh: as it is when it holds
/// nothing either reads, in single quotes otherwise.
pub fn quote(w: &str) -> String {
    let plain = !w.is_empty()
        && !w.starts_with('=')
        && w.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:,+@%".contains(c));
    if plain {
        w.to_string()
    } else {
        format!("'{}'", w.replace('\'', "'\\''"))
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// A word as the shell gives it, and as it was written.
    Word { text: String, raw: String },
    And,
    Pipe,
    /// `>` or `>>`, before the word it writes to.
    Out { fd: u8, append: bool },
    Dup { fd: u8, to: u8 },
}

/// Ends of a word outside quotes.
fn ends_word(c: char) -> bool {
    matches!(c, ' ' | '\t' | '|' | '&' | ';' | '<' | '>' | '(' | ')')
}

/// The tokens of `line`, or why it is not one moonlet routes: anything a
/// shell would expand, chain to a second command or read input from.
fn lex(line: &str) -> Result<Vec<Tok>, Refusal> {
    if line.contains(['\n', '\r']) {
        return refuse(SECOND);
    }
    let mut toks = Vec::new();
    // The word being read: as the shell gives it, as written.
    let mut word: Option<(String, String)> = None;
    let flush = |word: &mut Option<(String, String)>, toks: &mut Vec<Tok>| {
        if let Some((text, raw)) = word.take() {
            toks.push(Tok::Word { text, raw });
        }
    };
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' => flush(&mut word, &mut toks),
            '\'' => {
                let (text, raw) = word.get_or_insert_with(Default::default);
                raw.push(c);
                loop {
                    match chars.next() {
                        None => return refuse("a quote is not closed"),
                        Some('\'') => break raw.push('\''),
                        Some(c) => {
                            text.push(c);
                            raw.push(c);
                        }
                    }
                }
            }
            '"' => {
                let (text, raw) = word.get_or_insert_with(Default::default);
                raw.push(c);
                loop {
                    match chars.next() {
                        None => return refuse("a quote is not closed"),
                        Some('"') => break raw.push('"'),
                        Some(c @ ('$' | '`')) => return refuse(expands(c)),
                        Some('\\') => match chars.next() {
                            None => return refuse("a quote is not closed"),
                            Some(c @ ('$' | '`')) => return refuse(expands(c)),
                            Some(c @ ('"' | '\\')) => {
                                text.push(c);
                                raw.extend(['\\', c]);
                            }
                            Some(c) => {
                                text.extend(['\\', c]);
                                raw.extend(['\\', c]);
                            }
                        },
                        Some(c) => {
                            text.push(c);
                            raw.push(c);
                        }
                    }
                }
            }
            '\\' => match chars.next() {
                None => return refuse("it ends with `\\`"),
                Some(c) => {
                    let (text, raw) = word.get_or_insert_with(Default::default);
                    text.push(c);
                    raw.extend(['\\', c]);
                }
            },
            '&' => match chars.peek() {
                Some('&') => {
                    chars.next();
                    flush(&mut word, &mut toks);
                    toks.push(Tok::And);
                }
                Some('>') => return refuse(REDIRECTION),
                _ => return refuse(SECOND),
            },
            '|' => match chars.peek() {
                Some('|') => return refuse(SECOND),
                Some('&') => return refuse(REDIRECTION),
                _ => {
                    flush(&mut word, &mut toks);
                    toks.push(Tok::Pipe);
                }
            },
            '>' => {
                // `2>`: a number right before `>`, unquoted, names the
                // stream; only 1 and 2 are routed.
                let fd = match &word {
                    Some((text, raw)) if text == raw && text.bytes().all(|b| b.is_ascii_digit()) => {
                        let fd = match text.as_str() {
                            "1" => 1,
                            "2" => 2,
                            _ => return refuse(REDIRECTION),
                        };
                        word = None;
                        fd
                    }
                    _ => {
                        flush(&mut word, &mut toks);
                        1
                    }
                };
                match chars.peek() {
                    Some('>') => {
                        chars.next();
                        if matches!(chars.peek(), Some('&' | '|')) {
                            return refuse(REDIRECTION);
                        }
                        toks.push(Tok::Out { fd, append: true });
                    }
                    Some('&') => {
                        chars.next();
                        let mut to = String::new();
                        while let Some(&c) = chars.peek() {
                            if ends_word(c) {
                                break;
                            }
                            to.push(c);
                            chars.next();
                        }
                        let to = match to.as_str() {
                            "1" => 1,
                            "2" => 2,
                            _ => return refuse(REDIRECTION),
                        };
                        toks.push(Tok::Dup { fd, to });
                    }
                    Some('|') => return refuse(REDIRECTION),
                    _ => toks.push(Tok::Out { fd, append: false }),
                }
            }
            '<' => return refuse("it reads input with `<`"),
            ';' => return refuse(SECOND),
            '(' | ')' => return refuse("it has a subshell"),
            '#' => return refuse("it has `#`, which starts a comment"),
            '$' | '`' | '*' | '?' | '[' | '{' | '~' => return refuse(expands(c)),
            c => {
                let (text, raw) = word.get_or_insert_with(Default::default);
                text.push(c);
                raw.push(c);
            }
        }
    }
    flush(&mut word, &mut toks);
    Ok(toks)
}

fn expands(c: char) -> String {
    if c == '`' {
        "it has `` ` ``, which the shell expands".into()
    } else {
        format!("it has `{c}`, which the shell expands")
    }
}

/// A word or a redirection of one simple command.
#[derive(Clone)]
enum Item {
    Word { text: String, raw: String },
    Redirect(Redirect),
}

/// `NAME=` at the start of a word as written: an assignment to the shell.
fn assignment(raw: &str) -> Option<(&str, &str)> {
    let (name, value) = raw.split_once('=')?;
    let ok = name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    ok.then_some((name, value))
}

/// The line moonlet would route `line` as, or why it would not.
pub fn parse(line: &str) -> Result<Line, Refusal> {
    // Simple commands, and the `&&` or `|` after each.
    let mut parts: Vec<Vec<Item>> = vec![Vec::new()];
    let mut seps: Vec<Tok> = Vec::new();
    let mut toks = lex(line)?.into_iter();
    while let Some(t) = toks.next() {
        match t {
            Tok::And | Tok::Pipe => {
                seps.push(t);
                parts.push(Vec::new());
            }
            Tok::Word { text, raw } => parts.last_mut().unwrap().push(Item::Word { text, raw }),
            Tok::Dup { fd, to } => parts.last_mut().unwrap().push(Item::Redirect(Redirect::Dup { fd, to })),
            Tok::Out { fd, append } => match toks.next() {
                Some(Tok::Word { text, .. }) if !text.is_empty() => parts
                    .last_mut()
                    .unwrap()
                    .push(Item::Redirect(Redirect::File { fd, append, path: text })),
                _ => return refuse(REDIRECTION),
            },
        }
    }
    if parts.iter().any(|p| p.is_empty()) {
        return refuse(if parts.len() == 1 { "it is empty" } else { SECOND });
    }
    let first_word = |p: &[Item]| match p.first() {
        Some(Item::Word { text, .. }) => Some(text.clone()),
        _ => None,
    };
    let mut out = Line::default();
    let mut parts = parts.into_iter();
    let mut seps = seps.into_iter().peekable();
    let mut part = parts.next().unwrap();
    if seps.peek() == Some(&Tok::And) {
        seps.next();
        if first_word(&part).as_deref() != Some("cd") {
            return refuse(SECOND);
        }
        out.cd = Some(cd_folder(part)?);
        part = parts.next().unwrap();
    }
    if seps.peek() == Some(&Tok::And) {
        return refuse(if first_word(&part).as_deref() == Some("cd") {
            "it has more than one `cd`"
        } else {
            SECOND
        });
    }
    command(part, &mut out)?;
    for (sep, part) in seps.zip(parts) {
        if sep != Tok::Pipe {
            return refuse(SECOND);
        }
        out.filters.push(filter(part)?);
    }
    Ok(out)
}

fn cd_folder(part: Vec<Item>) -> Result<String, Refusal> {
    match part.as_slice() {
        [_, Item::Word { text, .. }] if !text.is_empty() && !text.starts_with('-') => {
            // The shell reads `..` by the path as written, through links,
            // where moonlet checks the folder it leads to.
            if text.split('/').any(|part| part == "..") {
                return refuse("`cd` takes a folder without `..`");
            }
            Ok(text.clone())
        }
        _ => refuse("`cd` takes one folder"),
    }
}

fn command(part: Vec<Item>, out: &mut Line) -> Result<(), Refusal> {
    let mut items = part.into_iter().peekable();
    let assign = |item: Option<&Item>| match item {
        Some(Item::Word { text, raw }) => assignment(raw).map(|(name, _)| {
            let value = text.split_once('=').map_or("", |(_, v)| v);
            (name.to_string(), value.to_string())
        }),
        _ => None,
    };
    let is_word = |item: Option<&Item>, w: &str| matches!(item, Some(Item::Word { text, .. }) if text == w);
    while let Some(a) = assign(items.peek()) {
        out.assigns.push(a);
        items.next();
    }
    // `env NAME=value` and `timeout <duration>` wrap the command; in any
    // other form they are the command itself.
    let next_is = |items: &std::iter::Peekable<std::vec::IntoIter<Item>>, ok: &dyn Fn(&Item) -> bool| {
        items.clone().nth(1).as_ref().is_some_and(ok)
    };
    if is_word(items.peek(), "env") && next_is(&items, &|i| assign(Some(i)).is_some()) {
        items.next();
        while let Some(a) = assign(items.peek()) {
            out.assigns.push(a);
            items.next();
        }
    }
    let is_duration = |i: &Item| matches!(i, Item::Word { text, .. } if duration(text));
    if is_word(items.peek(), "timeout") && next_is(&items, &is_duration) {
        items.next();
        if let Some(Item::Word { text, .. }) = items.next() {
            out.timeout = Some(text);
        }
    }
    match items.peek() {
        Some(Item::Word { text, raw }) => {
            if SHELL_WORDS.contains(&text.as_str()) {
                return refuse(format!("it starts with `{text}`, which the shell runs itself"));
            }
            if assignment(text).is_some() && assignment(raw).is_none() {
                return refuse(format!("`{text}` reads as an assignment the shell would not make"));
            }
        }
        Some(Item::Redirect(_)) => return refuse(REDIRECTION),
        None => return refuse("it has no command"),
    }
    for item in items {
        match item {
            Item::Word { text, .. } => out.words.push(text),
            Item::Redirect(r) => out.redirects.push(r),
        }
    }
    Ok(())
}

/// `600`, `1.5m`: a duration `timeout` reads.
fn duration(s: &str) -> bool {
    let n = s.strip_suffix(['s', 'm', 'h', 'd']).unwrap_or(s);
    let (whole, frac) = n.split_once('.').unwrap_or((n, "0"));
    digits(whole) && digits(frac)
}

fn filter(part: Vec<Item>) -> Result<Filter, Refusal> {
    let mut words = Vec::new();
    let mut redirects = Vec::new();
    for item in part {
        match item {
            Item::Word { text, .. } => words.push(text),
            Item::Redirect(r) => redirects.push(r),
        }
    }
    let Some(name) = words.first() else {
        return refuse("a `|` has no command after it");
    };
    let ok = match name.as_str() {
        "tail" => count_ok(&words[1..], true),
        "head" => count_ok(&words[1..], false),
        "grep" => grep_ok(&words[1..]),
        name => {
            return refuse(format!(
                "`{name}` is not a filter moonlet runs after a command: use tail, head or grep"
            ));
        }
    };
    if !ok {
        return refuse(format!(
            "`{}` is not a filter moonlet runs after a command: use tail -n N, head -n N or grep",
            words.join(" ")
        ));
    }
    Ok(Filter { words, redirects })
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `tail` and `head` with nothing but a line count.
fn count_ok(args: &[String], plus: bool) -> bool {
    let count = |n: &str| digits(n) || (plus && n.strip_prefix('+').is_some_and(digits));
    match args {
        [] => true,
        [a] => a.strip_prefix("-n").is_some_and(count) || a.strip_prefix('-').is_some_and(digits),
        [n, v] => n == "-n" && count(v),
        _ => false,
    }
}

/// `grep` reading its input only: options that change what it matches or
/// prints, and one pattern.
fn grep_ok(args: &[String]) -> bool {
    const FLAGS: &str = "ivEFGnwxocqs";
    const LONG: [&str; 15] = [
        "--ignore-case",
        "--invert-match",
        "--extended-regexp",
        "--fixed-strings",
        "--basic-regexp",
        "--line-number",
        "--count",
        "--word-regexp",
        "--line-regexp",
        "--only-matching",
        "--quiet",
        "--silent",
        "--color",
        "--color=never",
        "--color=always",
    ];
    let mut patterns = 0;
    let mut positional = Vec::new();
    let mut args = args.iter();
    while let Some(a) = args.next() {
        if a == "--" {
            positional.extend(args.by_ref());
            break;
        }
        if !a.starts_with('-') || a == "-" {
            positional.push(a);
            continue;
        }
        if LONG.contains(&a.as_str()) {
            continue;
        }
        if a == "-e" {
            if args.next().is_none() {
                return false;
            }
            patterns += 1;
            continue;
        }
        if a.starts_with("-e") {
            patterns += 1;
            continue;
        }
        let numbered = ["-A", "-B", "-C", "-m"].iter().find(|o| a.starts_with(**o));
        if let Some(o) = numbered {
            let rest = &a[o.len()..];
            let ok = if rest.is_empty() {
                args.next().is_some_and(|n| digits(n))
            } else {
                digits(rest)
            };
            if !ok {
                return false;
            }
            continue;
        }
        if !a[1..].chars().all(|c| FLAGS.contains(c)) {
            return false;
        }
    }
    patterns + positional.len() == 1 || (patterns > 0 && positional.is_empty())
}

/// The heavy command of `entries` that `line` runs somewhere in it,
/// however it is written, for telling the agent why it stays where it
/// is; `None` when it runs none. It never decides routing.
pub fn mentions(line: &str, entries: &[String]) -> Option<String> {
    // Words, with any shell character ending a simple command.
    let mut commands: Vec<Vec<String>> = vec![Vec::new()];
    let mut word: Option<String> = None;
    let mut chars = line.chars();
    let end = |word: &mut Option<String>, commands: &mut Vec<Vec<String>>| {
        if let Some(w) = word.take() {
            commands.last_mut().unwrap().push(w);
        }
    };
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' => end(&mut word, &mut commands),
            '\'' | '"' => {
                let w = word.get_or_insert_with(String::new);
                for q in chars.by_ref() {
                    if q == c {
                        break;
                    }
                    w.push(q);
                }
            }
            ';' | '&' | '|' | '(' | ')' | '`' | '\n' | '\r' | '{' | '}' => {
                end(&mut word, &mut commands);
                commands.push(Vec::new());
            }
            '<' | '>' => {
                // A redirection's target is no word of the command.
                end(&mut word, &mut commands);
                commands.push(Vec::new());
            }
            c => word.get_or_insert_with(String::new).push(c),
        }
    }
    end(&mut word, &mut commands);
    let wrappers = ["env", "time", "!", "nohup", "exec", "command", "builtin", "nice"];
    for words in commands {
        let mut w: &[String] = &words;
        loop {
            match w.first().map(String::as_str) {
                Some(x) if assignment(x).is_some() || wrappers.contains(&x) => w = &w[1..],
                Some(x) if x.starts_with('-') => w = &w[1..],
                Some("timeout") => w = w.get(2..).unwrap_or_default(),
                Some(x) if x.starts_with('$') => w = &w[1..],
                _ => break,
            }
        }
        let found = entries.iter().find(|e| listed(w, std::slice::from_ref(e)));
        if let Some(e) = found {
            return Some(e.clone());
        }
    }
    None
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

/// Whether Claude Code settings `files` have a `deny` or `ask` rule for
/// editing or writing files, as for a line that writes one: a routed line
/// runs without Claude Code's prompt for it. A settings file that exists
/// but cannot be read could hold one.
pub fn claude_guards_writes(files: &[std::path::PathBuf]) -> bool {
    const TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
    files.iter().any(|f| {
        let text = match std::fs::read_to_string(f) {
            Ok(t) => t,
            Err(e) => return e.kind() != std::io::ErrorKind::NotFound,
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
            return true;
        };
        ["deny", "ask"].iter().any(|list| {
            json.pointer(&format!("/permissions/{list}"))
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str())
                .any(|rule| {
                    let rule = rule.trim();
                    TOOLS.iter().any(|t| {
                        rule == *t || rule.strip_prefix(t).is_some_and(|r| r.starts_with('('))
                    })
                })
        })
    })
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
    for c in &heavy.rerun {
        if split(c).is_none_or(|w| w.is_empty()) {
            return Err(format!("rerun: `{c}` is not a plain command"));
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
                rerun: Vec::new(),
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

    /// How `line` reads: the shell line moonlet would run in its place,
    /// with `M` for `moonlet exec -- `, or why it is refused.
    fn reads(line: &str) -> Result<String, String> {
        parse(line)
            .map(|l| format!("{}M {}-- {}{}", l.before(), l.exec_args(), l.command(), l.after()))
            .map_err(|r| r.0)
    }

    /// The forms around one command that route (X62 › Lines moonlet
    /// routes), and what moonlet runs in their place.
    #[test]
    fn wrapped_lines_parse_into_the_command_and_what_runs_around_it() {
        let ok = |s: &str| Ok::<String, String>(s.to_string());
        let rows: [(&str, Result<String, String>); 27] = [
            ("pnpm test", ok("M -- pnpm test")),
            ("cd web && pnpm test", ok("cd ./web && M -- pnpm test")),
            ("cd /w/shop/web && pnpm test", ok("cd /w/shop/web && M -- pnpm test")),
            ("cd 'my app' && pnpm test", ok("cd './my app' && M -- pnpm test")),
            ("CI=1 pnpm test", ok("M --env CI=1 -- pnpm test")),
            ("CI=1 NODE_ENV='a b' pnpm test", ok("M --env CI=1 --env 'NODE_ENV=a b' -- pnpm test")),
            ("env CI=1 pnpm test", ok("M --env CI=1 -- pnpm test")),
            ("timeout 600 pnpm test", ok("timeout 600 M -- pnpm test")),
            ("timeout 1.5m pnpm test", ok("timeout 1.5m M -- pnpm test")),
            ("pnpm test 2>&1", ok("M -- pnpm test 2>&1")),
            ("pnpm test 2>&1 | tail -50", ok("M -- pnpm test 2>&1 | tail -50")),
            ("pnpm test | tail -n 50", ok("M -- pnpm test | tail -n 50")),
            ("pnpm test | tail -n +3", ok("M -- pnpm test | tail -n +3")),
            ("pnpm test | head -n20", ok("M -- pnpm test | head -n20")),
            (
                "pnpm test 2>&1 | grep -E \"FAIL|Error\" | head -20",
                ok("M -- pnpm test 2>&1 | grep -E 'FAIL|Error' | head -20"),
            ),
            ("pnpm test | grep -v -e skip -A 3", ok("M -- pnpm test | grep -v -e skip -A 3")),
            ("pnpm test > out.txt 2>&1", ok("M -- pnpm test > out.txt 2>&1")),
            ("pnpm test 2>/dev/null >> log/test.txt", ok("M -- pnpm test 2> /dev/null >> log/test.txt")),
            ("pnpm test 2>&1 >out.txt", ok("M -- pnpm test 2>&1 > out.txt")),
            ("pnpm test --reporter=dot 2>&1 --run", ok("M -- pnpm test --reporter=dot --run 2>&1")),
            // Words the shell would read are quoted, so they reach the
            // command as they were parsed.
            ("pnpm test \"a;b\" =x", ok("M -- pnpm test 'a;b' '=x'")),
            ("pnpm test a\\ b", ok("M -- pnpm test 'a b'")),
            (
                "cd web && CI=1 timeout 600 pnpm test 2>&1 | tail -n 50",
                ok("cd ./web && timeout 600 M --env CI=1 -- pnpm test 2>&1 | tail -n 50"),
            ),
            ("pnpm  test", ok("M -- pnpm test")),
            // `env` and `timeout` in any other form are the command
            // itself, routed only when approved as such.
            ("env", ok("M -- env")),
            ("env -i CI=1 pnpm test", ok("M -- env -i CI=1 pnpm test")),
            ("timeout -s KILL 5 pnpm test", ok("M -- timeout -s KILL 5 pnpm test")),
        ];
        for (line, want) in rows {
            assert_eq!(reads(line), want, "{line}");
        }
    }

    /// Anything beyond those forms stays where it is, with why.
    #[test]
    fn lines_beyond_the_routed_forms_are_refused_with_why() {
        let no = |s: &str| Err::<String, String>(s.to_string());
        let second = "it runs a second command";
        let rows: [(&str, Result<String, String>); 35] = [
            ("pnpm test && git status", no(second)),
            ("pnpm test; git status", no(second)),
            ("pnpm test || true", no(second)),
            ("pnpm test & git status", no(second)),
            ("pnpm test\nrm -rf x", no(second)),
            ("cd web && pnpm test && git push", no(second)),
            ("cd web; pnpm test", no(second)),
            ("cd web && cd api && pnpm test", no("it has more than one `cd`")),
            ("pnpm test $(cat files.txt)", no("it has `$`, which the shell expands")),
            ("pnpm test \"$FILE\"", no("it has `$`, which the shell expands")),
            ("pnpm test `ls`", no("it has `` ` ``, which the shell expands")),
            ("pnpm test src/*.ts", no("it has `*`, which the shell expands")),
            ("pnpm test ~/x", no("it has `~`, which the shell expands")),
            ("pnpm test {a,b}", no("it has `{`, which the shell expands")),
            ("pnpm test # all", no("it has `#`, which starts a comment")),
            ("(pnpm test)", no("it has a subshell")),
            ("pnpm test < in.txt", no("it reads input with `<`")),
            ("pnpm test &> out.txt", no("it has a redirection moonlet does not route")),
            ("pnpm test 3>&1", no("it has a redirection moonlet does not route")),
            ("pnpm test 2>&-", no("it has a redirection moonlet does not route")),
            ("pnpm test >| out.txt", no("it has a redirection moonlet does not route")),
            ("pnpm test |& tail", no("it has a redirection moonlet does not route")),
            ("pnpm test | > out.txt", no("a `|` has no command after it")),
            ("pnpm test | sh", no("`sh` is not a filter moonlet runs after a command: use tail, head or grep")),
            ("pnpm test | xargs rm", no("`xargs` is not a filter moonlet runs after a command: use tail, head or grep")),
            ("pnpm test | tail -f", no("`tail -f` is not a filter moonlet runs after a command: use tail -n N, head -n N or grep")),
            ("pnpm test | grep -r x", no("`grep -r x` is not a filter moonlet runs after a command: use tail -n N, head -n N or grep")),
            ("pnpm test | grep x src", no("`grep x src` is not a filter moonlet runs after a command: use tail -n N, head -n N or grep")),
            ("pnpm test | grep -f pats", no("`grep -f pats` is not a filter moonlet runs after a command: use tail -n N, head -n N or grep")),
            ("time pnpm test", no("it starts with `time`, which the shell runs itself")),
            ("\"CI\"=1 pnpm test", no("`CI=1` reads as an assignment the shell would not make")),
            ("cd && pnpm test", no("`cd` takes one folder")),
            // The shell reads `..` by the path as written, through links.
            ("cd .. && pnpm test", no("`cd` takes a folder without `..`")),
            ("cd web/link/../.. && pnpm test", no("`cd` takes a folder without `..`")),
            ("pnpm test 'open", no("a quote is not closed")),
        ];
        for (line, want) in rows {
            assert_eq!(reads(line), want, "{line}");
        }
    }

    /// Which heavy command a line runs somewhere in it, for telling the
    /// agent why the line stays where it is.
    #[test]
    fn a_heavy_command_anywhere_in_a_line_is_found_for_the_note() {
        let entries = vec!["pnpm test".to_string(), "cargo test".to_string()];
        let rows = [
            ("pnpm test; git status", Some("pnpm test")),
            ("git status && cargo test -p core", Some("cargo test")),
            ("cd web && pnpm test | sort", Some("pnpm test")),
            ("echo $(pnpm test)", Some("pnpm test")),
            ("CI=1 timeout 5 env A=b pnpm test --run", Some("pnpm test")),
            ("(cd web; pnpm test) > out.txt", Some("pnpm test")),
            ("git status", None),
            ("pnpm testing", None),
            ("echo 'pnpm test'", None),
        ];
        for (line, want) in rows {
            assert_eq!(mentions(line, &entries).as_deref(), want, "{line}");
        }
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
    fn a_lost_run_runs_again_only_when_rerun_lists_it() {
        let words = |c: &str| split(c).unwrap();
        let config = |rerun: &[&str]| HeavyConfig {
            commands: vec!["pnpm test".into(), "pnpm deploy".into()],
            rerun: rerun.iter().map(|s| s.to_string()).collect(),
            ..HeavyConfig::default()
        };
        // None by default: a test run as much as a deploy.
        assert!(!runs_again(&words("pnpm test"), &config(&[])));
        assert!(!runs_again(&words("pnpm deploy"), &config(&[])));
        let marked = config(&["pnpm test"]);
        assert!(runs_again(&words("pnpm test"), &marked));
        assert!(runs_again(&words("pnpm test src/cart.test.ts --run"), &marked));
        assert!(!runs_again(&words("pnpm deploy"), &marked));
        assert!(!runs_again(&words("pnpm"), &marked));
        assert_eq!(check(&config(&["pnpm test"])), Ok(()));
        assert_eq!(check(&config(&["pnpm test; rm -rf ."])), Err("rerun: `pnpm test; rm -rf .` is not a plain command".into()));
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

    /// X89's order table, for a session on the MacBook: the session's host
    /// is the fallback, so `None` runs it there.
    #[test]
    fn picks_as_in_the_mesh_order_table() {
        let host = |load: f64| Candidate {
            kind: Kind::Central,
            rtt_ms: None,
            ..mac("macbook", load, 10, 0)
        };
        let mini = |load: f64, used: u32| mac("studio-mini", load, 10, used);
        let devbox = Candidate {
            os: "linux".into(),
            slots: 4,
            ..mac("devbox", 1.0, 16, 0)
        };
        let rows: [(Vec<Candidate>, Option<&str>); 7] = [
            (vec![host(21.3), mini(2.6, 0)], Some("studio-mini")),
            // studio-mini's switch is off: it is no candidate.
            (vec![host(21.3)], None),
            (vec![host(1.0), mini(2.6, 0)], Some("studio-mini")),
            (vec![host(21.3), mini(2.6, 2), devbox.clone()], Some("devbox")),
            (vec![host(21.3), mini(3.0, 0), devbox.clone()], Some("devbox")),
            (
                vec![host(21.3), mini(8.0, 0), cloud("moonlet-shop-7k2q", 0.1, 8, 0)],
                Some("moonlet-shop-7k2q"),
            ),
            (vec![host(21.3), mini(8.0, 0)], None),
        ];
        for (i, (candidates, want)) in rows.into_iter().enumerate() {
            assert_eq!(
                pick(&candidates, HeavyOs::Any, false).map(|c| c.id.as_str()),
                want,
                "row {}",
                i + 1
            );
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
