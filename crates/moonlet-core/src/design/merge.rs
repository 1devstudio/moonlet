//! Design systems and designs follow a merged workspace (X71): when the
//! user merges workspace `from` into `into` (X68), what `~/.moonlet/design/
//! <from>/` holds moves to `<into>/`, so it is not left under an id nothing
//! shows any more.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Result, bail};

use super::designs::{DESIGN_FILE, read_design_config};
use super::fsx;
use super::place::DesignAt;
use super::store::{CONFIG, Store, is_name, read_config};

/// Which items a move took, and the slug each has now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Moved {
    /// `system` or `design`.
    pub kind: &'static str,
    pub from: String,
    pub to: String,
}

impl Store {
    /// Moves every design system and design of workspace `from` into
    /// `into`, with their records. A slug `into` already has gets the next
    /// free number, as a new one would (`acme-2`, named "Acme 2"), and the
    /// moved designs on a renamed system follow it. Nothing to move is not
    /// an error; `from`'s folder goes once empty.
    pub fn move_workspace(&self, from: &str, into: &str) -> Result<Vec<Moved>> {
        if from == into {
            bail!("a workspace cannot merge into itself");
        }
        let src = self.workspace(from)?;
        if std::fs::symlink_metadata(&src).is_err() {
            return Ok(Vec::new());
        }
        let root = self.root()?.to_path_buf();
        let mut moved = Vec::new();
        let mut renamed = BTreeMap::new();
        for slug in folders(&src.join("systems"))? {
            let to = self.move_item(&root, from, into, "systems", &slug, ".records")?;
            if to != slug {
                let dir = self.kind_dir(into, "systems", false)?.join(&to);
                let mut config = read_config(&dir)?;
                config.name = format!("{} {}", config.name, number(&slug, &to));
                fsx::write_inside(
                    &dir,
                    &dir.join(CONFIG),
                    toml::to_string(&config)?.as_bytes(),
                )?;
                renamed.insert(slug.clone(), to.clone());
            }
            moved.push(Moved {
                kind: "system",
                from: slug,
                to,
            });
        }
        for slug in folders(&src.join("designs"))? {
            let to = self.move_item(&root, from, into, "designs", &slug, ".records/designs")?;
            let dir = self.kind_dir(into, "designs", false)?.join(&to);
            if to != slug {
                let at = DesignAt::of_workspace(self.kind_dir(into, "designs", false)?, into, &to);
                let mut config = read_design_config(&at)?;
                config.name = format!("{} {}", config.name, number(&slug, &to));
                fsx::write_inside(
                    &dir,
                    &dir.join(DESIGN_FILE),
                    toml::to_string(&config)?.as_bytes(),
                )?;
            }
            follow_system(&dir, into, &to, &renamed, self)?;
            moved.push(Moved {
                kind: "design",
                from: slug,
                to,
            });
        }
        // Only folders left empty go: anything else stays where it was.
        for dir in ["systems", "designs", ".records/designs", ".records", ""] {
            let _ = std::fs::remove_dir(src.join(dir));
        }
        Ok(moved)
    }

    /// Moves `<from>/<kind>/<slug>` and its record (in `records`) to `into`,
    /// under the first free slug: `slug`, then `slug-2`, `slug-3`, ….
    fn move_item(
        &self,
        root: &Path,
        from: &str,
        into: &str,
        kind: &str,
        slug: &str,
        records: &str,
    ) -> Result<String> {
        let dest = self.kind_dir(into, kind, true)?;
        let mut n = 1;
        let to = loop {
            let to = if n == 1 {
                slug.to_string()
            } else {
                format!("{slug}-{n}")
            };
            if std::fs::symlink_metadata(dest.join(&to)).is_err() {
                break to;
            }
            n += 1;
        };
        let src = self.kind_dir(from, kind, false)?;
        fsx::rename_inside(root, &src.join(slug), &dest.join(&to))?;
        let record = self
            .workspace(from)?
            .join(records)
            .join(format!("{slug}.toml"));
        if let Ok(bytes) = std::fs::read(&record) {
            let ws = self.workspace(into)?;
            fsx::write_inside(&ws, &ws.join(records).join(format!("{to}.toml")), &bytes)?;
            fsx::remove_file_inside(root, &record)?;
        }
        Ok(to)
    }
}

/// The folders in `dir`, by name; links and hidden ones are left out.
fn folders(dir: &Path) -> Result<Vec<String>> {
    let Some(entries) = fsx::read_dir_if_there(dir)? else {
        return Ok(Vec::new());
    };
    let mut out: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_name(n) && !n.starts_with('.'))
        .collect();
    out.sort();
    Ok(out)
}

