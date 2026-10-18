# Tracker API fixtures

Gathered on 2026-10-15 from the trackers' official API documentation; no live account was used. The X50 Jira board files were added on 2026-10-17 from a real Jira Cloud site; the X50 Linear board files (`linear-board-issues.json`, `linear-active-cycle.json`) are SCHEMA, as Linear's other files. Each file is one of:

- **VERBATIM**: a documented example response or request body, trimmed to the fields moonlet reads (field names and nesting unchanged).
- **VERBATIM+**: a documented example with small, noted edits (a second item added, text replaced).
- **SCHEMA**: built from the official schema where the docs give no example (Linear has none).
- **CAPTURED**: a real error answer to a deliberately invalid token.
- **CAPTURED, SANITISED**: a real answer from a live site, trimmed to the fields moonlet reads, with every name, email, project key, label, summary, URL and account id replaced by made-up ones (ids of boards, statuses, filters and fields are kept).

| File | Kind | Source |
|---|---|---|
| `linear-viewer.json`, `linear-teams.json`, `linear-issues.json`, `linear-states.json`, `linear-issue-update.json`, `linear-comment.json`, `linear-board-issues.json`, `linear-active-cycle.json`, `linear-create-options.json`, `linear-issue-create.json` (X52) | SCHEMA | Linear's GraphQL schema, `linear/linear` `packages/sdk/src/schema.graphql`; https://linear.app/developers/graphql |
| `linear-error-auth.json` | CAPTURED | HTTP 401 to a bad personal key (and a bad Bearer token) |
| `linear-error-ratelimited.json` | VERBATIM+ | https://linear.app/developers/rate-limiting (message text is a placeholder) |
| `jira-myself.json` | VERBATIM | `GET /rest/api/3/myself`, https://developer.atlassian.com/cloud/jira/platform/rest/v3/ |
| `jira-projects.json` | VERBATIM | `GET /rest/api/3/project/search` |
| `jira-search.json` | VERBATIM+ | `POST /rest/api/3/search/jql`; status category keys are the real `new`, `indeterminate`, `done` (the doc example uses placeholders); descriptions follow the ADF docs |
| `jira-search-page1.json` | SCHEMA | a page with `nextPageToken` |
| `jira-transitions.json` | VERBATIM+ | `GET /rest/api/3/issue/{key}/transitions` |
| `jira-transition-request.json`, `jira-assignee-request.json`, `jira-comment-request.json`, `jira-comment.json` | VERBATIM | the transition, assignee and comment endpoints |
| `jira-error-401.json` | VERBATIM+ | the documented error body shape (`errorMessages`) |
| `jira-error-401.txt` | CAPTURED | what Jira actually sends with bad credentials: plain text with a JSON content type |
| `clickup-user.json`, `clickup-teams.json`, `clickup-spaces.json`, `clickup-folders.json`, `clickup-list.json`, `clickup-comment.json` | VERBATIM | https://developer.clickup.com/reference (append `.md` to a page for its OpenAPI) |
| `clickup-lists.json`, `clickup-tasks.json`, `clickup-update-task-request.json`, `clickup-comment-request.json` | VERBATIM+ | same; tasks use the object form of `assignees` and `tags` from the Get Task example, and its `due_date` on the first task, `null` on the second (X50) |
| `clickup-error-401.json`, `clickup-error-no-header.json` | CAPTURED | a bad token, and no Authorization header |
| `clickup-create-task.json`, `clickup-list-members.json`, `clickup-space-tags.json` (X52) | CAPTURED, SANITISED | 2026-10-18, from a sandbox list: `POST /list/{id}/task` (body in `clickup.rs` a_new_task_goes_in_the_columns_status_with_its_assignee_and_tags), `GET /list/{id}/member`, `GET /space/{id}/tag` (only three of the space's tags kept); the task was deleted after. Every id is a placeholder: the user `81942673`, the workspace `9015000001`, list `901500000002`, space `90150000003`, task `869e2e001`, statuses `p90150000003_e2e…` |
| `clickup-error-400-status.json` (X52) | CAPTURED | the same create with a status the list doesn't have |
| `jira-error-400-jql.json` | SCHEMA | Jira's error shape (`errorMessages`, `errors`) for a refused `POST /rest/api/3/search/jql`, with the message Jira gives for a field it doesn't know; the Atlassian connector hides the raw answer, so it was not captured (X50 Add a board's preview) |
| `jira-error-404-board.json` | SCHEMA | Jira's error shape for a 404 to `GET /rest/agile/1.0/board/{id}/configuration`, with the message Jira Software gives for a board that is gone; not captured (X50: a board whose origin is gone) |
| `jira-boards.json` | CAPTURED, SANITISED | `GET /rest/agile/1.0/board`; four of the site's boards (Scrum, Kanban, simple, and one with no project) |
| `jira-board-scrum-configuration.json` | CAPTURED, SANITISED | `GET /rest/agile/1.0/board/{id}/configuration` of a Scrum board; `max` added on one column in the documented `columnConfig` shape, since none of the site's columns had a limit |
| `jira-board-kanban-configuration.json` | CAPTURED, SANITISED | the same for a Kanban board: a Backlog column with no status, and a sub-filter |
| `jira-filter-scrum.json`, `jira-filter-kanban.json` | CAPTURED, SANITISED | `GET /rest/api/3/filter/{id}` of each board's filter, trimmed to `id`, `name`, `jql` |
| `jira-statuses.json` | CAPTURED, SANITISED | `GET /rest/api/3/status`, the statuses the two boards use |
| `jira-fields.json` | CAPTURED, SANITISED | `GET /rest/api/3/field`: the sprint field, the board's Story Points field and the site's other "Story point estimate" |
| `jira-board-search.json` | CAPTURED, SANITISED | four issues of an active sprint from the site's issue search (taken through the Atlassian MCP connector, whose wrapper is replaced by `/rest/api/3/search/jql`'s `{issues, isLast}`); the sprint's `boardId` set to the Scrum board's, one component added, and one due date set |
