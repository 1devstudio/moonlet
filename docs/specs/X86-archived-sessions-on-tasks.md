# X86 — Archived sessions stay on their task

- **Status:** draft
- **Priority / phase:** P1 · phase 3 (extends [X45](X45-tasks-mode.md), [X46](X46-tasks-in-sessions.md) and [S4](S4-restore-after-restart.md))
- **PRD refs:** none (user request, 2026-11-07)
- **Related ADRs:** none

## Summary

When a session linked to a task is archived, it disappears from the task's
card, the task detail and the session's Task tab, so the work done on the task
can no longer be found from the task. Archiving also deletes the session's chat
transcripts and forgets its tabs, so Restore brings back only the worktree and a
shell: the agent's conversation is gone.

With this feature an archived session stays listed on its task, as archived.
Opening it shows a read-only page with its chat transcripts and a Restore
button. Restore brings back the tabs it had when it was archived, and its
agents continue their conversations.

## User journey

1. A session works on task ACME-12 and is archived, by hand or with Clean up.
2. ACME-12's card in Tasks mode shows its live sessions as before, and under
   them a muted line: `1 archived`. Unfolding it lists the archived session.
3. The user clicks the archived session. The main area shows its read-only
   page: the header has its name, `Archived` and a **Restore** button; below
   are the task, project and branch, its PR, when it was created and archived,
   and its chat transcripts, read only.
4. The user clicks **Restore**. The worktree comes back, its tabs open again,
   and a Claude agent continues its last conversation in that worktree.

## Behaviour and acceptance criteria

### On the task

- [ ] An archived session belongs to a task the same way a live one does: by
      its stored link, or (unless unlinked) by its branch name or its PR (X44
      link rules).
- [ ] A card lists its archived sessions apart from its live ones. They do not
      count as the task's sessions: they move no GitHub issue to In Progress or
      In Review, raise no out-of-sync chip ("Session open", "Done, N sessions"
      with Clean up), never make the card need the user, and are not archived
      again by Clean up.
- [ ] A card with only archived sessions still says "No sessions" with its
      Start button, and the list row's summary counts only live sessions.
- [ ] The board card, the list row's detail and the task detail show
      `N archived`, folded; unfolded, each archived session is a row with its
      name, an archive mark and its branch.
- [ ] The session's Task tab lists the task's archived sessions after the live
      ones; "Session N of M" and "Sessions on this task N" count only live
      ones.

### The archived session's page

- [ ] Selecting an archived session (from a task, or from History) shows its
      read-only page instead of the home screen.
- [ ] The header shows its name, `Archived` and a **Restore** button.
- [ ] The page shows the task it belongs to, `project/branch`, its PR when
      known, when it was created and when it was archived (sessions archived
      before X86 have no archive time and show none).
- [ ] The page shows each chat transcript the session had when it was
      archived, oldest tab first, read only: no input, no permission answers.
      A session with no chat transcripts says so.
- [ ] **Restore** restores the session (as History's Restore does) and shows its
      normal view.

### Archive and restore keep the conversation

- [ ] Archiving a session keeps its chats' transcripts (they leave the live
      chat list) and remembers the tabs it had (S4 restore entries).
- [ ] Restoring brings back each kept chat with its transcript, and each
      remembered tab: a Claude tab continues its conversation (`--continue`)
      when the workspace's Claude profile is the one it ran in (X33), other
      agents resume as after a restart, shells start again in their folder.
- [ ] Restoring a session archived before X86 (nothing kept) starts one tab, as
      before.
- [ ] A kept chat is not restored after a daemon restart while its session is
      archived, and never counts as a live terminal.
- [ ] Removing a project from moonlet, which forgets its archived sessions,
      deletes their kept chats.

## UI

- `components/tasks/TasksMode.tsx`: under a card's live rows, a muted
  `N archived` toggle (chevron); unfolded rows use the `Archive` icon instead of
  the state glyph, faint text, the branch on the right. The same block in the
  task detail's Sessions section.
- `components/tasks/SessionTask.tsx`: archived rows under "Sessions on this
  task".
- `components/ArchivedSession.tsx` (new): the read-only page, rendered by
  `App.tsx` when the selected session is archived. The right panel stays
  closed for it.
- History's Restore and the page's Restore share one action
  (`restoreSession` in `lib/actions.ts`).

## Protocol and RPCs

- `session.history { id }` (new) → `{ chats: [{ id, title, agent, items }] }`:
  the kept chats of an archived session, oldest first. Fails for a session
  that is not archived.
- `session.archive` keeps the session's chats and its restore entries, and
  sets `archived_at`.
- `session.unarchive` brings back the kept chats and replays the kept restore
  entries; with neither, it starts one tab as before.

## Data and config

- `Session.archived_at` (ms since the epoch) and `Session.archived_restore`
  (the S4 restore entries at archive time) in the daemon's state. Both are
  absent on sessions archived before X86.
- Kept chats live in `~/.moonlet/chats/archived/<session id>/<terminal id>.json`,
  the same format as live chats; the daemon's chat restore reads only the top
  level of `~/.moonlet/chats`.

## Security considerations

Transcripts are shown with the same rendering as live chats (Markdown sanitised
the same way). `session.history` takes a session id and reads only that
session's folder; the id is checked against the session list before any path is
built from it.

## Out of scope

- The transcript of a TUI agent tab (the terminal's screen is gone once its
  process ends; the agent's own history is continued on Restore instead).
- Archived sessions on the phone (X76): the hub drops an archived session's
  copy, so the phone cannot list them.
- Changing the "issue moves to Done" rule: it stays Suggest or Off (X46).

## Test plan

- `crates/moonlet-core/src/session.rs`: archive then unarchive relaunches a
  Claude tab with `--continue`; a session archived with no tabs starts one;
  archive sets `archived_at`; a chat session's chat is its history and comes
  back on Restore, and removing the project deletes it.
- `crates/moonlet-core/src/chat/runtime.rs`: an archived chat leaves the live
  list, is not restored by a daemon start, is listed by its session's history
  and comes back with its items on unarchive; forgetting it deletes it.
- `crates/moonletd/tests/`: `session.history` returns an archived session's
  chats and refuses a live session.
- `lib/tasksBoard.test.ts`: archived sessions on `card.archived`, by link and
  by branch; no column move, no chip, not in Clean up.
- `lib/tasksList.test.ts`, `lib/taskDetails.test.ts`: counts and rows.
- `lib/archivedSession.test.ts`: the page's summary lines.
- `e2e/specs/tasks-mode.e2e.ts`: archive a linked session, see it under its
  card, open its read-only page, Restore.

## Open questions

- None.
