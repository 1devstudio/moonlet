# X23: In-app confirm modal

- **Status:** implemented
- **Priority / phase:** P1 · phase 3 (extends [X4](X4-visual-design.md))
- **PRD refs:** none (user request, 2026-10-06; design "Archive Confirm")

## Summary

Every "are you sure?" in jaunt was a native macOS sheet from the Tauri dialog plugin: generic OK and Cancel buttons, no danger tone, no options, and none of the app's styling. Project settings had a footer swap of its own for its one confirmation. All of them now use one in-app confirm modal, built from the "Archive Confirm" design: a title bar, a short message, an optional checkbox, Cancel, and the action button. Archive uses the checkbox to offer deleting the branch too.

## User journey

1. The user picks a risky action, such as Archive session… in the ⋯ menu.
2. The modal opens over the app, and over any dialog that is already open. The action button has focus.
3. For Archive, the message says the branch is kept. Ticking "Also delete the branch" changes the message to "The branch is deleted too." and turns the Archive button red.
4. Enter or a click on the action confirms. Esc, the ×, Cancel or a click outside cancels. Focus goes back to where it was before, such as the terminal that pressed ⌘W.

## Behaviour and acceptance criteria

- [x] No confirmation uses the native dialog plugin any more. Each one opens the in-app modal (the archive, close-agent, discard-file, discard-hunk, delete-section, remove-project, bypass-permissions, stop-daemon, install-hooks and install-helper confirms, plus Project settings' discard).
- [x] Archive's message says "The branch is kept." with a primary Archive button. With the box ticked, it says "The branch is deleted too." and the button is danger.
- [x] Confirming Archive with the box ticked deletes the branch; with the box clear the branch stays; cancelling archives nothing.
- [x] A second confirm asked while one is open cancels the first, so two never stack.
- [x] While the modal is open, the global ⌘ shortcuts do nothing, ⌘K included.
- [x] Esc in a modal opened over Settings or Project settings closes only the modal.
- [x] The action button has focus when the modal opens.
- [x] Tab and Shift+Tab stay inside the modal, and the modal sits above the toasts.
- [x] Closing Project settings while a save runs asks nothing; the save closes it.

## UI

`ConfirmDialog` in `components/ui.tsx` (also exported to the design system), shown by `ConfirmHost` from `App.tsx`:

- Overlay `bg-black/50` at `z-[70]`, so it sits above `Dialog` (`z-50`) and the toasts (`z-[60]`). Tab and Shift+Tab wrap inside the modal. The panel is top-aligned at 12vh, 440 px wide, `rounded-xl`, `border-border-strong`, `bg-panel`, shadow `0 25px 50px -12px rgba(0,0,0,.5)`.
- Header and footer are `bg-panel-2`, divided by `border-border`, `px-4 py-2.5`. The title is 13 px semibold, with a Close × on the right.
- The body is one 12.5 px muted paragraph with 1.55 line height. Line breaks in the message are kept.
- Footer: an optional checkbox on the left, then a ghost Cancel and the action button. Focused buttons get a 2 px accent outline, 2 px off the button.
- Danger (red) is for actions that lose data for good or lower safety: deleting the branch on archive, discarding file changes or a hunk, discarding unsaved Project settings, and bypass permissions. Every other confirm uses a primary button.

## Protocol and RPCs

None.

## Data and config

Nothing is persisted. The store holds the open request (`confirm`), and `lib/confirm.ts` resolves it. The Tauri capabilities no longer grant `dialog:allow-ask` or `dialog:allow-confirm`.

## Security considerations

Bypass permissions stays behind an explicit confirm with a danger button. The messages are plain text, and React escapes paths and names.

## Out of scope

- A "don't ask again" option.
- Restyling the general `Dialog` (Settings, Commit, Create PR).

## Test plan

- `lib/confirm.test.ts`: Archive's message and button for both checkbox states (the design's text), resolving and cancelling, and a second request cancelling the first.
- `lib/actions.test.ts`: the checkbox decides `delete_branch`, and cancelling sends no RPC.
- `lib/keys.test.ts`: global shortcuts are off while the modal is open.
- `lib/modal.test.ts`: Esc inside the modal is left to it, not to the dialog under it; Tab wraps at both ends.
- `lib/projectSettings.test.ts`: Close asks only for unsaved edits, and waits while a save runs.
- `e2e/specs/confirm-modal.e2e.ts`: archive from the ⋯ menu: the message, the focused action, the checkbox's text, Cancel, then a confirm that keeps the branch.
- `e2e/specs/project-settings.e2e.ts`: discarding unsaved changes goes through the modal.

## Open questions

- None.
