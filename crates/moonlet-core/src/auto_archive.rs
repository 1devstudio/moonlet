//! Archiving a session by itself once its PR merges (X116): what to do
//! with one session at one check, decided from what the daemon read.

use moonlet_proto::types::{AutoArchiveState, GitSettings, PullRequest, Session, UnpushedWork};

/// What one check does with a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Nothing: the setting is off, its PR is not done, or it is not this
    /// host's to archive.
    Nothing,
    /// Not yet, for this reason; looked at again at the next check.
    Wait {
        pr: u64,
        merged: bool,
        reason: String,
    },
    /// Archive it as this plan says, once no work would be lost.
    Archive(Plan),
}

/// How a session is archived, from the host's Git settings (X55).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub pr: u64,
    /// Merged, rather than closed without merging.
    pub merged: bool,
    pub remove_worktree: bool,
    pub delete_branch: bool,
    pub delete_remote: bool,
}

/// What one check does with session `s`, whose PR GitHub last said is
/// `pr`. `busy` is why the session cannot be archived now, if something
/// in it still runs.
pub fn step(
    settings: &GitSettings,
    s: &Session,
    pr: Option<&PullRequest>,
    busy: Option<&str>,
) -> Step {
    let Some(pr) = pr else { return Step::Nothing };
    let merged = match pr.state.as_str() {
        "merged" => true,
        "closed" if settings.archive_on_close => false,
        _ => return Step::Nothing,
    };
    if !settings.archive_on_merge {
        return Step::Nothing;
    }
    if s.archived || s.owner.is_some() {
        return Step::Nothing;
    }
    // Restored by the user, or failed: not again for the same PR.
    if s.auto_archive.as_ref().is_some_and(|a| {
        a.pr == pr.number
            && matches!(
                a.state,
                AutoArchiveState::Restored | AutoArchiveState::Failed
            )
    }) {
        return Step::Nothing;
    }
    if let Some(reason) = busy {
        return Step::Wait {
            pr: pr.number,
            merged,
            reason: reason.into(),
        };
    }
    Step::Archive(plan(settings, pr.number, merged))
}

/// What archiving as `plan` would lose of `work`, said for the sidebar,
/// or none: uncommitted files go with a removed folder, and commits not on
/// origin with a removed folder or a deleted branch.
pub fn lost_work(plan: &Plan, work: &UnpushedWork) -> Option<String> {
    let count =
        |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let mut lost = Vec::new();
    if plan.remove_worktree && !work.files.is_empty() {
        lost.push(count(
            work.files.len(),
            "uncommitted file",
            "uncommitted files",
        ));
    }
    if (plan.remove_worktree || plan.delete_branch) && work.commits > 0 {
        lost.push(count(
            work.commits as usize,
            "commit not on origin",
            "commits not on origin",
        ));
    }
    (!lost.is_empty()).then(|| lost.join(" · "))
}

