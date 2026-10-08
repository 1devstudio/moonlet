# A6: Local CLI and socket API

- **Status:** implemented (first slice)
- **Priority / phase:** P1 · phase 3, started early because hooks need it
- **PRD refs:** A6

## Summary

`moonlet` is the scripting entry point. It talks to the daemon over the same socket and protocol as the app.

## Commands

| Command | Does |
|---|---|
| `moonlet notify --state <s> [-m msg] [--session id]` | Reports agent state. The session defaults to `$MOONLET_SESSION_ID`. |
| `moonlet hook claude\|codex [payload]` | Entry point for agent hooks (see [A1](A1-agent-state.md)). |
| `moonlet hooks install\|status\|uninstall` | Manages hooks (see [A2](A2-hook-install.md)). |
| `moonlet ls [--json]` | Lists sessions. |
| `moonlet pane run <id> <cmd…>` | Types a command into a pane and presses Enter. |
| `moonlet agent start [--agent claude] [--cwd dir] [prompt…]` | Starts an agent session through the login shell and prints its id. |
| `moonlet project ls [--json]` | Lists projects (see [X22](X22-agent-opens-session.md)). |
| `moonlet session new <project> [prompt…]` | Creates a session in a project and starts its agent with the prompt (see [X22](X22-agent-opens-session.md)). |
| `moonlet session ls\|wait\|read\|send` | Lists sessions, waits for a session's agent, prints its last reply, sends it a message (see [X22](X22-agent-opens-session.md)). |

## Behaviour and acceptance criteria

- [x] The socket comes from `--socket`, then `$MOONLET_SOCK`, then `~/.moonlet/run/moonletd.sock`.
- [x] Errors print `moonlet: <message>` and exit 1. `hook` never fails.
- [ ] `moonlet agent start --workspace` once workspaces exist ([A4](A4-new-workspace.md)).

## Security considerations

The socket is protected as described in [S1](S1-daemon-owned-sessions.md). There is no network exposure.
