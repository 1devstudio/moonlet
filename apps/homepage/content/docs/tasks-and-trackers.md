---
title: Tasks and trackers
description: Connect Linear, Jira Cloud, ClickUp or GitHub Issues, see each issue beside the sessions working on it, and start work from a task.
group: Work
order: 2
tags: [Linear, Jira, GitHub]
---

## Trackers

moonlet connects to four trackers: **Linear**, **Jira Cloud**, **ClickUp** and **GitHub Issues**. Open **Settings › Task trackers** to manage them.

Each tracker connects differently:

| Tracker | How it signs in |
|---|---|
| GitHub Issues | Uses the `gh` login on the workspace's host. Nothing to connect. |
| Linear | An API key. |
| Jira Cloud | Your site (such as `acme.atlassian.net`), your email and an API token. |
| ClickUp | A personal API token (`pk_…`). |

Under **Add tracker**, click **Connect Linear**, **Connect Jira Cloud** or **Connect ClickUp**. moonlet checks the sign-in, says who you are signed in as, and offers **Add a board** or **Later**. You can connect more than one account of the same tracker, such as two Jira sites.

Tokens are kept in the macOS Keychain on this Mac and never sent to remote hosts. The settings are saved to `~/.moonlet/trackers.toml`.

When a tracker stops accepting a token, its row shows the tracker's message in red, with **Reconnect**. Jira API tokens expire, so this is the usual fix there.

If `gh` is not signed in, the GitHub Issues row tells you to run `gh auth login` on that host.

## Boards

Tasks mode shows one **board** at a time. A board is a named view of one tracker:

- Jira: an existing Jira board, or a JQL query
- Linear: a team
- GitHub: a GitHub Project, or a repository's issues
- ClickUp: a list

A board keeps the tracker's own columns in the tracker's own order, and follows the active sprint or cycle where the tracker has one.

**Add a board** has four steps:

1. **Source**: pick the connection and what the board is built from.
2. **Issues**: narrow the issues down, with a live count.
3. **Columns**: check what moonlet treats each column as (To do, In progress, In review or Done), then Show, Fold or Hide it.
4. **Finish**: name the board, pick its workspace and the projects its sessions start in, and choose what cards show.

**Create board** saves it and opens it. Change it later from a column's `⋯` menu › **Board settings**. Order and folding are moonlet's own and never change the tracker.

## Tasks mode

Press ⌃⌘T, or click the Tasks button in the sidebar's mode switch. The sidebar lists the workspace's pinned boards under **Boards**. Click the board's name in the header to switch boards.

Each card shows the issue's key, priority and title, and one row per session working on it, with its live agent state. A card whose session waits on you is outlined amber. **Board | List** switches to a list grouped by column. **Assignee: me / anyone** picks whose issues you see.

Click a card's title to open its detail: state, assignee, priority, labels, description, sessions, worktrees and activity.

### Move a task

Drag a card onto another column. The card moves at once, and moonlet sets the issue's status in the tracker to the column's first status. If the tracker refuses, the card goes back and the error shows with **Retry**. The State menu in the detail moves a task too.

### Create an issue

Click `+` in a column's header. **New issue in** that column asks for a title, a description, an assignee and labels. A Jira board also asks for the issue type. Press **Create** (⌘↵), and the new card shows in that column, selected.

## Start a session from a task

Click **Start** on a card. The New session composer opens with:

- the task as a chip
- the issue's description attached, sent as the first message
- a branch named after the issue
- the project that handles the issue's tracker project
- **Move to In Progress** ticked (for GitHub, **Assign to me**)

Leave the prompt empty to start from the issue, or add to it. Press ⌘↵ to start.

Which projects a tracker's sessions start in is set in Project settings › Task trackers, and saved in the project's `.moonlet/config.toml`. See [Project config](/docs/project-config).

## Links

A session works on at most one task. It is linked when:

- it was started from the task
- its branch name carries the issue key, such as `web-142-search`
- its pull request's title carries the key, or for GitHub the PR closes the issue
- you link it by hand

To link by hand, pick **Link to task…** in a session's right-click menu. Search, or paste a key or an issue URL. **Unlink** removes a link.

A linked session shows a task bar above the conversation, with the task's state menu, and a **Task** tab in the right panel.

## Keep in step

moonlet can move the issue as the work moves. Each rule is Automatically, Suggest or Off, per tracker, in Settings › Task trackers:

| When | Then | Default |
|---|---|---|
| A session starts from an issue | Move it to In Progress and assign it to you (GitHub: assign it to you) | Automatically |
| A pull request opens, not as a draft | Move the issue to In Review | Automatically |
| A pull request opens, not as a draft | Comment the PR's link on the issue (GitHub: add `Closes #<n>` to the PR body) | Automatically |
| Every session's PR is merged | Move the issue to Done (GitHub: close it as completed) | Suggest |
| The issue moves to Done | Archive its sessions and remove their worktrees, after a confirm | Suggest |

The Task tab's **Keep in step** switch turns every rule off for that task.

## Out of sync

A task is **out of sync** when its tracker state disagrees with its work. For example, a session works on it while it is still in a To do column, or every PR merged while it is still in review. The card shows an Out of sync chip with a one-click fix, such as **Move to Done**. **Not now** hides the chip until something changes. The Tasks button counts the tasks that are out of sync.

## Task comments

The Task detail and a session's Task tab show the issue's comments, oldest first. Type in **Leave a comment** and press **Comment** (⌘↵) to post one to the tracker.

## Tasks on the phone

The phone app has a **Tasks** tab with the same boards. You can move a task, fix what is out of sync, read and post comments, create an issue in a column, start a session from a task and link a session to a task. The phone holds no tracker tokens: it asks your Mac, so the moonlet app must be open there. See [Pair your phone](/docs/pair-your-phone).
