//! Requests the boards of one connection share (X50 Sync): a tracker answer
//! that is the same for every board, or for a board's two reads (the user's
//! issues and everyone's), is asked once and kept a while. Refresh forgets
//! them all.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex};

/// How long a Jira GET's answer is kept, in ms, or `None` for one that is
/// asked each time. Who the user is, a board's configuration and its filter
/// are kept for one sync; the site's statuses and fields, which rarely
/// change, for 10 minutes.
pub fn shared_for(path: &str) -> Option<u64> {
    const SYNC: u64 = 15_000;
    const SITE: u64 = 600_000;
    let board_config = path.strip_prefix("/rest/agile/1.0/board/").is_some_and(|rest| rest.ends_with("/configuration"));
    match path {
        "/rest/api/3/myself" => Some(SYNC),
        "/rest/api/3/status" | "/rest/api/3/field" => Some(SITE),
        _ if board_config || path.starts_with("/rest/api/3/filter/") => Some(SYNC),
        _ => None,
    }
}

type Slot = Arc<tokio::sync::Mutex<Option<(u64, Vec<u8>)>>>;

/// Answers kept by key (`<connection> <path>`).
#[derive(Default)]
pub struct Shared {
    slots: Mutex<HashMap<String, Slot>>,
}

impl Shared {
    /// The answer kept for `key` if it is younger than `keep_ms`, else
    /// `fetch`'s, kept if it worked. A read of the same key that comes while
    /// one is under way waits for it.
    pub async fn get<E, F, Fut>(&self, key: &str, keep_ms: u64, now: impl Fn() -> u64, fetch: F) -> Result<Vec<u8>, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<u8>, E>>,
    {
        let slot = self.slots.lock().unwrap().entry(key.to_string()).or_default().clone();
        let mut kept = slot.lock().await;
        if let Some((at, answer)) = kept.as_ref() {
            if now().saturating_sub(*at) < keep_ms {
                return Ok(answer.clone());
            }
        }
        let answer = fetch().await?;
        *kept = Some((now(), answer.clone()));
        Ok(answer)
    }

    /// Forgets the answers whose key starts with `prefix` (`""`: all).
    pub fn forget(&self, prefix: &str) {
        self.slots.lock().unwrap().retain(|key, _| !key.starts_with(prefix));
    }
}

/// The app's shared answers.
pub static SHARED: LazyLock<Shared> = LazyLock::new(Shared::default);

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn jiras_lookups_are_kept_and_its_searches_and_moves_are_not() {
        assert_eq!(shared_for("/rest/api/3/myself"), Some(15_000));
        assert_eq!(shared_for("/rest/agile/1.0/board/10/configuration"), Some(15_000));
        assert_eq!(shared_for("/rest/api/3/filter/10021"), Some(15_000));
        assert_eq!(shared_for("/rest/api/3/status"), Some(600_000));
        assert_eq!(shared_for("/rest/api/3/field"), Some(600_000));
        assert_eq!(shared_for("/rest/api/3/search/jql"), None);
        assert_eq!(shared_for("/rest/api/3/issue/OPS-1/transitions"), None);
        assert_eq!(shared_for("/rest/agile/1.0/board?startAt=0"), None);
    }

    #[tokio::test]
    async fn two_reads_at_once_ask_the_tracker_once() {
        let shared = Shared::default();
        let slow = || async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            Ok::<_, String>(b"first".to_vec())
        };
        let (one, two) = tokio::join!(
            shared.get("jira:acme /rest/api/3/myself", 15_000, || 1_000, slow),
            shared.get("jira:acme /rest/api/3/myself", 15_000, || 1_000, || async { Ok::<_, String>(b"second".to_vec()) }),
        );
        assert_eq!((one.unwrap(), two.unwrap()), (b"first".to_vec(), b"first".to_vec()));
    }

    #[tokio::test]
    async fn an_answer_is_kept_for_its_time_a_failure_not_at_all_and_forget_asks_again() {
        let shared = Shared::default();
        let clock = AtomicU64::new(1_000);
        let now = || clock.load(Ordering::SeqCst);
        let answer = |text: &'static str| move || async move { Ok::<_, String>(text.as_bytes().to_vec()) };
        let key = "jira:acme /rest/api/3/status";
        // A failure is not kept.
        assert_eq!(shared.get(key, 600_000, now, || async { Err::<Vec<u8>, _>("502".to_string()) }).await, Err("502".to_string()));
        assert_eq!(shared.get(key, 600_000, now, answer("a")).await.unwrap(), b"a");
        clock.store(600_999, Ordering::SeqCst);
        assert_eq!(shared.get(key, 600_000, now, answer("b")).await.unwrap(), b"a");
        clock.store(601_000, Ordering::SeqCst);
        assert_eq!(shared.get(key, 600_000, now, answer("c")).await.unwrap(), b"c");
        // Another connection's answers stay; this one's are asked again.
        assert_eq!(shared.get("jira:ops /rest/api/3/status", 600_000, now, answer("ops")).await.unwrap(), b"ops");
        shared.forget("jira:acme ");
        assert_eq!(shared.get(key, 600_000, now, answer("d")).await.unwrap(), b"d");
        assert_eq!(shared.get("jira:ops /rest/api/3/status", 600_000, now, answer("x")).await.unwrap(), b"ops");
        shared.forget("");
        assert_eq!(shared.get("jira:ops /rest/api/3/status", 600_000, now, answer("y")).await.unwrap(), b"y");
    }
}
