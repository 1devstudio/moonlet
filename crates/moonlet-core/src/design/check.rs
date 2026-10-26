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
    /// An `@import`, `<link>` or local `src` that names no file, or an
    /// `@import` of a proposal not yet settled.
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
    /// A design page's stylesheet that is not its design system's
    /// `styles.css` (X65).
    Stylesheet,
    /// A class or token in `conventions.md` that nothing defines.
    UnknownName,
    /// A README longer than the design agent reads.
    ReadmeOverBudget,
}

/// The folders whose `.html` files are cards: components, foundations and layouts.
pub(crate) const CARD_DIRS: [&str; 3] = ["components", "foundations", "ui_kits"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    /// Relative to the design system's folder, with `/`.
    pub path: String,
    /// 1-based.
    pub line: usize,
    pub kind: Kind,
    pub message: String,
}

/// CSS keywords and functions are case-insensitive: `@IMPORT` and `URL(` count.
/// A quoted URL runs to its closing quote and may hold spaces; see [`quoted`].
/// A quote or `url(` may follow `@import` with no space, as minifiers write
/// it (`@import"kit.css";`); a bare URL needs one, or it is part of the name.
static IMPORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)@import(?:\s*(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')|\s*url\(\s*([^"')\s]+)|\s+([^"')\s;]+))"#,
    )
    .unwrap()
});
static DEFINITION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(--[A-Za-z0-9_-]+)\s*:").unwrap());
static VAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"var\(\s*(--[A-Za-z0-9_-]+)").unwrap());
static FONT_FACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"@font-face\s*\{[^}]*?font-family:\s*["']?([^"';}]+)"#).unwrap());
static FONT_FAMILY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"font-family:\s*([^;}]+)").unwrap());
/// Families every Mac has, or that name no font.
const SYSTEM_FONTS: [&str; 18] = [
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "emoji",
    "math",
    "-apple-system",
    "blinkmacsystemfont",
    "inherit",
    "initial",
    "unset",
    "revert",
];
static URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')\s]+))"#).unwrap());

/// The URL an [`IMPORT`] or [`URL`] match took: double-quoted, single-quoted or bare.
fn quoted<'t>(c: &regex::Captures<'t>) -> &'t str {
    c.iter().skip(1).flatten().next().map_or("", |m| m.as_str())
}

/// Checks the design system in `root`.
pub fn check(root: &Path) -> Result<Vec<Problem>> {
    let mut problems = Vec::new();
    if !root.join("styles.css").is_file() {
        problems.push(Problem {
            path: "styles.css".into(),
            line: 1,
            kind: Kind::Unresolved,
            message: "styles.css is missing".into(),
        });
    }
    let closure = styles_closure(root);
    let texts: Vec<(PathBuf, String)> = closure
        .iter()
        .filter_map(|p| Some((p.clone(), std::fs::read_to_string(p).ok()?)))
        .collect();
    let defined: BTreeSet<String> = texts.iter().flat_map(|(_, t)| definitions(t)).collect();
    let faces: BTreeSet<String> = texts
        .iter()
        .flat_map(|(_, t)| {
            FONT_FACE
                .captures_iter(t)
                .map(|c| c[1].trim().to_lowercase())
        })
        .collect();
    for (path, text) in &texts {
        let path_rel = rel(root, path);
        css_problems(root, &path_rel, path, text, &[0..text.len()], &mut problems);
        unknown_tokens(&path_rel, text, &defined, &mut problems);
        fonts(&path_rel, text, &faces, &mut problems);
    }
    // The first card of each component folder, and where each snippet id first shows.
    let mut first_card: std::collections::BTreeMap<PathBuf, String> = Default::default();
    let mut snippets: std::collections::HashMap<String, String> = Default::default();
    for path in html_files(root) {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let path_rel = rel(root, &path);
        if !CARD_DIRS
            .iter()
            .any(|d| path_rel.starts_with(&format!("{d}/")))
        {
            continue;
        }
        let proposed = path_rel.ends_with(".proposed.html");
        let one_card_per_folder =
            path_rel.starts_with("components/") || path_rel.starts_with("foundations/");
        if one_card_per_folder && !proposed {
            let folder = path.parent().unwrap_or(root).to_path_buf();
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
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
                MarkerError::Missing => {
                    "the first line must be <!-- @dsCard group=\"…\" … -->".to_string()
                }
                MarkerError::Malformed(m) => m,
            };
            problems.push(Problem {
                path: path_rel.clone(),
                line: 1,
                kind: Kind::Marker,
                message,
            });
        }
        // A card may define its own custom properties in its <style>.
        let mut known = defined.clone();
        known.extend(definitions(&text));
        unknown_tokens(&path_rel, &text, &known, &mut problems);
        // A card's <style> may @import like a stylesheet; its text is not CSS.
        css_problems(
            root,
            &path_rel,
            &path,
            &text,
            &style_ranges(&text),
            &mut problems,
        );
        fonts(&path_rel, &text, &faces, &mut problems);
        for (line, id) in elements(root, &path_rel, &path, &text, &mut problems) {
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

/// `styles.css` and every local file it imports, directly or not, in import
/// order (each file once).
pub(super) fn styles_closure(root: &Path) -> Vec<PathBuf> {
    fn visit(file: PathBuf, root: &Path, seen: &mut Vec<PathBuf>) {
        if seen.contains(&file) {
            return;
        }
        let Ok(text) = std::fs::read_to_string(&file) else {
            return;
        };
        let dir = file.parent().unwrap_or(root).to_path_buf();
        seen.push(file);
        for r in css_refs(&text).into_iter().filter(|r| r.import) {
            if let Target::Fine(Some(next)) = target(root, &dir, &r.url)
                && !is_proposal(&next)
            {
                visit(next, root, seen);
            }
        }
    }
    let mut seen = Vec::new();
    visit(root.join("styles.css"), root, &mut seen);
    seen
}

/// A sync's proposed version of a card's file (`<name>.proposed.css`),
/// not live until the user settles it.
fn is_proposal(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|n| n.to_string_lossy().contains(".proposed."))
}

/// Where a URL in a file of the design system points.
enum Target {
    /// Inside the system, and the file exists (`None` for a fragment, `data:`,
    /// `mailto:` or `tel:`).
    Fine(Option<PathBuf>),
    /// Outside the system: another scheme, an absolute path, or `..` past its root.
    Leaves,
    /// Inside the system, but no file is there.
    Missing,
    /// A `javascript:` URL.
    Script,
}

static SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z][A-Za-z0-9+.-]*):").unwrap());

