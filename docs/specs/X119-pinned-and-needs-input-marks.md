# X119 — Pinned and needs-input marks on session rows

- **Status:** implemented
- **Priority / phase:** P2
- **PRD refs:** X112 (Pin to top), X48 (row styles), X118 (phone rows)
- **Design:** `~/.moonlet/design/.sessions/98f94fc00326/designs/pinned-session-indicator-in-the/` (session design, not committed; page `index.html`)

## Summary

X112 added **Pin to top**, but a pinned row looks like any other row: only its place in the list tells. A session row now starts with a pin when the session is pinned to the top. And the row's `needs input` word becomes an icon, so the badge column stays narrow and the name keeps its room. The rows are the shared `RowView` (X118), so the desktop sidebar and the phone's Sessions list both change.

## User journey

1. The user right-clicks "Rate-limit webhook retries" and picks **Pin to top**. The row moves first in its project and now starts with a small tilted pin, before its state glyph.
2. **Unpin from top** removes the pin.
3. When the session's agent asks something, the row ends in a yellow question bubble instead of the words `needs input`. Hovering it says "needs input".
4. On the phone, the same session's row shows the same pin and the same bubble.

## Behaviour and acceptance criteria

- [ ] A row's badge for an agent that needs input is an icon: `sessionBadge` returns `{ text: "needs input", tone: "blocked", icon: true }`, and every other badge has no icon. (`lib/sidebar.test.ts` lets needs input and creating win over agents; mobile `lib/sessionList.test.ts` shows a waiting session's needs input as an icon)
- [ ] The icon (lucide `message-circle-question`, 13px, `text-blocked`) carries the badge's text as its accessible name and tooltip. (`e2e/specs/agents.e2e.ts` and `e2e/specs/agent-reads-terminal.e2e.ts` find the row's `needs input` by its label)
- [ ] A session pinned to the top starts its row with a pin (lucide `Pin`, 12px, `text-muted`, turned 45° so it reads apart from X73's upright host pin), labelled "Pinned to top"; Unpin from top removes it. (`e2e/specs/session-menu.e2e.ts` pins a session from its menu and its row shows the pin; unpins it and the pin goes)
- [ ] The phone's Sessions rows show the same pin for a session pinned to the top. (shared `RowView`; the phone passes `pinned` from the session record, `apps/mobile/src/screens/Sessions.tsx`)

## UI

The pin sits before the glyph slot, its right margin trimmed by 4px, so a pinned row's glyph and name sit about 18px further right than its unpinned neighbours. Colours follow the row's other marks: the design pen, X73's host pin and the not-ready triangle are all `text-muted`.

Pages not chosen: **B** (a hairline under the last pinned row, no icon) and **C** (B plus an Unpin button on hover). The user picked page A and asked for the pin at the far left.

## Protocol and RPCs

None. `Session.pinned_top` (X112) already reaches the phone and every member.
