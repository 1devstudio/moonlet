# T9: Real command blocks (daemon-owned, on libghostty-vt)

- **Status:** draft
- **Priority / phase:** P1 · phase 3 (requested 2026-10-05)
- **PRD refs:** T1, T3, T4, S2, S3; PRD open question "per-block grid rendering vs decorations"
- **Related:** [T4](T4-command-blocks.md), [T7](T7-blocks-shell-model.md), [T8](T8-block-styling.md) (styling that ships first), [S2](S2-reattach-replay.md), [S3](S3-live-upgrade.md), [R1](R1-ssh-hosts.md)–[R4](R4-unified-hosts-sidebar.md)
- **Related ADRs:** [0006](../adr/0006-daemon-owned-command-blocks.md) (decision and future direction), [0003](../adr/0003-vt100-terminal-state.md) (superseded)

## Summary

In shell terminals in Blocks mode, each command becomes a real [Block](../../CONTEXT.md) with its own content, owned by the daemon. A running command can no longer disturb earlier blocks, blocks can be collapsed and searched, their headers stick while scrolling, and they survive reconnects, app restarts and live upgrades. The daemon's terminal emulator moves from `vt100` to libghostty-vt for every terminal. The app draws finished blocks as static HTML and the active block as a live xterm, behind a "Block view (beta)" setting.

## User journey

1. The user turns on Settings → Terminal → "Block view (beta)". Shell terminals in Blocks mode switch to the block list; nothing else changes.
2. They run `cargo build`. The active block grows as output arrives; its progress bar redraws in place without touching the blocks above.
3. They run `seq 1 20000`, scroll through it with its header pinned at the top, then click the header to collapse it to one line.
4. They resize the window. Every block, including one still running, rewraps to the new width.
5. They quit and reopen the app. Every block is back with its command, directory, exit status and duration.
6. They run `clear`. All blocks disappear.
7. They run `ssh devbox`. The whole remote session runs inside that one block; vim on the remote takes the full pane. When ssh exits, the block shows its output and the input editor returns.

## Behaviour and acceptance criteria

### Scope

- [ ] Blocks exist only in shell terminals with shell integration in Blocks mode. Classic mode, shells without integration, and agent, run and setup terminals keep a single screen, drawn as today.
- [ ] Remote hosts behave the same, because their `jauntd` owns the shell.

### Emulator

- [ ] `jaunt-core` uses the `libghostty-vt` crate 0.2.2 for every terminal; `vt100` is removed. Ghostty's source is a pinned git submodule passed as `GHOSTTY_SOURCE_DIR`.
- [ ] ADR 0003's round-trip tests are ported and pass: plain output with scrollback, Ink-style redraws, an alternate-screen TUI with application cursor and keypad modes, CJK, combining marks and emoji.
- [ ] Today's terminal signals keep working: title, bell, OSC 7 cwd (A1, T3), OSC 52 (opt-in), alternate-screen state, and OSC 9 / OSC 777 notifications (through jaunt's own scanner, since 0.2.2 ignores them).
- [ ] Each terminal's emulator runs on its own thread; the rest of the daemon talks to it over channels.
- [ ] Resizing reflows the primary screen.

### Block lifecycle

- [ ] **Marks:** jaunt's scanner reads OSC 133 marks from the raw output, including marks split across reads. Every mark carries `aid=<token>`, a random token the daemon makes per terminal and passes in `JAUNT_MARK_TOKEN`. The integration copies it into an unexported shell variable and unsets the environment variable at startup, so programs the shell runs never see it. Only marks with the terminal's token are honoured, so nested shells and programs that print OSC 133 cannot open or close blocks. (The shell PID was rejected: any command can print `$$`.)
- [ ] **Start:** at a `C` mark a block opens with a per-terminal id, the command line (the text between the prompt and `C`), the cwd from the last OSC 7, and the daemon clock as `started_at`.
- [ ] **Finish:** at a `D` mark the block records its exit code and `ended_at`, and is **frozen**: its rows (from the command line to the cursor, including scrollback) are formatted into styled logical lines (wrapped rows joined) and stored. The live emulator's screen and scrollback are then cleared and the cursor homed, inside the daemon only. Terminal modes such as bracketed paste are kept.
- [ ] Finished blocks never change.
- [ ] **Full-screen programs** in the active block use the whole pane. When they exit, the block's earlier output is visible again.
- [ ] **`clear`:** only an explicit clear drops blocks:
  - an erase-display (`CSI 2J` or `CSI 3J`) printed at the prompt, between blocks, which is how the shell answers Ctrl+L and the editor's Ctrl+L;
  - a block whose command is `clear`, `reset` or `tput clear`: when it finishes, every earlier block is dropped, and the clearing block is not kept.
  
  Any other program's erase-display clears only the active block's own screen.
- [ ] **Limits:** at most 10,000 lines across a terminal's blocks; when exceeded, whole blocks are dropped, oldest first. A single block over the limit keeps its last 10,000 lines and starts with a `… N earlier lines dropped` line. At most 2,000 blocks.
- [ ] Output from before shell integration started is kept as the terminal's preamble, not a block. It is sent as block 0 (see Protocol) and drawn above the first block without a header.

### Survival

- [ ] Attaching (S2) returns the block list and the active block's state; an app restart or reconnect shows the same blocks.
- [ ] The live upgrade (S3) carries the block store and the live emulator (its VT-formatted state with modes) to the new daemon.
- [ ] The first live upgrade from a `vt100` daemon restarts terminals once; no migration.
- [ ] Blocks do not survive a daemon restart or reboot: shells are restarted by S4 without history, as today.

### App (Block view)

