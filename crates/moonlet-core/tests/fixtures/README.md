# moonlet-core fixtures

Each file is gh's real output, captured from the maintainer's own GitHub account and sanitised before commit (titles, logins, repository names, URLs and node ids replaced; issue bodies emptied). Edits beyond sanitising are listed.

| File | What | Notes |
|---|---|---|
| `gh-issue-list.json` | `gh issue list --json <GH_TASK_FIELDS>` (X44) | |
| `gh-projects.json` | `gh api graphql` with `projects_query(1)` (X50): the user's Projects and an organisation's (none) | Captured 2026-10-17 |
| `gh-project-items.json` | `gh api graphql` with `ITEMS_QUERY` for a user's Project (X50) | Captured 2026-10-17. Added: an assignee and a label on the first issue, and one pull request item (its `content` is empty, as gh gives for items that are not issues); the Project's `fields` and each item's `fieldValues`, in the shape gh gave on 2026-10-18 (fields of other kinds come as `{}`; none of the user's Projects had a number field), with two number fields, Estimate and Hours: #10 Estimate 3 and Hours 8, #11 Estimate 0.5, #12 Hours 5 |
| `gh-error-read-project-scope.json` | The projects query with a token without `read:project` | Captured 2026-10-17, unchanged |
| `gh-error-project-scope.json` | `updateProjectV2ItemFieldValue` with a token without `project` | Captured 2026-10-17, unchanged (a move to the item's own status, so nothing changed) |
| `gh-project-move.json` | `updateProjectV2ItemFieldValue` with the `project` scope (X50 moves) | Captured 2026-10-17, unchanged but for the item id (a move to the item's own status, so nothing changed) |
| `gh-auth-status.txt` | `gh auth status` with one account (X50: the scopes moves need) | Captured 2026-10-17; the login and the masked token replaced |
| `gh-project-clear.json` | `clearProjectV2ItemFieldValue` with the `project` scope (X50 No Status) | Captured 2026-10-17 on an issue with no Status already, so nothing changed; the item id replaced |
| `gh-issue-create.json`, `gh-assignees.json`, `gh-labels.json`, `gh-repo-permissions.json` (X52) | `gh api` on a sandbox repository: `repos/{r}/issues -X POST` (title, body, an assignee, the `bug` label), `repos/{r}/assignees`, `repos/{r}/labels`, `repos/{r}` | Captured 2026-10-18, sanitised: login `sam-rivera`, repo `acme/web`, every node id `*_e2eNNNN`, numeric ids replaced, avatars one placeholder; three of the default labels kept; the test issue was deleted after |
| `gh-error-issue-create.json` (X52) | `gh api repos/{r}/issues -X POST -f title=` (an empty title) | Captured 2026-10-18, unchanged; gh's stderr was `gh: Validation Failed (HTTP 422)` |
