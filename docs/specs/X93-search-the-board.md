# X93 — Search the board

- **Status:** implemented (2026-11-08)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X45 (Tasks mode), X50 (boards), X44 (task trackers), X46 (tasks in sessions), X52 (new issue from a column)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)

## Summary

"Find a task" moves from the Tasks sidebar into the board header and stops filtering the board. Typing in it opens a dropdown of the tasks that match, by key, title, the name of a session working on the task, or that session's branch. Tasks the board shows are listed first; picking one highlights its card and scrolls to it, opening its column for the moment if the column is folded. Tasks the board does not show come from the workspace's other boards and from a search in each of their trackers; picking one opens a preview, where the user can open it in the tracker, switch to the board that has it, reopen it, or start a session for it. Today the field hides every card that doesn't match, which loses the board's shape, and it finds only what the board already shows.

## User journey

1. On the board `Moonlet · Cycle 14`, the user presses ⌘F and types `host`.
2. The dropdown lists **On this board · 4**: `MOON-149 Show remote host health in the sidebar footer` (Todo), `MOON-142 Remote hosts sidebar` (In Progress), `MOON-136 Context window meter in the chat footer` with a second line `branch moon-136-context-meter-on-host` (In Review), and `MOON-127 Reconnect a host after sleep` (Done).
3. Under it, **Not on this board · 3**: `CDK-41 Changelog themes` (`Changedeck · Cycle 9 · In Progress`), then the Linear search's `MOON-97 Ask before trusting a new SSH host key` (`Linear · no cycle · Backlog`) and `MOON-118 Host picker in the composer` (`Linear · Cycle 12 · Canceled`).
4. The user presses ↓ three times and ↵ on `MOON-127`. The dropdown closes. The folded Done column opens, its header saying "unfolded to show MOON-127", and the card is scrolled into view with an accent ring and "Found".
5. The user clicks the field again and picks `MOON-97`. A preview opens with its state, assignee, sessions and description, and says the board can't show it. **New session** opens the composer with the task, as the detail's New session does (X46).
6. Picking `CDK-41` instead offers **Switch to Changedeck · Cycle 9**, which shows that board with the card found on it.
7. For `xyzzy` the dropdown says "No task matches “xyzzy”", "Searched this board, your other boards and Linear.", and offers "Create “xyzzy” in Linear".

## Behaviour and acceptance criteria

### The field

