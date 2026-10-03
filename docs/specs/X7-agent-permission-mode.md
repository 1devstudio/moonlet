# X7: Permission mode picker for the structured agent view

- **Status:** implemented (2026-10-03): footer picker, Settings default and new-session picker. Design taken from the Claude desktop app's Mode menu. Backend and flag checked live; the UI (menu layout, Settings select, modal picker and size) and the Plan and Bypass flows have not been checked in the app.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** A5, goal 2
- **Related:** [X6](X6-structured-agent-view.md) (structured agent view, `chat.settings`)

## Summary

The structured Claude view had a model and effort picker but no way to change Claude Code's permission mode (the one Shift+Tab cycles in the TUI). X7 adds a separate **Mode** dropdown in the composer footer: Auto, Manual, Accept edits and Plan, plus Bypass permissions behind an explicit Enable step. The same menu is in the new-session modal, and Settings holds the default mode that modal starts from.

## User journey

1. The user opens a Claude session. The footer shows a mode chip next to the model chip. By default a new session starts in **Manual**, which is what Claude does without a flag; the Settings default (step 4) can change that.
2. Clicking the chip opens the Mode menu. Picking a mode, or pressing 1–4 while the menu is open, changes it. ⇧Tab in the editor cycles to the next mode without opening the menu.
3. The mode applies from the next message. The current turn, if any, finishes in the old mode.
4. In **Settings › Agents** the user picks the default mode (Auto, Manual, Accept edits or Plan; never Bypass). It is Manual until changed.
5. The new-session modal shows a Mode picker (Claude only) next to the model picker. It starts at the default from Settings, every time. The chosen mode is used for the session's first start, structured view or TUI.
6. "Bypass permissions" shows **Enable**. Clicking it asks for confirmation once. After confirming, Bypass is a normal selectable row for this session and is selected.

## Behaviour and acceptance criteria

- [x] `chat.settings {id, mode}` stores the mode in `ChatState.mode` and the saved config, and marks the agent for restart with resume (same as model and effort).
- [x] Claude starts with `--permission-mode <mode>` when a mode is set, and without the flag when it is not.
- [x] The mode survives a daemon restart, because it is part of the saved config.
- [x] Unknown mode strings are rejected by `chat.settings` and nothing changes.
- [ ] Codex ignores the mode, and the chip is hidden for Codex (footer and new-session modal).
- [ ] The menu lists Auto, Manual, Accept edits and Plan with a description each, a check on the current one, and the numbers 1–4 as hints.
- [ ] Bypass is never selected by default and is never offered as a one-click switch.
- [ ] ⇧Tab in the editor cycles Manual → Accept edits → Plan → Auto (Bypass only once enabled).
- [x] Settings has a default permission mode (Auto, Manual, Accept edits, Plan). A missing or unknown stored value reads as Manual (`resolveMode`, unit-tested; the select itself is not checked in the app).
- [ ] The new-session modal has the same Mode menu for Claude and starts at the Settings default. It is not remembered per project.
- [x] `session.create {mode}` starts the first chat with `--permission-mode <mode>`. With `tui: true`, the TUI command gets the same flag (tests: `a_new_chat_starts_in_the_requested_mode`, `session_mode_is_recorded_…`, `names_and_agent_flags`).
- [x] `session.create` and `terminal.create` reject an unknown or empty mode and create nothing (`session.create` and `ChatManager::create` have tests; the `terminal.create` handler only calls the shared `check_mode`).
- [ ] "Open in terminal" starts `claude --resume <id>` with `--permission-mode` for the chat's current mode. An explicit `mode` on an agent `terminal.create` wins over `Session.mode` when the command is built.
- [ ] ⇧Tab cycles the mode even while the `@` or `/` completion list is open; Tab and Enter still accept a completion. Escape closes an open Mode menu without also closing the new-session modal.
- [ ] The new-session modal is narrower and shorter than before (720px wide, 200px prompt area).

## UI

- **Chip:** an icon and the mode label, left of the model chip, in the same footer row.
- **Settings:** a new "Agents" section with a "Default permission mode" select. The Bypass option is not listed.
- **New-session modal:** the Mode picker sits right of the model and effort picker, same chip look, menu opens upward. The modal is `min(720px, 90vw)` wide with a 200px prompt area.
- **Menu:** shared by the footer and the modal; title "Mode"; each row has a label, a one-line description and the number hint; the current row has a check. The last row is "Bypass permissions" with an "Enable" action in place of the number, and a confirmation dialog.

| Row | `--permission-mode` | Description |
|---|---|---|
| Auto | `auto` | Claude handles permission decisions |
| Manual | `manual` | Always ask before making changes |
| Accept edits | `acceptEdits` | Automatically accept all file edits |
| Plan | `plan` | Create a plan before making changes |
| Bypass permissions | `bypassPermissions` | Skip every permission check |

## Protocol and RPCs

- `chat.settings {id, model?, effort?, mode?}`: `mode` is one of `auto`, `manual`, `acceptEdits`, `plan`, `bypassPermissions`.
- `ChatState.mode` and `ChatConfig.mode` are optional strings. `None` means no flag.
- `session.create {…, mode?}` and `terminal.create {…, mode?}` take the same values. Both reject an unknown value.
- `Session.mode` records the mode chosen at creation. Later terminals of the session (for example "Open in terminal") use it when none is passed. Changing the mode in the footer does not update it.
- The Settings default is app-side only (`jaunt.settings` in localStorage); the daemon never sees it.

## Data and config

- `mode` is saved with the chat in `~/.jaunt/chats/<terminal id>.json` (`cfg` and `state`). Older files without it load as `None`.

## Security considerations

- Bypass permissions removes every approval prompt. It needs a confirmation, is per session, and is not remembered for new sessions. It cannot be the Settings default, and the modal does not remember it per project.
- The mode comes from an explicit user action only. An agent cannot change it through the protocol.
- The value is checked against the fixed list before it reaches a process argument.

## Out of scope

- Mode for Codex (its approval policy is a separate setting).
- Remembering the mode per project in the modal.
- A per-project or per-host default mode.
- Switching mode live without a restart through the SDK `set_permission_mode` control request. It is not verified, and the restart path reuses the model and effort mechanism.
- Dedicated UI for the plan that Plan mode produces. It appears as a normal `ExitPlanMode` permission card.

## Test plan

- Unit: `Claude::command` with and without a mode.
- Unit: mode validation, including `session.create` and `terminal.create` rejecting unknown values.
- Unit: `session.create` with a mode starts the chat with it (fake `claude`), and `agent_flags` adds `--permission-mode` for the TUI.
- Unit (frontend): the Settings value falls back to Manual when missing or unknown.
- Runtime: `settings` stores the mode, marks a restart, and the mode survives save and restore.
- Manual: the footer chip and menu, the Settings select, the new-session modal picker and size, the keyboard shortcuts, and a live Claude turn in Plan mode (see `docs/manual-checks.md`).

## Verification (2026-10-03)

- `claude -p --model haiku --permission-mode <mode> "reply with the single word ok"` answered `ok` for `plan`, `auto` and `bypassPermissions` (claude 2.1.288). `bypassPermissions` needed no extra flag in that plain headless run.
- In the app (scratch `JAUNT_HOME`), a session switched to Auto completed a live turn, and the saved chat file held `mode: auto` in both the config and the state.

## Open questions

- Whether `auto` is available on every Claude account. If it is not, Claude reports an error on start, and the chat shows it as it does for any start failure.
- Whether `bypassPermissions` works together with `--permission-prompt-tool stdio` (the plain headless check did not use it).
