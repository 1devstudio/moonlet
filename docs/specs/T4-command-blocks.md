# T4: Command blocks

- **Status:** implemented (decorations; see out of scope)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** T4; PRD open question "per-block grid rendering vs decorations"

## Summary

With shell integration ([T3](T3-shell-integration.md)), each command is a block: prompt, command and output. Blocks show as a gutter mark, red when the exit code is non-zero, and power block actions.

## Behaviour and acceptance criteria

- [x] OSC 133 marks register xterm markers; the client keeps the last 2,000 blocks per pane.
- [x] ⌘↑ / ⌘↓ jump to the previous or next prompt.
- [x] ⇧⌘C copies the output of the last finished command.
- [x] The palette's "Re-run last command" retypes the last command line and presses Enter.
- [x] Decorations colour the gutter and the overview ruler by exit status.

## Out of scope

Collapsing a block's output. xterm.js has no per-block grid. The PRD's open question is answered "decorations are enough for v1"; revisit with a libghostty client.
