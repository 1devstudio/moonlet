---
title: Review and pull requests
description: Read an agent's changes, stage hunks, comment back to the agent, edit files and open a pull request without leaving moonlet.
group: Work
order: 3
---

## The Changes tab

The **Changes** tab in the right panel lists every file the session changed. It has two views:

- **Against main** (or whatever the project's base branch is): everything since the session branched off, including the commits the agent made.
- **Uncommitted**: only the changes not yet committed.

The header reads `N files changed`, with the `+a −d` totals. A toolbar button switches between a **tree**, which nests folders and folds a chain of single folders into one row such as `core / services / console`, and a flat **list** that shows each file's full path. moonlet remembers your choice.

Each row has a coloured status box and its `+a −d` counts. Hover a row to show its stage, unstage and discard buttons. Discarding asks first. The list refreshes as files change on disk.

### Diff tabs

Click a changed file, or press Enter or Space on its row, to open its diff as a tab of the main window, next to the session's terminals and agents. The Changes tab stays on its list. Clicking the same file again switches to its tab.

A diff tab is titled with what it compares, `against main` or `uncommitted`. The same file in the other view opens as a separate tab. A diff can be split or inline. Close a tab with its × or ⌘W.

### Stage and discard hunks

In a diff of uncommitted changes, each hunk has its own stage and discard buttons, so you can keep part of an agent's edit and drop the rest. Discarding a hunk asks first.

### Commit

**Commit…** in the Changes tab opens the Commit dialog. Its "Stage all changes first" checkbox starts as **Settings › Git › Stage all changes before committing** says, which is on by default.

### Markdown files

A Markdown file's diff tab has a **Diff** / **Preview** switch. **Preview** shows the new version of the file, rendered. A deleted file has no switch.

## Comment to the agent

You can answer an agent from the diff, line by line.

1. In a diff, hover the gutter and click the `+`, choose **Comment to agent** from the context menu, or press ⇧⌘M.
2. Write your comment and send it.

moonlet pastes it into the session's agent, the focused one or else the first one running, and presses Enter. The agent reads a line such as `Review comment on src/cart/Cart.tsx:42:`, then the code on that line, then your comment.

If no agent is running, moonlet shows an error and sends nothing. **Preview** in a Markdown diff hides the comment controls.

## Files and the editor

### The Files tab

The **Files** tab is the session's file tree, folders first, with an icon for each file type. Files that git ignores are hidden; the eye toggle shows them, dimmed.

Hover a row for its actions:

- `+` puts `@<path>` into the agent's input, after what you have typed, so you can add several files in a row. With no agent running, a new agent tab opens with it.
- `⌄` opens an **Open in** menu: Finder, which reveals the entry, then your installed editors, and for a folder your installed terminals too. On a remote host it offers VS Code and Cursor.

### Editor tabs

Click a file in the Files tab to open it in an editor tab of the main window. You can type in it straight away.

- A dot on the tab marks unsaved changes. ⌘S saves.
- Closing a tab with unsaved changes asks first.
- If the agent edits the file while its tab is open, the tab shows the new content, unless you have unsaved changes there, in which case it keeps your text.
- Code is coloured with VS Code's grammars, in Dark+ by default. Pick another theme in **Settings › Appearance › Editor and diffs**. It recolours every open editor and diff.

File paths in terminal output, with an optional `:line`, are links. ⌘-click one to open the file at that line.

### Markdown preview

A Markdown file's editor tab has a **Source** / **Preview** switch. Preview renders tables, task lists, highlighted code and Mermaid diagrams, from the editor's current text, unsaved edits included. It runs in a sandbox with no scripts and no remote content, so images from the web do not load.

## Pull requests

moonlet opens pull requests with the GitHub CLI, so `gh` needs to be signed in on the machine that runs the session.

1. Press ⇧⌘P, or click **PR** in the right panel's top bar.
2. The Create PR dialog is filled in from the session's name and its commits. Its "Draft" checkbox starts as **Settings › Git › Open pull requests as drafts** says.
3. Confirm. moonlet runs `git push -u origin HEAD`, then `gh pr create`.

Nothing is pushed until you confirm. For a session linked to a GitHub issue in the same repository, the dialog adds `Closes #<n>` to the body (see [Tasks and trackers](/docs/tasks-and-trackers)).

Once the pull request exists, the PR button opens it in your browser. A pull request's state has one colour everywhere: open is green, merged is purple, closed is red. moonlet re-reads open pull requests every minute, so a merge in the browser or from a terminal shows up within a minute.

### The Checks tab

The **Checks** tab shows the pull request's state, its review decision and its CI checks. It refreshes every 30 seconds while you look at it. Commit statuses, such as a review bot's, count as checks too.

### Stacked pull requests

When the session's pull request is part of a GitHub stack, made with `gh stack`, a chip next to the PR button shows its place, such as `3/5`. Click it to list the stack's pull requests and open one in the browser.

## On your phone

The iPhone app opens a session's changes and pull request too. See [Pair your phone](/docs/pair-your-phone).
