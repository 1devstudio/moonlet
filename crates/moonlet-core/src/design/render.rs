//! The render check and snapshots of a design system's cards (X64, ADR
//! 0013). The moonlet app renders each card in its sandboxed canvas and
//! judges it with design-sync's rubric; this module keeps what it found in
//! the system's `.cache/`: `render-check.json`, and the screenshots.

use std::path::PathBuf;

use anyhow::{Result, bail};
use moonlet_proto::methods::RenderMetrics;
use serde::{Deserialize, Serialize};

use super::store::Store;
use super::{card, check, fsx};

/// What `--render` and `snap` say when no moonlet app is there to render.
pub const NO_APP: &str = "Open moonlet to render cards";

/// A screenshot smaller than this is `blank`, as in design-sync.
pub const BLANK_BELOW: usize = 5 * 1024;

/// Where the render check's results go, in the system's folder.
pub const REPORT: &str = ".cache/render-check.json";

/// One card as the app rendered it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderResult {
    /// Relative to the design system's folder.
    pub path: String,
    /// The rubric's flags it raised (`rootEmpty`, `errs`, …, `thin`, `bad`).
    pub flags: Vec<String>,
    /// Its page errors.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
    /// Why it could not be rendered; such a card is `bad`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RenderResult {
    /// The card at `path` as the app judged it, or, when the app could not
    /// render it, `bad` with why.
    pub fn new(path: String, answer: Result<RenderMetrics, String>) -> Self {
        match answer {
            Ok(m) => RenderResult {
                path,
                flags: m.flags,
                errors: m.errors,
                error: None,
            },
            Err(why) => RenderResult {
                path,
                flags: vec!["bad".into()],
                errors: Vec::new(),
                error: Some(why),
            },
        }
    }
}

/// The counts `design check --render` prints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderCounts {
    pub total: usize,
    pub bad: usize,
    pub thin: usize,
    pub variants_identical: usize,
}

/// A card the render check loads: its path in the system and its viewport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderJob {
    pub path: String,
    pub viewport: (u32, u32),
}

/// A card to snap: its path in the system, the viewport, and the snippet
/// shown alone, by its full id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapTarget {
    pub path: String,
    pub viewport: (u32, u32),
    pub variant: Option<String>,
}

#[derive(Serialize)]
struct Report<'a> {
    #[serde(flatten)]
    counts: RenderCounts,
    cards: &'a [RenderResult],
}

/// The counts of `cards`.
pub fn counts(cards: &[RenderResult]) -> RenderCounts {
    let has = |c: &RenderResult, f: &str| c.flags.iter().any(|x| x == f);
    RenderCounts {
        total: cards.len(),
        bad: cards.iter().filter(|c| has(c, "bad")).count(),
        thin: cards.iter().filter(|c| has(c, "thin")).count(),
        variants_identical: cards.iter().filter(|c| has(c, "variantsIdentical")).count(),
    }
}

/// The screenshot's file name: `<card>[--<variant>]-<w>x<h>.png`.
pub fn screenshot_name(target: &SnapTarget) -> String {
    let stem = target
        .path
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .trim_end_matches(".html");
    let variant = target
        .variant
        .as_deref()
        .map(|v| format!("--{}", v.rsplit('/').next().unwrap_or(v)))
        .unwrap_or_default();
    let (w, h) = target.viewport;
    format!("{stem}{variant}-{w}x{h}.png")
}

/// A card's path in a system: `components/<group>/<name>/<name>.html`,
/// `foundations/<name>/<name>.html` or `ui_kits/<kit>/<screen>.html`, with
/// no empty, `.` or `..` part, and not a proposal.
fn is_card_path(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    let shape = match parts.first() {
        Some(&"components") => parts.len() == 4,
        Some(&"foundations" | &"ui_kits") => parts.len() == 3,
        _ => false,
    };
    shape
        && parts
            .iter()
            .all(|p| !p.is_empty() && *p != "." && *p != ".." && !p.contains('\\'))
        && path.ends_with(".html")
        && !path.ends_with(".proposed.html")
}

impl Store {
    /// The cards the render check loads: every card of the system, a
    /// proposal waiting to be settled left out, with the viewport its
    /// marker names (900×700 without one).
    pub fn render_cards(&self, workspace: &str, slug: &str) -> Result<Vec<RenderJob>> {
        let dir = self.system_dir(workspace, slug)?;
        let mut out = Vec::new();
        for file in check::html_files(&dir) {
            let path = check::rel(&dir, &file);
            if !is_card_path(&path) {
                continue;
            }
            let text = fsx::read_inside(&dir, &file)?;
            let viewport = card::parse_marker(&text).map_or(card::DEFAULT_VIEWPORT, |m| m.viewport);
            out.push(RenderJob { path, viewport });
        }
        Ok(out)
    }

