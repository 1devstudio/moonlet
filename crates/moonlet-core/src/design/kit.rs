//! What a design's visual editor builds with from its own design system
//! (X65): the system's tokens, read as the X64 check reads them, for the
//! Inspector, and its cards that hold snippets, whose markup the Palette
//! inserts. Only the design's own system: nothing else is ever inserted.

use anyhow::Result;

use moonlet_proto::methods::{DesignKit, DesignKitCard, DesignToken};

use super::place::DesignAt;
use super::store::Store;
use super::{fsx, manifest, tokens};

impl Store {
    /// The tokens and snippet cards of design `slug`'s design system. A
    /// card that cannot be read through the system's folder (a link) is
    /// left out.
    pub fn design_kit(&self, at: &DesignAt) -> Result<DesignKit> {
        let config = self.design_config(at)?;
        let workspace = at.workspace.as_deref().unwrap_or_default();
        let dir = self.system_dir(workspace, &config.system)?;
        let tokens = tokens::read(&dir)
            .into_iter()
            .map(|t| DesignToken {
                name: t.name,
                value: t.value,
                family: t.family,
            })
            .collect();
        let cards = manifest::build(&dir)?
            .cards
            .into_iter()
            .filter(|c| !c.snippets.is_empty())
            .filter_map(|c| {
                let html = fsx::read_inside(&dir, &dir.join(&c.path)).ok()?;
                Some(DesignKitCard {
                    path: c.path,
                    group: c.group,
                    name: c.name,
                    html,
                })
            })
            .collect();
        Ok(DesignKit {
            system: config.system,
            tokens,
            cards,
        })
    }
}

#[cfg(test)]
mod tests {
    use moonlet_proto::methods::{DesignKitCard, DesignToken};

    use super::super::tokens::Family;

    use super::*;

    const BUTTON: &str = "<!-- @dsCard group=\"Buttons\" name=\"Button\" source=\"src/ui.tsx\" -->\n<!doctype html>\n<link rel=\"stylesheet\" href=\"../../../styles.css\">\n<div class=\"ds-grid\">\n<section class=\"ds-cell\" data-snippet=\"buttons/button/primary\"><h4>primary</h4><div class=\"ds-mount\"><button class=\"btn btn--primary\">Save</button></div></section>\n<section class=\"ds-cell\" data-snippet=\"buttons/button/ghost\"><h4>ghost</h4><div class=\"ds-mount\"><button class=\"btn btn--ghost\">Cancel</button></div></section>\n</div>\n";

    #[test]
    fn a_designs_kit_is_its_own_systems_tokens_and_the_cards_that_hold_snippets() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        store
            .create_system(
                "w1",
                "moonlet desktop",
                vec![],
                super::super::store::Cover::Core,
                1,
            )
            .unwrap();
        store
            .create_system(
                "w1",
                "storefront",
                vec![],
                super::super::store::Cover::Core,
                1,
            )
            .unwrap();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        let system = home.path().join("design/w1/systems/moonlet-desktop");
        let write = |rel: &str, text: &str| {
            let p = system.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        write(
            "styles.css",
            "@import \"tokens/scale.css\";\n@import \"components.css\";\n",
        );
        write(
            "tokens/scale.css",
            ":root {\n  --space-1: 4px;\n  --space-4: 16px;\n  --color-panel: #161616;\n  --radius-xl: 12px;\n}\n",
        );
        write("components/buttons/Button/Button.html", BUTTON);
        // A layout, whole screens of snippets, holds none of its own.
        write(
            "ui_kits/desktop/Settings.html",
            "<!-- @dsCard group=\"Layouts\" name=\"Settings\" -->\n<!doctype html>\n<main></main>\n",
        );
        // Another system's card is not this design's.
        let other = home
            .path()
            .join("design/w1/systems/storefront/components/cart/Cart/Cart.html");
        std::fs::create_dir_all(other.parent().unwrap()).unwrap();
        std::fs::write(&other, BUTTON.replace("Buttons", "Cart")).unwrap();

        let t = |name: &str, value: &str, family: Family| DesignToken {
            name: name.into(),
            value: value.into(),
            family,
        };
        assert_eq!(
            store
                .design_kit(&store.workspace_design("w1", "settings-page").unwrap())
                .unwrap(),
            DesignKit {
                system: "moonlet-desktop".into(),
                tokens: vec![
                    t("--space-1", "4px", Family::Spacing),
                    t("--space-4", "16px", Family::Spacing),
                    t("--color-panel", "#161616", Family::Color),
                    t("--radius-xl", "12px", Family::Radius),
                ],
                cards: vec![DesignKitCard {
                    path: "components/buttons/Button/Button.html".into(),
                    group: "Buttons".into(),
                    name: "Button".into(),
                    html: BUTTON.into(),
                }],
            }
        );
        assert!(store.workspace_design("w1", "no-such-design").is_err());
    }
}
