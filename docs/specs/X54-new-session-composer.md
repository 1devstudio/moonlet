# X54 — New session composer: a branch row, attachments and source picks

- **Status:** draft (implemented but for the tests named open below; directory chips unchecked in the app)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X5 (composer), X29 (plus menu), X46 (start from a task), X50 (boards)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)

## Summary

The new-session composer put everything in its header: the project, `⋯`, the task chip, the task's branch, a from-ref chip, a PR chip, directory chips and an issue number, all next to the GitHub picker. Started from a task, the header overflowed, and the task's description filled the prompt, so what the user typed got mixed into the issue text. Picking a GitHub issue only filled an empty prompt, so with a task it silently did nothing.

The composer now has three layers. The header keeps the project, the task chip (which takes the spare width) and the source picker. A 38 px branch row under it holds the git things: the branch and its base, the from-ref, PR and directory chips, branch options and the "session starts" checkbox. The body shows the task's description, a picked issue and a picked PR as folded **attachments** above an empty prompt; Create sends them with what the user typed.

## User journey

1. **From a task.** In Tasks mode the user clicks **Start** on `WEB-279 Remove placeholder side nav menu items from Storefront`. The header reads `moonlet ⌄ | [J] WEB-279 Remove placeholder side nav menu items from Storefront × | (GitHub) ⌄`. The branch row reads `⎇ web-279-remove-placeholder-side-nav-menu-items from main`, then `☑ Move to In Progress` and `⋯`. The body shows one folded attachment, `WEB-279 description sent with your message · In Storefront side nav menu, remove A/B Testing and Security…`, above an empty prompt reading "Anything to add? Leave empty to start from the issue." ⌘↵ starts the session with the issue as its first message.
2. **Pick an issue too.** In the GitHub picker's Issues tab, a hint says "Adds the issue as a second attachment next to WEB-279’s description. It doesn’t replace the task." Picking #57 adds `#57 Terminal flickers when resizing a split · GitHub issue, sent too` under the description, outlined in the accent colour for a moment, with an ×. The branch stays the task's.
3. **Pick a PR.** In the Pull requests tab, a hint says "Picking a PR starts the session on its branch, instead of creating web-279-… from main. The task link stays." Picking #214 turns the branch row green: `PR #214 fix/side-nav-cleanup`, `☑ Move to In Progress` and `× Use task branch`. A second attachment reads `PR #214 description and review comments · Clean up the side nav before the Storefront release`, and the prompt asks "Anything to add? e.g. “Address the review comments”".
4. **No task yet.** Opened from Sessions mode in a workspace with a task source, the task chip is a dashed `+ Link a task` slot. After picking PR #214, whose title carries `WEB-279`, the slot reads `+ Link a task · PR #214 mentions WEB-279 [Link]`. The branch row is the PR row, with `× New branch instead`; there is no checkbox until a task is linked. The session is named after the PR.

## Behaviour and acceptance criteria

### Layout

