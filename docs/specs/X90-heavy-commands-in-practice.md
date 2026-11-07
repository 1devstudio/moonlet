# X90 — Heavy commands in practice: the project's list, long runs and full output

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0009](../adr/0009-central-host-workers-live-copies.md)
- **Depends on:** [X62](X62-routed-commands.md) (routed commands, jobs)
- **Changes:** X62's "The decision reads `[heavy]` from the session's own worktree" and its "A call whose input has any field but `command`, `timeout` and `description` is not routed: `run_in_background` …".

## Summary

X62 works in its tests but gets in the way on a real project, in three places found on 2026-11-07:

1. **A new session routes nothing.** Routing reads `[heavy]` from the session's worktree. Most projects keep `.moonlet/config.toml` out of git, so a worktree made from git has no `.moonlet/`, and every command comes back `not_heavy`. Meanwhile the project page shows and approves the list in the project's main checkout. So the user approves one list, and routing reads another, which isn't there.
2. **A long command cannot be routed.** Claude Code caps a foreground Bash call at 10 minutes, and X62 never routes a background call. A cold `pnpm check` takes longer than that.
3. **The agent cannot read the whole output.** When Claude Code cuts a long output short, the rest is in the job, and `job.output` refuses the `moonlet` CLI.

With this spec:

1. Routing reads `[heavy]` from the project's main checkout, as the `run` and `setup` scripts and the project page already do.
2. A background Bash call is routed like a foreground one.
3. Every job's output is also kept as a plain text file, and `moonlet exec`'s last line names it.

## User journey

1. Project `shop` on `studio-mini` has `[heavy] commands = ["pnpm check"]` in its main checkout's `.moonlet/config.toml`. The file is not in git. The user approved the list on the project page.
2. The user starts session `fix-cart`. Its worktree, made from git, has no `.moonlet/` folder.
3. The agent runs `pnpm check` with `run_in_background: true`. The chat's Bash row shows the chip **on Alex's MacBook Pro**. The agent checks the output with BashOutput now and then. After 14 minutes the command exits 0, and its changes are in the session.
4. The output's last line reads "moonlet: full output in ~/.moonlet/jobs/3f2a…/9c1d….log". Claude Code cut the output short, so the agent reads that file to find the first failing test.

## Behaviour and acceptance criteria

### The project's list

- [ ] `exec.route` and `exec.run` read `[heavy]` (`commands`, `os`, `env` and `outputs`) from the `.moonlet/config.toml` of the session's project's main checkout, the folder `heavy.get` reads. A worktree's own `.moonlet/config.toml` plays no part in routing.
- [ ] A session whose worktree has no `.moonlet/` folder routes an approved command that the main checkout lists. (`a_worktree_without_a_moonlet_folder_routes_the_main_checkouts_list`)
- [ ] An entry that only the worktree's config lists is not routed (`not_heavy`), even when the same text was approved, because the main checkout does not list it. (`an_entry_only_the_worktree_lists_is_not_routed`)
- [ ] A main checkout whose config cannot be read, or whose `[heavy]` is invalid, routes nothing (`invalid_config`), as X62 fails closed today. (`an_unreadable_main_checkout_config_routes_nothing`)
- [ ] The `outputs` and `os` a run uses are the main checkout's, read when the run starts, as X62 reads them now from the worktree. (`outputs_come_from_the_main_checkouts_list`)
- [ ] Approval is unchanged. The user approves the exact list and `env` names on the project page, and an entry added or changed in the main checkout is not routed until it is approved.

### Background calls

- [ ] The hook routes a Bash call whose input has only the fields `command`, `timeout`, `description` and `run_in_background`, whatever `run_in_background` holds. Any other field, such as `dangerouslyDisableSandbox`, still keeps the call where it is. (`a_background_bash_call_is_routed_and_stays_in_the_background`)
- [ ] The rewrite keeps `run_in_background` as the agent sent it. As in X62, `updatedInput` repeats every field and changes only `command`. (`a_background_bash_call_is_routed_and_stays_in_the_background`)
- [ ] When Claude Code stops a background call (KillShell, or the session ending), `moonlet exec` gets a signal or loses its terminal. The run is then stopped as X62 stops a cancelled one: SIGTERM, SIGKILL after 5 s, and its changes come back. When `moonlet exec` is killed outright, its connection to the daemon closes and the daemon stops the run in the same way. (`a_killed_moonlet_exec_stops_its_run_and_brings_its_changes_back`)
- [ ] An edit the agent makes while a background run goes on is handled by X62's fence rule. A file both changed keeps the session's version, and the run's version goes to `sync-leftovers`, with the line that says so. Nothing new is needed, but the test covers a background call. (`an_edit_during_a_background_run_keeps_the_sessions_version`)
- [ ] Plan mode, other tools and other hook events are still never routed. (`a_background_bash_call_is_routed_and_stays_in_the_background`)

### Full output

