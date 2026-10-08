# S4: Workspace restore after daemon restart

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** S4

## Summary

PTYs can't survive a daemon crash or reboot. Workspaces remember how each of their sessions was started, so after a restart moonlet reopens them. Agents resume their last conversation where the agent supports it.

## Behaviour and acceptance criteria

- [x] Agent and shell sessions started in a workspace add a `restore` entry (kind, title, cwd, command, agent, session id). Setup and run sessions are not restored.
- [x] Closing a tab (`session.kill` with `remove`) drops its entry, and so does a process exiting while the daemon is running. Only sessions cut off by a daemon restart come back.
- [x] On daemon start, each non-archived workspace whose directory exists restarts every entry without a live session:
  - agents use the resume command (`claude --continue`, `codex resume --last`) and the first prompt is not replayed;
  - shells, and agents moonlet does not know how to resume, use their original command.
- [x] Restore is idempotent while sessions are alive, so an upgraded daemon that adopted its sessions restores nothing.
- [x] The UI layout (`workspace.layout`, opaque JSON) persists with the workspace.

## Test plan

- `workspace.rs`: `restores_agents_after_restart`, `closing_a_tab_stops_restoring_it`.
