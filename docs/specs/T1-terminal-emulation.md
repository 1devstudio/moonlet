# T1: Terminal emulation and rendering

- **Status:** implemented
- **Priority / phase:** P0 · phase 1
- **PRD refs:** T1, NFR performance
- **Related ADRs:** [0003](../adr/0003-vt100-terminal-state.md)

## Summary

Panes are xterm.js 6 terminals. They render with the WebGL addon and fall back to the DOM renderer, with truecolor, Unicode 11 widths, IME and ligature-capable fonts. Terminal instances live outside React (`src/lib/terminals.ts`), so switching tabs or workspaces never re-attaches a pane or loses scrollback.

## Behaviour and acceptance criteria

- [x] One `TermEntry` per session per app. It is created when the pane is first shown; it attaches and receives the daemon snapshot.
- [x] PTY output arrives through one binary Tauri channel per host, batched every 8 ms, as `[u32 session][u32 len][bytes]` records. JSON is never used for output.
- [x] The attach snapshot travels on the same channel, flagged `RESET_FLAG`, so the reset and redraw always precede live output.
- [x] WebGL is enabled only while a pane is on screen (WebKit limits live contexts). On context loss or failure the pane falls back to the DOM renderer; a setting turns WebGL off.
- [x] Resizing refits xterm and sends a debounced (60 ms) `session.resize`.
- [x] URLs open in the browser. Cmd-click on file paths is handled in [F3](F3-open-from-terminal.md).
- [x] OSC 52 clipboard writes are swallowed unless enabled in Settings.
- [x] Option-as-Meta is on by default and can be changed in Settings.

## Out of scope

- Ligatures beyond what the chosen font and renderer support.
- A custom renderer.

## Test plan

- Manual checks M1–M3 in [manual-checks](../manual-checks.md).
- `daemon.test.ts`-level parsing is covered by `parseBatch` (see `src/lib/daemon.ts`).
