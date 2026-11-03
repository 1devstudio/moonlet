# X78 — The app stays quiet while nothing changes

- **Status:** implemented
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

- [x] A git poll whose result equals the session's current git status changes
      nothing in the store, so nothing re-renders (`re-renders nothing when
      the worktree has not changed since the last poll`).
- [x] A git poll whose result differs updates the session's git status, as
      before (`stores a changed status and tells subscribers once`).
- [x] A workspace's board is built once for a given set of inputs, however many
      components show it (sidebar, mode switch, a session's task, Tasks mode).
      It is built again when anything it reads changes, projects and the
      workspace's hosts included. Boards of the last 8 workspaces are kept
      (`is built once however many components ask for it`, `is built again
      once the workspace's projects change`, `is built again once the
      workspace's hosts change`, `keeps the boards of the last 8 workspaces
      shown`).
- [x] Linking a session to tasks lower-cases the session's branch, PR title,
      repository and name once, not once per task. Links found are the same as
      before.

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

- Vitest, `gitPoll.test.ts`: `re-renders nothing when the worktree has not
  changed since the last poll` and `stores a changed status and tells
  subscribers once`.
- Vitest, `workspaceBoard.test.ts`: `is built once however many components ask
  for it`, `is a workspace's own, even for another account's workspace of the
  same id`, `is built again once a Tasks setting changes`, `is built again
  once the workspace's hosts change`, `keeps the boards of the last 8
  workspaces shown`, `is built again once
  the workspace's projects change` and `is built again once a session it shows
  changes`.
- Vitest: existing `tasks.test.ts`, `tasksBoard.test.ts` and `tasksStore.test.ts`
  link tests stay green. A board built from 306 sessions and 165 tasks took
  7.7–7.9 ms before and 4.0–5.4 ms after (best of 10, Node).
- Manual: `footprint -p <pid>` and `ps -o pcpu` of the app's web content process
  (found with `launchctl print pid/<pid>`, bundle ID `dev.onedevstudio.moonlet`)
  before and after, with the user's sessions loaded and the app idle.

## Open questions

- None.
