# X45 — Tasks mode

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X44 (task trackers), X46 (tasks in sessions), X2 (pull requests), X32 (workspaces), X42 (subagents), A1 (agent state)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)

## Summary

The sidebar gains a second mode next to Sessions: **Tasks**. It shows the issues of the current workspace's sources (X44) as a board or a list, and puts on each issue the sessions, worktrees and pull requests working on it, with their live agent state. It answers "what is being worked on, by which agent, and what needs me" from the issue side, and flags issues whose tracker state no longer matches the work (**out of sync**) with a one-click fix.

## User journey

1. The user clicks the Tasks button in the sidebar's mode switch (or presses ⌃⌘T). The sidebar lists views and trackers; the centre shows My issues as a board.
2. Each card shows the issue key, priority, title, and one row per session with its state glyph and its most useful fact. A card with a session waiting on the user is outlined amber.
3. Clicking a card's title opens its detail on the right: state, assignee, priority, labels, description, sessions, worktrees without a session and activity.
4. Clicking a session row (or **Open**) switches to Sessions mode with that session selected (X46).
5. An out-of-sync card shows an Out of sync chip, for example `#128 merged · Move to Done`. One click moves the issue.
6. **List** shows the same tasks grouped by column, with rows that expand into their sessions.

## Behaviour and acceptance criteria

### Mode switch

- [x] The sidebar header has a two-button mode switch, Sessions and Tasks. ⌃⌘T toggles between them; it is a Run action (X19) and can be rebound. (`runActions.test.ts` shortcuts, `tasksStore.test.ts` Tasks mode switch, `tasks-mode.e2e.ts`)
- [x] The two buttons are titled with the shortcut as the user bound it (`Sessions ⌃⌘T` and `Tasks ⌃⌘T` by default). (`tasksView.test.ts` modeSwitch)
- [x] The Tasks button counts the tasks that are out of sync. In Sessions mode too, the shown workspace's tasks load when it opens. (`tasksBoard.test.ts` outOfSync, `tasksStore.test.ts` ensureTasks)
- [x] The Tasks button shows an accent dot and the label `Tasks, <n> out of sync` when tasks are out of sync, and in Sessions mode the shown workspace's tasks are asked for again every 5 minutes (X44 Sync limits how often). (`tasksView.test.ts` modeSwitch, `tasksStore.test.ts` the out-of-sync dot's poll)
- [x] With no source in the current workspace, Tasks mode shows a "Connect a task tracker" panel in the centre: a GitHub Issues row (add a project with a GitHub origin to the workspace), Linear, Jira Cloud and ClickUp rows that open Settings › Task trackers, "Open Settings › Task trackers" and "Not now". (`tasks-mode.e2e.ts`)
- [x] The mode is remembered per workspace across restarts. (`tasksStore.test.ts` remembers Tasks mode per workspace across restarts)

### Sidebar in Tasks mode

- [x] Rows: workspace switcher, mode switch, a "Find a task" field, **Views**, **Trackers**, and a footer `<tracker> synced <age>` with a refresh button. "Find a task" filters the board by key or title. (`tasksView.test.ts` syncedLabel, `taskDetails.test.ts` findTasks, `tasks-mode.e2e.ts`)
- [x] After a failed sync the footer reads `Sync failed · <error>` instead. (`tasks-mode.e2e.ts`)
- [x] Views, each with a count: My issues, In review, Out of sync (count in the accent colour), Sessions without a task. (`tasksView.test.ts`)
- [x] Trackers lists each source of the workspace as `<tracker> · <source>`, with a red dot when its connection needs attention. (`trackerSources.test.ts` sourceList, `task-trackers.e2e.ts`)

### Board

