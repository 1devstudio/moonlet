//! `data-mid`, the id every element of a design page carries, so comments and
//! edits by hand can point at it (X65). `moonlet design check` reports missing
//! and repeated ids; `--fix` adds and renumbers them, leaving the rest of the
//! file as it was.

use super::check::{Kind, Problem};

use std::cell::RefCell;
use std::collections::HashSet;

/// Elements that never carry an id: they draw nothing of their own, or are
/// the inside of an `<svg>` (the `<svg>` itself carries one).
const SKIPPED: [&str; 20] = [
    "script",
    "style",
    "template",
    "noscript",
    "path",
    "g",
    "circle",
    "rect",
    "line",
    "polyline",
    "polygon",
    "ellipse",
    "defs",
    "use",
    "symbol",
    "lineargradient",
    "radialgradient",
    "stop",
    "clippath",
    "mask",
];

/// One element of the page's body that should carry a `data-mid`.
struct Seen {
    line: usize,
    tag: String,
    mid: Option<String>,
}

/// Visits every element of the body that should carry an id, in document
/// order, letting `f` set its id; returns the page as rewritten.
fn walk(html: &str, mut f: impl FnMut(&Seen) -> Option<String>) -> (String, Vec<Seen>) {
    let seen = RefCell::new(Vec::new());
    let line_of = |byte: usize| html[..byte.min(html.len())].matches('\n').count() + 1;
    let settings = lol_html::Settings::new().append_element_content_handler(lol_html::element!(
        "body *",
        |el| {
            let tag = el.tag_name();
            if SKIPPED.contains(&tag.as_str()) {
                return Ok(());
            }
            let s = Seen {
                line: line_of(el.source_location().bytes().start),
                tag,
                mid: el.get_attribute("data-mid"),
            };
            if let Some(id) = f(&s) {
                el.set_attribute("data-mid", &id)?;
            }
            seen.borrow_mut().push(s);
            Ok(())
        }
    ));
    let out = lol_html::rewrite_str(html, settings).unwrap_or_else(|_| html.to_string());
    (out, seen.into_inner())
}

/// Gives every element of the body that lacks an id, or repeats an earlier
/// one, the next free `m<n>` in document order. Nothing else changes.
pub fn fix_page(html: &str) -> String {
    let (_, seen) = walk(html, |_| None);
    let mut next = seen
        .iter()
        .filter_map(|s| number(s.mid.as_deref()?))
        .max()
        .unwrap_or(0)
        + 1;
    let mut ids = HashSet::new();
    walk(html, |s| match &s.mid {
        Some(id) if ids.insert(id.clone()) => None,
        _ => {
            let id = format!("m{next}");
            next += 1;
            ids.insert(id.clone());
            Some(id)
        }
    })
    .0
}

/// `7` for `m7`.
fn number(id: &str) -> Option<u64> {
    id.strip_prefix('m')?.parse().ok()
}

/// Missing and repeated `data-mid`s in a design page.
pub fn check_page(path_rel: &str, html: &str) -> Vec<Problem> {
    let mut ids = HashSet::new();
    let (_, seen) = walk(html, |_| None);
    let mut problems = Vec::new();
    for s in seen {
        let (kind, message) = match &s.mid {
            None => (Kind::MissingMid, format!("<{}> has no data-mid", s.tag)),
            Some(id) if !ids.insert(id.clone()) => (
                Kind::DuplicateMid,
                format!("<{}> repeats data-mid=\"{id}\"", s.tag),
            ),
            Some(_) => continue,
        };
        problems.push(Problem {
            path: path_rel.to_string(),
            line: s.line,
            kind,
            message,
        });
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "<!doctype html>
<html><head><title>Settings</title><style>body { margin: 0 }</style></head>
<body>
<main data-mid=\"m1\">
  <h1 data-mid=\"m2\">Settings</h1>
  <section data-mid=\"m2\"><p>Git</p></section>
  <svg data-mid=\"m4\" viewBox=\"0 0 8 8\"><path d=\"M0 0h8\"/></svg>
</main>
</body></html>
";

    #[test]
    fn elements_in_the_body_without_an_id_or_with_a_repeated_one_are_reported() {
        let got: Vec<(usize, Kind, String)> = check_page("pages/index.html", PAGE)
            .into_iter()
            .map(|p| (p.line, p.kind, p.message))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    6,
                    Kind::DuplicateMid,
                    "<section> repeats data-mid=\"m2\"".into()
                ),
                (6, Kind::MissingMid, "<p> has no data-mid".into()),
            ]
        );
    }

    #[test]
    fn fix_gives_missing_and_repeated_ids_the_next_free_numbers_and_leaves_the_rest() {
        let fixed = fix_page(PAGE);
        assert_eq!(
            fixed,
            "<!doctype html>
<html><head><title>Settings</title><style>body { margin: 0 }</style></head>
<body>
<main data-mid=\"m1\">
  <h1 data-mid=\"m2\">Settings</h1>
  <section data-mid=\"m5\"><p data-mid=\"m6\">Git</p></section>
  <svg data-mid=\"m4\" viewBox=\"0 0 8 8\"><path d=\"M0 0h8\"/></svg>
</main>
</body></html>
"
        );
        assert_eq!(check_page("pages/index.html", &fixed), vec![]);
    }
}
