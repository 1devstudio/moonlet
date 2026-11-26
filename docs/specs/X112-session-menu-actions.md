# X112 — Session menu actions

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** Sidebar
- **Related ADRs:** none
- **Depends on:** [X32](X32-workspaces-and-sections.md) (sessions belong to a workspace), [X33](X33-workspace-claude-profiles.md) (a workspace's Claude profile), [X60](X60-keep-in-sync.md) (worktree snapshots), [X72](X72-session-copies-on-the-central-host.md) (session records on every member), [X86](X86-archived-sessions-on-tasks.md) (chats kept with their conversation), [X106](X106-select-several-sessions.md) (Move to workspace, Mark as read)

## Summary

A session's right-click menu offers only Open, Link to task…, Keep in sync, Run only on… and Archive. Most things a user does to a session live elsewhere: its PR and Open in… in the session header, renaming by double-click, Mark as read and Move to workspace only for a selection. X112 gathers them in the row's own menu and adds four actions that did not exist: **Mark as unread**, **Pin to top**, **Move under** (nest one session under another of its project) and **Fork** (a new session that starts where this one is: its branch, its uncommitted changes and its chats' conversations).

The work ships in three parts: the menu items that reuse existing actions (part 1), Pin to top and Move under (part 2, two new session fields), and Fork (part 3, a new RPC).

## User journey

1. The user right-clicks "Rate-limit webhook retries" in the sidebar. The menu reads: Open ⌘2 · Open PR · Open in › / Pin to top · Mark as unread · Rename · Fork / Move to workspace › · Move under › / Link to task… · Keep in sync / Archive.
2. **Open PR** opens its pull request in the browser. **Open in › Cursor** opens its worktree in Cursor.
3. **Pin to top** keeps it first in its project, also on the phone and the user's other Macs. The menu then says **Unpin from top**.
4. **Move under › Webhook retries spike** nests it under that session, indented. Its menu then offers **Move under › Move to top level**.
5. **Fork** makes "Rate-limit webhook retries 2" in the same project and workspace, opened at once. Its worktree has the same commits and the same uncommitted edits; its chat tab shows the conversation so far, and the next message continues a copy of it while the first session goes on unchanged.

## Behaviour and acceptance criteria

### The menu (part 1)

- [ ] The menu of a session lists, in groups: **Open**, **Open PR** (only with a PR), **Open in ›**; **Pin to top** or **Unpin from top**, **Mark as read** or **Mark as unread**, **Rename**, **Fork**; **Move to workspace ›**, **Move under ›**; **Link to task…** (as before), **Keep in sync** (as before); the Run only on… items (X73, as before); **Archive**. (`lib/sidebar.test.ts` lists a session's actions in groups; offers Open PR only with a PR)
- [ ] A copy of another member's session (X88) keeps its short menu: **Open**, and **Archive** while its member is reachable. (`lib/sidebar.test.ts` a copy of another member's session keeps Open and Archive)
- [ ] An item with a keyboard shortcut that does the same to that row shows it on the right: **Open** shows ⌘1 to ⌘9 for the first nine sessions in sidebar order, the keys that open them. (`lib/sidebar.test.ts` Open shows the ⌘ key that opens the row, for the first nine)
- [ ] **Open PR** opens the session's pull request in the browser, as the header's PR button does.
- [ ] **Open in ›** lists the same apps as the header's ⋯ menu and opens the session's worktree, or its copy on this Mac when kept in sync (X60), in the picked one.
- [ ] **Mark as unread** marks the session's first agent tab unread ("done"), so the row turns bold and the attention dot shows, without opening anything. It is offered when no tab of the session is unread and the session has an agent tab; otherwise **Mark as read** is offered, and does what it does for a selection (X106). (`lib/workspaceStore.test.ts` marks a session's first agent tab unread without opening it; `lib/sidebar.test.ts` offers Mark as unread on a read session with an agent and Mark as read on an unread one)
- [ ] **Rename** starts the row's inline rename, as a double-click does. (`e2e/specs/session-menu.e2e.ts` renames a session from its menu)
- [ ] **Move to workspace ›** lists the workspaces as it does for a selection of that one session (X106).

### Pin to top and Move under (part 2)

- [ ] **Pin to top** sets `pinned_top` on the session; pinned sessions come first in their group, in the group's own order. **Unpin from top** clears it.
- [ ] **Move under ›** lists the other top-level, unarchived sessions of the same project and workspace, and **Move to top level** for a session that has a parent. A session that has sessions under it is not offered there and cannot be moved under another: nesting is one level deep.
- [ ] A session with a parent shows right after its parent, indented, when both are in the same group. When its parent is archived, in another group, or gone, it shows as a top-level row.
- [ ] `session.update` takes `pinned_top` and `parent` (`null` to clear). A parent is refused when it is the session itself, not in the same project, archived, has a parent of its own, or the session has sessions under it.
- [ ] Both fields reach every member of the account with the session's record (X72), so the phone and other Macs show the same order.

### Fork (part 3)

- [ ] `session.fork {id}` makes a new session in the same project and workspace, named "<name> 2" (the next free number), on a new branch made from the source session's branch HEAD, with the source's base branch as its base.
- [ ] The new worktree has the source worktree's uncommitted changes: edited, deleted and new (untracked, not ignored) files. Staged and unstaged edits all land as unstaged edits. The source worktree and its index are not touched. Gitignored files are copied as for any new session (the project's copied files).
- [ ] Each chat tab of the source is a chat tab of the fork with the same conversation shown. Its agent's first start passes `--resume <conversation> --fork-session`, so the two go on separately. The conversation's transcript is copied to where Claude looks for the new worktree's conversations, under the workspace's Claude profile (X33).
- [ ] A TUI agent tab of the source opens as a new, empty agent of the same kind in the fork. Other tabs are not copied; with no tab to open the fork gets one shell.
- [ ] A failure while making the fork removes its worktree and branch, and says why.
- [ ] Fork is not offered on a copy of another member's session.

## UI

The menu keeps today's look (`RowContextMenu` in `Sidebar.tsx`): icons on the left, shortcuts in the hint column on the right, dividers between groups. A nested row uses the existing `nested` row style.

## Protocol and RPCs

- `session.update` takes optional `pinned_top: bool` and `parent: string | null` (part 2).
- `session.fork {id} -> Session` (part 3).

## Data and config

- `Session.pinned_top` and `Session.parent`, in the daemon's session state and in the account log's session records (part 2).
- Mark as unread lives in the app only, as unread marks do.

## Security considerations

`session.update` is among the phone's methods (X40); a phone may set the new fields as it may rename a session, and the daemon checks a parent the same way. `session.fork` copies files only between two worktrees of the same project on the same host, and a transcript only between two folders of the same Claude profile.

## Out of scope

- Delete (Archive stays the only way to remove a session).
- Forking a TUI agent's conversation: the daemon does not know which conversation a terminal's agent has.
- Nesting deeper than one level, and collapsing nested sessions.
- Letter keys while the menu is open.

## Test plan

Vitest for the menu's items and Mark as unread; Rust unit tests for `session.update`'s new fields, their account-log sync and `session.fork`; a daemon test for a fork's files and chat; `e2e/specs/session-menu.e2e.ts` renames a session from its menu and forks one.

## Open questions

- None.
