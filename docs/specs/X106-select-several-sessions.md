# X106 — Select several sessions

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** Sidebar
- **Related ADRs:** none
- **Depends on:** [X32](X32-workspaces-and-sections.md) (sessions belong to a workspace), [X33](X33-workspace-claude-profiles.md) (a workspace's Claude profile), [X55](X55-git-settings.md) (unpushed work on archive), [X83](X83-session-processes-listed-and-stopped.md) (what still runs on archive)
- **Design:** `~/.moonlet/design/.sessions/54df64042aed/designs/select-several-sessions-in-the/` (session design, not committed)

## Summary

The sidebar acts on one session at a time: archiving five finished sessions takes five right-clicks and five confirms. X106 lets the user pick several sessions with ⌘-click and ⇧-click, as in Finder, and run one action on all of them from a bar at the bottom of the sidebar or from the right-click menu: **Archive**, **Move to workspace** and **Mark as read**. X32 removed moving a session to a section on purpose (a session shows under its project in every section of its workspace), so the move is to another workspace.

## User journey

1. The user ⌘-clicks "Dark mode for account pages", then "Idempotent refund endpoint", then ⇧-clicks "Rate-limit webhook retries" two rows down. Every row now shows a checkbox where its state glyph was; the three picked rows are ticked and tinted. The session that was open stays open.
2. The sidebar's footer becomes a bar: "3 selected · in 2 projects", ✕, **Archive**, **Move to ▾** and `⋯` (Mark as read).
3. They click **Archive**. One confirm lists the three sessions, each with a note ("done", "agent working, stops", "2 commits not pushed"), and offers **Push 1, then archive all** and **Archive anyway**. They pick the first; the one session is pushed, then all three archive, each row playing its archive scene.
4. Later they pick two sessions, right-click one of them, and choose **Move to workspace › Acme client**. That workspace uses another Claude profile, so moonlet asks first; once confirmed both sessions leave the sidebar and show in Acme client.
5. Esc, ✕, or a plain click on any row clears the selection.

## Behaviour and acceptance criteria

### Picking

- [ ] A plain click on a row opens its session and clears the selection. (`lib/sessionPick.test.ts` a plain click opens the session and clears the picks)
- [ ] ⌘-click picks a row, or unpicks it when it is picked; it does not open the session. The open session is picked only when it is ⌘-clicked. (`lib/sessionPick.test.ts` ⌘-click adds a session and a second ⌘-click takes it out)
- [ ] ⇧-click picks every row from the last row clicked to this one, in the order the sidebar shows them, adding to what is picked. With nothing clicked yet it picks just that row. A session listed under two sections counts once; rows of a folded section or project are not in the range, and folding a section or project takes its sessions out of the selection, so an action never takes a session the user can't see. (`lib/sessionPick.test.ts` ⇧-click picks the range from the last click, adding to the picks; ⇧-click with nothing clicked yet picks just that row; ⇧-click range counts a session shown under two sections once)
- [ ] Esc clears the selection unless the focus is in a text field or a terminal. The selection also clears when the shown workspace changes, and a session that is archived or leaves the workspace leaves the selection. (`lib/sessionPick.test.ts` picks drop sessions no longer in the sidebar; `e2e/specs/select-sessions.e2e.ts` ⌘-click picks rows without opening them, and Esc clears them)
- [ ] While anything is picked, each row shows a checkbox in its glyph's place: ticked on a picked row, which is tinted. A click on a row's box picks or unpicks that row as ⌘-click does (⇧ picks a range) and never opens the session; unpicking the last one ends picking, as ✕ (Clear selection) and Esc do. (`lib/sessionPick.test.ts` a click on a row's box picks or unpicks it as ⌘-click does, and the last one out ends picking; ⇧ on a box picks the range, as ⇧-click on the row does; `e2e/specs/select-sessions.e2e.ts` a click on a row's box picks or unpicks it, and the last one out ends picking) (`e2e/specs/select-sessions.e2e.ts` ⌘-click picks rows without opening them, and Esc clears them; design `index.html` m53)

### The selection bar

- [ ] While anything is picked the sidebar footer is the selection bar: "N selected", "in M projects" when they are in more than one, ✕ (Clear selection), **Archive**, **Move to** and `⋯` with **Mark as read**. (`lib/sessionPick.test.ts` the bar says how many and in how many projects; design `index.html` m141)
- [ ] Right-clicking a picked row opens the menu for the whole selection: "N sessions", **Mark as read**, **Move to workspace ›**, **Archive N sessions** ("1 session" and **Archive session** for one). Right-clicking a row that is not picked opens its own menu, as before. (`e2e/specs/select-sessions.e2e.ts` the right-click menu of a picked row acts on all of them; design `context-menu.html`)

### Archive

- [ ] **Archive** asks once for every picked session: "Archive N sessions", what happens to their folders and branches by each host's Git settings, then a list of the sessions, each with a note: uncommitted files or commits not pushed (amber), "agent working, stops" for an agent at work, "needs input, stops" for one asking (amber), what processes still run, "done" or "failed". One picked session is asked as Archive asks for one. (`lib/actions.test.ts` asks one picked session as Archive does for one) (`lib/bulkArchive.test.ts` lists each session with a note, and pushes the one with commits only here first)
- [ ] With work only on this machine in any of them the action is **Archive anyway** (danger), and **Push N, then archive all** pushes those sessions first; it is disabled, saying to commit first, when one has uncommitted files. The message ends with what the push saves: "Rate-limit webhook retries has 2 commits only on this Mac: Push 1, then archive all saves them to origin first.", or how many sessions have work only on their host. Otherwise the action is **Archive N**. "Also delete the branches" shows when any host's Git settings ask. (`lib/bulkArchive.test.ts` archives plainly when nothing would be lost, and asks about the branches when the settings ask; can't push first while a session has uncommitted files)
- [ ] Once confirmed, every picked row plays the archive scene at once, and the sessions archive at most 5 at a time, the next starting as one ends, in sidebar order. Each archives as Archive does for one: what runs stops, and a failure is a toast for that session while the others go on. (`lib/pool.test.ts` runs at most 5 at once, the next as one ends, in order; goes on past one that fails; `lib/actions.test.ts` archives at most 5 at once, every row showing the archive scene from the start)
- [ ] Each session archives as Archive does for one: what runs stops, its row plays the archive scene, and a failure is a toast for that session while the others go on. A session whose push failed is not archived. The selection clears once the archive is confirmed. (`lib/actions.test.ts` pushes those with work only here first, and leaves one whose push failed; `e2e/specs/select-sessions.e2e.ts` archives the picked sessions after one confirm)

