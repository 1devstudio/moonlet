//! Plan artifacts (X114): the plans one chat's agent proposed, kept as
//! versions in `<home>/artifacts/plans/<session id>/<key>/`: `plan.toml`
//! with the plan's record and its versions, and `v<n>.md` with each
//! version's text.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Where a version stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VersionState {
    /// Proposed, not answered yet.
    Pending,
    Approved,
    Rejected,
    /// Edited by hand by the user.
    Edited,
}

/// One version of a plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Version {
    pub n: u32,
    pub state: VersionState,
    /// When it was proposed or edited, in milliseconds since the epoch.
    pub at: u64,
    /// The chat item that proposed it; none for an edit by hand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
}

/// A plan artifact: one chat's plans.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Plan {
    pub session: String,
    pub key: String,
    /// The title of the chat that proposed it, when it had one.
    #[serde(default)]
    pub chat_title: String,
    /// The first heading of the latest version, else its first line.
    #[serde(default)]
    pub heading: String,
    /// The name the user gave it; it then no longer follows the session's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renamed: Option<String>,
    pub created_at: u64,
    #[serde(default)]
    pub versions: Vec<Version>,
}

impl Plan {
    /// Its artifact id, `plan:<session id>:<key>`.
    pub fn id(&self) -> String {
        format!("plan:{}:{}", self.session, self.key)
    }

    /// The latest version.
    pub fn latest(&self) -> Option<&Version> {
        self.versions.last()
    }

    /// When it last changed: its latest version's time.
    pub fn updated_at(&self) -> u64 {
        self.latest().map_or(self.created_at, |v| v.at)
    }
}

/// The name a plan shows: the one the user gave it; else its session's,
/// with its chat's title when the session has plans from several chats;
/// else, for a session with no name yet, the plan's first heading.
pub fn display_name(plan: &Plan, session_name: Option<&str>, several: bool) -> String {
    if let Some(n) = &plan.renamed {
        return n.clone();
    }
    // A session moonlet named "Untitled" has no name of its own yet.
    match session_name
        .map(str::trim)
        .filter(|n| !n.is_empty() && *n != "Untitled")
    {
        Some(n) if several && !plan.chat_title.trim().is_empty() => {
            format!("{n} · {}", plan.chat_title.trim())
        }
        Some(n) => n.to_string(),
        None => plan.heading.clone(),
    }
}

/// Where `query` is in `text`, ignoring case: the line it is on, cut at
/// whole words to at most 40 characters each side of it, with `…` where it
/// was cut. `None` when it is not there.
pub fn snippet(text: &str, query: &str) -> Option<String> {
    const SIDE: usize = 40;
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return None;
    }
    text.lines().find_map(|line| {
        let line = line.trim();
        let chars: Vec<char> = line.chars().collect();
        // Each character lowercased on its own, with where it starts in the
        // lowercased line, so a match maps back to whole characters whatever
        // lowercasing does to their lengths.
        let mut folded = String::new();
        let mut starts = Vec::with_capacity(chars.len());
        for c in &chars {
            starts.push(folded.len());
            folded.extend(c.to_lowercase());
        }
        let at = folded.find(&query)?;
        let start = starts.iter().rposition(|&s| s <= at)?;
        let end = starts
            .iter()
            .position(|&s| s >= at + query.len())
            .unwrap_or(chars.len());
        let mut from = start.saturating_sub(SIDE);
        if from > 0 {
            // Start at the next whole word.
            while from < start && !chars[from - 1].is_whitespace() {
                from += 1;
            }
        }
        let mut to = (end + SIDE).min(chars.len());
        if to < chars.len() {
            // End at the last whole word.
            while to > end && !chars[to].is_whitespace() {
                to -= 1;
            }
        }
        let cut: String = chars[from..to].iter().collect();
        let cut = cut.trim();
        Some(format!(
            "{}{cut}{}",
            if from > 0 { "…" } else { "" },
            if to < chars.len() { "…" } else { "" }
        ))
    })
}

/// A plan a chat proposed, or its answer, as the chat's item has it.
pub struct Proposal<'a> {
    pub session: &'a str,
    /// The plan file's name, else the chat's Claude conversation.
    pub key: &'a str,
    pub chat_title: &'a str,
    /// The `ExitPlanMode` item's id.
    pub item: &'a str,
    pub text: &'a str,
    /// The item's status: `running`, `ok`, `denied` or `error`.
    pub status: &'a str,
    pub at: u64,
}

