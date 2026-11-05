---
title: Introduction
description: What moonlet is, and the words it uses for the things you work with.
group: Start here
order: 1
tags: [Overview]
---

## What moonlet is

moonlet is a terminal for macOS built around coding agents. You describe a task, and moonlet starts an agent on it in its own git worktree, on its own branch. You see what every agent is doing, review its changes and open a pull request without leaving the app.

moonlet is free and open source, under the MIT or Apache 2.0 license. It is in early development (version 0.1), so expect rough edges and breaking changes between releases.

## Workspaces, projects and sessions

moonlet uses a few words the same way in the app, the command line and these docs.

- **Workspace.** A named, coloured scope such as "Personal" or "Acme". The sidebar shows one workspace at a time, and the switcher moves between them. Each workspace has its own sections, sessions and Claude profile, so a work subscription and a personal one never mix.
- **Section.** A named set of projects inside a workspace, shown as one collapsible block in the sidebar. A project can be in more than one section, and in more than one workspace.
- **Project.** A git repository folder, on this Mac or on a remote host.
- **Session.** One piece of work inside a project: a git worktree on its own branch, plus the agents and shells working in it. You start one from the composer, "What do you want to work on?".
- **Terminal.** One terminal owned by the `moonletd` daemon: an agent, a shell or a run script. A session has one or more.

The daemon owns every terminal, so closing the app does not end your sessions. When you open it again, each terminal comes back with its screen and scrollback. A daemon upgrade hands the running terminals to the new binary.

Shell terminals start in **Blocks** mode: each command shows as a block with its output, its exit status and its timing, under one input editor. **Classic** keeps your shell's own prompt.

The [glossary](/docs/glossary) lists every term.

## Agents

An agent is the program running in an agent terminal.

- **Claude Code** and **Codex** are built in. Their tabs show a conversation: messages, thinking, tool calls with their output and diffs, and permission requests as buttons. **Open in terminal** opens the same conversation in the agent's own terminal interface.
- **Custom agents** are commands you name in a project's `.moonlet/config.toml`, under `[agents]`. You pick them like the built-in ones. See [Project config](/docs/project-config).

moonlet starts agents in your login shell, so it uses the `claude` and `codex` on your `PATH`.

### Agent states

Agent hooks tell moonlet what each agent is doing. You install them once, from Settings or with `moonlet hooks install` (see [Your first session](/docs/your-first-session)).

| State | What it means | In the sidebar |
|---|---|---|
| working | The agent is on a turn. | a spinner |
| needs input | It waits for you, for example to allow a tool. | a pulsing ⚠ |
| done | It finished its turn. | ✓ |
| failed | It stopped with an error. | ✗ |
| idle | It is not on a turn. | nothing |

A session row shows its most urgent agent. When an agent needs you, finishes or fails while moonlet is not focused, you get a macOS notification. The dock badge counts the sessions with an agent that is blocked or failed and that you have not looked at. The top of the ⌘K palette lists every blocked or failed agent, on every host, with the agent's own message. Pick one to jump to it.

Without hooks, moonlet guesses: output marks an agent working, and 4 seconds of silence mark it idle.

## Beyond one Mac

### One mesh of machines

moonlet treats the machines you own as one **account**: your MacBook, an always-on Mac mini or Linux machine that acts as the **central host**, and your iPhone. They reach each other over your [Tailscale](https://tailscale.com) tailnet and pair once, with no SSH keys or port forwarding.

- Every member of the account keeps the same workspaces and sections.
- The machine running an agent sends the central host a checkpoint of the worktree and the transcript after every tool call.
- Close the MacBook's lid and the central host carries on from the last checkpoint. Type into the session on another Mac and it moves there once the current turn ends.
- Commands you mark as heavy, such as a test suite, run on the least busy machine, or on a cloud machine that moonlet creates for the job.

Start with [Add an always-on host](/docs/add-an-always-on-host), then read [Sessions that follow you](/docs/sessions-that-follow-you), [Heavy commands](/docs/heavy-commands) and [Cloud workers](/docs/cloud-workers).

> **Note:** The mesh features are new and not yet tried between real machines. Expect rough edges there.

### Your phone

The moonlet iPhone app pairs by scanning a code. It lists every session of the account, wherever it runs, answers permission prompts and plans, and opens any session's chat, terminal, changes and pull request. See [Pair your phone](/docs/pair-your-phone).

### Design mode

Work out what a screen should look like before an agent writes the code. An agent writes your project's design system as static HTML and CSS, and a design agent builds prototypes on it. See [Design mode](/docs/design-mode).

### Tasks

moonlet connects to Linear, Jira Cloud, ClickUp and GitHub Issues. Tasks mode shows a tracker's board with the sessions and pull requests working on each issue, and **Start** on a card opens the composer with the issue attached. See [Tasks and trackers](/docs/tasks-and-trackers).

## Where to go next

1. [Installation](/docs/installation): download the app.
2. [Your first session](/docs/your-first-session): add a project and start an agent.
3. [Project config](/docs/project-config): setup and run scripts, the base branch, custom agents.
4. [Review and pull requests](/docs/review-and-pull-requests): read, stage and comment on an agent's changes.

To script moonlet, see the [command line](/docs/command-line) and the [socket protocol](/docs/socket-protocol). What each feature does, and how far along it is, is in the [feature specs](/docs/feature-specs).
