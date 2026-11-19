//! What the daemon last heard from GitHub about each session's pull request
//! and about PR stacks (X108), kept in `prs.json` beside `state.json`. It is
//! this host's own cache, not part of the account state: an unreadable file
//! starts it empty, and GitHub is asked again.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Mutex;

use moonlet_proto::types::{PrStack, PullRequest};
use serde::{Deserialize, Serialize};

/// How long a saved stack with an open PR in it, or a PR found not to be in
/// a stack, answers for every asker before GitHub is asked again.
pub const STACK_FRESH_MS: u64 = 60_000;

/// A session's PR as last heard, `None` when it had none, and when.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KnownPr {
    pub pr: Option<PullRequest>,
    pub checked_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KnownStack {
    stack: PrStack,
    checked_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Saved {
    /// By session id.
    #[serde(default)]
    sessions: BTreeMap<String, KnownPr>,
    /// By project id: stack numbers belong to the project's GitHub repository.
    #[serde(default)]
    stacks: BTreeMap<String, Vec<KnownStack>>,
    /// `<project id>#<PR number>` → when that PR was found in no stack.
    #[serde(default)]
    unstacked: BTreeMap<String, u64>,
}

pub struct PrCache {
    file: PathBuf,
    saved: Mutex<Saved>,
}

/// Whether a stack saved `age_ms` ago answers without asking GitHub: it is
/// fresh, or no PR in it is open, so it cannot change any more.
pub fn stack_fresh(stack: &PrStack, age_ms: u64) -> bool {
    age_ms < STACK_FRESH_MS || !stack.prs.iter().any(|p| p.state == "open")
}

/// `stack` as seen from PR `number`: its 1-based position (1 is closest to
/// the base) and the stack's size, or `None` when it is not in the stack.
pub fn stack_at(stack: &PrStack, number: u64) -> Option<PrStack> {
    let position = stack.prs.iter().position(|p| p.number == number)? as u64 + 1;
    Some(PrStack {
        position,
        size: stack.prs.len() as u64,
        ..stack.clone()
    })
}

fn unstacked_key(project: &str, number: u64) -> String {
    format!("{project}#{number}")
}

impl PrCache {
    pub fn load(file: PathBuf) -> Self {
        let saved = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        PrCache {
            file,
            saved: Mutex::new(saved),
        }
    }

    /// The saved answer for session `id`.
    pub fn session(&self, id: &str) -> Option<KnownPr> {
        self.saved.lock().unwrap().sessions.get(id).cloned()
    }

    /// Every saved answer of the sessions in `live`.
    pub fn sessions(&self, live: &BTreeSet<String>) -> BTreeMap<String, KnownPr> {
        let saved = self.saved.lock().unwrap();
        saved
            .sessions
            .iter()
            .filter(|(id, _)| live.contains(*id))
            .map(|(id, k)| (id.clone(), k.clone()))
            .collect()
    }

    /// Saves session `id`'s PR, and drops the sessions not in `live`.
    pub fn set_session(
        &self,
        id: &str,
        pr: Option<PullRequest>,
        now: u64,
        live: &BTreeSet<String>,
    ) {
        let mut saved = self.saved.lock().unwrap();
        saved.sessions.retain(|id, _| live.contains(id));
        saved.sessions.insert(
            id.to_string(),
            KnownPr {
                pr,
                checked_at: now,
            },
        );
        self.save(&saved);
    }

    /// The saved stack of `project` holding PR `number`, as seen from it,
    /// and when it was fetched.
    pub fn stack(&self, project: &str, number: u64) -> Option<(PrStack, u64)> {
        let saved = self.saved.lock().unwrap();
        saved
            .stacks
            .get(project)?
            .iter()
            .find_map(|k| Some((stack_at(&k.stack, number)?, k.checked_at)))
    }

    /// When PR `number` of `project` was last found in no stack.
    pub fn unstacked_at(&self, project: &str, number: u64) -> Option<u64> {
        let saved = self.saved.lock().unwrap();
        saved
            .unstacked
            .get(&unstacked_key(project, number))
            .copied()
    }

    /// Saves `stack`, fetched at `now`, in place of its older copy.
    pub fn set_stack(&self, project: &str, stack: &PrStack, now: u64) {
        let mut saved = self.saved.lock().unwrap();
        for p in &stack.prs {
            saved.unstacked.remove(&unstacked_key(project, p.number));
        }
        let stacks = saved.stacks.entry(project.to_string()).or_default();
        stacks.retain(|k| k.stack.number != stack.number);
        stacks.push(KnownStack {
            stack: stack.clone(),
            checked_at: now,
        });
        self.save(&saved);
    }

    /// Saves that PR `number` of `project` was in no stack at `now`.
    pub fn set_unstacked(&self, project: &str, number: u64, now: u64) {
        let mut saved = self.saved.lock().unwrap();
        saved.unstacked.insert(unstacked_key(project, number), now);
        self.save(&saved);
    }

    /// Writes the file whole; a failure only costs asking GitHub again.
    fn save(&self, saved: &Saved) {
        let write = || -> anyhow::Result<()> {
            if let Some(dir) = self.file.parent() {
                crate::paths::ensure_private_dir(dir)?;
            }
            let tmp = self.file.with_extension("json.tmp");
            crate::paths::write_whole(&self.file, &tmp, &serde_json::to_vec(saved)?, 0o600)?;
            Ok(())
        };
        if let Err(e) = write() {
            tracing::warn!("could not save {}: {e:#}", self.file.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use moonlet_proto::types::StackPr;

    fn stack(states: &[&str]) -> PrStack {
        PrStack {
            number: 4,
            base: "main".into(),
            position: 0,
            size: states.len() as u64,
            prs: states
                .iter()
                .enumerate()
                .map(|(i, s)| StackPr {
                    number: 11 + i as u64,
                    title: format!("Part {}", i + 1),
                    url: format!("https://github.com/acme/web/pull/{}", 11 + i),
                    state: s.to_string(),
                    draft: false,
                    branch: format!("moonlet/part-{}", i + 1),
                })
                .collect(),
        }
    }

    #[test]
    fn a_stack_with_an_open_pr_answers_for_a_minute() {
        let s = stack(&["merged", "open"]);
        assert!(stack_fresh(&s, 0));
        assert!(stack_fresh(&s, 59_999));
        assert!(!stack_fresh(&s, 60_000));
    }

    #[test]
    fn a_stack_with_no_open_pr_answers_for_good() {
        assert!(stack_fresh(&stack(&["merged", "merged"]), 30 * 86_400_000));
        assert!(stack_fresh(&stack(&["merged", "closed"]), 30 * 86_400_000));
    }

    #[test]
    fn a_saved_stack_is_seen_from_the_asked_pr() {
        let s = stack(&["merged", "open", "open"]);
        let at = stack_at(&s, 12).unwrap();
        assert_eq!((at.position, at.size), (2, 3));
        assert_eq!(stack_at(&s, 11).unwrap().position, 1);
        assert!(stack_at(&s, 99).is_none());
    }

    #[test]
    fn an_unreadable_file_starts_empty_and_is_written_again() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("prs.json");
        std::fs::write(&file, "{ not json").unwrap();
        let cache = PrCache::load(file.clone());
        assert_eq!(cache.session("s1"), None);
        cache.set_unstacked("p1", 12, 1_000);
        assert_eq!(PrCache::load(file).unstacked_at("p1", 12), Some(1_000));
    }
}
