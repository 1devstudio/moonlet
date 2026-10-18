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

- [x] A board has a name, a connection, an origin, an issue filter, columns, a workspace, start-in rules, card fields and a pinned flag. It is saved in `trackers.toml` under `[[boards]]`; a setting at its default is not written. (`config.rs` a_jira_board_with_its_columns_rules_and_cards, a_board_written_with_only_its_essentials_takes_the_defaults, a_board_at_its_default_finished_rule_does_not_write_it, every_origin_reads_back)
- [x] Origins:
  - Jira: `jira_board` (an existing Jira board, by id) or `jql` (a JQL query).
  - Linear: `linear_team` (a team, by key).
  - GitHub: `github_project` (a GitHub Project, by owner and number) or `github_repo` (a repository's issues, as X44 shows them today).
  - ClickUp: `clickup_list` (a list, by id).

  (`config.rs` every_origin_reads_back, a_jira_board_with_its_columns_rules_and_cards, a_board_written_with_only_its_essentials_takes_the_defaults)
- [x] When the app reads `trackers.toml` after the upgrade, every X44 source becomes one board in its workspace. A Jira project becomes a `jql` board `project = <KEY>`, a Linear team a `linear_team` board, a ClickUp list a `clickup_list` board. The board is named after the source and pinned, and carries its connection's state mapping. Its columns come from the tracker on the first sync, named as there: the statuses the Jira project's issues are in, the Linear team's workflow states, the ClickUp list's statuses. Each column's category is the one the mapping gave its state; a state mapped to Not shown becomes a hidden column. The connections keep no sources or mapping, and a source no workspace was chosen for goes. (`boards.test.ts` turns every workspace's sources into pinned boards as soon as the file loads, keeping each connection's state mapping, drops a source no workspace was chosen for, skips one that already has its board, and leaves a file without sources as it is, gives the tracker's states the categories the old state mapping gave them, and hides those not shown; `tasksStore.test.ts` turns the file's sources into boards when it loads, and gives the workspace's repository its board on the first sync)
- [x] Each GitHub repository of a workspace's projects gets a `github_repo` board, with GitHub's Open and Closed, the first time a sync sees it, so one whose origin could not be read at first (a host offline, a remote added later) still gets one; a board removed later stays removed, and `Acme/Web` and `acme/web` are one board. (`boards.test.ts` gives each repository of a workspace's projects its board once, whatever its case, keeps a board removed later removed, gives a repository seen on a later sync its board then (a host offline, a remote added later))
- [x] Removing a board asks first. Session links (X46) stay, and so do the sessions themselves. (`tasksStore.test.ts` removes a board only after asking, and leaves the sessions and their task links alone; `task-trackers.e2e.ts` adds a board of a Linear team that uses cycles, following its active cycle, with the card fields picked, and removes it after asking (X50))
- [x] Disconnecting a connection (X44) also removes its boards, and its confirm names them. (`trackerSources.test.ts` names the boards that go with the connection; `task-trackers.e2e.ts` disconnects after asking, naming its boards: the token, the connection and its boards are gone)
- [x] The Connect dialog (X44) ends with who signed in, what the account sees (`2 teams visible`) and **Add a board**, which opens the wizard on the new connection in the workspace shown, or **Later**. Reconnecting ends with **Done**. With no workspace open, Add a board waits and says to open one. (`trackerSources.test.ts` says who signed in, what the account sees and what its first board can be built from; `task-trackers.e2e.ts` connects with an API key, keeps the key out of trackers.toml, and ends in Add a board for a team (X50), connects ClickUp with its raw token to the account's first workspace, its lists grouped by space in Add a board, shows Jira's refusal in the dialog, then connects two Jira sites side by side, stops asking Linear once it rejects the token, the Settings nav shows a dot, and reconnecting ends with Done)

### Add a board

- [x] The wizard is a dialog with four steps listed on the left: Source, Issues, Columns, Finish. A step already done shows a check and can be clicked. The footnote reads "Every choice can be changed later from the board's ⋯ menu › Board settings." (`task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50))
- [x] **Back** and **Continue** move between steps; the last step has **Create board**. Continue waits until the step is complete: a board picked, or a query that Jira accepts. (`addBoard.test.ts` waits for a board, a non-empty query, columns and a name; `task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50))
- [x] Each step's footer says what moonlet does with the tracker. Step 1: "moonlet reads the board's configuration; it never changes it in Jira" (or Linear, GitHub, ClickUp). Step 2: "Counts update as you type." Step 3: "Drag to reorder. Order and folding are moonlet-only and don't change <tracker>.", and on a JQL board "Drag to reorder, or drag a status onto another column to group them. …" Step 4: "Saved to ~/.moonlet/trackers.toml." (`task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50); `task-trackers.e2e.ts` adds an existing Jira board: its filter with Edit in Jira, statuses by name, a changed category outlined, a column dragged, its lookups shared with the site's other board, and says when it is gone (X50))

#### 1. Source

