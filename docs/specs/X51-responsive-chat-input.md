# X51 — Responsive chat input

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X6 (structured agent view), X29 (chat plus menu), X34 (context window), X49 (queued messages)
- **Related ADRs:** none

## Summary

The chat input and the footer under it were laid out for one width. In a narrow chat column (a split pane, a wide side panel) the footer's three groups ran into each other, and the one-line input looked cramped next to the queued messages and cards above it. The input is now two lines tall by default, the turn's status (Working, Waiting for your approval) has its own line above the input, and the footer drops its extras in a fixed order as the chat column narrows, so nothing in it wraps or overlaps at any width.

## User journey

1. The user opens a chat in a wide column. The input is a two-line box. Under it, on the left: `+`, the context ring with `15%`, and `$3.49 · 3M in · 19.9k out`; on the right: `Opus 5.5 High`, `⚡ Auto ⌄` and `…`.
2. They send a message. A line appears above the input: the spinner, `Working 47s · esc to stop`, and **Stop** at its right end.
3. They split the pane. At 560 px the spend shortens to `$3.49`; at 420 px it goes, with `High`, `· esc to stop` and `⌥↵ ask aside`; at 320 px the ring loses its percentage and the mode chip keeps only its icon. The input stays two lines tall throughout, and **Stop** stays on the status line.

## Behaviour and acceptance criteria

The width is the chat column's, measured as it resizes.

- [x] Tiers: **wide** from 640 px, **medium** from 500 px, **narrow** from 380 px, **compact** below. (`chatInput.test.ts` picks the tier from the chat column's width)
- [x] Wide shows everything: the full spend, the effort, `· esc to stop`, `⌥↵ ask aside` and the idle placeholder that names @ and /. (`chatInput.test.ts` shows everything when wide)
- [x] Medium keeps the spend's first part only: `$3.49`, or `41.2k in` when there is no cost. The full line is the spend's tooltip. (`chatInput.test.ts` keeps only the dollars of the spend at medium; `chat.test.ts` keeps only the cost in its short form, or the tokens in without one)
- [x] Narrow drops the spend, the effort, `· esc to stop` and `⌥↵ ask aside`, and the idle placeholder becomes `Ask for a change…`. While a turn runs, the placeholder stays `Queue a message for Claude` (X49). (`chatInput.test.ts` drops the spend, effort and hints when narrow; `queued.test.ts` shortens the idle placeholder in a narrow chat)
- [x] Compact also drops the context ring's percentage and the permission mode's name (the icon and chevron stay), and the column's padding shrinks from 24 px (16 px when narrow) to 12 px. (`chatInput.test.ts` keeps the ring and the mode's icon alone when compact)
- [x] The input is two lines tall when empty, and grows with its text up to 260 px. (seen in the app)
- [x] While a turn runs or waits for approval, its status is on a line of its own above the input, lined up with the input's text, with **Stop** at its right end; the footer has no status in the middle any more. (seen in the app; `plan-approval.e2e.ts` and `queued-messages.e2e.ts` still find the status and Stop)

## UI

```
 ◌ Working 47s · esc to stop                         ■ Stop
╭──────────────────────────────────────────────────────────╮
│ Queue a message for Claude                               │
│                                              ⌥↵ ask aside ↵│
╰──────────────────────────────────────────────────────────╯
 +  ◔ 15% │ $3.49 · 3M in · 19.9k out    Opus 5.5 High  ⚡ Auto ⌄  …
```

Card padding: 14 px top and bottom, 16 px left (11 px and 12 px when compact), 12 px right. The status line is 28 px high, 6 px above the card.

## Protocol and RPCs

None.

## Data and config

None.

## Security considerations

None: layout only.

## Out of scope

- The new-session composer (X5), which is a fixed-width dialog.
- The phone app's chat input (X40).

## Test plan

Vitest for the tiers, the short spend and the short placeholder; the existing e2e specs for the status line and Stop; screenshots of the chat at 760, 560, 420 and 320 px with `e2e/snap.ts`.

## Open questions

- None.
