//! The sessions a member asked the central host to give it
//! (`session.take`) and has neither taken in nor handed back yet (X73), in
//! `$MOONLET_HOME/takes.json`: each with the ownership number it asked at
//! and when. Written down before the take is sent and cleared once the
//! bring is settled, so a bring cut off half way, by a lost answer, a
//! timeout, a sleep or the daemon stopping, is finished or handed back
//! (`session.give_back`) once the central host is heard from.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// How long after a take was sent the central host may still be giving
/// the session up, its answer long gone: past the link's 60 s for an
/// answer, and some.
pub const LATE_MS: u64 = 120_000;

/// One take in flight: the ownership number it asked at, and when it was
/// sent, in ms since the epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Take {
    pub epoch: u64,
    pub at: u64,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Data {
    #[serde(default)]
    sessions: BTreeMap<String, Take>,
}

pub struct Takes {
    file: PathBuf,
    data: Mutex<Data>,
}

impl Takes {
    /// The takes kept in `home`'s `takes.json`; none when it is missing or
    /// cannot be read.
    pub fn open(home: &Path) -> Takes {
        let file = home.join("takes.json");
        let data = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Takes {
            file,
            data: Mutex::new(data),
        }
    }

    /// Each take in flight, by session.
    pub fn pending(&self) -> BTreeMap<String, Take> {
        self.data.lock().unwrap().sessions.clone()
    }

    /// Notes the take of `session` at ownership number `epoch`, sent at
    /// `at`, before it is sent.
    pub fn add(&self, session: &str, epoch: u64, at: u64) {
        let mut data = self.data.lock().unwrap();
        data.sessions.insert(session.to_string(), Take { epoch, at });
        self.save(&data);
    }

    /// Forgets the take of `session`: taken in, handed back, or refused.
    pub fn remove(&self, session: &str) {
        let mut data = self.data.lock().unwrap();
        if data.sessions.remove(session).is_some() {
            self.save(&data);
        }
    }

    fn save(&self, data: &Data) {
        let write = || -> std::io::Result<()> {
            crate::moves::write_whole(&self.file, &serde_json::to_vec_pretty(data)?)
        };
        if let Err(e) = write() {
            tracing::warn!("cannot save {}: {e}", self.file.display());
        }
    }
}

/// What member `me` does about a session after a take that may have been
/// cut off half way, or one its record names it the owner of (X73).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settle {
    /// The account names this member, and it does not run the session:
    /// handed back at that ownership number.
    GiveBack(u64),
    /// The central host may still be giving it up: looked at again later.
    Wait,
    /// Nothing to do: taken in, never taken, or moved on since.
    Done,
}

/// What member `me` does about a session whose record is `known` (none
/// when the account has none), that it runs here when `held`, with `take`
/// in flight or none, at `now` ms since the epoch.
pub fn settle(
    take: Option<&Take>,
    known: Option<&crate::power::Known>,
    held: bool,
    me: &str,
    now: u64,
) -> Settle {
    let Some(k) = known.filter(|k| !k.archived) else {
        return Settle::Done;
    };
    if k.owner == Some(me) {
        return if held { Settle::Done } else { Settle::GiveBack(k.epoch) };
    }
    match take {
        Some(t) if k.epoch == t.epoch && now.saturating_sub(t.at) < LATE_MS => Settle::Wait,
        _ => Settle::Done,
    }
}

/// How often a hand-back that fails, other than unheard, is sent before
/// it is left until the daemon starts again: a minute of looks.
pub const BACK_TRIES: u32 = 12;

/// Whether `code`, a take's error, is the central host's refusal made
/// while the session was still its own at the number asked: nothing was
/// given, the take is over. Not `stale` nor `elsewhere`: the session may
/// have gone to this very member, by an earlier take whose answer was
/// lost.
pub fn refused(code: &str) -> bool {
    matches!(code, "busy" | "used" | "pinned")
}

