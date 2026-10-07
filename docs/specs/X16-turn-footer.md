# X16 — Response time and copy under the agent's final message

- **Status:** implemented (2026-10-05)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2 (agent-first), journeys J2 and J3
- **Related:** [X6](X6-structured-agent-view.md) (structured agent view), [X14](X14-collapsed-tool-calls.md) (collapsed tool calls)

## Summary

When the agent finishes a turn, the user wants to know how long it took and when it ended, and often wants the answer on the clipboard to paste elsewhere. X16 puts a quiet footer under the final message of every completed turn: the response time, the time the turn ended, and a copy button that copies that message.

## User journey

1. The user asks the agent a question. The agent works for 14 seconds and answers.
2. Under the answer a faint line reads `14s · 4:00 PM`, followed by a copy icon.
3. The user clicks the icon. The answer's markdown is on the clipboard and a `Copied message` toast appears.
4. Two days later the same footer reads `14s · Thu 4:00 PM`; after a week, `14s · Sep 28, 4:00 PM`.

## Behaviour and acceptance criteria

- [x] When a turn completes (Claude `result` with success, Codex `turn/completed` with `completed`), the turn's last assistant message records when the turn started and ended. (`claude.rs`, `codex.rs` tests)
- [x] Interrupted and failed turns record nothing, and neither does a turn without assistant text. (`claude.rs`, `codex.rs` tests)
- [x] The footer shows the duration in the `elapsed` format (`14s`, `1m 05s`), then ` · `, then the end time. (`chat.test.ts`)
- [x] The end time is the time alone for today, weekday and time within the last 6 days, and month, day and time when older; a different year adds the year. (`chat.test.ts`)
- [x] The copy button (title `Copy final message`) copies the message's markdown and shows `Copied message`. (`agent-view.e2e.ts`)
- [x] Messages saved before X16 have no timing and show no footer.

## UI

    Tell me when it's saved and I'll re-check: …
    14s · Thu 4:00 PM  ⧉

The footer uses the faint text colour at 12px, under the message, aligned with its text.

## Protocol and RPCs

`ChatItem` gains an optional `turn: { started_at, ended_at }` (milliseconds since the epoch), set only on the final assistant message of a completed turn. Older clients ignore it.

## Data and config

The field is saved with the conversation in `chats/<id>.json`, so footers survive daemon restarts.

## Security considerations

None new. The copied text is the message as the agent wrote it; nothing is rendered from it.

## Out of scope

- Footers on interrupted or failed turns.
- Token counts or cost per turn (the status line keeps the session totals).
- A `⋯` menu with further actions on the message.

## Test plan

- Unit (Rust, `crates/moonlet-core/src/chat/claude.rs` and `codex.rs`): a completed turn stamps its final message; interrupted and failed turns do not.
- Unit (`apps/desktop/src/lib/chat.test.ts`): `turnFooter` for today, this week, older and another year.
- E2E (`apps/desktop/e2e/specs/agent-view.e2e.ts`): the replayed turn shows the footer, and its copy button puts the answer on the clipboard.

## Open questions

- None.
