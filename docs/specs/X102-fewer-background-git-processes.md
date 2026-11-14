# X102 — Fewer background git processes

- **Status:** implemented
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

App, background poll (tests in `apps/desktop/src/lib/gitPoll.test.ts`):

- [ ] A host's pass over its sessions, the 20-second poll's or the one when it connects, does not start while another pass on that host still runs. Tests: "starts no second pass on a host while its first still runs", "starts no poll pass on a host while its pass on connecting still runs".
- [ ] The 20-second poll checks the open session, sessions with an agent working, and sessions with terminal output or a change in their status in the last 5 minutes. Tests: "checks the open session on every poll", "checks a session with a working agent on every poll", "checks a session on every poll for 5 minutes after its terminal last printed", "checks a session on every poll for 5 minutes after its status changed".
- [ ] It checks every other session once it has gone 5 minutes without a check. Test: "checks a session nobody works in again once it has gone 5 minutes without a check".
- [ ] A session never checked yet is checked on the next poll. Test: the first poll in each of the tests above.
- [ ] Opening a session checks it at once, as before. Test: "checks a session nobody works in as soon as it is opened".
- [ ] A session whose status failed (its worktree gone, say) is asked again at the 5-minute pace, not on every poll. Test: "asks again about a session whose status failed only once it has gone 5 minutes".

Daemon, `git.status` (tests in `crates/moonlet-core`):

- [ ] A status against a local base, or against HEAD, runs 2 git processes (`status` and one `diff`) once the worktree's root is known. The root is looked up once per path, and again after a failed status. A base only on `origin` costs one more `diff`, and a missing base two more. Test: `tests/status_processes.rs` › `a_status_against_the_base_runs_two_git_processes`.
- [ ] Its answer is the same as before: the same files, status letters, staged and unstaged flags, line counts, binary flags, and `base_missing`. Tests: `git::tests::status_against_the_base_reports_each_kind_of_change` (its file list passed on the old code too), `git::tests::status_against_head_and_base`.
- [ ] A worktree without commits diffs against the empty tree, as before. Test: `git::tests::fresh_repo_without_commits`.
- [ ] A base that is neither a local branch nor on `origin` falls back to HEAD with `base_missing` set, as before. Test: `git::tests::status_against_head_and_base`.
- [ ] A base with several merge bases (main and the branch merged each other), which `git diff --merge-base` refuses, or a git before 2.30, which lacks it, diffs against `git merge-base`'s pick, as before. Test: `git::tests::status_against_a_base_with_two_merge_bases_uses_one_of_them`. A git before 2.30 takes the same path; no test runs an old git.
- [ ] A diff that times out is an error, as before, not a missing base. No automated test: it needs a git that runs for 60 seconds.
- [ ] A base that looks like an option is never read as one. Test: `git::tests::a_base_that_looks_like_an_option_is_not_found_and_runs_nothing`.
- [ ] `against` names the ref the diff is against (`main`, `origin/main`, `HEAD`, or the empty tree) instead of the merge-base's hash. No client reads it. Tests: `git::tests::status_against_the_base_reports_each_kind_of_change`, `git::tests::fresh_repo_without_commits`.

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

- Each criterion above names its tests.
- Manual: `top` on a Mac with many sessions, before and after.

## Open questions

- None.
