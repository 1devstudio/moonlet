# X57 — Tasks on the phone

- **Status:** implemented (2026-10-20; the phone screens checked in a browser against fixture replies, not yet on a phone with a real Mac)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X40 (phone app), X44 (task trackers), X45 (Tasks mode), X46 (tasks in sessions), X50 (boards), X52 (new issue from a column), X53 (moving tasks), X54 (new session composer)
- **Related ADRs:** [0008](../adr/0008-phone-link-over-tailscale.md), [0010](../adr/0010-task-trackers-in-the-app.md) (amended by this spec)

## Summary

The phone app gets a **Tasks** tab: the boards the desktop shows in Tasks mode (X50), with each task's sessions live. The user can switch boards, open a task, change its state, create an issue in a column and start a session from a task. The phone holds no tracker tokens (ADR 0010). The desktop app shares what it reads from the trackers through the daemon: after each sync it saves a **board snapshot** per workspace in that workspace's daemon, and the phone reads it. The phone asks the desktop to move and create issues through a **relay** in the daemon, the way terminal reads ask the app (X31). The tab bar becomes **Sessions · Tasks · Needs you · Hosts**, from the design "Moonlet Tasks Mode.html" (pages Phone, tasks board; Phone, board switcher; Phone, task detail; Phone, session).

User decisions (2026-10-20): the desktop shares its boards through the daemon (option A, over a tracker client on the phone or tracker calls in the daemon); scope is the board and list, moving a task, a new issue from a column, and starting a session from a task; the design's tab bar; no Across boards group (as on the desktop, 2026-10-17); the session screen keeps its four tabs and gains the design's task line and subagent strip.

## User journey

1. The user opens the **Tasks** tab. It shows the board last shown on the phone (else the first board of the shown workspace): "Moonlet · Cycle 14", "Linear · 9 tasks · 6 sessions", and column tabs **In Progress 3 ●**, **In Review 3 ●**, **Todo 2**, **Done 6**.
2. **In Progress** lists its cards. "MOON-147 Block styling pass" has a yellow border: its session "needs you". The user taps the session row, lands in the session's Chat tab, and allows the ask.
3. Back on the board, **In Review** shows "MOON-144 File tabs" with "#128 merged · Move to Done". The user taps **Move to Done**. The card leaves In Review at once; the Mac moves it in Linear.
4. The user taps the board title, picks "OPS · Sprint 42" under **Acme · switches workspace**, and the shown workspace becomes Acme.
5. The user opens "MOON-142 Remote hosts sidebar": its state (**In Progress ▾**), description, its two sessions, a worktree without a session with **Start**, and its activity. **New session for MOON-142** opens New session with the task attached and its branch named by the tracker's template.

## Behaviour and acceptance criteria

### The snapshot: what the desktop shares

- [x] After each Tasks sync of a workspace, and after a move, a create, a fix or a new activity line, the desktop saves that workspace's snapshot in the workspace's own daemon (`tasks.set_snapshot`), at most once a second and only when it changed. A snapshot holds, for each of the workspace's boards: its saved settings (`BoardConfig`, X50), what the last sync read (`BoardData`: keys, sprint, kind, error), the board's tasks as placed on it (`placedTasks`), the worktrees, each linked connection's branch template (X44), the activity lines of its tasks (at most 20 each), whether the connection needs attention, and when it synced (`synced_at`) on which Mac (`from`). It holds no token. (`taskSnapshot.test.ts` shares the workspace's shown boards with their tasks where the board puts them, moves under way included; carries the activity and attention of its own tasks and connections, the branch templates, and no account; `snapshotsToShare` shares each workspace with boards once until it changes; `tasks-mode.e2e.ts` shares the board with the phone through the workspace's daemon (X57); the second's wait is not tested)
- [x] A workspace whose boards were all removed gets an empty snapshot, so the phone stops showing them.
- [x] While a phone is paired (`mobile.status`), the app syncs every workspace that has a board every 5 minutes, as it does the shown one, so each has a snapshot. (`workspacesToPoll` in `tasksStore.test.ts`) (`taskSnapshot.test.ts` empties a workspace it shared before once its boards are gone)
- [x] The daemon keeps one snapshot per workspace, refuses one over 4 MB, saves it in `~/.moonlet/tasks/<workspace id>.json` (mode 0600) so it outlives a restart, and sends `tasks.changed` with it to every client. A workspace's removal removes its snapshot. (`mobile.rs` the_apps_board_snapshot_reaches_the_phone_and_outlives_a_restart, only_the_app_shares_boards_and_a_workspace_takes_its_boards_along)

