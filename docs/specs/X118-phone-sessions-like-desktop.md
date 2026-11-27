# X118 — Phone Sessions look and act like the desktop sidebar

- **Status:** implemented
- **Priority / phase:** P2 · phase 4
- **PRD refs:** X40 (phone app), X32 (workspaces and sections), X48 (session row styles), X112 (session menu actions)
- **Related ADRs:** ADR 0008

## Summary

The phone's Sessions tab drew its own two-line rows, grouped every section by project whatever the desktop said, and had no actions besides opening a session. Moving between the Mac and the phone meant reading two different lists. The phone now draws the list as the desktop sidebar does, with the same row component, and has the sidebar's actions: a session menu on a long press, folding sections and projects, the section's view menu and New session from a project.

## User journey

1. The user opens Sessions on the phone. Each section is a filled bar with its name and ⋯, then its projects, each with the GitHub owner's avatar, and one-line session rows: the state dot or branch glyph, the name and one badge, as on the Mac.
2. They tap a section's bar: it folds. They tap it again: it opens. The phone remembers it.
3. They tap ⋯ on a section and pick Group by › Status. The section regroups on the phone and on the Mac.
4. They press and hold a session. A sheet lists Open PR, Pin to top, Rename, Fork, Move to workspace, Move under, Link to task… and Archive.
5. They tap + on a project's header. New session opens with that project picked.

## Behaviour and acceptance criteria

### The list (layer 1)

- [x] Each section shows as a bar with its name, then its groups as the section's view says (X32): grouped by project, task, status or not at all, sorted by recent activity, creation or name, with the project filter. A project group is headed by the project's row, a status or task group by a small label, an ungrouped section by nothing. Rows nested under a session (X112) follow it, indented. (`sessionList.test.ts` "follows the section's view: grouped by status, sorted by name", "keeps a nested session right under its parent, marked nested")
- [x] A project's row shows the GitHub owner's avatar of its `origin` (from `avatars.githubusercontent.com`, which the phone's CSP already allows), else the dotted mark; its name; `on <member>` when the group comes from another member of the account (X68); and the desktop's base chip (`↓ 3`, `pulling`, `diverged`) when the base branch is behind, which pulls on a tap. (`sessionList.test.ts` "gives a project on GitHub its owner's avatar", `projectAvatar.test.ts`)
- [x] A project of the section shows even with no sessions while the All chip is on and nothing is searched, so its + is there. (`sessionList.test.ts` "keeps a project without sessions under All, not under a chip or a search")
- [x] A session row is the desktop's row (`RowView`), 44px tall on the phone: the state dot, or the branch glyph tinted by the PR's state when the agent is at rest; the name; the desktop's badge (`creating`, `needs input`, `2 agents` or the diff stat, `+412 -38`); a merge icon when the PR is merged; a server mark when the session runs on another member. (`sessionList.test.ts` "gives each row what its glyph and badge need")
- [x] Session rows follow the phone's own **Session rows** setting in Hosts, A (issue number column) or B (task as a sub-header), A by default, drawn as X48 says. The phone knows a session's task from its stored link or the boards the Mac shares (X76); it does not know when a task is out of sync, so the phone never shows a key in orange. (`sessionList.test.ts` "gives a linked session its task line", `rowStyle` in desktop `sessionRows.test.ts`)
- [x] The filter chips (All, Needs you, Working, Review) and the search stay above the list. (`sessionList.test.ts` chips, filterGroups)
- [x] Tapping a row opens the plan sheet for a waiting plan, else the session's Chat, as before (X40).

### Actions (layer 2)

- [ ] Pressing and holding a row (half a second) opens the session's sheet with the desktop's items (`sessionMenu`, X112) the phone can do: Open, Open PR (with a PR), Pin to top or Unpin from top, Rename, Fork, Move to workspace, Move under, Link to task… (with no task and a board), and Archive. Another member's session (X72) has Open, and Archive while its member is reachable. Mark as read/unread, Open in and Keep in sync are the Mac's own and are left out. (`sessionActions.test.ts`)
- [ ] Rename asks for the name in the sheet and saves it with `session.update`; Pin, Move under and Move to workspace save with `session.update` too; Fork calls `session.fork` and opens the new session; Archive opens the same archive sheet as the session screen. (`sessionActions.test.ts` for what each item sends)
- [ ] Tapping a section's bar or a project's row folds it; tapping again opens it. Folds are kept on the phone. (`sessionList.test.ts` "leaves out the rows of a folded section or project")
- [ ] A section's ⋯ opens a sheet with Group by (Project, Task, Status, None), Filter by project and Sort by (Recent activity, Created, Name), each ticked as the section is. A choice saves the section's view with `section.update` on the section's host, so the Mac shows it too. (`sessionActions.test.ts` "sectionView")
- [ ] + on a project's row opens New session with that project picked. (`app.test.ts` "newSessionIn")
- [ ] Phones may call `session.fork` and `section.update` (`PHONE_METHODS`). (`crates/moonletd/tests/mobile.rs` "a_phone_may_fork_a_session_and_change_a_sections_view")

## UI

The desktop sidebar's sizes, but rows 44px (40px nested) for a finger. The section bar is 38px with `bg-bg`, rounded, the name in `ui-text-14` semibold muted and ⋯ at the end. Long press highlights the row. Sheets are the phone's bottom sheets.

## Protocol and RPCs

No new RPCs. Phones may now call `session.fork` and `section.update`.

## Data and config

Phone settings (`mobile.settings`): `sessionRows: "number" | "task"` (missing: `"number"`), `collapsed: Record<string, true>` keyed as the desktop does (`sectionCollapseKey`, `groupCollapseKey`).

## Security considerations

`session.fork` copies a session's worktree on its host and `section.update` changes a section's name and view; both act only on what the paired phone can already see and change through `session.update`. No new input crosses a trust boundary: the avatar URL is built from the project's own origin and only for a GitHub owner name that passes the X15 check.

## Out of scope

Unread state, the design pen mark, sync marks, the not-ready triangle, picking several sessions (X106), a project's settings and getting a project another member has (X70) on the phone.

## Test plan

Vitest in `apps/mobile/src/lib` for grouping, rows, folds and menu items; daemon test for the two new phone methods; a screenshot of Sessions through the phone browser harness.

## Open questions

- None.
