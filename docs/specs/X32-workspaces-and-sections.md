# X32: Workspaces above sections (today's workspaces become sections)

- **Status:** implemented (switcher look unchecked in app)
- **Priority / phase:** P1 · phase 3
- **Related:** [ADR 0007](../adr/0007-workspaces-above-sections.md), [X5](X5-workspaces-projects-sessions.md) (the model this changes), [X33](X33-workspace-claude-profiles.md) (a Claude profile per workspace), [R4](R4-unified-hosts-sidebar.md) (hosts), [glossary](../../CONTEXT.md).
- **References:** the user's design "Workspaces & Sections" (2026-10-11): sidebar with the workspace switcher, the switcher open, and the New workspace dialog.

## Summary

Today the sidebar stacks several **workspaces**, each a named set of projects. They are renamed **sections**. A new, larger **workspace** sits above them: a named, coloured scope such as "Personal" or "Acme". It has its own sections, sessions and (X33) Claude account. The sidebar shows one workspace at a time, and a switcher in the title bar moves between them. The old "section" (a user-named group of sessions inside a workspace) is removed.

The hierarchy becomes **Workspace › Section › Project › Session › Terminal**.

## User journey

1. After the upgrade, the user sees the same sidebar as before, now under a workspace called "Personal". The old "1devstudio" and "Acme" blocks are sections.
2. The user clicks the switcher (`P Personal ⇅`) next to the traffic lights and picks **New workspace…**. The dialog asks for a name ("Acme"), a colour, a Claude profile (X33), and what to start with: an empty workspace, or sections moved from the current one. The user ticks the "Acme" section and clicks **Create workspace**.
3. The sidebar now shows Acme: its section, projects and sessions. The "Personal" workspace no longer shows them.
4. The user moves between workspaces with the switcher or ⌃⌘1 to ⌃⌘9. Each workspace remembers the session that was open in it.

## Behaviour and acceptance criteria

### Model

- [x] A **workspace** has a name, a colour and an ordered list of sections. Every section belongs to exactly one workspace. Tests: `migrates_x5_workspaces_into_sections`, `workspaceSections` in `sidebar.test.ts`.
- [x] A **section** is what X5 called a workspace: a name, its projects, and its view (group by, filter, sort). Its sessions are listed under its projects, as today. Tests: the X5 tests carried over to `section.*` (`new_project_added_to_a_section_lands_only_there`, `removing_a_shared_project_detaches_it_from_one_section`, `removing_a_project_from_its_last_section_drops_it`, `a_project_with_live_sessions_stays_in_its_last_section`, `a_project_can_be_removed_from_a_section_over_rpc`, `section-projects.e2e.ts`).
- [x] A project can be in several sections, in the same workspace or in different ones. Tests: `removing_a_shared_project_detaches_it_from_one_section`, `sessions_belong_to_the_workspace_they_are_created_in`.
- [x] A **session belongs to one workspace**, recorded as `workspace_id` when it is created. A session shows only in its own workspace: under each section of that workspace that holds its project. Tests: `sessions_belong_to_the_workspace_they_are_created_in`, and "shows only the sessions of its own workspace" in `sidebar.test.ts`.
- [x] `session.create` takes `workspace_id`. The app sends the current workspace. A session started by an agent (`moonlet session new`, X22) goes into the spawning session's workspace when the project is there, else into the first workspace that holds the project. A CLI call without either uses the first workspace that holds the project. Test: `a_spawned_session_joins_its_parents_workspace`.
- [x] The old session sections are removed: no "Move to section", no dragging rows onto sections, no `section` field on sessions. Test: `migrates_x5_workspaces_into_sections` (a session in an X5 section shows under its project).

### Migration

- [x] An X5 `state.json` loads with one workspace, "Personal" (colour Clay). Each old workspace becomes one of its sections, in the same order, with its projects and view. Every session gets that workspace. Old session sections are dropped, and their sessions show under their project again. Test: `migrates_x5_workspaces_into_sections`, using an X5 `state.json` with two workspaces, a shared project and a session in a section.
- [x] `PROTOCOL_VERSION` goes to 3, so an app and a daemon on different versions upgrade the daemon (S3), the same way as ADR 0005. Test: `rejects_protocol_mismatch`.

### Switching

