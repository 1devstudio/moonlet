# X5: Workspaces, projects and sessions (Conductor model)

- **Status:** approved
- **Priority / phase:** P1 · phase 3
- **Related:** [ADR 0005](../adr/0005-workspace-project-session-terminal.md), [glossary](../../CONTEXT.md). Replaces the "workspace = task" model of [A4](A4-new-workspace.md).
- **References:** Conductor screenshots the user provided on 2026-10-03 (sidebar menu, new-session composer).

## Summary

The sidebar shows one or more **workspaces**, each a collapsible block holding **projects** (repo folders on disk). Each project lists its **sessions**, every one an isolated git worktree. "+" on a project opens a Conductor-style composer: you describe the task, pick the agent and model, and Create. The session name and branch come from the prompt.

## Sidebar

- Each workspace block has:
  - a header (name, chevron to collapse, `⋯` menu);
  - its projects, each with a `+` and its sessions below;
  - collapse state remembered per workspace.
- The workspace `⋯` menu:
  - **Group by:** Project (default), Status, or None.
  - **Filter by project:** a checklist of the workspace's projects.
  - **Sort by:** Recent activity (default), Created, or Name.
  - **New section…:** a named group; rows get "Move to section".
  - **Add project…:** a folder picker or an existing project.
  - Rename and Delete workspace (deleting only removes the grouping; projects and sessions remain).
- A "New workspace" entry at the bottom of the workspace list.
- **Session row:** a branch icon (purple when the branch has an open PR, otherwise muted), the title, and the diffstat (`+5.5k −41`, using k for thousands). The agent state still shows as a dot when an agent is working, blocked, done or failed. Double-click renames; the context menu has Rename, Move to section, Archive.

## Composer (new session)

- Opened by `+` on a project, ⇧⌘N, or the palette. It is a large dialog:
  - **Header:** the project picker (`name ⌄`) and `⋯`, which holds "Start from branch…", "Use existing branch…" and "Base branch". On the right is a source picker (GitHub ⌄) to start from an issue or PR (`gh issue list` / `gh pr list`). An issue fills the prompt with its title and body and links it; a PR checks out its branch.
  - **Body:** a textarea, "What do you want to work on?" (optional).
  - **Footer:** the agent/model picker on the left (`Sonnet 5.5 High ⌄`: agent, model alias, effort), and on the right `+` (attach files: adds paths to the prompt) and **Create ↵** (⌘↵, or ↵ in a single-line prompt).
- **On Create:**
  - The session name is the prompt's first line, trimmed to 48 characters, or "Untitled".
  - The branch is `jaunt/<slug>`, made unique.
  - The worktree is created and the setup script runs.
  - The agent starts with the chosen model and effort: Claude `--model <alias> --effort <level> -n <name>`; Codex `-m <model> -c model_reasoning_effort=<level>` (unverified here, no Codex install).
  - The prompt becomes the agent's first message.
- The last used agent, model and effort are remembered per project.

## Data and RPCs

- **Workspaces** (`workspace.*`):
  - `workspace.create {name}`
  - `workspace.list`
  - `workspace.update {id, name?, project_ids?, sections?, view?}`
  - `workspace.delete {id}`
  - `workspace.add_project {id, path}`, which adds the project if it is new and attaches it.
  - `view` holds group/sort/filter and is persisted.
- **Projects** (`project.*`): `add`, `list`, `remove`, `config`.
- **Sessions** (`session.*`): `create`, `list`, `archive`, `unarchive`, `update {name?, section?, layout?}`, `run`.
  - `session.create` takes `{project_id, prompt?, name?, agent?, model?, effort?, from?, existing_branch?, issue?}`.
- **Terminals** (`terminal.*`): the old PTY `session.*` methods, renamed.
- **Migration:** see ADR 0005.

## Acceptance criteria

- [ ] An existing `state.json` from before the rename loads with all projects and sessions under "My workspaces".
- [ ] Two workspaces can share a project. Collapsing one keeps the other expanded.
- [ ] Group, sort and filter work and survive a restart.
- [ ] Sections: create one, move a session into it, see it under that section.
- [ ] The composer creates a session from a prompt: name and branch derived, agent started with the selected model and effort, the prompt delivered.
- [ ] Starting from a GitHub issue prefills the prompt. Starting from a PR uses its branch.
- [ ] No real agent is started by tests.
