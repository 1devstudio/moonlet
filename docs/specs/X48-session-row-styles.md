# X48 — Session row styles

- **Status:** implemented
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X46 (tasks in sessions), X5 (sidebar)
- **Related ADRs:** ADR 0010

## Summary

A session linked to a task needs to show the task in the Sessions sidebar without making every row taller. Settings › Appearance offers two one-line styles for session rows, each shown as a small preview: **A · Issue number column**, a narrow column with the issue number, and **B · Task as a sub-header**, sessions grouped under a quiet line for their task. A replaces X46's two-line row.

## User journey

1. The user opens Settings › Appearance. Under **Session rows** two cards show the same sessions drawn in each style; A is chosen on a new install.
2. They pick B. The sidebar at once groups each project's sessions under their tasks' lines.
3. They pick A again. Every row is one line, with the issue number between the glyph and the name.

## Behaviour and acceptance criteria

- [x] Settings › Appearance has **Session rows** with two radio cards, `A · Issue number column` and `B · Task as a sub-header`, each with a preview of rows in that style. The choice is saved with the app's settings and applies at once; a new install starts on A. (`sessionRows.test.ts` rowStyle, `settingsSearch.test.ts` finds the session row style, `tasks-mode.e2e.ts` A · and B ·)
- [x] **A:** a session row is one 38px line: the state or branch glyph, the issue number, the name and the badge. The number is the key's part after its prefix (`MOON-142` → `142`, `acme/web#12` → `12`; a GitHub key's prefix is its repository), orange when the task is out of sync, blank when the session has no task. Hovering the row shows the key, state and title. (`sessionRows.test.ts` splitKey, numberColumn, `tasks-mode.e2e.ts` A · shows a linked session's issue number)
- [x] **A:** when every linked session under a project heading shares one prefix, the heading shows it (`MOON-`, or `#` for one GitHub repository) and the column shows only numbers; when they do not, or there is no project heading (no grouping, or grouped by status or task), the column shows whole keys. The column is as wide as its longest entry, and at least three characters, so names line up. (`sessionRows.test.ts` numberColumn)
- [x] **B:** under a project heading (or with no grouping, or grouped by status), sessions sit under a 24px line for their task: its glyph, key and title, the key orange and `· out of sync` added when it is out of sync. Tasks come in the order of their most recent session; sessions without a task come last under `No task`, with a dashed glyph. Session rows are 34px and indented, with a guide line down from the task's glyph. (`sessionRows.test.ts` taskGroups, `tasks-mode.e2e.ts` B · puts the sessions under a line for their task)
- [x] **B:** a section grouped by task (X46) shows no extra task lines, since its groups already are tasks. (`sessionRows.test.ts` taskGroups)
- [x] In a workspace with no task source, A shows no number column and B no task lines. (`sessionRows.test.ts` numberColumn has no column, taskGroups without a task source)
- [x] A session without a task shows no `No task` text; linking it stays in its right-click menu (**Link to task…**, X46). (`tasks-mode.e2e.ts` offers Link to task… in a session's right-click menu)

## UI

Settings › Appearance › Session rows: two cards side by side like New shells (X43). Each card has its title, a one-line description and a preview panel: a project heading and three or four rows drawn by the same component the sidebar uses, with sample sessions.

## Protocol and RPCs

None.

## Data and config

- `sessionRows: "number" | "task"` in the app's settings (localStorage `moonlet.settings`); missing means `"number"`.

## Security considerations

None: the setting only changes how the app draws data it already has.

## Out of scope

- The two-line row of X46 as a third choice (the user chose A and B only).
- Per-workspace or per-section row styles.

## Test plan

- Vitest: `sessionRows.test.ts` (key splitting, the number column, task groups, the saved style), `settingsSearch.test.ts`.
- e2e: `tasks-mode.e2e.ts` switches the style in Settings and checks the sidebar.

## Open questions

- None.
