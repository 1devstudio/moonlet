# A4: New workspace (agent task)

- **Status:** superseded by [X5](X5-workspaces-projects-sessions.md): what this spec calls a workspace is now a **session**, and repos are **projects** ([ADR 0005](../adr/0005-workspace-project-session-terminal.md)). The worktree, scripts and archive behaviour below still apply to sessions.
- **Priority / phase:** P0 · phase 1
- **PRD refs:** A4, journey J1; UI direction in plan section 2 (Superset/Conductor)

## Summary

A workspace is one task: a git worktree on its own branch, the agent working in it, and any shells or run scripts beside it. Creating one sets up the worktree, runs the repo's setup script and starts the agent. Archiving tears it down.

## User journey

1. Add a repo once: the "Add repository" dialog calls `repo.add`.
2. Press Cmd+Shift+N, then pick the repo, name the task, pick an agent, and optionally give a first prompt. The task can start from the base branch (default), another branch or ref, or an existing branch.
3. A new workspace row appears in the sidebar and the agent starts in its own tab.
4. When the work has landed, Archive removes the worktree, keeps the branch unless asked otherwise, and moves the workspace to History.

## Behaviour and acceptance criteria

- [x] `repo.add` accepts any directory inside a repo, stores the top level, and returns the existing record for a repo added twice. The base branch comes from `.jaunt/config.toml` `base_branch`, then `origin/HEAD`, then `main`/`master`/`develop`/`trunk`.
- [x] `workspace.create`:
  - The branch defaults to `jaunt/<slug(name)>` and the directory to `~/.jaunt/worktrees/<repo>/<slug>`; both get `-2`, `-3`… suffixes when taken.
  - The worktree starts from `from`, defaulting to the repo base branch. With `existing_branch` it checks out that branch instead of creating one (a leading `origin/` is stripped).
  - If `setup` is configured it runs in a `setup` tab, at the same time as the agent.
  - The agent runs in a login interactive shell (`$SHELL -lic "<agent cmd> '<prompt>'"`), so the user's PATH applies.
  - With no agent configured, a plain shell opens instead.
- [x] Agent commands: `claude` and `codex` are built in; `[agents]` in `.jaunt/config.toml` adds or overrides them. Unknown names run as commands.
- [x] Every workspace session gets `JAUNT_WORKSPACE_ID`, `JAUNT_ROOT_PATH` (main checkout), `JAUNT_WORKSPACE_PATH`, `JAUNT_WORKSPACE_NAME` and `JAUNT_BRANCH`.
- [x] `workspace.archive`:
  - runs the `archive` script, with a 60 s cap;
  - kills the workspace's sessions;
  - removes the worktree (`remove_worktree`, default true);
  - deletes the branch only with `delete_branch`;
  - marks the workspace archived.
- [x] `workspace.unarchive` recreates the worktree if needed and opens a shell.
- [x] State is saved atomically to `~/.jaunt/state.json`. Changes emit `workspaces.changed` / `repos.changed`.
- [x] A repo can't be removed while it has active workspaces.
- [x] UI: new-workspace dialog, sidebar rows, History view.

## Data and config

`.jaunt/config.toml` in the repo:

```toml
setup = "pnpm install"
run = "pnpm dev"
archive = "docker compose down"
default_agent = "claude"
base_branch = "main"
[agents]
claude-yolo = "claude --dangerously-skip-permissions"
```

## Security considerations

- Scripts come from the repository, so they are as trusted as the repo itself, the same as `package.json` scripts. They run only on explicit user action (create, Run, archive).
- The prompt is single-quoted for the shell.

## Test plan

- `workspace.rs`: `create_run_archive_workspace`, `agent_commands_resume_where_supported`, `config_parsing`.
- `daemon.rs` e2e: `workspace_lifecycle_over_rpc`.
