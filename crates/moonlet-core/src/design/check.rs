//! `moonlet design check` (X64): problems in a design system's folder, each
//! with the file, the line and what is wrong.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;
use serde::Serialize;

use super::card::{self, MarkerError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// The card's `@dsCard` line is missing or wrong.
    Marker,
    /// A `var(--x)` that nothing in the `styles.css` closure defines.
    UnknownToken,
    /// An `@import`, `<link>` or local `src` that names no file.
    Unresolved,
    /// A URL outside the design system.
    ExternalUrl,
    /// A `<script>` or an `on*` attribute in a card.
    Script,
    /// A font family used first in a stack that has no `@font-face`.
    FontMissing,
    /// A second card in one folder: the Design System pane keeps only the first.
    DuplicateCard,
    /// A snippet id another card already uses.
    DuplicateSnippet,
    /// An element of a design page without a `data-mid` (X65).
    MissingMid,
    /// A `data-mid` an earlier element of the page already has (X65).
    DuplicateMid,
}

/// The folders whose `.html` files are cards: components, foundations and layouts.
const CARD_DIRS: [&str; 3] = ["components", "foundations", "ui_kits"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    /// Relative to the design system's folder, with `/`.
    pub path: String,
    /// 1-based.
    pub line: usize,
    pub kind: Kind,
    pub message: String,
}

static IMPORT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"@import\s+(?:url\(\s*)?["']?([^"')\s;]+)"#).unwrap());
static DEFINITION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(--[A-Za-z0-9_-]+)\s*:").unwrap());
static VAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"var\(\s*(--[A-Za-z0-9_-]+)").unwrap());
static FONT_FACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"@font-face\s*\{[^}]*?font-family:\s*["']?([^"';}]+)"#).unwrap());
static FONT_FAMILY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"font-family:\s*([^;}]+)").unwrap());
/// Families every Mac has, or that name no font.
const SYSTEM_FONTS: [&str; 18] = [
    "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
    "ui-monospace", "ui-rounded", "emoji", "math", "-apple-system", "blinkmacsystemfont", "inherit", "initial",
    "unset", "revert",
];
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"url\(\s*["']?([^"')\s]+)"#).unwrap());

/// Checks the design system in `root`.
pub fn check(root: &Path) -> Result<Vec<Problem>> {
    let mut problems = Vec::new();
    let closure = styles_closure(root);
    let texts: Vec<(PathBuf, String)> =
        closure.iter().filter_map(|p| Some((p.clone(), std::fs::read_to_string(p).ok()?))).collect();
    let defined: BTreeSet<String> = texts.iter().flat_map(|(_, t)| definitions(t)).collect();
    let faces: BTreeSet<String> =
        texts.iter().flat_map(|(_, t)| FONT_FACE.captures_iter(t).map(|c| c[1].trim().to_lowercase())).collect();
    for (path, text) in &texts {
        let path_rel = rel(root, path);
        imports(&path_rel, path, text, &mut problems);
        unknown_tokens(&path_rel, text, &defined, &mut problems);
        fonts(&path_rel, text, &faces, &mut problems);
    }
    // The first card of each component folder, and where each snippet id first shows.
    let mut first_card: std::collections::BTreeMap<PathBuf, String> = Default::default();
    let mut snippets: std::collections::HashMap<String, String> = Default::default();
    for path in html_files(root) {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let path_rel = rel(root, &path);
        if !CARD_DIRS.iter().any(|d| path_rel.starts_with(&format!("{d}/"))) {
            continue;
        }
        let proposed = path_rel.ends_with(".proposed.html");
        let one_card_per_folder = path_rel.starts_with("components/") || path_rel.starts_with("foundations/");
        if one_card_per_folder && !proposed {
            let folder = path.parent().unwrap_or(root).to_path_buf();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            match first_card.get(&folder) {
                Some(first) => problems.push(Problem {
                    path: path_rel.clone(),
                    line: 1,
                    kind: Kind::DuplicateCard,
                    message: format!("{} holds two cards: {first} and {name}", rel(root, &folder)),
                }),
                None => {
                    first_card.insert(folder, name);
                }
            }
        }
        if let Err(e) = card::parse_marker(&text) {
            let message = match e {
                MarkerError::Missing => "the first line must be <!-- @dsCard group=\"…\" … -->".to_string(),
                MarkerError::Malformed(m) => m,
            };
            problems.push(Problem { path: path_rel.clone(), line: 1, kind: Kind::Marker, message });
        }
        // A card may define its own custom properties in its <style>.
        let mut known = defined.clone();
        known.extend(definitions(&text));
        unknown_tokens(&path_rel, &text, &known, &mut problems);
        css_urls(&path_rel, &text, &mut problems);
        fonts(&path_rel, &text, &faces, &mut problems);
        for (line, id) in elements(&path_rel, &path, &text, &mut problems) {
            if proposed {
                continue;
            }
            match snippets.get(&id) {
                Some(first) => problems.push(Problem {
                    path: path_rel.clone(),
                    line,
                    kind: Kind::DuplicateSnippet,
                    message: format!("snippet {id} is also in {first}"),
                }),
                None => {
                    snippets.insert(id, path_rel.clone());
                }
            }
        }
    }
    problems.sort_by(|a, b| (&a.path, a.line).cmp(&(&b.path, b.line)));
    Ok(problems)
}

