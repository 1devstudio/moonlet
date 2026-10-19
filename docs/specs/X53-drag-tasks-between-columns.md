# X53 — Drag tasks between columns

- **Status:** implemented (2026-10-19)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X50 (boards), X45 (Tasks mode), X44 (task trackers)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)

## Summary

A card on a board can be dragged onto another column, and the move changes the issue's state in the tracker. X45 and X50 left drag and drop out; until now a task moved only from the detail's State menu. A drop moves the issue the way that menu does: to the first status of the column it lands on. The card shows in its new column at once and goes back if the tracker refuses the move.

## User journey

1. On a board, the user drags the card of `OPS-12` from **In Progress** onto **QA**.
2. While the card is over QA, the column is outlined.
3. On drop, the card shows in QA. moonlet sets the issue's status in Jira to QA's first status and records "moonlet moved it to QA" in its Activity.
4. If Jira refuses (no transition leads there), the card goes back to In Progress, the error shows as a toast and on the task with Retry (X46).

## Behaviour and acceptance criteria

### Where a card can go

- [x] A card can be dragged onto any column the board draws: a shown column or a folded strip. A hidden column is not drawn, so it is no target. The column that holds the card, and a column with no statuses, take no drop. (`boardScreen.test.ts` moves to the first status of a shown or folded column, and not onto the card's own column; takes no drop on a hidden column, a column with no statuses, or a column the board lacks; `tasks-mode.e2e.ts` closes an issue dragged onto the folded Closed strip (X53))
- [x] A drop moves the issue to the column's first status, as the State menu does (X50): a tracker issue's status, a GitHub Project item's Status option (No Status clears it), and on a GitHub repository's board, Closed closes the issue as completed and Open reopens it. (`boardScreen.test.ts` moves to the first status of a shown or folded column, and not onto the card's own column; closes a GitHub repository's issue as completed on Closed, and reopens it on Open; `tasksStore.test.ts` shows a moved item in its new column at once, No Status too (X53); shows it in Closed at once while gh closes it; `tasks-mode.e2e.ts` closes an issue dragged onto the folded Closed strip (X53))
- [x] A GitHub Project item's card cannot be dragged while gh lacks the `project` scope, as its State menu is locked then (X50). (`tasks-mode.e2e.ts` adds a board of a GitHub Project, after gh gets its read:project scope and next to the workspace's repositories, with No Status and the Project's Status as columns and its estimate on cards, moves an item by its Status (X50), and creates one from a column's + (X52))
- [x] The column under a dragged card that would take it is outlined in the accent colour (a folded strip, by its border); a column that would not take it is not. (Seen in the app, a shown column and a folded strip, in screenshots with `e2e/snap.ts`. Which columns take it: `boardScreen.test.ts` moves to the first status of a shown or folded column, and not onto the card's own column; takes no drop on a hidden column, a column with no statuses, or a column the board lacks)

### The move

- [x] The card shows in the column it was dropped on at once, before the tracker answers, and stays there through a sync that lands while the move is under way. This holds for a move from the State menu too. (`tasksStore.test.ts` shows a moved card in its new column at once, through a sync that lands meanwhile, back where it was when the tracker refuses, and placed by the tracker once done (X53); keeps a done move's card in its new column until a sync reads that task: not one that kept the board's last tasks, nor another workspace's (X53); shows a moved item in its new column at once, No Status too (X53); shows it in Closed at once while gh closes it)
- [x] Once the move is done, the next sync that reads the task places the card. A sync that kept the board's last tasks (its connection needs attention) or another workspace's sync leaves the move shown. (`tasksStore.test.ts` shows a moved card in its new column at once, through a sync that lands meanwhile, back where it was when the tracker refuses, and placed by the tracker once done (X53); keeps a done move's card in its new column until a sync reads that task: not one that kept the board's last tasks, nor another workspace's (X53))
- [x] A move the tracker refuses puts the card back where it was, with the tracker's message as a toast and on the task with Retry (X46). (`tasksStore.test.ts` shows a moved card in its new column at once, through a sync that lands meanwhile, back where it was when the tracker refuses, and placed by the tracker once done (X53); keeps the error until a retry works)
- [x] A drop records the move in the task's Activity, as the State menu does: "moonlet moved it to `<column>`", "moonlet closed it", "moonlet reopened it". The move is not reported as a change made outside moonlet (X44). (`tasksStore.test.ts` shows it in Closed at once while gh closes it; moves a task to the first status of its board's column of that category; reopens a closed GitHub issue through gh; is not announced when moonlet closed it, even if a sync from before the close lands first)

## UI

- The card is the drag source (`draggable`); its buttons still click. A link or image dragged out of a card is not a card move.
- A drop target gets an accent outline while a card is over it; a folded strip, an accent border.
- No drag handle: the whole card drags.

## Protocol and RPCs

None new. A drop uses the State menu's moves: the `tracker_update` Tauri command, `gh.project_move` and `gh.task_update`.

## Data and config

Nothing saved. A move under way is kept in memory only, until it is refused or a sync reads the task after it is done.

## Security considerations

None new: a drop sends the same requests as the State menu.

## Out of scope

- Reordering cards within a column (rank), and dropping between two cards.
- Dragging from the List layout.
- Moving several cards at once.
- A keyboard way to drag: the State menu stays the keyboard's way to move a task.
- WIP limits refusing a drop: Jira shows a full column but lets issues in, and so does moonlet.

## Test plan

- Vitest: which columns take a drop and the status a drop sends (`boardScreen.test.ts`); the card placed in its new column at once, kept through a sync, put back on a refusal (`tasksStore.test.ts`).
- e2e: drag a card of a GitHub repository's board onto its folded Closed strip; the fake gh closes the issue (`tasks-mode.e2e.ts`).

## Open questions

None.
