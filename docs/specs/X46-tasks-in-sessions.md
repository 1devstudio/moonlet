# X46 — Tasks in sessions

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X44 (task trackers), X45 (Tasks mode), X5 (sessions), X2 (pull requests)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)
- **Superseded in part by:** [X50](X50-boards.md) — moves and fixes go to a board's columns (a fix to the next column), and a GitHub repository board has only Open and Closed. [X54](X54-new-session-composer.md) — the composer shows the task as a chip without `For`, its description as a folded attachment above an empty prompt, and the "session starts" checkbox with a short label in its branch row.

## Summary

A session can belong to a task. The link is made when a session starts from a task, when its branch or pull request carries the issue key, or by hand from the link dialog. A linked session shows its task above the conversation and in a Task tab, and moonlet can keep the tracker in step with the work: moving the issue when a session starts, when its PR opens and when every PR merges.

## User journey

1. **Start from a task.** In Tasks mode the user clicks **Start** on a card. The new-session composer opens with the task chip `MOON-151 Drag sessions between sections`, the issue as a folded attachment sent as the first message (X54), the branch `moon-151-drag-sessions-between-sections`, the project that links the issue's tracker project, and "Move to In Progress" ticked. ⌘↵ starts the session.
2. **Work on it.** Above the conversation a task bar shows `MOON-142 Remote hosts sidebar`, its state, `Session 1 of 2` with arrows to the task's other sessions, and `Linear ↗`. The right panel's Task tab shows the description, acceptance criteria, the Keep in step switch and the task's sessions.
3. **Link a session made without a task.** From **Link to task…** in a session's right-click menu, or "Link to task" in Tasks mode, a dialog searches tasks, suggests matches and links the session.
4. **Ship it.** Opening the PR (not as a draft) moves the issue to In Review and comments the PR link; merging every session's PR suggests moving it to Done.

## Behaviour and acceptance criteria

### Links

- [x] A session has at most one task: `{connection, key, url}`, with the connection id of X44. It is stored by the daemon with the session. (`a_session_started_from_a_task_keeps_its_link`)
- [x] A session is linked to a task when (first match wins): it has a stored link; its branch name carries the key (if that rule is on, X44), or for a GitHub issue starts with its number in the issue's own repository; its PR's title carries the key, or for a GitHub issue the PR closes it (if that rule is on). Links found from the branch or PR are not stored, so renaming a branch or a reconnect never leaves a stale link. (`tasks.test.ts` taskForSession)
- [x] A stored link can be removed with **Unlink**. The daemon then records `task_unlinked`, and branch and PR matches are ignored for that session until it is linked again. (`a_session_can_be_linked_to_a_task_and_unlinked`, `tasks-mode.e2e.ts`)
- [x] A worktree whose branch carries a task's key and that no session uses is a "worktree without a session" on that task (X45). (`tasksBoard.test.ts`)

### Starting a session from a task

- [x] **Start** on a card opens the composer with a removable task chip `<key> <title>` (X54), and the first message, shown as a folded attachment (X54): (`tasks.test.ts` taskStart, `tasks-mode.e2e.ts`)

```
<key> · <title>
<description, as Markdown>
```

  What the user types is sent after it (X54).
- [x] `+ New session` in the detail and `Start a session for <key>` in the list open the same composer. (`tasks-mode.e2e.ts`)
- [x] Project: for a GitHub issue, the project whose `origin` is the issue's repository; for a tracker issue, the workspace's project whose Project settings link its tracker project (X44). When several do, none is preselected: the project menu lists them first under `Linked to <key>`, and Create waits for a pick. When none does, the composer starts on the current session's project or the first. The project menu has a search box over the workspace's projects. (`workspaces.test.ts` composerPick, composerProjects, `tasks.test.ts` taskStart, `tasksStore.test.ts` the projects that link them, `task-trackers.e2e.ts` moves the issue to In Progress) Branch: the tracker's template filled in and cut to the max length (X44), then made unique the same way session branches are (`-2`, `-3`). (`tasks.test.ts` taskStart, `a_task_branch_follows_the_trackers_default_template`, `tasks-mode.e2e.ts`)
- [x] A quick ⌘↵ waits for the branch name. (`tasks-mode.e2e.ts`)
- [x] The "session starts" checkbox, `Move to In Progress` with the tooltip "Move <key> to In Progress and assign it to me" (X54), is shown and ticked when the "session starts" rule is Automatically, shown unticked when it is Suggest, and hidden when Off. It only acts on a task in Todo (or a state not shown); a task further along is left alone. For a GitHub repository issue it reads `Assign to me`, with the tooltip "Assign <key> to me", and if the assignment fails an error toast says why. (`keepInStep.test.ts` startAction, `tasksStore.test.ts` moves a tracker issue to In Progress and assigns it, starting a session on a GitHub issue whose repository is in no project says so; `tasks-mode.e2e.ts`, `task-trackers.e2e.ts`)
- [x] If the move or the assignment of a Linear, Jira or ClickUp issue fails, an error toast says why. (`tasksStore.test.ts` says why when the move or assignment of a tracker issue fails)
- [x] **Start session** on a worktree without a session creates a session on that worktree and branch instead of making a new one. A worktree is matched by its real path, so `/var/…` and `/private/var/…` name the same one. (`worktrees_made_outside_moonlet_are_listed_and_can_be_adopted`, `tasks-mode.e2e.ts`)
- [x] The project picker stays on the worktree's project. (`tasks-mode.e2e.ts`)
- [x] The new session is stored with its link. (`tasks-mode.e2e.ts`)
- [x] The task's Activity records that a session started from it. (`tasksStore.test.ts` records that a session started from the task)

