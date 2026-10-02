# T5: Command palette and scrollback search

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** T5

## Behaviour and acceptance criteria

- [x] ⌘K opens a fuzzy palette with commands (with their shortcuts), every workspace across hosts, and every blocked or failed agent first (the approval inbox, [A5](A5-approval-inbox.md)).
- [x] ⌘F opens find-in-terminal for the focused pane. It searches the whole client scrollback with the xterm search addon, with Enter / ⇧Enter for next/previous and match highlights in the overview ruler.
- [x] `session.search {id, query, regex, case_sensitive}` searches the daemon-side scrollback, for scripts and for sessions not attached.
