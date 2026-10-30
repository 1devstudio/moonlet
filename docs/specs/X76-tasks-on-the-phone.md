# X76 — Tasks on the phone

- **Status:** implemented (2026-10-29; the phone screens checked in a browser against fixture replies, not yet on a phone with a real Mac)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X40 (phone app), X44 (task trackers), X45 (Tasks mode), X46 (tasks in sessions), X50 (boards), X52 (new issue from a column), X53 (moving tasks), X54 (new session composer), X66 (task comments), X68 (one account)
- **Related ADRs:** [0008](../adr/0008-phone-link-over-tailscale.md), [0010](../adr/0010-task-trackers-in-the-app.md) (amended by this spec)

## Summary

The phone app gets a **Tasks** tab: the boards the desktop shows in Tasks mode (X50), with each task's sessions live. The user can switch boards, filter to their own tasks, open a task, move it, fix what is out of sync, read and post comments, create an issue in a column, start a session from a task and link a session to a task. The phone holds no tracker tokens (ADR 0010). The desktop app shares what it reads from the trackers through the daemon: after each sync it saves a **board snapshot** per workspace in that workspace's daemon, and the phone reads it. The phone asks the desktop to move, create, fix and comment through a **relay** in the daemon, the way terminal reads ask the app (X31). The tab bar becomes **Inbox · Sessions · Tasks · New · Hosts**.

