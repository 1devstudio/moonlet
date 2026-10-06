# X24 — Plan panel, and approving a plan into Auto

- **Status:** implemented (2026-10-06). Approving into Auto checked live against claude 2.1.291; the panel, card, setting and tabs covered by e2e with a fake `claude`. Not yet looked at in the running app by a person.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** A5, goal 2 (agent-first)
- **Related:** [X20](X20-plan-approval.md) (plan approval card), [X7](X7-agent-permission-mode.md) (permission mode picker), [X8](X8-project-settings.md) (settings)

## Summary

X20 showed Claude's plan inside a large card in the conversation. A long plan pushed the conversation out of view, and the card disappeared once the plan was answered. X24 moves the plan into a **Plan** tab of the right panel, which opens by itself when a plan arrives, and leaves a compact card in the conversation that carries the approval buttons and, once answered, what happened to the plan. Approving now switches to **Auto** by default; a setting chooses Auto or Accept edits. The right panel's tabs get the underlined style from the same design.

Design: `Plan Panel.html` (a Claude Design bundle built from jaunt's own components), with the approval buttons placed in the conversation card.

## User journey

1. The user works in Plan mode. Claude proposes a plan.
2. The right panel opens on the **Plan** tab and shows the plan as markdown, with its status ("Waiting for your approval"), the time it arrived and the plan file's path.
3. In the conversation a compact card reads "Claude has a plan · waiting for approval" with the plan's title and three buttons:
   - **Approve, auto mode** (or **Approve, accept edits**, per Settings): Claude implements the plan; the mode chip changes to Auto (or Accept edits).
   - **Approve, ask before edits**: Claude implements and asks before each edit; the chip changes to Manual.
   - **Keep planning**: the composer below gets focus with the placeholder "What should change in the plan?". What the user sends goes back to Claude as feedback on the plan. Escape in the empty composer drops out of this without sending.
4. The card stays in the conversation and shows the outcome: "Plan approved · auto mode", "Plan approved · accepting edits", "Plan approved · asking before edits" or "Plan · revising with your feedback". The Plan tab shows the same.
5. When the panel is closed or shows another tab, the card has an **Open plan →** button, and the Plan tab shows a dot while a plan waits.
6. In **Settings › Agents**, "When a plan is approved, switch to" offers Auto (the default) and Accept edits.

## Behaviour and acceptance criteria

- [x] `chat.permission` with `mode: "auto"` and `decision: "allow"` on a pending `ExitPlanMode` answers Claude with `updatedPermissions: [{type: "setMode", mode: "auto", destination: "session"}]`. `acceptEdits` works as in X20; any other mode is still rejected. (`approving_a_plan_can_switch_to_auto`, `a_plan_approval_only_switches_to_auto_or_accept_edits`)
- [x] The setting "When a plan is approved, switch to" holds `auto` or `acceptEdits`; a missing or unknown stored value reads as `auto`. (`resolvePlanMode` in `agents.test.ts`; switching it in `plan-approval.e2e.ts`)
- [x] The approve button is labelled "Approve, auto mode" for `auto` and "Approve, accept edits" for `acceptEdits`, and sends `allow` with that mode. "Approve, ask before edits" sends `allow` with no mode. Feedback sends `deny` with the trimmed text; empty feedback sends nothing. (`planAnswer`, `planApproveLabel` in `chat.test.ts`)
- [x] The plan shown for a chat is its latest one: the pending `ExitPlanMode` ask when there is one, else the last `ExitPlanMode` call in the transcript. Its status is pending while the ask waits (or the call is still running), revising after feedback, stopped when the call failed, and approved otherwise; an approved plan reads with the chat's current mode. (`planView`)
- [x] The card and panel labels for each status and mode are as listed under UI. (`planLabels`)
- [x] The Plan tab shows the plan of the session's chat that has a pending plan, else the focused chat, else the session's first chat. (`planChat`)
- [x] When a plan ask arrives in a chat on screen, the right panel opens on the Plan tab. (`plan-approval.e2e.ts`)
- [x] The compact card sits right after the transcript row of its `ExitPlanMode` call, has the approval buttons while the plan waits, and stays with the outcome after. (`plan-approval.e2e.ts`)
- [x] Keep planning focuses the composer with the placeholder "What should change in the plan?"; sending answers the plan with the feedback; Escape in the empty composer leaves without sending and without stopping Claude. (`plan-approval.e2e.ts`)
- [x] The Plan tab shows a dot while a plan waits and another tab is selected. (`planTabDot`)
- [x] The right panel's tabs are Plan, Files, Changes and Review, styled as underlined 13px labels that scale with the text size. (`font-size.e2e.ts`)

## UI

Plan tab (right panel):

    Plan  Files  Changes  Review          ← 38px, active tab underlined in accent
    ─────────────────────────────────────
    ● Waiting for your approval   Updated 7:22 PM
    ~/.claude/plans/add-a-dark-theme.md
    ─────────────────────────────────────
    # Add a dark theme                     ← markdown, scrolls
    …

Empty: "No plan yet" / "Plans Claude proposes in Plan mode show here."

Card (conversation):

    ┌──────────────────────────────────────────────────────────┐
    │ 🗎 Claude has a plan · waiting for approval  Open plan → │
    │   Add a dark theme                                       │
    │ ──────────────────────────────────────────────────────── │
    │ [Approve, auto mode] [Approve, ask before edits]  Keep planning │
    └──────────────────────────────────────────────────────────┘

| Status | Card label | Panel label | Colour |
|---|---|---|---|
| pending | Claude has a plan · waiting for approval | Waiting for your approval | blocked |
| revising | Plan · revising with your feedback | Revising | accent |
| stopped | Plan · stopped | Stopped | muted |
| approved, `auto` | Plan approved · auto mode | Approved · auto mode | done |
| approved, `acceptEdits` | Plan approved · accepting edits | Approved · accepting edits | done |
| approved, `manual` | Plan approved · asking before edits | Approved · asking before edits | done |
| approved, other | Plan approved | Approved | done |

## Protocol and RPCs

- `chat.permission {…, mode?}`: `mode` may now be `auto` or `acceptEdits`, still only with `decision: "allow"` on a pending `ExitPlanMode`.

Captured from claude 2.1.291 (haiku, Plan mode, `--permission-prompt-tool stdio`) after answering `ExitPlanMode` with `{"behavior":"allow","updatedInput":…,"updatedPermissions":[{"type":"setMode","mode":"auto","destination":"session"}]}`:

    {"type":"system","subtype":"status","status":null,"permissionMode":"auto","uuid":"67af9b54-f1df-4403-8ddb-aee90f8981d6","session_id":"dcfd4256-64fa-4677-b619-c9d94bddd79f"}

Claude then edited the file without another `can_use_tool` ask.

## Data and config

- `planApproveMode` (`auto` | `acceptEdits`) in the app settings (`jaunt.settings` in localStorage). The daemon never sees it.
- `rightTab` may now be `plan`.

## Security considerations

- The mode is raised only by a user click on the card. The agent cannot pick it, and the daemon accepts only `auto` or `acceptEdits` from a plan approval. Bypass permissions stays behind X7's confirmation.
- The plan is rendered with the same markdown renderer as agent messages (no raw HTML).

## Out of scope

- Approving into the mode the session had before Plan.
- Editing the plan text before approving.
- Showing older plans in the panel; they stay readable in their transcript rows (X20).
- Remembering the approved mode per plan: an approved plan's label follows the chat's current mode.
- Codex, which has no plan mode.

## Test plan

- Unit (Rust, `crates/jaunt-core/src/chat/runtime.rs`): approving into `auto` sends `setMode auto` and the restarted agent gets `--permission-mode auto`; other modes are rejected.
- Unit (`apps/desktop/src/lib/plan.test.ts`): `planView`, `planLabels`, `planChat`, `planTabDot`. (`agents.test.ts`): `resolvePlanMode`. (`chat.test.ts`): `planAnswer`, `planApproveLabel`.
- E2E (`apps/desktop/e2e/specs/plan-approval.e2e.ts`): the panel opens on the Plan tab with the plan; Open plan and the tab dot; feedback through the composer; approving switches the chip to Auto, or to Accept edits per Settings; the card keeps the outcome. (`font-size.e2e.ts`): the restyled tabs.

## Open questions

- None.
