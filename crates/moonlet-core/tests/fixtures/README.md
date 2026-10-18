# moonlet-core fixtures

Each file is gh's real output, captured from the maintainer's own GitHub account and sanitised before commit (titles, logins, repository names, URLs and node ids replaced; issue bodies emptied). Edits beyond sanitising are listed.

| File | What | Notes |
|---|---|---|
| `gh-issue-list.json` | `gh issue list --json <GH_TASK_FIELDS>` (X44) | |
| `gh-projects.json` | `gh api graphql` with `projects_query(1)` (X50): the user's Projects and an organisation's (none) | Captured 2026-10-17 |
| `gh-project-items.json` | `gh api graphql` with `ITEMS_QUERY` for a user's Project (X50) | Captured 2026-10-17. Added: an assignee and a label on the first issue, and one pull request item (its `content` is empty, as gh gives for items that are not issues) |
| `gh-error-read-project-scope.json` | The projects query with a token without `read:project` | Captured 2026-10-17, unchanged |
| `gh-error-project-scope.json` | `updateProjectV2ItemFieldValue` with a token without `project` | Captured 2026-10-17, unchanged (a move to the item's own status, so nothing changed) |
| `gh-project-move.json` | `updateProjectV2ItemFieldValue` with the `project` scope (X50 moves) | Captured 2026-10-17, unchanged but for the item id (a move to the item's own status, so nothing changed) |
| `gh-auth-status.txt` | `gh auth status` with one account (X50: the scopes moves need) | Captured 2026-10-17; the login and the masked token replaced |
| `gh-project-clear.json` | `clearProjectV2ItemFieldValue` with the `project` scope (X50 No Status) | Captured 2026-10-17 on an issue with no Status already, so nothing changed; the item id replaced |