/// `styles.css` and every local file it imports, directly or not.
fn styles_closure(root: &Path) -> Vec<PathBuf> {
    let mut seen = Vec::new();
    let mut todo = vec![root.join("styles.css")];
    while let Some(file) = todo.pop() {
        if seen.contains(&file) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let dir = file.parent().unwrap_or(root).to_path_buf();
        for c in IMPORT.captures_iter(&text) {
            if !is_external(&c[1]) {
                todo.push(dir.join(&c[1]));
            }
        }
        seen.push(file);
    }
    seen
}

fn definitions(text: &str) -> impl Iterator<Item = String> + '_ {
    DEFINITION.captures_iter(text).map(|c| c[1].to_string())
}

fn unknown_tokens(path: &str, text: &str, known: &BTreeSet<String>, problems: &mut Vec<Problem>) {
    for (i, line) in text.lines().enumerate() {
        for c in VAR.captures_iter(line) {
            if !known.contains(&c[1]) {
                problems.push(Problem {
                    path: path.to_string(),
                    line: i + 1,
                    kind: Kind::UnknownToken,
                    message: format!("var({}) is not defined in styles.css or the files it imports", &c[1]),
                });
            }
        }
    }
}

/// `@import`s that leave the design system or name no file, and other
/// `url()`s that leave it.
fn imports(path_rel: &str, path: &Path, text: &str, problems: &mut Vec<Problem>) {
    let dir = path.parent().unwrap_or(Path::new("."));
    for (i, line) in text.lines().enumerate() {
        let Some(c) = IMPORT.captures(line) else {
            css_urls_in_line(path_rel, i + 1, line, problems);
            continue;
        };
        let target = &c[1];
        let (kind, message) = if is_external(target) {
            (Kind::ExternalUrl, format!("{target} leaves the design system"))
        } else if !dir.join(target).is_file() {
            (Kind::Unresolved, format!("@import \"{target}\" does not resolve"))
        } else {
            continue;
        };
        problems.push(Problem { path: path_rel.to_string(), line: i + 1, kind, message });
    }
}

fn css_urls(path_rel: &str, text: &str, problems: &mut Vec<Problem>) {
    for (i, line) in text.lines().enumerate() {
        css_urls_in_line(path_rel, i + 1, line, problems);
    }
}

fn css_urls_in_line(path_rel: &str, line: usize, text: &str, problems: &mut Vec<Problem>) {
    for c in URL.captures_iter(text) {
        if is_external(&c[1]) {
            problems.push(Problem {
                path: path_rel.to_string(),
                line,
                kind: Kind::ExternalUrl,
                message: format!("{} leaves the design system", &c[1]),
            });
        }
    }
}

/// Font families used first in a stack, without a face.
fn fonts(path_rel: &str, text: &str, faces: &BTreeSet<String>, problems: &mut Vec<Problem>) {
    for (i, line) in text.lines().enumerate() {
        if line.contains("@font-face") {
            continue;
        }
        for c in FONT_FAMILY.captures_iter(line) {
            let first = c[1].split(',').next().unwrap_or("").trim().trim_matches(['"', '\'']).to_string();
            let key = first.to_lowercase();
            if first.is_empty() || first.starts_with("var(") || SYSTEM_FONTS.contains(&key.as_str()) || faces.contains(&key) {
                continue;
            }
            problems.push(Problem {
                path: path_rel.to_string(),
                line: i + 1,
                kind: Kind::FontMissing,
                message: format!("font \"{first}\" has no @font-face in styles.css or the files it imports"),
            });
        }
    }
}

