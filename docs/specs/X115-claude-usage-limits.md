# X115 — Claude usage limits in the sidebar footer

- **Status:** implemented
- **Priority / phase:** P2 · phase 4
- **PRD refs:** agent sessions (Claude)
- **Related ADRs:** —

## Summary

A Claude subscription has a 5-hour session limit and weekly limits: one for all models, and some for a single model. Claude Code shows them in `/usage`, and claude.ai shows them in Settings › Usage. Until now, moonlet showed neither. The sidebar footer now shows how much of the current session limit is used, for the workspace's Claude profile, at the right end of the footer row. A click opens a card with every limit, its bar and when it resets.

The numbers come from Claude Code itself: its `get_usage` control request answers with the same limits `/usage` shows, without a turn and without spending tokens. So moonlet never reads the account's credentials or calls Anthropic's API itself.

## User journey

1. The user works in a workspace whose sessions use Claude.
2. The sidebar footer shows a small gauge and `49%`: 49% of the current session limit is used.
3. The user clicks it. A card opens above the footer:
   - Current session: a bar at 49%, "Resets 2:40 PM".
   - Weekly · All models: a bar at 33%, "Resets Wed 5:00 AM".
   - Weekly · Fable: a bar at 2%, "Resets Wed 5:00 AM".
   - The plan (`Team`), when it was last updated, and a refresh button.
4. Switching to a workspace with another Claude profile (another account) shows that account's limits.

## Behaviour and acceptance criteria

- [x] `claude.usage {workspace?}` answers with the limits Claude Code's `get_usage` reports in that workspace's Claude profile: each limit's kind, model (for a model's own weekly limit), percent used, severity and reset time, plus the plan.
- [x] It answers `null` when Claude Code cannot say: it is missing, it fails or times out, or the account has no limits (`rate_limits_available: false`, as with an API key). A `null` is held for the minute too, so a Claude that cannot answer is not started on every ask.
- [x] An answer is reused for 60 s per profile, so several windows and the poll start at most one Claude a minute per profile. `refresh: true` asks again unless the held answer is younger than 5 s.
- [x] The footer shows the current session's percentage (the user's choice), else the first limit Claude reported, at the right end of the row. It hides itself when the answer is `null` or has no limits. Its tooltip names the weekly one too.
- [x] The card lists every limit in Claude's order, labelled "Current session", "All models" and the model's name, under the headings Session and Weekly.
- [x] A reset today reads "Resets 2:40 PM"; a later one "Resets Wed 5:00 AM"; one more than 6 days away "Resets Dec 9".
- [x] A limit whose reset time has passed shows no percentage ("—") and "Reset at 11:00 AM", because it no longer holds, until the next answer.
- [x] A limit at `warning` severity, or 80% and above, is drawn in the warning colour; at `critical`, or 100%, in the error colour.
- [x] The app asks when the footer mounts, when the shown workspace changes, every 5 minutes, and when the card opens (with `refresh`).

## UI

```
[⚙] [🔔] [👤 Work] [⬆]              [◔ 49%]
```

The gauge is a ring like the chat's context meter (X34), filled to the session percentage. The card, 300 px wide, opens upwards from the button:

```
Usage limits                         Team
SESSION
Current session          Resets 2:40 PM
▓▓▓▓▓▓▓▓▓░░░░░░░░░░                  49%
WEEKLY
All models           Resets Wed 5:00 AM
▓▓▓▓▓▓░░░░░░░░░░░░░                  33%
Fable                Resets Wed 5:00 AM
░░░░░░░░░░░░░░░░░░░                   2%
─────────────────────────────────────────
Updated 2 min ago                       ⟳
```

Escape, a click outside or a resize closes it.

## Protocol and RPCs

- `claude.usage` (`ClaudeUsageAsk {workspace?, refresh?}`) → `ClaudeUsage | null`.
- `ClaudeUsage {plan?, limits: UsageLimit[], at}`, where `at` is when Claude answered (ms since the epoch).
- `UsageLimit {kind, group, model?, percent, severity, resets_at?}`. Claude Code names the kinds and groups (`session`/`session`, `weekly_all`/`weekly`, `weekly_scoped`/`weekly`), and `resets_at` is its ISO 8601 time.

The method is not on the phone's allowlist (X38), so the phone can't call it.

## Data and config

Nothing is saved. The daemon holds the last answer per Claude profile in memory.

## Security considerations

No new input crosses a trust boundary. The Claude started to answer runs as the chat probes of X105 do: `claude -p` in the profile's environment, in the home folder, killed with its process group after the answer or 20 s.

## Out of scope

- Codex and other agents' limits.
- Claude's usage credits (`spend`, `extra_usage`) and its usage recommendations (`behaviors`).
- Updating the numbers from the `rate_limit_event`s of running chats.
- The phone app.

## Test plan

- Rust unit: `the_get_usage_reply_gives_the_accounts_limits`, on a reply captured from Claude Code 2.1.332 (`fixtures/claude-usage.json`), and `None` for `rate_limits_available: false`.
- Daemon: `claude_usage_comes_from_claude_codes_get_usage_reply` (a fake `claude` that answers `get_usage`, per profile, and is asked once within the minute), `claude_usage_refresh_asks_claude_again_after_five_seconds` and `claude_usage_is_null_when_claude_cannot_say`.
- Vitest `lib/usageLimits.test.ts`: the footer text, labels, reset wording, passed resets and warning levels. `lib/claudeUsage.test.ts`: "asks at once and every 5 minutes, and afresh on refresh" and "drops an answer that comes after a newer ask's, and a failed ask".
- Manual: the footer and card in the real app, by screenshot (`e2e/snap.ts`).

## Open questions

- Should a limit that reaches 100% also raise a notification?