/// The number a renamed slug took: `3` for `acme` → `acme-3`.
fn number<'a>(slug: &str, to: &'a str) -> &'a str {
    &to[slug.len() + 1..]
}

/// Points design `slug` (in `dir`) at its system's new slug when the move
/// renamed it: `design.toml` and every page that links its styles,
/// snapshots in `history/` too.
fn follow_system(
    dir: &Path,
    workspace: &str,
    slug: &str,
    renamed: &BTreeMap<String, String>,
    store: &Store,
) -> Result<()> {
    let at = DesignAt::of_workspace(
        store.kind_dir(workspace, "designs", false)?,
        workspace,
        slug,
    );
    let mut config = read_design_config(&at)?;
    let Some(to) = renamed.get(&config.system) else {
        return Ok(());
    };
    let (old_link, new_link) = (
        format!("/systems/{}/", config.system),
        format!("/systems/{to}/"),
    );
    config.system = to.clone();
    fsx::write_inside(
        dir,
        &dir.join(DESIGN_FILE),
        toml::to_string(&config)?.as_bytes(),
    )?;
    let pages: BTreeMap<String, Vec<u8>> = fsx::read_tree(dir, Path::new(""))?
        .into_iter()
        .filter(|(path, _)| path.ends_with(".html"))
        .filter_map(|(path, bytes)| {
            let text = String::from_utf8(bytes).ok()?;
            text.contains(&old_link)
                .then(|| (path, text.replace(&old_link, &new_link).into_bytes()))
        })
        .collect();
    fsx::write_tree(dir, Path::new(""), Path::new(""), &pages, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design::store::{Cover, Source};
    use moonlet_proto::types::ProjectIdentity;

    fn source() -> Source {
        Source {
            project: "p-acme".into(),
            path: "/Users/alex/Workspace/acme-web".into(),
            identity: ProjectIdentity {
                origin: Some("github.com/acme/acme-web".into()),
                root: Some("4f2a91c".into()),
            },
            subdir: None,
            commit: Some("b7e01d2".into()),
        }
    }

    #[test]
    fn a_merged_workspaces_systems_and_designs_move_and_a_taken_slug_gets_a_number() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        // The MacBook's "Personal" (w-mac) and the mini's (w-mini) both have
        // "Acme web"; the MacBook's also has a design on it.
        store
            .create_system("w-mini", "Acme web", vec![], Cover::Core, 1)
            .unwrap();
        store
            .create_system("w-mac", "Acme web", vec![source()], Cover::Core, 2)
            .unwrap();
        store
            .create_system("w-mac", "Billing", vec![], Cover::None, 3)
            .unwrap();
        store
            .create_design("w-mac", "Checkout", "acme-web", "a checkout page", 4)
            .unwrap();
        let design = home.path().join("design/w-mac/designs/checkout");
        std::fs::write(
            design.join("pages/index.html"),
            r#"<link rel="stylesheet" href="../../../systems/acme-web/styles.css">"#,
        )
        .unwrap();

        let moved = store.move_workspace("w-mac", "w-mini").unwrap();

        assert_eq!(
            moved,
            vec![
                Moved {
                    kind: "system",
                    from: "acme-web".into(),
                    to: "acme-web-2".into()
                },
                Moved {
                    kind: "system",
                    from: "billing".into(),
                    to: "billing".into()
                },
                Moved {
                    kind: "design",
                    from: "checkout".into(),
                    to: "checkout".into()
                },
            ]
        );
        let names: Vec<(String, String)> = store
            .systems("w-mini")
            .unwrap()
            .into_iter()
            .map(|s| (s.slug, s.name))
            .collect();
        assert_eq!(
            names,
            vec![
                ("acme-web".into(), "Acme web".into()),
                ("acme-web-2".into(), "Acme web 2".into()),
                ("billing".into(), "Billing".into()),
            ]
        );
        // Its record came along.
        assert_eq!(
            store.record("w-mini", "acme-web-2").unwrap().sources,
            vec![source()]
        );
        // The design now names the renamed system, and its page links it.
        let designs = store.designs("w-mini").unwrap();
        assert_eq!(designs.len(), 1);
        assert_eq!(designs[0].system, "acme-web-2");
        assert_eq!(
            std::fs::read_to_string(
                home.path()
                    .join("design/w-mini/designs/checkout/pages/index.html")
            )
            .unwrap(),
            r#"<link rel="stylesheet" href="../../../systems/acme-web-2/styles.css">"#
        );
        assert!(!home.path().join("design/w-mac").exists());
    }

    #[test]
    fn a_workspace_with_no_design_folder_moves_nothing() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        assert_eq!(store.move_workspace("w-none", "w-mini").unwrap(), vec![]);
        assert!(!home.path().join("design/w-mini").exists());
    }
}
