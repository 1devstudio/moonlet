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

- [ ] A host's 20-second poll does not start a pass while that host's previous one is still running. (The pass over every session when a host connects is not part of it; each session is still asked once at a time.)
- [ ] The 20-second poll checks the open session, sessions with an agent working, and sessions with terminal output or a change in their status in the last 5 minutes.
- [ ] It checks every other session once it has gone 5 minutes without a check.
- [ ] A session never checked yet is checked on the next poll.
- [ ] Opening a session checks it at once, as before.
- [ ] A session whose status failed (its worktree gone, say) is asked again at the 5-minute pace, not on every poll.

Daemon, `git.status`:

- [ ] A status against a local base, or against HEAD, runs 2 git processes (`status` and one `diff`) once the worktree's root is known. The root is looked up once per path, and again after a failed status. A base only on `origin` costs one more `diff`, and a missing base two more.
- [ ] Its answer is the same as before: the same files, status letters, staged and unstaged flags, line counts, binary flags, and `base_missing`.
- [ ] A worktree without commits diffs against the empty tree, as before.
- [ ] A base that is neither a local branch nor on `origin` falls back to HEAD with `base_missing` set, as before.
- [ ] A base with several merge bases (main and the branch merged each other), which `git diff --merge-base` refuses, or a git before 2.30, which lacks it, diffs against `git merge-base`'s pick, as before.
- [ ] A diff that times out is an error, as before, not a missing base.
- [ ] `against` names the ref the diff is against (`main`, `origin/main`, `HEAD`, or the empty tree) instead of the merge-base's hash. No client reads it.

## UI

No change.

## Protocol and RPCs

`git.status` answers as before, except `against` (see above).

## Data and config

No config. The intervals are fixed: 20 seconds for active sessions, 5 minutes for the rest, and a session counts as active for 5 minutes after its last output or change.

## Security considerations

`base` comes from the client. `git diff` has options that write files (`--output=<file>`), so the base goes after `--end-of-options` and is never read as an option.

## Out of scope

- A cap on how many processes the daemon runs at once, and a list of them in the sidebar footer. Deferred until these changes have been measured.
- Watching worktrees for changes so the daemon runs git only after a file changes.

## Test plan

- Vitest `apps/desktop/src/lib/gitPoll.test.ts` › "background git poll passes (X102)": "starts no second pass on a host while its first still runs", "checks a session nobody works in again once it has gone 5 minutes without a check", "checks a session with a working agent on every poll", "checks a session on every poll for 5 minutes after its terminal last printed", "checks a session nobody works in as soon as it is opened", "checks the open session on every poll", "checks a session on every poll for 5 minutes after its status changed".
- Rust `crates/moonlet-core/tests/status_processes.rs` › `a_status_against_the_base_runs_two_git_processes`, which counts the `start` events in git's trace2 log.
- Rust `crates/moonlet-core/src/git.rs` › `status_against_the_base_reports_each_kind_of_change` (added, deleted, renamed, binary, committed and uncommitted, a local and an `origin/` base), `status_against_a_base_with_two_merge_bases_uses_one_of_them`, `a_base_that_looks_like_an_option_is_not_found_and_runs_nothing`; the existing `status_against_head_and_base` (a missing base) and `fresh_repo_without_commits` stay green.
- Manual: `top` on a Mac with many sessions, before and after.

## Open questions

- None.
