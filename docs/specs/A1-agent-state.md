# A1: Agent state per pane

- **Status:** implemented (daemon side); UI in [A3](A3-sidebar-and-notifications.md)
- **Priority / phase:** P0 · phase 1
- **PRD refs:** A1, goal 2, journey J3, metric "blocked to notified < 2 s"

## Summary

Every agent session has a state: `idle`, `working`, `blocked`, `done` or `error`. The state comes from the most trustworthy source available. Hooks rank highest, then process exit, then terminal signals, then heuristics.

## Behaviour and acceptance criteria

- [x] A session is an agent session when it is created with `kind: agent`, or when it first receives a hook report.
- [x] Sources, highest first: `hook` (via `jaunt hook`/`jaunt notify`), `process` (exit), `terminal` (OSC 9 / OSC 777 notifications), `heuristic` (bell, output activity).
- [x] A lower source is ignored for 20 s after a higher one reported.
- [x] Without hooks, output marks the agent `working`, and 4 s of silence marks it `idle`. Once any hook has reported, activity heuristics are off for that session.
- [x] Process exit makes an agent `done` (code 0) or `error` (non-zero code or signal), with a message.
- [x] Each change emits `session.updated`. A change to `blocked`, `done` or `error` also emits `agent.attention` with the session, workspace, title and message.
- [x] Blocked to attention event in under 2 s. Measured at 28 ms in `crates/jaunt-cli/tests/hook_e2e.rs`.

## Claude Code mapping

| Hook event | State |
|---|---|
| SessionStart, SessionEnd | idle |
| UserPromptSubmit, PreToolUse, PostToolUse | working |
| PermissionRequest | blocked ("Permission needed for <tool>") |
| Notification (`permission_prompt` or other) | blocked (with the message) |
| Notification (`idle_prompt`) | done |
| Stop | done |

## Codex mapping

The `notify` program receives JSON. `agent-turn-complete` maps to done, with the last assistant message trimmed to 200 characters. Approval request types map to blocked.

## Security considerations

Messages come from agent output. The UI must sanitise them (strip control characters) before showing a notification.

## Test plan

- Unit tests in `agent.rs` and `hooks.rs`.
- `session.rs`: `hook_reports_raise_attention`.
- e2e: `hook_e2e.rs`.
