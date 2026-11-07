# X86 — Archived sessions stay on their task

- **Status:** implemented
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
button. Restore brings back the chats and tabs it had when it was archived.
Its agents resume the way they do after a daemon restart (S4): a chat goes on
from its kept transcript, a Claude tab continues its conversation while the
workspace uses the Claude profile it ran in (X33), and an agent with no known
way to resume starts again.

## User journey

1. A session works on task ACME-12 and is archived, by hand or with Clean up.
2. ACME-12's card in Tasks mode shows its live sessions as before, and under
   them a muted line: `1 archived`. Unfolding it lists the archived session.
3. The user clicks the archived session. The main area shows its read-only
   page: the header has its name, `Archived` and a **Restore** button; below
   are the task, project and branch, its PR, when it was created and archived,
   and its chat transcripts, read only.
4. The user clicks **Restore**. The worktree comes back, its tabs open again,
   and its Claude agent continues its conversation (unless the workspace's
   Claude profile changed since, X33).

## Behaviour and acceptance criteria

### On the task

- [x] An archived session belongs to a task the same way a live one does: by
      its stored link, or (unless unlinked) by its branch name or its PR (X44
      link rules). An archived session's PR is no longer polled: the PR seen
      last in this run of the app counts, else the PR number the daemon keeps,
      which links it to the GitHub issue that PR closes. (`tasksBoard.test.ts`
      "lists a task's archived sessions apart, by its stored link or its branch,
      leaving an unlinked one out"; `tasksStore.test.ts` "links an archived
      session to the issue its stored PR closes, though its PR is no longer
      polled")
- [x] A card lists its archived sessions apart from its live ones. They do not
      count as the task's sessions: they move no GitHub issue to In Progress or
      In Review, raise no out-of-sync chip ("Session open", "Done, N sessions"
      with Clean up), never make the card need the user, and are not archived
      again by Clean up. (`tasksBoard.test.ts` "counts no archived session as
      the task's: no column, chip, empty line or clean-up of their own")
- [x] A card with only archived sessions still says "No sessions" with its
      Start button, and the list row's summary counts only live sessions.
      (`tasksBoard.test.ts` "counts no archived session as the task's: no
      column, chip, empty line or clean-up of their own"; `tasksList.test.ts`
      "sums, counts and takes the PR of its live sessions only")
- [x] The board card, the list row's detail and the task detail show
      `N archived`, folded; unfolded, each archived session is a row with its
      name, an archive mark and its branch. (`archivedSession.test.ts` "counts
      them for the folded line"; `tasks-mode.e2e.ts` "lists a task's archived sessions under its card, opens one read only, and restores it from its header (X86)", on the board card)
- [x] The session's Task tab lists the task's archived sessions after the live
      ones; "Session N of M" and "Sessions on this task N" count only live
      ones. It finds its task's card by the session's host and id.
      (`tasksBoard.test.ts` "finds the card of a session, live or archived, by
      its host and id". Partly: the tab's rows themselves are UI only, no test.)

### The archived session's page

- [x] Selecting an archived session (from a task, or by name in History) shows
      its read-only page instead of the home screen. (`tasks-mode.e2e.ts` "lists a task's archived sessions under its card, opens one read only, and restores it from its header (X86)")
- [x] The header shows its name, `Archived` and a **Restore** button.
      (`tasks-mode.e2e.ts` "lists a task's archived sessions under its card, opens one read only, and restores it from its header (X86)")
- [x] The page shows the task it belongs to, `project/branch`, its PR when
      known (by its number alone when its state is not), when it was created
      and when it was archived (sessions archived before X86 have no archive
      time and show none). (`archivedSession.test.ts` "says its task, where it
      worked, its PR and when it was created and archived", "leaves out what it
      does not know, as for a session archived before X86", "says a PR whose
      state it no longer knows by its number"; `a_session_archived_without_tabs_restores_with_one_and_says_when_it_was_archived`)
- [x] The page names the tabs Restore starts again: an agent's tab (a terminal
      agent, whose transcript is not kept here) continues its conversation, a
      shell starts again. (`archivedSession.test.ts` "names the tabs Restore
      starts again: an agent's goes on with its conversation")
- [x] The page shows each chat transcript the session had when it was
      archived, oldest tab first, read only: no input, no permission answers.
      A session with no chat transcripts says so; a host whose moonlet has no
      `session.history` says to update it, and any other failure says why.
      (`an_archived_sessions_chat_is_its_history_and_comes_back_on_restore`,
      `an_archived_sessions_history_is_read_over_rpc`; `archivedSession.test.ts`
      "says when it kept no chat, when the host's moonlet is too old to say,
      and why else it could not". Partly: the rendered transcript is UI only.)
- [x] **Restore** restores the session (as History's Restore does) and shows its
      normal view. (`actions.test.ts` "restores the session and shows it,
      live", "says why it could not, and leaves it archived";
      `tasks-mode.e2e.ts` "lists a task's archived sessions under its card, opens one read only, and restores it from its header (X86)")

### Archive and restore keep the conversation

- [x] Archiving a session keeps its chats' transcripts (they leave the live
      chat list) and remembers the tabs it had (S4 restore entries).
      (`an_archived_chat_is_kept_listed_and_restored_with_its_session`)
- [x] An archive that fails after its chats were kept (a worktree or branch git
      will not remove) leaves the session live with its chats.
      (`a_failed_archive_gives_the_session_its_chats_back`)
- [x] Restoring brings back each kept chat with its transcript, and each
      remembered tab: a Claude tab continues its conversation (`--continue`)
      when the workspace's Claude profile is the one it ran in (X33), other
      agents resume as after a restart, shells start again in their folder.
      (`restoring_an_archived_session_continues_its_claude_tab`,
      `an_archived_sessions_chat_is_its_history_and_comes_back_on_restore`; the
      profile rule is S4's own, `a_restored_claude_tab_continues_only_in_the_same_profile`)
- [x] A kept chat whose terminal id another chat took meanwhile (ids start
      again with each daemon) comes back under a new id, and neither
      transcript is lost. (`a_kept_chat_whose_id_was_taken_meanwhile_comes_back_beside_the_new_one`)
- [x] Restoring a session archived before X86 (nothing kept) starts one tab, as
      before. (`a_session_archived_without_tabs_restores_with_one_and_says_when_it_was_archived`)
- [x] A kept chat is not restored after a daemon restart while its session is
      archived, and never counts as a live terminal.
      (`an_archived_chat_is_kept_listed_and_restored_with_its_session`)
- [x] Removing a project from moonlet, which forgets its archived sessions,
      deletes their kept chats.
      (`an_archived_sessions_chat_is_its_history_and_comes_back_on_restore`,
      `forgetting_an_archived_sessions_chats_deletes_them`)

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
- A conversation per Claude TUI tab: like a restart (S4), Restore runs
  `claude --continue`, which takes the worktree's latest conversation, so two
  Claude TUI tabs in one worktree both continue that one. Keeping each tab's
  conversation id would change S4 too, and is left for its own spec.
- A test that the page offers no input or permission answers: it renders the
  kept items with the chat's item views and no editor, and React components
  have no unit tests here (AGENTS.md).
- Archived sessions on the phone (X76): the hub drops an archived session's
  copy, so the phone cannot list them.
- Changing the "issue moves to Done" rule: it stays Suggest or Off (X46).

## Test plan

- `crates/moonlet-core/src/session.rs`: archive then unarchive relaunches a
  Claude tab with `--continue`; a session archived with no tabs starts one;
  archive sets `archived_at`; a chat session's chat is its history and comes
  back on Restore, and removing the project deletes it; a failed archive gives
  the chats back.
- `crates/moonlet-core/src/chat/runtime.rs`: an archived chat leaves the live
  list, is not restored by a daemon start, is listed by its session's history
  and comes back with its items on unarchive, beside a chat that took its id;
  forgetting it deletes it.
- `crates/moonletd/tests/daemon.rs`: `session.history` returns an archived
  session's chats and refuses a live session.
- `lib/tasksBoard.test.ts`: archived sessions on `card.archived`, by link and
  by branch; no column move, no chip, not in Clean up; the card of a session by
  host and id.
- `lib/tasksStore.test.ts`: the link by the PR number the daemon keeps.
- `lib/tasksList.test.ts`: the list row counts only live sessions.
- `lib/archivedSession.test.ts`: the page's lines, its notes and kept tabs.
- `lib/actions.test.ts`: `restoreSession`.
- `e2e/specs/tasks-mode.e2e.ts`: archive a linked session, see it under its
  card, open its read-only page, Restore; open it again from History.

## Open questions

- None.
