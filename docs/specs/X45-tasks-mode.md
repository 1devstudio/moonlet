# X45 — Tasks mode

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X44 (task trackers), X46 (tasks in sessions), X2 (pull requests), X32 (workspaces), X42 (subagents), A1 (agent state)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)

## Summary

The sidebar gains a second mode next to Sessions: **Tasks**. It shows the issues of the current workspace's sources (X44) as a board or a list, and puts on each issue the sessions, worktrees and pull requests working on it, with their live agent state. It answers "what is being worked on, by which agent, and what needs me" from the issue side, and flags issues whose tracker state no longer matches the work (**out of sync**) with a one-click fix.

## User journey

1. The user clicks the Tasks button in the sidebar's mode switch (or presses ⌃⌘T). The sidebar lists views and trackers; the centre shows the workspace's default view as a board.
2. Each card shows the issue key, priority, title, and one row per session with its state glyph and its most useful fact. A card with a session waiting on the user is outlined amber.
3. Clicking a card opens its detail on the right: state, assignee, priority, labels, description, sessions, worktrees without a session and activity.
4. Clicking a session row (or **Open**) switches to Sessions mode with that session selected (X46).
5. An out-of-sync card shows a chip, for example `#128 merged · Move to Done`. One click moves the issue.
6. **List** shows the same tasks grouped by column, with rows that expand into their sessions.

## Behaviour and acceptance criteria

### Mode switch