- [x] The header shows the view name and a summary such as `9 tasks · 6 sessions`, then filters (`Assignee: me`, on for a new install, which keeps a task you have a session on and decides whose issues are fetched: off, every source also brings everyone's open issues, GitHub included, fetched as soon as it is turned off (X44); `Hide empty Done`; both kept across restarts) and the Board / List switch. (`tasksView.test.ts` boardSummary, filterBoard, `tasksStore.test.ts` the header's filters and Assignee: me decides whose issues are fetched, `tasks-mode.e2e.ts`, `task-trackers.e2e.ts` shows everyone's open issues once Assignee: me is off)
- [x] Columns Todo, In Progress and In Review, each with its glyph and count. (`tasks-mode.e2e.ts`)
- [x] Done is a narrow column: a button that opens List. (`tasks-mode.e2e.ts`)
- [x] The Done button shows its count and a badge counting done tasks that still have sessions or worktrees (`1 needs clean-up`). (`tasksList.test.ts` groups In Progress, In Review, Todo and Done, `tasks-mode.e2e.ts`)
- [x] **Card:** key, priority bars, the task's source (its repository, or its team, project or list; in full, such as `acme/web` or `globex ENG`, when two share a name) when the workspace's tasks come from more than one source, assignee initials, title. Then one row per session: state glyph, session name, meta. With no session: `No sessions` or `1 worktree, no session`, and **Start**. (`taskDetails.test.ts` initials, `tasksView.test.ts` sourceLabels, `tasksBoard.test.ts`, `tasks-mode.e2e.ts`)
- [x] A card whose task has a worktree without a session shows **Start session** (on the worktree) instead of Start. (`tasks-mode.e2e.ts`)
- [x] **Row meta**, first match wins: `needs you` (amber) when the session waits on the user; `#<n>` in its PR state colour, `#<n> merged` or `#<n> ✕` for failing checks; `◑ <n>` when the agent has running subagents (X42); otherwise `+<added>`. (`tasksBoard.test.ts`)
- [x] The card is outlined amber when any session needs the user, and highlighted with the accent when selected. (`tasksBoard.test.ts`)
- [x] Task state is shown by shape (empty ring Todo, half In Progress, three-quarters In Review, filled check Done); agent state by colour, the same `StateGlyph` as the Sessions sidebar. (`taskDetails.test.ts` glyphShape)

### Out of sync

A task is out of sync when the work and the tracker disagree. Each case has an Out of sync chip and a fix:

- [x] **PR merged:** every session on the task has a merged PR and the task is not Done → `#<n> merged`, fix **Move to Done** (GitHub closes the issue as completed). (`tasksBoard.test.ts`, `keepInStep.test.ts`)
- [x] **PR open:** a Linear, Jira or ClickUp issue in Todo or In Progress has a session whose PR is open and not a draft → `#<n> open`, fix **Move to In Review**. (`tasksBoard.test.ts`, `keepInStep.test.ts`)
- [x] **Work started:** the task is Todo and has a live session → `Session running` while an agent works, else `Session open`; fix **In Progress**. It shows unless the "session starts" rule (X46) is Off; under Automatically it covers sessions linked by their branch, which nothing moved. (`tasksBoard.test.ts` work started)
- [x] Work started also reads `Session running` while an agent waits on the user, and it is never fixed by itself. (`tasksBoard.test.ts`, `keepInStep.test.ts` never moves a task by itself for work started)
- [x] **Done, still open:** the task is Done and still has sessions that are not archived, or worktrees → `<n> session, <n> worktree`, fix **Clean up**: archive the sessions and remove the worktrees after a confirm, which warns about uncommitted changes. (`keepInStep.test.ts`, `a_worktree_without_a_session_can_be_removed`)
- [x] A rule set to Off (X46), or the Task tab's Keep in step switch turned off, hides that task's chips, work started included. (`keepInStep.test.ts` rules, `tasksStore.test.ts` Keep in step switch)
- [x] Out of sync tasks are listed by the Out of sync view and counted on the Tasks button. (`tasksView.test.ts`)
- [x] **Not now** on the detail hides that chip until the task or its sessions change. (`keepInStep.test.ts` driftKey, withoutPutOff)

### Detail panel

- [x] Header: key, copy key, `Open in <tracker>` naming the task's own tracker, close. (`tasks.test.ts` trackerName, `tasks-mode.e2e.ts`)
- [x] Title, then State (a menu: Todo, In Progress, In Review and Done for a tracker issue, Open and Closed for a GitHub issue; picking one moves it), Assignee, Priority (with the cycle when there is one), Labels, and the description cut to four lines. A move that fails shows on the task with Retry and as an error toast. (`taskDetails.test.ts` stateOptions, `tasksStore.test.ts` moveTask and a failed action shows on its task with Retry, `tasks-mode.e2e.ts`, the cycle in `task-trackers.e2e.ts` shows the team's issues in Tasks mode)
- [x] An out-of-sync block shows the chip's text with the fix and **Not now**. (`tasksStore.test.ts` chip's fix, `keepInStep.test.ts` withoutPutOff)
- [x] **Sessions** with a count and `+ New session`. Each session card: glyph, name, **Open** (↵ on the first, outside a field or button and with nothing over Tasks mode), `project/branch`, diff stat, one line per agent (name, state and time since its last output), and the PR line (`#131 open · 7/7 checks · approved`, or `No pull request · Create PR ⇧⌘P`). (`taskDetails.test.ts` sessionCard, enterOpensFirst, `tasks-mode.e2e.ts`)
- [x] With no session: "No sessions yet. Starting one names the branch after the issue." (`tasks-mode.e2e.ts`)
- [x] **Worktrees without a session**: branch, **Start session** (adopts the worktree, X46) and remove, after a confirm that warns when uncommitted changes would be lost. (`tasksBoard.test.ts`, `keepInStep.test.ts` removeWorktreeAsk, `worktrees_made_outside_moonlet_are_listed_and_can_be_adopted`, `a_worktree_without_a_session_can_be_removed`)
- [x] **Activity**: moonlet's own events for the task, newest first, at most 20: each PR opened on its sessions (`PR #12 opened: <title>`, once per PR, whatever the rules), and what moonlet moved, closed or reopened. (`taskDetails.test.ts` appendActivity, `tasksStore.test.ts` records each PR that opens on a task's sessions once and moving a task from its state menu, `tasks-mode.e2e.ts`)
- [x] Activity also records a session started from the task, what moonlet assigned or commented, and changes outside moonlet (X44). (`tasksStore.test.ts` open spec lines: Activity, a linked task changed outside moonlet)

