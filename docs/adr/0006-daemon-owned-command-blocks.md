# ADR 0006: Daemon-owned command blocks on libghostty-vt, drawn as static HTML plus a live xterm

- **Status:** accepted (2026-10-05)
- **Supersedes:** [ADR 0003](0003-vt100-terminal-state.md) (`vt100` for daemon-side terminal state).
- **Revises:** the answer to the PRD's open question "per-block grid rendering vs decorations", which [T4](../specs/T4-command-blocks.md) settled as "decorations are enough for v1".

## Context

Shell terminals in Blocks mode ([T7](../specs/T7-blocks-shell-model.md)) show each command as a [Block](../../CONTEXT.md), but only as xterm.js decorations over one shared grid. That gives the look (header, separator, selection highlight, copy) but not the behaviour the user wants:

- collapse and expand a block's output;
- a sticky block header while scrolling a long output;
- search and filter within one block;
- a running command cannot disturb earlier blocks (`clear`, cursor jumps, progress bars);
- blocks, with their command, cwd, exit status and timing, survive reconnects, app restarts and live upgrades.

Today the daemon keeps one `vt100` screen per terminal and snapshots carry no prompt marks, so the app loses block boundaries on every attach. `vt100` also cannot reflow: its `Grid::set_size` clears every row's wrapped flag when the width changes.

## Options

App side:

- **A. Static HTML plus one live xterm.** Finished blocks reach the app as styled text runs and are drawn as DOM in a virtual list; only the active block is a live xterm. Weeks of work. Links, search and copy have to be rebuilt on the DOM.
- **B. One xterm per block.** Simple, but WebKit limits live WebGL contexts and memory grows with every block. Breaks after a few dozen blocks.
- **C. The same terminal core in the app (WASM) with our own renderer.** See "Future direction" below. Months of work.

Daemon side:

- **Keep `vt100`** and split blocks ourselves. Stable, but no reflow and our own OSC 133 splitting.
- **libghostty-vt** through the Rust crate `libghostty-vt`. Reflows on resize, keeps a semantic-prompt marker per row that survives reflow, and ships a plain/VT/HTML formatter that covers any row range including scrollback. Its C API is marked "incomplete, work-in-progress… definitely going to change" and has no tagged release. The released crate (0.2.2, Ghostty pinned at a887df4) drops the OSC 133 exit code, ignores OSC 9/777 notifications, passes no unknown OSCs through and has no binary snapshot; upstream `main` and the unreleased crate `master` add these.
- **`alacritty_terminal`.** Reflows, but has no WASM build ("wontfix") and no versioned snapshot format, so it cannot become the shared core of option C.

## Decision

- **Daemon:** move terminal state from `vt100` to **libghostty-vt now**, as part of blocks v1. jaunt is used and tested only by its author, locally, so an unstable upstream API costs only our own update work. It replaces `vt100` for every terminal (agents, run scripts, classic shells), so the daemon has one emulator; `vt100` is removed.
  - Use the released crate **0.2.2**, pinned, and move to a newer release on purpose.
  - Ghostty's source comes from a pinned git submodule passed to the build as `GHOSTTY_SOURCE_DIR`, so builds are reproducible and work offline.
  - jaunt keeps its own small scanner for the OSC sequences it needs whatever the library supports: 133 (with the exit code), 9 and 777. The scanner also gives the byte offsets where blocks start and end.
- **Block storage: freeze on finish.** One live terminal per shell holds only the active block. At the `D` mark the daemon formats the block's rows (wrapped rows joined into logical lines, with styles) into the block store and resets the live terminal for the next command. Finished blocks never change, so a running program cannot touch them, and memory stays at one emulator per terminal. One terminal per block was rejected: about 2 MiB of virtual memory each (a 512 KiB page, four preheated). Row markers in one shared terminal were rejected: a screen clear would damage earlier blocks.
- **Blocks:** the daemon owns blocks for shell terminals in Blocks mode. Classic mode, shells without integration, agent, run and setup terminals keep a single screen.
- **Protocol:** carries the block model, not raw bytes for history: finished blocks as styled text runs with their metadata, plus the active block's screen and its live output. Nothing in it depends on how the app draws.
- **App:** option A. Finished blocks are static HTML, the active block is a live xterm. It ships behind a "Block view (beta)" setting, default off, until it has e2e coverage and a few days of real use; the decoration code is removed after that.
- The decoration-based styling (header, chips, selection) ships first; its header and chip logic carries over.
- `ssh` typed in a shell runs inside one active block. Remote hosts (R1 to R4) get full blocks natively, because the remote `jauntd` owns the shell. Prompt marks from a nested shell are ignored while a block is active.

## Consequences

- Every build of `jauntd`, the app and the remote helpers needs Zig 0.15.2 on `PATH` (cargo does not fetch it). jaunt already uses Zig through `cargo-zigbuild` in `scripts/build-remote.sh`; musl cross builds of libghostty-vt are not covered by its CI and must be checked.
- libghostty-vt types are `!Send` and `!Sync`, so a terminal's emulator can no longer sit behind the shared state mutex in `terminal.rs`. Each terminal's emulator lives on its own thread and the rest of the daemon talks to it over channels.
- The live upgrade replays the formatter's VT output (with input modes) into a fresh emulator; no binary snapshot is needed.
- While a full-screen program runs, the primary screen is not readable (same limit as `vt100`), so the active block's earlier output reappears only after the program exits.
- ADR 0003's round-trip tests (plain output with scrollback, Ink-style redraws, alternate-screen TUIs with application modes, CJK, combining marks and emoji) are ported and must pass on libghostty-vt before blocks build on it.
- The first live upgrade from a `vt100` daemon to a libghostty-vt daemon does not carry terminal state over: terminals restart once and their scrollback is lost. No migration is built.
- Reflow on resize now works for every block, including the one running.
- `PROTOCOL_VERSION` goes up; remote helpers and the live upgrade must carry blocks.
- Memory stays at today's budget: 10,000 lines across a terminal's blocks, whole blocks evicted oldest first, at most 2,000 blocks.

## Future direction: option C in the app

Write this down so it is not lost: the long-term destination is **libghostty-vt in the app as well (WASM), with jaunt's own renderer drawing from its render state**, so daemon and app run the same emulator. Block-based terminals with their own renderer work this way: each block holds separate header and output grids.

What C removes:
- Two emulators that can disagree (libghostty-vt in the daemon, xterm.js in the app).
- The DOM rebuilds of option A (links, search, copy) and the split between static and live blocks.

Why not now (checked 2026-10-05):
- libghostty-vt has no renderer, only render state. Selection, IME, accessibility, links, search, font shaping and GPU drawing would all be ours, and agent TUIs would run on it too, so it must be excellent before it replaces xterm.js anywhere.

Known pieces:
- WASM: `ghostty-vt.wasm` ships in Ghostty's nightly "tip" release. Coder's `ghostty-web` (MIT) wraps it behind an xterm.js-compatible API and could be a middle step for the app.

Revisit when option A is the default and the block protocol has settled.

Also later: turning a plain `ssh` into blocks (remote commands become blocks in the local terminal). One known approach installs a companion server on the remote host, reached over the existing connection, which matches jaunt's remote helper ([R2](../specs/R2-remote-helper-install.md)).

Sources: [ghostty `vt.h`](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt.h), [libghostty is coming](https://mitchellh.com/writing/libghostty-is-coming), [libghostty-rs](https://github.com/Uzaaft/libghostty-rs), [ghostty-web](https://github.com/coder/ghostty-web), [alacritty WASM issue](https://github.com/alacritty/alacritty/issues/7985).