/// Resolves `url`, written in a file of `dir`, against the system in `root`.
fn target(root: &Path, dir: &Path, url: &str) -> Target {
    let url = url.trim();
    if url.is_empty() || url.starts_with('#') {
        return Target::Fine(None);
    }
    if let Some(c) = SCHEME.captures(url) {
        return match c[1].to_lowercase().as_str() {
            "data" | "mailto" | "tel" => Target::Fine(None),
            "javascript" => Target::Script,
            _ => Target::Leaves,
        };
    }
    if url.starts_with('/') {
        return Target::Leaves;
    }
    let path = url.split(['?', '#']).next().unwrap_or("");
    let Some(resolved) = inside(root, dir, path) else {
        return Target::Leaves;
    };
    if !resolved.exists() {
        return Target::Missing;
    }
    // A symlink inside the system may still point out of it.
    match (
        std::fs::canonicalize(&resolved),
        std::fs::canonicalize(root),
    ) {
        (Ok(file), Ok(root)) if file.starts_with(&root) => Target::Fine(Some(resolved)),
        _ => Target::Leaves,
    }
}

/// `dir/rel` with `.` and `..` worked out, or `None` when it climbs out of `root`.
fn inside(root: &Path, dir: &Path, rel: &str) -> Option<PathBuf> {
    use std::path::Component;
    let mut parts: Vec<std::ffi::OsString> = dir
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|c| c.as_os_str().to_owned())
        .collect();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(p) => parts.push(p.to_owned()),
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(
        parts
            .iter()
            .fold(root.to_path_buf(), |p, part| p.join(part)),
    )
}

/// The byte ranges of the comments in `css`, found as a browser finds them:
/// a `/*` in a string or an unquoted `url(…)` opens none.
fn css_comments(css: &str) -> Vec<std::ops::Range<usize>> {
    fn walk(p: &mut cssparser::Parser<'_, '_>, out: &mut Vec<std::ops::Range<usize>>) {
        loop {
            let start = p.position().byte_index();
            let Ok(token) = p.next_including_whitespace_and_comments() else {
                return;
            };
            let comment = matches!(token, cssparser::Token::Comment(_));
            let block = matches!(
                token,
                cssparser::Token::Function(_)
                    | cssparser::Token::ParenthesisBlock
                    | cssparser::Token::SquareBracketBlock
                    | cssparser::Token::CurlyBracketBlock
            );
            if comment {
                out.push(start..p.position().byte_index());
            } else if block {
                let _ = p.parse_nested_block(|p| {
                    walk(p, out);
                    Ok::<_, cssparser::ParseError<'_, ()>>(())
                });
            }
        }
    }
    let mut input = cssparser::ParserInput::new(css);
    let mut out = Vec::new();
    walk(&mut cssparser::Parser::new(&mut input), &mut out);
    out
}

