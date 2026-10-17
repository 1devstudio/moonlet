# X50 — Boards

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X44 (task trackers), X45 (Tasks mode), X46 (tasks in sessions), X8 (project settings), X32 (workspaces)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)

## Summary

Tasks mode shows one **board** at a time. A board is a named view of one tracker: a Jira board or JQL query, a Linear team, a GitHub Project or repository, or a ClickUp list. It has the tracker's own columns in the tracker's own order, its filter, its sprint or cycle, which projects its sessions start in, and which fields its cards show. Boards replace X44's sources and X45's fixed Todo / In Progress / In Review / Done columns. moonlet's four groups stay, as each column's **category**, so out of sync, Keep in step and the glyphs work as before. Columns like QA or Ready for Release, which the old board folded into In Review, now show as they do in the tracker.

## User journey

1. The user connects a tracker (X44). The Connect dialog ends with **Add a board** instead of the Sources dialog.
2. **Add a board** has four steps:
   1. **Source:** pick the connection and what the board is built from, such as an existing Jira board.
   2. **Issues:** narrow the issues down and preview how many match.
   3. **Columns:** check each column's category, then Show, Fold or Hide it.
   4. **Finish:** name the board, pick its workspace and the projects its sessions start in, and choose what cards show.

   **Create board** saves it and opens it.
3. The Tasks sidebar lists the workspace's pinned boards under **Boards**. The header's board name opens the **board switcher**, which lists every board of every workspace.
4. The board shows the tracker's columns. A folded column is a narrow strip. A Scrum board or a Linear team that follows the active sprint or cycle names it in the title, with its dates in the subtitle.
5. A column's `⋯` menu or the switcher's **Manage** opens **Board settings**, the same four steps as tabs.

## Behaviour and acceptance criteria

### Boards replace sources

