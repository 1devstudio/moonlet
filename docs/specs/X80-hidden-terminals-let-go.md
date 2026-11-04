# X80 — Hidden terminals let go of their memory

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** performance targets in `docs/plan.md` (memory under 600 MB with 10 panes), S2 reattach replay, T1 terminal rendering
- **Related ADRs:** none

## Summary

The app's web content process grew to 1.5–1.9 GB in a day. Every terminal
ever shown kept a live xterm.js terminal, with 10,000 rows of scrollback, until
the terminal itself was removed. Switching tabs or sessions only took the
terminal off the screen: it stayed attached to the daemon, so hidden terminals
kept receiving and parsing their output. Agents and dev servers print a lot,
so the scrollback of every one of them filled up.

The daemon already keeps every terminal's screen and scrollback, and replays
them when a client attaches (S2). The app therefore keeps only the terminals
shown most recently, and lets go of the others; a terminal shown again is
attached again and drawn from the daemon's replay.

## User journey

1. The user works in many sessions, each with agent and shell tabs, and
   switches between them all day.
2. The app keeps the eight terminals shown most recently. Older ones are let
   go of: their xterm is disposed and the daemon stops sending their output.
3. The user goes back to a terminal shown long ago. It shows its screen and
   scrollback, as after a reconnect, and its live output carries on.

## Behaviour and acceptance criteria

- [x] At most 8 terminals keep a live xterm. When a ninth is shown, the one
      shown longest ago is let go of: its xterm and add-ons are disposed, the
      app sends `terminal.detach` for it, and it receives no more output
      (`lets go of the least recently shown terminals beyond the limit (X80)`,
      `a ninth terminal shown lets go of the one shown longest ago, and detaches it (X80)`).
- [x] A terminal counts as shown until it leaves the screen: one in a split
      that is closed, or whose tab is hidden, is shown more recently than any
      terminal hidden before it
      (`a terminal that leaves the screen counts as shown just then (X80)`).
      Terminals beyond the limit that were kept only because they were on
      screen are let go of once they leave it, as when a split of more than
      8 panes is hidden; a pane unmounted and mounted again at once, as its
      effect runs again, is kept
      (`a split of ten hidden lets go of the two shown longest ago (X80)`,
      `a pane unmounted and mounted again in one go is kept (X80)`).
- [x] A terminal let go of while its attach is still on its way ends up
      detached: once the attach answers, the app sends `terminal.detach`
      again, since the daemon may have taken the first one before the attach
      (`a terminal let go of while its attach is on its way is detached once the attach answers (X80)`).
      It does not when the terminal was shown again meanwhile: the new
      terminal's attach keeps it subscribed
      (`a terminal shown again before its slow attach answers stays subscribed (X80)`).
- [x] Another member's terminal (X72) let go of and shown again before its
      `session.detach` answers keeps the new attach's relay: the late answer
      forgets only the relay it detached, so typing still reaches the terminal
      (`a shared terminal shown again while its detach is on its way is typed into through its new relay (X80)`).
      One let go of and shown again while its first attach is on its way has
      that first attach's relay detached once it answers, and keeps the
      relay of the attach sent when it was shown again
      (`a shared terminal shown again while its first attach is on its way detaches the first relay only (X80)`).
- [x] A terminal let go of is attached again when it is shown again, and the
      daemon's replay (S2) draws its screen and scrollback
      (`a terminal let go of attaches again when shown, and the replay draws it (X80)`).
      One let go of and shown again at once keeps its live output: the
      daemon never handles the detach after the attach sent after it
      (`a_terminal_detached_and_attached_again_at_once_keeps_its_live_output`).
      A terminal attaches once it is in its pane, fitted to it, so the replay
      is drawn at the pane's size rather than 80x24, and no resize follows
      (`a terminal shown again attaches at the size its pane fits, not 80x24 (X80)`).
      The attach waits for the pane's other effects in the same commit, so a
      terminal in Blocks mode attaches at the rows its taller line height
      fits, not the classic ones, and no resize follows the replay
      (`a terminal shown in Blocks mode attaches at the rows Blocks mode fits, and no resize follows (X80)`).
- [x] A terminal on screen is never let go of, nor is any pane of a split on
      screen, even when more than 8 are on screen
      (`never lets go of a terminal on screen, even past the limit (X80)`,
      `ten terminals on screen at once are all kept (X80)`,
      `a terminal in a split on screen is kept however many others are shown (X80)`).
