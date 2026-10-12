# X34 — Context window meter and cost line

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2 (agent-first), journey J2
- **Related:** [X29](X29-chat-plus-menu-and-mcp.md) (chat footer and `+` menu), [X6](X6-structured-agent-view.md) (structured agent view)

## Summary

The chat footer follows the updated "MCP Servers Menu" design: next to the `+` button sits a small ring showing how full the agent's context window is, and after it the session's cost and tokens. Clicking the ring opens a card that breaks the context down by category (system prompt, tools, memory files, skills, messages and so on), shows the free space and when Claude compacts on its own, and offers **Compact now**. The numbers come from Claude Code's `get_context_usage` control request, the source of `/context` in the terminal. `Free` here is the window minus what is used; `/context` also sets the autocompact buffer apart. Codex does not report a breakdown, so Codex sessions show the cost line without the ring.

## User journey

1. In a Claude session the footer reads, left to right: `+`, a ring with `62%`, a thin divider, `$43.73 · 130.7M in · 297k out`. The model, effort and permission mode stay on the right.
2. The user clicks the ring. A card opens above it: `Context window` with `124k / 200k` on the right, a stacked bar, and one row per category with its colour and token count, for example `System prompt 8.1k`, `Skills 8.8k`, `Messages 92.1k`, then `Free 75.8k`.
3. Under a divider the card says `Auto-compacts at 95%` and has **Compact now**. Clicking it sends `/compact` to the agent and closes the card.
4. While a turn runs the centre of the footer shows `Working`, the elapsed time and `esc to stop`; the ring and cost line stay where they are.
5. After each turn the ring updates.

## Behaviour and acceptance criteria

- [x] After Claude's `initialize` reply, and after every turn's `result` (finished, failed or stopped), moonlet sends `get_context_usage` with `detail: "summary"`, which needs no API call. (`claude.rs` test)
- [x] The reply fills `ChatState.context`: tokens used (`totalTokens`), the window size (`maxTokens`), the auto-compact threshold when auto-compact is on, and the categories Claude counts as used, in Claude's order, without empty ones. Deferred tools, the autocompact buffer and free space are not categories. (`claude.rs` test with a captured reply)
- [x] An error reply leaves the previous `context` in place. (`claude.rs` test)
- [x] The ring's label is the used share of the window, rounded to a whole percent; the card's heading reads `<used> / <max>` in the short token format. (`chat.test.ts`)
- [x] The card lists each category with its token count, then `Free` with the window size minus the used tokens. The bar has one segment per category, sized by its share of the window. (`chat.test.ts`)
- [x] Category colours: `System prompt` and `System tools` grey, `MCP tools` purple, `Memory files` yellow, `Messages` the accent; other categories take blue, green, cyan and pink in turn. (`chat.test.ts`)
- [x] The card says `Auto-compacts at <n>%` when Claude reported a threshold, and `Auto-compact is off` otherwise. (`chat.test.ts`)
- [x] Token counts of a million or more read like `130.7M` instead of `130719k`. (`chat.test.ts`)
- [x] The cost line reads `$<cost> · <in> in · <out> out`, leaving out a zero cost, and is hidden until the session has a cost or tokens. (`chat.test.ts`)
- [x] The cost line sits left of centre after the ring, with a divider between them, and stays visible while a turn runs. Sessions without `context` (Codex, or Claude before its first reply) show no ring and no divider. (`agent-view.e2e.ts` for the ring and cost line)
- [x] **Compact now** closes the card and sends `/compact` to the agent as a message, also while a plan is being revised. (`agent-view.e2e.ts`)

## UI

```
[+] (◔ 62%) │ $43.73 · 130.7M in · 297k out       Working 12s · esc to stop       Opus 5.5 Medium  Auto  …

┌ Context window            124k / 200k ┐
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░ │
│ ■ System prompt                  8.1k │
│ ■ MCP tools                     18.4k │
│ ■ Memory files                   5.6k │
│ ■ Messages                      92.1k │
│ □ Free                          75.8k │
├───────────────────────────────────────┤
│ Auto-compacts at 95%    [Compact now] │
└───────────────────────────────────────┘
```

The ring is a conic gradient in the accent colour over the border colour. The card closes on a click outside it or on Escape.

## Protocol and RPCs

`ChatState` gains `context: ContextUsage | null`:

```json
{
  "used": 15165,
  "max": 1000000,
  "auto_compact_at": 967000,
  "categories": [{ "name": "System prompt", "tokens": 2387 }, { "name": "Messages", "tokens": 1869 }]
}
```

No new RPCs. Claude Code's `get_context_usage` control request is sent by the daemon on its own.

## Data and config

`context` is saved with the conversation in `chats/<id>.json`, so a restored chat shows its last reading until the agent answers again.

## Security considerations

None: the reply is numbers and category names from the local agent.

## Out of scope

- A context reading for Codex.
- Per-file memory, per-skill or per-MCP-server detail (the reply has it; the card shows totals only).
- Refreshing the reading while a turn runs.