- [ ] A board has a name, a connection, an origin, an issue filter, columns, a workspace, start-in rules, card fields and a pinned flag. It is saved in `trackers.toml` under `[[boards]]`; a setting at its default is not written. (`config.rs` a_jira_board_with_its_columns_rules_and_cards, a_board_written_with_only_its_essentials_takes_the_defaults, a_board_at_its_default_finished_rule_does_not_write_it, every_origin_reads_back)
- [ ] Origins:
  - Jira: `jira_board` (an existing Jira board, by id) or `jql` (a JQL query).
  - Linear: `linear_team` (a team, by key).
  - GitHub: `github_project` (a GitHub Project, by owner and number) or `github_repo` (a repository's issues, as X44 shows them today).
  - ClickUp: `clickup_list` (a list, by id).
- [x] The first time the app opens a workspace after the upgrade, each X44 source of that workspace becomes one board in it. A Jira project becomes a `jql` board `project = <KEY>`, a Linear team a `linear_team` board, a ClickUp list a `clickup_list` board. Each GitHub repository a workspace showed becomes a `github_repo` board. The board is named after the source and pinned. Its columns come from the tracker on the first sync, named as there: the Jira project's statuses, the Linear team's workflow states, the ClickUp list's statuses, GitHub's Open and Closed. Each column's category is the one the connection's state mapping gave its state; a state mapped to Not shown becomes a hidden column. The old sources and `states` are dropped from the file when it is next written. (`boards.test.ts` turns the workspace's sources and GitHub repositories into pinned boards, keeps other workspaces' sources until they open, and drops a connection's states with its last source, migrates a workspace once, so a board removed later stays removed, gives the tracker's states the categories the old state mapping gave them, and hides those not shown; `tasksStore.test.ts` turns the workspace's sources and repositories into boards on its first sync, and saves them)
- [x] A GitHub repository of the workspace's projects gets its board the first time a sync sees it, so one whose origin could not be read at first (a host offline, a remote added later) still gets one; a board removed later stays removed. (`boards.test.ts` gives a repository its board the first sync that sees it, even after the workspace migrated, migrates a workspace once, so a board removed later stays removed)
- [ ] Removing a board asks first. Session links (X46) stay, and so do the sessions themselves.
- [ ] Disconnecting a connection (X44) also removes its boards, and its confirm names them. (Partly: the confirm does not name them yet. `task-trackers.e2e.ts` disconnects after asking: the token and the connection are gone)

### Add a board

- [ ] The wizard is a dialog with four steps listed on the left: Source, Issues, Columns, Finish. A step already done shows a check and can be clicked. The footnote reads "Every choice can be changed later from the board's ⋯ menu › Board settings."
- [ ] **Back** and **Continue** move between steps; the last step has **Create board**. Continue waits until the step is complete: a board picked, or a query that Jira accepts.
- [ ] Each step's footer says what moonlet does with the tracker. Step 1: "moonlet reads the board's configuration; it never changes it in Jira" (or Linear, GitHub, ClickUp). Step 2: "Counts update as you type." Step 3: "Drag to reorder. Order and folding are moonlet-only and don't change <tracker>." Step 4: "Saved to ~/.moonlet/trackers.toml."

#### 1. Source

- [ ] Connections are cards with the tracker's mark, its name and its site (`acme.atlassian.net`, the Linear organisation, `via gh login`, the ClickUp workspace). GitHub is always offered.
- [ ] **Jira:** "Build the board from" offers **An existing Jira board** or **A JQL query**.
  - Existing board: Jira's boards are listed with key, name and type (Scrum, Kanban or Team-managed) (`jira_board.rs` the_boards_a_connection_can_show). One that is already a board in this workspace is marked "Already added" and cannot be picked. The picked one shows its column count.
  - JQL query: a query field.
- [ ] **Linear:** the account's teams, listed with key and name. One already added is marked the same way.
- [ ] **GitHub:** "Build the board from" offers **A GitHub Project** or **A repository's issues**.
  - Projects: the projects of the signed-in user and of the owners of the workspace's repositories, with their Status field's options counted as columns.
  - Repository: the workspace's GitHub repositories.
- [ ] Reading GitHub Projects needs gh's `read:project` scope. Without it, step 1 says so, with the command `gh auth refresh -s read:project` to copy and **Check again**. moonlet never runs `gh auth` itself.
- [ ] **ClickUp:** the workspace's lists, by space and folder.

#### 2. Issues

- [ ] **Jira board:** the board's filter is shown read-only, with **Edit in Jira**. Below it, "Narrow it down in moonlet · optional JQL, added with AND". A `jql` board has its query here instead.
- [ ] **Linear, GitHub and ClickUp:** an optional label filter. A GitHub Project has no label filter, since its view's filter stays in GitHub.
- [ ] "Show issues assigned to": **Me** or **Anyone**. Under Anyone, other people's issues are dimmed. The header's Assignee filter can still switch it.
- [ ] "Finished issues":
  - **Hide after 14 days**, the default for boards without sprints.
  - **Follow the active sprint** on a Jira Scrum or team-managed board, **Follow the active cycle** on a Linear team with cycles.

  The sprint and cycle options are only offered where they exist.
- [ ] A preview below says `<n> issues match · <n> assigned to you · <n> already have a branch with their key`, with three of the issues (key, title, status). It updates as the user types, after a short pause. A query the tracker rejects shows the tracker's error instead, and Continue waits.

#### 3. Columns

- [ ] A strip previews the board, its columns in order, a folded one narrow.
- [ ] One row per column, in order:
  - a drag handle
  - the column's name and its statuses
  - "moonlet treats it as": To do, In progress, In review or Done
  - Show / Fold / Hide
  - WIP
- [ ] Where columns come from:
  - Jira board: Jira's columns, their statuses and their WIP limits (max).
  - JQL board: one column per status its issues are in, ordered by category; a status seen later gets a column of its own. A status can be dragged onto another column to group them, as the design's "which you can then group and order" says.
  - Linear: the team's workflow states.
  - GitHub Project: the Status field's options. A repository: Open and Closed.
  - ClickUp: the list's statuses.
- [ ] A column's category is suggested from its statuses: Jira's status category, Linear's state type, ClickUp's status type, and for GitHub the option's name. A column named like "review" or "QA" is suggested as In review (X44's rule).
- [ ] A changed category is outlined in the accent colour. The note under the table says: "Suggested from each status's <tracker> category. Change one where your team means something else." A hidden column's issues are not shown and not counted, out of sync included.
- [ ] Defaults: Done-category columns are folded. Jira's backlog column and a column with no status, and Linear's `backlog`, `triage` and `canceled` states, are hidden. A GitHub repository's Closed holds issues closed as completed and as not planned.
- [ ] WIP is shown only for Jira boards; Linear, GitHub and ClickUp have no WIP limits.

#### 4. Finish

- [ ] **Name**, prefilled from the source (`WEB · Website`, the team name, the project title), and **Workspace**, preset to the current one.
- [ ] "New sessions from this board start in":
  - A **By default** row, empty unless the user sets it. Empty, it shows as its hint the projects whose committed `.moonlet/config.toml` links the board's tracker project (X44), and those are used, so a teammate's change to that file reaches the board.
  - Rules by component (Jira) or label: `Component = design-system → ui-kit`.
  - **Add a rule by component or label**.
- [ ] "Cards show" checkboxes, only those the tracker has:
  - issue type (Jira)
  - story points (Jira) or estimate (Linear, GitHub number field)
  - assignee
  - epic (Jira) or parent
  - due date
- [ ] A summary card shows the tracker's mark, the name and `<origin> · <n> columns shown, <n> folded, <n> hidden · <n> issues · <workspace>`, with **Pin in sidebar** (on).
- [ ] **Create board** saves the board, closes the wizard and opens the board.

### Board settings and Manage

- [ ] **Board settings** opens from a column's `⋯` menu and from Manage. It has the wizard's four steps as tabs, with the board's current values, plus **Save** and **Remove board**. Its Source tab shows the origin read-only: changing it means a new board.
- [ ] A board's columns are matched to the tracker's on each sync (a Jira board's columns; a JQL board's, a Linear team's, a ClickUp list's and a Project's statuses), by status id. A new one shows as a new column with step 3's defaults; a removed one disappears; the order, folding and categories the user set stay.
- [ ] **Manage** (in the switcher) opens Settings › Task trackers at **Boards**, a list of each workspace's boards: mark, name, origin, pinned, and Board settings and Remove. A board whose connection needs attention shows the reason in red (X44).

### Sidebar and header

- [ ] The Tasks sidebar shows:
  - "Find a task"
  - **Boards** with a `+` that opens Add a board, then one row per pinned board of the workspace: mark, name with the sprint or cycle it follows (`OPS · Sprint 42`), open-task count
  - the footer `<tracker> synced <age>` with a dot (green, or red after a failed sync)

  The current board is highlighted.
- [ ] X45's Views (My issues, In review, Out of sync, Sessions without a task) and the Trackers list are gone:
  - Sessions without a task is the List's last group.
  - Out of sync stays on the cards and on the Tasks button's dot and count, counted over the workspace's boards.
  - My issues is the Assignee filter.
- [ ] The header title is the board's name with a `⌄`. When the board follows a sprint or cycle, the title adds its name: `OPS · Sprint 42`, `Moonlet · Cycle 14`. Clicking the title opens the board switcher.
- [ ] The subtitle reads `<tracker> · <site> · <start> – <end> · <n> tasks · <n> sessions`:
  - `<n> issues` for Jira.
  - The dates show only while following a sprint or cycle.
  - The counts are those of the shown board after its filters.

  (Partly: not drawn yet. `boardColumns.test.ts` names the tracker, its site, the sprint's dates and the counts, Jira counting issues)
- [ ] The header's controls are:
  - **Assignee: me / anyone**, a menu that starts from the board's own setting; a change is kept per board in the app, not written to the board.
  - **Columns `<n>` · `<n>` folded**, a menu that shows, folds or hides each column (saved to the board).
  - **Hide empty Done**.
  - **Board | List** with their icons.
  - **Expand all**, in List (X45).
  - Refresh.
- [ ] Tasks mode opens on the board last shown in the workspace, or on its first pinned board.

### Board switcher

- [ ] The switcher is a popover under the title with "Find a board, team or project", which finds boards by name, key or workspace. It lists boards grouped by workspace: the current workspace first ("this workspace"), then the others ("switches workspace").
- [ ] A row shows:
  - the tracker's mark, the name and the type (Scrum, Kanban, Team-managed or Board until a Jira board's first sync, Query, `Cycle <n>` or Team, Project, Repository, List)
  - a strip of small bars, one per shown or folded column, in its category's colour
  - `<n> columns · <n> issues` (`tasks` but for Jira, as in the subtitle), as much as is known before its first sync
  - the board's sessions: `<n> sessions` with a dot in the most urgent agent state, or `no sessions`

  The current board has a check. (Partly: not drawn yet. `boardColumns.test.ts` lists this workspace's boards first, then the others', with their columns and live counts, finds a board by its name, its key or its workspace)
- [ ] ↑ and ↓ move, ↵ opens, Esc closes. Picking a board of another workspace switches to that workspace, in Tasks mode.
- [ ] The footer has **New board** (opens Add a board) and **Manage**.

### Board

- [ ] The board draws its shown and folded columns in the board's order, a folded one as a narrow strip. Hidden columns are not drawn. (Partly: not drawn yet. `boardColumns.test.ts` draws the tracker's columns in the board's order, folded ones as such, hidden ones not at all)
- [ ] A task sits in the column whose statuses hold its status (its id, else its name). A status in no column, or only in hidden ones, is not shown. Laying out 2000 issues takes well under a second. (Partly: not drawn yet. `boardColumns.test.ts` draws the tracker's columns in the board's order, folded ones as such, hidden ones not at all, moves a merged PR from a board's only In review column to Done, and from In Progress to In Review, lays out 2000 issues with 60 sessions in under a second)
- [ ] A column header shows its name and count, then a line with its category glyph and name. On a Jira board with a WIP limit it adds `· <n> of <max>`, counting the cards it shows (under Assignee: me, the user's own); at or above the limit, `· full` in amber. (Partly: not drawn yet. `boardColumns.test.ts` shows a Jira column's WIP limit, full at the limit)
- [ ] The column's `⋯` menu has Fold, Hide and Board settings….
- [ ] A folded column is a narrow strip: its glyph, its name written vertically, its count. A folded Done-category column adds a red badge with the done tasks that still need clean-up (X45). Clicking a strip unfolds it; folding it again goes through its `⋯` menu.
- [ ] Column names always come from the tracker; moonlet never names a column itself. A `github_repo` board has GitHub's two, Open and Closed, so X45's split of open issues into Todo, In Progress and In Review by their work is gone; a GitHub Project gives a status flow.

### Cards

- [ ] A card shows the X45 card plus the board's card fields:
  - issue type, after the key
  - story points as `<n> pt`, before the assignee's initials
  - epic or parent and due date, on a line under the title
- [ ] Under Assignee: anyone, a card assigned to someone else is dimmed.
- [ ] A card with no sessions can have a note line instead of `No sessions`. The first that applies:
  - `Assigned to <name>`: the issue is someone else's.
  - `Merged · waiting for <column>, as expected`: every session's PR is merged and the task is in an In review column of a board with several (see Out of sync below).
- [ ] With a session, a card's note line reads `<agent> is fixing <n> failing checks` when the session's PR has failing checks and its agent is working.

### Out of sync and moves

- [ ] Out of sync (X45) reads the task's column category instead of the old fixed column.
- [ ] A fix moves the task to the **next column** on the board: the first shown or folded column after the task's own. It is named after that column, as the tracker names it: `Move to QA`, `Move to Done`, `Move to Code Review`. When there is no next column, or the next one is not in a later category than the task's own (another To do column, for a task with a running session), the chip shows without a fix. (Partly: not drawn yet. `boardColumns.test.ts` names each fix after the next column and moves there, moves a merged PR in To Do to the next column, a later category, has no fix when the next column is not a later category; `keepInStep.test.ts` on a board, moves to the next column's first status, and has nothing to do without a fix (X50))
- [ ] Work started and PR open show only on a board with a column of that category (In progress, In review). A GitHub repository board, with only Open and Closed, shows neither; its merged PR's fix is Move to Closed. (Partly: not drawn yet. `boardColumns.test.ts` flags a GitHub repository issue only for a merged PR, closing it)
- [ ] **PR merged** is out of sync when the task is in a To do or In progress column, or in an In review column of a board with only one, as in X45 (there the next column is usually Done). On a board with several In review columns (Code Review, QA, Staging), a merged PR in any of them is expected and not flagged. (Partly: not drawn yet. `boardColumns.test.ts` expects a merged PR in any In review column of a board with several, moves a merged PR from a board's only In review column to Done, and from In Progress to In Review)
- [ ] Keep in step's automatic moves (X46) go to a category: moonlet picks the first status of the first shown or folded column of that category. Jira moves go through the transition to that status. A status Jira's workflow can't reach shows Jira's error with Retry, as X46 does.
- [ ] The detail panel's State menu lists the board's columns by name, not the four categories. A GitHub repository still offers Open and Closed.
- [ ] Moving a GitHub Project item sets its Status field, which needs gh's `project` scope. Without it, the State menu is disabled and says why.

### List

- [ ] The List groups by the board's shown and folded columns, in order. Folded columns are collapsed to their header with X45's notes. Then comes **Sessions without a task** (X45's rows and Link to task) as the last group.

### Sync

- [ ] A sync reads each pinned board of the workspace, plus the shown board, each task taking its board column's category, and a board whose columns changed in its tracker saves them. X44's interval, focus refresh and failure rules apply per board. Boards of one connection share its requests where the tracker allows it. (Partly: each board makes its own requests. `tasksStore.test.ts` keeps a board's columns as its tracker has them, with the user's folding, and places tasks by their column, syncs the board shown even when it is not pinned, keeping each board's tasks apart, keeps the last tasks only of a source that failed, and takes the others fresh; `boardColumns.test.ts` gives a tracker task its column's category, hides one in no column or a hidden one, and leaves GitHub issues as they are)
- [ ] **Jira:**
  - A `jira_board` reads its configuration: columns, statuses, WIP, filter id, a Kanban board's sub-filter, and the estimation field. A column's category is the one most of its statuses have, a tie going to the later one. (`jira_board.rs` a_scrum_boards_columns_with_their_suggested_categories, a_kanban_boards_backlog_is_hidden_and_its_sub_filter_kept, a_columns_category_is_the_one_most_of_its_statuses_have)
  - A JQL board's columns are the statuses its issues are in. (`jira_board.rs` a_jql_boards_columns_are_its_issues_statuses_in_category_order)
  - Each sync matches the board's saved columns to these. (`boards.test.ts` keeps the user's order, folding and categories, takes Jira's names and statuses, adds new columns and drops removed ones, takes the tracker's columns as they are for a board that has none yet)
  - Its search is `(<filter>) AND (<sub-filter>) AND (<narrowing>) [AND assignee = currentUser()] AND <finished>`, in the filter's own `ORDER BY` (taken off the filter first, since a filter ends with one), else `Rank ASC`. Finished is `sprint in openSprints()` when it follows the sprint, else `(statusCategory != Done OR updated >= -<n>d)`. An `ORDER BY` in the sub-filter or the narrowing is dropped, and an empty filter adds no condition. (`jira_board.rs` a_boards_query_is_its_filter_and_moonlets_narrowing_in_the_filters_order, the_query_survives_filters_that_end_or_hide_an_order_by)
  - Story points come from the board's estimation field, never from guessing among the site's fields: a site can have a "Story point estimate" field that its boards don't use. (`jira_board.rs` the_sprint_field_is_found_by_its_type_and_points_come_from_the_boards_estimation)
  - The active sprint's name and dates come from the issues' sprint field (the field Jira Software made, found by its type): the board's sprint whose state is `active`. (`jira_board.rs` a_boards_issues_with_their_status_id_points_parent_and_the_active_sprint)
  - Each issue keeps its status id, which the board's columns list, plus its components, parent and due date. (`jira_board.rs` a_boards_issues_with_their_status_id_points_parent_and_the_active_sprint, a_jql_boards_columns_are_its_issues_statuses_in_category_order; `boards.test.ts` keeps the status id with the tracker's state, and the card's fields)
  - Before searching, each sync asks Jira who the user is, so a token Jira no longer accepts asks to reconnect instead of showing an empty board (X44).
- [ ] **Linear:** issues of the team, filtered by label and assignee. With Follow the active cycle, only the active cycle's issues, plus its number and dates.
- [ ] **GitHub Project:** the project's items that are issues, with their Status and number fields. Draft items and PRs are left out.
- [ ] **ClickUp:** X44's two passes over the list.

## UI

The designs are the "Tasks mode · Board", "Tasks mode · Jira board", "Tasks mode · List", "Board switcher", "Add a board" and "Task card states" boards of the Tasks mode design.
- The design's "Across boards" sidebar section is left out (see Sidebar and header, and Out of scope).
- The design's `+` on Linear columns is left out.
- The design shows only the Jira path through Add a board. Linear, GitHub and ClickUp follow the same four steps, with the differences listed above.

States:
- A workspace with no board shows "Add a board" in the centre, with its connections and GitHub as cards. With no connection and no GitHub repository either, it shows X45's "Connect a task tracker" panel.
- "Loading tasks…" shows before a board's first list.
- A board whose origin is gone (a Jira board deleted, a team archived) shows the tracker's error and **Board settings**.

## Protocol and RPCs

Desktop-only Tauri commands (ADR 0010):

- `tracker_boards {id}` → what a board can be built from:
  - Jira: boards `{id, name, kind, project}`, at most 1000.
  - Linear: teams `{key, name, cycles}`.
  - ClickUp: lists.
- `tracker_board_setup {id, board}` → a Jira board's `{filterId, subQuery, pointsField, sprints, columns}`, each column with its suggested category and Show / Fold / Hide.
- `tracker_board_preview {id, board}` → `{count, mine, sample: [task; 3]}`. The "already have a branch" count is the app's, from the workspace's branches and worktrees.
- `tracker_board_tasks {query: {id, origin, narrow, mine, finished}}` → `{issues, sprint, columns}`: each issue a task with its `statusId`, `components`, `points`, `parent` and `due`; the active sprint `{id, name, startMs, endMs}`; a Jira board's columns as Jira has them now, or a JQL board's from its issues. It replaces `tracker_tasks` (in a later change).
- `tracker_update` takes a `status` instead of a `column` when the board knows it.

Daemon RPCs, since `gh` runs on the project's host:

- `gh.projects {path}` → `[{owner, number, title, status_options, number_fields}]`, or a `missing_scope` error naming the scope.
- `gh.project_items {path, owner, number, mine}` → issues with their Status option and number fields.
- `gh.project_item_move {path, owner, number, item, option}`.
- `gh.tasks` stays for `github_repo` boards.

## Data and config

- `~/.moonlet/trackers.toml` gains `[[boards]]`:
  - `id`, `name`, `connection`, `workspace`, `pinned`
  - `[boards.origin]`: `kind` (`jira_board`, `jql`, `linear_team`, `github_project`, `github_repo`, `clickup_list`) and its key (`board`, `query`, `team`, `owner` + `number`, `repo`, `list`)
  - `narrow` (JQL), `labels`, `assignee` (`me` or `anyone`), `finished` (a number of days, `14` by default, or `"sprint"`)
  - `[[boards.columns]]`: `name`, `statuses` (status or state ids where the tracker has them, Jira and Linear; else names, ClickUp and a GitHub repository's `open`, `completed`, `not_planned`), `category` (`todo`, `in_progress`, `in_review`, `done`: hiding a column is its `show`), `show` (`show`, `fold`, `hide`), `wip` (`config.rs` a_columns_category_is_one_of_four_and_hiding_is_its_show)
  - `[[boards.rules]]`: `when` (`"default"`, `{ component = "…" }` or `{ label = "…" }`) and `project`, one project per rule
  - `cards` (a list of field names: `issue_type`, `points`, `assignee`, `parent`, `due`, `labels`)
  - a migrated board's `states`, the old connection's state mapping, until its columns are first read
- `migrated`: the workspaces whose sources have become boards (`local/acme`), and each repository that got its board (`local/acme github:github.com/acme/web`). The app migrates a workspace's sources the first time it opens it, and each repository the first time a sync sees it, since only then does it know the workspace's GitHub repositories. A board removed later stays removed.
- `[[connections.sources]]` are read until their workspace is migrated, then dropped. `connections.states` is dropped once its connection has no source left.
- A Jira board's columns are kept with the user's order, folding and categories. On each sync they are matched to Jira's by status ids.
- `.moonlet/config.toml`'s `trackers = ["<connection>/<key>"]` (X44) stays. It is the default for a board's By default row. A new session from a task starts in, in this order:
  1. the board's matching rule
  2. the board's By default row
  3. the projects that link the task's tracker project
  4. X46's fallback

  A rule's project, or the By default row's projects, all of them. (`boards.test.ts` takes the first matching component or label rule, then the board's default, then the projects linking the tracker project)
- The app's local storage keeps, per workspace, the board last shown, and per board, the Assignee filter.

## Security considerations

- A JQL query and the narrowing clause are the user's own. They are sent only to that connection's site, in the request body.
- Board, column and status names from trackers are untrusted and shown as plain text.
- The GitHub scope message shows a command to copy. moonlet never runs `gh auth` and never asks for a token.

## Out of scope

- An "Across boards" section (My tasks, In review, Out of sync, Sessions without a task over every board).
- A Current cycle view across Linear teams; boards built from Linear projects or custom views.
- Creating tasks (the `+` on a column) and drag and drop between columns.
- WIP limits for Linear, GitHub and ClickUp.
- Writing anything back to the tracker's board: column order, folding and categories are moonlet-only.
- An "Opens on" setting per workspace: Tasks mode opens on the board last shown.

## Test plan

- **Rust (`crates/moonlet-trackers`):**
  - the `[[boards]]` round trip (`config.rs`)
  - Jira board list, board configuration, active sprint, filter JQL and per-site field lookup (`jira_board.rs`); fixtures from real responses, captured with the user's token, with names, emails, keys and URLs replaced
  - Linear teams with their active cycle (`linear.rs`)
  - category suggestions (`states.rs`)
- **Daemon:** `gh.projects` and `gh.project_items` against real `gh api graphql` output, and the missing-scope error.
- **Vitest (`apps/desktop/src/lib/`):**
  - the migration from sources, once per workspace (`boards.test.ts`)
  - placing tasks in a board's columns, fold and hide, WIP `full`
  - the switcher's groups and search, the header subtitle
  - the repository a new session starts in, by rule
  - PR merged with one and with several In review columns; each fix named after and moving to the next column, and no fix without one; Keep in step's moves by category
  - the List's groups
  - the wizard's step rules (what Continue waits for, defaults per tracker)
- **e2e:**
  - `boards.e2e.ts`: add a `github_repo` board with a fake `gh`, see it pinned and shown; add a Jira board against a mock of Jira's API, fold a column, change a category, and see a merged PR in QA not flagged.
  - Update `tasks-mode.e2e.ts` for the Boards sidebar and the List's last group.

## Open questions

- **Opens on.** The design's Settings page lets each workspace open Tasks mode on its current cycle, active sprint or Sessions mode. This spec leaves it out (Tasks mode opens on the board last shown). Keep it out?
- **`+` on a column.** The design's Linear board has a `+` per column, which would create a task there. Creating tasks stays out of scope. Keep it out?
