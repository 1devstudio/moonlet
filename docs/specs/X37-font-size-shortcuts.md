# X37 — ⌘+, ⌘− and ⌘0 change the window's font size

- **Status:** implemented (2026-10-12). Unit tests pass. The keys are not checked in the running app yet.
- **Priority / phase:** P2 · phase 3
- **PRD refs:** keyboard-first workspaces
- **Related:** [T2](T2-tabs-splits-workspaces.md) (shortcuts), [X4](X4-visual-design.md) (one text scale for the window)

## Summary

The window has one font size: **Settings › Terminal › Size** sets the terminals' size, and every other text in the app scales with it. Changing it meant opening Settings. ⌘+ and ⌘− now make it one pixel bigger or smaller from anywhere in the window, and ⌘0 puts it back to the default, the way they zoom in a browser or an editor.

## User journey

1. The user presses ⌘+ (or ⌘=, the same key without ⇧). Terminals, the agent view, the sidebar and the editors grow by one step.
2. ⌘− makes them smaller again, and ⌘0 goes back to the default 13px.
3. The size is saved like any other setting and shows in **Settings › Terminal › Size**.

## Behaviour and acceptance criteria

- [x] ⌘= and ⌘+ (with or without ⇧, and the keypad +) raise the font size by 1px.
- [x] ⌘− lowers it by 1px.
- [x] ⌘0 sets it back to the default 13px.
- [x] The size stays between 9px and 24px, the range the Settings field allows. A key past either end changes nothing.
- [x] The shortcuts work while a terminal, the chat input or an editor has focus, and do nothing while a dialog or the confirm modal is open, like the other fixed shortcuts.
- [x] A Run action cannot take ⌘=, ⌘+, ⌘− or ⌘0: recording one reports it as reserved.

## UI

No new UI. The new size applies at once, through the same setting as the Settings field.

## Protocol and RPCs

None. The shortcuts change an app setting; the daemon is not involved.

## Data and config

`settings.term.fontSize` in the app's saved settings, as before.

## Security considerations

None. The keys only change a number kept within 9px to 24px.

## Out of scope

- A menu bar item for the shortcuts.

## Test plan

- `apps/desktop/src/lib/keys.test.ts`: the keys change the size, ⌘0 resets it, the size stops at 9px and 24px, the keys work from a terminal, the chat input and an editor, and they are off while a dialog or the confirm modal is open.
- `apps/desktop/src/lib/runActions.test.ts`: recording the keys for an action is refused.

## Open questions

- Layouts where 0, = or − need a modifier (AZERTY types 0 with ⇧, so ⌘0 arrives as `shift+cmd+0`) do not get ⌘0. Bind by physical key if users ask.
