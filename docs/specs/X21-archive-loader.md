# X21: Pixel loader in the sidebar row while a session archives

- **Status:** implemented (UI unchecked in app)
- **Priority / phase:** P1 · phase 3 (extends [X5](X5-workspaces-projects-sessions.md))
- **PRD refs:** none (user request, 2026-10-06; design "Archive Prototype" and "Archive Loader Options")

## Summary

Archiving a session runs the project's archive script (up to 60 seconds), stops its terminals and removes the worktree. Until now the sidebar row sat unchanged for that whole time, so the app looked stuck. The row now turns into a small night scene drawn in pixel art while the daemon works, then folds away. Each archive picks one of five scenes at random.

## User journey

1. The user right-clicks a session and chooses Archive, then confirms.
2. The row keeps its 38 px height and becomes a dark strip across the sidebar: a spinner and the session name on the left, a looping pixel scene on the right.
3. When the daemon is done, the spinner becomes a done check. The scene plays at least one full cycle (6 seconds), so a fast archive still shows it.
4. The row folds to zero height and the "Archived …" toast appears.

## Behaviour and acceptance criteria

- [x] Each archive picks one scene at random from Gravedigger, Ghost, Zombie wave, Graveyard progress and Reaper, each equally likely.
- [x] After the user confirms, the session's row shows the loader while the archive RPC runs.
- [x] The row stays in the sidebar while the loader plays, even after the daemon reports the session archived.
- [x] The loader plays for at least 6 seconds (one cycle), then the row folds away and the "Archived …" toast shows.
- [x] When the archive fails, the loader stops at once, the row returns and the error shows.

## UI

`Sidebar.tsx`, `SessionRow`: while archiving, the row renders `ArchiveLoader` (`components/ArchiveLoader.tsx`), a 150 × 19 canvas scaled 2× with `image-rendering: pixelated`, drawn at 12 frames a second. Clicking, double-clicking, dragging and the context menu do nothing on an archiving row. The row's tooltip reads "Archiving…" and then "Archived". The fold is a 280 ms height and opacity transition. The scenes are ported from the design's "Archive Loader Options" page; the accent, foreground and done colours come from the theme's CSS variables.

## Protocol and RPCs

None. `session.archive` is unchanged; the loader covers the time it takes.

## Data and config

Nothing persisted. The store keeps `archiving` per session (`sesKey`): the scene, whether the daemon finished, and whether the row is folding.

## Security considerations

None: no input crosses a trust boundary.

## Out of scope

- Real progress per archive step (script, worktree, branch). The daemon reports no steps, so the scene loops instead of tracking them.
- Making the archive itself faster.

## Test plan

- `lib/archiveLoader.test.ts`: the random pick maps to each of the five scenes.
- `lib/actions.test.ts`: loader shown during the RPC, held for one cycle then folded with the toast, cleared at once on failure.
- `lib/sidebar.test.ts`: an archived session that is still archiving stays in its group.
- Manual: archive a session in the app and watch the row.

## Open questions

- None.
