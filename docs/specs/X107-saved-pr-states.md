# X107 — Saved PR states and stacks

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (extends [X2](X2-pull-requests-and-checks.md) and [X11](X11-pr-stacks.md))
- **Related specs:** [X102](X102-fewer-background-git-processes.md)

## Summary

The app learns each session's pull request (the sidebar's PR state, the PR button, the stack chip) by asking GitHub through `gh`. Nothing of it is kept: after the app or the daemon starts again, every session is asked again, merged ones included, and a stack is fetched again each time a session is opened. With many sessions, the sidebar fills slowly, and it costs many GitHub requests. With this feature, the daemon keeps what it last heard about each session's PR and about each stack in a file. A merged PR is never asked about again. A reopened app shows every saved PR at once and asks GitHub only about the ones that can still change.

## User journey

1. The user quits the app with 40 sessions, 25 of them on merged PRs.
2. They open it again. The sidebar shows every session's PR state from the start: merged, open, draft, closed or no PR.
3. In the background the app asks GitHub about the open PRs only, and about sessions with no PR it has not asked about in the last 5 minutes. The merged ones are never asked about again.
4. They open a session on a stacked PR. Its PR is asked about at once, and the stack chip shows the saved stack at once, then the one fetched from GitHub.

## Behaviour and acceptance criteria

### The daemon keeps each session's PR

- [ ] After `gh.pr_status` finds a session's PR (or finds that it has none), the daemon saves the answer, with the time it was checked, in `~/.moonlet/prs.json`. It is still there after the daemon restarts.
- [ ] `gh.pr_status` for a session whose saved PR is merged, and is still the session's PR, answers with the saved PR without running `gh`. A merged PR cannot change.
- [ ] A failed lookup (no `gh`, offline) leaves the saved answer as it was.
- [ ] `gh.pr_known {}` returns, for every live session of this host with a saved answer, that answer and when it was checked. It never runs `gh`.
- [ ] A session that is archived or deleted no longer appears in `gh.pr_known`.
- [ ] A path that no session owns is looked up as before and nothing is saved.

### The daemon keeps each stack

- [ ] After `gh.pr_stack` finds a PR's stack, the daemon saves the stack with the time it was fetched. A PR found not to be in a stack is saved as such.
- [ ] Within 60 s of the last fetch, `gh.pr_stack` for any PR of that stack answers from the saved one, so the desktop app, the phone and every session in the stack share one fetch a minute.
- [ ] A stack with no open PR in it is not fetched again by the polls; only opening a session fetches it.
- [ ] When a saved stack is older than 60 s and still has an open PR, only the stack is fetched again (1 call instead of 2). If the PR is no longer in it, the PR's stack is looked up as before.
- [ ] `gh.pr_stack {path, number, known: true}` answers with the saved stack, or `null`, without running `gh`.
- [ ] `gh.pr_stack {path, number, refresh: true}` asks GitHub however fresh the saved stack is: only the stack when one is saved, and saves the answer.
- [ ] The answer's `position` is the asked PR's place in the saved stack, whichever PR's lookup saved it.

### The app shows saved states first and asks less

- [ ] When the app connects to a host, it reads `gh.pr_known` first and shows those PRs in the sidebar before any `gh` runs. A daemon without `gh.pr_known` leaves the app as before.
- [ ] The app's PR poll starts at once, not after every session's git status has been read.
- [ ] The background polls (every 5 minutes and on coming back to the window) skip merged PRs, as before. They also skip a session with no PR, or with a closed one, that was checked less than 5 minutes before the poll started. An open PR is asked about on every poll, as before.
- [ ] The open session's own poll (the PR button and the Checks tab) asks the moment the session opens and every 60 s after, whatever the pause, so a PR just made in the open session shows within a minute.
- [ ] On opening a session, the stack chip shows the saved stack first (`known: true`), then the one fetched with `refresh: true`. The minute polls after it share the saved stack. The phone's PR screen fetches with `refresh: true` when it opens.

## UI

No change in look. The sidebar, PR button and stack chip only fill in sooner.

## Protocol and RPCs

- New `gh.pr_known {}` → `{ [session_id]: { pr: PullRequest | null, checked_at: number } }`. For the app only: neither the phone nor local callers get it.
- `gh.pr_stack` takes optional `known: bool` and `refresh: bool` (both default `false`; `known` wins). An older daemon ignores them and fetches.
- `gh.pr_status` keeps its shape; the answer may come from the saved file.

## Data and config

`~/.moonlet/prs.json`, written whole, as `state.json` is:

```json
{
  "sessions": { "<session id>": { "pr": { "number": 12, "state": "merged", "...": "..." }, "checked_at": 1763550000000 } },
  "stacks": { "<project id>": [ { "stack": { "number": 4, "base": "main", "prs": ["..."] }, "checked_at": 1763550000000 } ] },
  "unstacked": { "<project id>#<pr number>": 1763550000000 }
}
```

It is this host's own record: it is not part of the account state and is not copied to other members (X68). It is a cache, so if it cannot be read the daemon starts with an empty one and asks GitHub again. Entries of sessions that no longer exist are dropped the next time the file is written.

## Security considerations

Nothing new crosses a trust boundary. The file holds what `gh` already returned (titles, URLs, check names), is written with the home folder's private permissions, and is read only by the daemon. `gh.pr_known` goes only to the proven app.

## Out of scope

- Telling the app when an agent or a terminal runs `gh pr create` or `gh pr merge` in a session that is not open. It is found by the next background poll: within 5 minutes, or when the session is opened.
- Copies of sessions run by another member (X72): their PRs are asked about as before.
- Webhooks or GitHub's ETag caching.

## Test plan

- Rust, `crates/moonlet-core/src/pr_cache.rs`: whether a saved stack is still good (fresh, or with no open PR, or stale), and the position of a PR in a saved stack, from literal stacks.
- Rust, `crates/moonletd/tests/daemon.rs`, with a fake `gh` that logs its calls:
  - a merged PR is answered from the saved one with no new `gh` call, and `gh.pr_known` returns it after a restart;
  - a stack is answered from the saved one within 60 s, `known: true` returns it after a restart with no `gh` call, and `refresh: true` fetches only the stack.
- Vitest, `apps/desktop/src/lib/prPoll.test.ts`: `needsPrPoll` skips sessions with no PR, or a closed one, checked within 5 minutes, and still polls open ones and ones never checked. `knownPrs` keeps PRs the app already holds over saved ones.
- Manual: reopen the app with many sessions; the sidebar shows PR states at once.

## Open questions

- None. Decided: the pause for sessions with no PR is 5 minutes, and opening a session asks about its PR and its stack at once, so a reopened PR in a finished stack shows when its session is opened.