/// The byte ranges of a page's `<style>` elements' text: the page's CSS.
fn style_ranges(html: &str) -> Vec<std::ops::Range<usize>> {
    let styles = std::cell::RefCell::new(Vec::<std::ops::Range<usize>>::new());
    let settings =
        lol_html::Settings::new().append_element_content_handler(lol_html::text!("style", |t| {
            // One style's text may come in several chunks.
            let r = t.source_location().bytes();
            let mut styles = styles.borrow_mut();
            match styles.last_mut() {
                Some(last) if last.end == r.start => last.end = r.end,
                _ => styles.push(r),
            }
            Ok(())
        }));
    if lol_html::rewrite_str(html, settings).is_err() {
        return Vec::new();
    }
    styles.into_inner()
}

/// Each `@import` in a page's `<style>`s, comments left out, as the line it
/// starts on and its URL, which may be on a later line: what a design page's
/// check holds against its design system's `styles.css` (X65). An `@import`
/// anywhere else in the page, in its text or a script, is not CSS.
pub(super) fn style_imports(html: &str) -> Vec<(usize, String)> {
    style_ranges(html)
        .into_iter()
        .flat_map(|s| {
            css_refs(&html[s.clone()])
                .into_iter()
                .filter(|r| r.import)
                .map(move |r| (line_of(html, s.start + r.at), r.url))
        })
        .collect()
}

/// A URL that CSS names: an `@import`'s, or a `url()` elsewhere.
struct CssRef {
    /// Where it starts in the CSS, in bytes.
    at: usize,
    url: String,
    import: bool,
}

/// Each `@import` and `url()` of `css`, comments left out, in order. One may
/// span lines (`@import` with its URL on the next); an `@import url(…)` is
/// one `@import`, not a `url()` too.
fn css_refs(css: &str) -> Vec<CssRef> {
    let css = blank(css, &css_comments(css));
    let mut refs = Vec::new();
    let mut taken = Vec::new();
    for c in IMPORT.captures_iter(&css) {
        let m = c.get(0).map_or(0..0, |m| m.range());
        refs.push(CssRef {
            at: m.start,
            url: quoted(&c).to_string(),
            import: true,
        });
        taken.push(m);
    }
    for c in URL.captures_iter(&css) {
        let at = c.get(0).map_or(0, |m| m.start());
        if !taken.iter().any(|r| r.contains(&at)) {
            refs.push(CssRef {
                at,
                url: quoted(&c).to_string(),
                import: false,
            });
        }
    }
    refs.sort_by_key(|r| r.at);
    refs
}

/// The 1-based line of the byte at `byte` in `text`.
fn line_of(text: &str, byte: usize) -> usize {
    text[..byte.min(text.len())].matches('\n').count() + 1
}

/// `text` with every byte in `ranges` but line breaks made a space, so lines
/// and offsets stay where they were.
fn blank(text: &str, ranges: &[std::ops::Range<usize>]) -> String {
    let mut bytes = text.as_bytes().to_vec();
    for r in ranges {
        for b in &mut bytes[r.clone()] {
            if *b != b'\n' && *b != b'\r' {
                *b = b' ';
            }
        }
    }
    // A comment starts and ends on ASCII, so the bytes are still UTF-8.
    String::from_utf8(bytes).unwrap_or_else(|_| text.to_string())
}

pub(super) fn definitions(text: &str) -> impl Iterator<Item = String> + '_ {
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
                    message: format!(
                        "var({}) is not defined in styles.css or the files it imports",
                        &c[1]
                    ),
                });
            }
        }
    }
}

/// Each `@import` and `url()` in the CSS of a file, the `css` ranges of
/// `text` (a stylesheet's whole text, a card's `<style>`s), that leaves the
/// design system or names no file.
fn css_problems(
    root: &Path,
    path_rel: &str,
    path: &Path,
    text: &str,
    css: &[std::ops::Range<usize>],
    problems: &mut Vec<Problem>,
) {
    let dir = path.parent().unwrap_or(root);
    for range in css {
        for r in css_refs(&text[range.clone()]) {
            if let Some((kind, message)) = css_problem(root, dir, &r) {
                problems.push(Problem {
                    path: path_rel.to_string(),
                    line: line_of(text, range.start + r.at),
                    kind,
                    message,
                });
            }
        }
    }
}

/// What is wrong with a URL that CSS in `dir` names, if anything.
fn css_problem(root: &Path, dir: &Path, r: &CssRef) -> Option<(Kind, String)> {
    let url = &r.url;
    Some(match target(root, dir, url) {
        Target::Leaves => (Kind::ExternalUrl, format!("{url} leaves the design system")),
        Target::Missing if r.import => (
            Kind::Unresolved,
            format!("@import \"{url}\" does not resolve"),
        ),
        Target::Missing => (Kind::Unresolved, format!("url({url}) does not resolve")),
        Target::Script => (
            Kind::Script,
            "a javascript: URL is not allowed in a card".into(),
        ),
        Target::Fine(Some(file)) if r.import && is_proposal(&file) => {
            let live = file
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .replace(".proposed.", ".");
            (
                Kind::Unresolved,
                format!("@import \"{url}\" is a proposal waiting to be settled; import {live}"),
            )
        }
        Target::Fine(_) => return None,
    })
}

