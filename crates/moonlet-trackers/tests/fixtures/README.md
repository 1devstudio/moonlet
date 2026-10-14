# Tracker API fixtures

Gathered on 2026-10-15 from the trackers' official API documentation; no live account was used. Each file is one of:

- **VERBATIM**: a documented example response or request body, trimmed to the fields moonlet reads (field names and nesting unchanged).
- **VERBATIM+**: a documented example with small, noted edits (a second item added, text replaced).
- **SCHEMA**: built from the official schema where the docs give no example (Linear has none).
- **CAPTURED**: a real error answer to a deliberately invalid token.

| File | Kind | Source |
|---|---|---|
| `linear-viewer.json`, `linear-teams.json`, `linear-issues.json`, `linear-states.json`, `linear-issue-update.json`, `linear-comment.json` | SCHEMA | Linear's GraphQL schema, `linear/linear` `packages/sdk/src/schema.graphql`; https://linear.app/developers/graphql |
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
| `clickup-lists.json`, `clickup-tasks.json`, `clickup-update-task-request.json`, `clickup-comment-request.json` | VERBATIM+ | same; tasks use the object form of `assignees` and `tags` from the Get Task example |
| `clickup-error-401.json`, `clickup-error-no-header.json` | CAPTURED | a bad token, and no Authorization header |
