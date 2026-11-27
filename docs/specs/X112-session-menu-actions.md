# X112 — Session menu actions

- **Status:** implemented
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

- [ ] The menu of a session lists, in groups: **Open**, **Open PR** (only with a PR), **Open in ›**; **Pin to top** or **Unpin from top**, **Mark as read** or **Mark as unread**, **Rename**, **Fork**; **Move to workspace ›**, **Move under ›**; **Link to task…** (as before), **Keep in sync** (as before); the Run only on… items (X73, as before); **Archive**. (`lib/sidebar.test.ts` lists a session's actions in groups; offers Open PR only with a PR; offers Pin to top, or Unpin from top on a pinned session, and Move under; `e2e/specs/session-menu.e2e.ts` lists the session's actions)
- [ ] A copy of another member's session (X88) keeps its short menu: **Open**, and **Archive** while its member is reachable. (`lib/sidebar.test.ts` offers only Open for a session another member runs, and Archive while that member is reachable (X88))
- [ ] An item with a keyboard shortcut that does the same to that row shows it on the right: **Open** shows ⌘1 to ⌘9 for the first nine sessions in sidebar order, the keys that open them. (`lib/sidebar.test.ts` Open shows the ⌘ key that opens the row, for the first nine)
- [ ] **Open PR** opens the session's pull request in the browser, as the header's PR button does. (`lib/sidebar.test.ts` offers Open PR only with a PR; the click is the header's `openUrl` call)
- [ ] **Open in ›** lists the same apps as the header's ⋯ menu and opens the session's worktree, or its copy on this Mac when kept in sync (X60), in the picked one. (`lib/openIn.test.ts` opens a session kept in sync from its copy, with every app on this Mac; opens any other session where it is, with its host's apps)
- [ ] **Mark as unread** marks the session's first agent tab unread ("done"), so the row turns bold and the attention dot shows, without opening anything. **Mark as read** is offered instead while a tab of the session is unread, and does what it does for a selection (X106). A read session with no agent tab offers neither. (`lib/workspaceStore.test.ts` marks a session's first agent tab unread without opening it; `lib/sidebar.test.ts` offers Mark as unread on a read session with an agent and Mark as read on an unread one)
- [ ] **Rename** starts the row's inline rename, as a double-click does. (`e2e/specs/session-menu.e2e.ts` renames a session from its menu)
- [ ] **Move to workspace ›** lists the workspaces as it does for a selection of that one session (X106). (`lib/sessionPick.test.ts` move targets are the workspaces holding every picked project; a picked session another Mac runs disables Move to)
- [ ] The menu opens at the pointer, moved up to fit the window. Taller than the window, it scrolls, and a submenu opens beside it, unclipped, on the right or, without room there, on the left. (`lib/menuPlace.test.ts` opens a right-click menu at the pointer, moved up to fit the window, and never above its top margin; opens a submenu right of its item, or left of it when the window has no room on the right)

### Pin to top and Move under (part 2)

- [ ] **Pin to top** sets `pinned_top` on the session; pinned top-level sessions come first in their group, in the group's own order (nesting wins: a pinned nested session stays right after its parent). **Unpin from top** clears it. (`session.rs` a_session_is_pinned_to_the_top_and_nested_under_another; `lib/sidebar.test.ts` puts sessions pinned to the top first in their group, each part in the group's order (X112))
- [ ] **Move under ›** lists the other top-level, unarchived sessions of the same project and workspace on the session's own host (not another member's session listed through its copy, X88), and **Move to top level** for a session that has a parent. A session that has sessions under it is not offered there and cannot be moved under another: nesting is one level deep. (`lib/sidebar.test.ts` moveUnderTargets: lists the other top-level sessions of its project and workspace, newest first; ticks the parent of a nested session and offers Move to top level; is disabled for a session with sessions under it; is disabled when no other session of its project is there to go under; leaves out another member's session, listed here through its copy (X88))
- [ ] A session with a parent shows right after its parent, indented, when both are in the same group. When its parent is archived, in another group, or gone, it shows as a top-level row. (`lib/sidebar.test.ts` shows a nested session right after its parent, and as a top row when its parent is not in the group (X112); keeps a pinned nested session right after its unpinned parent (X112))
- [ ] `session.update` takes `pinned_top` and `parent` (`null` to clear). A parent is refused when it is the session itself, not in the same project or workspace, archived, has a parent of its own, or the session has sessions under it. (`session.rs` a_session_is_not_nested_under_itself_another_project_or_a_nested_one)
- [ ] Both fields reach every member of the account with the session's record (X72), so the phone and other Macs show the same order. (`session/account.rs` a_pin_to_the_top_and_a_parent_reach_every_member; `tests/central_copies.rs` a_members_pin_to_the_top_and_parent_show_on_the_central_host)

### Fork (part 3)

- [ ] `session.fork {id}` makes a new session in the same project and workspace, named "<name> 2" (the next free number; a fork of a fork counts on, "<name> 3", while a number that is part of the name stays, "Bump to Node 18 2"), on a new branch made from the source session's branch HEAD, with the source's base branch as its base. (`session.rs` a_fork_takes_the_next_free_number; a_fork_starts_from_its_sessions_head_with_its_uncommitted_changes)
- [ ] The new worktree has the source worktree's uncommitted changes: edited, deleted and new (untracked, not ignored) files. Staged and unstaged edits all land as unstaged edits. The source worktree and its index are not touched. (`session.rs` a_fork_starts_from_its_sessions_head_with_its_uncommitted_changes; `e2e/specs/session-menu.e2e.ts` forks a session from its menu, with its uncommitted files, and opens the fork)
- [ ] Each Claude chat tab of the source is a chat tab of the fork with the same conversation shown. Its agent's first start passes `--resume <conversation> --fork-session`, so the two go on separately. The conversation's transcript is copied to where Claude looks for the new worktree's conversations, under the workspace's Claude profile (X33). (`session.rs` a_forks_chat_goes_on_from_its_sessions_conversation_as_a_new_one)
- [ ] A fork's chat that moves to another member (X73) before its first message still makes a new conversation there: the conversation it came from travels with its state (`fork_of`), so the two sessions never write to one. (`session.rs` a_forks_chat_moved_before_its_first_message_still_forks)
- [ ] A chat of another agent (Codex) opens as a new, empty chat of that agent: only a Claude conversation can go on as a new one. (`session.rs` a_forks_codex_chat_starts_afresh_as_a_codex_chat)
- [ ] A TUI agent tab of the source opens as a new, empty agent of the same kind in the fork. Other tabs are not copied; with no tab to open the fork gets one shell. A tab that cannot open once the fork is made is left out (and logged), rather than failing a session that exists. (`session.rs` a_forks_terminal_agent_starts_afresh_and_an_archived_session_is_not_forked)
- [ ] A failure while making the fork (copying its changes or transcripts) removes its worktree and branch, and says why. (`session.rs` a_fork_whose_changes_cannot_be_copied_leaves_no_worktree_or_branch)
- [ ] Fork is not offered on a copy of another member's session, and an archived session is not forked. (`lib/sidebar.test.ts` offers only Open for a session another member runs, and Archive while that member is reachable (X88); `session.rs` a_forks_terminal_agent_starts_afresh_and_an_archived_session_is_not_forked)

## UI

The menu keeps today's look (`RowContextMenu` in `Sidebar.tsx`): icons on the left, shortcuts in the hint column on the right, dividers between groups. **Archive** is red, as a menu's dangerous actions are, in a row's menu and in the menu of picked rows. A nested row uses the existing `nested` row style. Rename being an item, the menu's "Double-click a session to rename it" note goes. Fork says "Forked <name> as <fork>" in a toast as it opens the fork.

## Protocol and RPCs

- `session.update` takes optional `pinned_top: bool` and `parent: string | null` (part 2).
- `session.fork {id} -> Session` (part 3).

## Data and config

- `Session.pinned_top` and `Session.parent`, in the daemon's session state and in the account log's session records (part 2).
- Mark as unread lives in the app only, as unread marks do.
- A fork's gitignored files come from the project's checkout, as any new session's do (X74), not from the source worktree.

## Security considerations

`session.update` is among the phone's methods (X40); a phone may set the new fields as it may rename a session, and the daemon checks a parent the same way. `session.fork` copies files only between two worktrees of the same project on the same host, and a transcript only between two folders of the same Claude profile.

## Out of scope

- Delete (Archive stays the only way to remove a session).
- Forking a TUI agent's conversation: the daemon does not know which conversation a terminal's agent has.
- Nesting deeper than one level, and collapsing nested sessions.
- Nesting in the task-lines row style (X48), which already indents sessions under their task: there, sessions keep their task lines.
- Letter keys while the menu is open.

## Test plan

Vitest for the menu's items and Mark as unread; Rust unit tests for `session.update`'s new fields, their account-log sync and `session.fork`; a daemon test for a fork's files and chat; `e2e/specs/session-menu.e2e.ts` renames a session from its menu and forks one.

## Open questions

- None.