### Link dialog

- [x] A search field "Search tasks, or paste a key or URL" filters by key or title. (`taskLinking.test.ts` linkChoices, `tasks-mode.e2e.ts`)
- [x] The dialog is titled `Link “<session name>” to a task`. (`tasks-mode.e2e.ts`)
- [x] **Suggested**: tasks whose title is the session's name or whose key is in its branch, with the reason, the task's state and its sessions (`Title matches the session name · In Progress · no sessions`). ↵ links the pasted task, else the first suggested, else the first of the rest. (`taskLinking.test.ts` linkChoices, firstChoice, `tasks-mode.e2e.ts`)
- [x] **Recent**: the workspace's other tasks, most recently updated first. (`taskLinking.test.ts` linkChoices)
- [x] Recent shows at most 20. (`taskLinking.test.ts` shows at most 20 under Recent)
- [x] Pasting a key (`MOON-142`, `#42`, `CU-86abc`) or an issue URL of Linear, Jira, ClickUp or GitHub finds that task among the workspace's tasks, and otherwise asks its tracker: GitHub through the project's `gh` (`gh.task`, any repository), Linear, Jira and ClickUp through the connection the URL names or each connection of that tracker for a bare key. A session linked by hand to a task outside the loaded ones has a task, not "No task". A key must look like one: letters, digits and `_` starting with a letter (a Jira project key may hold `_`: `MY_PROJ-12`), `-`, then digits. `CU-` followed by letters and digits is a ClickUp task id; a digits-only `CU-12` could be any tracker. A trailing slash on a URL is fine. `#42` is that issue in the session's project's repository. (`refs.rs` a_jira_project_key_may_hold_an_underscore, `a_pasted_issue_url_reaches_the_app_as_kind_key_and_site`, `taskLinking.test.ts` findPasted, `tasksStore.test.ts` lookUpPasted, `daemon.rs` one_github_issue_by_its_number_through_gh, `linear.rs`/`jira.rs`/`clickup.rs` one issue by its key, `tasks-mode.e2e.ts`)
- [x] The dialog looks a pasted key or URL up after a short pause, and forgets an earlier paste as soon as the query changes. ↵ waits for the lookup under way, following a newer one that replaces it, and links from the lists as they are when it ends; a lookup cancelled by the dialog closing links nothing. (`taskLinking.test.ts` pasteLookup, enterChoice, `tasks-mode.e2e.ts`)
- [x] A background sync does not drop the pasted task, and ↵ links once. (`taskLinking.test.ts` ↵ pressed twice links once, asking again for the same text keeps the lookup under way)
- [x] Linking sets the stored link. (`tasks-mode.e2e.ts`)
- [x] The footer says "Links live in moonlet; the tracker hears of a PR only through Keep in step." (`tasks-mode.e2e.ts`)

### Session view

