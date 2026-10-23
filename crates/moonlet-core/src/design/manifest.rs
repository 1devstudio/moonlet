//! `_ds_manifest.json` (X64): the index of a design system's cards, built from
//! their `@dsCard` markers, as Claude Design's self-check builds its own.

use std::path::Path;

use anyhow::Result;
use serde::Serialize;

use super::card;
use super::check::{CARD_DIRS, html_files, rel};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub group: String,
    pub name: String,
    /// Relative to the design system's folder.
    pub path: String,
    pub viewport: (u32, u32),
    pub source: Vec<String>,
    pub snippets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Manifest {
    pub cards: Vec<Entry>,
}

/// The manifest of the design system in `root`.
/// Cards whose marker is missing or wrong, and proposals waiting to be settled,
/// are left out.
pub fn build(root: &Path) -> Result<Manifest> {
    let mut cards = Vec::new();
    for path in html_files(root) {
        let path_rel = rel(root, &path);
        if !CARD_DIRS
            .iter()
            .any(|d| path_rel.starts_with(&format!("{d}/")))
            || path_rel.ends_with(".proposed.html")
        {
            continue;
        }
        let text = std::fs::read_to_string(&path)?;
        let Ok(marker) = card::parse_marker(&text) else {
            continue;
        };
        let stem = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        cards.push(Entry {
            group: marker.group,
            name: marker.name.unwrap_or(stem),
            path: path_rel,
            viewport: marker.viewport,
            source: marker.source,
            snippets: card::snippets(&text),
        });
    }
    cards.sort_by(|a, b| (&a.group, &a.name).cmp(&(&b.group, &b.name)));
    Ok(Manifest { cards })
}

/// Writes `_ds_manifest.json`.
pub fn write(root: &Path) -> Result<()> {
    let json = serde_json::to_string_pretty(&build(root)?)?;
    std::fs::write(root.join("_ds_manifest.json"), json + "\n")?;
    Ok(())
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
    fn the_manifest_lists_every_card_by_group_then_name_with_its_snippets() {
        let dir = system(&[
            (
                "components/buttons/button/button.html",
                "<!-- @dsCard group=\"Buttons\" name=\"Button\" source=\"apps/desktop/src/components/ui.tsx\" -->\n<!doctype html>\n\
<section class=\"ds-cell\" data-snippet=\"buttons/button/primary\"><h4>primary</h4></section>\n\
<section class=\"ds-cell\" data-snippet=\"buttons/button/danger\"><h4>danger</h4></section>\n",
            ),
            (
                "components/buttons/button/button.proposed.html",
                "<!-- @dsCard group=\"Buttons\" name=\"Button\" -->\n",
            ),
            (
                "components/custom/session-row/session-row.html",
                "<!-- @dsCard group=\"Custom\" name=\"Session row\" source=\"apps/desktop/src/components/Sidebar.tsx\" viewport=\"320x140\" -->\n",
            ),
            (
                "components/buttons/icon-button/icon-button.html",
                "<!-- @dsCard group=\"Buttons\" -->\n",
            ),
            (
                "components/forms/field/field.html",
                "<!doctype html>\n<p>no marker</p>\n",
            ),
            (
                "ui_kits/app/settings.html",
                "<!-- @dsCard group=\"Layouts\" name=\"Settings\" viewport=\"1440x900\" -->\n",
            ),
        ]);
        write(dir.path()).unwrap();
        let json = std::fs::read_to_string(dir.path().join("_ds_manifest.json")).unwrap();
        let json = json.strip_suffix('\n').unwrap();
        assert_eq!(
            json,
            r#"{
  "cards": [
    {
      "group": "Buttons",
      "name": "Button",
      "path": "components/buttons/button/button.html",
      "viewport": [
        900,
        700
      ],
      "source": [
        "apps/desktop/src/components/ui.tsx"
      ],
      "snippets": [
        "buttons/button/primary",
        "buttons/button/danger"
      ]
    },
    {
      "group": "Buttons",
      "name": "icon-button",
      "path": "components/buttons/icon-button/icon-button.html",
      "viewport": [
        900,
        700
      ],
      "source": [],
      "snippets": []
    },
    {
      "group": "Custom",
      "name": "Session row",
      "path": "components/custom/session-row/session-row.html",
      "viewport": [
        320,
        140
      ],
      "source": [
        "apps/desktop/src/components/Sidebar.tsx"
      ],
      "snippets": []
    },
    {
      "group": "Layouts",
      "name": "Settings",
      "path": "ui_kits/app/settings.html",
      "viewport": [
        1440,
        900
      ],
      "source": [],
      "snippets": []
    }
  ]
}"#
        );
    }
}
