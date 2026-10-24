//! The Foundations cards (X64): Colours, Type, Spacing, and Radius and shadow,
//! written from the tokens with no agent involved. design-sync makes none;
//! static HTML makes them cheap.

use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;

use super::tokens::{self, Family, Token};

/// Each foundation card the tokens call for, as (path, HTML). A family with no
/// tokens gets no card.
pub fn cards(tokens: &[Token]) -> Vec<(String, String)> {
    let of = |f: Family| tokens.iter().filter(move |t| t.family == f);
    let mut out = Vec::new();
    let colours: Vec<String> = of(Family::Color)
        .map(|t| {
            cell(
                &format!(
                    "<div class=\"ds-swatch\" style=\"background: var({})\"></div>",
                    t.name
                ),
                t,
            )
        })
        .collect();
    push(&mut out, "colours", "Colours", colours);
    let type_cells: Vec<String> = of(Family::Typography)
        .map(|t| {
            let property = if t.name.contains("leading") || t.name.contains("line-height") {
                "line-height"
            } else if t.name.contains("tracking") || t.name.contains("letter") {
                "letter-spacing"
            } else if t.name.contains("weight") {
                "font-weight"
            } else if LENGTH.is_match(&t.value) {
                "font-size"
            } else {
                "font-family"
            };
            cell(
                &format!("<div style=\"{property}: var({})\">{SAMPLE}</div>", t.name),
                t,
            )
        })
        .collect();
    push(&mut out, "type", "Type", type_cells);
    let spacing: Vec<String> = of(Family::Spacing)
        .map(|t| {
            cell(
                &format!(
                    "<div class=\"ds-bar\" style=\"width: var({})\"></div>",
                    t.name
                ),
                t,
            )
        })
        .collect();
    push(&mut out, "spacing", "Spacing", spacing);
    let shapes: Vec<String> = tokens
        .iter()
        .filter_map(|t| {
            let property = match t.family {
                Family::Radius => "border-radius",
                Family::Shadow => "box-shadow",
                _ => return None,
            };
            Some(cell(
                &format!(
                    "<div class=\"ds-box\" style=\"{property}: var({})\"></div>",
                    t.name
                ),
                t,
            ))
        })
        .collect();
    push(&mut out, "radius-and-shadow", "Radius and shadow", shapes);
    out
}

/// Writes the foundation cards for the tokens in `root`, and removes those
/// of families that no longer have tokens.
/// Folders under `foundations/` that are not moonlet's are left alone.
pub fn write(root: &Path) -> Result<()> {
    let cards = cards(&tokens::read(root));
    for slug in SLUGS {
        let path = format!("foundations/{slug}/{slug}.html");
        match cards.iter().find(|(p, _)| *p == path) {
            Some((_, html)) => {
                let file = root.join(&path);
                std::fs::create_dir_all(file.parent().unwrap_or(root))?;
                std::fs::write(file, html)?;
            }
            None => {
                let dir = root.join("foundations").join(slug);
                if dir.is_dir() {
                    std::fs::remove_dir_all(dir)?;
                }
            }
        }
    }
    Ok(())
}

/// The folders of moonlet's foundation cards.
const SLUGS: [&str; 4] = ["colours", "type", "spacing", "radius-and-shadow"];

/// What type samples say.
const SAMPLE: &str = "Add search to the product list";
static LENGTH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-?[0-9.]+(px|rem|em|pt|%)$").unwrap());

fn push(out: &mut Vec<(String, String)>, slug: &str, name: &str, cells: Vec<String>) {
    if cells.is_empty() {
        return;
    }
    let html = format!(
        "<!-- @dsCard group=\"Foundations\" name=\"{name}\" -->\n<!doctype html>\n\
<html><head><meta charset=\"utf-8\"><link rel=\"stylesheet\" href=\"../../styles.css\">\n\
<style>{CSS}</style></head>\n<body><div class=\"ds-grid\">\n{}</div></body></html>\n",
        cells.concat()
    );
    out.push((format!("foundations/{slug}/{slug}.html"), html));
}

