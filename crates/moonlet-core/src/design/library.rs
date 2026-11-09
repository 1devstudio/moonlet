//! The account's design library (X95): design systems, and the designs
//! shared with every workspace, live in `~/.moonlet/design/library/`, laid
//! out like a workspace's folder, so every workspace sees them.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Result;

use super::fsx;
use super::merge::{folders, follow_system};
use super::store::{CONFIG, Record, Store, is_name, read_config, read_record};

/// The folder of the library under `~/.moonlet/design`. A workspace id is
/// 12 hex digits, so it is never this.
pub const LIBRARY: &str = "library";

/// Where the move from workspaces keeps the systems it renamed, by
/// workspace, until that workspace's designs follow them.
const JOURNAL: &str = "move.toml";

/// One system the move took from a workspace into the library.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToLibrary {
    pub workspace: String,
    pub from: String,
    /// Its slug in the library.
    pub to: String,
    /// The chat of its sync agent, which its record named before the move
    /// forgot it: it ran in the folder that moved away.
    pub agent: Option<u32>,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Journal {
    #[serde(default)]
    renamed: BTreeMap<String, BTreeMap<String, String>>,
}

impl Store {
    /// Moves the design systems moonlet kept in each workspace's folder
    /// before X95 into the library, with their records, which forget their
    /// agents. Workspaces go in `order` (the account's), then any other
    /// folder by name, so on a slug the library already has the first keeps
    /// it and a later one takes the next free number (`acme-web-2`, named
    /// "Acme web 2"); that workspace's designs follow it. A system `owns`
    /// says is not this member's (a copy of another member's, X71) is
    /// deleted, not moved: its owner moves it. A move stopped midway
    /// finishes on the next call, and nothing to move is not an error.
    pub fn move_systems_to_library(
        &self,
        order: &[String],
        owns: &dyn Fn(&str, &str) -> bool,
    ) -> Result<Vec<ToLibrary>> {
        let root = self.root()?.to_path_buf();
        let journal = self.workspace(LIBRARY)?.join(".records").join(JOURNAL);
        let mut renamed = read_journal(&journal)?;
        let mut moved = Vec::new();
        for ws in self.workspace_folders(order)? {
            let src = self.workspace(&ws)?;
            for slug in folders(&src.join("systems"))? {
                if !owns(&ws, &slug) {
                    fsx::remove_dir_inside(&root, &src.join("systems").join(&slug))?;
                    let record = src.join(".records").join(format!("{slug}.toml"));
                    if std::fs::symlink_metadata(&record).is_ok() {
                        fsx::remove_file_inside(&root, &record)?;
                    }
                    continue;
                }
                let taken = renamed.get(&ws).and_then(|r| r.get(&slug)).cloned();
                let to = match taken {
                    Some(to) => to,
                    None => self.free_slug(LIBRARY, "systems", ".records", &slug)?,
                };
                if to != slug {
                    renamed
                        .entry(ws.clone())
                        .or_default()
                        .insert(slug.clone(), to.clone());
                    write_journal(&self.workspace(LIBRARY)?, &journal, &renamed)?;
                    // Named before it moves, so a stop midway leaves the
                    // number on it once.
                    let dir = src.join("systems").join(&slug);
                    let mut config = read_config(&dir)?;
                    let suffix = format!(" {}", &to[slug.len() + 1..]);
                    if !config.name.ends_with(&suffix) {
                        config.name.push_str(&suffix);
                        fsx::write_inside(
                            &dir,
                            &dir.join(CONFIG),
                            toml::to_string(&config)?.as_bytes(),
                        )?;
                    }
                }
                let record = src.join(".records").join(format!("{slug}.toml"));
                let agent = match std::fs::symlink_metadata(&record) {
                    Ok(_) => read_record::<Record>(&record)?.agent,
                    Err(_) => None,
                };
                self.move_item(&root, &ws, LIBRARY, "systems", &slug, &to, ".records")?;
                moved.push(ToLibrary {
                    workspace: ws.clone(),
                    from: slug,
                    to,
                    agent,
                });
            }
            if let Some(names) = renamed.get(&ws) {
                for design in folders(&src.join("designs"))? {
                    follow_system(&src.join("designs").join(&design), names)?;
                }
            }
            // Only a folder left empty goes.
            let _ = std::fs::remove_dir(src.join("systems"));
        }
        match std::fs::remove_file(&journal) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        Ok(moved)
    }

    /// The workspaces' folders under `~/.moonlet/design`: those in `order`
    /// first, then the others by name; never the library or a hidden one.
    pub(super) fn workspace_folders(&self, order: &[String]) -> Result<Vec<String>> {
        let mut found = folders(self.root()?)?;
        found.retain(|f| f != LIBRARY);
        let mut out: Vec<String> = order
            .iter()
            .filter(|w| is_name(w) && found.contains(w))
            .cloned()
            .collect();
        out.extend(found.into_iter().filter(|f| !order.contains(f)));
        Ok(out)
    }
}