    /// The card `path` of the system to snap, at `viewport` (else its
    /// marker's), showing only the snippet `variant` names: its full id, or
    /// the last part of it.
    pub fn snap_target(
        &self,
        workspace: &str,
        slug: &str,
        path: &str,
        variant: Option<&str>,
        viewport: Option<(u32, u32)>,
    ) -> Result<SnapTarget> {
        let dir = self.system_dir(workspace, slug)?;
        if !is_card_path(path) {
            bail!("{path} is not a card of {slug}");
        }
        // Through a handle opened from the system's folder: never a file
        // a link points to outside it.
        let text = fsx::read_inside(&dir, &dir.join(path))?;
        let variant = match variant {
            None => None,
            Some(v) => {
                let snippets = card::snippets(&text);
                let found = snippets
                    .iter()
                    .find(|s| s.as_str() == v || s.rsplit('/').next() == Some(v));
                match found {
                    Some(s) => Some(s.clone()),
                    None => bail!("{path} has no variant \"{v}\""),
                }
            }
        };
        let viewport = viewport.unwrap_or_else(|| {
            card::parse_marker(&text).map_or(card::DEFAULT_VIEWPORT, |m| m.viewport)
        });
        Ok(SnapTarget {
            path: path.to_string(),
            viewport,
            variant,
        })
    }

    /// Writes `.cache/render-check.json`: the counts, then each card with
    /// the flags it raised. Returns the counts.
    pub fn write_render_check(
        &self,
        workspace: &str,
        slug: &str,
        cards: &[RenderResult],
    ) -> Result<RenderCounts> {
        let dir = self.system_dir(workspace, slug)?;
        let counts = counts(cards);
        let mut json = serde_json::to_string_pretty(&Report { counts, cards })?;
        json.push('\n');
        fsx::write_inside(&dir, &dir.join(REPORT), json.as_bytes())?;
        Ok(counts)
    }

    /// Saves a card's screenshot in `.cache/screenshots/` and returns its path.
    pub fn write_screenshot(
        &self,
        workspace: &str,
        slug: &str,
        target: &SnapTarget,
        png: &[u8],
    ) -> Result<PathBuf> {
        let dir = self.system_dir(workspace, slug)?;
        let path = dir.join(".cache/screenshots").join(screenshot_name(target));
        fsx::write_inside(&dir, &path, png)?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design::store::Cover;

    fn put(dir: &std::path::Path, files: &[(&str, &str)]) {
        for (path, text) in files {
            let p = dir.join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
    }

    fn card(path: &str, flags: &[&str]) -> RenderResult {
        RenderResult {
            path: path.into(),
            flags: flags.iter().map(|f| f.to_string()).collect(),
            errors: Vec::new(),
            error: None,
        }
    }

    #[test]
    fn the_render_check_writes_each_cards_flags_and_the_counts() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        let mut field = card("components/forms/field/field.html", &["errs", "bad"]);
        field.errors = vec!["link did not load: ../../../missing.css".into()];
        let mut menu = card("components/menus/menu/menu.html", &["bad"]);
        menu.error = Some("the card did not finish loading in 15 s".into());
        let cards = vec![
            card("components/buttons/button/button.html", &[]),
            field,
            menu,
            card(
                "components/forms/select/select.html",
                &["nameOnly", "variantsIdentical", "thin"],
            ),
        ];
        assert_eq!(
            store.write_render_check("w1", &slug, &cards).unwrap(),
            RenderCounts {
                total: 4,
                bad: 2,
                thin: 1,
                variants_identical: 1
            }
        );
        assert_eq!(
            std::fs::read_to_string(
                home.path()
                    .join("design/w1/systems/storefront/.cache/render-check.json")
            )
            .unwrap(),
            r#"{
  "total": 4,
  "bad": 2,
  "thin": 1,
  "variants_identical": 1,
  "cards": [
    {
      "path": "components/buttons/button/button.html",
      "flags": []
    },
    {
      "path": "components/forms/field/field.html",
      "flags": [
        "errs",
        "bad"
      ],
      "errors": [
        "link did not load: ../../../missing.css"
      ]
    },
    {
      "path": "components/menus/menu/menu.html",
      "flags": [
        "bad"
      ],
      "error": "the card did not finish loading in 15 s"
    },
    {
      "path": "components/forms/select/select.html",
      "flags": [
        "nameOnly",
        "variantsIdentical",
        "thin"
      ]
    }
  ]
}
"#
        );
    }

    const BUTTON: &str = "<!-- @dsCard group=\"Buttons\" name=\"Button\" viewport=\"320x140\" -->\n<!doctype html>\n<html><body><section class=\"ds-cell\" data-snippet=\"buttons/button/primary\"><h4>primary</h4><div class=\"ds-mount\"><button class=\"btn\">Run</button></div></section>\n<section class=\"ds-cell\" data-snippet=\"buttons/button/ghost\"><h4>ghost</h4><div class=\"ds-mount\"><button class=\"btn btn--ghost\">Cancel</button></div></section></body></html>\n";

