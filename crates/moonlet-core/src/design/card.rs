//! A card's first line, `<!-- @dsCard group="…" … -->` (X64). design-sync's
//! grammar needs only `group`; moonlet adds `name`, `source` and `viewport`.

use std::sync::LazyLock;

use regex::Regex;

/// What a card's marker says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Marker {
    pub group: String,
    pub name: Option<String>,
    /// Source files, relative to the source project.
    pub source: Vec<String>,
    /// Width and height; 900×700 when the marker names none.
    pub viewport: (u32, u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkerError {
    /// The first line is not an `@dsCard` comment.
    Missing,
    /// It is one, but `group` or `viewport` is wrong.
    Malformed(String),
}

/// The viewport of a card whose marker names none, as design-sync captures.
pub const DEFAULT_VIEWPORT: (u32, u32) = (900, 700);

static COMMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<!--\s*@dsCard\s+(.*?)\s*-->(.*)$").unwrap());
/// Only `name="value"` pairs, separated by spaces.
static ATTRS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^[A-Za-z-]+="[^"]*"(\s+[A-Za-z-]+="[^"]*")*$"#).unwrap());
static ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"([A-Za-z-]+)="([^"]*)""#).unwrap());

/// Reads the marker on the card's first line. As in design-sync, `group` comes
/// first; the other attributes may follow in any order.
pub fn parse_marker(html: &str) -> Result<Marker, MarkerError> {
    let first = html.lines().next().unwrap_or("");
    let c = COMMENT.captures(first).ok_or(MarkerError::Missing)?;
    if !c[2].trim().is_empty() {
        return Err(MarkerError::Malformed(
            "the marker must be the whole first line".into(),
        ));
    }
    let attrs = c.get(1).map_or("", |m| m.as_str());
    if !attrs.starts_with("group=\"") {
        return Err(MarkerError::Malformed("group=\"…\" must come first".into()));
    }
    if !ATTRS.is_match(attrs) {
        return Err(MarkerError::Malformed(
            "attributes must be name=\"value\"".into(),
        ));
    }
    let mut pairs = ATTR
        .captures_iter(attrs)
        .map(|c| (c[1].to_string(), c[2].to_string()));
    let group = match pairs.next() {
        Some((k, v)) if k == "group" && !v.trim().is_empty() => v,
        _ => return Err(MarkerError::Malformed("group=\"…\" must come first".into())),
    };
    let mut marker = Marker {
        group,
        name: None,
        source: Vec::new(),
        viewport: DEFAULT_VIEWPORT,
    };
    for (k, v) in pairs {
        match k.as_str() {
            "name" => marker.name = Some(v),
            "source" => {
                marker.source = v
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect();
                // Sources are read from the projects: never from outside them.
                if let Some(bad) = marker.source.iter().find(|s| {
                    s.starts_with('/')
                        || std::path::Path::new(s).components().any(|c| {
                            !matches!(
                                c,
                                std::path::Component::Normal(_) | std::path::Component::CurDir
                            )
                        })
                }) {
                    return Err(MarkerError::Malformed(format!(
                        "source \"{bad}\" must be a path inside the project"
                    )));
                }
            }
            "viewport" => {
                marker.viewport = parse_viewport(&v)
                    .ok_or_else(|| MarkerError::Malformed(format!("viewport \"{v}\" is not WxH")))?
            }
            _ => {}
        }
    }
    Ok(marker)
}

/// The card's snippet ids (`data-snippet`), in document order.
pub fn snippets(html: &str) -> Vec<String> {
    let ids = std::cell::RefCell::new(Vec::new());
    let settings = lol_html::Settings::new().append_element_content_handler(lol_html::element!(
        "[data-snippet]",
        |el| {
            if let Some(id) = el.get_attribute("data-snippet") {
                ids.borrow_mut().push(id);
            }
            Ok(())
        }
    ));
    let _ = lol_html::rewrite_str(html, settings);
    ids.into_inner()
}

fn parse_viewport(v: &str) -> Option<(u32, u32)> {
    let (w, h) = v.split_once('x')?;
    Some((
        w.parse().ok().filter(|w| *w > 0)?,
        h.parse().ok().filter(|h| *h > 0)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_moonlet_card_marker_names_its_group_name_sources_and_viewport() {
        let html = "<!-- @dsCard group=\"Custom\" name=\"Session row\" source=\"apps/desktop/src/components/Sidebar.tsx\" viewport=\"320x140\" -->\n<!doctype html>\n<html></html>\n";
        assert_eq!(
            parse_marker(html),
            Ok(Marker {
                group: "Custom".into(),
                name: Some("Session row".into()),
                source: vec!["apps/desktop/src/components/Sidebar.tsx".into()],
                viewport: (320, 140),
            })
        );
    }

    #[test]
    fn a_design_sync_marker_with_only_a_group_takes_the_default_viewport() {
        assert_eq!(
            parse_marker("<!-- @dsCard group=\"actions\" -->\n<!doctype html>"),
            Ok(Marker {
                group: "actions".into(),
                name: None,
                source: vec![],
                viewport: (900, 700)
            })
        );
        assert_eq!(
            parse_marker("<!-- @dsCard group=\"Buttons\" source=\"src/ui.tsx, src/icon.tsx\" -->")
                .unwrap()
                .source,
            vec!["src/ui.tsx".to_string(), "src/icon.tsx".to_string()]
        );
    }

    #[test]
    fn a_marker_not_on_the_first_line_or_without_a_leading_group_is_rejected() {
        assert_eq!(
            parse_marker("<!doctype html>\n<!-- @dsCard group=\"x\" -->"),
            Err(MarkerError::Missing)
        );
        assert_eq!(
            parse_marker("<!-- @dsCard name=\"Button\" group=\"Buttons\" -->"),
            Err(MarkerError::Malformed("group=\"…\" must come first".into()))
        );
        assert_eq!(
            parse_marker("<!-- @dsCard group=\"Buttons\" viewport=\"wide\" -->"),
            Err(MarkerError::Malformed(
                "viewport \"wide\" is not WxH".into()
            ))
        );
    }

    #[test]
    fn a_marker_with_stray_text_is_malformed() {
        assert_eq!(
            parse_marker("<!-- @dsCard junk group=\"Buttons\" -->\n"),
            Err(MarkerError::Malformed("group=\"…\" must come first".into()))
        );
        assert_eq!(
            parse_marker("<!-- @dsCard group=\"Buttons\" name=Button -->\n"),
            Err(MarkerError::Malformed(
                "attributes must be name=\"value\"".into()
            ))
        );
        assert_eq!(
            parse_marker("<!-- @dsCard group=\"Buttons\" --><p>after</p>\n"),
            Err(MarkerError::Malformed(
                "the marker must be the whole first line".into()
            ))
        );
    }

    #[test]
    fn a_source_outside_the_project_is_malformed() {
        for source in ["../secrets.txt", "/etc/passwd", "src/../../x.tsx"] {
            assert_eq!(
                parse_marker(&format!(
                    "<!-- @dsCard group=\"Buttons\" source=\"{source}\" -->\n"
                )),
                Err(MarkerError::Malformed(format!(
                    "source \"{source}\" must be a path inside the project"
                )))
            );
        }
    }
}
