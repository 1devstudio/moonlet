---
title: Project config
description: The .moonlet/config.toml file that sets a project's scripts, agents and base branch, and how to edit it.
group: Start here
order: 4
tags: [Reference]
---

## The config file

Each repository can carry a `.moonlet/config.toml`. It sets the scripts moonlet runs for the project's sessions, the agent new sessions start with, and the branch they start from. You can edit it by hand, or in **Project settings** in the app.

```toml
setup = "pnpm install"        # runs when a session's worktree is created
run = "pnpm dev"              # the Run button (⌘R)
archive = "docker compose down"
default_agent = "claude"      # claude, codex or a name from [agents]
base_branch = "main"

[agents]
claude-yolo = "claude --dangerously-skip-permissions"
```

The file is often committed, so the whole team shares it.

## Keys

| Key | Purpose |
|---|---|
| `setup` | Command run in a new session's worktree after it is created. |
| `run` | Command started by the Run button (⌘R). Running it again restarts it. |
| `archive` | Command run before a session is archived. |
| `default_agent` | Agent started for new sessions: `claude`, `codex` or a name from `[agents]`. |
| `base_branch` | Branch that new sessions start from and that Changes compare against. |
| `branch_prefix` | Put before the name of each new session branch. Overrides the host's prefix in **Settings › Git**. |
| `trackers` | The tracker projects whose sessions start in this project, such as `["jira:acme.atlassian.net/WEB"]`. See [Tasks and trackers](/docs/tasks-and-trackers). |
| `[agents]` | Custom agent commands, picked like the built-in `claude` and `codex`. |
| `[heavy]` | Commands that run on a free machine. See [below](#heavy-commands). |

### Scripts

`setup`, `run` and `archive` run through your login shell (`$SHELL -lic`), so your `PATH` applies.

- **setup** runs when a session is created. The agent starts first; setup runs in a second tab beside it, in the background.
- **run** starts in a tab titled after the script. Running it again replaces that tab, so run tabs do not pile up. Closing, stopping or restarting the tab stops every process the script started.
- **archive** runs before a session is archived, for up to 60 seconds.

If a project has no `run` script, the Run button opens Project settings with the **Run** field focused.

### Agents

`claude` and `codex` are built in. `[agents]` adds your own, each a name and the command that starts it, as `claude-yolo` in the example above. You pick a custom agent like the built-in ones.

- A name uses only letters, digits, `.`, `_` and `-`. It cannot be `claude` or `codex`.
- A command cannot be empty.
- `default_agent`, when set, must be `claude`, `codex` or one of the names in `[agents]`.

### Base branch

When `base_branch` is not set, moonlet uses the repository's default branch: `origin/HEAD`, then `main`, `master`, `develop` or `trunk`, whichever it finds first. Clearing `base_branch` in Project settings goes back to that default.

## Project settings

Project settings is a page of Settings that edits the same file. Open it in one of these ways:

- the gear on a project's header in the sidebar, shown on hover next to `+`;
- **Project settings…** in the right panel's `⋯` menu;
- "Project settings…" in the command palette, for the current session's project;
- the Run button, when the project has no `run` script.

The page's breadcrumb reads `Settings › Projects › storefront`. It has these sections:

- **Scripts:** Setup, Run and Archive.
- **Agents:** Default agent, and Custom agents with **Add agent**.
- **Task trackers:** the tracker projects linked to this project, and **Link a tracker project…**.
- **Git:** Base branch, and the project's branch prefix.

Edits collect until you save. The bar at the bottom shows the file's path (click to copy it) and its state: "This file is part of the repository.", "Unsaved changes" or "Fix N errors to save". Press **Save** (⌘↵) or **Discard**. Leaving the page with unsaved changes asks first.

Saving writes the file in place. Comments, blank lines, key order and keys the page does not know stay as they were. An empty field removes its key. The Run button picks up the new values at once, and the composer reads the file each time it opens.

### When the file needs attention

- **No file yet.** The page says "No .moonlet/config.toml yet. Saving creates it."
- **Changed on disk.** If the file changed after you opened the page, saving writes nothing and offers **Reload**.
- **Not valid TOML.** The page shows the parse error and the path instead of the form, with **Check again** and **Reveal in Finder** (or **Copy path** for a project on a remote host). It never overwrites a file it cannot read.

### Which copy is read

Project settings edits the copy in the project's main checkout, and that is the copy moonlet reads for these keys. A session's worktree has its own checked-out copy. Saving shows up as an uncommitted change in the main checkout, as a hand edit would. moonlet does not watch the file for hand edits; it picks them up the next time you switch sessions.

## Heavy commands

A `[heavy]` table lists commands, such as a test suite, that run on the least busy machine of your account instead of the one running the agent:

```toml
[heavy]
commands = ["pnpm test", "pnpm build"]
outputs = ["coverage"]
```

It also takes `os` (`"any"`, `"macos"` or `"linux"`) and `env`, the environment variables passed through to the machine that runs the command. Listing a command is not enough: you approve the list in the project's **Heavy commands** section before anything is routed. [Heavy commands](/docs/heavy-commands) explains routing and approval.

## Where moonlet keeps its own data

The config file belongs to the repository. moonlet's own data lives in `~/.moonlet`: its state, logs and session worktrees (`~/.moonlet/worktrees/<project>/<session>`). Set `MOONLET_HOME` to use another directory, for example to keep a test setup apart from your real data:

```sh
MOONLET_HOME=/tmp/moonlet-dev pnpm dev
```
