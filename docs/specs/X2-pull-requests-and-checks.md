# X2: Create PR and Checks tab

- **Status:** implemented
- **Priority / phase:** P1 · phase 3 (new scope from the Superset/Conductor UI direction)

## Summary

From a workspace, the user can push the branch and open a GitHub pull request with the `gh` CLI. The Checks tab then shows the PR's state, review decision and CI checks.

## Behaviour and acceptance criteria

- [x] `gh.pr_create {path, title, body, base, draft}` runs `git push -u origin HEAD`, then `gh pr create`, and returns the PR.
- [x] `gh.pr_status {path}` returns the number, URL, state, title, review decision and checks; it returns `null` when the branch has no PR.
- [x] UI: a Create PR dialog (Cmd+Shift+P) prefilled from the workspace name and commit log, and a Checks tab that polls every 30 s while visible.

- [x] The PR button in the right panel's top bar opens the PR in the browser when one exists, and shows an external-link icon on hover. With no PR it opens the Create PR dialog and shows a plus icon on hover.

## Security considerations

Pushing and opening a PR are outward-facing. The UI calls `gh.pr_create` only after the user confirms in the dialog. The daemon RPC itself is not gated: any client allowed on the socket (the same user) can call it directly. Authentication stays with `gh`.