/// Scripts, `on*` attributes, and `href`/`src` that leave the system or name
/// no file. Returns the snippet ids (`data-snippet`) with their lines.
fn elements(path_rel: &str, path: &Path, text: &str, problems: &mut Vec<Problem>) -> Vec<(usize, String)> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let found = std::cell::RefCell::new(Vec::new());
    let snippet_ids = std::cell::RefCell::new(Vec::new());
    let line_of = |byte: usize| text[..byte.min(text.len())].matches('\n').count() + 1;
    let settings = lol_html::Settings::new().append_element_content_handler(lol_html::element!("*", |el| {
            let line = line_of(el.source_location().bytes().start);
            let tag = el.tag_name();
            let mut found = found.borrow_mut();
            if let Some(id) = el.get_attribute("data-snippet") {
                snippet_ids.borrow_mut().push((line, id));
            }
            if tag == "script" {
                found.push((line, Kind::Script, "<script> is not allowed in a card".to_string()));
            }
            for a in el.attributes() {
                let (name, value) = (a.name(), a.value());
                if name.starts_with("on") {
                    found.push((line, Kind::Script, format!("{name}=\"…\" is not allowed in a card")));
                } else if name == "href" || name == "src" {
                    let target = value.split(['?', '#']).next().unwrap_or("");
                    if is_external(&value) {
                        found.push((line, Kind::ExternalUrl, format!("{value} leaves the design system")));
                    } else if !target.is_empty() && !value.contains(':') && !dir.join(target).exists() {
                        found.push((line, Kind::Unresolved, format!("<{tag} {name}=\"{value}\"> does not resolve")));
                    }
                }
            }
            Ok(())
        }));
    if lol_html::rewrite_str(text, settings).is_err() {
        return Vec::new();
    }
    for (line, kind, message) in found.into_inner() {
        problems.push(Problem { path: path_rel.to_string(), line, kind, message });
    }
    snippet_ids.into_inner()
}

/// A URL that leaves the design system.
fn is_external(url: &str) -> bool {
    url.starts_with("http:") || url.starts_with("https:") || url.starts_with("//") || url.starts_with('/')
}

