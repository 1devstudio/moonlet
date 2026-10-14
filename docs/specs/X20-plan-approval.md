# X20 — Plan approval card

- **Status:** implemented (2026-10-06). Protocol checked live against claude 2.1.291; card, chip and transcript row covered by e2e with a fake `claude`. The card, the approve choice and Keep planning were reworked by [X24](X24-plan-panel.md).
- **Priority / phase:** P1 · phase 3
- **PRD refs:** A5, goal 2 (agent-first)
- **Related:** [X6](X6-structured-agent-view.md) (structured agent view), [X7](X7-agent-permission-mode.md) (permission mode picker), [X14](X14-collapsed-tool-calls.md) (collapsed tool calls), [A5](A5-approval-inbox.md) (approval inbox)

## Summary

In Plan mode Claude ends its plan with an `ExitPlanMode` call. moonlet showed it as a generic "Allow ExitPlanMode?" card with the plan as escaped JSON, cut off after one line, so the user could not read what they were approving. Approving also left moonlet thinking the session was still in Plan mode: the footer chip kept saying Plan, and the next restart (a model change, a daemon restart) started Claude with `--permission-mode plan` again. X20 gives the plan its own card, with the plan rendered as markdown and the same three choices as Claude Code's terminal UI, and makes Claude's own mode reports the source of truth for the session's mode.

## User journey

1. The user starts a session in Plan mode and asks for a change. Claude explores, then proposes a plan.
2. A card titled "Claude has a plan" shows the plan as formatted markdown (headings, lists, code), scrollable when long, with the plan file's path under it.
3. The user picks one of:
   - **Approve, accept edits:** Claude starts implementing and file edits go through without asking. The mode chip changes to Accept edits.
   - **Approve, ask before edits:** Claude starts implementing and asks before each edit. The chip changes to Manual.
   - **Keep planning:** a text box opens. The user types what to change ("Use a feature flag instead") and clicks Send feedback. Claude gets the text and revises the plan. The chip stays Plan.
4. Later the user changes the model. Claude restarts in the mode it was last in, not in Plan.
5. Scrolling back, the `ExitPlanMode` row in the transcript opens to show the plan that was approved.

## Behaviour and acceptance criteria

- [x] When Claude reports a mode change (`{"type":"system","subtype":"status","permissionMode":…}`), the chat's mode becomes that mode; Claude's `default` reads as `manual`. Modes the picker does not offer (such as `dontAsk`) leave the mode unchanged. (`claude_reports_set_the_mode`)
- [x] The next start of the agent (restart after a settings change, or resume after a daemon restart) uses the mode Claude last reported. (`the_agent_restarts_in_the_mode_claude_last_reported`)
- [x] A plan card waiting at a daemon restart shows again afterwards, and its three choices still work. The old agent process is gone, so the resumed agent gets the answer as a message. An approval restarts it in the chosen mode (`manual` for "Approve, ask before edits") with "I approve your plan. Go ahead with it."; "Keep planning" sends the feedback and stays in Plan. See X6, Persistence and restore. (`a_plan_approved_after_a_daemon_restart_resumes_claude_in_the_chosen_mode`, `a_plan_approved_to_ask_before_edits_after_a_daemon_restart_resumes_claude_in_manual`, `plan_feedback_after_a_daemon_restart_reaches_claude_still_in_plan_mode`)
- [x] `chat.permission` with `mode: "acceptEdits"` and `decision: "allow"` answers Claude with `updatedPermissions: [{type: "setMode", mode: "acceptEdits", destination: "session"}]`. (`approving_a_plan_can_switch_to_accept_edits`)
- [x] `chat.permission` rejects any other `mode` value (X24 adds `auto`), a `mode` with a decision other than `allow`, and a `mode` on any ask that is not a pending `ExitPlanMode`, and answers nothing. (`a_plan_approval_only_switches_to_auto_or_accept_edits`)
- [x] An `ExitPlanMode` ask with a string `plan` shows the plan card; an `ExitPlanMode` ask without one falls back to the plain permission card. (`planOf` in `chat.test.ts`, `plan-approval.e2e.ts`)
- [x] The card renders the plan as markdown and shows `planFilePath` when present. (`plan-approval.e2e.ts`)
- [x] "Approve, accept edits" sends `allow` with mode `acceptEdits`; "Approve, ask before edits" sends `allow` with no mode; "Keep planning" sends `deny` with the typed feedback as the message. Send feedback is disabled while the text box is empty. (`planAnswer` in `chat.test.ts`, `plan-approval.e2e.ts`)
- [x] The ask's one-line summary (approval inbox, sidebar, notifications) is the plan's first heading, or its first line when it has none. (`a_plan_is_summarised_by_its_heading_or_first_line`)
- [x] The `ExitPlanMode` tool row in the transcript can be opened and shows the plan as markdown, followed by the tool's result. (`plan-approval.e2e.ts`)
- [x] The status line under the conversation reads "Waiting for your approval" while the plan card is open. (`plan-approval.e2e.ts`)