- [x] The header holds, in order: the project picker, a `|` separator, the task chip or the Link a task slot, and the source picker at its right end. It has no `⋯` and no other chips. (`composer.e2e.ts` puts the branch, its base and branch options in a row of their own; the order seen in the app)
- [x] The task chip shows the tracker's tile (16 px, as in board lists), the key in mono, the title cut with an ellipsis, and × "Remove the task link". It takes the header's spare width. (`tasks-mode.e2e.ts`)
- [x] The branch row is always shown. What it says (`composer.test.ts` branchRow):
  - from a task: the task's branch (a quiet `…` until it is worked out), then `from <base>`;
  - with neither a task nor a pick: `New branch` and `from <base>`;
  - "Start from branch or commit…": `New branch` (or the task's branch) and `from <ref>`, with × to go back to the base;
  - "Use an existing branch…": the branch and `existing branch`, with ×;
  - an adopted worktree (X46): the branch and `existing worktree`;
  - a picked PR: the PR row, below.
- [x] Branch options (`⋯`) sits at the branch row's right end, except on the PR row. Picking "Start from branch or commit…" or "Use an existing branch…" puts the ref field in the branch row itself, and ↵ sets it. (`composer.e2e.ts` asks for a ref inside the branch row)
- [ ] Directories added from `+` (X29) show as chips in the branch row, after the branch, each with ×. The branch name gives way first when the row is full. (No test yet: the folder dialog is the system's, which e2e cannot drive.)
- [x] The "session starts" checkbox (X46) sits in the branch row, left of `⋯`. Its label is short: `Move to In Progress` for Linear, Jira and ClickUp, `Assign to me` for a GitHub issue. The long label (`Move WEB-279 to In Progress and assign it to me`) is its tooltip. (`keepInStep.test.ts` startAction, `tasks-mode.e2e.ts`)

### Attachments

- [x] Started from a task, the prompt is empty and its placeholder reads "Anything to add? Leave empty to start from the issue." The task's description is a folded attachment: `<key> description sent with your message · <first line of the description>`; for a task without a description, `<key> sent with your message · <title>`. (`composer.test.ts` attachments, `tasks-mode.e2e.ts`)
- [x] An attachment unfolds to show its text, Markdown rendered as in the Task tab (X46). It cannot be edited; what the user wants changed goes in the prompt. (`tasks-mode.e2e.ts` unfolds a task's description in the composer)
- [x] Create sends the attachments' texts, in the order shown, then what the user typed, separated by a blank line. With nothing attached and nothing typed, the agent starts with no first message, as before. (`composer.test.ts` firstMessage, `tasks-mode.e2e.ts` starts a session from a task, `composer.e2e.ts` sends a picked PR's description and reviews first) The texts:
  - the task: `<key> · <title>` and the description on the next lines, as before (X46);
  - an issue: `#<n> · <title>`, a blank line, its body, a blank line, its URL;
  - a PR: `PR #<n> · <title>`, a blank line, its description and review comments, a blank line, its URL.
- [x] Picking an issue adds its attachment, `#<n> <title> · GitHub issue, sent too` with a task and `#<n> <title> · GitHub issue` without one, whatever the prompt holds. It is outlined in the accent colour for 1.5 s (seen in the app). × "Remove #<n>" removes it. (`composer.test.ts` attachments, `composer.e2e.ts` adds a picked issue as an attachment)
- [x] The placeholder follows what is attached (`composer.test.ts` placeholder):
  - a task and a PR: "Anything to add? e.g. “Address the review comments”";
  - a task and an issue: "Anything to add?";
  - a task alone, or an issue alone: "Anything to add? Leave empty to start from the issue.";
  - a PR without a task: "What should the agent do on this PR? e.g. “Address the review comments”";
  - nothing: "What do you want to work on?"
- [x] The session's name is the task's title; without a task, the PR's title; without either, the issue's title; else it comes from the prompt as before (X5). (`composer.test.ts` sessionName, `composer.e2e.ts`)

### Source picks

- [x] The source picker's popover ends with a hint for its tab (`composer.test.ts` pickerHint):
  - Pull requests, with a task: "Picking a PR starts the session on its branch, instead of creating <the task branch's first two parts>-… from <base>. The task link stays.";
  - Pull requests, without a task: "Picking a PR starts the session on its branch, instead of a new branch from <base>.";
  - Issues, with a task: "Adds the issue as a second attachment next to <key>’s description. It doesn’t replace the task.";
  - Issues, without a task: "Adds the issue as an attachment, and names the session after it."
- [x] A list that arrives after a switch to the other tab is dropped, so issues never show, or get picked, as pull requests. (`composer.e2e.ts` turns the branch row into the PR row)
- [x] Picking a PR turns the branch row into the PR row, tinted green: the PR mark and `PR #<n>` in the done colour, the PR's head branch, and `existing branch · checks out in a new worktree`. With the checkbox showing, that hint moves into the row's tooltip so the branch keeps its room. (`composer.test.ts` branchRow, `composer.e2e.ts`)
- [x] The PR row ends with `× Use task branch` (tooltip `Back to <task branch> from <base>`) when there is a task, `× New branch instead` (tooltip `Create a new branch from <base> instead`) when not. Either undoes the pick: the PR's attachment goes too. (`composer.test.ts` branchRow, `composer.e2e.ts`)
- [x] Picking a PR adds its attachment, `PR #<n> description and review comments · <title>`. Its × "Don’t send the PR description" removes the attachment and keeps the PR's branch. (`composer.test.ts` attachments, `composer.e2e.ts`)
- [x] The PR's attachment holds its description, its reviews and its comments, both the conversation's and those on lines of code, read through `gh.pr_context` when it is picked. Until they arrive, or if reading fails, it holds the description from the list. (`daemon.rs` a_pr_context_holds_its_reviews_and_comments, `git.rs` pr_context_holds_its_description_reviews_and_comments, `composer.e2e.ts`)
- [x] Only the reviews and comments of the PR's author and of people with a role in the repository (owner, member, collaborator) are sent; minimised comments are not. A last line says how many were left out: `3 reviews and comments by people without a role in the repository are left out.` (`git.rs` pr_context_holds_its_description_reviews_and_comments)
- [x] The session is created on the PR's branch and keeps the PR's number. (`composer.e2e.ts` sends a picked PR's description and reviews first, and starts the session on its branch)
- [x] Esc closes the composer wherever the focus is, also after a pick or an undo took the focused button away. (`composer.e2e.ts` turns the branch row into the PR row)

### Link a task

- [x] Without a task, in a workspace with a task source (the rule of "Link to task…", X46), the task chip's place holds a dashed `+ Link a task` slot. Clicking it opens a search over the workspace's tasks with the link dialog's Suggested and Recent lists, filtered by key or title (X46). Picking a task links it as if the composer had been started from it (its attachment, its branch and the "session starts" checkbox), without changing the project. (`tasks-mode.e2e.ts` links a task from the composer's Link a task slot)
- [x] When a picked PR's title, body or head branch mentions a loaded task's key (X46 key matching), or the PR closes a loaded GitHub issue, or a picked issue's title or body mentions a key, the slot reads `+ Link a task · PR #214 mentions WEB-279` (or `closes`) with a **Link** button that links it in one click. (`composer.test.ts` suggestedTask; seen in the app)
- [ ] In a workspace without a task source, the header has no slot. (No test yet: e2e specs share one world, and a board added by one spec is a source for the next.)

## UI

The designs are "New session from a task", "Composer GitHub source picker open" and "Composer after picking a PR or an issue, with and without a task".

```
╭──────────────────────────────────────────────────────────────────────╮
│ moonlet ⌄ │ [J] WEB-279 Remove placeholder side nav menu items ×  (●)⌄│
├──────────────────────────────────────────────────────────────────────┤
│ ⎇ web-279-remove-placeholder-side-nav-menu-items  from main  ☑ Move to In Progress ⋯ │
├──────────────────────────────────────────────────────────────────────┤
│ ┌ 🗎 WEB-279 description sent with your message · In Storefront… › ┐   │
│ Anything to add? Leave empty to start from the issue.               │
│                                                                      │
│ Opus 5.5 High ⌄  Auto ⌄                                 +  Create ↵ │
╰──────────────────────────────────────────────────────────────────────╯
```

- Dialog: 720 px (at most 90 % of the window), radius 16, `border-strong`, `#1f1f1f`.
- Header: padding 12 px top and bottom, 24 px left, 16 px right; gap 10 px. Task chip: 30 px high, radius 8, `hover` background, 13 px text, padding 8 px left and 6 px right. Source picker button: a 28 px white circle and a 14 px chevron, gap 6 px; `hover` background while open.
- Branch row: 38 px, padding 24 px left and 16 px right, `panel-2` background, a bottom border, 12.5 px `muted` text, gap 8 px; the branch in mono and `fg`, the base in `faint`. The PR row's background is the done colour at 5 %.
- Body: padding 16 px top, 24 px sides, 8 px bottom; 8 px between attachments. An attachment: radius 10, `border`, `panel-2` background, padding 9 px by 12 px, 12.5 px `muted` text with its summary in `fg`, a 13 px icon, › to unfold or × to remove. The prompt fills what the body has left: the body is 168 px tall with the textarea at least 52 px, and the dialog grows when more is attached.
- Footer: padding 20 px sides and 16 px bottom, gap 10 px. Unchanged otherwise.
- Source picker popover: 420 px, as before, with the hint footer: a top border, padding 9 px by 12 px, 12 px `faint` text and a 12 px icon.
- Link a task slot: 30 px high, radius 8, a dashed `border-strong` border, `muted` text; its **Link** button is 22 px high, radius 5, accent at 12 % with `accent-2` text.

## Protocol and RPCs

- `gh.pr_context {path, number}` returns the text a PR's attachment sends: its body, then its reviews (author, state and body), its conversation comments and its review comments on lines (author, `path:line` and body), each cut so the whole stays under 8000 characters, by the PR's author and people whose `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR` only. It runs `gh pr view <n> --json author,body,reviews,comments` and `gh api repos/{owner}/{repo}/pulls/<n>/comments`.
- `session.create` is unchanged: `prompt` carries the attachments, `name` the task's, PR's or issue's title, `pr` the PR's number.

## Data and config

- None new. The composer's choices per project stay in local storage (X5).

## Security considerations

- Issue, PR and comment text is untrusted. Attachments render it as the Task tab does (sanitised Markdown, no raw HTML, `https` links only), and it reaches the agent only as the first message the user sends, after it was shown folded in the composer, as X46 requires for the task's description.
- On a public repository anyone can comment on a PR, and the PR's attachment goes to the agent as instructions. So it carries only the words of the PR's author and of people with a role in the repository; a CONTRIBUTOR (anyone with one merged PR) and a bot without a role are left out, and minimised comments too. The attachment says how many were left out.

## Out of scope

- Editing an attachment's text in the composer.
- More than one picked issue or PR.
- Keyboard navigation in the source picker's list.

## Test plan

- Vitest (`apps/desktop/src/lib/composer.test.ts`): the branch row for each case, the attachments and their labels, the first message, the placeholders, the session name, the picker hints and the suggested task, with literals from the designs. `keepInStep.test.ts` for the short checkbox labels; `tasks.test.ts` for the description in the task's start.
- Rust: `gh.pr_context` output parsed from captured `gh` JSON (`git.rs`), and the RPC through a stub `gh` (`daemon.rs`).
- e2e: start from a task with the description folded and sent, unfold it, and link a task from the slot (`tasks-mode.e2e.ts`); a from-ref, an issue and a PR picked, the PR's attachment removed, the pick undone, and a session created on a PR with its reviews sent (`composer.e2e.ts`).

## Open questions

- None yet.
