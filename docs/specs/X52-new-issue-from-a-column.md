# X52 — New issue from a column

- **Status:** approved (2026-10-18)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X50 (boards), X44 (task trackers), X45 (Tasks mode), X46 (tasks in sessions)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)

## Summary

A board column's `+` creates an issue in the tracker, in that column. The design's Linear board shows a `+` in each column header. X50 left creating tasks out; the user decided on 2026-10-18 to build it, for every tracker a board can show: Jira, Linear, ClickUp, and GitHub repositories and Projects. The form asks for a title, a description, an assignee and labels. Once the tracker has the issue, its card shows in the column and its detail opens, so starting a session on it is one click away.

## User journey

1. On a board, the user clicks `+` in a column's header, such as **QA**.
2. **New issue in QA** opens over the board. Title is focused. Description, Assignee (the user, at first) and Labels are below it. A Jira board also asks for the issue type, and a board whose issues can come from several places asks where the issue goes: a Jira project, or for a GitHub Project, a repository.
3. The user types a title and presses **Create** (or ⌘↵).
4. moonlet creates the issue in the tracker, puts it in the column's status, and closes the dialog. The card shows in QA, selected, with its detail open.

## Behaviour and acceptance criteria

### Where the `+` shows

- [ ] Each shown column of a board has a `+` button in its header, labelled `New issue in <column>`. It is always in the tab order and visible on keyboard focus; with a pointer it shows on hover of the column, and always on a touch screen. A folded column, a hidden one, and a GitHub repository board's Closed column have none. (Partly: Linear boards only so far; the other trackers follow. A locked `+` stays in the tab order (`aria-disabled`). `newIssue.test.ts` shows on a shown column, creating in its first status; not on a folded or hidden one, or a repository's Closed, shows on the boards of the trackers moonlet creates issues in: Linear so far; `task-trackers.e2e.ts` creates an issue from a column's +, in that column, its card selected with its detail open (X52). Touch and keyboard focus are seen in the app.)
- [ ] The `+` is disabled, its label saying why, while the connection needs attention (X44), and on a GitHub board whose host is offline. (Partly: the GitHub host's state is not wired yet, as GitHub boards have no + so far. `newIssue.test.ts` is disabled, saying why, while the tracker needs attention, its GitHub host is offline, or a Project lacks gh's project scope)

### The form