fn read_journal(path: &Path) -> Result<BTreeMap<String, BTreeMap<String, String>>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(toml::from_str::<Journal>(&text)?.renamed),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.into()),
    }
}

fn write_journal(
    library: &Path,
    path: &Path,
    renamed: &BTreeMap<String, BTreeMap<String, String>>,
) -> Result<()> {
    let journal = Journal {
        renamed: renamed.clone(),
    };
    fsx::write_inside(library, path, toml::to_string(&journal)?.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design::store::{Cover, Store};
    use std::path::Path;

    #[test]
    fn a_system_made_in_one_workspace_is_listed_from_every_workspace() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        store
            .create_system("w-acme-app", "Acme web", vec![], Cover::Core, 1)
            .unwrap();

        let listed: Vec<String> = store
            .systems("w-acme-site")
            .unwrap()
            .into_iter()
            .map(|s| s.slug)
            .collect();

        assert_eq!(listed, vec!["acme-web".to_string()]);
        assert!(
            home.path()
                .join("design/library/systems/acme-web/config.toml")
                .is_file()
        );
        assert!(
            home.path()
                .join("design/library/.records/acme-web.toml")
                .is_file()
        );
        assert!(!home.path().join("design/w-acme-app").exists());
    }

    /// A system as moonlet before X95 kept it, in its workspace's folder.
    fn old_system(home: &Path, ws: &str, slug: &str, name: &str, sources: &str) {
        let dir = home.join("design").join(ws).join("systems").join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("config.toml"),
            format!("name = \"{name}\"\ncreated_at = 1\n"),
        )
        .unwrap();
        std::fs::write(dir.join("styles.css"), format!("/* {ws} */\n")).unwrap();
        let records = home.join("design").join(ws).join(".records");
        std::fs::create_dir_all(&records).unwrap();
        std::fs::write(records.join(format!("{slug}.toml")), sources).unwrap();
    }

    fn old_design(home: &Path, ws: &str, slug: &str, system: &str) {
        let dir = home.join("design").join(ws).join("designs").join(slug);
        std::fs::create_dir_all(dir.join("pages")).unwrap();
        std::fs::write(
            dir.join("design.toml"),
            format!("name = \"{slug}\"\nsystem = \"{system}\"\n"),
        )
        .unwrap();
        std::fs::write(
            dir.join("pages/index.html"),
            format!("<link rel=\"stylesheet\" href=\"../../../systems/{system}/styles.css\">\n"),
        )
        .unwrap();
    }

    fn read(home: &Path, path: &str) -> String {
        std::fs::read_to_string(home.join("design").join(path)).unwrap()
    }

    #[test]
    fn every_workspaces_systems_move_into_the_library_and_a_taken_slug_gets_a_number() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        old_system(h, "a1b2c3d4e5f6", "acme-web", "Acme web", "synced_at = 5\n");
        old_system(h, "f6e5d4c3b2a1", "acme-web", "Acme web", "synced_at = 9\n");
        old_system(h, "f6e5d4c3b2a1", "billing", "Billing", "");
        old_design(h, "a1b2c3d4e5f6", "pricing", "acme-web");
        old_design(h, "f6e5d4c3b2a1", "checkout", "acme-web");
        let store = Store::new(h);

        // The account's order puts f6e5… first: its Acme web keeps the slug.
        let moved = store
            .move_systems_to_library(&["f6e5d4c3b2a1".into(), "a1b2c3d4e5f6".into()], &|_, _| {
                true
            })
            .unwrap();

        assert_eq!(
            moved,
            vec![
                ToLibrary {
                    workspace: "f6e5d4c3b2a1".into(),
                    from: "acme-web".into(),
                    to: "acme-web".into(),
                    agent: None
                },
                ToLibrary {
                    workspace: "f6e5d4c3b2a1".into(),
                    from: "billing".into(),
                    to: "billing".into(),
                    agent: None
                },
                ToLibrary {
                    workspace: "a1b2c3d4e5f6".into(),
                    from: "acme-web".into(),
                    to: "acme-web-2".into(),
                    agent: None
                },
            ]
        );
        let listed: Vec<(String, String)> = store
            .systems("a1b2c3d4e5f6")
            .unwrap()
            .into_iter()
            .map(|s| (s.slug, s.name))
            .collect();
        assert_eq!(
            listed,
            vec![
                ("acme-web".into(), "Acme web".into()),
                ("acme-web-2".into(), "Acme web 2".into()),
                ("billing".into(), "Billing".into()),
            ]
        );
        assert_eq!(
            read(h, "library/systems/acme-web/styles.css"),
            "/* f6e5d4c3b2a1 */\n"
        );
        assert_eq!(
            read(h, "library/systems/acme-web-2/styles.css"),
            "/* a1b2c3d4e5f6 */\n"
        );
        assert_eq!(
            read(h, "library/.records/acme-web-2.toml"),
            "synced_at = 5\n"
        );
        // Each workspace's designs still use the system they were made on.
        assert_eq!(
            store.designs("a1b2c3d4e5f6").unwrap()[0].system,
            "acme-web-2"
        );
        assert_eq!(
            read(h, "a1b2c3d4e5f6/designs/pricing/pages/index.html"),
            "<link rel=\"stylesheet\" href=\"../../../systems/acme-web-2/styles.css\">\n"
        );
        assert_eq!(store.designs("f6e5d4c3b2a1").unwrap()[0].system, "acme-web");
        assert!(!h.join("design/a1b2c3d4e5f6/systems").exists());
        assert!(!h.join("design/library/.records/move.toml").exists());
        // Nothing is left to move.
        assert_eq!(
            store
                .move_systems_to_library(&["a1b2c3d4e5f6".into()], &|_, _| true)
                .unwrap(),
            vec![]
        );
    }

    #[test]
    fn a_move_stopped_after_naming_a_system_finishes_with_its_number_once() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        old_system(h, "library", "acme-web", "Acme web", "");
        // Stopped after it was named "Acme web 2", before it moved.
        old_system(h, "a1b2c3d4e5f6", "acme-web", "Acme web 2", "");
        old_design(h, "a1b2c3d4e5f6", "pricing", "acme-web");
        std::fs::write(
            h.join("design/library/.records/move.toml"),
            "[renamed.a1b2c3d4e5f6]\nacme-web = \"acme-web-2\"\n",
        )
        .unwrap();
        let store = Store::new(h);

        store
            .move_systems_to_library(&["a1b2c3d4e5f6".into()], &|_, _| true)
            .unwrap();

        let names: Vec<String> = store
            .systems("a1b2c3d4e5f6")
            .unwrap()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["Acme web", "Acme web 2"]);
        assert_eq!(
            store.designs("a1b2c3d4e5f6").unwrap()[0].system,
            "acme-web-2"
        );
    }

    #[test]
    fn a_move_stopped_before_the_designs_followed_finishes_them() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        old_system(h, "library", "acme-web", "Acme web", "");
        old_system(h, "library", "acme-web-2", "Acme web 2", "");
        old_design(h, "a1b2c3d4e5f6", "pricing", "acme-web");
        std::fs::write(
            h.join("design/library/.records/move.toml"),
            "[renamed.a1b2c3d4e5f6]\nacme-web = \"acme-web-2\"\n",
        )
        .unwrap();
        let store = Store::new(h);

        let moved = store
            .move_systems_to_library(&["a1b2c3d4e5f6".into()], &|_, _| true)
            .unwrap();

        assert_eq!(moved, vec![]);
        assert_eq!(
            store.designs("a1b2c3d4e5f6").unwrap()[0].system,
            "acme-web-2"
        );
        assert!(!h.join("design/library/.records/move.toml").exists());
    }

    #[test]
    fn another_members_copy_is_deleted_and_a_moved_systems_agent_is_forgotten() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        old_system(
            h,
            "a1b2c3d4e5f6",
            "acme-web",
            "Acme web",
            "agent = 7\nagent_launch = \"x\"\nsynced_at = 3\n",
        );
        old_system(h, "a1b2c3d4e5f6", "docs-kit", "Docs kit", "");
        let store = Store::new(h);

        let moved = store
            .move_systems_to_library(&[], &|ws, slug| ws == "a1b2c3d4e5f6" && slug == "acme-web")
            .unwrap();

        assert_eq!(
            moved,
            vec![ToLibrary {
                workspace: "a1b2c3d4e5f6".into(),
                from: "acme-web".into(),
                to: "acme-web".into(),
                agent: Some(7)
            }]
        );
        let record = store.record("a1b2c3d4e5f6", "acme-web").unwrap();
        assert_eq!((record.agent, record.synced_at), (None, Some(3)));
        assert!(!h.join("design/a1b2c3d4e5f6/systems").exists());
        assert!(
            !h.join("design/a1b2c3d4e5f6/.records/docs-kit.toml")
                .exists()
        );
        assert!(!h.join("design/library/systems/docs-kit").exists());
    }

    #[test]
    fn a_record_that_cannot_be_read_stops_the_move_with_that_system_left_in_place() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        old_system(h, "a1b2c3d4e5f6", "acme-web", "Acme web", "synced_at = 3\n");
        let record = h.join("design/a1b2c3d4e5f6/.records/acme-web.toml");
        std::fs::set_permissions(&record, std::fs::Permissions::from_mode(0o000)).unwrap();

        let moved = Store::new(h).move_systems_to_library(&[], &|_, _| true);
        std::fs::set_permissions(&record, std::fs::Permissions::from_mode(0o600)).unwrap();

        assert!(moved.is_err());
        assert!(
            h.join("design/a1b2c3d4e5f6/systems/acme-web/config.toml")
                .exists()
        );
        assert!(!h.join("design/library/systems/acme-web").exists());
    }
}