- [x] Connections are cards with the tracker's mark, its name and its site (`acme.atlassian.net`, the Linear organisation, `via gh login`, the ClickUp workspace). GitHub is always offered. (`task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50))
- [x] **Jira:** "Build the board from" offers **An existing Jira board** or **A JQL query**.
  - Existing board: Jira's boards are listed with key, name and type (Scrum, Kanban or Team-managed) (`jira_board.rs` the_boards_a_connection_can_show). One that is already a board in this workspace is marked "Already added" and cannot be picked. The picked one shows its column count. (`addBoard.test.ts` takes the picked board's name and the tracker's defaults, marks a board that is already one in this workspace)
  - JQL query: a query field. (`task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50))
- [x] **Linear:** the account's teams, listed with key and name, a team that uses cycles marked Cycles. One already added is marked the same way. (`addBoard.test.ts` marks a board that is already one in this workspace; `task-trackers.e2e.ts` adds a board of a Linear team that uses cycles, following its active cycle, with the card fields picked, and removes it after asking (X50))
- [ ] **GitHub:** "Build the board from" offers **A GitHub Project** or **A repository's issues**.
  - Projects: the projects of the signed-in user and of the owners of the workspace's repositories, with their Status field's options counted as columns.
  - Repository: the workspace's GitHub repositories.

  Projects show under their owner; at most 50 per owner are listed. (Partly: no test lists the workspace's repositories in step 1. `addBoard.test.ts` asks about the owners of the workspace's repositories, each once; `gh_projects.rs` only_github_logins_are_asked_about_each_once, a_project_without_a_status_field_is_not_offered, an_owner_gh_may_not_read_leaves_the_others; `gh_projects.rs` the_users_open_projects_with_their_status_options; `addBoard.test.ts` lists a Project under its owner, with its Status options counted as columns, takes the picked board's name and the tracker's defaults; `tasks-mode.e2e.ts` adds a board of a GitHub Project, after gh gets its read:project scope, with No Status and the Project's Status as columns and its estimate on cards, and moves an item by its Status (X50))
- [x] Reading GitHub Projects needs gh's `read:project` scope. Without it, step 1 says so, with the command `gh auth refresh -s read:project` to copy and **Check again**. moonlet never runs `gh auth login` or `gh auth refresh` itself; it only reads `gh auth status`. (`gh_projects.rs` a_missing_scope_names_the_command_that_adds_it; `addBoard.test.ts` knows when gh lacks a scope, from the daemon's message, and which; `tasks-mode.e2e.ts` adds a board of a GitHub Project, after gh gets its read:project scope, with No Status and the Project's Status as columns and its estimate on cards, and moves an item by its Status (X50))
- [x] **ClickUp:** the workspace's lists, by space and folder: each list under `Space` or `Space › Folder`. (`clickup.rs` the_lists_inside_a_spaces_folders_are_sources_named_with_their_folder, a_list_is_headed_by_its_space_and_folder; `addBoard.test.ts` groups a connection's lists by space and folder, in the order they came; `task-trackers.e2e.ts` connects ClickUp with its raw token to the account's first workspace, its lists grouped by space in Add a board)

#### 2. Issues

- [x] **Jira board:** the board's filter is shown read-only, with **Edit in Jira**. Below it, "Narrow it down in moonlet · optional JQL, added with AND". A `jql` board has its query here instead. (`addBoard.test.ts` links a Jira board's filter for editing in Jira; `task-trackers.e2e.ts` adds an existing Jira board: its filter with Edit in Jira, statuses by name, a changed category outlined, a column dragged, its lookups shared with the site's other board, and says when it is gone (X50); `jira_board.rs` a_boards_query_is_its_filter_and_moonlets_narrowing_in_the_filters_order)
- [x] **Linear, GitHub and ClickUp:** an optional label filter. A GitHub Project has no label filter, since its view's filter stays in GitHub. (`tasksStore.test.ts` keeps only the issues with any of a board's labels, whatever their case (Add a board, Issues))
- [x] "Show issues assigned to": **Me** or **Anyone**. Under Anyone, other people's issues are dimmed. The header's Assignee filter can still switch it. (`addBoard.test.ts` makes the board, leaving out what is at its default; `boards.test.ts` is the user's pick for the board while the board's own setting is the one it was made over, else that setting, forgets the picks of boards that are gone, and keeps an upgrade's Assignee: anyone for boards at me)
- [x] "Finished issues":
  - **Hide after 14 days**, the default for boards without sprints.
  - **Follow the active sprint** on a Jira Scrum or team-managed board, **Follow the active cycle** on a Linear team with cycles.

  The sprint and cycle options are only offered where they exist. (`addBoard.test.ts` offers the sprint or cycle only where there is one; `linear.rs` the_viewer_teams_and_states; `task-trackers.e2e.ts` adds a board of a Linear team that uses cycles, following its active cycle, with the card fields picked, and removes it after asking (X50))
- [x] A preview below says `<n> issues match · <n> assigned to you · <n> already have a branch with their key`, with three of the issues (key, title, status). It updates as the user types, after a short pause (half a second after the last change; only the latest change's answer shows). A query the tracker rejects shows the tracker's error instead, and Continue waits. (`addBoard.test.ts` asks the tracker a moment after the last change, and shows only the latest change's answer; `task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50); `addBoard.test.ts` says how many issues match, how many are the user's, and how many have a branch with their key, waits for a board, a non-empty query, columns and a name; `tasksStore.test.ts` previews a board not saved yet: everyone's issues, the user's own marked, and the tracker's columns (Add a board))

#### 3. Columns

