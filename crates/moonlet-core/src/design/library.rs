//! The account's design library (X95): design systems, and the designs
//! shared with every workspace, live in `~/.moonlet/design/library/`, laid
//! out like a workspace's folder, so every workspace sees them.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result};

use super::designs::DESIGN_FILE;
use super::fsx;
use super::merge::{folders, follow_system, number};
use super::place::DesignAt;
use super::store::{CONFIG, Record, Store, is_name, read_config, read_record, record_file};

/// The folder of the library under `~/.moonlet/design`. A workspace id is
/// 12 hex digits, so it is never this.
pub const LIBRARY: &str = "library";

/// Where the move from workspaces keeps each system it moved, until the
/// daemon has finished what follows the move (see
/// [`Store::library_move_done`]).
const JOURNAL: &str = "move.toml";

/// One system the move took from a workspace into the library.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ToLibrary {
    pub workspace: String,
    pub from: String,
    /// Its slug in the library.
    pub to: String,
    /// The chat of its sync agent, which its record named before the move
    /// forgot it: it ran in the folder that moved away.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<u32>,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Journal {
    #[serde(default)]
    moved: Vec<ToLibrary>,
}

impl Store {
    /// Moves the design systems moonlet kept in each workspace's folder
    /// before X95 into the library, with their records, which forget their
    /// agents. Workspaces go in `order` (the account's), then any other
    /// folder by name, so on a slug the library already has the first keeps
    /// it and a later one takes the next free number (`acme-web-2`, named
    /// "Acme web 2"); that workspace's designs follow it. A system `owns`
    /// says is not this member's (a copy of another member's, X71) is
    /// deleted, not moved: its owner moves it. Each move is noted in a
    /// journal before it is made, so a move stopped midway finishes on the
    /// next call, and every call gives every move the journal holds, until
    /// [`Store::library_move_done`] says what follows them is done too.
    /// Nothing to move is not an error.
    pub fn move_systems_to_library(
        &self,
        order: &[String],
        owns: &dyn Fn(&str, &str) -> bool,
    ) -> Result<Vec<ToLibrary>> {
        let root = self.root()?.to_path_buf();
        let library = self.workspace(LIBRARY)?;
        let journal = library.join(".records").join(JOURNAL);
        let mut moved = read_journal(&journal)?;
        for ws in self.workspace_folders(order)? {
            let src = self.workspace(&ws)?;
            for slug in folders(&src.join("systems"))? {
                let record = record_file(&src.join(".records"), &slug);
                if !owns(&ws, &slug) {
                    fsx::remove_dir_inside(&root, &src.join("systems").join(&slug))?;
                    if std::fs::symlink_metadata(&record).is_ok() {
                        fsx::remove_file_inside(&root, &record)?;
                    }
                    continue;
                }
                let noted = moved
                    .iter()
                    .find(|m| m.workspace == ws && m.from == slug)
                    .cloned();
                let mv = match noted {
                    Some(mv) => mv,
                    None => {
                        let agent = match std::fs::symlink_metadata(&record) {
                            Ok(_) => read_record::<Record>(&record)?.agent,
                            Err(_) => None,
                        };
                        let mv = ToLibrary {
                            workspace: ws.clone(),
                            to: self.free_slug(LIBRARY, "systems", ".records", &slug)?,
                            from: slug.clone(),
                            agent,
                        };
                        moved.push(mv.clone());
                        // The library's folder, for the journal's first note.
                        self.kind_dir(LIBRARY, "systems", true)?;
                        write_journal(&library, &journal, &moved)?;
                        mv
                    }
                };
                if mv.to != slug {
                    // Named before it moves, so a stop midway leaves the
                    // number on it once.
                    let dir = src.join("systems").join(&slug);
                    let mut config = read_config(&dir)?;
                    let suffix = format!(" {}", number(&slug, &mv.to));
                    if !config.name.ends_with(&suffix) {
                        config.name.push_str(&suffix);
                        fsx::write_inside(
                            &dir,
                            &dir.join(CONFIG),
                            toml::to_string(&config)?.as_bytes(),
                        )?;
                    }
                }
                self.move_item(&root, &ws, LIBRARY, "systems", &slug, &mv.to, ".records")?;
            }
            let names: BTreeMap<String, String> = moved
                .iter()
                .filter(|m| m.workspace == ws && m.to != m.from)
                .map(|m| (m.from.clone(), m.to.clone()))
                .collect();
            if !names.is_empty() {
                for design in folders(&src.join("designs"))? {
                    follow_system(&src.join("designs").join(&design), &names)?;
                }
            }
            // Only a folder left empty goes.
            let _ = std::fs::remove_dir(src.join("systems"));
        }
        Ok(moved)
    }

