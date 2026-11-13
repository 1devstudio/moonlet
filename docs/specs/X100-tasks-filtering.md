# X100 — Filters and display options behind icons

- **Status:** implemented (2026-11-12)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X45 (Tasks mode), X50 (boards), X93 (search the board)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)
- **Design:** docs/design/tasks-filtering/

## Summary

The board header holds too much: Assignee, Columns, Hide empty Done, Expand all and Board | List sit beside the board switcher and Find a task. This feature leaves the header with four things: the board switcher, Find a task (shown by default), a **Filter** icon and a **Display options** icon. Refresh stays too. Filter opens a menu that adds a filter by State, Assignee, Priority, Type, Labels, Sessions, Pull request or Cycle. Each filter applied is a chip in a row under the header, with `<field> <is> <value>` and ×, a count of the tasks left and Clear. Display options is a popover with Board | List, the ordering, the columns, the board's options and the card's properties. The Assignee pick of X50 (me / anyone) becomes the Assignee filter's **Me**.

## User journey

1. On the board `Storefront`, the header shows the board switcher, the field "Find a task: key, title, session or branch" with `⌘F`, and the Filter and Display options icons. No filter row shows.
2. The user presses `F` (or clicks Filter). A menu opens with "Add filter…" and the fields State, Assignee, Priority, Type, Labels, then Sessions, Pull request and Cycle.
3. The user points at State. A panel lists the board's columns, Backlog 6, Todo 3, In Progress 3, In Review 2, Done 14, each with its glyph and count. The user clicks Done: it is checked, and a row under the header shows the chip `State is Done`, "14 of 28 tasks" and Clear.
4. The user clicks the chip's `is`: it reads `is not`, and the board shows every task but the Done ones.
5. The user adds Priority › High and Priority › Medium: the chip reads `Priority is any of High, Medium`. The Filter icon shows 2.
6. The user presses `V`. Display options opens: List | Board, Ordering, Columns `4 shown · 2 folded`, Show empty columns, Hide empty Done, Show sessions on cards, and the card's properties as pills. The user picks Ordering › Priority: each column puts its High tasks first.
7. The user clicks Clear: the chips go, and the board shows every task again.

## Behaviour and acceptance criteria

### The header