- [x] The sidebar header has a two-button mode switch, Sessions and Tasks, titled `Sessions ⌃⌘T` and `Tasks ⌃⌘T`. ⌃⌘T toggles between them; it is a Run action (X19) and can be rebound. (`runActions.test.ts`, `tasksStore.test.ts`, `tasks-mode.e2e.ts`)
- [x] The Tasks button shows an accent dot and the label `Tasks, <n> out of sync` when tasks are out of sync. (The shown workspace's tasks are checked every 5 minutes in Sessions mode too; `tasksView.test.ts`.)
- [ ] With no source in the current workspace, the Tasks button opens the "Connect a task tracker" popover instead: Linear, Jira Cloud, ClickUp and GitHub Issues rows (each opening its connect flow, X44), "Open Settings › Task trackers" and "Not now". (Partly: Tasks mode opens and shows the "Connect a task tracker" panel in the centre instead of a popover.)
- [x] The mode is remembered per workspace across restarts.

### Sidebar in Tasks mode

- [x] Rows: workspace switcher, mode switch, "Find a task ⌘K", **Views**, **Trackers**, and a footer `<tracker> synced <age>` with a refresh button. (Find a task is a filter field; ⌘K stays the Run action palette.)
- [ ] Views, each with a count: My issues, Current cycle (Linear cycle, Jira active sprint; hidden when the source has neither), In review, Out of sync (count in the accent colour), Sessions without a task. (Partly: no Current cycle view yet, see Out of scope.)
- [x] Trackers lists each source as `<tracker> · <source>` with its key prefix, and `Connect…` for a tracker not connected yet.

### Board

- [ ] The header shows the view name and a line such as `Moonlet · Cycle 14 · Oct 7 – Oct 20 · 9 tasks · 6 sessions`, then filters (`Assignee: me`, `Hide empty Done`), the Board / List switch and Refresh. (Partly: the title and the summary; no filters yet.)
- [x] Columns Todo, In Progress and In Review, each with its glyph and count. Done is a narrow collapsed column with its count and a badge counting done tasks that still have sessions or worktrees (`1 needs clean-up`); clicking it opens List. (`tasks-mode.e2e.ts`)
- [x] **Card:** key, priority bars, project (when different from the workspace's main one), assignee initials, title. Then one row per session: state glyph, session name, meta. With no session: `No sessions` or `1 worktree, no session`. (The source shows when a workspace has more than one. `taskDetails.test.ts` initials.)
- [x] **Row meta**, first match wins: `needs you` (amber) when the session waits on the user; `#<n>` in its PR state colour, `#<n> merged` or `#<n> ✕` for failing checks; `◑ <n>` when the agent has running subagents (X42); otherwise `+<added>`. (`tasksBoard.test.ts`)
- [x] The card is outlined amber when any session needs the user, and highlighted with the accent when selected. (`tasksBoard.test.ts`)
- [x] Task state is shown by shape (empty ring Todo, half Progress, three-quarters Review, filled check Done); agent state by colour, the same `StateGlyph` as the Sessions sidebar.

### Out of sync

A task is out of sync when the work and the tracker disagree. Each case has a chip and a fix:

- [x] **PR merged:** every session on the task has a merged PR and the task is not Done → `#<n> merged`, fix **Move to Done**. (`tasksBoard.test.ts`, `keepInStep.test.ts`; GitHub closes the issue)
- [x] **Work started:** the task is Todo and a session on it is running → `Session running`, fix **In Progress**. Only shown when the "session starts" rule (X46) is not Automatically. (`tasksBoard.test.ts`)
- [x] **Done, still open:** the task is Done and still has sessions that are not archived, or worktrees → `<n> session, <n> worktree`, fix **Clean up**: archive the sessions and remove the worktrees after a confirm, which warns about uncommitted changes. (`keepInStep.test.ts`, `a_worktree_without_a_session_can_be_removed`)
- [x] Out of sync tasks are listed by the Out of sync view and counted on the Tasks button. (`tasksView.test.ts`)
- [x] **Not now** on the detail hides that chip until the task or its sessions change. (`keepInStep.test.ts` driftKey, withoutPutOff)

### Detail panel

- [x] Header: tracker mark, key, copy key, `Open in <tracker>`, more, close. (No "more" menu yet.)
- [x] Title, then State (a menu listing the columns; picking one moves the issue), Assignee, Priority, Labels, and the description cut to four lines with **More**. (`taskDetails.test.ts` stateOptions, `tasksStore.test.ts` moveTask, `tasks-mode.e2e.ts`)
- [x] An out-of-sync block explains why and offers the fix and **Not now**.
- [ ] **Sessions** with a count and `+ New session`. Each session card: glyph, name, **Open** (↵ on the first), `project/branch`, diff stat, one line per agent (icon, name, state with time), and the PR line (`#131 open · 7/7 checks · 1 approval`, or `No pull request · Create PR ⇧⌘P`). (Partly: each session's branch and PR; no agent lines yet.)
- [x] With no session: "No sessions yet. Starting one names the branch after the issue and moves it to In Progress." and **Start a session** (X46).
- [x] **Worktrees without a session**: branch, how it was made or its last commit, **Start session** (adopts the worktree, X46) and remove (with confirm).
- [x] **Activity**: moonlet's own events for the task (session started from it, PR opened, moved by moonlet, worktree found), newest first. (`taskDetails.test.ts` appendActivity, `tasksStore.test.ts`, `tasks-mode.e2e.ts`)

### List

- [x] Groups In Progress, In Review, Todo and Done with counts and a note (`1 needs you`, `1 out of sync`). Done is collapsed to a line. (`tasksList.test.ts`, `tasks-mode.e2e.ts`)
- [x] A row: expand toggle, key, title, drift chip, session glyphs with a summary (`2 working`, `needs you`, `1 worktree`, `none`), PR summary, worktree count, updated time. A row with a session that needs the user has a faint amber background. (`tasksList.test.ts`)
- [x] An expanded row lists sessions (glyph, name, agent with state, branch, diff stat, Open), worktrees (`worktree, no session`, Start session) and, when empty, `Start a session for <key>`. (`tasks-mode.e2e.ts`)
- [x] "Expand all" toggles every row.
- [x] **Sessions without a task** lists sessions of the workspace with no task: glyph, name, `project/branch`, a hint (`Looks like CDK-41 Changelog themes`, or `No matching issue`) and **Link to task** (X46). (`tasksBoard.test.ts`, `tasks-mode.e2e.ts`)

### Find a task

- [ ] ⌘K in Tasks mode searches tasks of the workspace by key and title, and accepts a pasted key or issue URL of any connected tracker. (Partly: "Find a task" filters by key and title, `taskDetails.test.ts` findTasks, `tasks-mode.e2e.ts`; pasted keys and URLs work in the link dialog.)

## UI

The designs are the "Tasks mode · Board", "Tasks mode · List", "Task card states" and "Tasks with no tracker connected" boards. Colours: accent `#d97757` for selection and out of sync, amber `#f2c94c` for needs you, green, purple and red for PR open, merged and failing, the same as X2.

Empty states: a workspace with no source shows "No task tracker in this workspace" in the centre (until X44's Settings page and the connect popover ship, a source is a project with a GitHub origin); no tasks in the view ("Nothing assigned to you in Cycle 14"), a failed sync (last good list with `Linear sync failed 3 min ago · Retry`), loading (skeleton cards).

## Protocol and RPCs

- `project.worktrees {id}` (daemon) → `[{path, branch, last_commit_ms}]`: the linked worktrees from `git worktree list --porcelain` (not the main checkout, and not prunable ones whose directory is gone; `branch` is `null` when detached), so worktrees made outside moonlet show on their task.
- Tasks themselves come from the desktop's tracker commands (X44).

## Data and config

- UI state (mode per workspace, view, layout, expanded rows, hidden chips) in the app's local settings.
- The board is computed in the app from tasks, sessions (`Session.task`, X46), PR state (X2), git stats and worktrees; nothing about the board is stored.

## Security considerations

Titles, descriptions and labels from trackers are untrusted and rendered as text or sanitised Markdown. Clean up archives sessions and removes worktrees only after a confirm, which names any uncommitted changes.

## Out of scope

- A Current cycle view and the header's filters (Assignee, Hide empty Done): the board shows the user's issues, or all open issues of a source set to show them.
- ⌘K searching tasks: ⌘K stays the Run action palette; "Find a task" in the Tasks sidebar filters the board, and the link dialog takes pasted keys and URLs.

- Creating tasks ("New task in this column") and drag and drop between columns.
- Activity from the tracker's own history and comments.
- Grouping by assignee or label.

## Test plan

- Vitest on the board model in `apps/desktop/src/lib/`: columns, card rows and meta, amber outline, each out-of-sync case, counts per view, list summaries, sessions without a task and their hints.
- Daemon test for `project.worktrees` with a worktree made by `git worktree add`.
- e2e: with a stub tracker, open Tasks mode, see a card with its session, open the session from the card, and fix an out-of-sync task.

## Open questions

- None yet.
