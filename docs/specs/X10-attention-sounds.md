# X10 — Sound when an agent finishes or needs you

- **Status:** implemented (2026-10-04). Unit tests pass and `afplay` was checked from the shell; the sound has not been heard from inside the app yet.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** A3, journeys J2 and J3
- **Related:** [A3](A3-sidebar-and-notifications.md) (attention events, notifications)

## Summary

A3 notifies through macOS notifications, which only fire when jaunt is not focused and are silent. X10 plays a short system sound whenever an agent finishes, fails or needs the user, unless the user is already looking at that agent. Each of the three events has its own sound, which the user can change or turn off in Settings.

## User journey

1. The user starts an agent in a session and switches to another session, another app, or leaves the desk.
2. The agent stops to ask for permission or a question (blocked): jaunt plays the "needs you" sound.
3. The agent finishes its turn (done) or fails (error): jaunt plays the "done" or "failed" sound.
4. In **Settings › Agents › Sounds** the user picks a sound per event (or Off) and can preview it.

## Behaviour and acceptance criteria

- [x] A sound plays on every `agent.attention` event (blocked, done, error), local or remote. The daemon only sends one per state change, so a sound means a real transition.
- [x] No sound when jaunt is focused and the agent's tab is the active tab of the selected session (the same "visible" check that suppresses the unread mark).
- [x] Defaults: needs you = Glass, done = Hero, failed = Basso. Each can be set to any macOS system sound or Off. Off plays nothing.
- [x] A missing or unknown stored value falls back to the default for that event (`soundFor`, unit-tested).
- [x] Sound plays independently of notification permission and of the "Notify even while jaunt is focused" setting.
- [x] Settings shows a ▶ button next to each picker that plays the chosen sound.

## UI

Settings › Agents, under the default permission mode:

    Sounds
    Needs you   [Glass   ▾] ▶
    Done        [Hero    ▾] ▶
    Failed      [Basso   ▾] ▶

## Protocol and RPCs

New Tauri command `play_sound { name }`. It plays `/System/Library/Sounds/<name>.aiff` with `afplay` and waits for it to finish, so no zombie processes are left. Names outside the fixed list are rejected with `invalid_params`. On non-macOS builds it is a no-op.

## Data and config

`jaunt.settings` in localStorage gains `sounds: { blocked, done, error }`, each a system sound name or `""` for Off.

## Security considerations

The sound name comes from the webview and becomes part of a file path. The Rust side accepts only names from a fixed allowlist, so no path traversal and no arbitrary file is played.

## Out of scope

- Custom sound files.
- Volume control (`afplay` plays at the system output volume).
- Sounds for other events (PR checks, terminal bell).

## Test plan

- Unit: `soundFor` defaults, Off and unknown values (`sounds.test.ts`); Rust `sound_path` allowlist.
- Manual: with jaunt in the background, an agent finishing plays Hero; a permission prompt plays Glass; while watching the agent's tab nothing plays; changing a picker to Off silences it.

## Open questions

- None.
