# X66 — Task comments

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X44 (task trackers), X45 (Tasks mode), X46 (tasks in sessions), X50 (boards)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)

## Summary

A task's column shows the comments its tracker holds, and takes a new one. Until now moonlet only wrote comments (the PR-link comment of Keep in step, X46) and X45 left the tracker's own comments out. The Comments section sits at the end of both places a task is shown in full: the Task detail beside a board in Tasks mode (X45) and the Task tab of a linked session's right panel (X46). It works for every tracker moonlet connects: Linear, Jira, ClickUp and GitHub issues.

## User journey

1. In Tasks mode the user selects `ENG-124`. The Task detail ends with **Comments 3**: Ada Lovelace "2 h ago", her comment rendered as Markdown, then two more, oldest first.
2. The user types "Picked this up, PR later today" in the box under them and presses ⌘↵. The comment is posted to Linear, shows last in the list, and the box empties.
3. The user opens a session linked to `ENG-124`. Its Task tab shows the same comments at the end, with the same box.
4. Linear is offline: the section says "Couldn't load comments: <Linear's message>" with **Retry**. A comment that fails to post stays in the box, with the error under it; **Comment** sends it again.

## Behaviour and acceptance criteria

### Reading

- [ ] The Task detail (Tasks mode) and the Task tab (a linked session) end with a **Comments** section headed `Comments <n>`, `<n>` being the comments shown.
- [ ] Each comment shows its author, how long ago it was written (`just now`, `5 min ago`, `2 h ago`, `3 days ago`, the full date and time on hover) and its body. Comments are listed oldest first, so the newest sits just above the box.
- [ ] A Linear, Jira or GitHub comment's body is shown as Markdown, rendered as the task's description is (X46: sanitized, checklist items as boxes, images as links, HTML comments left out). A Jira comment's rich text is turned into Markdown as its description is. A ClickUp comment is shown as its plain text, line breaks kept.
- [ ] The author is the tracker's display name: Linear's user name (or the bot's name for an integration's comment), Jira's `displayName`, ClickUp's `username`, and GitHub's `@login`. A comment with no author reads "Someone".
- [ ] A GitHub comment that is hidden (minimized) on GitHub is not shown.
- [ ] moonlet reads at most 100 comments of a task (the newest, where the tracker lets it choose). When the tracker has more, the section ends with "More comments are in <tracker>", linking to the issue.
- [ ] While the first load runs, the section reads "Loading comments…"; a task with none reads "No comments yet."
- [ ] A load that fails shows "Couldn't load comments: <the tracker's message>" with **Retry**, which loads them again.
- [ ] Comments are loaded when the task is shown, again when a sync (X44) sees the task's updated time change, and again after the user posts one. Showing a task whose comments were loaded before shows those at once while they load again.

### Posting

- [ ] Under the comments, a box (placeholder "Leave a comment") and a **Comment** button post its text to the tracker as a comment on the issue. ⌘↵ in the box does the same. Empty or blank text posts nothing: the button is disabled.
- [ ] What the user types is Markdown: Linear and GitHub take it as it is; Jira gets it as rich text, converted as a new issue's description is (X52); ClickUp gets it as the comment's text.
- [ ] While a comment is posted, the box and button are disabled. Once the tracker takes it, the box empties and the comments load again, so the new one shows last. Activity (X45) records "You commented".
- [ ] A comment the tracker refuses stays in the box, and the tracker's message shows under it; pressing **Comment** again sends it again. Nothing is posted again by itself.
- [ ] A GitHub issue's comment is posted by `gh` on the host whose project has the issue's repository as its origin (as X46's assign does); with no such project the error says so.

## UI

The section is the last block of the Task detail (after Activity) and of the Task tab (after Link to another task / Unlink).

```
Comments 3
Ada Lovelace · 2 h ago
  Looks good. Can we **also** cover ClickUp?
Sam Rivera · 1 day ago
  …
More comments are in Linear ↗            (only when there are more than 100)
┌───────────────────────────────────┐
│ Leave a comment                   │
└───────────────────────────────────┘
                          [Comment ⌘↵]
```

States: loading ("Loading comments…"), empty ("No comments yet."), load failed (message + Retry), posting (box disabled), post failed (message under the box).

## Protocol and RPCs

- Tauri `tracker_comments {id, task}` (`task` is the issue's id in the tracker) → `{comments: [{id, author, body, markdown, createdMs}], more}`: Linear `issue(id).comments(first: 100)`, Jira `GET /rest/api/3/issue/{key}/comment?orderBy=-created&maxResults=100`, ClickUp `GET /task/{id}/comment` (pages of 25 through `start`/`start_id`, up to 4). Sorted oldest first in Rust, whatever order the tracker answers in.
- Tauri `tracker_comment {id, task, text}` posts one comment: Linear `commentCreate`, Jira `POST /rest/api/3/issue/{key}/comment` with `adf::from_markdown`, ClickUp `POST /task/{id}/comment`.
- Daemon `gh.issue_comments {path, number}` → `{comments: [{id, author, body, created_ms}], more}`, from `gh issue view <n> --json comments`; `gh.issue_comment {path, number, body}` runs `gh issue comment <n> --body-file -` with the body on stdin.

## Data and config

Nothing stored. Loaded comments live in the app's memory for the session, keyed by task.

## Security considerations

- Comment bodies and author names come from the tracker and are untrusted. Names are plain text; bodies are sanitized Markdown as descriptions are (X44), or plain text for ClickUp.
- Posting a comment is outward-facing: it happens only when the user presses Comment or ⌘↵, never by itself, and a failed post is never retried unasked.
- A comment's body reaches `gh` on stdin, never as an argument.

## Out of scope

- Editing, deleting, resolving or reacting to comments; threads (a reply is listed with the rest, by time).
- Mentions and attachments in the box.
- Jira comment visibility (a comment limited to a role shows for whoever the token can read it as).
- Comments on the phone app (X40).

## Test plan

- Rust (`moonlet-trackers`): parsing each tracker's comments from fixtures (order, author fallbacks, ADF to Markdown, `more`), the Jira and Linear post bodies. `moonlet-core` `git.rs`: parsing `gh issue view --json comments` (captured), minimized ones left out.
- Vitest (`lib/taskComments.test.ts`): the section's lines (heading, ago, empty, more), the store's load/reload/post/failure flow against a test double of the commands.
- e2e (`tasks-mode.e2e.ts`) with the fake `gh`: a GitHub issue's detail shows its comment, and posting one sends it to `gh` and lists it.

## Open questions

- None yet.
