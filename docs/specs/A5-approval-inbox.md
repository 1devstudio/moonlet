# A5: Approval inbox

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** A5, journey J3

## Summary

Every blocked or failed agent across all hosts is listed in one place, the top of the ⌘K palette, with the agent's own message (e.g. "Allow Bash(cargo test)?"). Picking one jumps to that pane, where the user answers in the agent's TUI.

## Behaviour and acceptance criteria

- [x] Entries come from live session state, so they disappear as soon as the agent moves on.
- [x] The sidebar footer shows the blocked count, and the dock badge counts unread blocked agents.
- [ ] A dedicated inbox view with approve/deny buttons needs a structured channel (ACP, [A7](../plan.md), P2). The TUI stays the place to answer.