static FONT_FACE_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"@font-face\s*\{[^}]*\}").unwrap());

/// Font families used first in a stack, without a face. A declaration may
/// span lines; it is reported on the line of `font-family:`.
fn fonts(path_rel: &str, text: &str, faces: &BTreeSet<String>, problems: &mut Vec<Problem>) {
    let face_blocks: Vec<std::ops::Range<usize>> =
        FONT_FACE_BLOCK.find_iter(text).map(|m| m.range()).collect();
    for c in FONT_FAMILY.captures_iter(text) {
        let at = c.get(0).map_or(0, |m| m.start());
        if face_blocks.iter().any(|r| r.contains(&at)) {
            continue;
        }
        let first = c[1]
            .split(',')
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches(['"', '\''])
            .to_string();
        let key = first.to_lowercase();
        if first.is_empty()
            || first.starts_with("var(")
            || SYSTEM_FONTS.contains(&key.as_str())
            || faces.contains(&key)
        {
            continue;
        }
        problems.push(Problem {
            path: path_rel.to_string(),
            line: text[..at].matches('\n').count() + 1,
            kind: Kind::FontMissing,
            message: format!(
                "font \"{first}\" has no @font-face in styles.css or the files it imports"
            ),
        });
    }
}

/// Scripts, `on*` attributes, and `href`/`src`/`srcset` URLs and a `style`
/// attribute's `url()`s that leave the system or name no file. Returns the snippet ids (`data-snippet`) with
/// their lines.
fn elements(
    root: &Path,
    path_rel: &str,
    path: &Path,
    text: &str,
    problems: &mut Vec<Problem>,
) -> Vec<(usize, String)> {
    let dir = path.parent().unwrap_or(root);
    let found = std::cell::RefCell::new(Vec::new());
    let snippet_ids = std::cell::RefCell::new(Vec::new());
    let settings =
        lol_html::Settings::new().append_element_content_handler(lol_html::element!("*", |el| {
            let line = line_of(text, el.source_location().bytes().start);
            let tag = el.tag_name();
            let mut found = found.borrow_mut();
            if let Some(id) = el.get_attribute("data-snippet") {
                snippet_ids.borrow_mut().push((line, id));
            }
            if tag == "script" {
                found.push((
                    line,
                    Kind::Script,
                    "<script> is not allowed in a card".to_string(),
                ));
            }
            for a in el.attributes() {
                let (name, value) = (a.name(), a.value());
                if name.starts_with("on") {
                    found.push((
                        line,
                        Kind::Script,
                        format!("{name}=\"…\" is not allowed in a card"),
                    ));
                    continue;
                }
                if name == "style" {
                    // A declaration list: its url()s, never an @import.
                    for r in css_refs(&value).iter().filter(|r| !r.import) {
                        if let Some((kind, message)) = css_problem(root, dir, r) {
                            found.push((line, kind, message));
                        }
                    }
                    continue;
                }
                let urls = match name.as_str() {
                    "href" | "src" => vec![value.as_str()],
                    "srcset" | "imagesrcset" => srcset_urls(&value),
                    _ => continue,
                };
                for url in urls {
                    match target(root, dir, url) {
                        Target::Leaves => found.push((
                            line,
                            Kind::ExternalUrl,
                            format!("{url} leaves the design system"),
                        )),
                        Target::Missing => found.push((
                            line,
                            Kind::Unresolved,
                            format!("<{tag} {name}=\"{url}\"> does not resolve"),
                        )),
                        Target::Script => found.push((
                            line,
                            Kind::Script,
                            "a javascript: URL is not allowed in a card".into(),
                        )),
                        Target::Fine(_) => {}
                    }
                }
            }
            Ok(())
        }));
    if lol_html::rewrite_str(text, settings).is_err() {
        return Vec::new();
    }
    for (line, kind, message) in found.into_inner() {
        problems.push(Problem {
            path: path_rel.to_string(),
            line,
            kind,
            message,
        });
    }
    snippet_ids.into_inner()
}

