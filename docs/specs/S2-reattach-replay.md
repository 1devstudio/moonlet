# S2: Reattach with screen and scrollback replay

- **Status:** implemented
- **Priority / phase:** P0 · phase 1
- **PRD refs:** S2, metric "reattach < 300 ms local"
- **Related ADRs:** [0003](../adr/0003-vt100-terminal-state.md)

## Summary

The daemon runs every PTY's output through a headless `vt100` emulator. When a client attaches, it receives a snapshot that redraws scrollback, the screen, the cursor and input modes, followed by live output with no gap and no duplicates.

## Behaviour and acceptance criteria

- [x] `session.attach` returns `{info, snapshot}`. The snapshot starts with a terminal reset, then scrollback rows, then the screen.
- [x] The snapshot is taken and the client subscribed under one lock, so live output frames continue exactly where the snapshot ends (test: `attach_replays_screen_then_streams_live_output`).
- [x] Attach may pass `cols`/`rows`; the PTY and the emulator are resized before the snapshot.
- [x] Scrollback keeps 10,000 lines per session.
- [x] Alternate-screen apps are restored in the alternate screen with their input modes (application cursor, bracketed paste, mouse).
- [x] **Prompt marks:** the snapshot carries the shell's OSC 133 marks (`A`, `C`, `D` with its exit code) on the rows they were printed on, so a new window, a reconnect or an app restart rebuilds the shell's command blocks with their headers (T4, T8), not only the prompt that was open at attach. Each mark gets `moonlet_age=<ms>`, how long ago the daemon saw it, so finished blocks keep their durations; an age, not a time, so the app's and a remote host's clocks need not agree. Before each `C` whose directory differs from the last one sent, an OSC 7 gives the directory the command ran in, and a last OSC 7 gives the shell's current directory. Marks whose rows left the scrollback are dropped, and so are all marks after a full reset (`ESC c`). A mark printed above earlier ones (after `clear` homed the cursor and erased the screen) drops the marks below it, and a `D` whose `C` was dropped is not sent, so the app never ends a block twice. Marks printed while a full-screen program had the alternate screen are not kept, and a snapshot taken in the alternate screen has none (the primary screen is not replayed). The live upgrade (S3) replays the snapshot into the new daemon, so marks and ages carry over.
- [x] **Resizing:** the daemon's screen resizes as xterm does. Fewer rows (a smaller new window, or a pane not yet fitted) keep the newest rows: the cursor's row stays on screen and the rows above the new top go to the scrollback. More rows take rows back from the scrollback. `vt100` cut the rows below the new bottom, losing the newest output, the prompt and their marks, and added empty rows below, so a taller window showed the history above a blank screen.
- [x] **No erase after the marks:** xterm drops the markers on rows it erases, so the snapshot writes every scrollback and screen row once, with the marks at their starts, and then redraws the screen over them without an erase-in-display.
- [x] **Row counter:** `vt100` 0.16 does not say how many rows have scrolled into its scrollback, which stops growing at 10,000 rows, so mark rows could not be told apart once it is full. The workspace patches it (`vendor/vt100`, through `[patch.crates-io]`) with a count of rows pushed into the scrollback that also survives a full reset. The patch goes with `vt100` when T9 moves to libghostty-vt.

## UI

On attach the client calls `term.reset()`, writes the snapshot, then writes live output. Marks in the snapshot go through the same OSC 133 handling as live ones; a mark's `moonlet_age` sets the block's start or end time (`markTime()` in `lib/`).

- The snapshot is drawn at the size the attach asked for, which the daemon resized to before taking it; a pane fitted to another size while the snapshot was on its way is set back to that size for the snapshot, then fitted again. Drawn at another size, the screen rows landed in the wrong place and the newest marks were lost.
- A new window can replay the snapshot before it knows the terminal is in Blocks mode (that comes with the terminal's info); when the mode is set, the blocks it already has get their header rows (T8).

## Out of scope

- Persisting scrollback to disk (S5, P2).
- Replaying the hidden main screen while the alternate screen is active.

## Test plan

- Round-trip fidelity tests in `term.rs`.
- Resizing in `term.rs`: after shrinking from 10 to 4 rows the screen shows the newest block, after growing from 4 to 10 it shows both blocks, and every mark keeps its line.
- Prompt marks in `term.rs`: marks land before the rows they were printed on, in scrollback and on screen; ages from an injected clock; a directory change between blocks; marks dropped once their rows leave a full scrollback, after `ESC c`, and in the alternate screen; a snapshot replayed into a fresh state (the live upgrade) gives the same marks and ages.
- A real zsh in Blocks mode (`shell.rs`): after `echo one`, the snapshot has `C` right before the `one` row and `D;0` after it.
- `markTime()` (Vitest).
- e2e: a shell's blocks still have headers, exit codes and durations after the app attaches again.
- The e2e test `session_survives_client_disconnect_and_replays_on_reattach`.
