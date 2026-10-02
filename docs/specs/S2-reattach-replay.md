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

## UI

On attach the client calls `term.reset()`, writes the snapshot, then writes live output.

## Out of scope

- Persisting scrollback to disk (S5, P2).
- Replaying the hidden main screen while the alternate screen is active.

## Test plan

- Round-trip fidelity tests in `term.rs`.
- The e2e test `session_survives_client_disconnect_and_replays_on_reattach`.