/// The plan artifacts of a host.
pub struct Plans {
    root: PathBuf,
    lock: Mutex<()>,
}

impl Plans {
    /// The plans kept under `home` (`~/.moonlet`).
    pub fn new(home: &Path) -> Self {
        Self {
            root: home.join("artifacts").join("plans"),
            lock: Mutex::new(()),
        }
    }

    /// Keeps a proposal: a new version when its text is new, else the
    /// answer to the version it is. Returns the plan's id when anything
    /// changed.
    pub fn record(&self, p: &Proposal) -> Result<Option<String>> {
        let text = p.text.trim_end();
        if text.trim().is_empty() || !super::safe_name(p.session) || !super::safe_name(p.key) {
            return Ok(None);
        }
        let _held = self.lock.lock().unwrap();
        let dir = self.root.join(p.session).join(p.key);
        let mut plan = read_plan(&dir)?.unwrap_or_else(|| Plan {
            session: p.session.to_string(),
            key: p.key.to_string(),
            chat_title: p.chat_title.to_string(),
            heading: String::new(),
            renamed: None,
            created_at: p.at,
            versions: Vec::new(),
        });
        let answer = state_of(p.status);
        // The item proposed a version already: only its answer is new.
        if let Some(v) = plan
            .versions
            .iter_mut()
            .find(|v| v.item.as_deref() == Some(p.item))
        {
            match answer {
                Some(s) if v.state != s => v.state = s,
                _ => return Ok(None),
            }
        } else {
            let same = match plan.latest() {
                Some(v) => std::fs::read_to_string(dir.join(version_file(v.n)))
                    .is_ok_and(|t| t.trim_end() == text),
                None => false,
            };
            if same {
                // Proposed again with the same text: the latest version
                // waits for this proposal's own answer.
                let v = plan.versions.last_mut().unwrap();
                v.item = Some(p.item.to_string());
                let state = answer.unwrap_or(VersionState::Pending);
                if v.state == state {
                    write_plan(&dir, &plan)?;
                    return Ok(None);
                }
                v.state = state;
            } else {
                let n = plan.latest().map_or(1, |v| v.n + 1);
                crate::paths::ensure_private_dir(&dir)?;
                write_file(&dir, &version_file(n), &format!("{text}\n"))?;
                plan.versions.push(Version {
                    n,
                    state: answer.unwrap_or(VersionState::Pending),
                    at: p.at,
                    item: Some(p.item.to_string()),
                });
                plan.heading = heading(text);
            }
        }
        if !p.chat_title.is_empty() {
            plan.chat_title = p.chat_title.to_string();
        }
        write_plan(&dir, &plan)?;
        Ok(Some(plan.id()))
    }

    /// The plan with artifact id `id`, if there is one.
    pub fn plan(&self, id: &str) -> Result<Option<Plan>> {
        let Some(dir) = self.dir_of(id) else {
            return Ok(None);
        };
        read_plan(&dir)
    }

    /// The text of version `n` of plan `id`.
    pub fn text(&self, id: &str, n: u32) -> Result<String> {
        let dir = self.dir_of(id).context("no such plan")?;
        std::fs::read_to_string(dir.join(version_file(n)))
            .with_context(|| format!("plan {id} has no version {n}"))
    }

    /// Saves `text` as a new version of plan `id`, edited by hand. Returns
    /// the new version's number, or `None` when the text is the latest's.
    pub fn edit(&self, id: &str, text: &str, at: u64) -> Result<Option<u32>> {
        let text = text.trim_end();
        let dir = self.dir_of(id).context("not a plan's id")?;
        let _held = self.lock.lock().unwrap();
        let mut plan = read_plan(&dir)?.with_context(|| format!("no plan {id}"))?;
        if let Some(v) = plan.latest()
            && std::fs::read_to_string(dir.join(version_file(v.n)))
                .is_ok_and(|t| t.trim_end() == text)
        {
            return Ok(None);
        }
        let n = plan.latest().map_or(1, |v| v.n + 1);
        write_file(&dir, &version_file(n), &format!("{text}\n"))?;
        plan.versions.push(Version {
            n,
            state: VersionState::Edited,
            at,
            item: None,
        });
        plan.heading = heading(text);
        write_plan(&dir, &plan)?;
        Ok(Some(n))
    }

