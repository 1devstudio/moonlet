# X83 — A session's processes, listed and stopped

- **Status:** implemented (2026-11-03; the Processes tab checked in the running app with `snap.ts`)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** S1 daemon-owned sessions, X1 repo scripts, A6 CLI and socket API
- **Related:** [X79](X79-session-processes-end-with-session.md) (a session's processes end with it), [X23](X23-confirm-modal.md) (confirm modal), [X55](X55-git-settings.md) (archive settings)

## Summary

Processes started in moonlet sessions leaked for days: dev servers, `tail`
pipelines, test daemons, re-parented to launchd and invisible in the app.
X79 makes them end with their tab or agent. X83 lets the user see what a
session runs now, and stop it: from the app, with `moonlet ps` and
`moonlet kill`, and when archiving the session. Processes are shown by the
name of the file they run, never by their arguments, which can hold tokens.

## User journey

1. The user opens a session's **⋯** menu and picks **Processes…**. A
   Processes tab opens in the right panel, listing what the session's
   terminals and agents run: name, pid, the tab or agent it belongs to, how
   long it has run, its CPU use and memory.
2. A dev server they forgot eats a core. They click **Stop** on its row; it
   is gone a moment later. **Stop all** stops everything the tabs and agents
   started, leaving the tabs themselves.
3. Under **Left in the worktree** the tab lists processes nothing in moonlet
   owns any more (launchd's), which work in the session's worktree, such as a
   server a crashed tool left. Each has its own **Stop**.
4. The user archives the session. The confirm says
   "3 processes still run: vite, tail, node. Archiving stops them." and, on
   **Archive**, they are stopped with the session.
5. In a terminal, `moonlet ps` lists the current session's processes, and
   `moonlet kill 4242` or `moonlet kill --all` stops them.

## Behaviour and acceptance criteria

Listing (`session.processes`):

- [x] A session's processes are every process in each of its terminals'
      sessions (their session id is the tab's shell pid), and each of its
      chat agents with the processes it started (X79's family), each with the
      tab or agent it belongs to; a Run tab's (one of the session's scripts)
      say so, as `run`. The tab's shell and the chat's agent are
      marked as the tab's own (`tab`, a name kept on the wire: it says whose
      the process is, not that it is a tab)
      (`a_sessions_processes_are_its_tabs_sessions_and_its_agents_families`,
      `a_sessions_processes_are_listed_by_name_and_stopped`).
- [x] Each process is named by the file name of its executable as the kernel
      says, never its arguments, without the " (deleted)" Linux adds to an
      executable replaced since it started; it has its start time, its CPU
      time and its resident memory where the kernel tells them
      (`a_child_s_working_directory_and_usage_are_what_the_kernel_says`,
      `an_executable_deleted_since_it_started_is_named_by_its_file`).
- [x] Leftovers are listed apart: processes whose parent is launchd (init on
      Linux), that are not already the session's, whose working directory is
      the session's worktree or inside it. Each says what it was left to on
      the host's system, which the app and `moonlet ps` show as its origin:
      "launchd" on macOS, "init" on Linux. They are never stopped unless named
      by pid (`leftovers_are_launchd_children_working_in_the_worktree`,
      `leftovers_in_a_sessions_worktree_are_listed_apart_and_stopped_only_by_pid`).

Stopping (`session.kill_processes`):

- [x] Named pids are stopped with SIGTERM, then SIGKILL after 3 s for those
      still running; the call returns once they are gone. A named pid may be
      a tab's own process. A pid that runs but is not one of the session's
      processes or leftovers is skipped, even one this user may not read,
      such as launchd's; one no process runs with any more is
      reported apart, as gone (`stopping_by_pid_skips_pids_that_are_not_the_sessions`,
      `leftovers_in_a_sessions_worktree_are_listed_apart_and_stopped_only_by_pid`).
      Only those gone after their signals are reported ended; one still
      running (this user may not signal it, say) is reported as still running:
      `moonlet kill` fails naming it, and the app says so in a toast
      (`a_process_still_running_after_its_ending_is_not_reported_ended`,
      `kill_fails_naming_pids_that_still_run_after_their_stop`,
      `says which processes still run after their Stop`).
- [x] With no pids, every process of the session is stopped except the tabs'
      own and the leftovers; an empty list stops nothing
      (`stopping_all_spares_the_tabs_own_processes_and_leftovers`,
      `stopping_by_pid_skips_pids_that_are_not_the_sessions`).
- [x] A process is signalled only while its start time is the one it had when
      listed: a pid reused meanwhile is left alone
      (`ending_skips_a_pid_whose_start_changed`). A pid may be sent with the
      start `session.processes` listed it with, as the app does; it is
      stopped only while that is still its start, and is gone otherwise.
      That start is the kernel's own (`start`: clock ticks since boot on
      Linux), never the wall-clock `started` shown, which on Linux moves
      when the clock is adjusted
      (`stopping_a_pid_listed_with_another_start_leaves_it_alone`,
      `a_pid_named_with_another_start_than_listed_is_left_alone`).

CLI:

- [x] `moonlet ps [--session <id>]` prints the session's processes (the
      current one, from `MOONLET_SESSION`, by default) in the columns PID
      NAME ORIGIN AGE CPU MEMORY, memory as the app shows it ("900 KB",
      "210 MB", "3.0 GB"), then the leftovers under their own heading
      (`ps_prints_name_pid_origin_age_cpu_and_memory_never_arguments`,
      `moonlet_ps_lists_a_sessions_processes_and_moonlet_kill_stops_one`).
