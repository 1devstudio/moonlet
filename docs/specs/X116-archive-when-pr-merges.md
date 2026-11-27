# X116 — Archive a session when its PR merges

- **Status:** implemented (2026-11-27; daemon tests and e2e of the settings; not tried against a real GitHub PR)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X2 (pull requests), X55 (Git settings, archiving), X108 (saved PR states), X86 (archived sessions keep their chats), X83 (session processes), X49 (queued messages), X11 (stacks), X68/X72 (sessions across hosts)
- **Related ADRs:** none

## Summary

A session's work is usually over once its pull request merges, but the session stays in the sidebar, with its worktree, terminals and agents, until the user archives it by hand. With many sessions this is a chore, and the worktrees fill the disk. With this feature, a host can archive a session by itself once the session's PR merges, and optionally once it is closed without merging. The daemon watches the PRs, so this works while the app is closed. It never loses work: a session with uncommitted files, or with commits that exist only on this machine, is left alone and marked instead.

## User journey

1. The user opens Settings › Git and turns on **Archive when its pull request merges** under "Archiving a session".
2. They open a PR from a session, and go on with other work. The app may be closed.
3. A reviewer merges the PR on GitHub. Within 5 minutes the session's host sees the merge, and archives the session as a click on Archive would, with the Git page's choices for the worktree folder and branch.
4. The session leaves the sidebar's live list. In Archived it reads "Archived when #12 merged". Restore brings it back as with any archived session (X86).
5. Another session's PR merges while its worktree still has an uncommitted file. That session is not archived. Its merged icon turns amber, and its tooltip reads "PR merged · not archived: work only on This Mac (1 uncommitted file)". Archiving it by hand shows the file in the archive prompt, as X55 does.

## Behaviour and acceptance criteria

### Settings

- [x] Settings › Git › Archiving a session gains **Archive when its pull request merges** (default off), with the hint "Archives a session, as Archive does, once its pull request merges. Sessions with uncommitted files or commits not on origin are left alone."
- [x] Under it, indented and enabled only while it is on: **Also when its pull request is closed without merging** (default off), with the hint "A closed pull request can be reopened. Its branch and commits stay unless the settings above delete them."
- [x] Both save through `git.set_settings` per host, like every Git setting, and are found by Search settings under `App › Git`. (`lib/settingsSearch.test.ts` "finds archiving when a pull request merges or closes (X116)"; `e2e/specs/git-settings.e2e.ts` "keeps archiving when a pull request merges, and closed ones only under it (X116)")

### Which sessions are archived

