# X28 — Changed files as a tree or a list

- **Status:** implemented (2026-10-08)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** D1 (Changes panel), journey J4
- **Related ADRs:** —

## Summary

The Changes tab grouped the changed files under one header per folder, each header the folder's full path. On a branch that touches a deep folder structure that repeats the same long path many times and hides how the files relate. X28 replaces the grouping with two views of the same files: a **tree** that nests folders and folds single-folder chains into one row, and a flat **list** that shows each file's full path with the folder dimmed. A toolbar button switches between them and the choice is remembered. The rows are restyled at the same time: coloured status boxes and counts, a header with the file count and the totals.

## User journey

1. The user opens the Changes tab. A header reads `53 files changed` with `+7228 −97` on the right.
2. Below it is the tree. `core / services / console` is one row, because `core` and `services` hold nothing else. Folders come before files, each level indented under a faint guide line.
3. They click `deploy` to collapse it, then click it again.
4. They press the list button in the toolbar. Every file is now one row, `core/services/console/src/` dimmed and `app.ts` bright. On a narrow panel the folder is cut short with `…` and the name stays whole.
5. They restart the app. The Changes tab opens on the list.

## Behaviour and acceptance criteria

- [x] The tree nests changed files by folder, folders before files and each sorted by name. A folder whose only child is a folder shares its row, named `a / b / c`. (`changeTree` in `changes.test.ts`)
- [x] The list shows the changed files in path order, each as its folder (`a/b/`, empty at the root) and its name. (`changeList` in `changes.test.ts`)
- [x] A tree folder collapses and expands on click. (`file-explorer.e2e.ts`)
- [x] The toolbar button switches between tree and list; the tree is the default and the choice persists across restarts. (`file-explorer.e2e.ts`)
- [x] The header reads `N files changed` with the `+a −d` totals; the "base not found" warning stays. (`file-explorer.e2e.ts`)
- [x] Each row shows its `+a −d` counts in green and red and a status box: green for added or untracked, red for deleted or conflicted, yellow otherwise. Hovering a row shows stage, unstage and discard in their place.
- [x] A changed-file row takes keyboard focus; Enter or Space opens its diff, and focus shows the row's actions like hover does. (`file-explorer.e2e.ts`)

## UI

Tree:

```
53 files changed                            +7228 −97
⌄ 🗁 core / services / console
│  ⌄ 🗁 src
│  │  ⌄ 🗁 deploy
│  │  │   route.platform.test.ts               +2 ⊡
│  │   app.ts                                 +13 ⊡
│   package.json                               +1 ⊡
```

List:

```
53 files changed                            +7228 −97
core/services/console/package.json             +1 ⊡
core/services/console/src/app.ts              +13 ⊡
core/services/console/src/sour… merge.ts     +192 ⊞
```

## Protocol and RPCs

None.

## Data and config

`changesView` (`"tree"` or `"list"`) joins the persisted UI state in the webview's local storage (`moonlet.ui`).

## Out of scope

- Comment counts per file. Comments go to the agent as prompts and are not stored.
- A menu behind a chevron on hover; the row keeps its stage, unstage and discard buttons.

## Test plan

- Vitest: `changes.test.ts` (`changeTree`, `changeList`, `changeCount`).
- e2e: `file-explorer.e2e.ts` drives the tree, the list toggle and the header against a scratch repo.
