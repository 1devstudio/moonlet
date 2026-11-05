---
title: Your first session
description: Add a project, start an agent in its own worktree, review what it did and open a pull request.
group: Start here
order: 3
tags: [10 minutes]
---

## Before you start

You need moonlet installed (see [Installation](/docs/installation)), a git repository to work in, and Claude Code or Codex on your `PATH`. To open a pull request at the end, sign in to the GitHub CLI with `gh auth login`.

The examples use a project called `storefront`.

## Add a project

A project is a git repository folder. Projects belong to a workspace, and the sidebar shows one workspace at a time.

1. Open the workspace's `⋯` menu in the sidebar and choose **Add project…**.
2. Pick one of the two tabs:
   - **Local folder**: choose a folder that holds a git repository, then **Add project**.
   - **Clone from GitHub**: in **Repository**, paste a URL such as `https://github.com/acme/storefront`, type `acme/storefront`, or pick from **Your repositories** (listed when `gh` is signed in). **Clone into** starts at `~/moonlet` / `storefront`. Press **Clone and add**.

A clone shows git's progress as it runs, and keeps running if you close the dialog. When it finishes, a toast says "Added storefront", and the dialog turns into the new session composer.

## Install agent hooks

Hooks let Claude Code and Codex tell moonlet when they are working, need you, are done or failed. You install them once per Mac.

1. Open **Settings** (⌘,) and go to **Claude Code › Hooks**.
2. Click **Install hooks**. moonlet lists the files it will edit and asks you to confirm.

Or run this in any terminal:

```sh
moonlet hooks install
```

moonlet adds its hooks to `~/.claude/settings.json` and sets Codex's `notify` in `~/.codex/config.toml`. It keeps everything else in those files, and copies each file to a `.moonlet-backup-<ms>` file before it changes it. If Codex already has a different `notify` program, moonlet refuses and leaves it alone. Installing again changes nothing. `moonlet hooks status` shows what is installed, and `moonlet hooks uninstall` removes only moonlet's entries.

## Start a session

Open the composer in one of these ways:

- the `+` on a project in the sidebar;
- ⇧⌘N;
- the command palette.

The composer asks "What do you want to work on?". Type the task, for example "Add a search box to the product list".

- **The header** has the project picker and, on the right, a source picker to start from an existing branch or pull request instead of a new branch.
- **The branch row** under it reads `New branch` `from main`. Its `⋯` holds **Start from branch or commit…** and **Use an existing branch…**.
- **The footer** has the agent and model picker on the left, with the effort, such as `Opus 5.5 High ⌄`. The last agent, model and effort you used are remembered per project. On the right, `+` attaches files, and **Create** starts the session.

Press **Create** or ⌘↵. moonlet then:

1. names the session after the first line of your prompt;
2. creates a branch such as `moonlet/add-a-search-box-to-the-product-list`, from the base branch;
3. creates a worktree for it under `~/.moonlet/worktrees/storefront/`;
4. starts the agent with your prompt as its first message, and opens the session on the agent's tab;
5. runs the project's `setup` script, if it has one, in a second tab beside it.

The branch prefix `moonlet/` is a setting in **Settings › Git**, and a project can set its own. See [Project config](/docs/project-config) for `setup` and the base branch.

## Work with the agent

A Claude Code or Codex tab shows the conversation: the agent's messages, its tool calls with their output and diffs, and permission requests as buttons. Type into the input at the bottom to send the next message.

The session's row in the sidebar shows the agent's state and the diffstat against the base branch. While you work elsewhere:

- a macOS notification tells you when the agent needs you, is done or failed, while moonlet is not focused;
- the top of the ⌘K palette lists every agent that is waiting for you, so you can jump to it.

If the project has a `run` script, the **Run** button (⌘R) starts it in a tab of its own, for example your dev server.

## Review the changes

Open the **Changes** tab in the right panel. It lists every file the session changed against the base branch, including what the agent committed. Click a file to open its diff in a tab of the main window.

In a diff you can:

- switch to **Uncommitted** to stage or discard single hunks;
- hover the gutter, click `+` and write a comment. It goes to the agent as `Review comment on <file>:<line>:`, with the line and your text.

[Review and pull requests](/docs/review-and-pull-requests) covers the Changes tab, the file tree and the editor in full.

## Commit and open a pull request

1. Click **Commit…** in the Changes tab, write the message and commit.
2. Press ⇧⌘P, or click **PR** in the right panel's top bar. The Create PR dialog is filled in from the session's name and its commits.
3. Confirm. moonlet pushes the branch and opens the pull request with `gh`.

The **Checks** tab then shows the pull request's state, its review decision and its CI checks. The branch icon on the session's row in the sidebar turns green while the pull request is open. Once it is merged, the row shows a purple merge icon and `merged`.

## Archive the session

When the work has landed, right-click the session's row and choose **Archive**. moonlet runs the project's `archive` script, if there is one, and removes the worktree. By default it deletes the local branch only when the session's pull request merged.

Before it removes anything, moonlet warns you about work that exists only on this machine, such as uncommitted files or commits not pushed to origin, and offers **Push, then archive**. What archiving keeps is set in **Settings › Git**.

## Next steps

- [Project config](/docs/project-config): setup, run and archive scripts, the default agent and custom agents.
- [Tasks and trackers](/docs/tasks-and-trackers): start a session from a Linear, Jira, ClickUp or GitHub issue.
- [Add an always-on host](/docs/add-an-always-on-host): keep sessions running when your MacBook sleeps.