    /// Names plan `id` as the user does; `None` gives it its session's
    /// name again.
    pub fn rename(&self, id: &str, name: Option<&str>) -> Result<()> {
        let dir = self.dir_of(id).context("not a plan's id")?;
        let _held = self.lock.lock().unwrap();
        let mut plan = read_plan(&dir)?.with_context(|| format!("no plan {id}"))?;
        plan.renamed = name
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(String::from);
        write_plan(&dir, &plan)
    }

    /// Every plan of the sessions `sessions` names, or of every session
    /// when it is `None`.
    pub fn list(&self, sessions: Option<&[&str]>) -> Vec<Plan> {
        let session_dirs: Vec<PathBuf> = match sessions {
            Some(ids) => ids
                .iter()
                .filter(|s| super::safe_name(s))
                .map(|s| self.root.join(s))
                .collect(),
            None => children(&self.root),
        };
        session_dirs
            .iter()
            .flat_map(|d| children(d))
            .filter_map(|d| match read_plan(&d) {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!("skipping plan {}: {e:#}", d.display());
                    None
                }
            })
            .collect()
    }

    /// Where version `n` of plan `id` is kept, the path its chat is told.
    pub fn version_path(&self, id: &str, n: u32) -> Option<PathBuf> {
        Some(self.dir_of(id)?.join(version_file(n)))
    }

    /// Copies plan `id`'s latest version into workspace `workspace` as a
    /// workspace plan named `name`, one version long. Returns its id.
    pub fn copy_to_workspace(
        &self,
        id: &str,
        workspace: &str,
        name: &str,
        at: u64,
    ) -> Result<String> {
        let home = workspace_home(workspace);
        anyhow::ensure!(super::safe_name(&home), "not a safe workspace id");
        let from = self.plan(id)?.with_context(|| format!("no plan {id}"))?;
        let latest = from
            .latest()
            .with_context(|| format!("plan {id} has no version"))?;
        let text = self.text(id, latest.n)?;
        let _held = self.lock.lock().unwrap();
        let key = free_key(&self.root.join(&home), &from.key);
        let dir = self.root.join(&home).join(&key);
        crate::paths::ensure_private_dir(&dir)?;
        write_file(&dir, &version_file(1), &text)?;
        let plan = Plan {
            session: home,
            key,
            chat_title: String::new(),
            heading: from.heading.clone(),
            renamed: Some(name.trim().to_string()).filter(|n| !n.is_empty()),
            created_at: at,
            versions: vec![Version {
                n: 1,
                state: latest.state,
                at,
                item: None,
            }],
        };
        write_plan(&dir, &plan)?;
        Ok(plan.id())
    }

    /// Moves workspace plan `id` into workspace `workspace`, its versions
    /// with it. Returns its id there.
    pub fn move_to_workspace(&self, id: &str, workspace: &str) -> Result<String> {
        let (session, key) = parse_id(id).context("not a plan's id")?;
        anyhow::ensure!(
            workspace_of_home(session).is_some(),
            "only a workspace's own plan moves; a session's is copied"
        );
        let home = workspace_home(workspace);
        anyhow::ensure!(super::safe_name(&home), "not a safe workspace id");
        let _held = self.lock.lock().unwrap();
        let from = self.root.join(session).join(key);
        let mut plan = read_plan(&from)?.with_context(|| format!("no plan {id}"))?;
        let to_key = free_key(&self.root.join(&home), key);
        let to = self.root.join(&home).join(&to_key);
        crate::paths::ensure_private_dir(&self.root.join(&home))?;
        std::fs::rename(&from, &to)?;
        plan.session = home;
        plan.key = to_key;
        write_plan(&to, &plan)?;
        Ok(plan.id())
    }

    fn dir_of(&self, id: &str) -> Option<PathBuf> {
        let (session, key) = parse_id(id)?;
        Some(self.root.join(session).join(key))
    }
}

impl VersionState {
    /// Its name, as the protocol and `plan.toml` spell it.
    pub fn as_str(self) -> &'static str {
        match self {
            VersionState::Pending => "pending",
            VersionState::Approved => "approved",
            VersionState::Rejected => "rejected",
            VersionState::Edited => "edited",
        }
    }
}