### List

- [x] Groups In Progress, In Review, Todo and Done with counts. Every group but Done notes `<n> needs you` and `<n> out of sync`; Done is collapsed to a line noting `<n> needs clean-up`. (`tasksList.test.ts`, `tasks-mode.e2e.ts`)
- [x] A group with both notes joins them: `1 needs you · 1 out of sync`. (`tasksList.test.ts` a group with both notes)
- [x] A row: expand toggle, key, title, session glyphs with a summary (`2 working`, `needs you`, `1 session`, `1 worktree`, `none`), PR summary, worktree count. A row with a session that needs the user has a faint amber background. (`tasksList.test.ts`)
- [x] A row also shows its Out of sync chip with its fix, and its updated time, kept current. (`tasksList.test.ts` a row's chip and updated time)
- [x] An expanded row lists sessions (glyph, name, branch, meta), worktrees (`worktree, no session`, Start session) and, when empty, `Start a session for <key>`. (`tasks-mode.e2e.ts`)
- [x] "Expand all" opens every row, then "Collapse all" closes them. Open rows are remembered across restarts. (`tasks-mode.e2e.ts`, `tasksStore.test.ts` the List layout's open rows)
- [x] **Sessions without a task** lists sessions of the workspace with no task: glyph, name, branch, a hint (`Looks like CDK-41 Changelog themes`, or `No matching issue`) and **Link to task** (X46). (`tasksBoard.test.ts`, `tasks-mode.e2e.ts`)

## UI

The designs are the "Tasks mode · Board", "Tasks mode · List", "Task card states" and "Tasks with no tracker connected" boards. Colours: accent `#d97757` for selection and out of sync, amber `#f2c94c` for needs you, green, purple and red for PR open, merged and failing, the same as X2.

States: a workspace with no source shows the "Connect a task tracker" panel; "Loading tasks…" before the first list; a failed sync keeps the last good list and says `Sync failed · <error>` in the sidebar's footer.

## Protocol and RPCs

- `project.worktrees {id}` (daemon) → `[{path, branch, last_commit_ms}]`: the linked worktrees from `git worktree list --porcelain` (not the main checkout, and not prunable ones whose directory is gone; `branch` is `null` when detached), so worktrees made outside moonlet show on their task.
- Tasks themselves come from the desktop's tracker commands (X44).

## Data and config

- Kept in the app's local storage: the mode per workspace, Board or List, the List's open rows, each task's Keep in step switch and Activity, and the automatic fixes already made (X46). The view and chips put off with Not now last until the app quits.
- The board is computed in the app from tasks, sessions (`Session.task`, X46), PR state (X2), git stats and worktrees; nothing about the board is stored.
- Building the board grows with tasks times sessions and worktrees, not with tasks squared: a workspace with 2000 issues, 60 sessions and 60 worktrees builds it in well under a second, so the app stays responsive while it rebuilds during an agent's work.

## Security considerations

Titles, descriptions and labels from trackers are untrusted and shown as plain text. Clean up archives sessions and removes worktrees only after a confirm, which names any uncommitted changes.

## Out of scope

- A Current cycle view (Linear cycle, Jira active sprint): it needs each tracker's cycle or sprint dates, which moonlet does not read yet.
- ⌘K searching tasks: ⌘K stays the Run action palette; "Find a task" in the Tasks sidebar filters the board, and the link dialog (X46) takes pasted keys and URLs.
- A connect popover on the Tasks button; a `Connect…` row and key prefixes in the Trackers list; the tracker's mark and a "more" menu in the detail header.
- Creating tasks ("New task in this column") and drag and drop between columns.
- Activity from the tracker's own history and comments.
- Grouping by assignee or label.

## Test plan

- Vitest in `apps/desktop/src/lib/`: the board's columns, card rows and meta, amber outline, each out-of-sync case, drafts and building a board of 2000 issues (`tasksBoard.test.ts`); fixes, Not now, rules and Clean up's confirm (`keepInStep.test.ts`); views, counts, the header summary and the footer (`tasksView.test.ts`); list groups, notes and rows (`tasksList.test.ts`); the state menu, initials, Find a task and Activity (`taskDetails.test.ts`); the mode switch, moves, Activity and failures with Retry (`tasksStore.test.ts`).
- Daemon tests for `project.worktrees` with a worktree made by `git worktree add`, adopting it and removing it.
- e2e (`tasks-mode.e2e.ts`) with a stub `gh`: open Tasks mode, see a card with its session, open the session from the card, list sessions without a task, start a session from a task, the list layout, Find a task, and close an issue from the detail's state menu.

## Open questions

- None yet.
