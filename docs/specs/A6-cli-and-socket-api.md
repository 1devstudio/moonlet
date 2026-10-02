# A6: Local CLI and socket API

- **Status:** implemented (first slice)
- **Priority / phase:** P1 · phase 3, started early because hooks need it
- **PRD refs:** A6

## Summary

`jaunt` is the scripting entry point. It talks to the daemon over the same socket and protocol as the app.

## Commands

| Command | Does |
|---|---|
| `jaunt notify --state <s> [-m msg] [--session id]` | Reports agent state. The session defaults to `$JAUNT_SESSION_ID`. |
| `jaunt hook claude\|codex [payload]` | Entry point for agent hooks (see [A1](A1-agent-state.md)). |
| `jaunt hooks install\|status\|uninstall` | Manages hooks (see [A2](A2-hook-install.md)). |
| `jaunt ls [--json]` | Lists sessions. |
| `jaunt pane run <id> <cmd…>` | Types a command into a pane and presses Enter. |
| `jaunt agent start [--agent claude] [--cwd dir] [prompt…]` | Starts an agent session through the login shell and prints its id. |

## Behaviour and acceptance criteria

- [x] The socket comes from `--socket`, then `$JAUNT_SOCK`, then `~/.jaunt/run/jauntd.sock`.
- [x] Errors print `jaunt: <message>` and exit 1. `hook` never fails.
- [ ] `jaunt agent start --workspace` once workspaces exist ([A4](A4-new-workspace.md)).

## Security considerations

The socket is protected as described in [S1](S1-daemon-owned-sessions.md). There is no network exposure.