/// A plan artifact's key: its plan file's name, as Claude keeps one plan
/// file per conversation; without one, the conversation. Only letters,
/// digits, `_` and `-`. None when there is neither.
pub fn plan_key(plan_file: Option<&str>, conversation: Option<&str>) -> Option<String> {
    let key = plan_file
        .and_then(|p| Path::new(p).file_stem())
        .map(|s| s.to_string_lossy().into_owned())
        .or_else(|| conversation.map(String::from))?;
    Some(
        key.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '_' | '-') {
                    c
                } else {
                    '-'
                }
            })
            .collect(),
    )
}

/// `key`, or `key-2`, `key-3`… when `dir` has a plan by that key already.
fn free_key(dir: &Path, key: &str) -> String {
    (1..)
        .map(|n| {
            if n == 1 {
                key.to_string()
            } else {
                format!("{key}-{n}")
            }
        })
        .find(|k| !dir.join(k).exists())
        .unwrap()
}

/// The home of a workspace's own plans, which no session has: copies from
/// another workspace (X114).
pub fn workspace_home(workspace: &str) -> String {
    format!("w-{workspace}")
}

/// The workspace whose own plans `home` holds, when it is such a home.
pub fn workspace_of_home(home: &str) -> Option<&str> {
    home.strip_prefix("w-")
}

/// The session and key of a plan's artifact id, when it is one.
pub fn parse_id(id: &str) -> Option<(&str, &str)> {
    let rest = id.strip_prefix("plan:")?;
    let (session, key) = rest.split_once(':')?;
    (super::safe_name(session) && super::safe_name(key)).then_some((session, key))
}


/// The answer an item's status gives, if any.
fn state_of(status: &str) -> Option<VersionState> {
    // A call closed when its turn ends (`ok`), interrupted or not, is no
    // answer: only the user's approval is.
    match status {
        "approved" => Some(VersionState::Approved),
        "denied" => Some(VersionState::Rejected),
        _ => None,
    }
}

/// The plan's first heading, else its first line.
fn heading(text: &str) -> String {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.clone().next().unwrap_or("");
    lines
        .find(|l| l.starts_with('#'))
        .map_or(first, |h| h.trim_start_matches('#').trim())
        .chars()
        .take(200)
        .collect()
}

/// The folders in `dir`, none of them hidden.
fn children(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.flatten()
        .filter(|e| {
            e.file_type().is_ok_and(|t| t.is_dir())
                && !e.file_name().to_string_lossy().starts_with('.')
        })
        .map(|e| e.path())
        .collect()
}

fn version_file(n: u32) -> String {
    format!("v{n}.md")
}

