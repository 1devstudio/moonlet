//! The sessions a member handed to the central host before a sleep and has
//! not heard answered yet (X73), in `$MOONLET_HOME/moves.json`: each with
//! the ownership number it had as it was handed over. Written down before
//! the hand-over is sent, and cleared once the central host answers it, so
//! a hand-over cut off by the end of the sleep's hold, or by the daemon
//! stopping, is sent again at the next wake or start. One whose agents went
//! on here with no answer is withdrawn: never sent again, but looked at
//! once the central host is heard from, in case it took it all the same.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Data {
    #[serde(default)]
    sessions: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    withdrawn: BTreeMap<String, u64>,
}

pub struct Moves {
    file: PathBuf,
    data: Mutex<Data>,
}

impl Moves {
    /// The hand-overs kept in `home`'s `moves.json`; none when it is
    /// missing or cannot be read.
    pub fn open(home: &Path) -> Moves {
        let file = home.join("moves.json");
        let data = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Moves {
            file,
            data: Mutex::new(data),
        }
    }

    /// Each session handed over and not answered yet, with its ownership
    /// number as it was handed over.
    pub fn pending(&self) -> BTreeMap<String, u64> {
        self.data.lock().unwrap().sessions.clone()
    }

    /// The hand-overs withdrawn with no answer, each with its ownership
    /// number as it was handed over.
    pub fn withdrawn(&self) -> BTreeMap<String, u64> {
        self.data.lock().unwrap().withdrawn.clone()
    }

    /// Notes `sessions` as handed over, before the hand-over is sent.
    pub fn add(&self, sessions: &[(String, u64)]) {
        let mut data = self.data.lock().unwrap();
        for (id, epoch) in sessions {
            data.withdrawn.remove(id);
            data.sessions.insert(id.clone(), *epoch);
        }
        self.save(&data);
    }

    /// Withdraws the hand-over of `sessions`, not answered: their agents go
    /// on here. It is never sent again.
    pub fn withdraw<'a>(&self, sessions: impl IntoIterator<Item = &'a str>) {
        let mut data = self.data.lock().unwrap();
        let mut changed = false;
        for id in sessions {
            if let Some(epoch) = data.sessions.remove(id) {
                data.withdrawn.insert(id.to_string(), epoch);
                changed = true;
            }
        }
        if changed {
            self.save(&data);
        }
    }

    /// Forgets the hand-over of `sessions`, withdrawn or not: answered, or
    /// settled.
    pub fn remove<'a>(&self, sessions: impl IntoIterator<Item = &'a str>) {
        let mut data = self.data.lock().unwrap();
        let before = data.sessions.len() + data.withdrawn.len();
        for id in sessions {
            data.sessions.remove(id);
            data.withdrawn.remove(id);
        }
        if data.sessions.len() + data.withdrawn.len() != before {
            self.save(&data);
        }
    }

    fn save(&self, data: &Data) {
        let write = || -> std::io::Result<()> {
            write_whole(&self.file, &serde_json::to_vec_pretty(data)?)
        };
        if let Err(e) = write() {
            tracing::warn!("cannot save {}: {e}", self.file.display());
        }
    }
}

/// Writes `bytes` to `path` whole or not at all: into a file beside it,
/// flushed to the disk, then renamed over it. A crash leaves the old file
/// or the new one, never half of one.
pub(crate) fn write_whole(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("json.tmp");
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path)?;
    // The rename itself reaches the disk with its folder.
    if let Some(dir) = path.parent() {
        std::fs::File::open(dir)?.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hand_over_is_kept_across_a_restart_until_it_is_answered() {
        let home = tempfile::tempdir().unwrap();
        let moves = Moves::open(home.path());
        moves.add(&[("fix-cart".into(), 3), ("big-refactor".into(), 1)]);
        drop(moves);

        let again = Moves::open(home.path());
        assert_eq!(
            again.pending(),
            BTreeMap::from([("big-refactor".to_string(), 1), ("fix-cart".to_string(), 3)])
        );
        again.remove(["fix-cart"]);
        assert_eq!(
            Moves::open(home.path()).pending(),
            BTreeMap::from([("big-refactor".to_string(), 1)])
        );
        // Its agents went on here with no answer: never sent again, but
        // still looked at.
        again.withdraw(["big-refactor"]);
        let after = Moves::open(home.path());
        assert!(after.pending().is_empty());
        assert_eq!(
            after.withdrawn(),
            BTreeMap::from([("big-refactor".to_string(), 1)])
        );
        let text = std::fs::read_to_string(home.path().join("moves.json")).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            serde_json::json!({ "sessions": {}, "withdrawn": { "big-refactor": 1 } })
        );
        after.remove(["big-refactor"]);
        assert!(Moves::open(home.path()).withdrawn().is_empty());
    }

    #[test]
    fn a_write_cut_off_by_a_crash_leaves_the_last_whole_file() {
        let home = tempfile::tempdir().unwrap();
        Moves::open(home.path()).add(&[("fix-cart".into(), 2)]);
        // A crash in the middle of the next write leaves half of it beside
        // the file, never in it.
        std::fs::write(
            home.path().join("moves.json.tmp"),
            br#"{ "sessions": { "fix-ca"#,
        )
        .unwrap();

        let moves = Moves::open(home.path());
        assert_eq!(
            moves.pending(),
            BTreeMap::from([("fix-cart".to_string(), 2)])
        );
        moves.add(&[("docs".into(), 1)]);
        assert_eq!(
            Moves::open(home.path()).pending(),
            BTreeMap::from([("docs".to_string(), 1), ("fix-cart".to_string(), 2)])
        );
    }
}
