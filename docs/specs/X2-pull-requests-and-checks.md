# X2: Create PR and Checks tab

- **Status:** implemented
- **Priority / phase:** P1 · phase 3 (new scope from the Superset/Conductor UI direction)

## Summary

From a workspace, the user can push the branch and open a GitHub pull request with the `gh` CLI. The Checks tab then shows the PR's state, review decision and CI checks.

## Behaviour and acceptance criteria

- [x] `gh.pr_create {path, title, body, base, draft}` runs `git push -u origin HEAD`, then `gh pr create`, and returns the PR.
- [x] `gh.pr_status {path}` returns the number, URL, state, title, review decision and checks; it returns `null` when the branch has no PR.
- [x] UI: a Create PR dialog (Cmd+Shift+P) prefilled from the workspace name and commit log, and a Checks tab that polls every 30 s while visible.

## Security considerations

Pushing and opening a PR are outward-facing, so they happen only from the dialog's explicit confirm button. Authentication stays with `gh`.
