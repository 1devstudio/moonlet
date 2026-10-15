# X47 — Quieter notifications

- **Status:** implemented (2026-10-15). Unit and e2e tests cover it; not yet heard in the running app by a person.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** A3, journeys J2 and J3
- **Related:** [A3](A3-sidebar-and-notifications.md) (notifications), [X10](X10-attention-sounds.md) (sounds), [X42](X42-subagents-view.md) (subagents)

## Summary

With several agents at work, moonlet sounds and shows a banner for every finished turn, and that gets noisy. Some of these alerts are repeats: a Claude terminal tab finishes, and about 60 s later Claude reports that it is waiting for input. A chat that leaves background subagents running says "done" while they still work. X47 cuts these repeats. A chat is done only once its subagents end, and another "done" for the same session within 90 s stays silent. The user can also turn off the banner for each event and mute every sound from a bell in the sidebar footer.

## User journey

1. The user asks Claude for work that it splits across background subagents, then switches away. Claude's own turn ends while the subagents still run: no alert, and the session row still shows the agent working. When the last subagent ends, one "is done" alert comes.
2. A Claude terminal tab finishes: one "is done" alert. When Claude reports a minute later that it waits for input, nothing plays.
3. The user finds the "done" banners too much: in **Settings › Notifications** they turn off "Notification when an agent is done". The banners for "needs you" and "fails" stay.
4. In a meeting, the user clicks the bell next to the gear in the sidebar footer. It becomes a crossed-out bell, and no sound plays until they click it again. Banners still show.

## Behaviour and acceptance criteria

- [x] A chat whose turn ended while a background subagent still runs reports its agent as working, and raises no `agent.attention`. When the last subagent ends, it reports done and raises one `agent.attention` with state done. (`a_turn_is_not_done_while_its_subagents_run`)
- [x] A "done" for a session within 90 s of the last "done" that alerted for it plays no sound and shows no banner. After 90 s it alerts again. A "done" the user watched starts no burst, and looking at the session ends the burst, so the next "done" alerts. "Needs you" and "failed" always alert. (`alerts.test.ts`: a burst of done, DoneBursts)
- [x] Each event (needs you, done, failed) has its own desktop notification switch, on by default. Off sends no banner for that event and still plays its sound. (`alerts.test.ts`: banners per event, `mute-sounds.e2e.ts`)
- [x] "Mute all sounds" turns off every agent sound and leaves the banners. (`alerts.test.ts`: muted)
- [x] The sidebar footer has a bell next to the gear: "Mute sounds" mutes, and the crossed-out bell "Unmute sounds" turns the sounds back on. It and the switch in Settings › Notifications › Sounds are the same setting. (`mute-sounds.e2e.ts`)
- [x] Settings search finds the three notification switches and "Mute all sounds", with On or Off. (`settingsSearch.test.ts`)
- [x] The unread mark and the dock badge are unchanged: a silenced alert still marks the session. (`alerts.test.ts`: unread)

## UI

Sidebar footer:

    [⚙] [🔔] Default profile ▾          ← 🔕 while muted

Settings › Notifications:

    Desktop notifications
    Notify even while moonlet is focused        [ ]
    Notification when an agent needs you        [x]
    Notification when an agent is done          [x]
    Notification when an agent fails            [x]

    Sounds
    Mute all sounds                             [ ]
    Needs you   [Glass   ▾] ▶
    Done        [Hero    ▾] ▶
    Failed      [Basso   ▾] ▶

## Protocol and RPCs

No new RPC. The daemon's chat runtime reports `working` instead of `done` while the chat's subagents run, so `terminal.updated` and `agent.attention` follow that.

## Data and config

`moonlet.settings` in localStorage gains `banners: { blocked?, done?, error? }` (a missing value is on) and `muted: boolean`. The 90 s burst timestamps live in memory only (`DoneBursts`).

## Security considerations

None: no new input crosses a trust boundary.

## Out of scope

- Waiting for Claude's wrap-up turn. Claude answers once more after its last subagent ends; the "done" comes when the subagent ends, a few seconds before that answer.
- Stopping a chat, or restarting it for a new setting, while its subagents run ends them, so the chat turns done and alerts like a finished turn.
- A "done" alert from a Claude terminal tab per background subagent turn. Hooks carry no subagent state, so the burst rule is what keeps those quiet.
- Muting banners from the footer (macOS Focus does that).
- Per-session or per-project mute.

## Test plan

- Rust: `a_turn_is_not_done_while_its_subagents_run` (chat runtime with the fake `claude`).
- Vitest: `alerts.test.ts`, `settingsSearch.test.ts`.
- E2e: `mute-sounds.e2e.ts`.
- Manual: with moonlet in the background, a chat with background subagents alerts once at the end; a Claude terminal tab alerts once per finish; the bell silences Hero.

## Open questions

- None.
