# X52 — New issue from a column

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X50 (boards), X44 (task trackers), X45 (Tasks mode), X46 (tasks in sessions)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)

## Summary

A board column's `+` creates an issue in the tracker, in that column. The design's Linear board shows a `+` in each column header. X50 left creating tasks out; the user decided on 2026-10-18 to build it, for every tracker a board can show: Jira, Linear, ClickUp, and GitHub repositories and Projects. The form asks for a title, a description, an assignee and labels. Once the tracker has the issue, its card shows in the column and its detail opens, so starting a session on it is one click away.

## User journey

1. On a board, the user clicks `+` in a column's header, such as **QA**.
2. **New issue in QA** opens over the board. Title is focused. Description, Assignee (the user, at first) and Labels are below it. A Jira board also asks for the issue type, and a board whose issues can come from several places asks where the issue goes: a Jira project, or for a GitHub Project, a repository.
3. The user types a title and presses **Create** (or ⌘↵).
4. moonlet creates the issue in the tracker, puts it in the column's first status, and closes the dialog. The card shows in QA, selected, with its detail open.

## Behaviour and acceptance criteria

### Where the `+` shows

- [ ] Each shown column of a board has a `+` in its header, titled `New issue in <column>`. A folded column, a hidden one, and a GitHub repository board's Closed column have none.
- [ ] Without a connection the tracker accepts (X44's attention state), or for a GitHub Project without gh's `project` scope, the `+` is disabled and its title says why, as the State menu does (X50).

### The form

- [ ] **New issue in `<column>`**, titled with the board's name under it, has:
  - **Title**, required, focused.
  - **Description**, Markdown, optional.
  - **Assignee**: the user at first; a menu of the people the tracker lets the issue be assigned to, and **Unassigned**.
  - **Labels**: the tracker's labels to pick from (Jira's are free text, added as typed).
  - Jira only: **Issue type**, the project's types, its default first.
  - Where the board's issues come from more than one place: **Project** (a Jira board or JQL query over several projects) or **Repository** (a GitHub Project: the workspace's repositories, then those of the Project's items).
- [ ] **Create** is disabled until there is a title, and while the tracker is asked. ⌘↵ creates; Escape closes without creating.
- [ ] What the form lists (people, labels, types, projects) is read when it opens, once per connection and place for the app's session; a list the tracker won't give leaves its field with the user's own choice only (Assignee: the user or Unassigned; Labels: none).

### Creating

- [ ] **Jira:** the issue is created in the project with the type, summary, description (as Atlassian document paragraphs), assignee and labels. If the column's first status is not the one Jira created it in, moonlet moves it there with the transition that leads to it; when none does, the issue stays where Jira put it and the board says `Created MOON-142 in To Do; Jira has no way to move it to QA from there`.
- [ ] **Linear:** the issue is created in the team with the column's state, title, description, assignee and labels.
- [ ] **ClickUp:** the task is created in the list with the column's status, name, description, assignee and tags.
- [ ] **GitHub repository board:** `gh issue create` in the board's repository with the title, body, assignee and labels. Only the Open column has a `+`.
- [ ] **GitHub Project board:** the issue is created in the chosen repository, added to the Project, and its Status set to the column's option. In No Status, the Status is left empty. Creating and adding need gh's `project` scope.
- [ ] A refusal (a required field Jira asks for, a label the repository lacks, a missing permission) shows the tracker's message in the dialog, which stays open with what was typed. A failure after the issue exists (the move, or adding it to the Project) closes the dialog and says what was done and what was not: `Created acme/web#57; adding it to the Project failed: <message>`.

### After creating

- [ ] The new issue's card shows in the column at once, selected, and its detail opens. The next sync replaces it with the tracker's own copy.
- [ ] Its Activity starts with `moonlet created it`.
- [ ] Moving it there is moonlet's own move, so it raises no "moved outside moonlet" notice (X44).

## UI

- The `+` sits in the column header, after the count, as the design's Linear board shows it; it shows on hover and on keyboard focus of the column header.
- The dialog is the size of the link dialog (X46), with the fields stacked. Assignee and Labels are `Menu`s with search. A long list of people or labels scrolls.
- States: lists loading (fields show the user's own choice until they arrive), creating (Create shows a spinner), refused (the tracker's message above the buttons).

## Protocol and RPCs

- Tauri commands (the app talks to trackers, ADR 0010):
  - `tracker_create_options(id, place)`: people, labels, and for Jira the project's issue types.
  - `tracker_create(req)`: `{ id, place, title, description, assignee, labels, issueType?, status }`, returning the issue as a board issue.
- Daemon RPCs, for GitHub through gh on the host:
  - `gh.create_options { repo }`: assignable users and labels.
  - `gh.issue_create { repo, title, body, assignee, labels }`.
  - `gh.project_add { project, content }`: the item id.
  - The Status is set with the existing `gh.project_move`.

## Data and config

Nothing new in `trackers.toml`. The lists the form reads are kept in memory for the app's session.

## Security considerations

- The title, description and labels go to the tracker as data, in JSON bodies or as separate `gh` arguments, never through a shell.
- A repository picked for a GitHub Project comes from the workspace's projects or the Project's items, and is checked as `owner/repo` before gh is run.

## Out of scope

- Creating sub-issues, epics or cycles; setting priority, estimate, due date or sprint.
- Templates (Jira's or GitHub's issue forms).
- Creating from anywhere but a column's `+`, such as the List or a keyboard shortcut.
- Drafts: a GitHub Project draft item is not created; the issue always lives in a repository.

## Test plan

- Rust: each tracker's create request body and its answer, from captured responses where moonlet can capture them without writing to a team's tracker, otherwise built from the tracker's API reference and marked SCHEMA in the fixtures README.
- Vitest: which columns have a `+`, the form's defaults, Create's gating, the place picker's choices, the card placed and selected after creating, and the messages for a partial failure.
- e2e: create an issue from a Linear column and from a GitHub Project column against the fake tracker and fake gh; the card shows in the column and its detail is open.

## Open questions

- **Captured fixtures.** Creating an issue writes to a real tracker. Capturing real create responses needs a sandbox: a Linear team, a ClickUp list, a GitHub repository and Project the user is happy to have test issues in. Jira's would have to be built from its reference, since the connected site is the user's employer's.
