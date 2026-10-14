//! Branch names for sessions started from a task (X44 "Branch names and linking").

use crate::TrackerKind;

/// "Max length" until the user changes it.
pub const DEFAULT_MAX_LEN: usize = 48;

/// The template a new connection starts with. GitHub uses the same names as
/// `gh issue develop`.
pub fn default_template(kind: TrackerKind) -> &'static str {
    match kind {
        TrackerKind::Github => "{number}-{title}",
        TrackerKind::Linear | TrackerKind::Jira | TrackerKind::Clickup => "{key}-{title}",
    }
}

/// The values a branch template can use: `{key}`, `{title}`, `{number}`,
/// `{user}` and `{type}`.
#[derive(Debug, Clone)]
pub struct BranchVars<'a> {
    pub key: &'a str,
    pub title: &'a str,
    /// The GitHub issue number.
    pub number: Option<u64>,
    pub user: &'a str,
    /// The issue type, such as "bug" or "feature".
    pub issue_type: &'a str,
}

/// Fills `template` and makes it a branch name: lower case, words joined by
/// `-`, at most `max_len` characters.
pub fn branch_name(template: &str, vars: &BranchVars, max_len: usize) -> String {
    let number = vars.number.map(|n| n.to_string()).unwrap_or_default();
    let mut raw = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        raw.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('}') else {
            raw.push_str(&rest[open..]);
            rest = "";
            break;
        };
        raw.push_str(match &rest[open + 1..open + close] {
            "key" => vars.key,
            "title" => vars.title,
            "number" => &number,
            "user" => vars.user,
            "type" => vars.issue_type,
            _ => "",
        });
        rest = &rest[open + close + 1..];
    }
    raw.push_str(rest);
    cut(&clean(&raw), max_len)
}

/// At most `max_len` characters, cut at the last `-` or `/` rather than
/// inside a word, unless the first word alone is too long.
fn cut(name: &str, max_len: usize) -> String {
    if name.len() <= max_len {
        return name.into();
    }
    let head = &name[..max_len];
    let splits_word = name.as_bytes()[max_len].is_ascii_alphanumeric();
    let head = match head.rfind(['-', '/']) {
        Some(at) if splits_word => &head[..at],
        _ => head,
    };
    head.trim_end_matches(['-', '/']).into()
}

/// Lower case, accents dropped; `/` kept; any other run of non-alphanumerics
/// becomes one `-`.
fn clean(raw: &str) -> String {
    let mut out = String::new();
    let lower = raw.to_lowercase();
    let folded = lower.chars().flat_map(|c| match fold(c) {
        Some(ascii) => ascii.chars().collect::<Vec<_>>(),
        None => vec![c],
    });
    for c in folded {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if c == '/' {
            let trimmed = out.trim_end_matches('-').len();
            out.truncate(trimmed);
            if !out.is_empty() && !out.ends_with('/') {
                out.push('/');
            }
        } else if !out.is_empty() && !out.ends_with(['-', '/']) {
            out.push('-');
        }
    }
    out.trim_end_matches(['-', '/']).to_string()
}

/// The plain letters of a lower-case accented Latin letter, so titles in
/// French, German, Polish and the like keep their words.
fn fold(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => "a",
        'æ' => "ae",
        'ç' | 'ć' | 'č' => "c",
        'ď' | 'đ' | 'ð' => "d",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => "e",
        'ğ' => "g",
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' | 'ı' => "i",
        'ł' | 'ľ' | 'ĺ' => "l",
        'ñ' | 'ń' | 'ň' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => "o",
        'œ' => "oe",
        'ř' | 'ŕ' => "r",
        'ś' | 'š' | 'ş' => "s",
        'ß' => "ss",
        'ť' | 'ţ' => "t",
        'þ' => "th",
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' | 'ų' => "u",
        'ý' | 'ÿ' => "y",
        'ź' | 'ż' | 'ž' => "z",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moon_151() -> BranchVars<'static> {
        BranchVars {
            key: "MOON-151",
            title: "Drag sessions between sections",
            number: None,
            user: "sam",
            issue_type: "feature",
        }
    }

    #[test]
    fn default_templates_per_tracker() {
        use crate::TrackerKind::*;
        assert_eq!(
            [Linear, Jira, Clickup].map(default_template),
            ["{key}-{title}"; 3]
        );
        assert_eq!(default_template(Github), "{number}-{title}");
    }

    #[test]
    fn key_and_title_template() {
        assert_eq!(
            branch_name("{key}-{title}", &moon_151(), 48),
            "moon-151-drag-sessions-between-sections"
        );
    }

    #[test]
    fn a_long_name_is_cut_between_words() {
        let vars = BranchVars {
            title: "Context window meter in the chat footer",
            key: "MOON-136",
            ..moon_151()
        };
        // "moon-136-context-window-me" would split "meter".
        assert_eq!(
            branch_name("{key}-{title}", &vars, 26),
            "moon-136-context-window"
        );
        assert_eq!(
            branch_name("{key}-{title}", &vars, 30),
            "moon-136-context-window-meter"
        );
        // A cut inside the first word keeps the characters that fit.
        assert_eq!(branch_name("{key}-{title}", &vars, 3), "moo");
    }

    #[test]
    fn github_number_user_and_type() {
        let vars = BranchVars {
            key: "1devstudio/moonlet#42",
            title: "Fix: login (again)!",
            number: Some(42),
            ..moon_151()
        };
        assert_eq!(
            branch_name("{number}-{title}", &vars, 48),
            "42-fix-login-again"
        );
        assert_eq!(
            branch_name("{user}/{type}/{key}-{title}", &moon_151(), 48),
            "sam/feature/moon-151-drag-sessions-between"
        );
        assert_eq!(
            branch_name("{nope}-{title}", &moon_151(), 48),
            "drag-sessions-between-sections"
        );
    }

    #[test]
    fn accented_letters_lose_their_accents() {
        let vars = BranchVars {
            key: "OPS-7",
            title: "Café menü: zażółć gęślą jaźń, Straße",
            ..moon_151()
        };
        assert_eq!(
            branch_name("{key}-{title}", &vars, 60),
            "ops-7-cafe-menu-zazolc-gesla-jazn-strasse"
        );
    }
}
