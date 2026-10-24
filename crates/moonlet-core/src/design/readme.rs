//! `README.md` (X64), the design agent's main doc: the agent's conventions
//! header (`conventions.md`) first, then an index moonlet writes from the
//! cards and tokens, as design-sync's converter writes its own.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;

use super::check::{Kind, Problem, definitions, styles_closure};
use super::manifest;
use super::tokens::{self, Family};

/// The README of the design system in `root`, called `name`.
pub fn build(root: &Path, name: &str) -> Result<String> {
    let mut out = String::new();
    if let Ok(conventions) = std::fs::read_to_string(root.join("conventions.md")) {
        out.push_str(conventions.trim_end());
        out.push_str("\n\n");
    }
    out.push_str(&format!("# {name}\n\n## Where things are\n\n"));
    out.push_str(WHERE);
    if root.join("guidelines/index.md").is_file() {
        out.push_str("- `guidelines/`: read these before composing larger layouts. Start with `guidelines/index.md`.\n");
    }
    out.push_str("\n## Loading\n\n```html\n<link rel=\"stylesheet\" href=\"styles.css\">\n```\n");

    let tokens = tokens::read(root);
    if !tokens.is_empty() {
        out.push_str("\n## Tokens\n\n");
        for family in [
            Family::Color,
            Family::Spacing,
            Family::Typography,
            Family::Radius,
            Family::Shadow,
            Family::Other,
        ] {
            let names: Vec<&str> = tokens
                .iter()
                .filter(|t| t.family == family)
                .map(|t| t.name.as_str())
                .collect();
            if names.is_empty() {
                continue;
            }
            let mut shown: Vec<String> = names.iter().take(3).map(|n| format!("`{n}`")).collect();
            if names.len() > 3 {
                shown.push("…".into());
            }
            out.push_str(&format!(
                "- **{}** ({}): {}\n",
                family_label(family),
                names.len(),
                shown.join(", ")
            ));
        }
    }

    let cards = manifest::build(root)?.cards;
    let components: Vec<_> = cards
        .iter()
        .filter(|c| c.path.starts_with("components/"))
        .collect();
    if !components.is_empty() {
        out.push_str("\n## Components\n");
        let mut group = "";
        for c in components {
            if c.group != group {
                group = &c.group;
                out.push_str(&format!("\n### {group}\n\n"));
            }
            let prompt = root.join(&c.path).with_extension("prompt.md");
            let summary = std::fs::read_to_string(prompt)
                .ok()
                .and_then(|t| t.lines().next().map(|l| l.trim().to_string()))
                .filter(|l| !l.is_empty())
                .unwrap_or_else(|| "no `.prompt.md` yet.".into());
            out.push_str(&format!("- `{}` (`{}`): {summary}\n", c.name, c.path));
        }
    }
    let layouts: Vec<_> = cards
        .iter()
        .filter(|c| c.path.starts_with("ui_kits/"))
        .collect();
    if !layouts.is_empty() {
        out.push_str("\n## Layouts\n\n");
        for c in layouts {
            out.push_str(&format!(
                "- `{}` (`{}`), {}×{}\n",
                c.name, c.path, c.viewport.0, c.viewport.1
            ));
        }
    }
    Ok(out)
}