- [x] The sidebar shows the current workspace only. The current workspace is remembered across restarts, and falls back to the first one when it is gone. Tests: `currentWorkspace` in `workspaces.test.ts`, the fallback in `keys.test.ts`, and `workspaces.e2e.ts`.
- [x] ⌃⌘1 to ⌃⌘9 switch to the first nine workspaces, in list order; ⌘1 to ⌘9 still pick sessions, now of the shown workspace only. Tests: "⌘1–9 order" in `workspaceStore.test.ts`, "workspace shortcuts" in `keys.test.ts`, and `workspaces.e2e.ts`.
- [x] Switching restores the session last selected in that workspace, or shows none. Switching closes History. Opening a session from elsewhere (the sidebar, a notification, the inbox, the palette, the in-app card) shows its workspace and makes it that workspace's last session. Terminals and agents of other workspaces keep running. Tests: `sessionToRestore` in `workspaces.test.ts`, "⌃⌘2 switches to the second workspace and reopens its last session" in `keys.test.ts`, "opening a session elsewhere" in `workspaceStore.test.ts`, and `workspaces.e2e.ts` (a hidden workspace's terminal still runs).
- [x] When a session in another workspace needs input or has finished unread, the switcher button and that workspace's row show the attention dot. Notifications and the approval inbox (A5) still cover every workspace; opening one switches to its workspace. Tests: `workspacesNeedingYou` in `workspaces.test.ts`, `sessionNeedsYou` in `workspaceStore.test.ts`.
- [x] With several hosts (R4), each host has its own workspaces. The switcher lists them grouped under host names, local first. Test: `switcherRows` in `workspaces.test.ts`.

### Creating, editing and deleting workspaces