- [x] `moonlet kill <pid>...` stops those pids of the session;
      `moonlet kill --all` stops every process but the tabs' own. It prints
      what it stopped, and fails naming the pids that are not the session's
      ("not processes of this session: 999") apart from those already ended
      ("already ended: 5151") (`kill_says_which_pids_it_stopped`,
      `kill_fails_naming_pids_not_the_sessions_apart_from_those_already_ended`,
      `moonlet_ps_lists_a_sessions_processes_and_moonlet_kill_stops_one`).

App:

- [x] The Processes tab lists each process with its name, pid, origin, age,
      CPU use and memory, with **Stop** per row and **Stop all**; leftovers
      follow under **Left in the worktree**, each with **Stop**. The origin is
      "Terminal · zsh", "Run · dev" for a Run tab's, or "Agent · Claude". It
      looks again every 3 s while shown; a look answering after a newer one,
      or for a session shown before (as a Stop's refresh after a switch), is
      dropped (`describes a process row: origin, age, CPU and memory`,
      `works out CPU use from two looks`, `keeps only the latest look at the session shown`). **Stop** sends the row's pid with
      the start it was listed with; **Stop all** sends no pids, and the
      daemon stops what it decides: the rows it marks stopping are the same,
      never a tab's own nor a leftover (`stops a row by its pid and the start it was listed with; Stop all names none`,
      `Stop all covers what the daemon stops: neither the tabs' own nor what was left in the worktree`).
- [x] Archiving a session that runs processes other than its tabs' own, or
      has leftovers, says so in the confirm, by name: "3 processes still run:
      vite, tail, node. Archiving stops them." On **Archive** they are stopped,
      each by its pid and the start it was listed with, before the session is
      archived; a daemon that cannot list them archives
      as before (`names the processes still running, after their count`,
      `says nothing when only the tabs' own processes run`,
      `lists the processes still running and stops them before archiving (X83)`,
      `archives as before when the daemon cannot list processes (X83)`;
      e2e `names what still runs in the session, and archiving stops it (X83)`).

## UI

**⋯** menu → **Processes…** opens the Processes tab in the right panel; the
tab shows while it is the chosen one.

```
┌ 4 processes · 1 left in the worktree         Stop all ┐
│ vite        4242  Run · run         2h   12%  210 MB  Stop │
│ tail        4250  Terminal · zsh    3d    0%    1 MB  Stop │
│ zsh         4100  Terminal · zsh    3d    0%    4 MB  tab  │
│ claude      4300  Agent · Claude    1h    3%  380 MB  tab  │
│ Left in the worktree                                       │
│ node        5151  launchd           6d   40%  900 MB  Stop │
└────────────────────────────────────────────────────────────┘
```

The tabs' own processes (a shell, a chat's agent) show "tab" instead of
**Stop**: closing the tab ends them. Empty state: "Nothing runs in this
session". A daemon too old to list processes shows the error.

## Protocol and RPCs