- [x] Terminals are let go of only once every pane shown with the one just
      shown has mounted, so showing a split tab never lets go of its second
      pane for its first, even when the second was shown longest ago
      (`a split tab shown keeps both its panes, though one was shown longest ago (X80)`).
- [x] A terminal keeps its newest 2000 command blocks (T4, T8). The marks and
      decorations of an older block are disposed when it is dropped, not left
      in the terminal until its rows leave the scrollback
      (`a block dropped past the 2000 kept lets go of its marks (X80)`).
- [x] Only a block's prompt (`A`), output (`C`) and end (`D`) marks keep a
      marker in the terminal. A shell's input mark (`B`) leaves none behind
      (`a command's input mark (B) leaves no mark behind in the terminal (X80)`).

## UI

- A tab that is not on screen does not create a terminal, so opening a
  session with several tabs creates only the terminals of its active tab. A
  hidden tab's pane passes Blocks mode, block header context and the reported
  directory to its terminal only while one exists; the pane passes them again
  when the tab is shown. The pane asks `entryFor` in
  `apps/desktop/src/lib/terminals.ts` for its terminal
  (`a hidden pane creates no terminal, nor brings back one let go of (X80)`).
- A terminal shown again after it was let go of is drawn from the replay, as
  after a reconnect: a block's header shows the time the daemon recorded for
  it (`moonlet_age`), a text selection or selected block is not kept, and the
  scroll position is back at the bottom.

## Protocol and RPCs

No new RPC. The app now sends `terminal.detach` (already handled by the
daemon, and routed to `session.detach` for another member's terminal, X72)
when it lets go of a terminal. The daemon handles `terminal.detach` in its
read loop, in frame order with `terminal.attach`, rather than on a task of its
own: a terminal let go of and shown again at once sends a detach then an
attach, and a detach handled late would undo the attach, leaving the terminal
without live output
(`a_terminal_detached_and_attached_again_at_once_keeps_its_live_output`).

## Data and config

None. The limit is a constant in `apps/desktop/src/lib/terminals.ts`
(`LIVE_TERMINALS`).

## Security considerations

None: no new input crosses a trust boundary.

## Out of scope

- Fewer rows of scrollback for terminals that stay live.
- A setting for the number of live terminals.
- Chat agents (`SessionChat`), whose items are kept by the store, not by
  xterm.

## Test plan

- Rust, `crates/moonletd/tests/daemon.rs`, against a real daemon, with a
  detach and an attach of one terminal sent in one write:
  `a_terminal_detached_and_attached_again_at_once_keeps_its_live_output`.
- Vitest, `daemon.test.ts`, through `rpc` and `sendInput` to a copy host,
  with the Tauri core faked as its central host:
  `a shared terminal shown again while its detach is on its way is typed into through its new relay (X80)` and
  `a shared terminal shown again while its first attach is on its way detaches the first relay only (X80)`.
- Vitest, `terminals.test.ts`, the pure choice of terminals to let go of:
  `lets go of the least recently shown terminals beyond the limit (X80)` and
  `never lets go of a terminal on screen, even past the limit (X80)`.
- Vitest, `terminals.test.ts`, through `getEntry`, `findEntry`, `entryFor`
  and `TermEntry.mount`, through the app's daemon bridge (`daemon.ts`) to a
  faked Tauri core: the RPCs it is sent are recorded, the terminals it would
  send output for tracked, and an attach is answered as the core answers it,
  with the terminal's replay on its host's output channel before the reply:
  `a ninth terminal shown lets go of the one shown longest ago, and detaches it (X80)`,
  `a terminal that leaves the screen counts as shown just then (X80)`,
  `a split of ten hidden lets go of the two shown longest ago (X80)`,
  `a pane unmounted and mounted again in one go is kept (X80)`,
  `a terminal let go of while its attach is on its way is detached once the attach answers (X80)`,
  `a terminal shown again before its slow attach answers stays subscribed (X80)`,
  `a terminal let go of attaches again when shown, and the replay draws it (X80)`,
  `a terminal shown again attaches at the size its pane fits, not 80x24 (X80)`,
  `a terminal shown in Blocks mode attaches at the rows Blocks mode fits, and no resize follows (X80)`,
  `ten terminals on screen at once are all kept (X80)`,
  `a terminal in a split on screen is kept however many others are shown (X80)`,
  `a split tab shown keeps both its panes, though one was shown longest ago (X80)`,
  `a hidden pane creates no terminal, nor brings back one let go of (X80)`,
  `a block dropped past the 2000 kept lets go of its marks (X80)` and
  `a command's input mark (B) leaves no mark behind in the terminal (X80)`.

## Open questions

- None.
