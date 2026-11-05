---
title: Design mode
description: Build a design system from your project's code, then prototype screens on it with an agent before any code is written.
group: Work
order: 1
tags: [Claude Code]
---

## What Design mode is for

Design mode is the third sidebar mode, next to Sessions and Tasks. You use it to work out what a UI should look like before writing code, without running the project. Press ⌃⌘D, or click the pen icon in the sidebar's mode switch.

It has two parts:

- A **design system**: your project's UI as the code has it, written as static HTML and CSS.
- A **design**: a prototype made of plain HTML pages that use one design system.

## Design systems

An agent reads your project's source and writes its design system. The source projects stay read only: the agent writes nothing in them. A design system belongs to a workspace, so every project and design in that workspace can use it.

A design system holds:

- your project's tokens, copied as they are
- **foundations**: colours, type and spacing, generated from the tokens
- one **card** per component, with each variant as a labelled example
- the elements only your project has, in the **Custom** group
- **layouts**: whole screens built from the cards

Each variant on a card is also a **snippet** that a design can insert. Because the cards are plain HTML, this works with any stack.

### Build one

1. In Design mode, click `+` beside **Design systems**.
2. In **New design system**, give it a **Name** and pick the projects under **Built from the code of**. A project can be a folder of a repository, such as `apps/web`.
3. Choose **What to cover**: the components that matter most, all of them, or none yet.
4. Click **Build design system**.

The sync agent works in four steps: **Inventory**, **Tokens**, **Cards** and **Layouts**. A step bar shows each step's result, and the card being written is marked **Rewriting**. The agent's chat is docked on the right, with **Hide agent** and **Stop sync**.

moonlet checks each card by rendering it, then the agent grades it before moving on. A component the agent has not written yet gets a floor card that says "Preview not yet authored", never a fake render.

If the agent needs you, for a question the code cannot settle or an approval, the step bar reads **Needs you** and you get a notification. Answer in the docked chat and the sync goes on.

### Keep it in sync

When the code changes, the header names the sources that changed since the last sync. **Sync** runs the agent again, and it rewrites only the cards whose source changed. A change to styles or docs alone makes no card out of date.

After a sync, a green bar sums up what happened. **Needs you** lists what is left to settle:

- A card you edited by hand is never overwritten. You see yours and the synced version side by side, with **Keep mine** or **Use synced**.
- A card whose source was deleted is orphaned, with **Keep for now** or **Remove card**.

Open a card to see where it was made from, its check problems with **Ask the sync agent to fix**, and its snippets.

## Designs

A design lives in one of three places:

| Kind | Where it lives | Who writes it |
|---|---|---|
| Workspace design | `~/.moonlet/design/`, no branch | its own agent |
| Session design | the session's worktree, under `docs/design/` | the session's agent |
| Project design | `docs/design/` on the project's base branch, after the PR merged | read only |

### Start a workspace design

1. In Design mode, click **New design** (⇧⌘N).
2. Give it a name, pick a design system and write a brief.
3. Press **Create design** (⌘↵).

The agent reads the design system and writes the pages. The **canvas** shows them live at the viewport you pick: Desktop, Laptop, Tablet, Phone or a custom size. **Overview** shows every page side by side.

### Iterate

You can iterate in three ways, and mix them:

- **Chat** with the agent.
- **Comment.** In Comment mode (C), click an element, type a comment and press **Send** (⌘↵). It goes into the chat and stays on the canvas as a pin. **Keep** saves it without sending.
- **Edit by hand.** In Edit mode (V), select an element and drag to move it, resize it, restyle it in the Inspector, edit its text, or insert components from the Palette. A chip counts your edits, and they go to the agent with your next message.

Edit is locked while the agent is working. Comments still work.

### History

Every agent turn and every burst of hand edits is a **snapshot**. Open History, pick a snapshot to preview it read only, then **Back to current** or **Restore**.

## From prototype to pull request

**Build it** in a workspace design's header opens the New session composer. The design's pages and styles are attached, and creating the session copies the design into it as a session design.

Inside a session, type `/moonlet-design` followed by a brief. The session's agent makes a session design in the worktree under `docs/design/`, and the session gets a **Design** tab beside Changes, Files and Plan. Comments and hand edits there go into the same session chat.

From there the flow is design, then spec, then code:

1. Ask the agent to write the spec from the design.
2. **Implement it**: the agent writes the code and opens the PR.
3. The Changes panel groups the files as **Design**, **Spec** and **Code**. Comments and snapshots are not committed.

The prototype, its spec and the code ship in the same pull request. After the merge, the design shows under **In projects**, where **Use as a start** copies it into a new workspace design.

The slash menu also offers `/moonlet-design new`, which starts a separate workspace design, and `/moonlet-design sync`, which syncs the project's design system.

## On every machine

If you use moonlet on more than one Mac, every member of your account keeps a copy of each design system and workspace design. See [Sessions that follow you](/docs/sessions-that-follow-you).

The agent runs on one member, the owner. Other members show a read-only copy, marked "from studio-mini", that stays up to date and stays readable while the owner is offline. **Move here** makes the Mac you are on the owner, so the agent runs there from then on.

> **Note:** Rendering cards for the agent needs the moonlet app open on the owner.
