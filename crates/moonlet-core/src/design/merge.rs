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
    /// `into`, with their records. A slug `into` already has, as a folder
    /// or a record, gets the next free number, as a new one would (`acme-2`,
    /// named "Acme 2"), and the moved designs on a renamed system follow it.
    /// A moved item's record forgets its agent, whose folder moved away.
    /// Each item's record is written before its folder moves, and a move
    /// that stops midway finishes on the next call: the renamed systems are
    /// kept in `<from>/.records/merge.toml` until every design followed.
    /// Nothing to move is not an error; `from`'s folders go once empty.
    pub fn move_workspace(&self, from: &str, into: &str) -> Result<Vec<Moved>> {
        if from == into {
            bail!("a workspace cannot merge into itself");
        }
        let src = self.workspace(from)?;
        if std::fs::symlink_metadata(&src).is_err() {
            return Ok(Vec::new());
        }
        let root = self.root()?.to_path_buf();
        let journal = src.join(".records").join(JOURNAL);
        let mut renamed = read_journal(&journal)?;
        let mut moved = Vec::new();
        for slug in folders(&src.join("systems"))? {
            let to = self.free_slug(into, "systems", ".records", &slug)?;
            if to != slug {
                renamed.insert(slug.clone(), to.clone());
                write_journal(&src, &journal, &renamed)?;
            }
            self.move_item(&root, from, into, "systems", &slug, &to, ".records")?;
            if to != slug {
                let dir = self.kind_dir(into, "systems", false)?.join(&to);
                let mut config = read_config(&dir)?;
                config.name = format!("{} {}", config.name, number(&slug, &to));
                fsx::write_inside(
                    &dir,
                    &dir.join(CONFIG),
                    toml::to_string(&config)?.as_bytes(),
                )?;
            }
            moved.push(Moved {
                kind: "system",
                from: slug,
                to,
            });
        }
        for slug in folders(&src.join("designs"))? {
            // Pointed at its system's new slug while still here, so a stop
            // midway leaves it where the next call finds it.
            follow_system(&src.join("designs").join(&slug), &renamed)?;
            let to = self.free_slug(into, "designs", ".records/designs", &slug)?;
            self.move_item(&root, from, into, "designs", &slug, &to, ".records/designs")?;
            if to != slug {
                let dir = self.kind_dir(into, "designs", false)?.join(&to);
                let at = DesignAt::of_workspace(self.kind_dir(into, "designs", false)?, into, &to);
                let mut config = read_design_config(&at)?;
                config.name = format!("{} {}", config.name, number(&slug, &to));
                fsx::write_inside(
                    &dir,
                    &dir.join(DESIGN_FILE),
                    toml::to_string(&config)?.as_bytes(),
                )?;
            }
            moved.push(Moved {
                kind: "design",
                from: slug,
                to,
            });
        }
        match std::fs::remove_file(&journal) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        // Only folders left empty go: anything else stays where it was.
        for dir in ["systems", "designs", ".records/designs", ".records", ""] {
            let _ = std::fs::remove_dir(src.join(dir));
        }
        Ok(moved)
    }

    /// The first slug of `kind` in `workspace` that neither a folder nor a
    /// record (in `records`) has: `slug`, then `slug-2`, `slug-3`, ….
    fn free_slug(&self, workspace: &str, kind: &str, records: &str, slug: &str) -> Result<String> {
        let dest = self.kind_dir(workspace, kind, false)?;
        let recs = self.workspace(workspace)?.join(records);
        let taken = |s: &str| {
            std::fs::symlink_metadata(dest.join(s)).is_ok()
                || std::fs::symlink_metadata(recs.join(format!("{s}.toml"))).is_ok()
        };
        let mut n = 1;
        loop {
            let to = if n == 1 {
                slug.to_string()
            } else {
                format!("{slug}-{n}")
            };
            if !taken(&to) {
                return Ok(to);
            }
            n += 1;
        }
    }

    /// Moves `<from>/<kind>/<slug>` to `<into>/<kind>/<to>`, with its record
    /// (in `records`), which forgets its agent. The record is read and
    /// written first: one that cannot be read stops the move with nothing
    /// moved, and one written for a folder that then does not move is
    /// taken back.
    #[allow(clippy::too_many_arguments)]
    fn move_item(
        &self,
        root: &Path,
        from: &str,
        into: &str,
        kind: &str,
        slug: &str,
        to: &str,
        records: &str,
    ) -> Result<()> {
        let src = self.kind_dir(from, kind, false)?.join(slug);
        let dest = self.kind_dir(into, kind, true)?.join(to);
        let record = self
            .workspace(from)?
            .join(records)
            .join(format!("{slug}.toml"));
        let moved_record = self
            .workspace(into)?
            .join(records)
            .join(format!("{to}.toml"));
        let bytes = match std::fs::read(&record) {
            Ok(b) => Some(without_agent(&b)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                return Err(
                    anyhow::Error::from(e).context(format!("cannot read {}", record.display()))
                );
            }
        };
        if let Some(bytes) = &bytes {
            let ws = self.workspace(into)?;
            fsx::write_inside(&ws, &moved_record, bytes)?;
        }
        let renamed = fsx::rename_inside(root, &src, &dest);
        if !matches!(renamed, Ok(true)) {
            if bytes.is_some() {
                let _ = fsx::remove_file_inside(root, &moved_record);
            }
            return match renamed {
                Ok(_) => Err(anyhow::anyhow!(
                    "{} went away while it was moved",
                    src.display()
                )),
                Err(e) => Err(e),
            };
        }
        if bytes.is_some() && record != moved_record {
            fsx::remove_file_inside(root, &record)?;
        }
        Ok(())
    }

    /// Renames item `slug` of `kind` (`systems` or `designs`) in
    /// `workspace` to the next free slug (`acme-web-2`, named "Acme web 2"),
    /// with its record; a renamed system's designs for which `follows`
    /// holds point at its new slug. Gives the new slug.
    pub fn rename_item(
        &self,
        workspace: &str,
        kind: &str,
        slug: &str,
        follows: &dyn Fn(&str) -> bool,
    ) -> Result<String> {
        let records = if kind == "systems" {
            ".records"
        } else {
            ".records/designs"
        };
        let root = self.root()?.to_path_buf();
        let to = self.free_slug(workspace, kind, records, slug)?;
        self.move_item(&root, workspace, workspace, kind, slug, &to, records)?;
        let dir = self.kind_dir(workspace, kind, false)?.join(&to);
        if kind == "systems" {
            let mut config = read_config(&dir)?;
            config.name = format!("{} {}", config.name, number(slug, &to));
            fsx::write_inside(
                &dir,
                &dir.join(CONFIG),
                toml::to_string(&config)?.as_bytes(),
            )?;
            let renamed = BTreeMap::from([(slug.to_string(), to.clone())]);
            let designs = self.kind_dir(workspace, "designs", false)?;
            for d in folders(&designs)?.into_iter().filter(|d| follows(d)) {
                follow_system(&designs.join(&d), &renamed)?;
            }
        } else {
            let at =
                DesignAt::of_workspace(self.kind_dir(workspace, "designs", false)?, workspace, &to);
            let mut config = read_design_config(&at)?;
            config.name = format!("{} {}", config.name, number(slug, &to));
            fsx::write_inside(
                &dir,
                &dir.join(DESIGN_FILE),
                toml::to_string(&config)?.as_bytes(),
            )?;
        }
        Ok(to)
    }
}

