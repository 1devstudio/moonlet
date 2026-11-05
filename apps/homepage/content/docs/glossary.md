---
title: Glossary
description: The terms moonlet uses in the app, the docs and the protocol.
group: Reference
order: 3
---

## How to read this page

These terms mean the same thing in the app, the docs and the protocol. The full list, with the names used in the code, is in [CONTEXT.md](https://github.com/1devstudio/moonlet/blob/main/CONTEXT.md).

## Work

| Term | Meaning |
|---|---|
| **Workspace** | A named, coloured scope such as "Personal" or "Acme", with its own sections, sessions and Claude profile. The sidebar shows one workspace at a time; the switcher moves between them. |
| **Section** | A named set of projects inside a workspace, shown as one collapsible block in the sidebar. A project can be in more than one section, and in more than one workspace. |
| **Claude profile** | A Claude Code config folder with its own login, settings, MCP servers and history. Each workspace uses one; the default is `~/.claude`. |
| **Project** | A git repository folder on disk, on this Mac or on a remote host. |
| **Session** | One piece of work inside a project, in one workspace: a git worktree on its own branch, plus the agents and shells working in it. You create one from the composer ("What do you want to work on?"). |
| **Project identity** | What makes two folders on different hosts the same project: the repository's origin and its first commit, never its path. |

## Terminals and agents

| Term | Meaning |
|---|---|
| **Terminal** | One terminal owned by `moonletd`: an agent, a shell or a run script. A session has one or more terminals. |
| **Block** | One command run in a shell terminal: the command line, its output, its exit status and timing. The block of a command still running is the active block. |
| **Blocks mode** | How a shell terminal works by default: the shell draws no prompt, the input editor is the only input, and each command shows as a block. Its opposite is **Classic**, where the shell keeps its own prompt and you type into the terminal. |
| **Agent** | The program running in an agent terminal: Claude Code, Codex, or a custom command. |
| **Subagent** | An agent that a chat's agent launches to work on part of the task in the background. Listed in the Agents tab. |
| **Queued message** | A message sent while the agent works, which it has not read yet. Claude reads it when the running step ends; **Send now** asks Claude to read it at once. |
| **Aside** | A side question answered from a chat's conversation by a separate Claude with no tools, without touching the running turn or being added to the session. Claude Code's `/btw` in the terminal. |

## Machines

| Term | Meaning |
|---|---|
| **Host** | A machine running `moonletd`: this Mac, or a remote host reached over the tailnet (paired once) or over SSH. |
| **Tailnet access** | A host's setting "Allow connections from my tailnet": its daemon listens on its Tailscale addresses, and paired devices connect there. |
| **Paired device** | A phone or a Mac that has paired with a host once and holds its token. A Mac paired with a host reaches it as a tailnet host. |
| **Central host** | The always-on host that phones pair with and that relays the account's changes between its members. |
| **Account** | The hosts one user has set up, linked to one central host, that share the account state. A host outside it, such as an SSH host, keeps its own workspaces. |
| **Member** | A host of an account: it keeps the whole account state and can run sessions. Cloud machines are never members. |
| **Account state** | What every member of an account keeps in step: its workspaces and sections, with their projects by project identity. |
| **Worker** | A host linked to a central host: it holds live copies of the central host's sessions and lends its CPU for heavy commands. A cloud machine is a worker only. |
| **Live copy** | A worker's copy of a session's files: a git worktree kept in sync with the central host both ways ("Keep in sync"). |
| **Routed command** | A heavy command, such as a test run, that an agent on the central host runs and that is carried out on a worker's live copy, with its output and exit status coming back. |

## Tasks

| Term | Meaning |
|---|---|
| **Task** | An issue in a task tracker (a Linear or Jira issue, a ClickUp task, a GitHub issue), shown in Tasks mode with the sessions working on it. A session works on at most one task; a task can have several sessions. |
| **Tracker** | An issue tracker moonlet connects to: Linear, Jira Cloud, ClickUp or GitHub Issues. |
| **Connection** | One signed-in account of Linear, Jira Cloud or ClickUp on one site, such as the Jira site `acme.atlassian.net`. A tracker can have several connections. GitHub Issues has none of its own: it uses `gh`'s login. |
| **Board** | One view of one tracker in a workspace, shown in Tasks mode: a Jira board or JQL query, a Linear team, a GitHub Project or repository, or a ClickUp list. It has the tracker's columns, each with a category (To do, In progress, In review, Done) and shown, folded or hidden; its filter; its sprint or cycle; and which projects its sessions start in. Saved in `~/.moonlet/trackers.toml`. |
| **Tracker project** | One Linear team, Jira project, ClickUp list or GitHub repository. A moonlet project lists the tracker projects whose sessions start in it, in its `.moonlet/config.toml`. |
| **Out of sync** | A task whose tracker state disagrees with its work, such as an issue still in a To do column while a session works on it. Shown as an Out of sync chip with a one-click fix. |

## Design

| Term | Meaning |
|---|---|
| **Design system** | A folder of static HTML and CSS that shows a project's UI as the code has it: tokens, foundations, one card per component, the project's own elements, and layouts. Built and kept in sync by an agent from one or more source projects; it belongs to a workspace. |
| **Card** | One component of a design system as an HTML file, with each variant and state as a labelled example and a snippet. |
| **Snippet** | The markup of one variant in a card, which a design inserts from the component palette. |
| **Design** | A prototype: HTML pages built on one design system, with comments and snapshots. A workspace design has its own agent and no branch; a session design lives in a session's worktree under `docs/design/` and ships with the session's PR; a project design is a merged session design, read only. |
| **Canvas** | The sandboxed frame in Design mode that shows a design's page at a chosen viewport, where you comment and edit by hand. |
| **Off-system** | An element of a design's page with a style value that matches none of its design system's tokens, where the property takes tokens. Allowed, and marked with a dot. |
| **Snapshot** | A copy of a design's pages and assets, taken when its agent ends a turn or edits by hand stop for 10 seconds, if anything changed. The newest 50 are kept. History previews one read only and restores it. |
