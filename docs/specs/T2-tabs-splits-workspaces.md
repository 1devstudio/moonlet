# T2: Tabs, splits and keyboard-first workspaces

- **Status:** implemented
- **Priority / phase:** P0 · phase 1
- **PRD refs:** T2; UI direction (plan section 2)

## Summary

Each workspace has tabs, and each tab holds a tree of split panes (`src/lib/layout.ts`). The layout is stored on the workspace in the daemon (`workspace.update {layout}`), so it survives app restarts and follows the workspace.

## Behaviour and acceptance criteria

- [x] Layout is reconciled with live sessions: a session nobody shows gets a background tab without stealing focus, and a pane whose session is gone is removed.
- [x] Split right (⌘D) and down (⌥⌘D) split the focused pane; splitters resize. Closing the last pane of a split collapses it.
- [x] Shortcuts all use ⌘. xterm ignores every ⌘ combination, so app shortcuts can never be typed into an agent; that replaces the PRD's "prefix key".
  - Tabs and panes: ⌘T new agent tab, ⇧⌘T new terminal tab ([X38](X38-new-agent-tab-context.md)), ⌘W close pane (asks before stopping a running agent), ⌥⌘←/→ focus pane, ⇧⌘[ / ⇧⌘] switch tab.
  - Navigation: ⌘1–9 workspace, ⌘B sidebar, ⌘\ review panel, ⌘K palette.
- [x] Only the active tab's panes mount terminals.
- [x] An exited pane shows its exit code with Restart and Close.

## Test plan

`src/lib/layout.test.ts` covers reconcile, split/collapse, focus cycling and validation of stored layouts.