- [ ] Every job keeps its output as plain text in `$MOONLET_HOME/jobs/<session>/<job>.log`, mode 0600: stdout and stderr in the order they came, ANSI escapes kept, `moonlet:` lines included. The same limit as the job's stored output applies: past 10 MiB the middle is dropped and replaced by "moonlet: 3.2 MB of output dropped here". After a rerun, each run's output is there, with X62's separator line between them. (`a_jobs_whole_output_is_in_its_log_file`, `a_log_over_ten_mib_keeps_its_start_and_end`)
- [ ] The file is removed with its job, when the job leaves the history of 50, or when the session is archived. (`a_jobs_log_goes_with_the_job`)
- [ ] `moonlet exec`'s last stderr line, after everything else moonlet says, reads `moonlet: full output in <path>`, with `~` for the home folder. It is printed for every job, routed or run on the session's own host, because moonlet cannot tell when Claude Code will cut an output short. (`moonlet_exec_ends_with_the_full_outputs_path`)
- [ ] `job.list` and `job.output` stay refused to the `moonlet` CLI. The log file is the agent's way to the whole output.
- [ ] The chat's Bash row and the job tab show the line like any other `moonlet:` line, in the accent colour (X62).

## UI

No new screens.

- The project page's help text for **Commands** stays. It now matches what routing reads.
- The `moonlet: full output in …` line is coloured like the other `moonlet:` lines.

## Protocol and RPCs

- `exec.exited {run, status}` gains `log`: the job's log file, as an absolute path. `moonlet exec` prints it. A daemon from before this spec sends none, and `moonlet exec` then prints no such line.
- `exec.route`'s `reason` values are unchanged. `invalid_config` now refers to the main checkout's config.
- No protocol version change.

## Data and config

- `$MOONLET_HOME/jobs/<session>/<job>.log`, beside X62's `<job>.out`.
- `.moonlet/config.toml` in the project's main checkout is the only `[heavy]` that counts.

## Security considerations

- **The approved list and the routed list are now one list.** Before, an agent could add an entry to the worktree's config, and it was refused only because it was not approved. Now the worktree's config isn't read for routing at all. An agent can still edit the main checkout's file, but an edited entry is not routed until the user approves it again, as in X62.
- **Background calls get the same consent as foreground ones.** Only approved entries are routed, and the user's Claude Code deny and ask rules still apply to the original command (X62). The hook still never routes a call that asks to leave the sandbox.
- **The log file holds what the job's output holds.** It is mode 0600 under `$MOONLET_HOME`, readable by the user's own processes, as `<job>.out` already is. The CLI's refusal to list and read jobs stays, so an agent is not handed a list of other sessions' jobs.

## Out of scope

- Raising Claude Code's foreground timeout (`BASH_MAX_TIMEOUT_MS`). Background calls cover long runs.
- Routing on other hosts' sessions: [X89](X89-every-host-runs-heavy-commands.md).
- Codex, chained or piped commands.

## Test plan

Expected values are literals from this spec or from captured output.

- **Rust unit (`crates/moonlet-cli/src/hook.rs`):** `a_background_bash_call_is_routed_and_stays_in_the_background`, against a `PreToolUse` payload with `run_in_background: true`, captured from the current Claude Code (`src/fixtures/pre_tool_use_bash_background.json`). It replaces X62's `a_background_bash_call_is_not_routed`, and keeps that test's checks for plan mode, other tools, other events and `dangerouslyDisableSandbox`.
- **Daemon e2e (`crates/moonletd/tests/exec.rs`):** `a_worktree_without_a_moonlet_folder_routes_the_main_checkouts_list`, `an_entry_only_the_worktree_lists_is_not_routed`, `an_unreadable_main_checkout_config_routes_nothing`, `outputs_come_from_the_main_checkouts_list`, `a_killed_moonlet_exec_stops_its_run_and_brings_its_changes_back`, `an_edit_during_a_background_run_keeps_the_sessions_version`, `a_jobs_whole_output_is_in_its_log_file`, `a_log_over_ten_mib_keeps_its_start_and_end`, `a_jobs_log_goes_with_the_job`.
- **CLI e2e (`crates/moonlet-cli/tests/exec.rs`):** `moonlet_exec_ends_with_the_full_outputs_path`.
- X62's tests that write `[heavy]` into a session's worktree move it to the project's main checkout. Their names stay.
- **Manual:** in a real session, a background `pnpm check` that runs past 10 minutes on another Mac, and the agent reading the log file.

| Criterion | Tests |
|---|---|
| The main checkout's list | `a_worktree_without_a_moonlet_folder_routes_the_main_checkouts_list`, `an_entry_only_the_worktree_lists_is_not_routed` |
| Fails closed | `an_unreadable_main_checkout_config_routes_nothing` |
| `outputs` and `os` | `outputs_come_from_the_main_checkouts_list` |
| Background calls routed, flag kept | `a_background_bash_call_is_routed_and_stays_in_the_background` |
| Stopping a background run | `a_killed_moonlet_exec_stops_its_run_and_brings_its_changes_back` |
| Edits during a background run | `an_edit_during_a_background_run_keeps_the_sessions_version` |
| The log file and its limit | `a_jobs_whole_output_is_in_its_log_file`, `a_log_over_ten_mib_keeps_its_start_and_end` |
| The log goes with the job | `a_jobs_log_goes_with_the_job` |
| The last line | `moonlet_exec_ends_with_the_full_outputs_path` |

## Open questions

- Does KillShell send `moonlet exec` a signal, or kill it outright? Both end in a stopped run (see Background calls), but the captured payload and a manual check should confirm it.

Decided by the user on 2026-11-07:

- **The main checkout's config, not a committed file.** Every other key of `.moonlet/config.toml` is already read from there, and so is the list the user approves.
- **Route background calls** rather than raise Claude Code's foreground timeout.
- **A log file, not `job.output` for the CLI.** The CLI names its session only through `MOONLET_SESSION`, which an agent can set to anything, so opening `job.output` to it would open every session's jobs.