/// Whether `code`, an error of a request to the central host, says it was
/// not heard, or its answer not: the link is down or timed out.
pub fn unheard(code: &str) -> bool {
    matches!(code, "disconnected" | "timeout" | "unreachable")
}

/// Whether `code`, a hand-back's error, is the central host's final word:
/// it did not give the session to be handed back, or it moved since.
pub fn back_refused(code: &str) -> bool {
    matches!(code, "not_given" | "elsewhere" | "stale" | "not_found" | "forbidden" | "invalid_params")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::power::Known;

    const BOOK: &str = "7d3f1c2a";
    const MINI: &str = "3c9a5e71";

    fn known(owner: &str, epoch: u64) -> Known<'_> {
        Known {
            owner: Some(owner),
            epoch,
            pinned: false,
            archived: false,
        }
    }

    #[test]
    fn a_take_is_kept_across_a_restart_until_it_is_settled() {
        let home = tempfile::tempdir().unwrap();
        let takes = Takes::open(home.path());
        takes.add("fix-cart", 3, 1_000);
        drop(takes);

        let again = Takes::open(home.path());
        assert_eq!(
            again.pending(),
            BTreeMap::from([("fix-cart".to_string(), Take { epoch: 3, at: 1_000 })])
        );
        again.remove("fix-cart");
        assert!(Takes::open(home.path()).pending().is_empty());
    }

    #[test]
    fn a_bring_cut_off_half_way_is_handed_back_waited_on_or_dropped() {
        let take = Take { epoch: 4, at: 10_000 };
        let soon = 10_000 + 5_000;
        let late = 10_000 + LATE_MS;
        let cases: [(&str, Option<&Take>, Option<Known>, bool, u64, Settle); 9] = [
            // The central host gave it up, and this Mac never took it in.
            ("given, not here", Some(&take), Some(known(BOOK, 5)), false, soon, Settle::GiveBack(5)),
            ("given, taken in", Some(&take), Some(known(BOOK, 5)), true, soon, Settle::Done),
            // Its answer may still come: it waits, for a while.
            ("not given yet", Some(&take), Some(known(MINI, 4)), false, soon, Settle::Wait),
            ("not given in time", Some(&take), Some(known(MINI, 4)), false, late, Settle::Done),
            // Handed back, or moved on, meanwhile.
            ("handed back", Some(&take), Some(known(MINI, 6)), false, soon, Settle::Done),
            ("gone", Some(&take), None, false, soon, Settle::Done),
            // With no take in flight, a record naming this Mac for a session
            // it does not run, as an older version left it, is handed back.
            ("stranded before", None, Some(known(BOOK, 9)), false, soon, Settle::GiveBack(9)),
            ("this Mac's own", None, Some(known(BOOK, 9)), true, soon, Settle::Done),
            ("another's", None, Some(known(MINI, 9)), false, soon, Settle::Done),
        ];
        for (what, take, known, held, now, want) in cases {
            assert_eq!(settle(take, known.as_ref(), held, BOOK, now), want, "{what}");
        }
        let archived = Known { archived: true, ..known(BOOK, 5) };
        assert_eq!(settle(Some(&take), Some(&archived), false, BOOK, soon), Settle::Done);
    }

    #[test]
    fn only_a_refusal_made_while_the_session_was_still_there_ends_a_take() {
        // The central host's own at the number asked: nothing given.
        for code in ["busy", "used", "pinned"] {
            assert!(refused(code), "{code}");
        }
        // It may have gone to this member by an earlier take, or the
        // answer was lost: looked at.
        for code in ["stale", "elsewhere", "timeout", "disconnected", "failed"] {
            assert!(!refused(code), "{code}");
        }
        assert!(unheard("timeout") && unheard("disconnected") && !unheard("not_given"));
        assert!(back_refused("not_given") && back_refused("stale") && !back_refused("failed"));
    }
}