- [ ] **New issue in `<column>`**, with the board's name under it, has:
  - **Title**, required, focused.
  - **Description**, Markdown, optional.
  - **Assignee**: the user at first; a menu of the people the tracker lets the issue be assigned to, and **Unassigned**.
  - **Labels**, prefilled with the board's label filter (X50 Issues) so the new issue matches it: the tracker's labels to pick from. Jira's are free text, one word each (Jira refuses spaces).
  - Jira only: **Issue type**, the project's standard types (sub-task and epic types left out), Task first when there is one.
  - Where the issue's place is not the board's one place, **Project** or **Repository**:
    - a Jira board: the projects of the board's filter, from the issues the board shows, the most common first;
    - a JQL board: the projects of its issues, the most common first;
    - a GitHub Project: the workspace's repositories, then those of the Project's items. (Partly: no Project, Repository or Issue type field yet; they come with Jira and GitHub. `newIssue.test.ts` starts the form assigned to the user, with the board's labels, so the issue matches the board)
- [ ] Jira: fields Jira requires on its create screen that the form does not have make the form say `Jira also requires <field>; create it in Jira` with an Open in Jira link, before the user types. A field the form has but the create screen lacks (such as Assignee) is left out of the form.
- [ ] **Create** is disabled until there is a title, and while the tracker is asked. ⌘↵ creates; Escape closes without creating. (Partly: ⌘↵ and Escape are seen in the app; React components have no unit tests. `newIssue.test.ts` creates once there is a title, the place and the Jira issue type it needs, and not while asking; `task-trackers.e2e.ts` creates an issue from a column's +, in that column, its card selected with its detail open (X52))
- [ ] The lists the form shows (places, people, labels, issue types, required fields) are read each time it opens, as X50's Add a board reads its lists; until they arrive each field offers only the user's own choice (Assignee: the user or Unassigned; Labels: the prefilled ones). A list the tracker won't give leaves its field that way. (Partly: people and labels only so far; seen in the app.)

### Creating

- [ ] **Jira:** `POST /rest/api/3/issue` in the project with the type, summary, description, assignee (account id) and labels.
  - The description becomes Atlassian document format: paragraphs, line breaks, bold, italics, inline code, code blocks, links and bullet lists; anything else stays as text.
  - The target status is the first status in the column that the project's workflow has. When Jira creates the issue in another status, moonlet moves it there with a transition that leads to it; when none does, the issue stays where Jira put it and the notice says `Created MOON-142 in To Do; Jira has no way to move it to QA from there`.
  - On a board that follows its active sprint, the issue is added to that sprint. (Not yet: a later X52 pull request.)
- [ ] **Linear:** `issueCreate` in the team with the state of the column's first status (by name, resolved to its id), title, description, assignee and labels. On a board that follows its active cycle, the issue is added to it. A refused label combination (an exclusive label group) shows Linear's message. (Partly: the fixtures are SCHEMA until the Linear sandbox is captured. `linear.rs` a_teams_people_labels_states_and_active_cycle_for_a_new_issue, a_new_issue_goes_in_the_columns_state_with_its_assignee_labels_and_cycle, the_created_issue_as_a_board_issue; `task-trackers.e2e.ts` creates an issue from a column's +, in that column, its card selected with its detail open (X52))
- [ ] **ClickUp:** `POST /list/{id}/task` with the column's first status, the name, the description as Markdown (`markdown_content`), the assignee (a list member's id) and tags (the space's). (Not yet: a later X52 pull request.)
- [ ] **GitHub repository board:** the issue is created in the board's repository through the issues API (`POST /repos/{owner}/{repo}/issues`, which answers with its number and node id) with the title, body, assignee and labels. Only the Open column has a `+`. Without triage access GitHub drops labels and assignees silently, so the form offers them only when gh's user can set them. (Not yet: a later X52 pull request.)
- [ ] **GitHub Project board:** the issue is created in the chosen repository as above, added to the Project (`addProjectV2ItemById`), and its Status set to the column's option. In No Status, the Status is left empty. Creating needs gh's `repo` scope; adding it to the Project needs `project`, and without it the `+` is disabled with the State menu's line (X50). A Project workflow that sets the Status of added items runs after moonlet sets it; the card then shows where the Project put it. (Not yet: a later X52 pull request.)
- [ ] A refusal before the issue exists (a label the repository lacks, a missing permission, a rate limit) shows the tracker's message in the dialog, which stays open with what was typed. A failure after the issue exists (the move, the sprint, or adding it to the Project) closes the dialog and says what was done and what was not, such as `Created acme/web#57; adding it to the Project failed: <message>`. (Partly: Linear's refusals; no test shows the form keeping what was typed. `tasksStore.test.ts` says at once when the board can't show it, and keeps the form open on a refusal)

### After creating

- [x] When the board shows the new issue, its card shows in the column at once, selected, with its detail open. A sync that started before the create, and ends after it, keeps the card; the next sync replaces it with the tracker's own copy. (`tasksStore.test.ts` creates it in the column's state, shows its card selected with Activity, and keeps it through a sync that started before it; `newIssue.test.ts` keeps a new issue on its board through a sync that started before it, and lets a later sync that lacks it say the board doesn't show it; `task-trackers.e2e.ts` creates an issue from a column's +, in that column, its card selected with its detail open (X52))
- [ ] When the board does not show it, because of its Assignee (an Assignee: me board and someone else picked), its filter or query, or a hidden column it ended up in, a notice says `Created MOON-142; this board doesn't show it`, with an Open link to the issue in the tracker. (Partly: the Open link is seen in the app. `newIssue.test.ts` knows when the board can't show the new issue: someone else's on an Assignee: me board, outside its labels, or in a hidden column; `tasksStore.test.ts` says at once when the board can't show it, and keeps the form open on a refusal, creates it in the column's state, shows its card selected with Activity, and keeps it through a sync that started before it)
- [x] Its Activity starts with `moonlet created it`. (`tasksStore.test.ts` creates it in the column's state, shows its card selected with Activity, and keeps it through a sync that started before it)
- [ ] Putting it in the column is moonlet's own move: a session started on it before the next sync raises no "moved outside moonlet" notice (X44). (Not yet tested: creating records the column as moonlet's own move, as Keep in step's moves are, so a different state at the next sync is reported only if the tracker changed it.)

## UI

- The `+` sits in the column header, after the count, as the design's Linear board shows it.
- The dialog is the size of the link dialog (X46), with the fields stacked. Assignee and Labels are `Menu`s with search. A long list of people or labels scrolls.
- States: lists loading (fields offer the user's own choice until they arrive), creating (Create reads `Creating…`), refused (the tracker's message above the buttons).
- A board's `+` follows its saved columns, so a board shows it once its first sync has saved them.

## Protocol and RPCs

- Tauri commands (the app talks to trackers, ADR 0010):
  - `tracker_create_options(id, place)`: the people, labels, and for Jira the project's issue types and the create screen's required fields. `place` is a Jira project key, a Linear team key or a ClickUp list id.
  - `tracker_create(req)`: `{ id, place, title, description, assignee, labels, issueType?, status, sprint? }`, returning the issue as a board issue, and what of the move or sprint did not happen.
- Daemon RPCs, for GitHub through gh on the workspace's host:
  - `gh.create_options { repo }`: assignable users, labels, and whether gh's user can set them.
  - `gh.issue_create { repo, title, body, assignee, labels }`: number, url and node id.
  - `gh.project_add { project, content }`: the new item's id.
  - The Status is set with the existing `gh.project_move`.

## Data and config

Nothing new in `trackers.toml`. The lists the form reads are not kept after it closes.

## Security considerations

- The title, description and labels go to the tracker as data, in JSON bodies or as separate `gh` arguments, never through a shell.
- A repository picked for a GitHub Project comes from the workspace's projects or the Project's items, and is checked as `owner/repo` before gh is run.

## Out of scope

- Creating sub-issues or epics; setting priority, estimate, due date or components.
- Jira fields the form does not have, beyond saying they are required.
- Templates (Jira's or GitHub's issue forms).
- Creating from anywhere but a column's `+`, such as the List or a keyboard shortcut.
- Drafts: a GitHub Project draft item is not created; the issue always lives in a repository.

## Test plan

- Rust: each tracker's create request body and its answer, the description's conversion to Atlassian document format, and the Jira create screen's required fields, from captured responses where moonlet can capture them without writing to a team's tracker, otherwise built from the tracker's API reference and marked SCHEMA in the fixtures README.
- Vitest: which columns have a `+`, the form's defaults (the board's labels, the user as assignee, the place's choices in order), Create's gating, the target status per place, the card placed and selected after creating, a sync in flight keeping it, and the notices for an issue the board doesn't show and for a partial failure.
- e2e: create an issue from a Jira board column, a Linear column and a GitHub Project column against the fake Jira and Linear servers and the fake gh; the card shows in the column with its detail open.

## Open questions

- **Captured fixtures.** Creating an issue writes to a real tracker. Capturing real create responses needs a sandbox: a Linear team, a ClickUp list, a GitHub repository and Project the user is happy to have test issues in. Jira's would be built from its reference, since the connected site is the user's employer's.