### The Tasks tab

- [x] The tab bar is **Sessions · Tasks · Needs you · Hosts**. Needs you is the old Inbox, with its badge; New session moves to a `+` in the Sessions title and to **New session for <key>** on a task. (Seen in a browser against fixture replies; `TabBar.tsx` has no logic to test.)
- [x] Tasks shows one board: the one last shown on the phone, else the shown workspace's first. Its header has the workspace's letter tile, the board's title with ▾ (opens the switcher), the desktop's subtitle (`boardHeader`: "Linear · 9 tasks · 6 sessions", a sprint or cycle), and a search button that filters cards by key and title. (`board.test.ts` heads the board as the Mac does; `phoneBoards` lists the boards of the shown workspace on connected hosts)
- [x] Under the header, a tab per shown column, in the board's order (folded ones too, hidden ones not), each with its category glyph, name and card count, and a dot: yellow when one of its sessions needs the user, orange when one of its cards is out of sync. A column's WIP limit shows as `3/4`. (`board.test.ts` has a tab per shown column with its count, and a dot where a session needs the user or a card is out of sync; `firstColumn`)
- [x] Each card shows the key, the priority bars (0–3), the project (when the board starts sessions in several), the assignee's initials, the title, the desktop's card line (`cardFace`: parent, due, estimate, as the board's card fields say), and a row per session: its state glyph, name and meta (`RowMeta`: "needs you", "◑ 5" for subagents, a PR number, a diff stat), opening the session. A card whose session needs the user has a yellow border. A card without a session has **Start a session**. A card out of sync shows the drift's text and its fix ("#128 merged · Move to Done"). (`board.test.ts` puts on each card its key, priority, assignee, card line and live sessions, and an out-of-sync fix)
- [x] The cards and their sessions come from the desktop's `tasksBoard` and `boardColumns`, given the snapshot's tasks and the phone's live sessions, PRs and diff stats from the same host: a session's state changes on the board as it changes, without a new snapshot. (`board.test.ts`, the sessions from the phone's own host data and PRs)
- [x] Without any board on any connected host, the tab says "No boards yet. Add one in moonlet on the Mac (Tasks › Add a board)." (Seen in a browser against fixture replies.)
- [x] A snapshot older than 15 minutes says "Synced <n> min ago on <Mac>. Open moonlet on the Mac to sync." under the header. A board whose sync failed shows its error (`boardProblem`). (`staleLine` in `board.test.ts`)

### Board switcher

- [x] Tapping the title opens **Boards**: a search box ("Find a board") and the desktop's `switcherGroups`: the shown workspace's boards first ("this workspace"), then each other workspace's ("switches workspace"), each row with the tracker's letter tile, the board's name, "<n> tasks · <n> sessions", a yellow dot when a session needs the user, and ✓ on the shown board. Picking a board of another workspace switches the phone's shown workspace. (`switcher` in `board.test.ts`)
- [x] No Across boards group (My tasks, Out of sync), as on the desktop.

### Task detail

- [x] Tapping a card opens the task: **‹ Board**, open in the tracker (↗), ⋯ (Copy link); the tracker tile, key, priority and sprint or cycle; the title; the state menu; the description, Markdown without HTML comments, folded after 3 lines with **More**; **Sessions · <n>**, each with its state, name, agent and state word ("Claude · working 2:14 · 5 subagents"), branch and diff stat, and "A subagent is waiting for your approval" when one is; **Worktree without a session**, each with its branch, last commit age and **Start**; **Activity**, newest first; and **New session for <key>** at the bottom. (`taskDetail` in `taskView.test.ts`; `activityTime`)
- [x] The state menu lists the board's columns (`stateChoices`), the current one checked. Picking one moves the task (see Moving). (`taskDetail`'s choices in `taskView.test.ts`)

### Moving, creating and fixing through the Mac

- [x] Moving a task (state menu, a drift fix) shows it in the new column at once, as the desktop does (`withStatus`), and asks the Mac to move it (`tasks.request` `move`). The Mac moves it as its own State menu does (X53), for every tracker, GitHub included, and saves a new snapshot. If the Mac refuses or does not answer, the card goes back and the phone says why. (`board.test.ts` shows a move the phone asked for at once, in its new column; `pruneMoves` in `taskView.test.ts`; `taskActions.test.ts` asks for moves the Mac's app understands, and a refused move goes back and says why unless a newer one replaced it; `tasksStore.test.ts` moves a task the phone asks for, and says why the tracker refused; `tasksRelay.test.ts` moves a task to a column's first status, or to the status the phone names, and refuses what the Mac no longer has)
- [x] **New issue in <column>**, at the top of a column that takes new issues (X52's `createTarget`), opens the X52 form on a sheet: Title, Description, Assignee, Labels, and the issue type or place where X52 asks for one. Its people and labels come from the Mac (`create_options`). **Create** asks the Mac to create the issue (`create`); the new card shows in the column and its detail opens. The Mac checks the request as its own form does: a title, a place among the board's projects or the workspace's repositories, and a Jira issue type. Create waits for the Mac's lists. When the Mac does not answer in time, the sheet says it may still create the issue. The new task's detail says it is waiting for the Mac's snapshot until it arrives. (`issueForm` in `taskView.test.ts`; `taskActions.test.ts`; `tasksRelay.test.ts` checks a create as the form does)
- [x] Every request needs moonlet open on a Mac: with no app connected to the daemon, the phone says "Open moonlet on the Mac to change tasks." at once; a request no app answers in 30 s fails with "moonlet on the Mac did not answer." One app connection gets each request, the longest connected, so two apps never both create an issue. (`mobile.rs` a_phones_task_request_is_answered_by_the_app: no app, a refusal, the timeout, a second answer, a phone cannot answer; one_app_takes_a_task_request_and_agents_cannot_answer_one)

### Starting a session from a task

- [x] **New session for <key>** and **Start a session** open New session with the task attached as the desktop's composer does (X54: "<key> description sent with your message"), the session named after the task, and the branch the tracker's template makes (`task_branch_name`, now also a command of the phone's core, from `moonlet-trackers`). **Start session** creates the session linked to the task (`session.create` with `task`), then tells the Mac it started from the task (`started`), so the Mac runs Keep in step's "session starts" rule (X46) and adds the activity line. (`taskPreset` in `taskView.test.ts`; `composer` in `newSession.test.ts` starts from a task; `tasksStore.test.ts` tells of a session started from a task as the Mac's composer does, and answers; `moonlet-trackers` a_tasks_branch_takes_its_trackers_template_or_the_default, which both apps' `task_branch_name` call)
- [x] **Start** on a worktree without a session starts a session in that worktree (`session.create` with `worktree`), linked to the task. (`composer` in `newSession.test.ts`, started on a worktree without a session)

### The session screen

- [x] A session with a task shows the task's state glyph, key, state and project under its title ("◑ MOON-142 · In Progress · moonlet"), from the snapshot. Links derived from the branch or PR (`taskForSession`) count, now that the phone has the tasks. (`sessionTask` in `sessionList.test.ts`)
- [x] While the session's chat runs subagents, a strip under the header shows a bar per agent in its state's colour, "<done>/<n>", and "<n> needs you", "all running", "all done", or how many failed or stopped. (`agentStrip` in `chatView.test.ts`)

## UI

The design export "Moonlet Tasks Mode.html", phone pages, 390 × 844, dark only. The tablet page is out of scope (X40 has no iPad layout).

## Protocol and RPCs

- `tasks.snapshot {workspace?}` → `{ workspace, snapshot }[]`: the saved snapshots, all or one workspace's.
- `tasks.set_snapshot {workspace, snapshot}` → `true`. Refused for phones and the CLI ("only the moonlet app shares boards"), for an unknown workspace, and over 4 MB.
- Event `tasks.changed {workspace, snapshot}`.
- `tasks.request {workspace, action}` → the app's answer. `action` is one of:
  - `{kind: "move", board, task, column, status?}`
  - `{kind: "create_options", board, column, place?, issue_type?}`
  - `{kind: "create", board, column, issue: NewIssue}`
  - `{kind: "started", task, session}`
  The daemon gives it an id, sends event `tasks.request {request_id, workspace, action}` to one app connection (the longest connected), and answers the caller with its `tasks.answer`; it fails at once with no app connected, or after 30 s. The app syncs a workspace it has not read for at most 10 s before it acts.
- `tasks.answer {request_id, ok, result?, error?}` → `true`; from the app only; a second answer gets "already answered". The app is the connection whose hello says `moonlet-app`: the same self-declared name X31's reads trust.
- The phone's core gains a `task_branch_name` command, the desktop's (`moonlet-trackers::branch`).

The snapshot is JSON the daemon stores and forwards without reading it beyond its size; its shape is the desktop's TypeScript (`TaskSnapshot` in `apps/desktop/src/lib/taskSnapshot.ts`, `version: 1`), so both apps build it and read it with the same code.

## Data and config

- Daemon: `~/.moonlet/tasks/<workspace id>.json` per workspace, 0600.
- Phone: the board shown and the column shown per board, in the webview's storage.
- Nothing new in `trackers.toml`.

## Security considerations

- ADR 0010 kept tracker data in the app. With this spec, issue titles, descriptions, assignees' names and labels of the boards a user shows are saved on each daemon host that owns a workspace with boards, including remote hosts. Tokens stay in the Mac's Keychain. The amendment to ADR 0010 records this.
- A phone already has full access to its daemon (X39). It can now also ask an open desktop app to move or create issues as the user; the app does only the four actions above, for boards it has, and never with input it did not validate the same way its own UI does.
- Descriptions are rendered through the desktop's sanitising Markdown renderer.

## Out of scope

- Tracker tokens or connections on the phone; Add a board, Board settings and Settings › Task trackers (on the Mac).
- Across boards (My tasks, Out of sync), as on the desktop.
- Drag and drop between columns; the List layout; the tablet layout.
- Keep in step running without a Mac: rules still run in the desktop app (ADR 0010).

## Test plan

- Rust, daemon: `tasks.set_snapshot` / `tasks.snapshot` / `tasks.changed` (saved, reloaded after a restart, refused for a phone, over 4 MB, removed with its workspace); `tasks.request` / `tasks.answer` (first answer wins, no app → error at once, timeout, phone and CLI cannot answer).
- Vitest, desktop: the snapshot is built from a workspace's data and boards (`taskSnapshot.test.ts`), pushed only when changed; the Mac answers each request kind as its own UI would (`tasksRelay.test.ts`, with the existing fixtures).
- Vitest, phone: the board from a snapshot and live sessions; column tabs, dots and counts; the switcher; the detail's sections; staleness; request errors; the session's task line and subagent strip; the composer preset.
- Rust, phone core: `task_branch_name` with the desktop's cases.
- e2e, desktop: a sync saves a snapshot the daemon returns (`tasks-mode.e2e.ts`).
- The phone screens are checked in a browser against fixture replies, and once against a real Mac.

## Open questions

- None. Decided 2026-10-20: GitHub moves and creates go through the Mac too, like every tracker, so moves follow one path and show in the Mac's activity.