    /// Ends the move into the library: what follows each move (its record
    /// re-keyed, its agent stopped, open sessions' designs following a new
    /// slug) is done, so the next call to
    /// [`Store::move_systems_to_library`] gives it no more.
    pub fn library_move_done(&self) -> Result<()> {
        let journal = self.workspace(LIBRARY)?.join(".records").join(JOURNAL);
        match std::fs::remove_file(&journal) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
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

impl Store {
    /// Shares workspace `workspace`'s design `slug` with every workspace
    /// (X95): it moves into the library with its pages, comments, history
    /// and record, which forgets its agent. A slug the library has gets the
    /// next free number (`pricing-2`, named "Pricing 2"). Gives its slug
    /// there.
    pub fn share_design(&self, workspace: &str, slug: &str) -> Result<String> {
        self.move_design(workspace, LIBRARY, slug)
    }

    /// Moves the library's shared design `slug` into workspace `into`, the
    /// one the user stops sharing it from (X95), under the next free slug
    /// there. Gives its slug there.
    pub fn unshare_design(&self, slug: &str, into: &str) -> Result<String> {
        self.move_design(LIBRARY, into, slug)
    }

    fn move_design(&self, from: &str, into: &str, slug: &str) -> Result<String> {
        if from == into {
            anyhow::bail!("the design is there already");
        }
        // It must be a design there.
        self.workspace_design(from, slug)?;
        let root = self.root()?.to_path_buf();
        let to = self.free_slug(into, "designs", ".records/designs", slug)?;
        self.move_item(&root, from, into, "designs", slug, &to, ".records/designs")?;
        if to != slug {
            let dir = self.kind_dir(into, "designs", false)?.join(&to);
            fsx::update_inside(&dir, Path::new(DESIGN_FILE), |text| {
                let mut doc: toml_edit::DocumentMut = text
                    .parse()
                    .with_context(|| format!("cannot read {DESIGN_FILE}"))?;
                let name = doc["name"].as_str().unwrap_or(slug).to_string();
                doc["name"] = toml_edit::value(format!("{name} {}", &to[slug.len() + 1..]));
                Ok(doc.to_string())
            })?;
        }
        Ok(to)
    }

    /// Points a session design at the library slug `to` of its design
    /// system, when its `design.toml` names `from`: the move into the library
    /// renamed that system (X95). The rest of the file is left as the agent
    /// wrote it, and its pinned styles are its own. Gives whether it changed.
    pub fn follow_renamed_system(&self, at: &DesignAt, from: &str, to: &str) -> Result<bool> {
        if self.design_config(at)?.system != from {
            return Ok(false);
        }
        fsx::update_inside(&at.root, &at.in_dir(DESIGN_FILE), |text| {
            let mut doc: toml_edit::DocumentMut = text
                .parse()
                .with_context(|| format!("cannot read {DESIGN_FILE}"))?;
            doc["system"] = toml_edit::value(to);
            Ok(doc.to_string())
        })?;
        Ok(true)
    }
}

fn read_journal(path: &Path) -> Result<Vec<ToLibrary>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(toml::from_str::<Journal>(&text)?.moved),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

fn write_journal(library: &Path, path: &Path, moved: &[ToLibrary]) -> Result<()> {
    let journal = Journal {
        moved: moved.to_vec(),
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
        // Until the daemon says it finished what follows, the next call
        // gives the same moves again; then nothing is left to move.
        assert_eq!(
            store
                .move_systems_to_library(&["a1b2c3d4e5f6".into()], &|_, _| true)
                .unwrap(),
            moved
        );
        store.library_move_done().unwrap();
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
            "[[moved]]\nworkspace = \"a1b2c3d4e5f6\"\nfrom = \"acme-web\"\nto = \"acme-web-2\"\n",
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
            "[[moved]]\nworkspace = \"a1b2c3d4e5f6\"\nfrom = \"acme-web\"\nto = \"acme-web-2\"\n",
        )
        .unwrap();
        let store = Store::new(h);

        let moved = store
            .move_systems_to_library(&["a1b2c3d4e5f6".into()], &|_, _| true)
            .unwrap();

        // The move done before the stop is given again, for what follows it.
        assert_eq!(
            moved,
            vec![ToLibrary {
                workspace: "a1b2c3d4e5f6".into(),
                from: "acme-web".into(),
                to: "acme-web-2".into(),
                agent: None
            }]
        );
        assert_eq!(
            store.designs("a1b2c3d4e5f6").unwrap()[0].system,
            "acme-web-2"
        );
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

    #[test]
    fn a_shared_design_moves_into_the_library_with_its_pages_and_history_and_back_into_a_workspace()
    {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let store = Store::new(h);
        store
            .create_system("a1b2c3d4e5f6", "Acme web", vec![], Cover::Core, 1)
            .unwrap();
        store
            .create_design("a1b2c3d4e5f6", "Pricing", "acme-web", "a pricing page", 2)
            .unwrap();
        // The library already shares a "Pricing".
        store
            .create_design(LIBRARY, "Pricing", "acme-web", "", 3)
            .unwrap();
        let page = "<link rel=\"stylesheet\" href=\"../../../systems/acme-web/styles.css\">\n";
        std::fs::write(
            h.join("design/a1b2c3d4e5f6/designs/pricing/pages/index.html"),
            page,
        )
        .unwrap();
        let at = store.workspace_design("a1b2c3d4e5f6", "pricing").unwrap();
        store
            .take_snapshot(&at, crate::design::history::Take::AgentTurn, 4)
            .unwrap()
            .unwrap();

        let shared = store.share_design("a1b2c3d4e5f6", "pricing").unwrap();

        assert_eq!(shared, "pricing-2");
        assert_eq!(store.designs("a1b2c3d4e5f6").unwrap(), vec![]);
        let names: Vec<(String, String)> = store
            .designs(LIBRARY)
            .unwrap()
            .into_iter()
            .map(|d| (d.slug, d.name))
            .collect();
        assert_eq!(
            names,
            vec![
                ("pricing".into(), "Pricing".into()),
                ("pricing-2".into(), "Pricing 2".into())
            ]
        );
        assert_eq!(read(h, "library/designs/pricing-2/pages/index.html"), page);
        let at = store.workspace_design(LIBRARY, "pricing-2").unwrap();
        assert_eq!(store.history(&at).unwrap().len(), 1);

        let back = store.unshare_design("pricing-2", "f6e5d4c3b2a1").unwrap();

        assert_eq!(back, "pricing-2");
        assert_eq!(store.designs("f6e5d4c3b2a1").unwrap()[0].name, "Pricing 2");
        assert_eq!(
            read(h, "f6e5d4c3b2a1/designs/pricing-2/pages/index.html"),
            page
        );
        assert_eq!(store.designs(LIBRARY).unwrap().len(), 1);
    }
}
