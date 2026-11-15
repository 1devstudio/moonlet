# X104 — Move a session design to the workspace

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** Design mode
- **Related ADRs:** none
- **Depends on:** [X65](X65-design-mode.md) (session and workspace designs), [X101](X101-session-designs-outside-the-project.md) (session designs kept in moonlet, made workspace designs on archive), [X71](X71-designs-on-every-member.md) (workspace designs on every member)

## Summary

A session design ([X65](X65-design-mode.md)) belongs to its session: its pages live in the session's worktree, or in `~/.moonlet/design/.sessions/<session id>/` when the project keeps them in moonlet ([X101](X101-session-designs-outside-the-project.md)). Until now, the only ways to make one a workspace design were to merge the session and use **Use as a start** on the project design, or to archive a session whose designs are kept in moonlet. X104 adds **Move to workspace** to a right-click menu on a session design's row in the Design sidebar's **Designs** list. The design becomes a workspace design of the session's workspace, as archiving makes it in X101, and it leaves the session.

## User journey

1. In Design mode, the sidebar's **Designs** list shows the workspace designs, then the session designs, "Settings page" among them.
2. The user right-clicks "Settings page". A menu opens at the pointer with **Move to workspace**.
3. They pick it. moonlet asks "Move Settings page to the workspace?", saying "It leaves the session: its folder is deleted from the session's worktree, a change you commit with the branch." (or, for a design kept in moonlet, "It leaves the session.") They confirm with **Move**.
4. "Settings page" is now a workspace design: its row is listed with the workspace designs and opens on the design screen, with its own agent. The session's Changes show its folder as deleted.

## Behaviour and acceptance criteria

- [ ] `design.adopt {session, slug}` makes session `session`'s design `slug` a workspace design of the session's workspace: its pages, linking the workspace's live design system again, its labels, viewport, brief, assets and comments, as X101's archiving makes one; its snapshots are not kept. A name the workspace has gets a ` 2`. The answer is its slug in the workspace. (`design/session.rs` moving_a_session_design_to_the_workspace_makes_it_a_workspace_design_and_takes_it_out_of_the_session)
- [ ] The moved design's own agent starts, as **Use as a start**'s does: its first message says it was moved from a session as the design "<name>", that its pages are written already, to read them and wait for what the user asks, then the brief it had. An agent that does not start is logged; the design is moved either way. (`moonletd/tests/daemon.rs` a_session_design_moved_to_the_workspace_is_listed_there_and_no_longer_in_the_session)
- [ ] The design then leaves the session: its folder and its comments and history folder are removed, from the worktree or from the session's design folder in `~/.moonlet/design/.sessions/`, and it is no longer among the session's designs. One that cannot be made a workspace design (its design system is gone) is refused and stays as it was. (`design/session.rs` moving_a_session_design_to_the_workspace_makes_it_a_workspace_design_and_takes_it_out_of_the_session, a_session_design_whose_system_is_gone_is_not_moved_and_stays)
- [ ] A design whose comments are there but cannot be read is refused before anything is made, and stays with them; one whose comments cannot be written in the workspace is not made there. (`design/session.rs` a_session_design_whose_comments_cannot_be_read_is_not_moved_and_stays)
- [ ] It is refused while the session's agent is in a turn, at work or asking the user, as a restore is: "Claude is changing the design; move it once it stops" (`busy`). The agent writes the pages straight in the folder the move deletes. (`moonletd/tests/daemon.rs` a_session_design_is_not_moved_while_its_sessions_agent_is_in_a_turn)
- [ ] The design's edits by hand not kept yet as a snapshot go with it only once it moved: a refused move leaves them, and their wait, as they were. (`moonletd/tests/daemon.rs` edits_by_hand_wait_on_after_a_refused_move)
- [ ] `design.adopt` is the user's choice, refused to an agent (`moonlet` CLI) as `design.share` is. A session moonlet does not have is `invalid_params`; a slug the session has no design of is refused, as every `{session, slug}` call refuses one. (`moonletd/tests/daemon.rs` a_session_design_moved_to_the_workspace_is_listed_there_and_no_longer_in_the_session)
- [ ] Right-clicking a session design's row in the Design sidebar's **Designs** list opens a menu at the pointer with **Move to workspace**. A workspace design's or a shared design's row opens no menu. (`lib/designsIndex.test.ts` offers Move to workspace for a session design's row and no menu for a workspace design's)
- [ ] **Move to workspace** asks first, naming the design, and saying its folder is deleted from the worktree when it is kept there. Once confirmed, it calls `design.adopt` on the host the session runs on, lists that host's designs again, and shows the moved design when that host is the one the sidebar shows. (`lib/designStore.test.ts` Move to workspace makes a session design a workspace design and shows it; `lib/designsIndex.test.ts` says a design kept in the worktree is deleted from it when moved)

## UI

- The menu is the app's context menu (`ContextMenu` in `components/Menu.tsx`, which the Files tab's uses too), one item: **Move to workspace**, with an arrow-up-from-line icon.
- The confirmation is the app's confirm dialog, action **Move**.
- A refusal shows in a toast.
- The menu remembers the workspace it was opened in, and closes when another is shown.

## Protocol and RPCs

- `design.adopt {session, slug}` → `string`, the design's slug in the workspace. App only. Addressed by its design, so its workspace is the session's, never one the call names.

## Data and config

None. The new workspace design lives in `~/.moonlet/design/<workspace id>/designs/<slug>/` as any workspace design (X65), and is copied to every member as any (X71).

## Security considerations

- Only the app may move a design: an agent could otherwise move its session's designs out of the branch.
- The session design is found as `locate` finds every `{session, slug}` design, through handles and never a link (X65), and removed as `design.remove` removes one.

## Out of scope

- Moving a project design (merged on the base branch): **Use as a start** copies one.
- Moving a workspace design into a session.
- A right-click menu on the Designs index's cards, or on workspace and shared designs' rows.

## Test plan

- Rust (`moonlet-core` `design/session.rs`): a session design in a worktree and one kept in moonlet, each moved, with its pages, labels, viewport, assets and comments; the session's listing after; a slug the workspace has; a design system gone.
- Daemon (`moonletd/tests/daemon.rs`): `design.adopt` from the app moves a worktree session design, `design.list` shows it as a workspace design with its agent and not as a session's; the CLI is refused.
- Manual: a throwaway snap spec right-clicks the row in the e2e app, shoots the menu and the question, moves it, and shoots the design screen after.
- Vitest (`lib/designsIndex.test.ts`, `lib/designStore.test.ts`): the row's menu items; the confirmation's text; the store call and what it shows.

## Open questions

- None.
