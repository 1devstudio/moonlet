# X46 — Tasks in sessions

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X44 (task trackers), X45 (Tasks mode), X5 (sessions), X2 (pull requests)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)

## Summary

A session can belong to a task. The link is made when a session starts from a task, when its branch or pull request carries the issue key, or by hand from the link dialog. A linked session shows its task above the conversation and in a Task tab, and moonlet can keep the tracker in step with the work: moving the issue when a session starts, when its PR opens and when every PR merges.

## User journey

1. **Start from a task.** In Tasks mode the user clicks **Start** on a card. The new-session composer opens with `For MOON-151 Drag sessions between sections`, the issue as the first message, the branch `moon-151-drag-sessions-between-sections`, the source's repository, and "Move MOON-151 to In Progress and assign it to me" ticked. ⌘↵ starts the session.
2. **Work on it.** Above the conversation a task bar shows `Tasks / MOON-142 Remote hosts sidebar`, its state, `Session 1 of 2` with arrows to the task's other sessions, and `Linear ↗`. The right panel's Task tab shows the description, acceptance criteria, the Keep in step switch and the task's sessions.
3. **Link a session made without a task.** From a session's "No task · Link", or "Link to task" in Tasks mode, a dialog searches tasks, suggests matches and links the session.
4. **Ship it.** Opening the PR moves the issue to In Review and comments the PR link; merging every session's PR suggests moving it to Done.

## Behaviour and acceptance criteria

### Links

- [ ] A session has at most one task: `{connection, key}`. It is stored by the daemon with the session.
- [ ] A session is linked to a task when (first match wins): it has a stored link; its branch name contains the key (if that rule is on, X44); its PR closes the issue or mentions the key (if that rule is on). Links found from the branch or PR are not stored, so renaming a branch or a reconnect never leaves a stale link.
- [ ] A stored link can be removed with **Unlink**; then branch and PR matches are ignored for that session until it is linked again.
- [ ] A worktree whose branch carries a task's key and that no session uses is a "worktree without a session" on that task (X45).

### Starting a session from a task

- [ ] **Start**, **Start a session** and **New session** on a task open the composer with a task chip `For <key> <title>` (removable), and the first message:

```
<key> · <title>
<description, as Markdown>
```

  The user can edit it before sending.
- [ ] Project: the source's repository (X44). Branch: the source's template filled in and cut to the max length, then made unique the same way session branches are (`-2`, `-3`).
- [ ] "Move <key> to In Progress and assign it to me" is shown and ticked when the "session starts" rule is Automatically, shown unticked when it is Suggest, and hidden when Off. It only acts on a task in Todo (or a state not shown); a task further along is left alone.
- [ ] **Start session** on a worktree without a session creates a session on that worktree and branch instead of making a new one.
- [ ] The new session is stored with its link.

### Link dialog

- [ ] Title `Link "<session name>" to a task`; a search field "Search Linear and Jira, or paste a key or URL" (naming the connected trackers).
- [ ] **Suggested**: tasks whose title matches the session name or whose key is in its branch, with the reason (`Title matches the session name · In Progress · no sessions`). ↵ links the first.
- [ ] **Recent in <source>**: the source's recently updated tasks.
- [ ] Pasting a key (`MOON-142`, `#42`, `CU-86abc`) or an issue URL of any connected tracker finds that task, even outside the workspace's sources.
- [ ] Linking sets the stored link. The footer says "Links live in moonlet. <tracker> gets a link back to the PR when one opens."

### Session view

- [ ] A linked session has a **task bar** above the conversation: `Tasks ⌃⌘T` (back to Tasks mode with the task selected), the tracker mark, key and title, a state menu, `Session <i> of <n>` with previous and next when the task has more than one session, and `<tracker> ↗`.
- [ ] The right panel has a **Task** tab, first, shown only for a linked session: tracker, key, priority and cycle; title; description; **Acceptance criteria · <done> of <n>** from the description's checklist items (`- [ ]` / `- [x]`, or a section titled "Acceptance criteria"); the **Keep <tracker> in step** switch with what it will do; **Sessions on this task**, with this session marked; the task's worktrees without a session; **Link to another task** and **Unlink**.
- [ ] The Sessions sidebar can group sessions by **Project** or **Task** ("Group by Project · Task"). In both, a linked session row shows a second line with the task glyph, key and state, in the accent colour with `· out of sync` when it is (X45). A session with no task shows `No task · Link` on hover.

### Keep in step

Each rule is Automatically, Suggest or Off per connection (X44). Suggest shows the task as out of sync with its fix instead of acting. The Task tab's switch turns all of them off for that task.

| When | Then | Default |
|---|---|---|
| A session starts from an issue | move it to In Progress and assign it to me (only from Todo or not shown) | Automatically |
| A pull request opens (not draft) | move the issue to In Review | Automatically |
| Every session's PR is merged | move the issue to Done | Suggest |
| A pull request opens | Linear, Jira, ClickUp: comment on the issue with its link (skipped when the tracker's GitHub integration already links it); GitHub: add `Closes #<n>` to the PR body | Automatically |
| The issue moves to Done | archive its sessions and remove their worktrees (always asks when a worktree has uncommitted changes) | Suggest |

- [ ] "Move" uses the tracker state mapped first onto that column (X44). For Jira it uses the workflow transition that leads to that state; with none, the action fails with "No Jira transition to <state> from <state>".
- [ ] For a GitHub repository source, "move to Done" closes the issue as completed and the other moves do nothing (the column follows the work). For a GitHub project board source, moves set the project's Status field.
- [ ] Each action moonlet takes is recorded in the task's activity (X45), and a failed action shows on the task with its error and a Retry.
- [ ] Actions happen once per event: reopening the app or a repeated PR poll does not move or comment again.

## UI

The designs are the "Session opened from a task" and "Link a session · Start from a task" boards.

## Protocol and RPCs

- `Session` gains `task: Option<TaskRef>`, `TaskRef {connection, key, url}`.
- `session.create` gains `task` and `worktree` (an existing worktree path to adopt).
- `session.update` gains `task` (`null` unlinks).
- No new events: `sessions.changed` already carries sessions.

## Data and config

- The stored link lives in `~/.moonlet/state.json` with the session; a defaulted field, so no state version bump.
- Actions already taken (event, task, session) are recorded in the app's local data so they happen once.

## Security considerations

- Moving issues and commenting are outward-facing. They only happen through rules the user can see and set per connection, defaulting as in the table; Suggest and Off never write to the tracker.
- The issue text becomes the first message only after the user sees it in the composer.
- Comments posted by moonlet contain only the PR's URL and title.

## Out of scope

- Renaming a session's branch from the link dialog.
- Creating an issue from a session.
- More than one task per session.

## Test plan

- Rust: daemon test creating a session with `task`, updating and clearing it, and adopting an existing worktree; unit tests for branch templates and key matching.
- Vitest: link resolution (stored, branch, PR, unlinked), composer prefill, acceptance criteria parsing, Keep in step decisions for each rule and each tracker, actions happening once.
- e2e: start a session from a task (crucial: starting a session), see the task bar and Task tab, link a session from the dialog.

## Open questions

- None yet.
