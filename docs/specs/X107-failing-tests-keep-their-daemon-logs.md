# X107 — Failing tests keep their daemon logs

- **Status:** implemented
- **Priority / phase:** P1 · phase 4
- **PRD refs:** none (developer tooling)
- **Related ADRs:** none
- **Depends on:** [X12](X12-e2e-tests.md) (how moonlet is tested)

## Summary

The daemon's end-to-end tests (`crates/moonletd/tests/`, and the CLI's in `crates/moonlet-cli/tests/`) start real `moonletd` processes in scratch homes. Each daemon logs to `logs/moonletd.log` in its home, and the home went away with the test, so a test that failed on CI said only where it stopped, never why: PR #674 found most of its causes by reproducing them by hand. X107 keeps the logs of every daemon a failing test started, prints their end with the failure, and has CI upload them, while a passing test leaves nothing behind.

## User journey

1. A pull request's `check` job fails on `central_copies.rs › a_central_host_started_with_a_truncated_account_log_keeps_its_copies`.
2. The job's log shows the panic, then "logs of its daemons kept in …/target/tmp/test-logs/moonletd/central_copies/a_central_host_…/ (studio-mini, MacBook)" and the last 200 lines of both daemons' logs, in time order, each line tagged with its daemon.
3. For more, the developer downloads the run's `test-logs-attempt-1` artifact: one folder per failing test (under its package and test file), with `studio-mini.log`, `MacBook.log` and `all.log`.
4. Locally, the same folder is under the worktree's `target/tmp/test-logs/`.

## Behaviour and acceptance criteria

- [x] When a daemon test fails, the log of every daemon it started is copied to `target/tmp/test-logs/<package>/<test file>/<test>/<daemon>.log` (or under `MOONLET_TEST_LOGS`, for runs of one test side by side), and `all.log` beside them has every daemon's lines in time order, each tagged with its daemon's name. (`kept_logs.rs` a_failing_test_keeps_each_daemons_log_and_all_of_them_in_time_order; two_logs_are_merged_by_time_each_line_tagged_with_its_daemon)
- [x] A daemon is named as the test names it: the worker name in its home's `link.json` (studio-mini, MacBook, Alex's MacBook Air), else `daemon`; a second daemon of the same name in one test gets `-2`. A fake cloud machine (X63) is `machine-<id>`. (`kept_logs.rs` a_failing_test_keeps_each_daemons_log_and_all_of_them_in_time_order; a_daemon_let_go_before_the_test_failed_still_has_its_log_kept for `-2`; `machine-<id>` and the 8 MiB bound have no test of their own)
- [x] A daemon the test let go of before it failed, whose scratch home is gone, still has its log kept. (`kept_logs.rs` a_daemon_let_go_before_the_test_failed_still_has_its_log_kept)
- [x] The failing test's output ends with the kept folder's path, the end of any daemon's stderr (a panic, say; at most 40 lines or 8 KiB each), and the last 200 lines of `all.log`, at most 48 KiB. (`kept_logs.rs` the_end_of_a_long_log_is_its_last_lines_within_the_bound)
- [x] A passing test leaves no folder and no file behind. Scratch homes go with their test, failed or passed: only logs are kept, at most the last 8 MiB of each. (`kept_logs.rs` a_passing_test_leaves_no_logs_behind)
- [x] A kept log names no home folder, temp folder, host name or computer name of the machine the test ran on: each is replaced by `~`, `$TMPDIR` or `this-host`. (`kept_logs.rs` a_kept_log_names_no_home_folder_or_host_of_this_machine)
- [x] Test daemons log at `info,moonletd=debug,moonlet_core=debug,moonlet_link=debug,moonlet_cloud=debug`, unless the test or the shell sets `MOONLET_LOG`; and with `MOONLET_TAILSCALE` pointing at no program, unless the test names one, so no test daemon runs this machine's `tailscale`. At that level a kept log follows a link (its state changes, the worker link trade, registration), each account sync round, each request a daemon answered or refused (only refusals of the read-only ones, which tests poll), so a session move's `session.take`, `session.give_back` and `session.bring` too, each request the central host sent a member, and each step of a routed run as the Jobs tab shows it. (`kept_logs.rs` a_failing_test_keeps_each_daemons_log_and_all_of_them_in_time_order: a request answered is in the kept log)
- [x] CI uploads `target/tmp/test-logs` as the artifact `test-logs-attempt-<n>` when the `check` job fails, kept 14 days. (`.github/workflows/test.yml`; checked on CI, no test)

## Implementation notes

- `crates/moonletd/tests/common/logs.rs`. Every place a test spawns `moonletd daemon` calls `.keep_logs(home)` on the command, last before `spawn`: it sets `MOONLET_LOG`, sends the daemon's stderr to `logs/stderr.log`, and hard-links both files into `$TMPDIR/moonlet-test-logs/`, so they outlive a home the test dropped. A thread-local guard removes the links when the test's thread ends (libtest runs each test on its own thread, named after it); the shared `moonlet-test-logs` folder itself stays, empty. Daemons are told apart by the thread that started them: one started from a `tokio::spawn` task on a worker thread is not kept.
- A panic hook, installed once, runs after the default one: for the panicking thread's test it copies the logs, writes `all.log` and prints through `eprint!`, so libtest shows it with that test's output. Daemons are still running at that point, so their logs are complete up to the failure.
- `cloud.rs` registers the fake provider's folder with `logs::machines_in`; the fake provider (`cloud_fake.rs`) sends each machine's stderr to its `logs/stderr.log`.
- The CLI's tests include the same file with `#[path]`.
- `central_copies.rs`'s agent tests used to `mem::forget` their scratch folder, so every run left one in `$TMPDIR`; it now goes with the last of the two daemons that use it (`Daemon::also`).
- Cost, measured on 2026-11-19 on a 10-core Mac shared with other work (load average 39–143), each suite run whole, two rounds, at `MOONLET_LOG=info` (as before X107) and at the test level. Size is every daemon's log at the end of its test, summed over the suite:

  | Suite | Level | Round 1 | Round 2 | Logs written (largest daemon) |
  |---|---|---|---|---|
  | `central_copies.rs`, 154 tests, 302 daemons | info | 195 s | 490 s | 0.20–0.24 MB (5 KB) |
  | | debug | 616 s | 219 s | 3.6–3.8 MB (173 KB) |
  | `mesh.rs`, 50 tests, 157 daemons | info | 110 s | 152 s | 0.08–0.16 MB (3 KB) |
  | | debug | 193 s | 133 s | 1.6–1.7 MB (123 KB) |

  The run times follow the machine's load, not the level: each level was both the faster and the slower one. The logs are about 25 KB a test, written to the scratch home, and nothing is copied unless the test fails.

## Security considerations

The artifact is public, as the repository is. Test daemons run in scratch homes with fake names and no `tailscale` (`keep_logs` points `MOONLET_TAILSCALE` at no program unless the test names a stub), and CI has no tailnet; the scrub takes out what of the machine could still show (its `HOME`, temp folder, host and computer names). No daemon log line prints a token: the one `token` field logged (`machines.rs`) is a run's numeric hold id.

## Out of scope

- Tests killed from outside (a timeout, `kill -9`): no panic, so nothing is kept.
- The Rust unit tests and Vitest, which start no daemon.

## Test plan

`crates/moonletd/tests/kept_logs.rs`: each test runs a probe on a thread named as a test, which starts real daemons and panics or returns.
