# ADR 0003: `vt100` crate for daemon-side terminal state

- **Status:** accepted (2026-10-02)
- **Answers:** spike S3 (replay fidelity)

## Options

- **`alacritty_terminal`:** the most complete emulator, but it has no serializer. We would have to write a grid-to-ANSI encoder ourselves.
- **`vt100` 0.16:** ships `contents_formatted()`, `input_mode_formatted()`, scrollback views and callbacks for bell, title and unknown OSCs.

## Evidence

`crates/jaunt-core/src/term.rs` has round-trip tests. Each test feeds output into the emulator, takes a snapshot, replays the snapshot into a fresh emulator, and compares every cell (text, colours, bold, inverse), the cursor, modes and the scrollback text. They pass for:
- plain shell output with 100 lines of scrollback;
- Ink-style frame redraws as Claude Code produces them (cursor up, erase line, 24-bit colour, inverse cursor cell);
- an alternate-screen TUI with application cursor and keypad modes;
- CJK wide characters, combining marks and emoji.

## Decision

Use `vt100`. The callbacks also give us OSC 7, OSC 133, OSC 9/777 and the bell for agent state, with no second parser.

## Limits

- Scrollback is plain rows, not reflowed on resize.
- When the alternate screen is active at attach time, the hidden main screen is not replayed; it reappears blank after the TUI exits.

Revisit with `alacritty_terminal` or libghostty-vt if either limit hurts.