    #[test]
    fn a_snapshot_is_saved_under_the_cards_name_its_variant_and_viewport() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems/storefront");
        put(&dir, &[("components/buttons/button/button.html", BUTTON)]);
        let card = "components/buttons/button/button.html";
        // The marker's viewport, the whole card.
        let whole = store.snap_target("w1", &slug, card, None, None).unwrap();
        assert_eq!(
            whole,
            SnapTarget {
                path: card.into(),
                viewport: (320, 140),
                variant: None
            }
        );
        let png = b"\x89PNG\r\n\x1a\n fake";
        assert_eq!(
            store.write_screenshot("w1", &slug, &whole, png).unwrap(),
            dir.join(".cache/screenshots/button-320x140.png")
        );
        assert_eq!(
            std::fs::read(dir.join(".cache/screenshots/button-320x140.png")).unwrap(),
            png
        );
        // A variant by the last part of its id, at another viewport.
        let ghost = store
            .snap_target("w1", &slug, card, Some("ghost"), Some((600, 400)))
            .unwrap();
        assert_eq!(ghost.variant.as_deref(), Some("buttons/button/ghost"));
        assert_eq!(
            store.write_screenshot("w1", &slug, &ghost, png).unwrap(),
            dir.join(".cache/screenshots/button--ghost-600x400.png")
        );
    }

    #[test]
    fn a_snapshot_names_a_card_of_the_system_and_one_of_its_variants() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems/storefront");
        put(
            &dir,
            &[
                ("components/buttons/button/button.html", BUTTON),
                ("components/buttons/button/button.proposed.html", BUTTON),
                ("README.md", "# storefront\n"),
            ],
        );
        put(outside.path(), &[("card.html", BUTTON)]);
        std::fs::create_dir_all(dir.join("components/menus/menu")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("card.html"),
            dir.join("components/menus/menu/menu.html"),
        )
        .unwrap();
        for bad in [
            "components/buttons/button/button.proposed.html",
            "components/buttons/../buttons/button/button.html",
            "/components/buttons/button/button.html",
            "README.md",
            "components/menus/menu/menu.html",
            "components/forms/field/field.html",
        ] {
            assert!(
                store.snap_target("w1", &slug, bad, None, None).is_err(),
                "{bad}"
            );
        }
        let err = store
            .snap_target(
                "w1",
                &slug,
                "components/buttons/button/button.html",
                Some("danger"),
                None,
            )
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "components/buttons/button/button.html has no variant \"danger\""
        );
    }

    #[test]
    fn the_render_check_loads_every_card_at_its_viewport_but_proposals() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems/storefront");
        put(
            &dir,
            &[
                ("components/buttons/button/button.html", BUTTON),
                ("components/buttons/button/button.proposed.html", BUTTON),
                (
                    "ui_kits/app/main.html",
                    "<!-- @dsCard group=\"Layouts\" name=\"Main\" viewport=\"1440x900\" -->\n<p>Main</p>\n",
                ),
                ("foundations/colours/colours.html", "<p>no marker</p>\n"),
                ("guidelines/page.html", "<p>a guideline</p>\n"),
            ],
        );
        assert_eq!(
            store.render_cards("w1", &slug).unwrap(),
            vec![
                RenderJob {
                    path: "components/buttons/button/button.html".into(),
                    viewport: (320, 140)
                },
                RenderJob {
                    path: "foundations/colours/colours.html".into(),
                    viewport: card::DEFAULT_VIEWPORT
                },
                RenderJob {
                    path: "ui_kits/app/main.html".into(),
                    viewport: (1440, 900)
                },
            ]
        );
    }

    #[test]
    fn render_results_and_screenshots_never_follow_a_link_the_agent_left() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        let slug = store
            .create_system("w1", "storefront", vec![], Cover::Core, 1)
            .unwrap();
        let dir = home.path().join("design/w1/systems/storefront");
        put(&dir, &[("components/buttons/button/button.html", BUTTON)]);
        std::os::unix::fs::symlink(outside.path(), dir.join(".cache")).unwrap();
        let target = store
            .snap_target(
                "w1",
                &slug,
                "components/buttons/button/button.html",
                None,
                None,
            )
            .unwrap();
        let _ = store.write_render_check("w1", &slug, &[]);
        let _ = store.write_screenshot("w1", &slug, &target, b"png");
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_card_the_app_could_not_render_is_bad_with_why() {
        let path = "components/menus/menu/menu.html".to_string();
        assert_eq!(
            RenderResult::new(
                path.clone(),
                Err("the card did not finish loading in 15 s".into())
            ),
            RenderResult {
                path: path.clone(),
                flags: vec!["bad".into()],
                errors: vec![],
                error: Some("the card did not finish loading in 15 s".into()),
            }
        );
        let measured = moonlet_proto::methods::RenderMetrics {
            flags: vec!["errs".into(), "bad".into()],
            errors: vec!["img did not load: hero.png".into()],
        };
        assert_eq!(
            RenderResult::new(path.clone(), Ok(measured)),
            RenderResult {
                path,
                flags: vec!["errs".into(), "bad".into()],
                errors: vec!["img did not load: hero.png".into()],
                error: None,
            }
        );
    }
}