/// Where a merge keeps the systems it renamed until every design followed.
const JOURNAL: &str = "merge.toml";

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Journal {
    #[serde(default)]
    renamed: BTreeMap<String, String>,
}

fn read_journal(path: &Path) -> Result<BTreeMap<String, String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(toml::from_str::<Journal>(&text)?.renamed),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.into()),
    }
}

fn write_journal(ws: &Path, path: &Path, renamed: &BTreeMap<String, String>) -> Result<()> {
    let journal = Journal {
        renamed: renamed.clone(),
    };
    fsx::write_inside(ws, path, toml::to_string(&journal)?.as_bytes())
}

/// A record without its agent (`agent`, `agent_launch`): its chat ran in a
/// folder that moved away.
fn without_agent(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut table: toml::Table = toml::from_str(&String::from_utf8_lossy(bytes))?;
    let agent = table.remove("agent").is_some();
    let launch = table.remove("agent_launch").is_some();
    if !agent && !launch {
        return Ok(bytes.to_vec());
    }
    Ok(toml::to_string(&table)?.into_bytes())
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

/// The files whose text may link a design system's files.
const LINKING: [&str; 6] = [".html", ".htm", ".css", ".svg", ".js", ".mjs"];

/// Points the design in `dir` at its system's new slug when `renamed` has
/// one: each relative link to the system (`../../../systems/<old>/`) in its
/// pages and text assets, snapshots in `history/` too, with each
/// snapshot's recorded hashes, so it still restores; then `design.toml`,
/// last, so a stop midway is finished by the next call. A URL that only
/// has the same path elsewhere is left alone.
fn follow_system(dir: &Path, renamed: &BTreeMap<String, String>) -> Result<()> {
    let config: super::designs::DesignConfig =
        toml::from_str(&fsx::read_inside(dir, &dir.join(DESIGN_FILE))?)?;
    let Some(to) = renamed.get(&config.system) else {
        return Ok(());
    };
    let link = regex::Regex::new(&format!(
        r"((?:\.\./)+systems/){}/",
        regex::escape(&config.system)
    ))?;
    let changed: BTreeMap<String, Vec<u8>> = fsx::read_tree(dir, Path::new(""))?
        .into_iter()
        .filter(|(path, _)| LINKING.iter().any(|ext| path.to_lowercase().ends_with(ext)))
        .filter_map(|(path, bytes)| {
            let text = String::from_utf8(bytes).ok()?;
            let new = link
                .replace_all(&text, format!("${{1}}{to}/").as_str())
                .into_owned();
            (new != text).then(|| (path, new.into_bytes()))
        })
        .collect();
    // A snapshot's hashes first: a stop before its file is written leaves
    // the file with its old link, which the next call rewrites.
    let mut snapshots: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for (path, bytes) in &changed {
        let mut parts = path.splitn(3, '/');
        let (Some(super::history::HISTORY_DIR), Some(n), Some(rel)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let record = format!(
            "{}/{n}/{}",
            super::history::HISTORY_DIR,
            super::history::RECORD_FILE
        );
        if !snapshots.contains_key(&record) {
            let text = fsx::read_inside(dir, &dir.join(&record))?;
            snapshots.insert(record.clone(), serde_json::from_str(&text)?);
        }
        if let Some(files) = snapshots
            .get_mut(&record)
            .and_then(|r| r.get_mut("files"))
            .and_then(|f| f.as_object_mut())
            && files.contains_key(rel)
        {
            files.insert(
                rel.to_string(),
                serde_json::Value::String(crate::hash::sha256_hex(bytes)),
            );
        }
    }
    for (record, value) in &snapshots {
        fsx::write_inside(
            dir,
            &dir.join(record),
            serde_json::to_string_pretty(value)?.as_bytes(),
        )?;
    }
    fsx::write_tree(dir, Path::new(""), Path::new(""), &changed, false)?;
    let mut config = config;
    config.system = to.clone();
    fsx::write_inside(
        dir,
        &dir.join(DESIGN_FILE),
        toml::to_string(&config)?.as_bytes(),
    )
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
    fn a_slug_whose_record_is_left_behind_is_taken_and_that_record_is_kept() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        store
            .create_system("w-mac", "Acme web", vec![source()], Cover::Core, 1)
            .unwrap();
        // w-mini lost its acme-web folder but kept its record.
        let orphan = home.path().join("design/w-mini/.records/acme-web.toml");
        std::fs::create_dir_all(orphan.parent().unwrap()).unwrap();
        std::fs::write(&orphan, "synced_at = 9\n").unwrap();

        let moved = store.move_workspace("w-mac", "w-mini").unwrap();

        assert_eq!(
            moved,
            vec![Moved {
                kind: "system",
                from: "acme-web".into(),
                to: "acme-web-2".into()
            }]
        );
        assert_eq!(std::fs::read_to_string(&orphan).unwrap(), "synced_at = 9\n");
        assert_eq!(
            store.record("w-mini", "acme-web-2").unwrap().sources,
            vec![source()]
        );
    }

    #[test]
    fn a_record_that_cannot_be_read_stops_the_move_with_nothing_moved() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        store
            .create_system("w-mac", "Acme web", vec![source()], Cover::Core, 1)
            .unwrap();
        let record = home.path().join("design/w-mac/.records/acme-web.toml");
        std::fs::set_permissions(&record, std::fs::Permissions::from_mode(0o000)).unwrap();

        let moved = store.move_workspace("w-mac", "w-mini");
        std::fs::set_permissions(&record, std::fs::Permissions::from_mode(0o600)).unwrap();

        assert!(moved.is_err());
        assert!(
            home.path()
                .join("design/w-mac/systems/acme-web/config.toml")
                .exists()
        );
        assert!(!home.path().join("design/w-mini/systems/acme-web").exists());
    }

    #[test]
    fn a_moved_items_agent_is_forgotten_so_a_new_one_starts_in_its_new_place() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        store
            .create_system("w-mac", "Acme web", vec![], Cover::Core, 1)
            .unwrap();
        store.set_agent("w-mac", "acme-web", 7, "launch").unwrap();
        store.move_workspace("w-mac", "w-mini").unwrap();
        assert_eq!(store.record("w-mini", "acme-web").unwrap().agent, None);
        assert_eq!(
            store.record("w-mini", "acme-web").unwrap().agent_launch,
            None
        );
    }

    #[test]
    fn only_a_designs_own_links_to_a_renamed_system_change_and_its_snapshots_still_restore() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        store
            .create_system("w-mini", "Acme web", vec![], Cover::Core, 1)
            .unwrap();
        store
            .create_system("w-mac", "Acme web", vec![], Cover::Core, 2)
            .unwrap();
        store
            .create_design("w-mac", "Checkout", "acme-web", "", 3)
            .unwrap();
        let design = home.path().join("design/w-mac/designs/checkout");
        let page = "<link rel=\"stylesheet\" href=\"../../../systems/acme-web/styles.css\">\n<a href=\"https://example.test/systems/acme-web/docs\">docs</a>\n";
        std::fs::write(design.join("pages/index.html"), page).unwrap();
        std::fs::write(
            design.join("assets/extra.css"),
            "@import \"../../../../systems/acme-web/tokens/colors.css\";\n",
        )
        .unwrap();
        let at = store.workspace_design("w-mac", "checkout").unwrap();
        store
            .take_snapshot(&at, crate::design::history::Take::AgentTurn, 4)
            .unwrap()
            .unwrap();

        store.move_workspace("w-mac", "w-mini").unwrap();

        let moved = home.path().join("design/w-mini/designs/checkout");
        assert_eq!(
            std::fs::read_to_string(moved.join("pages/index.html")).unwrap(),
            "<link rel=\"stylesheet\" href=\"../../../systems/acme-web-2/styles.css\">\n<a href=\"https://example.test/systems/acme-web/docs\">docs</a>\n"
        );
        assert_eq!(
            std::fs::read_to_string(moved.join("assets/extra.css")).unwrap(),
            "@import \"../../../../systems/acme-web-2/tokens/colors.css\";\n"
        );
        let at = store.workspace_design("w-mini", "checkout").unwrap();
        let snapshot = store.history(&at).unwrap()[0].n;
        store
            .restore_snapshot(&at, snapshot, crate::design::history::Take::AgentTurn, 5)
            .unwrap();
    }

    #[test]
    fn a_move_stopped_after_its_systems_went_finishes_its_designs_on_the_next_try() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        store
            .create_system("w-mini", "Acme web", vec![], Cover::Core, 1)
            .unwrap();
        store
            .create_system("w-mini", "Acme web 2", vec![], Cover::Core, 2)
            .unwrap();
        let checkout = home.path().join("design/w-mac/designs/checkout");
        std::fs::create_dir_all(checkout.join("pages")).unwrap();
        std::fs::write(
            checkout.join("design.toml"),
            "name = \"Checkout\"\nsystem = \"acme-web\"\n",
        )
        .unwrap();
        // The systems moved (acme-web became acme-web-2) before the move stopped.
        let journal = home.path().join("design/w-mac/.records/merge.toml");
        std::fs::create_dir_all(journal.parent().unwrap()).unwrap();
        std::fs::write(&journal, "[renamed]\nacme-web = \"acme-web-2\"\n").unwrap();

        store.move_workspace("w-mac", "w-mini").unwrap();

        let designs = store.designs("w-mini").unwrap();
        assert_eq!(designs[0].system, "acme-web-2");
        assert!(!home.path().join("design/w-mac").exists());
    }

    #[test]
    fn a_renamed_system_takes_the_next_number_and_only_the_designs_asked_follow_it() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        store
            .create_system("w-mac", "Acme web", vec![], Cover::Core, 1)
            .unwrap();
        store
            .create_design("w-mac", "Checkout", "acme-web", "", 2)
            .unwrap();
        store
            .create_design("w-mac", "Billing", "acme-web", "", 3)
            .unwrap();

        let to = store
            .rename_item("w-mac", "systems", "acme-web", &|d| d == "checkout")
            .unwrap();

        assert_eq!(to, "acme-web-2");
        let names: Vec<(String, String)> = store
            .systems("w-mac")
            .unwrap()
            .into_iter()
            .map(|s| (s.slug, s.name))
            .collect();
        assert_eq!(names, vec![("acme-web-2".into(), "Acme web 2".into())]);
        let systems: Vec<(String, String)> = store
            .designs("w-mac")
            .unwrap()
            .into_iter()
            .map(|d| (d.slug, d.system))
            .collect();
        assert_eq!(
            systems,
            vec![
                ("billing".into(), "acme-web".into()),
                ("checkout".into(), "acme-web-2".into())
            ]
        );
    }

    #[test]
    fn a_workspace_with_no_design_folder_moves_nothing() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        assert_eq!(store.move_workspace("w-none", "w-mini").unwrap(), vec![]);
        assert!(!home.path().join("design/w-mini").exists());
    }
}
