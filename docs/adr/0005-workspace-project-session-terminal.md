# ADR 0005: Workspace → Project → Session → Terminal

- **Status:** accepted (2026-10-03)
- **Supersedes:** the earlier naming, where "workspace" meant one worktree task and "session" meant a PTY.

## Context

The user expects Conductor's model: a workspace is a set of repositories, a project points at a folder on disk, and each project has sessions that are automatically worktrees. The code used "workspace" for the per-task worktree and "session" for a PTY, so every user-facing term pointed at the wrong code concept.

## Decision

Rename throughout code, protocol, storage and docs:

| Old | New |
|---|---|
| session (PTY), `SessionInfo`, `session.*` RPCs, `JAUNT_SESSION_ID` | terminal, `TerminalInfo`, `terminal.*`, `JAUNT_TERMINAL_ID` |
| workspace (worktree task), `workspace.*` RPCs | session, `session.*` |
| repo, `repo.*` RPCs | project, `project.*` |
| (none) | workspace: a named set of projects, `workspace.*` |

`PROTOCOL_VERSION` goes to 2. The live upgrade reports the mismatch and the app runs `jauntd upgrade`. `state.json` is migrated on load: `repos` become `projects`, old `workspaces` become `sessions`, and a default workspace "My workspaces" containing every project is created. Installed hooks keep working because `jaunt hook` reads both `JAUNT_TERMINAL_ID` and the old `JAUNT_SESSION_ID`.

## Consequences

This is a one-time broad rename, mostly mechanical. Old specs keep their IDs; their wording is updated where it names these concepts. See [CONTEXT.md](../../CONTEXT.md).