- [ ] **Setting:** "Block view (beta)", default off. When off, T8's decoration view is used.
- [ ] **List:** finished blocks are drawn as static HTML in a virtual list (only blocks near the viewport are in the DOM). Each shows the T8 header and the bold command, then its output with `white-space: pre-wrap`, so it rewraps with the pane.
- [ ] **Active block:** a live xterm at the end of the list, as tall as its content up to the pane's height. It is reset when a new block starts. Keys go to it while a command runs; the input editor returns at the next prompt.
- [ ] **Sticky header:** the header of the block at the top of the viewport stays pinned while its output scrolls under it.
- [ ] **Collapse:** clicking a header, or a shortcut on the selected block (see Open questions), collapses or expands its output. Collapse state lives in the app only and is not saved. Nothing collapses automatically.
- [ ] **Selection, copy and send to agent** behave as in T8. Text selection across blocks is the browser's own.
- [ ] **Links:** URLs open on click; file paths open with ⌘-click (F3), in finished blocks too.
- [ ] **Search:** ⌘F searches all blocks (finished blocks' text and the active xterm), highlights matches and steps through them across blocks.
- [ ] **ssh:** `ssh host` runs inside one active block with full interactivity. Remote commands are not split into blocks.

## UI

- The list scrolls as one surface; the input editor stays docked at the bottom.
- Collapsed block: header row plus a muted `N lines` count.
- Sticky header: the T8 header on a `bg` background with the separator under it.
- Dropped lines: a muted italic line at the top of the block.

## Protocol and RPCs

`PROTOCOL_VERSION` goes up by one.

- `BlockInfo { id, command, cwd, started_at, ended_at?, exit?, lines, dropped }`, where `lines` is the stored line count and `dropped` the number of lines cut by the limit.
- `terminal.attach` adds `blocks: BlockInfo[]` (finished, oldest first) and `active?: BlockInfo` for Blocks-mode shells. When the terminal has a preamble, it is `blocks[0]` with `id: 0`, an empty command and no timing; its lines come from `terminal.block_lines` like any finished block. The snapshot that follows is the active block's live screen only.
- `terminal.block_lines {id, block, from, count}` returns styled lines for one finished block: `Line = Run[]`, `Run = { t, fg?, bg?, bold?, italic?, underline?, inverse?, dim?, strike? }`, colours as palette indices (`0`–`255`) or `#rrggbb`. The app fetches lines for blocks near the viewport and caches them.
- Events, sent on the same stream as output so their order with output frames is exact:
  - `terminal.block_started {id, block: BlockInfo}`; the app resets the live xterm.
  - `terminal.block_finished {id, block: BlockInfo}`.
  - `terminal.blocks_dropped {id, through}`: blocks up to and including `through` are gone (`clear` or the limit).
- Nothing in the protocol assumes how the app draws, so a future renderer (ADR 0006, option C) needs no protocol change.

## Data and config

- App setting `blockView: boolean` (default `false`).
- Git submodule for Ghostty's source; Zig 0.15.2 on `PATH` for every build.

## Security considerations

- Marks are honoured only with the terminal's secret token, which programs run by the shell do not inherit, so a program printing OSC 133 cannot forge block boundaries. A program that reads the shell's memory could still find the token; that is out of scope.
- Styled lines are rendered as text nodes, never as HTML from the terminal.

## Out of scope

- Option C (libghostty-vt in the app with jaunt's own renderer) and turning a plain `ssh` into blocks: see ADR 0006, "Future direction".
- Per-block output filter (show only matching lines): a later PR.
- Saving blocks to disk across daemon restarts.
- Nested blocks.

## Test plan

- Rust, `jaunt-core`:
  - Scanner: marks split across reads at every byte; marks with a wrong or missing token are ignored, including one built from `$$`; OSC 9 / 777 extraction.
- Integration: `JAUNT_MARK_TOKEN` is not in the environment of a command the shell runs.
  - Ported ADR 0003 round-trip tests on libghostty-vt.
  - Freeze: captured output of a `cargo` progress bar, `printf` with long wrapped lines, vim inside a block, a program printing `CSI 2J` mid-block (only its own block is cleared), `clear` as a command and Ctrl+L at the prompt (both drop earlier blocks); each checked against literal expected lines.
  - Limits: 10,001 lines across blocks drops the oldest whole block; a 12,000-line block keeps its last 10,000 with `dropped = 2000`; the 2,001st block drops the first.
  - Resize reflow of the active block.
- Rust, `jauntd/tests`: attach mid-command returns finished blocks and the active one; a live upgrade keeps them; a nested shell's marks do not open blocks.
- TS (Vitest, `lib/`): lines and runs to DOM spans (colours, bold, inverse); virtual list offsets with collapsed blocks; cross-block search positions.
- e2e (`e2e/specs/`): with Block view on, run `echo one` and `seq 1 20000`, collapse the second block, reload the window and see both blocks; run `clear` and see none.
- Manual: musl remote helper build with libghostty-vt; memory of 20 open shells.

## Delivery

A second `gh stack`, after T8:
1. This spec and ADR 0006.
2. Swap `vt100` for libghostty-vt (submodule, Zig, one thread per emulator, ported tests). No behaviour change.
3. Scanner and block store in the daemon (freeze, `clear`, limits), with tests.
4. Protocol, attach and live upgrade.
5. App Block view behind the setting.
6. Links, search, copy and send to agent on the block list.

## Open questions

- Collapse shortcut for the selected block (proposal ⌥⌘[ / ⌥⌘]).
- Does libghostty-vt 0.2.2 cross-build for musl with `cargo-zigbuild`? Its CI does not cover it; checked in delivery step 2.
- Real memory per emulator (estimate about 2 MiB virtual); measured in step 2.
