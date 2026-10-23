//! A design system's tokens (X64): the custom properties in `tokens/*.css`,
//! by family, as design-sync's README groups them.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use super::check::{rel, styles_closure};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Family {
    Color,
    Spacing,
    Typography,
    Radius,
    Shadow,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Token {
    pub name: String,
    pub value: String,
    pub family: Family,
}

/// The tokens of the files under `tokens/` that `styles.css` imports, in
/// import order, each name once with its last value.
pub fn read(root: &Path) -> Vec<Token> {
    let mut tokens: Vec<Token> = Vec::new();
    for file in styles_closure(root) {
        if !rel(root, &file).starts_with("tokens/") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let text = COMMENT.replace_all(&text, "");
        for c in TOKEN.captures_iter(&text) {
            let (name, value) = (c[1].to_string(), c[2].trim().to_string());
            // A later declaration wins, as in the cascade; the token keeps its place.
            match tokens.iter_mut().find(|t| t.name == name) {
                Some(t) => {
                    t.family = family(&name, &value);
                    t.value = value;
                }
                None => tokens.push(Token {
                    family: family(&name, &value),
                    name,
                    value,
                }),
            }
        }
    }
    tokens
}

static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(--[A-Za-z0-9_-]+)\s*:\s*([^;}]+)").unwrap());
static COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)/\*.*?\*/").unwrap());
static COLOUR_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(#[0-9a-fA-F]{3,8}\b|(rgba?|hsla?|oklch|oklab|lab|lch|color)\()").unwrap()
});

/// By the name first, then by what the value looks like.
fn family(name: &str, value: &str) -> Family {
    let has = |words: &[&str]| words.iter().any(|w| name.contains(w));
    if has(&["radius", "rounded"]) {
        Family::Radius
    } else if has(&["shadow", "elevation"]) {
        Family::Shadow
    } else if has(&[
        "font",
        "text",
        "leading",
        "line-height",
        "tracking",
        "letter",
    ]) {
        Family::Typography
    } else if has(&["space", "spacing", "gap", "gutter", "inset"]) {
        Family::Spacing
    } else if has(&["color", "colour"]) || COLOUR_VALUE.is_match(value) {
        Family::Color
    } else {
        Family::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in files {
            let p = dir.path().join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        dir
    }

    #[test]
    fn tokens_come_from_the_imported_token_files_by_family() {
        let dir = system(&[
            (
                "styles.css",
                "@import \"tokens/colors.css\";\n@import \"tokens/scale.css\";\n@import \"components.css\";\n",
            ),
            (
                "tokens/colors.css",
                ":root {\n  --color-bg: #0b0c0e;\n  --accent: oklch(0.7 0.15 40);\n}\n",
            ),
            (
                "tokens/scale.css",
                ":root {\n  --space-4: 16px;\n  --text-lg: 15px;\n  --font-mono: \"JetBrains Mono\", ui-monospace;\n  --radius-xl: 12px;\n  --shadow-card: 0 1px 3px rgb(0 0 0 / 0.3);\n  --z-menu: 40;\n}\n",
            ),
            // Not a token file: component variables do not count.
            ("components.css", ".btn { --btn-pad: 6px; }\n"),
            // Not imported.
            ("tokens/unused.css", ":root { --color-unused: red; }\n"),
        ]);
        let got: Vec<(String, String, Family)> = read(dir.path())
            .into_iter()
            .map(|t| (t.name, t.value, t.family))
            .collect();
        let t = |n: &str, v: &str, f| (n.to_string(), v.to_string(), f);
        assert_eq!(
            got,
            vec![
                t("--color-bg", "#0b0c0e", Family::Color),
                t("--accent", "oklch(0.7 0.15 40)", Family::Color),
                t("--space-4", "16px", Family::Spacing),
                t("--text-lg", "15px", Family::Typography),
                t(
                    "--font-mono",
                    "\"JetBrains Mono\", ui-monospace",
                    Family::Typography
                ),
                t("--radius-xl", "12px", Family::Radius),
                t(
                    "--shadow-card",
                    "0 1px 3px rgb(0 0 0 / 0.3)",
                    Family::Shadow
                ),
                t("--z-menu", "40", Family::Other),
            ]
        );
    }

    #[test]
    fn a_last_declaration_without_a_semicolon_counts_a_commented_one_does_not_and_a_later_one_wins()
    {
        let dir = system(&[
            (
                "styles.css",
                "@import \"tokens/colors.css\";\n@import \"tokens/dark.css\";\n",
            ),
            (
                "tokens/colors.css",
                ":root {\n  /* --color-old: red; */\n  --color-bg: #fff;\n  --color-fg: #111 }\n",
            ),
            ("tokens/dark.css", ":root { --color-bg: #0b0c0e; }\n"),
        ]);
        let got: Vec<(String, String)> = read(dir.path())
            .into_iter()
            .map(|t| (t.name, t.value))
            .collect();
        assert_eq!(
            got,
            vec![
                ("--color-bg".to_string(), "#0b0c0e".to_string()),
                ("--color-fg".to_string(), "#111".to_string())
            ]
        );
    }
}