- [x] A linked session has a **task bar** above the conversation with the task's key and title and a state menu. A move from the state menu that fails shows an error toast and on the task in Tasks mode. (`tasks-mode.e2e.ts`, `taskDetails.test.ts` stateOptions, `tasksStore.test.ts` a failed action shows on its task with Retry)
- [x] The task bar also has the task's glyph before its key (no `Tasks /` before it), `Session <i> of <n>` with previous and next when the task has more than one session, and `<tracker> ↗`. (`tasks-mode.e2e.ts`)
- [x] The right panel has a **Task** tab, first, shown only for a linked session: the task's glyph and key; title; priority, cycle and assignees; the whole description, its Markdown rendered (checklist items as ticked or unticked boxes, images as links named by their alt text, HTML comments left out); **Acceptance criteria · <done> of <n>** from the description's checklist items (`- [ ]` / `- [x]`, or a section titled "Acceptance criteria"); the **Keep <tracker> in step** switch with what it does; **Sessions on this task**, with this session marked; the task's worktrees without a session; **Link to another task** and **Unlink**. Turning the switch off turns every rule off for that task. (`tasksStore.test.ts`, `taskLinking.test.ts` acceptanceCriteria, `markdown.test.ts` "a task's description (X46)", `tasks-mode.e2e.ts` "shows a linked session's task above the conversation and in the Task tab, and unlinks it")
- [x] The Sessions sidebar's section menu groups by Project, Task, Status or None. Grouped by Task, each group is headed `<key> <title>`, in order of its newest session, then "No task". How a session row shows its task is a choice in Settings › Appearance (X48): an issue number column, or a line for the task above its sessions; either marks a task out of sync in the accent colour (X45). In a workspace with a task source, a session without a task has **Link to task…** in its right-click menu. (`sidebar.test.ts` sessionMenu, `tasksView.test.ts` sessionTaskLines, `sessionRows.test.ts`, `tasks-mode.e2e.ts` offers Link to task… in a session's right-click menu)

### Keep in step

Each rule is Automatically, Suggest or Off, per tracker: Settings › Task trackers sets them, stored under `[linear.rules]`, `[jira.rules]`, `[clickup.rules]` and `[github.rules]` in `trackers.toml` (X44). Suggest shows the task as out of sync with its fix (X45) instead of acting; the PR-link comment has no chip, so at Suggest it is not posted. The Task tab's switch turns all of them off for that task.

