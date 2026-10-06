# X19 — Run action modal with custom shortcuts

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** T5 (command palette), A5 (approval inbox)
- **Related ADRs:** none

## Summary

⌘K opens the "Run action" modal: one searchable list of every app action, with its group and its shortcut. From the same list, the user can give any action a keyboard shortcut, or change the one it has. It replaces the T5 palette layout but keeps the palette's other entries (blocked agents and sessions) underneath the actions. A "Run action" row in the sidebar opens it too.

## User journey

1. Press ⌘K, or click **Run action** in the sidebar.
2. Type to filter. Matched letters are highlighted and the header shows "5 of 23".
3. ↑↓ selects, ↵ runs the selected action, Esc closes.
4. To give an action a shortcut, click **Set shortcut** on its row, or press ⌥↵ on the selected row. The row asks "Press keys…".
5. Press a combination with ⌘. It is saved, and a toast says "⌥⌘S now runs Re-run setup script".
6. If another action already uses it, the row says "⌘T is already used by New terminal tab." **Replace** (or ↵) moves the shortcut over; **Try another** records again. Esc cancels.

## Behaviour and acceptance criteria

- [x] The modal lists the 23 app actions (label, group, shortcut), then blocked or failed agents, then "Go to <session>" entries.
- [x] Filtering keeps rows whose label contains the query, or contains its letters in order. A contiguous match ranks above a scattered one, and an earlier match above a later one. The matched letters are highlighted.
- [x] The header shows "23 actions" with an empty query, and "N of 23" while filtering. With no match it shows "No actions match “q”".
- [x] Footer: ↑↓ select, ↵ run, ⌥↵ set or change shortcut, esc close (or cancel while recording).
- [x] Recording ignores bare modifier presses and requires ⌘, so a custom shortcut never reaches the terminal.
- [x] Recording refuses reserved keys with "⌘C is reserved for Copy.": editing keys (⌘C, ⌘V, ⌘X, ⌘A, ⌘Z, ⇧⌘Z), ⌘K, ⌘Q, ⌘H, ⌘M, and the app's fixed shortcuts (⌘B, ⌘\\, ⌘1–⌘9, ⌘↵, ⇧⌘↵, ⌥⌘C, ⌥⌘←/→, ⇧⌘[ and ⇧⌘]).
- [x] A key used by another action asks before replacing. Replacing leaves the other action with no shortcut.
- [x] Custom shortcuts are saved with the app settings and work at once, everywhere the default shortcuts work.
- [x] A **Run action ⌘K** row in the sidebar opens the modal.

## UI

Follows the "Run Action" design: 560 px panel 14 vh from the top, search icon and input with a count on the right, rows 32 px tall with the label, group in faint text, and a shortcut chip or a **Set shortcut** link on the right. The recording row has a dashed accent chip and a hint line under it. The conflict row shows the pending keys and **Try another** / **Replace** buttons.

## Protocol and RPCs

None.

## Data and config

`settings.shortcuts` in local storage (`jaunt.settings`): action id → key id (for example `"setup": "alt+cmd+s"`). An empty string means the action has no shortcut. Actions not in the map keep their default.

## Security considerations

None: the keys only choose among built-in actions.

## Out of scope

- Shortcuts for the fixed keys (pane focus, tab switching, sidebar toggles) and for sessions or agents in the list.
- Resetting all shortcuts to defaults.

## Test plan

- `lib/runActions.test.ts`: matching and ranking, highlight parts, key labels, recording outcomes (modifier only, no ⌘, reserved, conflict, free), assigning with and without replace, effective bindings.
- `e2e/specs/run-action.e2e.ts`: open with ⌘K, filter, set a shortcut, then trigger the action with it.

## Open questions

- None.