fn read_plan(dir: &Path) -> Result<Option<Plan>> {
    match std::fs::read_to_string(dir.join("plan.toml")) {
        Ok(t) => Ok(Some(toml::from_str(&t).with_context(|| {
            format!("reading {}", dir.join("plan.toml").display())
        })?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn write_plan(dir: &Path, plan: &Plan) -> Result<()> {
    crate::paths::ensure_private_dir(dir)?;
    write_file(dir, "plan.toml", &toml::to_string(plan)?)
}

/// Writes `name` in `dir` whole or not at all.
fn write_file(dir: &Path, name: &str, content: &str) -> Result<()> {
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, dir.join(name))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal<'a>(item: &'a str, text: &'a str, status: &'a str, at: u64) -> Proposal<'a> {
        Proposal {
            session: "a1b2c3d4e5f6",
            key: "groovy-whale",
            chat_title: "claude",
            item,
            text,
            status,
            at,
        }
    }

    #[test]
    fn a_proposed_plan_is_kept_as_its_first_version_waiting_for_an_answer() {
        let home = tempfile::tempdir().unwrap();
        let plans = Plans::new(home.path());

        let id = plans
            .record(&proposal(
                "toolu_1",
                "# Search for the product list\n\nAdd a search box.\n",
                "running",
                1_000,
            ))
            .unwrap();

        assert_eq!(id.as_deref(), Some("plan:a1b2c3d4e5f6:groovy-whale"));
        let plan = plans
            .plan("plan:a1b2c3d4e5f6:groovy-whale")
            .unwrap()
            .unwrap();
        assert_eq!(
            plan.versions,
            vec![Version {
                n: 1,
                state: VersionState::Pending,
                at: 1_000,
                item: Some("toolu_1".into())
            }]
        );
        assert_eq!(plan.heading, "Search for the product list");
        assert_eq!(
            plans.text("plan:a1b2c3d4e5f6:groovy-whale", 1).unwrap(),
            "# Search for the product list\n\nAdd a search box.\n"
        );
        assert!(
            home.path()
                .join("artifacts/plans/a1b2c3d4e5f6/groovy-whale/v1.md")
                .is_file()
        );
    }
    #[test]
    fn approving_or_rejecting_a_plan_answers_its_version() {
        let home = tempfile::tempdir().unwrap();
        let plans = Plans::new(home.path());
        plans
            .record(&proposal(
                "toolu_1",
                "# Plan\n\nFirst try.",
                "running",
                1_000,
            ))
            .unwrap();
        plans
            .record(&proposal(
                "toolu_1",
                "# Plan\n\nFirst try.",
                "denied",
                1_500,
            ))
            .unwrap();
        plans
            .record(&proposal(
                "toolu_2",
                "# Plan\n\nSecond try.",
                "running",
                2_000,
            ))
            .unwrap();
        let changed = plans
            .record(&proposal("toolu_2", "# Plan\n\nSecond try.", "approved", 2_500))
            .unwrap();

        assert_eq!(changed.as_deref(), Some("plan:a1b2c3d4e5f6:groovy-whale"));
        let plan = plans
            .plan("plan:a1b2c3d4e5f6:groovy-whale")
            .unwrap()
            .unwrap();
        let states: Vec<_> = plan.versions.iter().map(|v| (v.n, v.state, v.at)).collect();
        assert_eq!(
            states,
            vec![
                (1, VersionState::Rejected, 1_000),
                (2, VersionState::Approved, 2_000)
            ]
        );
        assert_eq!(
            plans.text("plan:a1b2c3d4e5f6:groovy-whale", 2).unwrap(),
            "# Plan\n\nSecond try.\n"
        );
    }

    #[test]
    fn a_plan_proposed_again_with_the_same_text_adds_no_version() {
        let home = tempfile::tempdir().unwrap();
        let plans = Plans::new(home.path());
        plans
            .record(&proposal("toolu_1", "# Plan\n\nSame.", "running", 1_000))
            .unwrap();
        // The item streams again, unchanged: nothing to tell.
        assert_eq!(
            plans
                .record(&proposal("toolu_1", "# Plan\n\nSame.", "running", 1_100))
                .unwrap(),
            None
        );
        // Proposed again by a new call, with the same text: still one version, which takes its answer.
        plans
            .record(&proposal("toolu_2", "# Plan\n\nSame.\n", "running", 2_000))
            .unwrap();
        plans
            .record(&proposal("toolu_2", "# Plan\n\nSame.\n", "approved", 2_100))
            .unwrap();

        let plan = plans
            .plan("plan:a1b2c3d4e5f6:groovy-whale")
            .unwrap()
            .unwrap();
        assert_eq!(
            plan.versions,
            vec![Version {
                n: 1,
                state: VersionState::Approved,
                at: 1_000,
                item: Some("toolu_2".into())
            }]
        );
    }

    #[test]
    fn a_plan_with_an_unsafe_key_or_no_text_is_not_kept() {
        let home = tempfile::tempdir().unwrap();
        let plans = Plans::new(home.path());
        let mut p = proposal("toolu_1", "# Plan", "running", 1_000);
        p.key = "../escape";
        assert_eq!(plans.record(&p).unwrap(), None);
        assert_eq!(
            plans
                .record(&proposal("toolu_2", "  \n", "running", 1_000))
                .unwrap(),
            None
        );
        assert!(!home.path().join("artifacts").exists());
    }
    #[test]
    fn an_edit_by_hand_is_a_new_version_and_one_changing_nothing_is_none() {
        let home = tempfile::tempdir().unwrap();
        let plans = Plans::new(home.path());
        plans
            .record(&proposal("toolu_1", "# Plan\n\nStep one.", "ok", 1_000))
            .unwrap();
        let id = "plan:a1b2c3d4e5f6:groovy-whale";

        assert_eq!(
            plans
                .edit(id, "# Plan\n\nStep one.\nStep two.", 3_000)
                .unwrap(),
            Some(2)
        );
        assert_eq!(
            plans
                .edit(id, "# Plan\n\nStep one.\nStep two.\n", 4_000)
                .unwrap(),
            None
        );

        let plan = plans.plan(id).unwrap().unwrap();
        assert_eq!(
            plan.versions.last(),
            Some(&Version {
                n: 2,
                state: VersionState::Edited,
                at: 3_000,
                item: None
            })
        );
        assert_eq!(
            plans.text(id, 2).unwrap(),
            "# Plan\n\nStep one.\nStep two.\n"
        );
        assert!(
            plans
                .edit("plan:a1b2c3d4e5f6:nothing-here", "x", 1)
                .is_err()
        );
    }

    #[test]
    fn a_renamed_plan_keeps_its_name_until_it_is_given_back() {
        let home = tempfile::tempdir().unwrap();
        let plans = Plans::new(home.path());
        plans
            .record(&proposal("toolu_1", "# Plan", "running", 1_000))
            .unwrap();
        let id = "plan:a1b2c3d4e5f6:groovy-whale";

        plans.rename(id, Some("  Search plan ")).unwrap();
        assert_eq!(
            plans.plan(id).unwrap().unwrap().renamed.as_deref(),
            Some("Search plan")
        );
        plans.rename(id, None).unwrap();
        assert_eq!(plans.plan(id).unwrap().unwrap().renamed, None);
    }

    #[test]
    fn plans_are_listed_for_the_sessions_asked_about() {
        let home = tempfile::tempdir().unwrap();
        let plans = Plans::new(home.path());
        plans
            .record(&proposal("toolu_1", "# One", "running", 1_000))
            .unwrap();
        let mut other = proposal("toolu_2", "# Two", "running", 2_000);
        other.session = "0f0f0f0f0f0f";
        other.key = "brave-otter";
        plans.record(&other).unwrap();

        let mut all: Vec<_> = plans.list(None).iter().map(Plan::id).collect();
        all.sort();
        assert_eq!(
            all,
            vec![
                "plan:0f0f0f0f0f0f:brave-otter",
                "plan:a1b2c3d4e5f6:groovy-whale"
            ]
        );
        let one: Vec<_> = plans
            .list(Some(&["0f0f0f0f0f0f"]))
            .iter()
            .map(Plan::id)
            .collect();
        assert_eq!(one, vec!["plan:0f0f0f0f0f0f:brave-otter"]);
    }
    fn named(chat_title: &str, heading: &str, renamed: Option<&str>) -> Plan {
        Plan {
            session: "a1b2c3d4e5f6".into(),
            key: "k".into(),
            chat_title: chat_title.into(),
            heading: heading.into(),
            renamed: renamed.map(String::from),
            created_at: 0,
            versions: vec![],
        }
    }

    #[test]
    fn a_plan_is_named_after_its_session_its_chat_or_its_heading() {
        let p = named("claude 2", "Search for the product list", None);
        assert_eq!(
            display_name(&p, Some("Add search to the product list"), false),
            "Add search to the product list"
        );
        assert_eq!(
            display_name(&p, Some("Add search to the product list"), true),
            "Add search to the product list · claude 2"
        );
        assert_eq!(
            display_name(&p, Some("  "), false),
            "Search for the product list"
        );
        assert_eq!(display_name(&p, None, true), "Search for the product list");
        let renamed = named(
            "claude 2",
            "Search for the product list",
            Some("Search plan"),
        );
        assert_eq!(
            display_name(&renamed, Some("Add search to the product list"), true),
            "Search plan"
        );
        let untitled_chat = named("", "Search", None);
        assert_eq!(
            display_name(&untitled_chat, Some("Checkout"), true),
            "Checkout"
        );
        // A session moonlet named "Untitled" has no name of its own yet.
        assert_eq!(
            display_name(&p, Some("Untitled"), false),
            "Search for the product list"
        );
    }

    #[test]
    fn the_same_text_proposed_again_after_an_answer_waits_for_its_own() {
        let home = tempfile::tempdir().unwrap();
        let plans = Plans::new(home.path());
        plans
            .record(&proposal("toolu_1", "# Plan\n\nSame.", "running", 1_000))
            .unwrap();
        plans
            .record(&proposal("toolu_1", "# Plan\n\nSame.", "denied", 1_100))
            .unwrap();
        plans
            .record(&proposal("toolu_2", "# Plan\n\nSame.", "running", 2_000))
            .unwrap();
        let id = "plan:a1b2c3d4e5f6:groovy-whale";
        assert_eq!(
            plans.plan(id).unwrap().unwrap().versions[0].state,
            VersionState::Pending
        );
        plans
            .record(&proposal("toolu_2", "# Plan\n\nSame.", "approved", 2_100))
            .unwrap();
        assert_eq!(
            plans.plan(id).unwrap().unwrap().versions[0].state,
            VersionState::Approved
        );
        // A call closed at the end of a turn is no answer.
        plans
            .record(&proposal("toolu_3", "# Plan\n\nNew.", "running", 3_000))
            .unwrap();
        plans
            .record(&proposal("toolu_3", "# Plan\n\nNew.", "ok", 3_100))
            .unwrap();
        assert_eq!(
            plans.plan(id).unwrap().unwrap().versions[1].state,
            VersionState::Pending
        );
    }

    #[test]
    fn a_snippet_is_the_line_the_text_was_found_on_cut_around_it() {
        let text = "# Search for the product list\n\n1. Add `SearchBox` in `src/components/` with a 150 ms debounce so typing stays smooth on slow phones and tablets\n2. Count";
        assert_eq!(
            snippet(text, "DEBOUNCE").as_deref(),
            Some(
                "…in `src/components/` with a 150 ms debounce so typing stays smooth on slow phones…"
            )
        );
        assert_eq!(snippet(text, "count").as_deref(), Some("2. Count"));
        assert_eq!(snippet(text, "fuzzy"), None);
        assert_eq!(snippet(text, "  "), None);
    }

    #[test]
    fn a_snippet_never_breaks_on_text_whose_lowercase_moves_its_characters() {
        // ẞ lowercases one byte shorter, İ one byte longer: the same length, other offsets.
        assert_eq!(
            snippet("ẞİ then debounce it", "debounce").as_deref(),
            Some("ẞİ then debounce it")
        );
        assert_eq!(
            snippet("Straße İstanbul", "İSTANBUL").as_deref(),
            Some("Straße İstanbul")
        );
        assert_eq!(snippet("ẞİ", "x"), None);
    }

    #[test]
    fn a_plan_is_copied_into_a_workspace_and_a_workspace_plan_moves_between_them() {
        let home = tempfile::tempdir().unwrap();
        let plans = Plans::new(home.path());
        plans
            .record(&proposal("toolu_1", "# Plan\n\nv1", "denied", 1_000))
            .unwrap();
        plans
            .record(&proposal("toolu_2", "# Plan\n\nv2", "approved", 2_000))
            .unwrap();

        let copy = plans
            .copy_to_workspace(
                "plan:a1b2c3d4e5f6:groovy-whale",
                "ws-personal",
                "Search plan",
                5_000,
            )
            .unwrap();
        assert_eq!(copy, "plan:w-ws-personal:groovy-whale");
        let p = plans.plan(&copy).unwrap().unwrap();
        assert_eq!(
            (
                p.renamed.as_deref(),
                p.versions.len(),
                p.versions[0].state,
                p.versions[0].at
            ),
            (Some("Search plan"), 1, VersionState::Approved, 5_000)
        );
        assert_eq!(plans.text(&copy, 1).unwrap(), "# Plan\n\nv2\n");
        // Copied again: another plan, not over the first.
        assert_eq!(
            plans
                .copy_to_workspace(
                    "plan:a1b2c3d4e5f6:groovy-whale",
                    "ws-personal",
                    "Search plan",
                    6_000
                )
                .unwrap(),
            "plan:w-ws-personal:groovy-whale-2"
        );

        let moved = plans.move_to_workspace(&copy, "ws-side").unwrap();
        assert_eq!(moved, "plan:w-ws-side:groovy-whale");
        assert!(plans.plan(&copy).unwrap().is_none());
        assert_eq!(plans.text(&moved, 1).unwrap(), "# Plan\n\nv2\n");
        // Only a workspace's own plan moves; a session's is copied.
        assert!(
            plans
                .move_to_workspace("plan:a1b2c3d4e5f6:groovy-whale", "ws-side")
                .is_err()
        );
    }
}
