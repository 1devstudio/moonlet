//! Requests the boards of one connection share within a sync (X50 Sync): a
//! tracker answer that is the same for every board, or for a board's two
//! reads (the user's issues and everyone's), is asked once a sync. The next
//! sync asks again, so a revoked token or a board changed in the tracker
//! shows at once.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex};

/// Whether a Jira GET is asked once a sync rather than by each read: who the
/// user is, the site's statuses and fields, a board's configuration and its
/// filter. Searches and moves are each the read's own.
pub fn shared_in_a_sync(path: &str) -> bool {
    let board_config = path.strip_prefix("/rest/agile/1.0/board/").is_some_and(|rest| rest.ends_with("/configuration"));
    matches!(path, "/rest/api/3/myself" | "/rest/api/3/status" | "/rest/api/3/field") || board_config || path.starts_with("/rest/api/3/filter/")
}

/// How long a sync's answers are held: well past any sync's own reads.
const HELD_MS: u64 = 60_000;

type Slot = Arc<tokio::sync::Mutex<Option<Vec<u8>>>>;

/// A sync's answers, by key (`<connection> <sync> <what>`), each with when it was first asked.
#[derive(Default)]
pub struct SyncAnswers {
    slots: Mutex<HashMap<String, (u64, Slot)>>,
}

impl SyncAnswers {
    /// The answer for `key` if a read already got it, else `fetch`'s, kept if
    /// it worked. A read of the same key that comes while one is under way
    /// waits for it.
    pub async fn get<E, F, Fut>(&self, key: &str, now: impl Fn() -> u64, fetch: F) -> Result<Vec<u8>, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<u8>, E>>,
    {
        let slot = {
            let mut slots = self.slots.lock().unwrap();
            // Earlier syncs' answers go.
            let at = now();
            slots.retain(|_, (asked, _)| at.saturating_sub(*asked) < HELD_MS);
            slots.entry(key.to_string()).or_insert_with(|| (at, Slot::default())).1.clone()
        };
        let mut kept = slot.lock().await;
        if let Some(answer) = kept.as_ref() {
            return Ok(answer.clone());
        }
        let answer = fetch().await?;
        *kept = Some(answer.clone());
        Ok(answer)
    }
}

/// The app's sync answers.
pub static SYNC_ANSWERS: LazyLock<SyncAnswers> = LazyLock::new(SyncAnswers::default);

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn jiras_lookups_are_shared_in_a_sync_and_its_searches_and_moves_are_not() {
        for path in ["/rest/api/3/myself", "/rest/api/3/status", "/rest/api/3/field", "/rest/agile/1.0/board/10/configuration", "/rest/api/3/filter/10021"] {
            assert!(shared_in_a_sync(path), "{path}");
        }
        for path in ["/rest/api/3/search/jql", "/rest/api/3/issue/OPS-1/transitions", "/rest/agile/1.0/board?startAt=0", "/rest/api/3/project/OPS/statuses"] {
            assert!(!shared_in_a_sync(path), "{path}");
        }
    }

    #[tokio::test]
    async fn two_reads_at_once_ask_the_tracker_once() {
        let answers = SyncAnswers::default();
        let slow = || async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            Ok::<_, String>(b"first".to_vec())
        };
        let (one, two) = tokio::join!(
            answers.get("jira:acme 7 /rest/api/3/myself", || 1_000, slow),
            answers.get("jira:acme 7 /rest/api/3/myself", || 1_000, || async { Ok::<_, String>(b"second".to_vec()) }),
        );
        assert_eq!((one.unwrap(), two.unwrap()), (b"first".to_vec(), b"first".to_vec()));
    }

    #[tokio::test]
    async fn a_syncs_answer_serves_that_sync_only_and_a_failure_is_not_kept() {
        let answers = SyncAnswers::default();
        let clock = AtomicU64::new(1_000);
        let now = || clock.load(Ordering::SeqCst);
        let answer = |text: &'static str| move || async move { Ok::<_, String>(text.as_bytes().to_vec()) };
        assert_eq!(answers.get("jira:acme 7 /rest/api/3/status", now, || async { Err::<Vec<u8>, _>("502".to_string()) }).await, Err("502".to_string()));
        assert_eq!(answers.get("jira:acme 7 /rest/api/3/status", now, answer("a")).await.unwrap(), b"a");
        assert_eq!(answers.get("jira:acme 7 /rest/api/3/status", now, answer("b")).await.unwrap(), b"a");
        // The next sync asks again.
        assert_eq!(answers.get("jira:acme 8 /rest/api/3/status", now, answer("c")).await.unwrap(), b"c");
        // A minute on, nothing is held.
        clock.store(61_000, Ordering::SeqCst);
        assert_eq!(answers.get("jira:acme 7 /rest/api/3/status", now, answer("d")).await.unwrap(), b"d");
    }
}