/// The URLs of a `srcset`: candidates split by commas, each a URL and
/// optional descriptors (`2x`, `480w`). A URL may hold commas (`data:`), so
/// it runs to the next space, as the HTML spec parses it.
fn srcset_urls(value: &str) -> Vec<&str> {
    let mut urls = Vec::new();
    let mut rest = value;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
        if rest.is_empty() {
            return urls;
        }
        let end = rest
            .find(|c: char| c.is_ascii_whitespace())
            .unwrap_or(rest.len());
        let (url, after) = rest.split_at(end);
        let bare = url.trim_end_matches(',');
        urls.push(bare);
        // A URL ending in a comma has no descriptors; otherwise skip them.
        rest = if bare.len() < url.len() {
            after
        } else {
            after.find(',').map_or("", |i| &after[i + 1..])
        };
    }
}

/// Every `.html` file, in a stable order, leaving out `.cache/`.
pub(super) fn html_files(root: &Path) -> Vec<PathBuf> {
    let mut out = files(root);
    out.retain(|p| p.extension().is_some_and(|x| x == "html"));
    out
}

/// Every file, in a stable order, leaving out `.cache/`.
pub(super) fn files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut todo = vec![root.to_path_buf()];
    while let Some(dir) = todo.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            // `file_type` does not follow symlinks: a linked folder is never
            // entered, so a link cannot loop or reach outside the system.
            let Ok(kind) = e.file_type() else { continue };
            let p = e.path();
            if kind.is_dir() {
                if e.file_name() != ".cache" {
                    todo.push(p);
                }
            } else if kind.is_file() {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// `path` relative to `root`, with `/`.
pub(super) fn rel(root: &Path, path: &Path) -> String {
    let p = path.strip_prefix(root).unwrap_or(path);
    p.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
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
                message:
                    "var(--color-selected-2) is not defined in styles.css or the files it imports"
                        .into(),
            }]
        );
    }

    #[test]
    fn a_card_without_a_marker_or_with_a_bad_one_is_reported_on_its_first_line() {
        let dir = system(&[
            ("styles.css", STYLES),
            ("tokens/colors.css", COLORS),
            ("components.css", COMPONENTS),
            (
                "components/buttons/button/button.html",
                "<!doctype html>\n<button class=\"btn\">Run</button>\n",
            ),
            (
                "ui_kits/app/settings.html",
                "<!-- @dsCard group=\"Layouts\" viewport=\"wide\" -->\n<!doctype html>\n",
            ),
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
        let got: Vec<(String, usize, Kind, String)> = check(dir.path())
            .unwrap()
            .into_iter()
            .map(|p| (p.path, p.line, p.kind, p.message))
            .collect();
        let card = "components/buttons/button/button.html".to_string();
        assert_eq!(
            got,
            vec![
                (
                    card.clone(),
                    4,
                    Kind::Unresolved,
                    "<link href=\"../../../missing.css\"> does not resolve".into()
                ),
                (
                    card.clone(),
                    5,
                    Kind::ExternalUrl,
                    "https://example.com/logo.png leaves the design system".into()
                ),
                (
                    card.clone(),
                    6,
                    Kind::Script,
                    "onclick=\"…\" is not allowed in a card".into()
                ),
                (
                    card.clone(),
                    7,
                    Kind::ExternalUrl,
                    "//cdn.example.com/bg.png leaves the design system".into()
                ),
                (
                    card,
                    8,
                    Kind::Script,
                    "<script> is not allowed in a card".into()
                ),
                (
                    "styles.css".into(),
                    2,
                    Kind::Unresolved,
                    "@import \"tokens/missing.css\" does not resolve".into()
                ),
                (
                    "styles.css".into(),
                    3,
                    Kind::ExternalUrl,
                    "https://fonts.example.com/inter.css leaves the design system".into()
                ),
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
    fn a_proposal_waiting_to_be_settled_is_not_live_and_importing_it_is_reported() {
        let card = "<!-- @dsCard group=\"Custom\" -->\n<!doctype html>\n<section class=\"ds-cell\" data-snippet=\"custom/row/default\"><h4>default</h4></section>\n";
        let dir = system(&[
            ("styles.css", STYLES),
            ("tokens/colors.css", COLORS),
            (
                "components.css",
                "@import \"components/custom/row/row.css\";\n@import \"components/custom/row/row.proposed.css\";\n",
            ),
            ("components/custom/row/row.html", card),
            (
                "components/custom/row/row.css",
                ".row { color: var(--color-accent); }\n",
            ),
            ("components/custom/row/row.prompt.md", "A row.\n"),
            ("components/custom/row/row.proposed.html", card),
            (
                "components/custom/row/row.proposed.css",
                ".row { color: var(--color-bg); }\n",
            ),
            (
                "components/custom/row/row.proposed.prompt.md",
                "A row, synced.\n",
            ),
        ]);
        assert_eq!(
            check(dir.path()).unwrap(),
            vec![Problem {
                path: "components.css".into(),
                line: 2,
                kind: Kind::Unresolved,
                message: "@import \"components/custom/row/row.proposed.css\" is a proposal waiting to be settled; import row.css".into(),
            }]
        );
    }

    #[test]
    fn two_cards_in_one_folder_and_a_snippet_id_used_twice_are_reported() {
        let card = |snippet: &str| {
            format!(
                "<!-- @dsCard group=\"Buttons\" -->\n<!doctype html>\n<section class=\"ds-cell\" data-snippet=\"{snippet}\"><h4>primary</h4></section>\n"
            )
        };
        let dir = system(&[
            ("styles.css", STYLES),
            ("tokens/colors.css", COLORS),
            ("components.css", COMPONENTS),
            (
                "components/buttons/button/button.html",
                &card("buttons/button/primary"),
            ),
            (
                "components/buttons/button/button-old.html",
                &card("buttons/button/old"),
            ),
            (
                "components/buttons/button/button.proposed.html",
                &card("buttons/button/primary"),
            ),
            (
                "components/buttons/icon-button/icon-button.html",
                &card("buttons/button/primary"),
            ),
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

    // Review fixes (#340).

    #[test]
    fn a_relative_link_or_import_that_climbs_out_of_the_system_leaves_it_even_when_the_file_exists()
    {
        let outer = tempfile::tempdir().unwrap();
        std::fs::write(outer.path().join("outside.png"), "png").unwrap();
        std::fs::write(outer.path().join("outside.css"), ":root { --x: 1; }\n").unwrap();
        let root = outer.path().join("system");
        for (path, text) in [
            (
                "styles.css",
                "@import \"tokens/colors.css\";\n@import \"../outside.css\";\n",
            ),
            ("tokens/colors.css", COLORS),
            (
                "components/buttons/button/button.html",
                "<!-- @dsCard group=\"Buttons\" -->\n<img src=\"../../../../outside.png\" alt=\"\">\n",
            ),
        ] {
            std::fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
            std::fs::write(root.join(path), text).unwrap();
        }
        let got: Vec<(String, usize, Kind, String)> = check(&root)
            .unwrap()
            .into_iter()
            .map(|p| (p.path, p.line, p.kind, p.message))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    "components/buttons/button/button.html".into(),
                    2,
                    Kind::ExternalUrl,
                    "../../../../outside.png leaves the design system".into()
                ),
                (
                    "styles.css".into(),
                    2,
                    Kind::ExternalUrl,
                    "../outside.css leaves the design system".into()
                ),
            ]
        );
    }

    #[test]
    fn a_local_url_that_names_no_file_and_every_import_on_a_line_are_checked() {
        let dir = system(&[
            (
                "styles.css",
                "@import \"tokens/colors.css\"; @import \"missing.css\";\n@import \"fonts/fonts.css\"; .x { background: url(https://cdn.example.com/bg.png) }\n",
            ),
            ("tokens/colors.css", COLORS),
            (
                "fonts/fonts.css",
                "@font-face {\n  font-family: \"Inter\";\n  src: url(./Missing.woff2);\n}\n",
            ),
        ]);
        let got: Vec<(String, usize, Kind, String)> = check(dir.path())
            .unwrap()
            .into_iter()
            .map(|p| (p.path, p.line, p.kind, p.message))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    "fonts/fonts.css".into(),
                    3,
                    Kind::Unresolved,
                    "url(./Missing.woff2) does not resolve".into()
                ),
                (
                    "styles.css".into(),
                    1,
                    Kind::Unresolved,
                    "@import \"missing.css\" does not resolve".into()
                ),
                (
                    "styles.css".into(),
                    2,
                    Kind::ExternalUrl,
                    "https://cdn.example.com/bg.png leaves the design system".into()
                ),
            ]
        );
    }

    #[test]
    fn any_scheme_but_data_mailto_and_tel_leaves_the_system_and_javascript_urls_are_scripts() {
        let card = "<!-- @dsCard group=\"Buttons\" -->\n\
<img src=\"ftp://host/x.png\" alt=\"\">\n\
<img src=\"data:image/png;base64,AAAA\" alt=\"\">\n\
<a href=\"mailto:team@example.com\">Mail</a> <a href=\"#top\">Top</a>\n\
<a href=\"javascript:go()\">Go</a>\n";
        let dir = system(&[
            ("styles.css", STYLES),
            ("tokens/colors.css", COLORS),
            ("components.css", COMPONENTS),
            ("components/buttons/button/button.html", card),
        ]);
        let got: Vec<(usize, Kind, String)> = check(dir.path())
            .unwrap()
            .into_iter()
            .map(|p| (p.line, p.kind, p.message))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    2,
                    Kind::ExternalUrl,
                    "ftp://host/x.png leaves the design system".into()
                ),
                (
                    5,
                    Kind::Script,
                    "a javascript: URL is not allowed in a card".into()
                ),
            ]
        );
    }

    #[test]
    fn a_font_family_declared_over_two_lines_is_checked() {
        let components = ".kbd {\n  font-family:\n    \"JetBrains Mono\", monospace;\n}\n";
        let dir = system(&[
            ("styles.css", STYLES),
            ("tokens/colors.css", COLORS),
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
    fn an_uppercase_import_or_url_is_checked_like_a_lowercase_one() {
        let dir = system(&[
            (
                "styles.css",
                "@import \"tokens/colors.css\";\n@IMPORT \"https://fonts.example.com/inter.css\";\n.x { background: URL(https://cdn.example.com/bg.png) }\n",
            ),
            ("tokens/colors.css", COLORS),
        ]);
        let got: Vec<(usize, Kind, String)> = check(dir.path())
            .unwrap()
            .into_iter()
            .map(|p| (p.line, p.kind, p.message))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    2,
                    Kind::ExternalUrl,
                    "https://fonts.example.com/inter.css leaves the design system".into()
                ),
                (
                    3,
                    Kind::ExternalUrl,
                    "https://cdn.example.com/bg.png leaves the design system".into()
                ),
            ]
        );
    }

    #[test]
    fn an_import_with_no_space_before_its_url_is_checked() {
        let dir = system(&[
            (
                "styles.css",
                "@import\"tokens/colors.css\";@import'https://fonts.example.com/inter.css';\n",
            ),
            ("tokens/colors.css", COLORS),
        ]);
        assert_eq!(
            check(dir.path()).unwrap(),
            vec![Problem {
                path: "styles.css".into(),
                line: 1,
                kind: Kind::ExternalUrl,
                message: "https://fonts.example.com/inter.css leaves the design system".into(),
            }]
        );
    }

    #[test]
    fn a_quoted_import_or_url_may_hold_spaces() {
        let dir = system(&[
            (
                "styles.css",
                "@import \"tokens/theme light.css\";\n@import 'components.css';\n",
            ),
            ("tokens/theme light.css", COLORS),
            (
                "components.css",
                ".hero { background: url(\"img/hero shot.png\"); color: var(--color-accent); }\n.old { background: url('img/no such.png'); }\n",
            ),
            ("img/hero shot.png", "png"),
        ]);
        assert_eq!(
            check(dir.path()).unwrap(),
            vec![Problem {
                path: "components.css".into(),
                line: 2,
                kind: Kind::Unresolved,
                message: "url(img/no such.png) does not resolve".into(),
            }]
        );
    }

    #[test]
    fn an_import_in_a_cards_style_is_checked_like_one_in_a_stylesheet() {
        let card = "<!-- @dsCard group=\"Buttons\" -->\n\
<!doctype html>\n\
<style>\n\
@import \"../../../components.css\";\n\
@import \"https://example.com/theme.css\";\n\
@import url(button-extra.css);\n\
</style>\n";
        let dir = system(&[
            ("styles.css", STYLES),
            ("tokens/colors.css", COLORS),
            ("components.css", COMPONENTS),
            ("components/buttons/button/button.html", card),
        ]);
        let got: Vec<(usize, Kind, String)> = check(dir.path())
            .unwrap()
            .into_iter()
            .map(|p| (p.line, p.kind, p.message))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    5,
                    Kind::ExternalUrl,
                    "https://example.com/theme.css leaves the design system".into()
                ),
                (
                    6,
                    Kind::Unresolved,
                    "@import \"button-extra.css\" does not resolve".into()
                ),
            ]
        );
    }

    #[test]
    fn each_url_of_a_srcset_is_checked_like_a_src() {
        let card = "<!-- @dsCard group=\"Media\" -->\n\
<img src=\"img/logo.png\" srcset=\"img/logo.png 1x, https://cdn.example.com/logo@2x.png 2x\" alt=\"\">\n\
<picture><source srcset=\"img/missing.webp 480w,img/logo.png 960w\"></picture>\n\
<link rel=\"preload\" as=\"image\" imagesrcset=\"//cdn.example.com/hero.png 1x\">\n";
        let dir = system(&[
            ("styles.css", STYLES),
            ("tokens/colors.css", COLORS),
            ("components.css", COMPONENTS),
            ("components/media/logo/logo.html", card),
            ("components/media/logo/img/logo.png", "png"),
        ]);
        let got: Vec<(usize, Kind, String)> = check(dir.path())
            .unwrap()
            .into_iter()
            .map(|p| (p.line, p.kind, p.message))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    2,
                    Kind::ExternalUrl,
                    "https://cdn.example.com/logo@2x.png leaves the design system".into()
                ),
                (
                    3,
                    Kind::Unresolved,
                    "<source srcset=\"img/missing.webp\"> does not resolve".into()
                ),
                (
                    4,
                    Kind::ExternalUrl,
                    "//cdn.example.com/hero.png leaves the design system".into()
                ),
            ]
        );
    }

    #[test]
    fn an_import_or_url_in_a_css_comment_is_not_checked_nor_followed() {
        let styles = "@import \"tokens/colors.css\";\n\
/* @import \"old.css\";\n\
   @import \"https://fonts.example.com/inter.css\"; */\n\
@import \"components.css\";\n";
        let components = ".session-row {\n\
  background: var(--color-bg); /* url(removed.png) */\n\
  /* was: background: URL(https://cdn.example.com/bg.png)\n\
  */ border-image: url(missing.png);\n\
}\n\
.quote::before { content: \"/*\"; background: url(https://cdn.example.com/q.png); content: \"*/\"; }\n";
        // Only a <style> holds CSS comments: elsewhere in a card `/*` is text.
        let card = "<!-- @dsCard group=\"Buttons\" -->\n\
<style>\n\
/* @import \"https://example.com/theme.css\"; */\n\
</style>\n\
<p>/*</p><div style=\"background: url(https://cdn.example.com/bg.png)\"></div><p>*/</p>\n";
        let dir = system(&[
            ("styles.css", styles),
            ("tokens/colors.css", COLORS),
            (
                "old.css",
                ".old { background: url(https://cdn.example.com/old.png) }\n",
            ),
            ("components.css", components),
            ("components/buttons/button/button.html", card),
        ]);
        let got: Vec<(String, usize, Kind, String)> = check(dir.path())
            .unwrap()
            .into_iter()
            .map(|p| (p.path, p.line, p.kind, p.message))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    "components.css".into(),
                    4,
                    Kind::Unresolved,
                    "url(missing.png) does not resolve".into()
                ),
                // A `/*` in a string opens no comment.
                (
                    "components.css".into(),
                    6,
                    Kind::ExternalUrl,
                    "https://cdn.example.com/q.png leaves the design system".into()
                ),
                (
                    "components/buttons/button/button.html".into(),
                    5,
                    Kind::ExternalUrl,
                    "https://cdn.example.com/bg.png leaves the design system".into()
                ),
            ]
        );
    }

    #[test]
    fn an_import_whose_url_is_on_the_next_line_of_a_stylesheet_is_checked() {
        let styles = "@import \"tokens/colors.css\";\n\
@import\n\
  \"https://fonts.example.com/inter.css\";\n\
@import url(\n\
  missing.css);\n";
        let dir = system(&[("styles.css", styles), ("tokens/colors.css", COLORS)]);
        let got: Vec<(String, usize, Kind, String)> = check(dir.path())
            .unwrap()
            .into_iter()
            .map(|p| (p.path, p.line, p.kind, p.message))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    "styles.css".into(),
                    2,
                    Kind::ExternalUrl,
                    "https://fonts.example.com/inter.css leaves the design system".into()
                ),
                (
                    "styles.css".into(),
                    4,
                    Kind::Unresolved,
                    "@import \"missing.css\" does not resolve".into()
                ),
            ]
        );
    }

    #[test]
    fn an_import_whose_url_is_on_the_next_line_of_a_cards_style_is_checked() {
        let card = "<!-- @dsCard group=\"Buttons\" -->\n\
<!doctype html>\n\
<style>\n\
@import\n\
  \"https://example.com/theme.css\";\n\
</style>\n";
        let dir = system(&[
            ("styles.css", STYLES),
            ("tokens/colors.css", COLORS),
            ("components.css", COMPONENTS),
            ("components/buttons/button/button.html", card),
        ]);
        assert_eq!(
            check(dir.path()).unwrap(),
            vec![Problem {
                path: "components/buttons/button/button.html".into(),
                line: 4,
                kind: Kind::ExternalUrl,
                message: "https://example.com/theme.css leaves the design system".into(),
            }]
        );
    }

    #[test]
    fn an_import_written_in_a_cards_text_and_not_its_style_is_not_checked() {
        let card = "<!-- @dsCard group=\"Buttons\" -->\n\
<!doctype html>\n\
<pre>@import \"https://example.com/theme.css\";</pre>\n\
<p>Put @import url(missing.css); at the top of a stylesheet.</p>\n";
        let dir = system(&[
            ("styles.css", STYLES),
            ("tokens/colors.css", COLORS),
            ("components.css", COMPONENTS),
            ("components/buttons/button/button.html", card),
        ]);
        assert_eq!(check(dir.path()).unwrap(), vec![]);
    }

    #[test]
    fn a_system_without_styles_css_is_reported() {
        let dir = system(&[("tokens/colors.css", COLORS)]);
        assert_eq!(
            check(dir.path()).unwrap(),
            vec![Problem {
                path: "styles.css".into(),
                line: 1,
                kind: Kind::Unresolved,
                message: "styles.css is missing".into()
            }]
        );
    }
}
