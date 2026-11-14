# X102 — Fewer background git processes

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X78 (background git poll), D1, D2
- **Related ADRs:** none

## Summary

The app asks for the git status of every open session every 20 seconds, so the sidebar can show each session's changes. On a Mac with about 110 sessions this made moonletd start about 30 git processes a second, and the load average reached 94 on 10 cores. Three things added up:

- One status ran 6 or 7 git processes: `rev-parse --show-toplevel`, `status`, `rev-parse --verify HEAD`, one or two `merge-base`, `diff --name-status` and `diff --numstat`.
- Every session was asked every 20 seconds, even ones nobody had touched for days.
- A host's new pass started while its previous pass was still running. Under load one pass took about 5 minutes, so about 15 passes ran at once.

This feature cuts all three. A status runs 2 git processes. Sessions nobody works in are checked every 5 minutes. A host's passes never overlap.

## User journey

1. The user has many sessions open. The Mac stays responsive, and moonletd's git processes no longer show in Activity Monitor most of the time.
2. An agent works in a session. Its changes show in the sidebar within about 20 seconds, as before.
3. The user edits a file in a session nobody works in, from another editor. The change shows in the sidebar within about 5 minutes, or at once when the user opens the session.

## Behaviour and acceptance criteria

App, background poll:

- [ ] A host's background pass does not start while that host's previous pass is still running.
- [ ] The 20-second poll checks the open session, sessions with an agent working, and sessions with terminal output or a change in their status in the last 5 minutes.
- [ ] It checks every other session once it has gone 5 minutes without a check.
- [ ] A session never checked yet is checked on the next poll.
- [ ] Opening a session checks it at once, as before.

Daemon, `git.status`:

- [ ] A status runs 2 git processes (`status` and one `diff`) once the worktree's root is known, and the root is looked up once per path.
- [ ] Its answer is the same as before: the same files, status letters, staged and unstaged flags, line counts, binary flags, and `base_missing`.
- [ ] A worktree without commits diffs against the empty tree, as before.
- [ ] A base that is neither a local branch nor on `origin` falls back to HEAD with `base_missing` set, as before.
- [ ] `against` names the ref the diff is against (`main`, `origin/main`, `HEAD`, or the empty tree) instead of the merge-base's hash. No client reads it.

## UI

No change.

## Protocol and RPCs

`git.status` answers as before, except `against` (see above).

## Data and config

No config. The intervals are fixed: 20 seconds for active sessions, 5 minutes for the rest, and a session counts as active for 5 minutes after its last output or change.

## Security considerations

None. No new inputs.

## Out of scope

- A cap on how many processes the daemon runs at once, and a list of them in the sidebar footer. Deferred until these changes have been measured.
- Watching worktrees for changes so the daemon runs git only after a file changes.

## Test plan

- Vitest `apps/desktop/src/lib/gitPoll.test.ts`: a second pass started during the first asks the daemon nothing new; idle sessions are checked every 5 minutes; active, open and never-checked sessions on each poll.
- Rust `crates/moonlet-core/src/git.rs` tests: the existing status tests (renames, binaries, untracked files, staged and unstaged, no commits, a missing base) stay green; a new test counts the git processes one status runs.
- Manual: `top` on a Mac with many sessions, before and after.

## Open questions

- None.
