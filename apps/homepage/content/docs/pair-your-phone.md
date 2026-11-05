---
title: Pair your phone
description: Pair the moonlet iPhone app over Tailscale to follow, answer and steer every session of your account away from the desk.
group: Mesh
order: 5
tags: [iPhone, Tailscale]
---

## Before you start

The moonlet iPhone app follows your agents while you are away from the desk. There is no public download yet. You build it from `apps/mobile` in the repository: see the [phone app's README](https://github.com/1devstudio/moonlet/blob/main/apps/mobile/README.md).

The phone reaches your machines over [Tailscale](https://tailscale.com), so it needs Tailscale on the phone and on the Mac, on the same tailnet. Nothing listens on your local network or the internet.

> **Note:** The phone app and the mesh behind it are new and not yet tried widely between real machines and phones. Expect rough edges.

## Pair the phone with the central host

Pair the phone with your central host, the always-on machine of your account. See [Add an always-on host](/docs/add-an-always-on-host) if you have not set one up. The central host keeps a copy of every session, so a phone paired with it reaches every session of the account.

1. In moonlet on that Mac, open **Settings › Machines › Phones**.
2. Turn on **Allow connections from my tailnet**. The page shows the address it listens on.
3. Click **Pair a phone**. The page shows a QR code and the same link as text. The code works once, for 5 minutes.
4. On the iPhone, open the moonlet app, tap **Scan QR code** and scan the code. You can also paste the link and tap **Pair**.

The app says "Paired with studio-mini" and opens the Inbox. The Mac lists the phone under its paired phones.

To take access back, click **Remove** next to the phone on the Mac. Its connection drops at once and its token stops working.

To add another Mac, tap **Pair a Mac** in the phone's **Hosts** tab. The phone also reaches the SSH hosts a paired Mac lists, through that Mac.

## Every session, wherever it runs

The phone lists the sessions of every member of the account. A session that runs on another member ends with "on macbook". The phone's requests for it go through the central host to the machine that runs it, so you chat, answer asks and commit as if you were there.

The phone never moves a session. While you answer from the bus, the session stays where it runs. When macbook is asleep, the row reads "macbook is asleep", and the session shows "macbook is asleep. This is the copy on studio-mini, read only." If the owner is unreachable without having gone to sleep while its session was working, the phone offers **Continue on studio-mini** after 30 seconds. See [Sessions that follow you](/docs/sessions-that-follow-you).

The phone connects to the central host. If the central host is offline, the phone shows that.

## What the phone shows

The tab bar has **Inbox**, **Sessions**, **Tasks**, **New** and **Hosts**.

### Inbox

**Needs you** lists, newest first, everything waiting for you across your machines:

- tool permissions, with **Allow**, **Always** and **Deny**;
- plans, with **Review plan** and **Approve, auto**;
- questions, which open the chat to answer;
- an agent's request to read a terminal's output;
- setup approvals for a copy's or a routing copy's setup, with the exact command, **Skip** and **Run setup**;
- asks from design agents, titled "Design ·" and the design's name.

With **Require Face ID to allow** on, in **Hosts**, allowing, approving and answering ask for Face ID first. Deny never does.

### Sessions

Sessions lists the shown workspace's sessions by section and project, with filters **All**, **Needs you**, **Working** and **Review**. Each row shows its state, branch, diff stat and pull request. A session opens on these tabs:

- **Chat**: the conversation, with asks docked in place of the composer, queued messages and subagents;
- **Terminal**: the session's shells as command blocks, with a key bar;
- **Changes**: the diff against the base or HEAD, staging and commits, and a long press on a line to comment to the agent;
- **PR**: the pull request and its checks, a button that asks Claude to fix a failing check, or a form to create one;
- **Jobs**: the session's [heavy commands](/docs/heavy-commands), shown once it has any, with their output and **Stop**.

### Tasks

Tasks shows the boards the Mac shows in Tasks mode, with each task's sessions live. You can move a task, fix what is out of sync, read and post comments, create an issue in a column and start a session from a task. The phone holds no tracker tokens: the moonlet app on a Mac does the work. A move made while moonlet is closed on the Mac waits for it. See [Tasks and trackers](/docs/tasks-and-trackers).

### New and Hosts

**New** starts a session: the task, the project, the agent, the model, the mode and the base branch. **Hosts** lists your paired Macs and the SSH hosts reached through them, with their status.

## What the phone does not do yet

- No push notifications.
- Design systems and designs stay on the Mac.
- A session that another member runs offers no new terminal, no jobs and no pull request creation from the phone.