- [x] The board header shows the board switcher, Find a task (X93, unchanged, centred, at most 520 px wide), then the Filter icon button, the Display options icon button and Refresh tasks. Assignee, Columns, Hide empty Done, Board | List and Expand all are no longer in the header. (`index.html` m42, m52, m57, m60, m62) (`tasks-mode.e2e.ts` filters the board from the Filter menu (F): a chip per filter, is and is not, ×, and Clear; Assignee is Me is the board's pick (X100); seen in the app with `e2e/snap.ts` at 1440 × 900)
- [x] The Filter button is titled "Filter  F" and labelled "Filter" or "Filter, `<n>` applied"; with filters applied it shows their number in an accent badge. (`index.html` m57, m59) (`tasks-mode.e2e.ts` filters the board from the Filter menu (F): a chip per filter, is and is not, ×, and Clear; Assignee is Me is the board's pick (X100))
- [x] In the List layout, Expand all / Collapse all moves into the header beside the icons, as an icon. (`tasks-mode.e2e.ts` shows the same tasks as a list whose rows open into their sessions, and unfolds and folds a column)
- [x] `F` opens the Filter menu and `V` Display options, when no text field has the focus and no dialog is open; the keys do nothing with ⌘, ⌃ or ⌥ held. Esc closes either. A panel open for one board closes when another board is shown. (`taskFilters.test.ts` opens Filter on F and Display options on V, but not while typing, in a dialog, or with a modifier; `tasks-mode.e2e.ts` filters the board from the Filter menu (F): a chip per filter, is and is not, ×, and Clear; Assignee is Me is the board's pick (X100); `tasks-mode.e2e.ts` opens Display options (V) with Board | List and the columns, and turns Show sessions on cards off and on (X100))

### The Filter menu

- [x] The Filter menu has a search field "Add filter…" with `F`, then the fields, each with its icon and a chevron: State, Assignee, Priority, Type, Labels, a divider, Sessions, Pull request, Cycle. (`filter-menu.html` m64–m138) (`taskFilters.test.ts` lists the fields in the menu's order, leaving out those no task has a value for; seen with `e2e/snap.ts`)
- [x] A field none of the board's tasks has a value for is left out: Type without an issue type (Jira's), Labels without a label, Cycle without a Linear cycle, Priority when no task has one. State, Assignee, Sessions and Pull request are always offered. (`taskFilters.test.ts` lists the fields in the menu's order, leaving out those no task has a value for)
- [x] Pointing at a field, clicking it, or → or ↵ on it opens its values in a panel beside the menu, with a "Filter…" field. Opened by → or ↵, the panel takes the focus; opened by pointing, the focus stays in "Add filter…". ← (with nothing typed) or Esc goes back to the fields. (`filter-menu.html` m75) (`taskFilters.test.ts` moves through the fields with ↑ and ↓, wrapping, and opens a field's values with → or ↵; `taskFilters.test.ts` in a field's values: ↑ ↓ move, ↵ picks, ← with nothing typed or Esc goes back to the fields; `tasks-mode.e2e.ts` filters the board from the Filter menu (F): a chip per filter, is and is not, ×, and Clear; Assignee is Me is the board's pick (X100))
- [x] Each value shows its glyph, its name and how many of the board's tasks have it, and a check when it is in the field's filter. Clicking a value (or ↵) adds it to the filter or takes it out; the panel stays open. (`filter-menu.html` m77–m97) (`taskFilters.test.ts` lists each field's values with how many tasks have them; `tasks-mode.e2e.ts` filters the board from the Filter menu (F): a chip per filter, is and is not, ×, and Clear; Assignee is Me is the board's pick (X100); the panel open with the check after a click, seen with `e2e/snap.ts`)
- [x] The values are:
  - **State:** the board's shown and folded columns, in the board's order, with their category glyphs.
  - **Assignee:** Me, then everyone a task is assigned to (most tasks first, then by name), then No assignee.
  - **Priority:** High, Medium, Low, No priority, as the card's bars show.
  - **Type:** each issue type, by name.
  - **Labels:** each label, by name.
  - **Sessions:** Needs you (a session waits on the user), With a session, No session.
  - **Pull request:** Open, Draft, Merged, Closed (the PRs of the card's sessions), No pull request.
  - **Cycle:** `Cycle <n>` from the newest, then No cycle.

  Values no task has are left out, except State's columns and Assignee's Me. (`taskFilters.test.ts` lists each field's values with how many tasks have them; `taskFilters.test.ts` keeps a column with no task, and Me with none of the user's)
- [x] Typing in "Add filter…" lists the fields whose name has the text, then the values that have it, each as `<field> › <value>`; ↑ ↓ move, ↵ picks. A value picked from there is added as from its panel. (`taskFilters.test.ts` lists the fields whose name has the text, then the values that have it, ignoring case; `taskFilters.test.ts` picks a value found by Add filter… with ↵, and → does nothing on it)
- [x] Typing in "Filter…" lists the field's values that have the text. (`taskFilters.test.ts` lists a field's values that have the text)

### Applied filters

- [x] A filter is a field, its values and whether it keeps or leaves out the tasks that have one of them. A task stays on the board when it passes every filter. A task with several values of a field (labels, assignees, sessions' PRs) passes `is` when one of them is picked, and `is not` when none is. (`taskFilters.test.ts` keeps the tasks in a picked state, or leaves them out with is not; `taskFilters.test.ts` keeps by assignee: Me is the user's own tasks and those with a session of theirs; No assignee those with none; `taskFilters.test.ts` keeps by priority, type, label and cycle; a task with several labels passes is when one is picked, is not when none is; `taskFilters.test.ts` keeps by sessions and by the state of the sessions' pull requests)
- [x] With at least one filter, a row under the header shows a chip per filter, in the order they were added (Assignee is Me, while the board is at me, first), a `+` that opens the Filter menu, "`<shown>` of `<total>` tasks" and Clear. With none, the row is not there. (`index.html` m185–m204, `no-filters.html`) (`taskFilters.test.ts` adds a value as a new filter at the end, or to its field's filter; taking out the last value removes the filter; `taskFilters.test.ts` shows a board at me as the chip Assignee is Me, first; at anyone, the saved filters as they are; `tasks-mode.e2e.ts` filters the board from the Filter menu (F): a chip per filter, is and is not, ×, and Clear; Assignee is Me is the board's pick (X100); seen with `e2e/snap.ts`)
- [x] A chip reads `<field> <op> <value>` with ×:
  - op is `is` / `is not` for one value, `is any of` / `is none of` for several;
  - value is the value for one, with its glyph for State and Priority; `A, B` for two; `<n> <plural>` for more (`3 states`, `4 assignees`, `3 labels`).

  (`index.html` m186, m194) (`taskFilters.test.ts` reads is or is not for one value, is any of or is none of for several, and counts more than two)
- [x] Clicking the op switches between keeping and leaving out. Clicking the field or the value opens that field's values under the chip. × removes the filter; a filter whose last value is taken out goes too. (`taskFilters.test.ts` flips between is and is not, and removes a filter; `taskFilters.test.ts` adds a value as a new filter at the end, or to its field's filter; taking out the last value removes the filter; `tasks-mode.e2e.ts` filters the board from the Filter menu (F): a chip per filter, is and is not, ×, and Clear; Assignee is Me is the board's pick (X100))
- [x] `<total>` counts the tasks the board draws in its shown and folded columns with the display options applied, `<shown>` those left by the filters too. (`taskFilters.test.ts` counts the tasks the filters leave of the board's)
- [x] Clear removes every filter, Assignee's Me too. (`tasks-mode.e2e.ts` filters the board from the Filter menu (F): a chip per filter, is and is not, ×, and Clear; Assignee is Me is the board's pick (X100))
- [x] Filters apply to the Board and the List alike. A task they leave out is still found by Find a task under Not on this board, saying the filters leave it out (X93). (`tasks-mode.e2e.ts` filters the board from the Filter menu (F): a chip per filter, is and is not, ×, and Clear; Assignee is Me is the board's pick (X100))
- [x] Each board keeps its own filters, across restarts, in the app (not in `trackers.toml`); saved filters it can't read are dropped. A removed board's filters are forgotten. (`tasksStore.test.ts` keeps each board's filters and the Display options across restarts; `tasksStore.test.ts` forgets a removed board's filters; `tasksStore.test.ts` drops saved filters it can't read, keeping the rest)
- [x] A value the board no longer has (a column renamed, a label gone) stays in the filter and keeps nothing. (`taskFilters.test.ts` stays in the filter and keeps nothing)

### Assignee: Me

- [x] X50's Assignee pick is the Assignee filter's Me: a board at **me** shows the chip `Assignee is Me`, which keeps the user's own tasks and those the user has a session on, and fetches only the user's issues, as before. (`taskFilters.test.ts` shows a board at me as the chip Assignee is Me, first; at anyone, the saved filters as they are; `tasksStore.test.ts` shows a board at Assignee: me as the chip Assignee is Me; removing it fetches everyone's issues, picking Me alone fetches the user's again)
- [x] Removing that chip, Clear, `is not`, or any other assignee picked with or instead of Me sets the board to **anyone**: everyone's issues are fetched (X50) and the filter keeps those of the people picked. Picking Me alone again sets it back to me. Others' issues stay dimmed under anyone (X50). (`taskFilters.test.ts` saves Me alone as the pick at me, and anything else as anyone with the filter kept; `tasksStore.test.ts` shows a board at Assignee: me as the chip Assignee is Me; removing it fetches everyone's issues, picking Me alone fetches the user's again; `task-trackers.e2e.ts` shows everyone's open issues once the board's Assignee is anyone, others' dimmed (X50))

### Display options

- [x] Display options is a popover under its icon: Board | List; Ordering; Columns; then "Board options" with Show empty columns, Hide empty Done and Show sessions on cards; then "Card properties" as pills; then Reset to default. (`display.html` m139–m184) (`tasks-mode.e2e.ts` opens Display options (V) with Board | List and the columns, and turns Show sessions on cards off and on (X100); seen with `e2e/snap.ts`)
- [x] **Board | List** switches the layout, as the header's switch did (X45). (`tasks-mode.e2e.ts` shows the same tasks as a list whose rows open into their sessions, and unfolds and folds a column)
- [x] **Ordering** is Board order (the tracker's, the default), Priority (highest first) or Updated (newest first), within each column and List group; ties keep the board's order. (`taskFilters.test.ts` orders each column by the board, by priority highest first, or by update newest first, ties in the board's order)
- [x] **Columns** reads `<n> shown`, then `· <n> folded` when a column is folded, as X50's header did, and opens the menu that shows, folds or hides each column, saved to the board (X50). (`tasks-mode.e2e.ts` opens Display options (V) with Board | List and the columns, and turns Show sessions on cards off and on (X100))
- [x] **Show empty columns**, on by default: off, a column with no card left (after filters and Hide empty Done) is not drawn, folded or not, nor its List group. (`taskFilters.test.ts` leaves out columns with no card when Show empty columns is off, folded ones too)
- [x] **Hide empty Done** works as before (X45). (`tasks-mode.e2e.ts` counts done tasks left to clean up on the folded Closed column, and filters the board)
- [x] **Show sessions on cards**, on by default: off, a board card shows no session rows, no archived sessions and no "No sessions" line with its Start; its note and out-of-sync chip stay. The List is unchanged. (`tasks-mode.e2e.ts` opens Display options (V) with Board | List and the columns, and turns Show sessions on cards off and on (X100))
- [x] **Card properties** are the board's Cards show fields (X50), named as Board settings names them; a pill turned on or off saves the board's `cards`. (`tasksStore.test.ts` saves the card properties to the board, and Reset to default puts back the layout, the options and the tracker's card fields; the pills seen with `e2e/snap.ts`)
- [x] Ordering and the three switches are kept across restarts, for every board. **Reset to default** sets Board, Board order, the switches to their defaults and the card properties to the tracker's. (`taskFilters.test.ts` starts with the board's order, empty columns shown and sessions on cards; `tasksStore.test.ts` keeps each board's filters and the Display options across restarts; `tasksStore.test.ts` saves the card properties to the board, and Reset to default puts back the layout, the options and the tracker's card fields)

### Not chosen from the design

- The sidebar's "Find a task" (`index.html` m17) is the design system's old sidebar: Find a task stays in the header (X93).
- The Filter menu's **Dates** (m134): moonlet keeps no created date; it waits for date pickers.
- Ordering's **Created** (m152): no created date.
- Card properties' **Key**, **Priority**, **Cycle**, **Updated** pills (m175, m177, m181, m182): the key and priority always show; the rest are not card fields yet.

## UI

See the design's pages: `index.html` (filters applied), `no-filters.html`, `filter-menu.html` and `display.html`, at 1440 × 900.

## Protocol and RPCs

None.

## Data and config

- `tasks.boardFilters` in the app's storage: filters per board id, `[{ field, values, not }]`, Assignee's Me not among them (it is X50's pick, `tasks.assignee`).
- `tasks.display`: `{ ordering, showEmpty, sessions }`. Hide empty Done stays in `tasks.filters`, Board | List in `tasks.layout`.
- Card properties write the board's `cards` in `trackers.toml`, as Board settings does.

## Security considerations

None: filters run over tasks already loaded.

## Out of scope

- Filters across boards, saved views, and AND/OR between filters.
- Dates, and ordering by creation.

## Test plan

- `lib/taskFilters.test.ts`: fields and values with counts, matching, chips, Assignee's Me, ordering, empty columns, keys, menu search.
- `lib/tasksStore.test.ts`: per-board filters kept and forgotten, Assignee's Me fetching, display options kept, card properties saved.
- `tasks-mode.e2e.ts`: the header, adding, flipping and removing a filter, Clear, Display options' layout and columns.
- Screenshots of the built screens at 1440 × 900.

## Open questions

- None.
