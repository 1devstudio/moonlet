---
title: Sessions that follow you
description: Your machines share one account, the central host keeps a copy of every session, and a session runs where you work.
group: Mesh
order: 2
tags: [Tailscale]
---

## One account across your machines

Every host linked to the same central host is a **member** of one account. To set one up, see [Add an always-on host](/docs/add-an-always-on-host).

Members keep the same workspaces and sections. Projects match by project identity, the origin plus the root commit, whatever folder they are in. A change on one member reaches the others within seconds, and a member that was offline catches up when it links again. Two workspaces with the same name stay apart, each marked "from studio-mini", until you pick **Merge with…** in the workspace switcher.

The sidebar lists every member's sessions under the shared workspace. A session whose agent runs on another member gets a small host icon at the end of its row, with the tooltip "Running on studio-mini". A session on this Mac shows nothing.

> **Note:** Sessions that follow you are new and not yet tried widely between real machines. Expect rough edges.

## A copy of every session

The member that runs a session's agent is its owner. It keeps a copy on the central host up to date: the worktree, the chat and Claude Code's transcript. After every tool call it sends a **checkpoint**, the files and the transcript up to that call. The copy is read only, and archiving the session removes it.

Only chat sessions are copied in full and moved. A terminal tab running `claude` is not, and plain terminals and their processes, such as a dev server, never move.

## When your Mac goes to sleep

When macbook is about to sleep, its daemon stops its agents, sends a last checkpoint and hands its sessions to the central host, which continues each one from there. A turn that sleep cut off goes on too. The agent is told that its last tool call may not have finished, so it checks before running it again.

A hand-over that could not be sent before sleep goes at the next wake, dark wakes included. When macbook wakes, an agent goes on only if its session is still macbook's.

## Typing on another Mac brings it back

When you type into a session on macbook while it runs on studio-mini, it comes back to macbook. If the agent is idle, it moves at once and your message runs on macbook. If a turn is running, it moves when the turn ends, and a toast offers **Move now**. After ten minutes of waiting, the message goes to where the session runs.

## Pin a session

The session's right-click menu has **Move to This Mac** and **Move to studio-mini**. Choosing one pins the session there: its icon carries a pin, and the tooltip reads "Kept on studio-mini". A pinned session never moves on its own, not on sleep and not on typing. **Unpin** in the same menu ends that.

During a turn, the toast "It moves when the turn ends." offers **Move now**, which cuts the turn off and continues it on the chosen machine with the same note to the agent.

## The phone never moves a session

A message from the phone goes through the central host to the machine that runs the session. Opening or reading a session never moves it either.

Only when the owner has been unreachable for 30 seconds without a sleep notice does the phone offer **Continue on studio-mini**. Pressing it, or sending a message, makes the central host take the session over. A pinned session is never taken over this way.

## Take over anyway

When your Mac has not reached the central host for 30 seconds, the sidebar says "studio-mini is offline since 14:02". For a session the central host runs and this Mac keeps in sync, the session menu offers **Take over anyway**. It asks first, because studio-mini may still be running the agent behind a network split.

Taking over starts a new conversation on this Mac. When studio-mini is back, its work from the gap is saved and this Mac's is kept. A machine that loses a session it went on running saves its changed files to `~/.moonlet/sync-leftovers/` and keeps its conversation as a fork.

## Files that git ignores

In **Settings › Projects › shop**, **Copied between your Macs** lists the files moonlet copies between members although git ignores them: `.env` and `.env.*` by default.

- Patterns use one `.gitignore` line each. `!` lines, absolute paths and `..` are refused.
- Matching files are kept the same in every member's checkout, copied into each new worktree before setup runs, and kept the same between a session and its copies.
- They never enter git. Files over 1 MiB and links are never copied, and at most 200 files and 16 MiB go per worktree.
- When both sides changed a file, the owner's version wins and the other goes to `~/.moonlet/sync-leftovers/`.
- Only the Mac's own app changes the list, so an agent cannot widen it.

**Also to cloud machines** is off by default. See [Cloud workers](/docs/cloud-workers).

## Sign-ins open where you are

Terminals and agents that moonlet starts have `BROWSER` and `GH_BROWSER` set to moonlet's opener. When an agent on studio-mini runs `gcloud auth login`, the browser opens on the machine you used last, and a toast names the machine and session that asked. A sign-in that comes back to `localhost` has that port forwarded from your Mac to the machine running the command.

On the phone, a sign-in with a one-time code, such as `gh auth login --web`, shows as a card with **Open** and **Copy code**. One that comes back to `localhost` has to finish on a Mac.

**Settings › Machines › Sign-ins** lists `gh` and `gcloud` by default, with each member signed in or not. **Sign in on every member** runs the sign-in on each member that needs it, every browser opening on your Mac, one at a time. Tools' own credentials are never copied between machines.
