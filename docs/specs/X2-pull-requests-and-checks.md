# X2: Create PR and Checks tab

- **Status:** implemented
- **Priority / phase:** P1 · phase 3 (new scope from the Superset/Conductor UI direction)

## Summary

From a workspace, the user can push the branch and open a GitHub pull request with the `gh` CLI. The Checks tab then shows the PR's state, review decision and CI checks.

## Behaviour and acceptance criteria

- [x] `gh.pr_create {path, title, body, base, draft}` runs `git push -u origin HEAD`, then `gh pr create`, and returns the PR.
- [x] `gh.pr_status {path}` returns the number, URL, state, title, review decision and checks; it returns `null` when the branch has no PR.
- [x] A session keeps its PR by number, because branch names and worktree paths get reused after an archive. The number is recorded when `gh.pr_create` succeeds, when the session is opened from a PR, or the first time `gh.pr_status` finds the PR on the session's branch. After that, `gh.pr_status` reads the PR by number, even if the branch is renamed.
- [x] Before the number is known, `gh.pr_status` takes the newest PR heading the session's branch that is open or was created after the session. A closed or merged PR from an earlier branch of the same name is not the session's PR. If the recorded PR was closed without merging, a newer PR on the branch replaces it.
- [x] Commit statuses (such as CodeRabbit's) count as checks too: a finished status shows as completed with its state as the conclusion, so it stops spinning.
- [x] UI: a Create PR dialog (Cmd+Shift+P) prefilled from the workspace name and commit log, and a Checks tab that polls every 30 s while visible.
- [x] The sidebar, the PR button and the Checks tab show one shared PR state per session, so whichever poll sees a change first updates all three. The PR button polls every 60 s. In the background, every session whose PR is not merged is re-read every 5 min and whenever the window regains focus (at most once per 15 s), so a PR merged in the browser shows as merged on return. Open PRs are also re-read every 60 s, so a merge by an agent or from a terminal shows within a minute. A merged PR is final and its session is not polled again in the background. Background polls run a few sessions at a time, and an answer to an older poll never overwrites a newer one.
- [x] PR state uses one colour everywhere (sidebar row, the PR button and the Checks tab): open is green, merged is purple, closed is red. A merged PR is labelled `merged` next to the session and on the PR button.

- [x] The PR button in the right panel's top bar opens the PR in the browser when one exists, and shows an external-link icon on hover. With no PR it opens the Create PR dialog and shows a plus icon on hover.

## Security considerations

Pushing and opening a PR are outward-facing. The UI calls `gh.pr_create` only after the user confirms in the dialog. The daemon RPC itself is not gated: any client allowed on the socket (the same user) can call it directly. Authentication stays with `gh`.
