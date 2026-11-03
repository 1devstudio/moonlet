# X78 — The app stays quiet while nothing changes

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** performance targets in `docs/plan.md` (memory under 600 MB with 10 panes)
- **Related ADRs:** none

## Summary

On a Mac with 81 open and 225 archived sessions, three Tasks boards and 165
tracker tasks, the app's web content process used about 35% of a core while the
user did nothing, and grew past 1.5 GB in a day. A one-second sample showed the
main thread busy in JavaScript started by timers: lower-casing strings, regex
replaces and `Object.values`. The app rebuilds the Tasks board and re-renders on
every store change, and the background git poll changes the store for every
open session every 20 seconds, even when nothing in the worktree changed. This
spec makes the app do no work for polls that bring nothing new, and builds each
workspace's board once per change instead of once per component that shows it.

## User journey

1. The user keeps many sessions open and leaves the app running.
2. Nothing happens in the worktrees. The app's CPU use stays near zero, and the
   fans and the window server stay quiet.
3. An agent edits a file. The session's diffstat and the board update as before.

## Behaviour and acceptance criteria

- [ ] A git poll whose result equals the session's current git status changes
      nothing in the store, so nothing re-renders.
- [ ] A git poll whose result differs updates the session's git status, as
      before.
- [ ] A workspace's board is built once for a given set of inputs, however many
      components show it (sidebar, mode switch, a session's task, Tasks mode).
- [ ] Linking sessions to tasks lower-cases each task key, repository and title
      once per task list, not once per session and task pair. Links found are
      the same as before.

## UI

No visible change.

## Protocol and RPCs

None.

## Data and config

None.

## Security considerations

None: no new inputs.

## Out of scope

Later parts of the same investigation, each with its own change:

- Terminals of sessions not shown keep a live xterm with 10,000 lines of
  scrollback and keep parsing output. A cap on live terminals, with replay on
  return (S2), is a separate change.
- Every chat's transcript stays in memory and renders without virtualization.
- Infinite CSS animations keep running in hidden tabs.
- `App` reads the whole store without a selector, so any store change
  re-renders the whole tree.

## Test plan

- Vitest: a poll that returns the same status notifies no store subscriber; a
  changed status notifies once and is stored.
- Vitest: the board for the same inputs is the same object when asked for
  twice; new inputs give a new board.
- Vitest: existing `tasks.test.ts`, `tasksBoard.test.ts` and `tasksStore.test.ts`
  link tests stay green.
- Manual: `footprint -p <pid>` and `ps -o pcpu` of the app's web content process
  (found with `launchctl print pid/<pid>`, bundle ID `dev.onedevstudio.moonlet`)
  before and after, with the user's sessions loaded and the app idle.

## Open questions

- None.