- `session.processes {id}` →
  `{processes: [SessionProcess], leftovers: [SessionProcess]}`, where
  `SessionProcess` is
  `{pid, name, origin, tab, start, started?, cpu_ms?, rss?}`; `origin` is
  `{kind: "terminal", id, title}`, `{kind: "run", id, title}` (a Run tab's),
  `{kind: "agent", id, title}` or
  `{kind: "leftover", parent}`, `parent` "launchd" on a macOS host and "init"
  on a Linux one; `start` is when it started as the kernel keeps it
  (microseconds since the epoch on macOS, clock ticks since boot on Linux),
  compared and never shown; `started` is in milliseconds since the epoch,
  for showing only,
  `cpu_ms` the CPU time used so far, `rss` resident memory in bytes.
- `session.kill_processes {id, pids?}` →
  `{ended: [pid], skipped: [pid], gone: [pid], still_running: [pid]}`:
  `ended` were signalled and are gone, `skipped` run but are not the
  session's, `gone` no longer ran when named, `still_running` were signalled
  and outlived SIGKILL. Each of `pids` is a pid (`4242`) or a
  pid with the `start` it was listed with (`{pid, start}`).
- Both answer the app and the CLI; a worker's link gets `forbidden`
  (`a_workers_link_neither_lists_nor_stops_a_sessions_processes`).
- CLI: `moonlet ps [--session <id>] [--json]`,
  `moonlet kill [--session <id>] (<pid>... | --all)`.

## Data and config

None: listed from the kernel's process table at each call.

## Security considerations

Command-line arguments of other processes can hold tokens: only pids, parent
pids, sessions, start times, executable paths (shown by file name), working
directories (compared with the worktree, never shown), CPU time and memory are
read. `session.processes` and `session.kill_processes` answer the app and the
`moonlet` CLI, which an agent running in a session can call; a worker's link
gets `forbidden`. `session.kill_processes` signals only what it finds, at the
time of the call, to be that session's processes or launchd's (init's)
children working in its worktree, and only while their start time is
unchanged. Such a leftover is any process of the user's that works in the
worktree, so the CLI can stop it by pid; nothing outside the session and its
worktree can be signalled.

## Out of scope

- Processes on a remote host's copy of the session are listed by that host's
  daemon only; the app asks the session's own host.
- Leftovers whose working directory moved out of the worktree are not found.
- On Linux, leftovers re-parented to a subreaper (such as `systemd --user`)
  rather than init are not found: only init's children are looked at.

## Test plan

- Rust, `process.rs`: `a_child_s_working_directory_and_usage_are_what_the_kernel_says`.
- Rust, `session_processes.rs`: `a_sessions_processes_are_its_tabs_sessions_and_its_agents_families`,
  `leftovers_are_launchd_children_working_in_the_worktree`,
  `stopping_all_spares_the_tabs_own_processes_and_leftovers`,
  `stopping_by_pid_skips_pids_that_are_not_the_sessions`,
  `stopping_a_pid_listed_with_another_start_leaves_it_alone`,
  `a_process_still_running_after_its_ending_is_not_reported_ended`,
  `an_executable_deleted_since_it_started_is_named_by_its_file` and
  `ending_skips_a_pid_whose_start_changed`.
- Rust, `moonletd/tests/daemon.rs`: `a_sessions_processes_are_listed_by_name_and_stopped`,
  `leftovers_in_a_sessions_worktree_are_listed_apart_and_stopped_only_by_pid`,
  `a_pid_named_with_another_start_than_listed_is_left_alone` and
  `a_workers_link_neither_lists_nor_stops_a_sessions_processes`.
- Rust, `moonlet-cli`: `ps_prints_name_pid_origin_age_cpu_and_memory_never_arguments`
  (`src/ps.rs`) and `moonlet_ps_lists_a_sessions_processes_and_moonlet_kill_stops_one`
  (`tests/session_e2e.rs`).
- Vitest, `sessionProcesses.test.ts`: `names the processes still running, after their count`,
  `says nothing when only the tabs' own processes run`,
  `describes a process row: origin, age, CPU and memory`,
  `stops a row by its pid and the start it was listed with; Stop all names none`,
  `Stop all covers what the daemon stops: neither the tabs' own nor what was left in the worktree`,
  `says which processes still run after their Stop`,
  `keeps only the latest look at the session shown` and
  `works out CPU use from two looks`; `actions.test.ts`:
  `lists the processes still running and stops them before archiving (X83)` and
  `archives as before when the daemon cannot list processes (X83)`.
- Rust, `moonlet-cli` `src/ps.rs`: `kill_says_which_pids_it_stopped`,
  `kill_fails_naming_pids_not_the_sessions_apart_from_those_already_ended` and
  `kill_fails_naming_pids_that_still_run_after_their_stop`.
- e2e, `confirm-modal.e2e.ts`: `names what still runs in the session, and archiving stops it (X83)`.

## Open questions

- None.