| When | Then | Default |
|---|---|---|
| A session starts from an issue | Linear, Jira, ClickUp: move it to In Progress and assign it to me (only from Todo or not shown); GitHub: assign it to me | Automatically |
| A pull request opens (not a draft) | Linear, Jira, ClickUp: move the issue to In Review (GitHub's columns follow the work) | Automatically |
| Every session's PR is merged | move the issue to Done; GitHub: close it as completed | Suggest |
| A pull request opens (not a draft) | Linear, Jira, ClickUp: comment on the issue with the PR's title and link; GitHub: add `Closes #<n>` to the PR body | Automatically |
| The issue moves to Done | archive its sessions and remove their worktrees, always after a confirm that names uncommitted changes (Suggest or Off only) | Suggest |

- [x] A move lands on the tracker state whose own default column (X44) is the target and that the user did not map elsewhere; failing that, on the first state, in the tracker's order, that the user mapped onto that column. The app's Rust side picks it (`tracker_update`) from the tracker's states and the connection's mapping. (the shared `states::pick`, with a mapping in `linear.rs` a_move_follows_the_users_state_mapping and a_move_picks_the_first_state_of_the_column_by_position; Jira and ClickUp go through the same `pick`, `jira.rs` the_transition_that_reaches_a_column, `clickup.rs` user_workspaces_spaces_lists_and_statuses; `task-trackers.e2e.ts`)
- [x] For Jira a move takes the transition that leads to that state; with none, it fails with "No Jira transition leads to that column from here". (`jira.rs` the_transition_that_reaches_a_column, `task-trackers.e2e.ts`)
- [x] For a GitHub repository source, "move to Done" closes the issue as completed and the other moves do nothing (the column follows the work). The state menu offers Open and Closed, which reopen or close it. (`task_updates_reach_github_through_gh`, `keepInStep.test.ts`, `taskDetails.test.ts` stateOptions, `tasksStore.test.ts`)
- [x] A draft PR does not count as opened: no In Review move, no PR-link comment, and a GitHub issue whose only PR is a draft stays In Progress. (`tasksBoard.test.ts` a draft PR is not an open one, `keepInStep.test.ts` prComments, `git.rs` a_draft_pr_says_so)
- [x] A draft PR adds no `PR #n opened` to Activity. (`tasksStore.test.ts` adds no PR opened for a draft)
- [x] The Create PR dialog adds `Closes #<n>` to the body, once, for a session linked to a GitHub issue in the PR's own repository. It follows the link rules (X44), and leaves the line out when the "a pull request opens" comment rule is Off or the task's switch is off. (`keepInStep.test.ts` Closes #N, `tasks-mode.e2e.ts`)
- [x] A failed chip fix or state-menu move shows on the task with its error and a Retry until the app quits, and is not tried again by itself, not even after a restart. Retry acts on the task as it is now, under the rules as they are now. A PR-link comment that works afterwards does not clear the failure; one that fails too is sent again by the same Retry. (`tasksStore.test.ts` a failed action shows on its task with Retry, Retry on a chip's fix, runs an automatic fix once, automatic fixes and failures, second review round)
- [x] Each action moonlet takes is recorded in the task's Activity (X45), and a failed PR-link comment shows on the task with its error and a Retry too. (`tasksStore.test.ts` open spec lines: Activity, comments, drafts and toasts)
- [x] Actions happen once per event: reopening the app or a repeated PR poll does not move or comment again. An automatic fix is remembered per situation, only once it worked, and a PR-link comment per PR URL. (`keepInStep.test.ts` autoFixes and prComments, `tasksStore.test.ts` runs an automatic fix once)
- [x] A PR-link comment is remembered only once it worked. (`tasksStore.test.ts` records the comment moonlet posts, remembers it only once it worked)

## UI

The designs are the "Session opened from a task" and "Link a session · Start from a task" boards.

## Protocol and RPCs

- `Session` gains `task: Option<TaskRef>`, `TaskRef {connection, key, url}`, and `task_unlinked: bool`.
- `session.create` gains `task` and `worktree`: the path of a linked worktree of the project to adopt, with its branch. Paths are compared by where they lead. It fails when the path is not one of the project's worktrees, is on a detached HEAD, or is used by a session that is not archived.
- `session.update` gains `task`: a task links it and clears `task_unlinked`; `null` unlinks it and sets `task_unlinked`; absent leaves the link alone.
- `gh.task {path, repo, number}` reads one issue of any repository, for a pasted key or URL.
- `gh.task_update {path, number, assign_me?, close?, reopen?}` assigns a GitHub issue to the user (`gh issue edit --add-assignee @me`), closes it as completed or reopens it.
- `project.worktree_remove {id, path}` removes a linked worktree no session uses (Clean up); it refuses the main checkout and a session's worktree.
- `PullRequest` gains `draft`, from `gh`'s `isDraft`.
- No new events: `sessions.changed` already carries sessions.

## Data and config

- The stored link and `task_unlinked` live in `~/.moonlet/state.json` with the session; defaulted fields, so no state version bump.
- The app's local storage keeps what already happened, so it happens once: automatic fixes by situation and PR-link comments and `PR opened` entries by PR URL. It also keeps each task's Keep in step switch and its Activity (the newest 20).

## Security considerations

- Moving issues and commenting are outward-facing. They only happen through rules the user can see and set per tracker, defaulting as in the table; Suggest and Off never write to the tracker.
- The issue text becomes the first message only after the user sees it in the composer.
- Comments posted by moonlet contain only the PR's title and URL.

## Out of scope

- A Recent list per source.
- Skipping the PR-link comment when the tracker's own GitHub integration already links the PR.
- GitHub project board sources, whose moves would set the Status field (X44).
- Renaming a session's branch from the link dialog.
- Creating an issue from a session.
- More than one task per session.

## Test plan

- Rust: daemon tests creating a session with `task`, linking and unlinking it (`task_unlinked`), adopting and removing an existing worktree, and `gh.task` and `gh.task_update` with a stub `gh` (`daemon.rs`); `isDraft` (`git.rs`); pasted keys and URLs, branch names and the state a move picks (`moonlet-trackers`).
- Vitest: link resolution (stored, branch, PR, unlinked) and key matching (`tasks.test.ts`), composer prefill (`tasks.test.ts` taskStart), the link dialog's lists and pasted keys and acceptance criteria (`taskLinking.test.ts`), Keep in step decisions for each rule, drafts, `Closes #N` and actions happening once (`keepInStep.test.ts`, `tasksBoard.test.ts`, `tasksStore.test.ts`), grouping by task (`sidebar.test.ts`).
- e2e: start a session from a task (crucial: starting a session), `Closes #N` in its PR, see the task bar and Task tab and unlink, link a session from a pasted key (`tasks-mode.e2e.ts`); a Linear issue moved and assigned when a session starts from it (`task-trackers.e2e.ts`).

## Open questions

- None yet.