/// Every `.html` file, in a stable order, leaving out `.cache/`.
fn html_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut todo = vec![root.to_path_buf()];
    while let Some(dir) = todo.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if e.file_name() != ".cache" {
                    todo.push(p);
                }
            } else if p.extension().is_some_and(|x| x == "html") {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// `path` relative to `root`, with `/`.
fn rel(root: &Path, path: &Path) -> String {
    let p = path.strip_prefix(root).unwrap_or(path);
    p.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A design system folder with these files.
    fn system(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in files {
            let p = dir.path().join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        dir
    }

    const STYLES: &str = "@import \"tokens/colors.css\";\n@import \"components.css\";\n";
    const COLORS: &str = ":root {\n  --color-bg: #0b0c0e;\n  --color-accent: #e8774f;\n}\n";
    const COMPONENTS: &str = ".session-row { background: var(--color-bg); }\n";

    #[test]
    fn a_token_no_file_in_the_styles_closure_defines_is_reported_at_its_line() {
        let card = "<!-- @dsCard group=\"Custom\" name=\"Session row\" source=\"apps/desktop/src/components/Sidebar.tsx\" viewport=\"320x140\" -->\n\
<!doctype html>\n\
<link rel=\"stylesheet\" href=\"../../../styles.css\">\n\
<section class=\"ds-cell\" data-snippet=\"custom/session-row/selected\"><h4>selected</h4>\n\
<div class=\"ds-mount\"><div class=\"session-row\" style=\"outline: 1px solid var(--color-selected-2); color: var(--color-accent)\">onboarding-copy</div></div>\n\
</section>\n";
        let dir = system(&[
            ("styles.css", STYLES),
            ("tokens/colors.css", COLORS),
            ("components.css", COMPONENTS),
            ("components/custom/session-row/session-row.html", card),
        ]);
        assert_eq!(
            check(dir.path()).unwrap(),
            vec![Problem {
                path: "components/custom/session-row/session-row.html".into(),
                line: 5,
                kind: Kind::UnknownToken,
                message: "var(--color-selected-2) is not defined in styles.css or the files it imports".into(),
            }]
        );
    }

    #[test]
    fn a_card_without_a_marker_or_with_a_bad_one_is_reported_on_its_first_line() {
        let dir = system(&[
            ("styles.css", STYLES),
            ("tokens/colors.css", COLORS),
            ("components.css", COMPONENTS),
            ("components/buttons/button/button.html", "<!doctype html>\n<button class=\"btn\">Run</button>\n"),
            ("ui_kits/app/settings.html", "<!-- @dsCard group=\"Layouts\" viewport=\"wide\" -->\n<!doctype html>\n"),
            // Not a card: the design system's own files outside the card folders.
            (".cache/review.html", "<!doctype html>\n"),
        ]);
        assert_eq!(
            check(dir.path()).unwrap(),
            vec![
                Problem {
                    path: "components/buttons/button/button.html".into(),
                    line: 1,
                    kind: Kind::Marker,
                    message: "the first line must be <!-- @dsCard group=\"…\" … -->".into(),
                },
                Problem {
                    path: "ui_kits/app/settings.html".into(),
                    line: 1,
                    kind: Kind::Marker,
                    message: "viewport \"wide\" is not WxH".into(),
                },
            ]
        );
    }

    #[test]
    fn links_that_do_not_resolve_urls_outside_the_system_and_scripts_are_reported() {
        let card = "<!-- @dsCard group=\"Buttons\" -->\n\
<!doctype html>\n\
<link rel=\"stylesheet\" href=\"../../../styles.css\">\n\
<link rel=\"stylesheet\" href=\"../../../missing.css\">\n\
<img src=\"https://example.com/logo.png\" alt=\"\">\n\
<button class=\"btn\" onclick=\"go()\">Run</button>\n\
<div style=\"background: url(//cdn.example.com/bg.png)\"></div>\n\
<script>go()</script>\n";
        let styles = "@import \"tokens/colors.css\";\n@import \"tokens/missing.css\";\n@import url(https://fonts.example.com/inter.css);\n";
        let dir = system(&[
            ("styles.css", styles),
            ("tokens/colors.css", COLORS),
            ("components/buttons/button/button.html", card),
        ]);
        let got: Vec<(String, usize, Kind, String)> =
            check(dir.path()).unwrap().into_iter().map(|p| (p.path, p.line, p.kind, p.message)).collect();
        let card = "components/buttons/button/button.html".to_string();
        assert_eq!(
            got,
            vec![
                (card.clone(), 4, Kind::Unresolved, "<link href=\"../../../missing.css\"> does not resolve".into()),
                (card.clone(), 5, Kind::ExternalUrl, "https://example.com/logo.png leaves the design system".into()),
                (card.clone(), 6, Kind::Script, "onclick=\"…\" is not allowed in a card".into()),
                (card.clone(), 7, Kind::ExternalUrl, "//cdn.example.com/bg.png leaves the design system".into()),
                (card, 8, Kind::Script, "<script> is not allowed in a card".into()),
                ("styles.css".into(), 2, Kind::Unresolved, "@import \"tokens/missing.css\" does not resolve".into()),
                ("styles.css".into(), 3, Kind::ExternalUrl, "https://fonts.example.com/inter.css leaves the design system".into()),
            ]
        );
    }

    #[test]
    fn a_font_used_first_in_a_stack_without_a_font_face_is_reported() {
        let styles = "@import \"tokens/colors.css\";\n@import \"fonts/fonts.css\";\n@import \"components.css\";\n";
        let fonts = "@font-face {\n  font-family: \"Inter\";\n  src: url(./Inter.woff2);\n}\n";
        let components = ".btn { font-family: Inter, system-ui, sans-serif; }\n.kbd { font-family: \"JetBrains Mono\", ui-monospace, monospace; }\n.hint { font-family: -apple-system, sans-serif; }\n";
        let dir = system(&[
            ("styles.css", styles),
            ("tokens/colors.css", COLORS),
            ("fonts/fonts.css", fonts),
            ("fonts/Inter.woff2", "woff2"),
            ("components.css", components),
        ]);
        assert_eq!(
            check(dir.path()).unwrap(),
            vec![Problem {
                path: "components.css".into(),
                line: 2,
                kind: Kind::FontMissing,
                message: "font \"JetBrains Mono\" has no @font-face in styles.css or the files it imports".into(),
            }]
        );
    }

    #[test]
    fn two_cards_in_one_folder_and_a_snippet_id_used_twice_are_reported() {
        let card = |snippet: &str| {
            format!("<!-- @dsCard group=\"Buttons\" -->\n<!doctype html>\n<section class=\"ds-cell\" data-snippet=\"{snippet}\"><h4>primary</h4></section>\n")
        };
        let dir = system(&[
            ("styles.css", STYLES),
            ("tokens/colors.css", COLORS),
            ("components.css", COMPONENTS),
            ("components/buttons/button/button.html", &card("buttons/button/primary")),
            ("components/buttons/button/button-old.html", &card("buttons/button/old")),
            ("components/buttons/button/button.proposed.html", &card("buttons/button/primary")),
            ("components/buttons/icon-button/icon-button.html", &card("buttons/button/primary")),
        ]);
        assert_eq!(
            check(dir.path()).unwrap(),
            vec![
                Problem {
                    path: "components/buttons/button/button.html".into(),
                    line: 1,
                    kind: Kind::DuplicateCard,
                    message: "components/buttons/button holds two cards: button-old.html and button.html".into(),
                },
                Problem {
                    path: "components/buttons/icon-button/icon-button.html".into(),
                    line: 3,
                    kind: Kind::DuplicateSnippet,
                    message: "snippet buttons/button/primary is also in components/buttons/button/button.html".into(),
                },
            ]
        );
    }
}