- [x] A strip previews the board, its columns in order, a folded one narrow. (Seen in the app; React components have no unit tests.)
- [x] One row per column, in order:
  - a drag handle
  - the column's name and its statuses
  - "moonlet treats it as": To do, In progress, In review or Done
  - Show / Fold / Hide
  - WIP

  Up and down buttons move a column too, for the keyboard. Statuses show by name: a Jira board's from its setup, a JQL board's from its issues, and a JQL board's status that no issue is in today from the site's statuses, once the preview has read them; until then, or when Jira won't list them, it shows its id. Names already seen stay while the next preview loads. (`trackers.rs` only_a_jql_boards_preview_asks_for_the_sites_status_names; `addBoard.test.ts` lists a column's statuses by name: Jira's board setup, else the previewed issues, else the site's statuses, else the id; `jira_board.rs` the_sites_status_names_by_id; `tasksStore.test.ts` previews a JQL board with the site's status names, for a column whose status no issue is in; `jira_board.rs` a_scrum_boards_columns_with_their_suggested_categories; `addBoard.test.ts` moves a column up or down, and sets its category and how it shows, drops a dragged column where it lands; `task-trackers.e2e.ts` adds an existing Jira board: its filter with Edit in Jira, statuses by name, a changed category outlined, a column dragged, its lookups shared with the site's other board, and says when it is gone (X50); `task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50))
- [x] Where columns come from:
  - Jira board: Jira's columns, their statuses and their WIP limits (max).
  - JQL board: one column per status its issues are in, ordered by category; a status seen later gets a column of its own, and no column goes by itself, since its statuses may just have no issue today. A status can be dragged onto another column to group them, as the design's "which you can then group and order" says; a column left without statuses goes, and one named after the status that left takes its next status's name. A grouped status's × gives it its own column again, beside the one it leaves, in the category suggested for it; the × shows only when that column can have the tracker's name for the status and no other column has it, since moonlet never names a column itself. Grouping is by drag only; the × is a button. Only a JQL board's statuses group: the other trackers' columns come back on each sync as the tracker has them. (`boards.test.ts` only adds columns to a JQL board, since its columns come from the statuses its issues happen to be in, keeps a JQL board's grouped statuses together on each sync, and gives a status seen later a column of its own; `addBoard.test.ts` moves a status dragged onto another column into it, and drops the column it leaves empty, names the column a status leaves after its next status, when it was named after the one that left, gives a grouped status its own column again, beside the one it leaves, in the category suggested for it, splits a status only when its column gets the tracker's own name, unique on the board, groups only a JQL board's statuses: a tracker's own columns come back on each sync as the tracker has them; `task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50))
  - Linear: the team's workflow states.
  - GitHub Project: No Status, then the Status field's options, each column named after its option and holding the option's id. A repository: Open and Closed.
  - ClickUp: the list's statuses.

  (`states.rs` a_github_projects_columns_start_with_no_status, a_github_projects_status_options_as_board_columns, a_clickup_lists_statuses_as_board_columns; `jira_board.rs` a_scrum_boards_columns_with_their_suggested_categories, a_jql_boards_columns_are_its_issues_statuses_in_category_order; `states.rs` a_linear_teams_states_as_board_columns; `boards.test.ts` is GitHub's Open and Closed, Closed holding both close reasons and folded)
- [x] A column's category is suggested from its statuses: Jira's status category, Linear's state type, ClickUp's status type, and for GitHub the option's name. A column named like "review" or "QA" is suggested as In review (X44's rule). (`states.rs` a_github_projects_status_options_as_board_columns, jira_status_categories, linear_state_types, clickup_status_types, github_project_status_options_by_name; `jira_board.rs` a_scrum_boards_columns_with_their_suggested_categories, a_columns_category_is_the_one_most_of_its_statuses_have)
- [x] A changed category is outlined in the accent colour. The note under the table says: "Suggested from each status's <tracker> category. Change one where your team means something else." A hidden column's issues are not shown and not counted, out of sync included. In Board settings, against the board's columns as saved. (`addBoard.test.ts` names the columns whose category differs from the one suggested, takes the columns' categories as suggested when they first come, and again for a new source; `task-trackers.e2e.ts` adds an existing Jira board: its filter with Edit in Jira, statuses by name, a changed category outlined, a column dragged, its lookups shared with the site's other board, and says when it is gone (X50); `task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50); `boardColumns.test.ts` draws the tracker's columns in the board's order, folded ones as such, hidden ones not at all)
- [x] Defaults: Done-category columns are folded. Jira's backlog column and a column with no status, and Linear's `backlog`, `triage` and `canceled` states, are hidden. A GitHub repository's Closed holds issues closed as completed and as not planned. (`jira_board.rs` a_backlog_column_is_hidden_by_its_name_even_with_statuses, a_scrum_boards_columns_with_their_suggested_categories, a_kanban_boards_backlog_is_hidden_and_its_sub_filter_kept; `states.rs` a_linear_teams_states_as_board_columns, linear_state_types; `boards.test.ts` is GitHub's Open and Closed, Closed holding both close reasons and folded)
- [x] WIP is shown only for Jira boards; Linear, GitHub and ClickUp have no WIP limits. (Seen in the app; React components have no unit tests.)

#### 4. Finish

- [x] **Name**, prefilled from the source (`WEB · Website`, the team name, the project title), and **Workspace**, preset to the current one. (`addBoard.test.ts` takes the picked board's name and the tracker's defaults)
- [x] "New sessions from this board start in":
  - A **By default** row, empty unless the user sets it. Empty, it shows as its hint the projects whose committed `.moonlet/config.toml` links the board's tracker project (X44), and those are used, so a teammate's change to that file reaches the board.
  - Rules by component (Jira) or label: `Component = design-system → ui-kit`.
  - **Add a rule by component or label**.

  (`boards.test.ts` names the projects whose committed config links the board's tracker project, or any of its connection's for a Jira board, names the projects that link the tracker project, by name where known; `boards.test.ts` takes the first matching component or label rule, then the board's default, then the projects linking the tracker project; `addBoard.test.ts` makes the board, leaving out what is at its default)
- [x] "Cards show" checkboxes, only those the tracker has:
  - issue type (Jira)
  - story points (Jira) or estimate (Linear; for a GitHub Project, its first number field in the Project's field order, offered under that field's name, such as **Hours**; reordering the Project's fields can change which one it is). A board that shows it keeps the box, as **Estimate**, while the field's name is not known yet or once the Project has no number field, so it can be unticked.
  - assignee
  - epic (Jira) or parent
  - due date

  Ticked at first: the tracker's own fields (Jira: issue type, story points, assignee; Linear: estimate, assignee; GitHub and ClickUp: assignee), which are not written to the file; unticking every box is kept as none. (`addBoard.test.ts` offers a GitHub Project's number field as the estimate, under its own name; `tasksStore.test.ts` gives an item's value in the Project's number field as its estimate, and previews the field's name for Cards show; `tasks-mode.e2e.ts` adds a board of a GitHub Project, after gh gets its read:project scope, with No Status and the Project's Status as columns and its estimate on cards, and moves an item by its Status (X50); `addBoard.test.ts` offers only the card fields the tracker has, makes the board, leaving out what is at its default, opens the board's own values, and saves it back as it was; `config.rs` a_board_whose_cards_show_nothing_keeps_that_choice)
- [x] A summary card shows the tracker's mark, the name and `<origin> · <n> columns shown, <n> folded, <n> hidden · <n> issues · <workspace>`, with **Pin in sidebar** (on). (`addBoard.test.ts` sums the board up as the summary card does, makes the board, leaving out what is at its default; `task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50), where the new board is in the sidebar. The mark is seen in the app.)
- [x] **Create board** saves the board, closes the wizard and opens the board. (`task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50))

### Board settings and Manage

- [x] **Board settings** opens from a column's `⋯` menu and from Manage's Boards. It has the wizard's four steps as tabs, with the board's current values, plus **Save** and **Remove board**. Its Source tab shows the origin read-only: changing it means a new board. Saving it into a workspace that already has a board from the same origin is refused, as Create board is. (`addBoard.test.ts` opens the board's own values, and saves it back as it was, refuses a board its workspace already has, even moved there in Board settings, adds a new board last, and puts a board saved from its settings where it was, under its new id; `task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50), adds a board of a Linear team that uses cycles, following its active cycle, with the card fields picked, and removes it after asking (X50). The read-only Source tab is seen in the app.)
- [x] A board's columns are matched to the tracker's on each sync (a Jira board's columns; a JQL board's, a Linear team's, a ClickUp list's and a Project's statuses), by status id. A new one shows as a new column with step 3's defaults, where the tracker has it: before the next column the board already had, so a saved Project board gains No Status first; a removed one disappears; the order, folding and categories the user set stay. (A Project's columns match by option id, so a renamed option keeps its column, folding and category; a board saved before columns held ids moves onto them on its next sync. `states.rs` a_github_projects_columns_start_with_no_status; `gh_projects.rs` a_projects_issues_with_their_status_and_no_drafts_or_pull_requests; `boardColumns.test.ts` sit in the column of their Status option, whatever the issue's own state or the option's name now; one with no Status under No Status; `boards.test.ts` moves a Project board saved with option names onto option ids, keeping the user's order, folding and categories; `boards.test.ts` keeps the user's order, folding and categories, takes Jira's names and statuses, adds new columns and drops removed ones, puts a column new in the tracker where the tracker has it, before the next column the board already had, matches a Jira board's, starts from the tracker's with the old mapping, and keeps what it has without news, only adds columns to a JQL board, since its columns come from the statuses its issues happen to be in; `tasksStore.test.ts` keeps a board's columns as its tracker has them, with the user's folding, and places tasks by their column)
- [x] **Manage** (in the switcher) opens Settings › Task trackers at **Boards**, a list of each workspace's boards: mark, name, origin, pinned, and Board settings and Remove. A board whose connection needs attention shows the reason in red (X44). (`trackerSources.test.ts` lists the workspace's boards with their origin and pin, marking a board whose connection needs attention; `boards.test.ts` pins or unpins a board, writing only an unpinned one; `settingsSearch.test.ts` finds the Boards section and each board by its name, with what it is built from (X50); `tasks-mode.e2e.ts` opens Settings at Boards from the switcher's Manage, where a board is unpinned and pinned again (X50); `task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50). The mark and the red reason are seen in the app.)

### Sidebar and header

- [x] The Tasks sidebar shows:
  - "Find a task"
  - **Boards** with a `+` that opens Add a board, then one row per pinned board of the workspace: mark, name with the sprint or cycle it follows (`OPS · Sprint 42`), open-task count
  - the footer `<tracker> synced <age>` with a dot (green, or red after a failed sync)

  The current board is highlighted. (`boards.test.ts` names the tracker of the board shown, a repository's board beside it or not; `tasksView.test.ts` says when the tracker last synced, or that it is syncing; `tasks-mode.e2e.ts` says the board shown could not be read, with gh's error, and the footer that the sync failed (X50); `tasks-mode.e2e.ts` opens Settings at Boards from the switcher's Manage, where a board is unpinned and pinned again (X50); `boardScreen.test.ts` lists the workspace's pinned boards with the sprint they follow and their open tasks, the shown one marked; `task-trackers.e2e.ts` shows the team's issues in Tasks mode, stops asking Linear once it rejects the token, and the Settings nav shows a dot)
- [x] X45's Views (My issues, In review, Out of sync, Sessions without a task) and the Trackers list are gone: (`tasks-mode.e2e.ts` lists sessions without a task, with the issue their name looks like; `boardScreen.test.ts` lays out each board's own tasks in its columns, and gathers their cards once by category with the board's out of sync)
  - Sessions without a task is the List's last group.
  - Out of sync stays on the cards and on the Tasks button's dot and count, counted over the workspace's boards.
  - My issues is the Assignee filter.
- [x] The header title is the board's name with a `⌄`. When the board follows a sprint or cycle, the title adds its name: `OPS · Sprint 42`, `Moonlet · Cycle 14` (a Linear cycle's own name when it has one). Clicking the title opens the board switcher. (`tasks-mode.e2e.ts` shows the project's GitHub issues with the sessions working on them; `boardScreen.test.ts` titles the board with the sprint it follows, and sums up what the filters show)
- [x] The subtitle reads `<tracker> · <site> · <start> – <end> · <n> tasks · <n> sessions`:
  - `<n> issues` for Jira.
  - A GitHub Project's `<site>` is `Project #<number> of <owner>`.
  - The dates show only while following a sprint or cycle.
  - The counts are those of the shown board after its filters.

  (`boardColumns.test.ts` names the tracker, its site, the sprint's dates and the counts, Jira counting issues; `boardScreen.test.ts` titles the board with the sprint it follows, and sums up what the filters show)
- [x] The header's controls are: (`boards.test.ts` is the user's pick for the board while the board's own setting is the one it was made over, else that setting, forgets the picks of boards that are gone, and keeps an upgrade's Assignee: anyone for boards at me; `tasksStore.test.ts` takes only the account's issues on a board at Assignee: me, and everyone's open issues on one at anyone, fetches everyone's issues as soon as a board's Assignee is set to anyone, and keeps that per board, starts each board at its own setting for a new install, and keeps X45's switch left off as anyone; `task-trackers.e2e.ts` shows everyone's open issues once the board's Assignee is anyone, others' dimmed (X50); `boardScreen.test.ts` counts the shown and folded columns; `tasks-mode.e2e.ts` counts done tasks left to clean up on the folded Closed column, and filters the board, shows the same tasks as a list whose rows open into their sessions, and unfolds and folds a column)
  - **Assignee: me / anyone**, a menu that starts from the board's own setting; a change is kept per board in the app, not written to the board, until Board settings change that setting. A removed board's pick is forgotten. X45's one Assignee: me, left off, carries over as anyone for every board at me.
  - **Columns `<n>` · `<n>` folded**, a menu that shows, folds or hides each column (saved to the board).
  - **Hide empty Done**.
  - **Board | List** with their icons.
  - **Expand all**, in List (X45), with the other controls.
  - Refresh.
- [x] Tasks mode opens on the board last shown in the workspace, or on its first pinned board. (`boardScreen.test.ts` is the board last shown in the workspace, else its first pinned one)

### Board switcher

- [x] The switcher is a popover under the title with "Find a board, team or project", which finds boards by name, key or workspace. It lists boards grouped by workspace: the current workspace first ("this workspace"), then the others ("switches workspace"). (`boardColumns.test.ts` finds a board by its name, its key or its workspace)
- [x] A row shows:
  - the tracker's mark, the name and the type (a Jira board's Scrum, Kanban or Team-managed, even while it follows a sprint, or Board until its first sync, Query, the cycle (`Cycle <n>` or its name) or Team, Project, Repository, List)
  - a strip of small bars, one per shown or folded column, in its category's colour
  - `<n> columns · <n> issues` (`tasks` but for Jira, as in the subtitle), as much as is known before its first sync
  - the board's sessions: `<n> sessions` with a dot in the most urgent agent state, or `no sessions`

  The current board has a check. (`boardScreen.test.ts` counts a synced board's tasks and sessions, its most urgent agent state, and names its sprint or cycle; `boardColumns.test.ts` lists this workspace's boards first, then the others', with their columns and live counts, finds a board by its name, its key or its workspace; `tasks-mode.e2e.ts` shows the project's GitHub issues with the sessions working on them, and a board switcher with bars and ↑ ↓ ↵; `jira_board.rs` a_scrum_boards_columns_with_their_suggested_categories, a_kanban_boards_backlog_is_hidden_and_its_sub_filter_kept)
- [x] ↑ and ↓ move, ↵ opens, Esc closes. Picking a board of another workspace switches to that workspace, in Tasks mode. The current board is where ↑ and ↓ start, and the first match once the search changes. Text an input method is composing keeps its ↵ and arrows, and items that change while the menu is open keep the active one. (`menuNav.test.ts` steps over labels and dividers, and wraps at either end, starts on the checked item when the menu opens, and on the first match once the search changes, follows the active item to where it is now, else starts over, moves with ↑ and ↓ and picks with ↵, leaving text being composed alone; `tasks-mode.e2e.ts` shows the project's GitHub issues with the sessions working on them, and a board switcher with bars and ↑ ↓ ↵; `tasksStore.test.ts` opens a board of another workspace there, in Tasks mode, keeps a board's type as its sync read it, for the board switcher)
- [x] The footer has **New board** (opens Add a board) and **Manage**, below the list's scrolling. (`tasks-mode.e2e.ts` shows the project's GitHub issues with the sessions working on them, and a board switcher with bars and ↑ ↓ ↵; `tasks-mode.e2e.ts` opens Settings at Boards from the switcher's Manage, where a board is unpinned and pinned again (X50))

### Board

- [x] The board draws its shown and folded columns in the board's order, a folded one as a narrow strip. Hidden columns are not drawn. (`boardColumns.test.ts` draws the tracker's columns in the board's order, folded ones as such, hidden ones not at all)
- [x] A task sits in the column whose statuses hold its status (its id, else its name). A status in no column, or only in hidden ones, is not shown. Laying out 2000 issues takes well under a second. (`boardColumns.test.ts` draws the tracker's columns in the board's order, folded ones as such, hidden ones not at all, moves a merged PR from a board's only In review column to Done, and from In Progress to In Review, lays out 2000 issues with 60 sessions in under a second)
- [x] A column header shows its name and count, then a line with its category glyph and name. On a Jira board with a WIP limit it adds `· <n> of <max>`, counting the cards it shows after the header's filters (under Assignee: me, the user's own); at or above the limit, `· full` in amber. (`boardColumns.test.ts` shows a Jira column's WIP limit, full at the limit, counts the WIP of the cards a filter leaves)
- [x] The column's `⋯` menu has Fold, Hide and Board settings…. (`task-trackers.e2e.ts` adds a board from a JQL query the workspace has no board for, groups a status into another column and back, shows it, renames it in Board settings, and removes it from Settings (X50); `tasks-mode.e2e.ts` shows the same tasks as a list whose rows open into their sessions, and unfolds and folds a column)
- [x] A folded column is a narrow strip: its glyph, its name written vertically, its count. A folded Done-category column adds a red badge with the done tasks that still need clean-up (X45). Clicking a strip unfolds it; folding it again goes through its `⋯` menu. (`tasks-mode.e2e.ts` counts done tasks left to clean up on the folded Closed column, and filters the board, shows the same tasks as a list whose rows open into their sessions, and unfolds and folds a column)
- [x] Column names always come from the tracker; moonlet never names a column itself. A `github_repo` board has GitHub's two, Open and Closed, so X45's split of open issues into Todo, In Progress and In Review by their work is gone; a GitHub Project gives a status flow. (`boards.test.ts` is GitHub's Open and Closed, Closed holding both close reasons and folded; `tasksView.test.ts` names a board column as the tracker does (X50))

### Cards

- [x] A card shows the X45 card plus the board's card fields, the board's own choice or else its tracker's (Jira: issue type, story points, assignee; Linear: estimate, assignee; GitHub and ClickUp: assignee): (`boardScreen.test.ts` shows the fields the board's cards show, the parent and due date on a line under the title, gives a board without its own choice its tracker's fields; `task-trackers.e2e.ts` adds a board of a Linear team that uses cycles, following its active cycle, with the card fields picked, and removes it after asking (X50))
  - issue type, after the key
  - story points or estimate as `<n> pt`, before the assignee's initials; a GitHub Project's as `<field> <n>`, by its number field's name (`Hours 0.5`)
  - epic or parent and due date, on a line under the title
- [x] Under Assignee: anyone, a card assigned to someone else is dimmed, unless a session of the user's is on it. (`boardScreen.test.ts` dims someone else's issue that has no session of yours)
- [x] A card can have a note line, the first that applies: (`boardColumns.test.ts` names whose issue it is when it is someone else's and no session is on it, says a merged PR waits for the next column as expected, on a board with several In review columns; `task-trackers.e2e.ts` shows everyone's open issues once the board's Assignee is anyone, others' dimmed (X50))
  - `Assigned to <name>`, in place of `No sessions`: the issue is someone else's, and no session or worktree of the user's is on it.
  - `Merged · waiting for <column>, as expected`: every session's PR is merged and the task is in an In review column of a board with several (see Out of sync below).
- [x] With a session, a card's note line reads `<agent> is fixing <n> failing checks` when the session's PR has failing checks and its agent is working. (`boardColumns.test.ts` says the agent is fixing the session's failing checks while it works)

### Out of sync and moves

- [x] Out of sync (X45) reads the task's column category instead of the old fixed column. (`boardColumns.test.ts` gives a tracker task its column's category, hides one in no column or a hidden one, and leaves GitHub issues as they are, names each fix after the next column and moves there, moves a merged PR from a board's only In review column to Done, and from In Progress to In Review)
- [x] A fix moves the task to the **next column** on the board: the first shown or folded column after the task's own. It is named after that column, as the tracker names it: `Move to QA`, `Move to Done`, `Move to Code Review`. When there is no next column, or the next one is not in a later category than the task's own (another To do column, for a task with a running session), the chip shows without a fix. (`boardColumns.test.ts` names each fix after the next column and moves there, moves a merged PR in To Do to the next column, a later category, has no fix when the next column is not a later category; `keepInStep.test.ts` on a board, moves to the next column's first status, and has nothing to do without a fix (X50))
- [x] Work started and PR open show only on a board with a column of that category (In progress, In review). A GitHub repository board, with only Open and Closed, shows neither; its merged PR's fix is Move to Closed. (`boardColumns.test.ts` flags a GitHub repository issue only for a merged PR, closing it)
- [x] **PR merged** is out of sync when the task is in a To do or In progress column, or in an In review column of a board with only one, as in X45 (there the next column is usually Done). On a board with several In review columns (Code Review, QA, Staging), a merged PR in any of them is expected and not flagged. (`boardColumns.test.ts` expects a merged PR in any In review column of a board with several, moves a merged PR from a board's only In review column to Done, and from In Progress to In Review)
- [x] Keep in step's automatic moves (X46), a state menu's move to a category and a fix without a column go to a category: moonlet picks the first status of the first shown or folded column of that category on the task's board (`boardColumns.test.ts` is the first status of the first shown or folded column of that category; `tasksStore.test.ts` moves a task to the first status of its board's column of that category). Jira moves go through the transition to that status. A status Jira's workflow can't reach shows Jira's error with Retry, as X46 does.
- [x] The detail panel's State menu lists the board's columns by name, not the four categories. A GitHub repository still offers Open and Closed. (`boardScreen.test.ts` lists a tracker board's shown and folded columns by name, each moving to its first status, with the task's own marked; `tasksStore.test.ts` moves a task to the first status of its board's column of that category; `tasks-mode.e2e.ts` finds a task by its title, and closes an issue from the detail's state menu)
- [x] Moving a GitHub Project item sets its Status field, which needs gh's `project` scope. Without it, the State menu is disabled and says why, with `gh auth refresh -s project`. Its State menu lists the board's columns; a fix, and Keep in step's automatic moves, move to the next column's option. A Project's item is never closed or reopened as a repository's issue is. (`gh_projects.rs` a_move_sets_the_status_or_says_the_scope_it_needs, a_move_to_an_option_sets_the_status_and_one_to_no_option_clears_it; the_active_accounts_token_scopes; `boards.test.ts` sets the item's Status field to the column's option, locks a Project item's State menu without gh's project scope, saying what to run; `keepInStep.test.ts` on a GitHub Project's board, sets the item's Status to the next column's, whatever its category (X50); `tasksStore.test.ts` moves an item by setting its Status to the option of the column picked, and knows gh's scopes, moves an issue on two Projects through the Project its item is in; `keepInStep.test.ts` names a Project item that changed column outside moonlet, as a tracker's issue, not as closed; `tasks-mode.e2e.ts` adds a board of a GitHub Project, after gh gets its read:project scope, with No Status and the Project's Status as columns and its estimate on cards, and moves an item by its Status (X50))

### List

- [x] The List groups by the board's shown and folded columns, in order. Folded columns are collapsed to their header with X45's notes. Then comes **Sessions without a task** (X45's rows and Link to task) as the last group. (`tasksList.test.ts` groups by the board's shown and folded columns, in order, with their notes; `tasks-mode.e2e.ts` shows the same tasks as a list whose rows open into their sessions, and unfolds and folds a column, lists sessions without a task, with the issue their name looks like)

### Sync

- [x] A sync reads each pinned board of the workspace, plus the shown board, each task taking its board column's category, and a board whose columns changed in its tracker saves them. X44's interval, focus refresh and failure rules apply per board. Boards of one connection share its requests where the tracker allows it:
  - Within one sync, Jira's who-am-I check, its statuses and fields, a board's configuration and its filter, and a Linear team's or ClickUp list's states are asked once. The boards of one site and a board's two reads (the user's issues and everyone's) share them.
  - The next sync asks again, so each sync still asks Jira who the user is first (X44), and a board or status changed in the tracker shows on the next sync.
  - Searches and moves are never shared, and a failed request is not kept. Add a board's preview and its Board settings read everything afresh, since the user may just have edited the board in the tracker.

  (`shared.rs` jiras_lookups_are_shared_in_a_sync_and_its_searches_and_moves_are_not, two_reads_at_once_ask_the_tracker_once, a_syncs_answer_serves_that_sync_only_and_a_failure_is_not_kept; `tasksStore.test.ts` names the sync each board read belongs to, so a connection's boards share its lookups within it; a preview belongs to none; `task-trackers.e2e.ts` adds an existing Jira board: its filter with Edit in Jira, statuses by name, a changed category outlined, a column dragged, its lookups shared with the site's other board, and says when it is gone (X50); `boards.test.ts` syncs the workspace's pinned boards and the one shown; `tasksStore.test.ts` keeps a board's columns as its tracker has them, with the user's folding, and places tasks by their column, syncs the board shown even when it is not pinned, keeping each board's tasks apart, keeps a failed board's own last tasks with why it failed, and takes its connection's other boards fresh, keeps the last tasks only of a source that failed, and takes the others fresh; `boardColumns.test.ts` gives a tracker task its column's category, hides one in no column or a hidden one, and leaves GitHub issues as they are)
- [x] **Jira:**
  - A `jira_board` reads its configuration: columns, statuses, WIP, filter id, a Kanban board's sub-filter, and the estimation field. A column's category is the one most of its statuses have, a tie going to the later one. (`jira_board.rs` a_scrum_boards_columns_with_their_suggested_categories, a_kanban_boards_backlog_is_hidden_and_its_sub_filter_kept, a_columns_category_is_the_one_most_of_its_statuses_have)
  - A JQL board's columns are the statuses its issues are in. (`jira_board.rs` a_jql_boards_columns_are_its_issues_statuses_in_category_order)
  - Each sync matches the board's saved columns to these. (`boards.test.ts` keeps the user's order, folding and categories, takes Jira's names and statuses, adds new columns and drops removed ones, takes the tracker's columns as they are for a board that has none yet)
  - Its search is `(<filter>) AND (<sub-filter>) AND (<narrowing>) [AND assignee = currentUser()] AND <finished>`, in the filter's own `ORDER BY` (taken off the filter first, since a filter ends with one), else `Rank ASC`. Finished is `sprint in openSprints()` when it follows the sprint, else `(statusCategory != Done OR updated >= -<n>d)`. An `ORDER BY` in the sub-filter or the narrowing is dropped, and an empty filter adds no condition. (`jira_board.rs` a_boards_query_is_its_filter_and_moonlets_narrowing_in_the_filters_order, the_query_survives_filters_that_end_or_hide_an_order_by)
  - Story points come from the board's estimation field, never from guessing among the site's fields: a site can have a "Story point estimate" field that its boards don't use. (`jira_board.rs` the_sprint_field_is_found_by_its_type_and_points_come_from_the_boards_estimation)
  - The active sprint's name and dates come from the issues' sprint field (the field Jira Software made, found by its type): the board's sprint whose state is `active`. (`jira_board.rs` a_boards_issues_with_their_status_id_points_parent_and_the_active_sprint)
  - Each issue keeps its status id, which the board's columns list, plus its components, parent and due date. (`jira_board.rs` a_boards_issues_with_their_status_id_points_parent_and_the_active_sprint, a_jql_boards_columns_are_its_issues_statuses_in_category_order; `boards.test.ts` keeps the status id with the tracker's state, and the card's fields)
  - Before searching, each sync asks Jira who the user is, so a token Jira no longer accepts asks to reconnect instead of showing an empty board (X44). The site's boards share that one answer within the sync (see Sync). (`task-trackers.e2e.ts` asks Jira who the user is before each search, and reads at most 5 pages; `jira.rs` a_rejected_token_needs_reconnecting)
- [x] **Linear:** issues of the team, filtered by label and assignee: open ones, and done or canceled ones updated in the board's last days (as Jira's rule reads `updated`). With Follow the active cycle, only the active cycle's issues, plus its number (or name) and dates. Each issue keeps its estimate, parent and due date. (`linear.rs` a_teams_board_follows_its_active_cycle_or_its_finished_days, a_boards_issues_carry_their_estimate_parent_and_due_date, the_teams_active_cycle_names_the_board; `tasksStore.test.ts` keeps only the issues with any of a board's labels, whatever their case (Add a board, Issues); `task-trackers.e2e.ts` adds a board of a Linear team that uses cycles, following its active cycle, with the card fields picked, and removes it after asking (X50))
- [x] **GitHub Project:** the project's items that are issues, with their Status and their value in the Project's first number field (the card's estimate; other number fields are left out). Draft items and PRs are left out. An item with no Status is under **No Status**, the board's first column, as GitHub shows it; moving an item there clears its Status. Its status is empty, so an option a team named "No Status" is a column of its own. A No Status item with a session gets the Work started chip without a fix when the next column (Todo) is To do too, under the next-column rule (`boardColumns.test.ts` has no fix when the next column is not a later category). At most 5 pages of 100 items are read. (`gh_projects.rs` a_projects_first_number_field_and_each_issues_value_in_it; `gh_projects.rs` pages_add_up_and_mine_keeps_the_users_own, a_number_goes_to_gh_as_a_number_and_a_login_as_a_string; `gh_projects.rs` a_projects_issues_with_their_status_and_no_drafts_or_pull_requests; `boardColumns.test.ts` sit in the column of their Status option, whatever the issue's own state or the option's name now; one with no Status under No Status; `states.rs` a_github_projects_columns_start_with_no_status; `boards.test.ts` sets the item's Status field to the column's option; `gh_projects.rs` a_move_to_an_option_sets_the_status_and_one_to_no_option_clears_it, a_move_sets_the_status_or_says_the_scope_it_needs; `tasksStore.test.ts` reads the Project's issues with their Status, the user's own marked, and its columns from the Status options; `tasks-mode.e2e.ts` adds a board of a GitHub Project, after gh gets its read:project scope, with No Status and the Project's Status as columns and its estimate on cards, and moves an item by its Status (X50))
- [x] **ClickUp:** X44's two passes over the list, the closed one going back the board's finished days, with each task's due date: ClickUp gives it as a time, and the card shows the day it falls on where the user is. (`clickup.rs` closed_tasks_are_read_back_to_the_boards_finished_days, a_boards_tasks_carry_their_due_dates_time, the_two_passes_make_open_tasks_and_recent_closed_ones; `boards.test.ts` is the day it falls on where the user is)

## UI

The designs are the "Tasks mode · Board", "Tasks mode · Jira board", "Tasks mode · List", "Board switcher", "Add a board" and "Task card states" boards of the Tasks mode design.
- The design's "Across boards" sidebar section is left out (see Sidebar and header, and Out of scope).
- The design's `+` on Linear columns is left out.
- The design shows only the Jira path through Add a board. Linear, GitHub and ClickUp follow the same four steps, with the differences listed above.

States:
- A workspace with no board shows "Add a board" in the centre when a tracker is connected, else X45's "Connect a task tracker" panel. (Without a tracker: `tasks-mode.e2e.ts` asks to connect a task tracker in a workspace with no board)
- "Loading tasks…" shows before a board's first list.
- A board whose origin is gone (a Jira board deleted, a team archived) shows the tracker's error and **Board settings**, above its last tasks if it has any. The sidebar footer then says only that the sync failed. A Jira board that is gone is shown; an archived Linear team fails the same way, untested. (`boardScreen.test.ts` says the tracker's error for the board shown, with what is still drawn, says the sync failed with the error, or only that when the board shown already says why; `tasks-mode.e2e.ts` says the board shown could not be read, with gh's error, and the footer that the sync failed (X50); `tasksStore.test.ts` keeps a failed board's own last tasks with why it failed, and takes its connection's other boards fresh; `task-trackers.e2e.ts` adds an existing Jira board: its filter with Edit in Jira, statuses by name, a changed category outlined, a column dragged, its lookups shared with the site's other board, and says when it is gone (X50))
- A board that follows its sprint or cycle while none is active is empty, and its subtitle says "No active sprint" or "No active cycle". (`boardScreen.test.ts` titles the board with the sprint it follows, and sums up what the filters show)

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

- `gh.projects {owners}` → the open Projects of the user and of `owners`, with a Status field: `[{id, owner, number, title, status_field, options}]`. A missing scope fails with "GitHub Projects need gh's read:project scope. Run gh auth refresh -s read:project, then Check again.", which the UI reads for its command. (Number fields are not read yet.)
- `gh.project_items {owner, number, mine}` → `{id, status_field, options, items: [{item, status, task}]}`: the Project's issues with their Status option.
- `gh.project_move {project, item, field, option}` → `true` once the item's Status is set, or cleared with no `option`; `gh.scopes` → gh's token scopes for github.com, from `gh auth status`.
- `gh.tasks` stays for `github_repo` boards.

## Data and config

- `~/.moonlet/trackers.toml` gains `[[boards]]`:
  - `id`, `name`, `connection`, `workspace`, `pinned`
  - `[boards.origin]`: `kind` (`jira_board`, `jql`, `linear_team`, `github_project`, `github_repo`, `clickup_list`) and its key (`board`, `query`, `team`, `owner` + `number`, `repo`, `list`)
  - `narrow` (JQL), `labels`, `assignee` (`me` or `anyone`), `finished` (a number of days, `14` by default, or `"sprint"`)
  - `[[boards.columns]]`: `name`, `statuses` (Jira status ids; else state names, as Linear and ClickUp, and a GitHub repository's `open`, `completed`, `not_planned`), `category` (`todo`, `in_progress`, `in_review`, `done`: hiding a column is its `show`), `show` (`show`, `fold`, `hide`), `wip` (`config.rs` a_columns_category_is_one_of_four_and_hiding_is_its_show)
  - `[[boards.rules]]`: `when` (`"default"`, `{ component = "…" }` or `{ label = "…" }`) and `project`, one project per rule
  - `cards` (a list of field names: `issue_type`, `points`, `assignee`, `parent`, `due`, `labels`)
  - `states`: the state mapping a migrated source brought, or the States dialog saved (X44): it gives a board's first columns their categories, and the dialog applies it to the columns at once
- `migrated`: each repository that got its board, `<workspace> <connection>/<owner/name>` in lower case (`local/acme github:github.com/acme/web`), so a removed one is not added again.
- `[[connections.sources]]` and `connections.states` are read, become boards when the file loads, and are not written again.
- A board's columns are kept with the user's order, folding and categories. On each sync they are matched to the tracker's by status (`matchColumns`), against the board as it is when the file is written, so a change made during the sync stays. The file is written only when the columns changed.
- `.moonlet/config.toml`'s `trackers = ["<connection>/<key>"]` (X44) stays. It is the default for a board's By default row. A new session from a task starts in, in this order:
  1. the board's matching rule
  2. the board's By default row
  3. the projects that link the task's tracker project
  4. X46's fallback

  A rule's project, or the By default row's projects, all of them. (`boards.test.ts` takes the first matching component or label rule, then the board's default, then the projects linking the tracker project)
- The app's local storage keeps, per workspace, the board last shown, and per board, the Assignee picked over its own setting (`tasks.assignee`).

## Security considerations

- A JQL query and the narrowing clause are the user's own. They are sent only to that connection's site, in the request body.
- Board, column and status names from trackers are untrusted and shown as plain text.
- The GitHub scope message shows a command to copy. moonlet never runs `gh auth login` or `gh auth refresh` and never asks for a token; it reads `gh auth status` for the scopes.

## Out of scope

- An "Across boards" section (My tasks, In review, Out of sync, Sessions without a task over every board).
- A Current cycle view across Linear teams; boards built from Linear projects or custom views.
- Drag and drop between columns. Creating tasks (the `+` on a column) gets a spec of its own.
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

- **Opens on.** Decided 2026-10-18: left out. The design's Settings page lets each workspace open Tasks mode on its current cycle, active sprint or Sessions mode; Tasks mode opens on the board last shown.
- **`+` on a column.** Decided 2026-10-18: built, under a spec of its own. The design's Linear board has a `+` per column that creates a task there, in that column's status.