/// One labelled example: what it shows, the token's name and its value.
fn cell(example: &str, t: &Token) -> String {
    format!(
        "<section class=\"ds-cell\">{example}<h4>{}</h4><p>{}</p></section>\n",
        t.name,
        escape(&t.value)
    )
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

const CSS: &str = "body{margin:0;padding:24px}\
.ds-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:20px;align-items:start}\
.ds-cell h4{margin:8px 0 2px;font:600 12px system-ui}\
.ds-cell p{margin:0;font:12px ui-monospace,monospace;opacity:.7}\
.ds-swatch{height:48px;border-radius:8px;border:1px solid rgb(127 127 127 / .3)}\
.ds-box{width:96px;height:64px;border:1px solid rgb(127 127 127 / .3)}\
.ds-bar{height:12px;background:currentColor;border-radius:2px}";

#[cfg(test)]
mod tests {
    use super::*;

    fn token(name: &str, value: &str, family: Family) -> Token {
        Token {
            name: name.into(),
            value: value.into(),
            family,
        }
    }

    #[test]
    fn the_colours_card_shows_a_swatch_per_colour_token() {
        let tokens = [
            token("--color-bg", "#0b0c0e", Family::Color),
            token("--color-accent", "#e8774f", Family::Color),
            token("--z-menu", "40", Family::Other),
        ];
        assert_eq!(
            cards(&tokens),
            vec![(
                "foundations/colours/colours.html".to_string(),
                "<!-- @dsCard group=\"Foundations\" name=\"Colours\" -->
<!doctype html>
<html><head><meta charset=\"utf-8\"><link rel=\"stylesheet\" href=\"../../styles.css\">
<style>body{margin:0;padding:24px}.ds-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:20px;align-items:start}.ds-cell h4{margin:8px 0 2px;font:600 12px system-ui}.ds-cell p{margin:0;font:12px ui-monospace,monospace;opacity:.7}.ds-swatch{height:48px;border-radius:8px;border:1px solid rgb(127 127 127 / .3)}.ds-box{width:96px;height:64px;border:1px solid rgb(127 127 127 / .3)}.ds-bar{height:12px;background:currentColor;border-radius:2px}</style></head>
<body><div class=\"ds-grid\">
<section class=\"ds-cell\"><div class=\"ds-swatch\" style=\"background: var(--color-bg)\"></div><h4>--color-bg</h4><p>#0b0c0e</p></section>
<section class=\"ds-cell\"><div class=\"ds-swatch\" style=\"background: var(--color-accent)\"></div><h4>--color-accent</h4><p>#e8774f</p></section>
</div></body></html>
"
                .to_string(),
            )]
        );
    }

    #[test]
    fn type_spacing_and_radius_and_shadow_cards_show_each_token_in_use() {
        let tokens = [
            token("--text-lg", "15px", Family::Typography),
            token(
                "--font-mono",
                "\"JetBrains Mono\", ui-monospace",
                Family::Typography,
            ),
            token("--leading-tight", "1.2", Family::Typography),
            token("--space-4", "16px", Family::Spacing),
            token("--radius-xl", "12px", Family::Radius),
            token(
                "--shadow-card",
                "0 1px 3px rgb(0 0 0 / 0.3)",
                Family::Shadow,
            ),
        ];
        let got = cards(&tokens);
        let paths: Vec<&str> = got.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            paths,
            [
                "foundations/type/type.html",
                "foundations/spacing/spacing.html",
                "foundations/radius-and-shadow/radius-and-shadow.html"
            ]
        );
        let has =
            |i: usize, cell: &str| assert!(got[i].1.contains(cell), "{} lacks {cell}", got[i].0);
        has(0, "<!-- @dsCard group=\"Foundations\" name=\"Type\" -->\n");
        has(
            0,
            "<section class=\"ds-cell\"><div style=\"font-size: var(--text-lg)\">Add search to the product list</div><h4>--text-lg</h4><p>15px</p></section>\n",
        );
        has(
            0,
            "<section class=\"ds-cell\"><div style=\"font-family: var(--font-mono)\">Add search to the product list</div><h4>--font-mono</h4><p>\"JetBrains Mono\", ui-monospace</p></section>\n",
        );
        has(
            0,
            "<section class=\"ds-cell\"><div style=\"line-height: var(--leading-tight)\">Add search to the product list</div><h4>--leading-tight</h4><p>1.2</p></section>\n",
        );
        has(
            1,
            "<!-- @dsCard group=\"Foundations\" name=\"Spacing\" -->\n",
        );
        has(
            1,
            "<section class=\"ds-cell\"><div class=\"ds-bar\" style=\"width: var(--space-4)\"></div><h4>--space-4</h4><p>16px</p></section>\n",
        );
        has(
            2,
            "<!-- @dsCard group=\"Foundations\" name=\"Radius and shadow\" -->\n",
        );
        has(
            2,
            "<section class=\"ds-cell\"><div class=\"ds-box\" style=\"border-radius: var(--radius-xl)\"></div><h4>--radius-xl</h4><p>12px</p></section>\n",
        );
        has(
            2,
            "<section class=\"ds-cell\"><div class=\"ds-box\" style=\"box-shadow: var(--shadow-card)\"></div><h4>--shadow-card</h4><p>0 1px 3px rgb(0 0 0 / 0.3)</p></section>\n",
        );
    }

    #[test]
    fn writing_the_cards_replaces_those_of_families_that_are_gone_and_passes_the_check() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for (path, text) in [
            ("styles.css", "@import \"tokens/colors.css\";\n"),
            ("tokens/colors.css", ":root {\n  --color-bg: #0b0c0e;\n}\n"),
            (
                "foundations/spacing/spacing.html",
                "<!-- @dsCard group=\"Foundations\" name=\"Spacing\" -->\n",
            ),
        ] {
            std::fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
            std::fs::write(root.join(path), text).unwrap();
        }
        write(root).unwrap();
        assert!(root.join("foundations/colours/colours.html").is_file());
        assert!(!root.join("foundations/spacing").exists());
        assert_eq!(super::super::check::check(root).unwrap(), vec![]);
    }

    #[test]
    fn a_font_weight_token_shows_as_a_weight() {
        let got = cards(&[token("--font-weight-bold", "700", Family::Typography)]);
        assert!(got[0].1.contains(
            "<section class=\"ds-cell\"><div style=\"font-weight: var(--font-weight-bold)\">Add search to the product list</div><h4>--font-weight-bold</h4><p>700</p></section>\n"
        ));
    }

    #[test]
    fn a_colour_alias_gets_a_swatch_on_the_written_colours_card() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for (path, text) in [
            ("styles.css", "@import \"tokens/colors.css\";\n"),
            (
                "tokens/colors.css",
                ":root {\n  --color-accent: #e8774f;\n  --accent: var(--color-accent);\n}\n",
            ),
        ] {
            std::fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
            std::fs::write(root.join(path), text).unwrap();
        }
        write(root).unwrap();
        let html = std::fs::read_to_string(root.join("foundations/colours/colours.html")).unwrap();
        assert!(html.contains(
            "<section class=\"ds-cell\"><div class=\"ds-swatch\" style=\"background: var(--accent)\"></div><h4>--accent</h4><p>var(--color-accent)</p></section>\n"
        ));
    }
}
