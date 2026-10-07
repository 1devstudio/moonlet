# X11: Stacked pull requests

- **Status:** implemented
- **Priority / phase:** P1 · phase 3 (extends [X2](X2-pull-requests-and-checks.md))

## Summary

GitHub groups dependent pull requests into a stack (created with `gh stack`). When the session's PR belongs to a stack, the right panel's top bar shows where it sits in the stack and lists every PR in it, so the user can see the state of the whole chain and open any PR in it.

## User journey

1. The user opens a session whose branch has a PR that is part of a GitHub stack.
2. Next to the PR button, a stack chip shows the PR's position and the stack size, for example `3/5`.
3. Clicking the chip opens a list of the stack's PRs, top of the stack first. Each row shows the state icon, the title, and `#number · branch`. The session's own PR is marked.
4. Clicking a row opens that PR in the browser.

## Behaviour and acceptance criteria

- [x] `gh.pr_stack {path, number}` returns `null` when the PR is not in a stack (or the host has no stacks API).
- [x] Otherwise it returns the stack number, base branch, the PR's 1-based position (1 = closest to the base), the stack size, and the PRs bottom first with number, title, URL, state, draft flag and head branch.
- [x] A PR's state is `open`, `merged` or `closed`, the same values as `gh.pr_status`, so `prTone` colours it.
- [x] The UI fetches the stack whenever it reloads the PR status (every 60 s while the session is open), and only for the selected session.
- [x] The chip is hidden when the PR has no stack, or when the loaded stack does not contain the session's current PR (a stale result from a previous PR).
- [x] When polls overlap, only the most recent one updates the PR and the stack.
- [x] Clicking a row opens that PR's URL in the browser.

## UI

`TopActions` in `RightPanel.tsx`: a `Layers` icon plus `position/size` chip left of the PR button. The dropdown uses the same overlay pattern as the More menu: a fixed backdrop closes it, rows are 2 lines (title, then `#number · branch` in muted text), and the current PR has a filled dot on the right.

## Protocol and RPCs

`gh.pr_stack {path, number}` → `PrStack | null`.

The daemon makes two `gh api` calls from the work tree:

1. `repos/{owner}/{repo}/pulls/<number>`: the PR's `stack` field holds the stack number, or `null` when it is not stacked.
2. `repos/{owner}/{repo}/stacks/<stack>`: the stack's base and its pull requests, bottom first.

## Security considerations

Read-only. `number` is a JSON integer, so it cannot inject arguments into `gh`. Authentication stays with `gh`.

## Out of scope

- Creating, rebasing or merging stacks from moonlet (use `gh stack`).
- Showing stack membership in the sidebar: it would cost two more `gh` calls per session on every poll.
- Switching to a moonlet session from a stack row.

## Test plan

- Unit: `parse_stack` maps the stacks API response (merged, closed, open and draft PRs, position, missing fields).
- Unit (`apps/desktop/src/lib/prStack.test.ts`): `stackView` lists the stack top first, takes the position from the current PR, and hides a stack that does not contain it. `latestOnly` lets only the most recent poll set state.
- Manual: a session on a stacked PR shows the chip and the list; a session on an unstacked PR shows no chip.