fn plan(settings: &GitSettings, pr: u64, merged: bool) -> Plan {
    use moonlet_proto::types::{BranchOnArchive, WorktreeOnArchive};
    let remove_worktree = settings.archive_worktree == WorktreeOnArchive::Remove;
    let delete_branch = remove_worktree
        && match settings.archive_branch {
            BranchOnArchive::Ask | BranchOnArchive::Keep => false,
            BranchOnArchive::Merged => merged,
            BranchOnArchive::Always => true,
        };
    let delete_remote = settings.delete_remote_branch && merged && delete_branch;
    Plan {
        pr,
        merged,
        remove_worktree,
        delete_branch,
        delete_remote,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        serde_json::from_value(serde_json::json!({
            "id": "s1", "project_id": "p1", "name": "Fix search", "branch": "moonlet/fix-search",
            "base": "main", "path": "/tmp/wt", "agent": null, "archived": false, "created_at": 1, "pr": 12
        }))
        .unwrap()
    }

    fn pr(state: &str) -> PullRequest {
        serde_json::from_value(serde_json::json!({
            "number": 12, "url": "https://github.com/acme/shop/pull/12", "state": state, "title": "Fix search"
        }))
        .unwrap()
    }

    fn on() -> GitSettings {
        GitSettings {
            archive_on_merge: true,
            ..GitSettings::default()
        }
    }

    #[test]
    fn an_idle_session_whose_pr_merged_is_archived_as_the_git_settings_say() {
        assert_eq!(
            step(&on(), &session(), Some(&pr("merged")), None),
            Step::Archive(Plan {
                pr: 12,
                merged: true,
                remove_worktree: true,
                delete_branch: true,
                delete_remote: false
            })
        );
    }

    #[test]
    fn a_closed_pr_archives_only_with_the_second_switch_and_keeps_the_branch() {
        assert_eq!(
            step(&on(), &session(), Some(&pr("closed")), None),
            Step::Nothing
        );
        let both = GitSettings {
            archive_on_close: true,
            ..on()
        };
        assert_eq!(
            step(&both, &session(), Some(&pr("closed")), None),
            Step::Archive(Plan {
                pr: 12,
                merged: false,
                remove_worktree: true,
                delete_branch: false,
                delete_remote: false
            })
        );
    }

    #[test]
    fn a_session_where_something_runs_waits_with_the_reason() {
        assert_eq!(
            step(
                &on(),
                &session(),
                Some(&pr("merged")),
                Some("archives when the agent is done")
            ),
            Step::Wait {
                pr: 12,
                merged: true,
                reason: "archives when the agent is done".into()
            }
        );
    }

    #[test]
    fn another_members_session_and_an_archived_one_are_left_alone() {
        let mut copy = session();
        copy.owner = serde_json::from_value(
            serde_json::json!({ "worker": "w2", "name": "Studio", "reachable": true }),
        )
        .unwrap();
        assert_eq!(step(&on(), &copy, Some(&pr("merged")), None), Step::Nothing);
        let mut archived = session();
        archived.archived = true;
        assert_eq!(
            step(&on(), &archived, Some(&pr("merged")), None),
            Step::Nothing
        );
    }

    #[test]
    fn a_session_restored_or_failed_for_a_pr_is_not_archived_again_for_it() {
        for state in ["restored", "failed"] {
            let mut s = session();
            s.auto_archive = serde_json::from_value(
                serde_json::json!({ "pr": 12, "state": state, "merged": true }),
            )
            .unwrap();
            assert_eq!(
                step(&on(), &s, Some(&pr("merged")), None),
                Step::Nothing,
                "{state}"
            );
            let mut later = pr("merged");
            later.number = 13;
            assert!(
                matches!(
                    step(&on(), &s, Some(&later), None),
                    Step::Archive(Plan { pr: 13, .. })
                ),
                "{state}"
            );
        }
    }

    fn work(files: usize, commits: u32) -> UnpushedWork {
        let files = (0..files)
            .map(|i| {
                serde_json::from_value(
                    serde_json::json!({ "status": "M", "path": format!("src/{i}.ts") }),
                )
                .unwrap()
            })
            .collect();
        UnpushedWork {
            files,
            commits,
            upstream: None,
        }
    }

    #[test]
    fn ask_each_time_and_a_kept_folder_keep_the_branch() {
        use moonlet_proto::types::{BranchOnArchive, WorktreeOnArchive};
        let ask = GitSettings {
            archive_branch: BranchOnArchive::Ask,
            delete_remote_branch: true,
            ..on()
        };
        assert_eq!(
            step(&ask, &session(), Some(&pr("merged")), None),
            Step::Archive(Plan {
                pr: 12,
                merged: true,
                remove_worktree: true,
                delete_branch: false,
                delete_remote: false
            })
        );
        let keep = GitSettings {
            archive_worktree: WorktreeOnArchive::Keep,
            archive_branch: BranchOnArchive::Always,
            ..on()
        };
        assert_eq!(
            step(&keep, &session(), Some(&pr("merged")), None),
            Step::Archive(Plan {
                pr: 12,
                merged: true,
                remove_worktree: false,
                delete_branch: false,
                delete_remote: false
            })
        );
    }

    #[test]
    fn work_only_on_this_host_is_lost_only_by_what_the_plan_removes() {
        let all = Plan {
            pr: 12,
            merged: true,
            remove_worktree: true,
            delete_branch: true,
            delete_remote: false,
        };
        let branch_only = Plan {
            remove_worktree: false,
            ..all.clone()
        };
        let nothing = Plan {
            remove_worktree: false,
            delete_branch: false,
            ..all.clone()
        };
        assert_eq!(lost_work(&all, &work(0, 0)), None);
        assert_eq!(
            lost_work(&all, &work(2, 0)).as_deref(),
            Some("2 uncommitted files")
        );
        assert_eq!(
            lost_work(&all, &work(1, 3)).as_deref(),
            Some("1 uncommitted file · 3 commits not on origin")
        );
        assert_eq!(lost_work(&branch_only, &work(2, 0)), None);
        assert_eq!(
            lost_work(&branch_only, &work(0, 1)).as_deref(),
            Some("1 commit not on origin")
        );
        assert_eq!(lost_work(&nothing, &work(2, 3)), None);
    }
}