### Move to workspace

- [ ] **Move to** lists the workspaces of the account. The workspace they are in is ticked and disabled; a workspace that has no section with the project of every picked session is disabled, as is the whole menu while a picked session runs on another member (X72), which cannot be moved from here. A workspace with another Claude profile than the picks' names it beside its name ("Work profile", or "Default"). Workspaces keep their ids on every member of the account (X68), so a workspace is checked on each picked session's own host by its id. (`lib/sessionPick.test.ts` move targets are the workspaces holding every picked project; a workspace one member lacks the project in is disabled, by the same workspace id on every member (X68); a picked session another Mac runs disables Move to)
- [ ] The moves go at most 5 at a time, as archives do.
- [ ] Moving to a workspace with another Claude profile while picked sessions run Claude agents asks first, as moving a section does (X33), with `switchConfirm`'s message and the action **Move to <workspace>**. (`lib/sessionPick.test.ts` asks before Claude agents in the picked sessions switch profiles, as moving a section does (X33))
- [ ] `session.update {id, workspace_id}` moves a session to that workspace, and its account record follows, so every member lists it there (X72). It is refused when that workspace has no section with the session's project, and when the workspace does not exist. Another member's session is not in the host's own list, so `session.update` already refuses it as "no such session". (`session.rs` a_session_moves_to_a_workspace_that_holds_its_project, a_session_is_not_moved_to_a_workspace_without_its_project; `session/account.rs` a_session_moved_to_another_workspace_moves_on_every_member; `e2e/specs/select-sessions.e2e.ts` moves picked sessions to another workspace from the bar)

### Mark as read

- [ ] **Mark as read** clears the unread mark of every picked session's terminals, as opening each would, without opening them. (`lib/workspaceStore.test.ts` clears the unread marks of every picked session's terminals without opening them)

## UI

Design pages: `index.html` (the bar), `move.html` (Move to open), `context-menu.html` (right-click a selection), `archive.html` (the confirm). The top-bar variant (`top-bar.html`) was not chosen: the bar at the bottom leaves New session, Run action and History where they are, and sits where the pointer is after picking.

## Protocol and RPCs

- `session.update` takes an optional `workspace_id`.

## Data and config

None. The selection lives in the app only, and is not kept across restarts.

## Security considerations

The new field changes only which workspace lists a session. `session.update` is among the phone's methods (X40); a phone may send the field too, as it may rename a session, and the daemon refuses it the same way (a workspace that doesn't exist or doesn't hold the project). The phone app does not send it.

## Out of scope

- Picking sessions with the keyboard alone (⇧↑/↓).
- Dragging a selection onto a workspace.
- Selecting sessions in Tasks mode or on the phone.

## Test plan

Vitest for picking, the bar's text, move targets and the archive prompt; Rust unit tests for `session.update`'s move; `e2e/specs/select-sessions.e2e.ts` picks two sessions with ⌘-click, archives them from the bar and checks both rows go.

## Open questions

- None.