- [x] The board header has a "Find a task" field after the board switcher, with the placeholder "Find a task: key, title, session or branch". The sidebar no longer has one. The field shows `⌘F` while empty and a clear button (×) while it has text. (`tasks-mode.e2e.ts` finds a task from the header's Find a task (⌘F) without filtering the board, by title or a session's branch, and finds one in the folded Closed column (X93); the field seen in the app with `e2e/snap.ts`)
- [x] ⌘F in Tasks mode focuses the field and selects its text. In Sessions mode ⌘F is still Find in terminal; in Tasks mode it no longer marks the terminal's find bar open. (`tasks-mode.e2e.ts` finds a task from the header's Find a task (⌘F) without filtering the board, by title or a session's branch, and finds one in the folded Closed column (X93))
- [x] The board and the List are never filtered by the field: every card the board draws stays, whatever is typed. The header's other filters (Assignee, Columns, Hide empty Done) work as before. This replaces X45's "Find a task filters the board". (`tasks-mode.e2e.ts` finds a task from the header's Find a task (⌘F) without filtering the board, by title or a session's branch, and finds one in the folded Closed column (X93))
- [x] The field is per workspace and lasts until the user clears it or the app restarts; nothing is saved. (`tasksStore.test.ts` keeps each workspace's query and found task apart)

### What matches

- [x] Matching ignores case and leading or trailing spaces, and looks for the typed text as one piece (a substring), not letters in order. An empty field matches nothing and shows no dropdown. (`boardSearch.test.ts` finds the board's tasks by key or title, ignoring case and outer spaces, in the board's column order, marking the matched text; finds nothing for an empty or blank query)
- [x] A task on the shown board matches by its key, its title, the name of a session on its card, or that session's branch. When the key or title matches, the row shows no second line; otherwise the second line names the first session that matched by name (`session <name>`), else by branch (`branch <branch>`), with that session's state glyph. (`boardSearch.test.ts` finds a task by the name of a session on its card, else by that session's branch, naming the session on a second line only then; `tasks-mode.e2e.ts` finds a task from the header's Find a task (⌘F) without filtering the board, by title or a session's branch, and finds one in the folded Closed column (X93))
- [x] A task not on the shown board also matches by its description. (`boardSearch.test.ts` lists the other boards' tasks, by description too, then what each tracker's search found, saying where each is)
- [x] Each row marks the matched text in the key, the title and the second line. (`boardSearch.test.ts` finds the board's tasks by key or title, …, marking the matched text; finds a task by the name of a session on its card, …)

### On this board

- [x] **On this board** lists the cards the board draws now, in a shown or folded column, after the header's filters: in the board's column order, then the column's card order. A task in a hidden column, or one the filters leave out, is not on this board. (`boardSearch.test.ts` finds the board's tasks by key or title, … in the board's column order; leaves out what the shown board or another board already lists, …)
- [x] A row shows the column's glyph, the key, the title, the state glyphs of the card's sessions and the column's name. (`boardSearch.test.ts` shows the state of each session on the card; the layout seen in the app with `e2e/snap.ts`)
- [x] Picking a row closes the dropdown, keeps the query, and marks the card **found**: an accent border and ring and a "Found" label. The card is scrolled into view, across the board and down its column. Found is not selected: the detail panel stays as it was, and clicking the card's title opens it as before. (`tasks-mode.e2e.ts` finds a task from the header's Find a task (⌘F) without filtering the board, by title or a session's branch, and finds one in the folded Closed column (X93))
- [x] When the found card is in a folded column, the column opens for the moment, its header saying "unfolded to show `<key>`". It folds again when the field is cleared, another task is found, or another board is shown. Its saved folding in `trackers.toml` does not change. (`boardSearch.test.ts` opens the folded column that holds the found task, saying why, and leaves the others as they are; `tasks-mode.e2e.ts` finds a task from the header's Find a task (⌘F) without filtering the board, by title or a session's branch, and finds one in the folded Closed column (X93))
- [x] The found mark goes when the field is cleared, another row is picked, or another board is shown. (`tasksStore.test.ts` drops the found mark when the field is cleared, another task is found, or another board is shown)
- [ ] In the List layout, picking a row scrolls to the task's row and marks it found, opening a folded group for the moment in the same way. (Partly: the List draws the same opened columns as the board, `boardSearch.test.ts` opens the folded column that holds the found task, …; the row's mark and scrolling have no test and were not yet looked at in the app)

### Not on this board

- [x] **Not on this board** lists, after the workspace's other boards' matching tasks (in the sidebar's board order), the tasks each tracker search found, with tasks already listed above or on the shown board left out. At most 8 rows show from each tracker. (`boardSearch.test.ts` lists the other boards' tasks, …; leaves out what the shown board or another board already lists, and keeps at most 8 of each tracker's tasks)
- [x] Tracker search covers the connection of every board of the workspace, each connection once:
  - Linear: the issues of the workspace's boards' teams that match the text (Linear's `searchIssues`), finished and canceled ones too.
  - Jira: the issues of the projects the workspace's boards hold that match `text ~` the query.
  - GitHub: the issues of the workspace's repository boards' repositories, and of the repositories of its Project boards' items, open or closed, that `gh` finds for the query.
  - ClickUp: only a task whose id or custom id is typed, since ClickUp's API has no text search.

  (`boardSearch.test.ts` searches each connection of the workspace's boards once, in the boards' teams, projects and repositories; skips a connection that needs attention, and one with nothing to search in; `linear.rs` a_search_finds_issues_of_the_boards_teams_finished_and_canceled_ones_too (the answer in the shape of Linear's schema, not captured); `jira.rs` a_search_asks_for_the_projects_issues_whose_text_has_the_query_and_nothing_else; `git.rs` a_search_lists_a_repositorys_open_and_closed_issues_that_match_the_text (captured); `tasksStore.test.ts` searches each tracker of the workspace's boards once 2 characters are typed, in their teams and repositories; `tasks-mode.e2e.ts` finds a task the board doesn't show through gh's search, previews it with Reopen and New session, and offers Create when nothing matches (X93))
- [x] A typed key or URL (as the link dialog takes, X46) is also looked up by key in its tracker, so an issue outside every board's team or project is found. (`tasksStore.test.ts` also looks up a typed key in its tracker)
- [x] Tracker searches start once at least 2 characters are typed and the typing pauses (250 ms). A newer query drops the answers of an older one. While a search runs, "Searching `<tracker>`…" shows at the end of the dropdown, and No match waits for every search to answer. (`tasksStore.test.ts` searches each tracker of the workspace's boards once 2 characters are typed, …; drops what an older query found once a newer one is typed)
- [x] A row shows the task's state glyph (dashed for a backlog state), the key, the title and where it is: `<board> · <column>` for another board's task; `<tracker> · <cycle> · <state>` for a Linear issue (`no cycle` without one); `<tracker> · <state>` otherwise. (`boardSearch.test.ts` lists the other boards' tasks, … saying where each is; says where a GitHub or Jira issue is by its tracker and state)
- [x] A tracker search that fails leaves that tracker's rows out and says so under the results: "Couldn't search `<tracker>`: `<error>`". A connection that needs attention (X44) is not searched. (`tasksStore.test.ts` says which tracker's search failed and keeps the others' results; `boardSearch.test.ts` skips a connection that needs attention, …)
- [x] Picking a row opens the **preview** (below) and closes the dropdown. (`tasks-mode.e2e.ts` finds a task the board doesn't show through gh's search, previews it with Reopen and New session, and offers Create when nothing matches (X93))

### No match

- [x] When nothing matches and every search has answered, the dropdown says "No task matches “`<query>`”" and "Searched this board, your other boards and `<trackers>`." (`…, your other boards, Linear and Jira.` with two). (`boardSearch.test.ts` says nothing matched, and where it searched, naming the trackers; `tasks-mode.e2e.ts` finds a task the board doesn't show through gh's search, previews it with Reopen and New session, and offers Create when nothing matches (X93))
- [x] It offers "Create “`<query>`” in `<tracker>`" when the shown board can create an issue (X52): it opens the column `+` form of the board's first column that takes new issues, with the query as the title. A board that can't create (X52's locks) shows no link. (`newIssue.test.ts` starts the form with the text searched for as its title; creates in the board's first column that takes new issues; `tasks-mode.e2e.ts` finds a task the board doesn't show through gh's search, previews it with Reopen and New session, and offers Create when nothing matches (X93))

### Keys

- [x] The first row is active when the dropdown opens. ↑ and ↓ move through both groups; ↵ picks the active row; Esc closes the dropdown and keeps the query; Esc in the field with the dropdown closed clears it. Typing or focusing the field opens the dropdown again. A click outside closes it. (`tasks-mode.e2e.ts` finds a task from the header's Find a task (⌘F) without filtering the board, by title or a session's branch, and finds one in the folded Closed column (X93); `tasks-mode.e2e.ts` finds a task the board doesn't show through gh's search, previews it with Reopen and New session, and offers Create when nothing matches (X93); the moves are `addProject.ts`'s `moveHighlight`, tested there)
- [x] The footer shows `↑↓ move`, `↵ open`, `esc close` and the number of results (`1 result`, `7 results`). (`boardSearch.test.ts` counts the results)

### Preview

- [x] The preview is a dialog over the board: the tracker's tile, the key, where it is, **Open in `<tracker>`** (the task's URL) and ×; the title; State, Assignee (or Unassigned) and Sessions (the sessions on its card on another board, or "None yet"); the description as Markdown; and why the board doesn't show it. (`tasks-mode.e2e.ts` finds a task the board doesn't show through gh's search, previews it with Reopen and New session, and offers Create when nothing matches (X93); seen in the app with `e2e/snap.ts`)
- [x] Why, and the action offered beside the buttons:
  - On another board of the workspace: "This task is on `<board>`. Switching shows it there with its columns." with **Switch to `<board>`**, which shows that board and finds the card on it.
  - In a finished state (done, canceled, or a GitHub issue closed as not planned) on no board: "This task is `<state>` in `<tracker>`, so the board doesn’t show it." with **Reopen in `<tracker>`**, which moves it as the State menu moves a task to Todo (X45), or reopens a GitHub issue. A backlog issue, which Linear's states also leave off a board, gets no Reopen.
  - Otherwise: "This task is in `<tracker>` but not on `<board>`, so the board can’t show it. You can still start a session from here." with no action.

  (`boardSearch.test.ts` offers to switch to the other board that has it; says the board can't show a task its tracker has elsewhere, with no action; offers nothing more for a backlog issue, …; offers to reopen a finished task on no board; `tasks-mode.e2e.ts` finds a task the board doesn't show through gh's search, previews it with Reopen and New session, and offers Create when nothing matches (X93). Switch to is not yet driven in e2e)
- [x] **New session** opens the new-session composer with the task preset, as the detail's New session does (X46), and closes the preview. **Back to the board** and Esc close it. (`tasks-mode.e2e.ts` finds a task the board doesn't show through gh's search, previews it with Reopen and New session, and offers Create when nothing matches (X93))

## UI

- The field: 32px high, rounded 8px, raised background, up to 440px wide. Its border is the accent colour while the dropdown is open with a query.
- The dropdown: 520px, under the field, rounded 12px, a strong border and shadow. Group headers in small caps with a count (`On this board · 4`) and a hint on the right (`selects it on the board`, `opens a preview`). Marked text has a translucent accent background. The active row has a raised background.
- A found card: accent border, a 4px translucent accent ring, a tinted background and "Found" in the accent colour beside the key.
- The temporarily opened column: its header ends with "unfolded to show `<key>`" in the accent colour.
- The preview: a 600px dialog near the top of the window with a dimmed backdrop. The why box has a search icon on a panel background. Footer: the action (ghost) on the left, then **Back to the board** (subtle) and **New session** (primary) on the right.
- Accessibility: the field is a `combobox` with `aria-expanded` and `aria-activedescendant`; the dropdown is a `listbox` of `option`s; the preview is a `dialog` labelled by its title.

## Protocol and RPCs

- New Tauri command `tracker_search { req: { id, query, scope } }` → the issues as `tracker_task` returns one, at most 8. `scope` is the Linear team keys or the Jira project keys to search; ClickUp takes no text search and a typed id uses `tracker_task`.
- New daemon RPC `gh.search { path, repo, query, limit }` → the issues of `gh issue list --repo <repo> --state all --limit <limit> --search=<query>`, in `gh.tasks`'s shape. An older daemon without it answers with an error, shown as "Couldn't search GitHub".

## Data and config

Nothing saved. The query, the found task and the temporarily opened column are kept in memory per workspace.

## Security considerations

- The query is untrusted text sent to trackers. In JQL it goes inside a quoted string with `\` and `"` escaped and Lucene's reserved characters escaped, so it can't change the rest of the query. For Linear it is a GraphQL variable. For `gh` it is one argument, never through a shell.
- Results are tracker data: titles and keys shown as plain text, descriptions rendered as sanitized Markdown, as X45 does.

## Out of scope

- **Add to Cycle `<n>`** for an issue outside the board's cycle (postponed: `tracker_update` can't set a cycle or sprint yet).
- Searching ClickUp by text, tasks of boards in other workspaces, and archived sessions (X86).
- Fuzzy matching (letters in order) and searching comments.
- The phone's Tasks tab (X76) keeps its own Find a task.

## Test plan

- Vitest: `boardSearch.test.ts` (matching, rows, groups, order, dedupe, the footer, the folded column opened for the found card, the preview's why and action, which trackers are searched), `tasksStore.test.ts` (the query and found mark per workspace, the tracker search: 2 characters, stale answers, failure, a typed key), `newIssue.test.ts` (the title prefilled, the column Create uses).
- Rust: `linear.rs` (the search query, its variables and its answer, in the schema's shape), `jira.rs` (the JQL and its escaping), `git.rs` (gh's arguments and a captured answer).
- e2e: `tasks-mode.e2e.ts` (⌘F; find by title and by a session's branch; pick a card in the folded Closed column; a gh search hit's preview with Reopen and New session; No match and Create).
- Screenshots with `e2e/snap.ts`: the dropdown, a found card in the opened column, the preview, No match.

## Open questions

- None.
