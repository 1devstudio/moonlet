# T5: Command palette and scrollback search

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** T5

## Behaviour and acceptance criteria

- [x] ⌘K opens a fuzzy palette with commands (with their shortcuts), every workspace across hosts, and every blocked or failed agent (the approval inbox, [A5](A5-approval-inbox.md)). Since [X19](X19-run-action.md) it is the Run action modal: actions come first, then blocked agents, then sessions.
- [x] ⌘F opens find-in-terminal for the focused pane. It searches the whole client scrollback with the xterm search addon, with Enter / ⇧Enter for next/previous and match highlights in the overview ruler.
- [x] `session.search {id, query, regex, case_sensitive}` searches the daemon-side scrollback, for scripts and for sessions not attached.