The screens follow the design export "Moonlet Mobile.html" (2026-10-28): Tasks · board, Task detail, Move task sheet, Start a session from a task, Link a session to a task, and the task lines of Sessions and Session · Chat. This spec replaces the unmerged first version of 2026-10-20 (PR #294, then numbered X57), whose daemon and desktop parts it keeps.

User decisions: the desktop shares its boards through the daemon, and every tracker's changes, GitHub's included, go through the Mac (2026-10-20); the tab bar of the 2026-10-28 design, with New back as a tab (2026-10-29); no Across boards group, as on the desktop.

## User journey

1. The user opens **Tasks**. It shows the board last shown on the phone: the board button reads "WEB · Sprint 42" over "Jira · acme.atlassian.net · Oct 20 – Nov 2 · 12 issues · 4 sessions", with **Assignee: me** and "2 out of sync" under it, and column tabs **To Do 3**, **In Progress 3**, **Code Review 2**, **QA 1**, **Done 6**.
2. **In Progress** lists its cards. "WEB-271 Add search to the product list" has a yellow border: its session "needs you". Under it, "#147 open · still In Progress" with **Move to Code Review**. The user taps it; the card leaves the column at once, and the Mac moves it in Jira.
3. The user opens "WEB-268": state **In Progress ▾**, "Bug · 2 pt", **High**; its assignee, sprint and labels; the Out of sync box; its session with branch, agent and PR lines; the description and its acceptance criteria; two comments and a box to leave one; the activity folded to its last line.
4. The user taps the state and picks **Code Review** in the Move sheet (suggested: PR #142 is open). **Move to Code Review** asks the Mac.
5. On "WEB-279" in To Do the user taps **Start**. New session opens with WEB-279 attached, the branch the tracker's template makes, and **Move to In Progress** checked. **Start session** starts it and the Mac moves and assigns the issue.
6. In Sessions, "Dark mode for account pages" shows "WEB-283?" — a task its title matches. The user taps it, and **Link** on WEB-283 in the sheet links the session.

## Behaviour and acceptance criteria

### The snapshot: what the desktop shares

- [x] After each Tasks sync of a workspace, and after a move, a create, a fix or a new activity line, the desktop saves that workspace's snapshot in the workspace's own daemon (`tasks.set_snapshot`), at most once a second and only when it changed. A snapshot holds, for each of the workspace's boards: its saved settings (`BoardConfig`, X50), what the last sync read (`BoardData`: keys, sprint, kind, error), the board's tasks as placed on it, the worktrees, each linked connection's branch template and Keep in step rules (X44, X46), the activity lines of its tasks (at most 20 each), whether the connection needs attention, and when it synced on which Mac (`from`). It holds no token. (`taskSnapshot.test.ts` shares the workspace's shown boards with their tasks where the board puts them, moves under way included; carries the activity and attention of its own tasks and connections, the branch templates, and no account; `snapshotsToShare` shares each workspace with boards once until it changes; `tasks-mode.e2e.ts` shares the board with the phone through the workspace's daemon (X76))
- [x] A workspace whose boards were all removed gets an empty snapshot, so the phone stops showing them. (`taskSnapshot.test.ts` empties a workspace it shared before once its boards are gone)
- [x] While a phone is paired (`mobile.status`), the app syncs every workspace that has a board every 5 minutes, as it does the shown one, so each has a snapshot. (`tasksStore.test.ts` keeps every workspace with a board synced while a phone is paired, on connected hosts)
- [x] The daemon keeps one snapshot per workspace, refuses one over 4 MB, saves it in `~/.moonlet/tasks/<workspace id>.json` (mode 0600) so it outlives a restart, and sends `tasks.changed` with it to every client. A workspace's removal or merge into another removes its snapshot (`mobile.rs` a_merged_workspace_takes_its_boards_along). (`mobile.rs` the_apps_board_snapshot_reaches_the_phone_and_outlives_a_restart, only_the_app_shares_boards_and_a_workspace_takes_its_boards_along)
- [x] The daemon tells whether the moonlet app is open on it: `tasks.app` answers `{open}`, and event `tasks.app` with `{open}` goes to every client when the first app connects or the last one leaves. (`mobile.rs` a_phone_hears_when_the_app_opens_and_closes)

### The tab bar

- [x] The tab bar is **Inbox · Sessions · Tasks · New · Hosts**. Inbox keeps its badge. Tasks carries the number of cards out of sync on the board it shows, when there are any. (`board.test.ts` counts the board's out-of-sync cards for the Tasks badge; the Inbox badge: `inbox.test.ts` lists every ask across hosts, newest first)

### The board

- [x] Tasks shows one board: the one last shown on the phone, else the one the Mac shows, else the shown workspace's first. A workspace of an account (X68) shows its boards once, from the member whose snapshot synced last, with that member's sessions; the phone remembers the board by its account, not by the member. (`board.test.ts` lists the boards of the shown workspace once across an account's members, the newest snapshot's (X68))
- [x] The header has the title **Tasks**, a search button that opens a field filtering the cards by key and title, and the workspace chip (X40). Under it, the board button: the tracker's letter tile in its colour, the board's title (`boardTitle`) and the line "<tracker> · <site> · <sprint dates> · <n> issues · <n> sessions"; it opens the board switcher. (`board.test.ts` heads the board as the Mac does)
- [x] A filter row has **Assignee: me** / **Assignee: anyone**, kept per board, which keeps the user's tasks and those they have a session on (the desktop's `keepCard`); "<n> out of sync" while cards of the board are; and a refresh button that asks the Mac to sync the board (`sync`), spinning until the Mac answers; a refusal shows under it. (`board.test.ts` keeps the user's tasks and the ones with their sessions under Assignee: me; `taskActions.test.ts` asks for fixes, syncs and comments the Mac's app understands; `tasksStore.test.ts` syncs the board the phone asks for)
- [x] Under the filters, a tab per shown column in the board's order (folded ones too, hidden ones not), each with its category glyph, name and card count, the shown one filled. A column with cards to clean up carries their number in red. (`board.test.ts` has a tab per shown column with its count and the number of cards to clean up)
- [x] Above the cards, "<category> · <n> issues" ("tasks" for other trackers than Jira), "· <n> needs clean-up" where some do, and **New issue** where the column takes new issues (X52's `createTarget`). (`board.test.ts` has a tab per shown column with its count and the number of cards to clean up)
- [x] Each card shows the key, the issue type, the priority bars (0–3), the estimate ("5 pt"), the assignee's initials, the title (opens the task), and a row per session: its state glyph, name and meta ("needs you" in yellow, "#147 open" in green, "#131 merged" in purple, "#136 ✕" in red), opening the session. A card whose session needs the user has a yellow border. A card without a session shows "No sessions" with **Start**, or "1 worktree, no session" with **Start session**. A card out of sync shows the drift's text and its fix as a button ("Move to Code Review", "Clean up"). (`board.test.ts` puts on each card its key, priority, assignee, card line and live sessions, and an out-of-sync fix; puts on each card its type and estimate when the board's cards show them)
- [x] The cards and their sessions come from the desktop's `tasksBoard` and `boardColumns`, given the snapshot's tasks and the phone's live sessions, PRs and diff stats: a session's state changes on the board as it changes, without a new snapshot. (`board.test.ts` puts on each card its key, priority, assignee, card line and live sessions, and an out-of-sync fix)
- [x] At the foot of the board, above the tab bar: "Synced by <Mac> <n>m ago" with a green dot while the app is open; "moonlet is closed on <Mac> · showing tasks from <n> h ago · moves wait for it" with a grey dot while it is not. A board whose sync failed, or whose connection needs attention, shows that above the cards. (`board.test.ts` says which Mac synced the board and when, and that moves wait while moonlet is closed there)
- [x] Without any board on any connected host, the tab says "No boards yet. Add one in moonlet on the Mac (Tasks › Add a board)." (`board.test.ts` says how to add a board when no connected host shares one)

### Board switcher

- [x] Tapping the board button opens **Boards**: a search box and the desktop's `switcherGroups`: the shown board's workspace first, then each other workspace's ("switches workspace"), each row with the tracker's tile, the board's name, "<n> tasks · <n> sessions", a yellow dot when a session needs the user, and ✓ on the shown board. Picking a board of another workspace switches the phone's shown workspace. No Across boards group. (`board.test.ts` groups every workspace's boards, the shown board's workspace first, with their tasks, sessions and whether one needs the user; finds a board by its name or its workspace's)

### Task detail

- [x] Tapping a card's title opens the task: back, the tracker's tile and key, a copy button (copies the key), **Open in <tracker> ↗**; the title; a row with the state (glyph, column, ▾, opens the Move sheet), "<type> · <n> pt" and the priority; Assignee (initials and name), Sprint ("Sprint 42 · Oct 20 – Nov 2") and Labels. (`taskView.test.ts` heads the task as the design does: type and estimate, priority, assignee, sprint dates and labels)
- [x] When the task is out of sync, an **Out of sync** box says why in a sentence ("PR #147 is open and not a draft, but the issue is still In Progress.") with the fix as the main button and **Not now**, which hides the box and the card's chip on this phone until the task or its sessions change (the desktop's `driftKey`). (`taskView.test.ts` says in a sentence why the task is out of sync; says what is left of a done task; `board.test.ts` drops a chip put off with Not now, until the task or its sessions change)
- [x] **Sessions <n>** with **New session**: each session a card with its state, name and **Open**; its project and branch with the diff stat; its agent, state word and what it waits for ("Claude · needs you · Allow Bash? · 2m"); and its PR with checks and review ("#147 open · 2/4 checks · 1 failing · review required"). A worktree without a session shows its branch with **Start**. (`taskView.test.ts` lists its sessions with their agent and what they do, and says when one waits for the user; says in a sentence why the task is out of sync (its session lines); offers its worktrees without a session, and its activity, newest first)
- [x] **Description**, rendered through the desktop's Markdown renderer without HTML comments; **Acceptance criteria · <done> of <n>** with its checklist when the description has one (the desktop's `acceptanceCriteria`). (`taskView.test.ts` lists the description's acceptance criteria, and the newest activity line for the folded Activity)
- [x] **Comments <n>**: each with the author's initials, name, how long ago, and its body; "Loading comments…", "No comments yet." or "Couldn't load comments: <why>" with **Retry**; and a box ("Leave a comment") with **Comment**, disabled while blank or posting. The comments come from the Mac (`comments`), and a comment is posted by it (`comment`), which records "You commented" in Activity; a refused comment stays in the box with the reason. (`taskActions.test.ts` reads a task's comments through the Mac, and posts one, then reads them again; keeps a refused comment with its reason; `tasksStore.test.ts` reads a task's comments for the phone, and posts one, noting it in Activity; `tasksRelay.test.ts` posts no blank comment; the rows are the desktop's `commentsView`, now in `commentsView.ts`)
- [x] **Activity** folded to its newest line and when ("moonlet moved it to In Progress · 2 d ago"), opening to every line, newest first. (`taskView.test.ts` lists the description's acceptance criteria, and the newest activity line for the folded Activity; offers its worktrees without a session, and its activity, newest first)

### Move task sheet

- [x] The state opens **Move <key>**: "<board> · the board's columns, in its order", then each shown column with its category glyph, name and a line: its category, "now" on the current one, "suggested, PR #147 is open" in orange on the column an out-of-sync fix moves to, and "Keep in step suggests clean-up after" on a done column. The current one starts picked, else the suggested; the button reads **Move to <column>**, and the footnote says the Mac moves it to the column's first status and notes it in Activity, and that a refusal moves it back with the tracker's message. (`taskView.test.ts` lists the board's columns in order, the current one now, the out-of-sync fix's suggested and picked, and says what the Mac does)
- [x] Moving a task (Move sheet, a drift fix) shows it in the new column at once, as the desktop does (`withStatus`), and asks the Mac to move it (`move`). The Mac moves it as its own State menu does (X53), for every tracker, GitHub included, and saves a new snapshot. If the Mac refuses or does not answer, the card goes back and the phone says why. (`board.test.ts` shows a move the phone asked for at once; `pruneMoves` in `taskView.test.ts`; `taskActions.test.ts` a refused move goes back and says why unless a newer one replaced it; `tasksRelay.test.ts` moves to a column's first status or the one named, and refuses what the Mac no longer has)
- [x] While the app is closed on the Mac, a move waits on the phone: the card shows in its new column with "Waits for moonlet on <Mac>", and the phone sends it when it hears the app open (`tasks.app`). A waiting move is kept across the phone app's restarts, until the Mac has answered it; a move the Mac did not take (it closed, or did not answer) waits again, and only the Mac's refusal drops it. A task's moves are sent one after another, so the tracker ends where the user chose last. (`taskActions.test.ts` keeps a move while the app is closed and sends it when the app opens)

### Fixing what is out of sync

- [x] A fix that moves the task is a move. **Clean up** asks on the phone first ("Clean up WEB-244?" with what goes), then asks the Mac to run the fix (`fix`, naming the chip the phone showed: if the Mac's chip differs now it answers "<key> changed on the Mac: look again." and does nothing), which archives the task's sessions and removes their worktrees as its own Clean up does, without asking again on the Mac. A worktree with uncommitted changes, or one whose changes cannot be checked, is never removed this way: the phone cannot know of them, so the Mac refuses ("<key> has uncommitted changes in <path>. Clean it up in moonlet on the Mac.") and its own Clean up warns. Retry on the Mac asks as the Mac does. (`tasksStore.test.ts` runs a clean-up the phone confirmed, without asking again on the Mac; `tasksRelay.test.ts` runs a card's fix)

### New issue

- [x] **New issue** opens the X52 form on a sheet: Title, Description, Assignee, Labels, and the issue type or place where X52 asks for one. Its people and labels come from the Mac (`create_options`). **Create** asks the Mac to create the issue (`create`); the new card shows in the column and its detail opens. The Mac checks the request as its own form does. When the Mac does not answer in time, the sheet says it may still create the issue. (`taskView.test.ts` asks a Jira board where the issue goes, its projects most used first, and its type; waits for the Mac's lists before Create, so a field Jira requires is not missed; keeps Create off for a Jira label with a space, and says why; `tasksRelay.test.ts` checks a create as the form does)
- [x] Every request but a move needs moonlet open on a Mac: with no app connected, the phone says "Open moonlet on the Mac to change tasks." at once; a request no app answers in 30 s fails with "moonlet on the Mac did not answer." One app connection gets each request, the longest connected, so two apps never both create an issue; only that connection may answer it, and its leaving ends the phone's wait at once ("moonlet on the Mac closed before it answered."). The app may be on this Mac or on a Mac paired with it over the tailnet (X57). A request names its board, and the Mac acts only on that board's tasks; a sync, start or create that fails, or a create whose later step failed, says so. Only a paired phone may ask: a local client, whatever name its hello gives, is refused, so an agent on the Mac cannot make the app act on the tracker. (`mobile.rs` a_phones_task_request_is_answered_by_the_app, one_app_takes_a_task_request_and_agents_cannot_answer_one)

### Starting a session from a task

- [x] **Start**, **Start session** and **New session** open the New tab with the task attached, as the desktop's composer does (X54): the task's tile, key and title with ×; "<key> description sent with your message" folded; the box "Anything to add? Leave empty to start from the issue."; the branch the tracker's template makes with "from <base>"; and **Move to In Progress** — "Move <key> to In Progress and assign it to me", the Mac's wording — checked as the tracker's Keep in step "session starts" rule says (shown only when the rule is not off). Project, Agent, Model and Mode are rows; Mode opens the four modes. Project reads "Linked to <key>" when the task's project was found from it. (`taskView.test.ts` starts a session from a task as the Mac's composer does: its projects, Keep in step's checkbox and the tracker's branch template; `newSession.test.ts` starts from a task: its description sent first, named after it, on its tracker's branch, linked to it (X76))
- [x] **Start session** creates the session linked to the task (`session.create` with `task`), then tells the Mac it started (`started`, with the checkbox's choice), so the Mac runs Keep in step's "session starts" rule (X46) and adds the activity line. Start on a worktree without a session starts in that worktree (`worktree`). (`newSession.test.ts` starts from a task: its description sent first, named after it, on its tracker's branch, linked to it (X76), which also starts on a worktree without a session; `tasksStore.test.ts` tells of a session started from a task as the Mac's composer does, and answers; says when a session's start could not move or assign its task; `taskActions.test.ts` says on the task when its start could not be told to the Mac)
- [x] The phone's core names the branch with the desktop's code (`task_branch_name`, from `moonlet-trackers`). (`moonlet-trackers` a_tasks_branch_takes_its_trackers_template_or_the_default)

### Sessions and the session screen

- [x] A Sessions row with a task shows its key in orange before the branch; a session without one whose title or branch suggests a task shows that key with "?" in grey, and tapping it opens the Link sheet. (`sessionList.test.ts` finds the task a session's branch names, with its state on the board and the project; suggests a task whose title is the session's name, for a session with no task (shown as MOON-142?); finds a session's task on a board another member of its account shares (X68))
- [x] The session screen shows the task's key in orange before its project and branch, opening the task on its board (else in the tracker). While its chat runs subagents, a strip under the header shows a bar per agent. Its tabs are the design's segmented control, Chat with a yellow dot while the session needs the user. (`sessionList.test.ts` finds the task a session's branch names, with its state on the board and the project; `chatView.test.ts` shows a bar per subagent in its state, how many are done, and whether one needs the user; the tabs' look seen in a browser against fixture replies, as styling)
- [x] **Link "<session>" to a task** (from a suggested key, or Link a task in the session's ⋯): a search field ("Search tasks, or paste a key or URL"), **Suggested** (the title matches the session name, or the branch carries the key) and **Recent** (by last update), each row with its state glyph, key, title and "<column> · <n> sessions · updated <when>", and **Link**, which sets the session's task (`session.update`). The footnote: "Links live in moonlet; the tracker hears of a PR only through Keep in step." (`taskView.test.ts` suggests the task the session's name matches, then the rest by last update, each with its column, sessions and age; finds a task by key, title, or a pasted URL)

## UI

The design export "Moonlet Mobile.html", 390 × 844, dark only: pages Tasks · board, Task detail (scrolled in full), Move task sheet, Start a session from a task, Link a session to a task, Sessions and Session · Chat for the task lines.

## Protocol and RPCs

- `tasks.snapshot {workspace?}` → `{ workspace, snapshot }[]`: the saved snapshots, all or one workspace's.
- `tasks.set_snapshot {workspace, snapshot}` → `true`. Refused for phones and the CLI ("only the moonlet app shares boards"), for an unknown workspace, and over 4 MB.
- Event `tasks.changed {workspace, snapshot}` (`snapshot` null once its workspace is deleted).
- `tasks.app {}` → `{open}`; event `tasks.app {open}` when it changes.
- `tasks.request {workspace, action}` → the app's answer. `action` is one of:
  - `{kind: "move", board, task, column, status?}`
  - `{kind: "fix", board, task}`: the card's out-of-sync fix, confirmed on the phone
  - `{kind: "sync", board}`
  - `{kind: "comments", board, task}` → `{comments, more}`
  - `{kind: "comment", board, task, body}`
  - `{kind: "create_options", board, column, place?, issue_type?}`
  - `{kind: "create", board, column, issue: NewIssue}`
  - `{kind: "started", task, session, assign}`
  The daemon gives it an id, sends event `tasks.request {request_id, workspace, action}` to one app connection (the longest connected), and answers the caller with its `tasks.answer`; it fails at once with no app connected, or after 30 s. The app syncs a workspace it has not read for at most 10 s before it acts.
- `tasks.answer {request_id, ok, result?, error?}` → `true`; from the app only; a second answer gets "already answered". The app is the connection whose hello says `moonlet-app`: the same self-declared name X31's reads trust.
- The phone's core gains a `task_branch_name` command, the desktop's (`moonlet-trackers::branch`).

The snapshot is JSON the daemon stores and forwards without reading it beyond its size; its shape is the desktop's TypeScript (`TaskSnapshot` in `apps/desktop/src/lib/taskSnapshot.ts`, `version: 1`), so both apps build it and read it with the same code.

## Data and config

- Daemon: `~/.moonlet/tasks/<workspace id>.json` per workspace, 0600.
- Phone: the board shown, the column shown and the assignee filter per board, the chips put off with Not now, and the moves waiting for the Mac, in the webview's storage.
- Nothing new in `trackers.toml`.

## Security considerations

- ADR 0010 kept tracker data in the app. With this spec, issue titles, descriptions, assignees' names and labels of the boards a user shows are saved on each daemon host that owns a workspace with boards, including remote hosts. Tokens stay in the Mac's Keychain. The amendment to ADR 0010 records this.
- A phone already has full access to its daemon (X39). It can now also ask an open desktop app to move, create, fix and comment as the user; the app does only the actions above, for boards it has, and never with input it did not validate the same way its own UI does. Comments are read through the Mac on request and are not kept in the snapshot.
- Descriptions and comments are rendered through the desktop's sanitising Markdown renderer.

## Out of scope

- Tracker tokens or connections on the phone; Add a board, Board settings and Settings › Task trackers (on the Mac).
- Across boards (My tasks, Out of sync), as on the desktop.
- Ticking acceptance criteria from the phone (they show as the description has them); drag and drop between columns; the List layout; the tablet layout.
- Keep in step running without a Mac: rules still run in the desktop app (ADR 0010).

## Test plan

- Rust, daemon: snapshots (saved, reloaded after a restart, refused for a phone, over 4 MB, removed with its workspace); `tasks.request` / `tasks.answer` (first answer wins, no app → error at once, timeout, phone and CLI cannot answer); `tasks.app` and its event.
- Vitest, desktop: the snapshot is built from a workspace's data and boards, pushed only when changed; the Mac answers each request kind as its own UI would (`tasksRelay.test.ts`, `tasksStore.test.ts`).
- Vitest, phone: the board from snapshots and live sessions; tabs, counts, clean-ups, filters and badge; the switcher; the detail's sections; the Move sheet; the Link sheet; waiting moves; comments; the composer preset; the session's task line.
- Rust, phone core: `task_branch_name` with the desktop's cases.
- e2e, desktop: a sync saves a snapshot the daemon returns (`tasks-mode.e2e.ts`).
- The phone screens are checked in a browser against fixture replies, and once against a real Mac.

## Open questions

- None.