- [x] `workspace.create {name, color, move_sections?}` creates a workspace, optionally moving the listed sections from another workspace into it. Test: `a_workspace_takes_sections_over_rpc`.
- [x] Moving a section to another workspace (from the New workspace dialog, or **Move to workspace ›** in the section's `⋯` menu) also moves the sessions of its projects, unless the old workspace still holds that project in another section. Test: `moving_a_section_takes_sessions_it_alone_holds`.
- [x] **New workspace…** (switcher menu, and the Run action list) sends the trimmed name, the colour (Blue unless picked), and the ticked sections only when "Move sections from …" is chosen; that choice is disabled when the current workspace has no sections. Create is disabled while the name is empty. Tests: `createRequest` in `workspaces.test.ts`, `workspaces.e2e.ts`.
- [x] **Workspace settings…** edits the name, colour and Claude profile (X33), and holds **Delete workspace**. Test: `workspaces.e2e.ts` (rename and recolour).
- [x] A workspace can be deleted only when it has no sections and it is not the last one. The confirm says so, and otherwise the button explains why it is disabled (`deleteBlocked` in `workspaces.test.ts`). Archived sessions move to the first workspace that holds their project whenever theirs no longer does (it was deleted, or lost its last section). Tests: `a_workspace_is_deleted_only_when_empty_and_not_last`, `a_workspace_takes_sections_over_rpc`, `archived_sessions_move_to_a_workspace_holding_their_project`.
- [x] Deleting a section keeps its projects: those no other section of the workspace holds move to the workspace's first other section. A workspace's last section can be deleted only while its projects have no live sessions there. Test: `deleting_a_section_keeps_projects_and_sessions`.
- [x] Removing a project from a section is refused while the project has unarchived sessions in this workspace and no other section here holds it (X5's rule, now per workspace). Test: `a_project_with_live_sessions_stays_in_its_workspace`.
- [x] Workspace names cannot be empty, in `workspace.create` or `workspace.update`, and the colour must be one of the five. Tests: `workspace_names_are_checked_and_colours_change`, `workspace_names_cannot_be_emptied`, `a_workspace_takes_sections_over_rpc` (an unknown colour is refused).
- [x] A request that fails half-way changes nothing, in memory or on disk (for example `workspace.create` with an unknown section to move). Test: `a_failed_workspace_create_leaves_nothing_behind`.
- [x] `workspace.update {section_ids}` reorders the workspace's sections and moves in sections listed from other workspaces, with their sessions; it cannot drop one of its own. Test: `updating_a_workspaces_sections_reorders_and_moves_them_in`.

### Sidebar

- [x] The sidebar is, from top to bottom (`workspaces.e2e.ts` and `workspace-profile.e2e.ts` drive the switcher, New session and the footer):
  - the title bar with the traffic lights and the workspace switcher;
  - New session (⇧⌘N), Run action (⌘K), History;
  - the current workspace's sections, each with its projects and their sessions;
  - **New section…** at the end of the list;
  - a footer with Settings and the workspace's Claude account ("Claude · Work profile", X33).
- [x] Each section has a header with its name and a `⋯` menu: Group by, Filter by project, Sort by, Add project…, Rename section…, Move to workspace ›, Delete section. Collapsing a section is remembered per section. Test: `section-projects.e2e.ts` (the project row's menu); the section menu is checked by hand only.
- [x] New session (button, ⇧⌘N, palette) opens the composer on the workspace it was opened for, else the current one, and the session is created there. Its project picker lists that workspace's projects, each labelled with its section; a workspace without projects offers to add one. Tests: `composerTarget`, `composerOptions` in `workspaces.test.ts`, and the session created in `workspaces.e2e.ts`.

## UI

Taken from the design:

- **Switcher button:** an 18 px rounded square in the workspace colour with the initial (the name's first letter, upper case), the name in 13 px semibold, and an up-down chevron. It shows the hover background while the menu is open.
- **Switcher menu:** 256 px wide, under the button. A "Workspaces" label, then one row per workspace: a 26 px colour square with the initial, the name, a summary line ("2 sections · 7 sessions · work profile"), a check on the current one, and its shortcut (⌃⌘1). Then a divider, **New workspace…**, **Workspace settings…**, and a footer line "Switch ⌃⌘1–9". Clicking outside or Escape closes it.
- **New workspace dialog:** 440 px.
  - Name, with a 36 px colour square showing the initial next to it.
  - Colour: Clay `#d97757`, Blue `#6f9fe8`, Violet `#a98be8`, Sand `#d9b779`, Grey `#8c8c8c`.
  - Claude profile (X33), with the hint "Every session in this workspace signs in with this account."
  - Start with: "An empty workspace", or "Move sections from <current>" with a checklist of its sections and their project counts.
  - Cancel and **Create workspace**. Create is disabled while the name is empty.
- **Section header:** 30 px, with the name in muted 13 px medium on a slightly raised background, and `⋯` on the right.
- Session rows keep their current look (X5): PR state, agent dot, diffstat, `merged`.

## Protocol and RPCs

- `workspace.*` now means the new scope: `workspace.list`, `workspace.create {name, color, move_sections?}`, `workspace.update {id, name?, color?, section_ids?}` (order, and moving sections in; it keeps the workspace's own), `workspace.delete {id}`. Event `workspaces.changed`.
- X5's `workspace.*` methods become `section.*`: `section.list`, `section.create {workspace_id, name}`, `section.update {id, name?, project_ids?, view?}`, `section.delete {id}`, `section.add_project {id, path}`, `section.remove_project {id, project_id}`, `section.move {id, workspace_id}`. Event `sections.changed`.
- `Session.section` is removed and `Session.workspace_id` is added. `session.update` no longer takes `section`.
- `PROTOCOL_VERSION` 3. `docs/protocol.md` is updated.

## Data and config

- `state.json` (version 3) gains `workspaces: [{id, name, color, section_ids, created_at}]`. A workspace's `section_ids` is the only record of which sections it holds. X5's `workspaces` are stored as `sections: [{id, name, project_ids, view, created_at}]`, keeping their ids, so the app's collapse state carries over.
- Colours are stored by name: `clay`, `blue`, `violet`, `sand`, `grey`. The app maps them to the design's values.
- A fresh install starts with "Personal" and one section, "My projects". A project added without a section goes into the first section of the first workspace.
- The shown workspace (its host and id), and the last session selected in each workspace, live in the app's settings (localStorage), like collapse state.

## Security considerations

- Names and colours come from the user. The colour must be one of the five palette names; other values are refused.
- Nothing crosses a new trust boundary: workspaces and sections only group existing projects and sessions.

## Out of scope

- The Claude profile itself: [X33](X33-workspace-claude-profiles.md).
- Custom colours or icons beyond the five swatches.
- Dragging sections between workspaces, or reordering workspaces by drag. The order is the creation order, and changes through `workspace.update`.
- A separate window per workspace.

## Test plan

- **Rust unit (`moonlet-core`):** the X5 migration; sessions per workspace; moving a section with and without a project left behind; delete refusals; agent-spawned session placement.
- **Daemon e2e (`crates/moonletd/tests/`):** create a workspace moving a section; list; delete refusals; protocol 3 handshake.
- **Vitest (`apps/desktop/src/lib/`):** arranging a workspace (`sidebar.ts`), the switcher summary and grouping by host, ⌃⌘1–9 in `keys.ts`, the selection restored on switch, attention per workspace, the New workspace form rules.
- **E2e (`apps/desktop/e2e/specs/workspaces.e2e.ts`):** crucial, because the sidebar is how every session is reached. Create a workspace moving a section into it; check the section and its sessions show there and not in "Personal"; switch back with ⌃⌘1; create a session in the new workspace. Existing specs that use the X5 workspace header (`workspace-projects.e2e.ts`) move to section headers.
- **Manual:** upgrade a real install with the user's `state.json` and check that both old workspaces show as sections of "Personal" with every session in place.

## Open questions

- None so far. Decided with the user on 2026-10-11: old session sections are removed, and a project can be in several workspaces.