## UI

    ┌──────────────────────────────────────────────────────────────┐
    │ ◇ Claude has a plan                                          │
    │ ┌──────────────────────────────────────────────────────────┐ │
    │ │ Jobs on other hosts: analysis and options                │ │
    │ │ Context …  (markdown, max 420px, scrolls)                │ │
    │ └──────────────────────────────────────────────────────────┘ │
    │ ~/.claude/plans/help-me-explore-this-tingly-octopus.md       │
    │ [Approve, accept edits] [Approve, ask before edits]  Keep planning │
    └──────────────────────────────────────────────────────────────┘

- Same card frame as the permission and question cards.
- "Keep planning" swaps the buttons for a text box (focused) with Send feedback and Cancel. Enter sends, Shift+Enter adds a line, Escape cancels; neither key acts while an input method is composing.

## Protocol and RPCs

- `chat.permission {id, ask, decision, message?, answers?, mode?}`: new optional `mode`. Only `acceptEdits` is accepted ([X24](X24-plan-panel.md) adds `auto`), and only with `decision: "allow"`.
- Claude's `system/status` line is read for `permissionMode`; `ChatState.mode` changes and a `chat.state` event goes out.

Captured from claude 2.1.291 in Plan mode (`--permission-prompt-tool stdio`):

    {"type":"control_request","request_id":"da66e8fc-…","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","display_name":"ExitPlanMode","input":{"plan":"1. Overwrite `a.txt` (untracked, repo root) content with `goodbye`.\n2. Verify by reading file back. …\n","planFilePath":"/Users/…/.claude/plans/plan-changing-a-txt-to-groovy-whale.md"},"tool_use_id":"toolu_013XgKuAKWBb9pZDCyHcs1rP","requires_user_interaction":true}}

It carries no `permission_suggestions`. After a plain `allow` Claude reported `permissionMode: "default"` and asked before the next Write; after an `allow` with the `setMode` update it reported `permissionMode: "acceptEdits"` and wrote the file without asking.

## Data and config

The reported mode is saved with the chat (`cfg.mode` and `state.mode` in `chats/<id>.json`), as X7 already does for the picker.

## Security considerations

- The mode can only be raised to Accept edits from the plan card, by a user click; the agent cannot pick it. Bypass permissions stays reachable only through X7's confirmation.
- A mode reported by Claude is accepted only if it is in X7's list, so a stray value never reaches `--permission-mode`.
- The plan is the agent's text and is rendered with the same markdown renderer as its messages (no raw HTML).

## Out of scope

- Approving into the mode the session had before Plan (for example back to Auto). Claude Code's terminal UI does not offer it either.
- "Clear context and approve".
- Editing the plan text before approving.
- Codex, which has no plan mode.

## Test plan

- Unit (Rust, `crates/moonlet-core/src/chat/claude.rs`): a `system/status` line updates the mode (`default` → `manual`, unknown ignored); `allow` with a mode sends `setMode`; the `ExitPlanMode` summary is the plan's heading.
- Unit (Rust, `crates/moonlet-core/src/chat/runtime.rs`): after Claude reports a new mode, the restarted agent gets `--permission-mode` with it; `chat.permission` rejects a bad mode.
- Unit (`apps/desktop/src/lib/chat.test.ts`): reading the plan out of an ask, and mapping each choice to its `chat.permission` parameters.
- E2E (`apps/desktop/e2e/specs/plan-approval.e2e.ts`): a fake `claude` proposes a plan; the card shows it formatted; Approve, accept edits switches the chip to Accept edits; Keep planning sends the feedback back to Claude.

## Open questions

- ~~Whether `setMode` with `auto` works from the plan card.~~ It does (claude 2.1.291, checked 2026-10-06); see [X24](X24-plan-panel.md).