/// Writes `README.md` and returns what is wrong with it: names in
/// `conventions.md` that do not exist, and a README over the design agent's budget.
pub fn write(root: &Path, name: &str) -> Result<Vec<Problem>> {
    let readme = build(root, name)?;
    std::fs::write(root.join("README.md"), &readme)?;
    let mut problems = Vec::new();
    let length = readme.chars().count();
    if length > BUDGET {
        problems.push(Problem {
            path: "README.md".into(),
            line: 1,
            kind: Kind::ReadmeOverBudget,
            message: format!(
                "README.md is {length} characters; the design agent reads the first {BUDGET}"
            ),
        });
    }
    let Ok(conventions) = std::fs::read_to_string(root.join("conventions.md")) else {
        return Ok(problems);
    };
    let css: Vec<String> = styles_closure(root)
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .collect();
    let tokens: BTreeSet<String> = css.iter().flat_map(|t| definitions(t)).collect();
    // Classes from selectors only: not from comments, strings or file names.
    let classes: BTreeSet<String> = css
        .iter()
        .flat_map(|t| {
            let t = COMMENT.replace_all(t, "").into_owned();
            SELECTOR
                .captures_iter(&t)
                .filter(|c| !c[1].trim_start().starts_with('@'))
                .flat_map(|c| {
                    CLASS
                        .captures_iter(&c[1])
                        .map(|m| m[1].to_string())
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>()
        })
        .collect();
    for (i, line) in conventions.lines().enumerate() {
        for code in CODE.captures_iter(line) {
            for name in NAME.captures_iter(&code[1]) {
                let name = &name[1];
                let message = if let Some(class) = name.strip_prefix('.') {
                    if classes.contains(class) {
                        continue;
                    }
                    format!(
                        "`{name}` is not a class in components.css or the files styles.css imports"
                    )
                } else {
                    if tokens.contains(name) {
                        continue;
                    }
                    format!("`{name}` is not a token in styles.css or the files it imports")
                };
                problems.push(Problem {
                    path: "conventions.md".into(),
                    line: i + 1,
                    kind: Kind::UnknownName,
                    message,
                });
            }
        }
    }
    Ok(problems)
}

/// What the design agent reads of the README, as Claude Design inlines it.
pub const BUDGET: usize = 32_000;

static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`([^`]+)`").unwrap());
/// A class (`.btn`) or a token (`--color-accent`) named in code.
static NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[^A-Za-z0-9_-])(\.[A-Za-z_][A-Za-z0-9_-]*|--[A-Za-z0-9_-]+)").unwrap()
});
/// The prelude of each rule: the text before a `{` since the last `}` or `;`.
static SELECTOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([^{};]+)\{").unwrap());
static COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)/\*.*?\*/").unwrap());
static CLASS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.([A-Za-z_][A-Za-z0-9_-]*)").unwrap());

const WHERE: &str = "- `styles.css`: link this one file. It imports the tokens, the fonts and `components.css`.
- `tokens/`: the custom properties, under the source's own names.
- `components/<group>/<Name>/`: one card (`<Name>.html`) and how to use it (`<Name>.prompt.md`). Read a component's `.prompt.md` before using it.
- `foundations/`: colours, type, spacing, radius and shadow.
- `ui_kits/`: whole screens to start from.
";

fn family_label(f: Family) -> &'static str {
    match f {
        Family::Color => "color",
        Family::Spacing => "spacing",
        Family::Typography => "typography",
        Family::Radius => "radius",
        Family::Shadow => "shadow",
        Family::Other => "other",
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
    fn the_readme_puts_the_conventions_first_then_the_index() {
        let dir = system(&[
            (
                "conventions.md",
                "## Conventions\n\nStyle with classes: `.btn` and `.btn--primary`, colours from `--color-accent`.\n",
            ),
            (
                "styles.css",
                "@import \"tokens/colors.css\";\n@import \"components.css\";\n",
            ),
            (
                "tokens/colors.css",
                ":root {\n  --color-bg: #0b0c0e;\n  --color-fg: #e8e6e3;\n  --color-muted: #8a8a8a;\n  --color-accent: #e8774f;\n  --space-4: 16px;\n}\n",
            ),
            (
                "components.css",
                ".btn { background: var(--color-bg); }\n.btn--primary { background: var(--color-accent); }\n",
            ),
            (
                "components/buttons/button/button.html",
                "<!-- @dsCard group=\"Buttons\" name=\"Button\" -->\n",
            ),
            (
                "components/buttons/button/button.prompt.md",
                "A button for one action; primary for the main one.\n\n## Markup\n",
            ),
            (
                "components/custom/session-row/session-row.html",
                "<!-- @dsCard group=\"Custom\" name=\"Session row\" -->\n",
            ),
            (
                "foundations/colours/colours.html",
                "<!-- @dsCard group=\"Foundations\" name=\"Colours\" -->\n",
            ),
            (
                "ui_kits/app/settings.html",
                "<!-- @dsCard group=\"Layouts\" name=\"Settings\" viewport=\"1440x900\" -->\n",
            ),
            ("guidelines/index.md", "# Guidelines\n"),
        ]);
        assert_eq!(
            build(dir.path(), "moonlet desktop").unwrap(),
            "## Conventions

Style with classes: `.btn` and `.btn--primary`, colours from `--color-accent`.

# moonlet desktop

## Where things are

- `styles.css`: link this one file. It imports the tokens, the fonts and `components.css`.
- `tokens/`: the custom properties, under the source's own names.
- `components/<group>/<Name>/`: one card (`<Name>.html`) and how to use it (`<Name>.prompt.md`). Read a component's `.prompt.md` before using it.
- `foundations/`: colours, type, spacing, radius and shadow.
- `ui_kits/`: whole screens to start from.
- `guidelines/`: read these before composing larger layouts. Start with `guidelines/index.md`.

## Loading

```html
<link rel=\"stylesheet\" href=\"styles.css\">
```

## Tokens

- **color** (4): `--color-bg`, `--color-fg`, `--color-muted`, …
- **spacing** (1): `--space-4`

## Components

### Buttons

- `Button` (`components/buttons/button/button.html`): A button for one action; primary for the main one.

### Custom

- `Session row` (`components/custom/session-row/session-row.html`): no `.prompt.md` yet.

## Layouts

- `Settings` (`ui_kits/app/settings.html`), 1440×900
"
        );
    }

    #[test]
    fn writing_the_readme_reports_conventions_that_name_nothing_and_a_readme_over_budget() {
        let long = format!("A button.{}\n", " Long.".repeat(6_000));
        let dir = system(&[
            (
                "conventions.md",
                "## Conventions\n\nUse `.btn`.\nUse `.btn--huge` and `var(--color-selected)` for the selection, `--color-accent` for actions.\n",
            ),
            (
                "styles.css",
                "@import \"tokens/colors.css\";\n@import \"components.css\";\n",
            ),
            (
                "tokens/colors.css",
                ":root {\n  --color-accent: #e8774f;\n}\n",
            ),
            ("components.css", ".btn { color: var(--color-accent); }\n"),
            (
                "components/buttons/button/button.html",
                "<!-- @dsCard group=\"Buttons\" name=\"Button\" -->\n",
            ),
            ("components/buttons/button/button.prompt.md", long.as_str()),
        ]);
        let problems: Vec<(String, usize, Kind, String)> = write(dir.path(), "moonlet desktop")
            .unwrap()
            .into_iter()
            .map(|p| (p.path, p.line, p.kind, p.message))
            .collect();
        let readme = std::fs::read_to_string(dir.path().join("README.md")).unwrap();
        assert!(readme.starts_with("## Conventions\n"));
        assert_eq!(
            problems,
            vec![
                (
                    "README.md".into(),
                    1,
                    Kind::ReadmeOverBudget,
                    format!(
                        "README.md is {} characters; the design agent reads the first 32000",
                        readme.chars().count()
                    )
                ),
                (
                    "conventions.md".into(),
                    4,
                    Kind::UnknownName,
                    "`.btn--huge` is not a class in components.css or the files styles.css imports"
                        .into()
                ),
                (
                    "conventions.md".into(),
                    4,
                    Kind::UnknownName,
                    "`--color-selected` is not a token in styles.css or the files it imports"
                        .into()
                ),
            ]
        );
    }

    #[test]
    fn a_class_only_named_in_a_comment_string_or_import_does_not_count() {
        let dir = system(&[
            (
                "conventions.md",
                "Use `.btn`, `.ghost`, `.woff2` and `.tooltip`.\n",
            ),
            (
                "styles.css",
                "@import \"tokens/colors.css\";\n@import \"components.css\";\n",
            ),
            ("tokens/colors.css", ":root { --color-bg: #fff; }\n"),
            (
                "components.css",
                "/* .ghost was removed */\n.btn { content: \".tooltip\"; background: url(./font.woff2); }\n",
            ),
        ]);
        let messages: Vec<String> = write(dir.path(), "x")
            .unwrap()
            .into_iter()
            .map(|p| p.message)
            .collect();
        assert_eq!(
            messages,
            vec![
                "`.ghost` is not a class in components.css or the files styles.css imports"
                    .to_string(),
                "`.woff2` is not a class in components.css or the files styles.css imports"
                    .to_string(),
                "`.tooltip` is not a class in components.css or the files styles.css imports"
                    .to_string(),
            ]
        );
    }

    #[test]
    fn a_colour_alias_is_listed_with_the_colours() {
        let dir = system(&[
            ("styles.css", "@import \"tokens/colors.css\";\n"),
            (
                "tokens/colors.css",
                ":root {\n  --color-accent: #e8774f;\n  --accent: var(--color-accent);\n}\n",
            ),
        ]);
        let readme = build(dir.path(), "moonlet desktop").unwrap();
        assert!(
            readme.ends_with("## Tokens\n\n- **color** (2): `--color-accent`, `--accent`\n"),
            "{readme}"
        );
    }
}
