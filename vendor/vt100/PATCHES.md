# moonlet's patch of vt100 0.16.2

Unchanged crates.io source of `vt100` 0.16.2 (MIT, see `LICENSE`), used
through `[patch.crates-io]` in the workspace `Cargo.toml`, with these changes,
marked `moonlet patch` in `src/grid.rs` and `src/screen.rs`:

- `Screen::scrolled_rows()`: how many rows of the primary screen were ever
  pushed into its scrollback. The scrollback stops growing at its limit, so
  without this count a row's position cannot be followed once it is full.
  A full reset (`ESC c`) keeps counting, as if the cleared screen had
  scrolled away.
- `Screen::scrollback_rows()`: how many rows the scrollback holds now.
- `Grid::set_size()`, as xterm resizes: a shorter screen keeps the cursor's
  row and the rows above it, and the top rows go to the scrollback; a taller
  one takes rows back from the scrollback. Upstream cuts the rows below, so
  a client attaching with fewer rows (a smaller new window) lost the newest
  output and the prompt, and adds empty rows below, so a taller one showed
  the history above a blank screen. The row count follows rows both ways.

The daemon uses them to put the shell's prompt marks back on the right rows
of a snapshot (spec S2). The patch goes away with `vt100` when spec T9 moves
the daemon to libghostty-vt.