- [x] A session is archived when the setting is on, its PR is the session's PR as X2 defines it, and that PR is merged (or closed, with the second switch on). A session without a PR is never archived. (`auto_archive.rs` tests `an_idle_session_whose_pr_merged_is_archived_as_the_git_settings_say`, `a_closed_pr_archives_only_with_the_second_switch_and_keeps_the_branch`; daemon test `a_session_is_archived_by_the_daemon_once_its_pr_merges`)
- [x] Only the host that runs the session archives it. A session another member owns (X72) is not archived here. (`another_members_session_and_an_archived_one_are_left_alone`)
- [x] It waits, and is tried again at the next check, while an agent in the session is working or blocked, a chat of the session has queued messages (X49) or an open permission ask, or a heavy command of the session runs (X62). The record says why, for example "archives when the agent is done". (`a_session_where_something_runs_waits_with_the_reason`) It is asked again right before archiving, after git was read, since an agent may have started meanwhile.
- [x] It is not archived while archiving would lose work only on this host, read with `git.unpushed` (the merged PR's head as `merged_head`): uncommitted files when the folder is removed, and commits not on origin when the folder is removed or the branch deleted. The record is `refused`, with what would be lost ("1 uncommitted file · 3 commits not on origin"). Every check reads it again, so committing and pushing, or discarding the files, lets the next check archive it. (`work_only_on_this_host_is_lost_only_by_what_the_plan_removes`; daemon test `a_merged_session_with_work_only_here_waits_until_the_work_is_gone`)
- [x] A closed PR archives its session only when the PR's head commit is the session branch's last commit. Anyone can open and close a PR from a fork whose branch has the session branch's name; merging one needs write access. Otherwise the record is `refused` with "the closed PR does not end at this branch's last commit". (daemon test `a_closed_pr_that_does_not_end_at_the_branch_archives_nothing`)
- [x] A PR merged before the setting was turned on counts too: the first check after turning it on archives every such session that passes the rules above.
- [x] A session the user restores after it was archived this way is not archived again for the same PR, nor one whose archive failed. A later PR of the session counts again. (`a_session_restored_or_failed_for_a_pr_is_not_archived_again_for_it`; `session.rs` test `restoring_a_session_archived_when_its_pr_merged_marks_it_restored`)
- [x] Pinned sessions (X112) are archived like any other.

### What archiving does

- [x] It is `session.archive` as the Archive prompt sends it, run by the daemon: the archive script runs, terminals end, chats are kept (X86), its copies, routed commands and designs follow.
- [x] The worktree folder follows "Worktree folder" (Remove or Keep). (daemon test `a_session_is_archived_by_the_daemon_once_its_pr_merges`)
- [x] The local branch follows "Local branch": Keep keeps it; "Delete when its PR merged" deletes it for a merged PR and keeps it for a closed one; Always delete deletes it. Ask each time keeps it, since nobody is there to ask. A kept folder keeps its branch. (`ask_each_time_and_a_kept_folder_keep_the_branch`)
- [x] "Also delete the branch on origin" applies as in X55: only for a merged PR whose local branch is deleted.
- [x] A failed archive (git refuses to remove the worktree, say) leaves the session live, records `failed` with the error, and is not tried again for that PR. Archive by hand still works.
- [x] In a stack (X11), only the session of the merged PR is archived: each session is decided on its own PR.

### Where the user sees it

- [x] An archived session in the Archived list reads "Archived when #<n> merged" (or "…was closed") under its name. (`lib/autoArchive.test.ts` "says in the Archived list which PR archived it")
- [x] When the app is open, a toast says "Archived <session name>: #<n> merged" with a Restore button. (`lib/autoArchive.test.ts` "finds the sessions the host just archived, for a toast")
- [x] A live session with a merged PR its host has not archived says why in its merged icon's tooltip; the icon turns amber with an alert mark when the user must act (refused or failed). A closed PR has no icon, so its record shows nowhere in the sidebar. (`lib/autoArchive.test.ts` "says on the merged icon why a merged session is still here")
- [ ] When the archived session is the one open in the window, the window shows its archived page (X86), with Restore. (Unchecked in the app.)

### How the daemon watches PRs

- [x] While the setting is on, the daemon looks every minute. It asks GitHub (through `gh.pr_status`'s own lookup, saved as X108 does) about a session whose saved PR is open every 5 minutes, and about one with no saved PR, or a closed one, every 15 minutes, so a PR an agent opened in a session the app never polled is found. A saved merged PR is not asked about again.
- [x] A PR state any `gh.pr_status` answer finds (the app's polls, or the phone's) triggers the same rules at once.
- [x] Checks run at most 4 sessions at a time.
- [x] With the setting off, the daemon asks GitHub nothing by itself. (daemon test `with_archiving_on_merge_off_the_daemon_checks_no_prs`)
- [x] A failed lookup (`gh` missing, offline, not logged in) archives nothing and is tried again at the next minute's look.

## UI

- Settings › Git: two rows under "Archiving a session", after "Warn before losing unpushed work": a switch row, and an indented switch row under it (as the design's "Open as draft" under "Open pull requests automatically").
- Sidebar row of a merged session that waits, was refused or failed: the merged icon (X2) holds the reason as its tooltip and accessible label. Refused or failed puts an amber alert mark before it.
- Archived list: a second line "Archived when #12 merged".

## Protocol and RPCs

- `GitSettings` gains `archive_on_merge: bool` and `archive_on_close: bool` (both default `false`). An older app ignores them. An older daemon drops them, so the switches go back off after a reload.
- `Session` gains `auto_archive: { pr: number, state: "waiting" | "refused" | "failed" | "archived" | "restored", reason?: string, merged: bool } | null`, sent in `sessions.changed`. Archived sessions keep it.
- Test seam `MOONLET_TEST_PR_WATCH_MS`: the daemon's check "minute", for tests.
- No new methods.

## Data and config

- Git settings: two new fields in the host's daemon settings file, as X55 keeps the others.
- `state.json`: the session's `auto_archive` record. `restored` and `failed` name the PR it is not archived for again.
- `prs.json` (X108): written by the daemon's own checks too.

## Security considerations

Nothing crosses a new trust boundary. The daemon runs the same `gh` lookups the app asks it for today, and the same archive. Archiving is destructive for the worktree, so the rules never archive a session with work only on this machine, and a restored session is not archived again for the same PR. The settings change only through `git.set_settings`, which only the proven app may call.

## Out of scope

- Opening pull requests automatically when an agent pushes.
- Archiving sessions without a PR, or after an idle time.
- Archiving on another member's behalf (X72 copies).
- GitHub webhooks: the daemon polls.

## Test plan

- `moonlet-core` `auto_archive.rs` unit tests of `step` and `lost_work` with literal sessions, PRs and settings; `session.rs` test of Restore.
- Daemon tests in `crates/moonletd/tests/daemon.rs` with a fake `gh` whose PR state comes from a file: archived once merged, nothing asked with the setting off, refused while an uncommitted file is there and archived once it is gone.
- `apps/desktop/src/lib/autoArchive.test.ts` for the tooltip, the Archived line and the toast; `settingsSearch.test.ts` for search.
- e2e `git-settings.e2e.ts`: both switches save to the daemon and survive closing Settings; the second is disabled until the first is on.

## Open questions

- Is 5 minutes right, or should open sessions be checked more often?
