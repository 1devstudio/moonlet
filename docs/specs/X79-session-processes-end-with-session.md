# X79 — A session's processes end with it

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** S1 daemon-owned sessions, S3 live upgrade, S4 restore after restart, X1 repo scripts
- **Related ADRs:** none

## Summary

Processes started inside moonlet sessions kept running for days after the
tab, agent or session that started them was gone: a `tail | sed | ugrep`
pipeline for 7 days, a `log stream` for 11, dev servers and test daemons for
hours. They were re-parented to launchd, so nothing in moonlet showed them or
could stop them. On one Mac they added up, with other load, to a load average
of 12 and 17 GB of swap.

They escape for three reasons:

- Closing a shell or agent tab signals only the shell's process group. A job
  that a job-control shell put in its own group, and that ignores SIGHUP, keeps
  running. Run and Setup tabs already signal every process in the tab's
  session (X1); other tabs did not.
- Stopping a chat agent signals only the agent's process group. Commands its
  tools start in a group of their own (background Bash commands do) keep
  running, and nothing ends them when the agent exits by itself.
- When the daemon stops, it sends SIGTERM to every agent and exits at once, so
  the SIGKILL meant to follow 3 s later never comes.

macOS has no cgroups and no fork tracking in kqueue (`NOTE_TRACK` is not
supported), and it hides the environment of Apple's own binaries (`zsh`,
`tail`, `log`) from other processes, so a `MOONLET_SESSION` marker cannot be
read back from all of them. The daemon therefore follows process trees itself,
while the parent links are still there.

## User journey

1. The user closes a terminal tab with a dev server running in the background.
   The server stops within a few seconds.
2. An agent starts `tail -f build.log | grep error` in the background and
   finishes. The pipeline stops with the agent's process.
3. The user stops an agent, or the daemon restarts. Nothing the agent started
   is left behind.

## Behaviour and acceptance criteria

Tabs:

- [x] Closing a shell tab stops every process in the tab's session, including
      jobs in their own process group that ignore SIGHUP: SIGHUP, then SIGTERM
      after 1.5 s, then SIGKILL after 3 s more, as for Run tabs (X1)
      (`closing_a_shell_tab_stops_jobs_that_outlive_the_shell`).
- [x] The same holds for an agent tab that runs in a terminal
      (`closing_an_agent_tab_stops_jobs_that_outlive_the_shell`).
- [x] The same holds once the tab's shell has exited and left such a job
      running (`closing_a_tab_whose_shell_exited_stops_the_job_it_left`).
- [x] A tab can show an exit while its shell still runs, once the terminal
      closed and the daemon stopped waiting for the shell. Closing it stops
      the shell too
      (`closing_a_tab_that_shows_an_exit_stops_its_shell_still_running`).
- [x] After a live upgrade (S3), closing a tab whose shell exited, and whose
      pid now leads another session, leaves that session running
      (`closing_an_adopted_tab_leaves_alone_the_session_now_on_its_shells_pid`).

Chat agents:

- [x] Stopping a chat agent stops the processes it started, including those in
      a process group of their own: SIGTERM, then SIGKILL after 3 s
      (`stopping_a_chat_stops_what_its_agent_left_running`).
- [x] When a chat agent's process exits by itself, processes it started that
      are still running are stopped the same way, even when one of them keeps
      the agent's output open, and writes to it
      (`an_agent_that_exits_leaves_nothing_running`,
      `an_agent_that_exits_leaves_nothing_running_though_its_server_keeps_writing`).
      Everything the agent wrote before it exited is still read, however long
      reading it takes; only the wait for more output after the exit is
      bounded, to half a second
      (`a_long_reply_is_read_to_its_end_though_the_agent_exits_before_it_is`).
- [x] Finding the processes an agent started looks at each process once,
      however many it started and however deep they nest
      (`a_deep_tree_is_walked_in_one_pass`).
- [x] New settings (model, effort, mode) restart the agent without ending what
      it left in a process group of its own; those processes then end with the
      restarted agent (`new_settings_restart_the_agent_but_keep_what_it_left_running`),
      or with the chat when the restarted agent fails to start
      (`what_an_agent_left_running_ends_with_its_chat_after_a_restart_that_failed`).
- [x] When the daemon stops (SIGTERM, `daemon.shutdown`, live upgrade), it
      waits up to 3 s for every agent to exit, those stopped a moment before
      included, and SIGKILLs those still running before it exits. Once it
      begins to stop, no agent starts (`no_agent_starts_once_the_daemon_is_stopping`,
      `the_daemon_stops_only_once_what_agents_left_running_is_gone`,
      `the_daemon_stops_only_once_a_just_stopped_agents_server_is_gone`,
      `a_daemon_stopped_with_sigterm_leaves_nothing_its_agents_started`).
      When a live upgrade fails after that, the old daemon goes on serving and
      its chats start agents again
      (`chats_start_agents_again_after_a_live_upgrade_that_failed`).

After a crash:

- [x] Every 2 s, while it changes, the daemon records next to its socket
      (`~/.moonlet/run/moonletd.leftovers.json` for the default one) each
      running agent and every process it started, and each terminal's session,
      its shell exited or not, all as pid and start time, with the machine's
      boot id and boot time. A terminal's shell start time is taken when the
      terminal starts (or is adopted in a handoff), never looked up once the
      shell may have exited and its pid gone to another process
      (`a_terminal_is_recorded_with_its_shells_start_though_the_shell_exited_first`).
- [x] A daemon that starts fresh (not by a live-upgrade handoff) ends what that
      file names and still runs with the same start time: agents and what they
      started get SIGTERM, then SIGKILL 3 s later; terminal sessions get SIGHUP,
      SIGTERM and SIGKILL as when a tab closes. A pid that now belongs to a
      process that started later is left alone, and a record from before a
      reboot ends nothing
      (`a_daemon_started_after_a_crash_ends_what_its_agents_left_running`,
      `reaping_ends_recorded_processes_and_spares_a_reused_pid`,
      `reaping_ends_a_recorded_terminal_session_whose_shell_is_gone`,
      `a_record_from_before_a_reboot_ends_nothing`).
- [x] A record is from before a reboot when its boot id differs from the
      machine's (`kern.bootsessionuuid` on macOS, the kernel's `boot_id` on
      Linux). Without a boot id on either side, it is when the boot times are
      more than 2 s apart. A clock change since the record, which moves the
      boot time, still lets it end what it names
      (`a_record_from_before_a_reboot_ends_nothing`,
      `a_clock_change_since_the_record_still_ends_what_it_names`).
- [x] The record is the user's own: written readable and writable by the
      user alone, never through a link, and read only when it is a file, not
      a link, owned by the user and that no one else may write. Any other
      record ends nothing, as another user may have planted it next to a
      socket in a shared folder such as /tmp
      (`a_record_others_may_write_ends_nothing`,
      `a_record_behind_a_link_ends_nothing`,
      `a_record_is_written_for_its_owner_alone_and_never_through_a_link`).
- [x] What is being ended stays in the record until it is gone: a stopped
      agent and its processes during their grace, and what the daemon before
      left, so a crash meanwhile still leaves them to the next daemon
      (`what_a_stopped_agent_left_stays_recorded_until_it_is_gone`,
      `a_stopped_agent_stays_recorded_until_it_is_gone`,
      `what_a_crashed_daemon_left_stays_recorded_until_it_is_gone`).
- [x] A daemon that stopped cleanly ended its agents and what they started.
      Jobs in its terminals' sessions that ignored the hangup end at the next
      start, as after a crash.
- [x] After a handoff nothing is ended: the new daemon adopted the terminals,
      and the old one ended its agents (`upgrade_keeps_sessions_alive`). The
      new daemon keeps recording what the old one's record names and still
      runs, as a fresh daemon does with what it is ending: the sessions of
      shells that exited, whose terminals are not handed over, and agents
      still being ended. A crash of the new daemon then leaves those to the
      next one too (`after_an_upgrade_a_crash_still_ends_what_an_exited_shell_left`).

Later parts of this spec, each with its own change:

- [x] A registry of each session's processes, kept across daemon restarts, and
      a reaper at startup that stops the processes of archived sessions:
      archiving stops a session's processes, those left in its worktree
      included ([X83](X83-session-processes-listed-and-stopped.md)), and the
      leftovers record above, kept across restarts, ends what a crashed daemon
      left. No separate registry per session is kept.
- [x] Archiving a session with processes still running asks first, listing
      them by name: [X83](X83-session-processes-listed-and-stopped.md).
- [x] A chat agent idle for 24 hours (no turn running, nothing waiting for the
      user) is stopped; the next message resumes its conversation
      (`--resume`), as after a daemon restart: X84
      ([X84-idle-agents-rest.md](X84-idle-agents-rest.md)).
- [x] A session's processes can be listed and stopped from the app and with
      `moonlet ps` and `moonlet kill`, by name only, never with their
      arguments: [X83](X83-session-processes-listed-and-stopped.md).

## UI

None in this part.

## Protocol and RPCs

None in this part.

## Data and config

`<socket name>.leftovers.json` next to the daemon's socket, written by the
daemon and read once by the next one on that socket:
`{"boot": …, "processes": [{"pid": …, "start": …}, …], "sessions": [{"pid": <leader>, "start": …}, …]}`.
A record written as `[pid, start]` pairs, as earlier daemons did, still reads.
Start and boot times are in microseconds since the epoch on macOS; on Linux a
start is in clock ticks since boot and the boot time in seconds. The boot id
is `kern.bootsessionuuid` on macOS and `/proc/sys/kernel/random/boot_id` on
Linux.

## Security considerations

Stopping processes by pid races with pid reuse: a process found as a
descendant is signalled only if its start time is still the one recorded when
it was found. A tab's session is signalled by its shell's session id; once the
shell's pid belongs to a process that started later, that process's own
session is left alone; for that, the shell's start time is taken when the
terminal starts, while the pid is surely the shell's. Command-line arguments of other processes can hold tokens; this
feature reads only pids, parent pids, process groups and start times.

The record next to the socket says which processes the next daemon ends. A
socket may be in a folder other users can write to, so a record is read only
when it is a file, not a link, owned by the user and not writable by anyone
else; it is written with mode 0600, and never through a link planted where
it is first written.

## Out of scope

- `nohup cmd &` in a shell tab no longer outlives the tab. To keep a process
  running after its tab, start it outside moonlet (for example with
  `launchctl`).
- The daemon looks at each agent's processes every 2 s and at the end of each
  of its turns. One the agent starts less than 2 s before it exits by itself,
  mid-turn and in a process group of its own, is not known to have been the
  agent's. Stopping an agent looks once more first.

## Test plan

- Rust, `terminal.rs`: `closing_a_shell_tab_stops_jobs_that_outlive_the_shell`,
  `closing_an_agent_tab_stops_jobs_that_outlive_the_shell`,
  `closing_a_tab_whose_shell_exited_stops_the_job_it_left`,
  `closing_a_tab_that_shows_an_exit_stops_its_shell_still_running` and
  `closing_an_adopted_tab_leaves_alone_the_session_now_on_its_shells_pid`.
- Rust, `process.rs`: `descendants_are_children_and_theirs_but_not_others`,
  `a_family_signals_only_processes_that_still_run` and
  `a_family_forgets_a_process_no_longer_in_the_table`.
- Rust, `leftovers.rs`: `reaping_ends_recorded_processes_and_spares_a_reused_pid`,
  `reaping_ends_a_recorded_terminal_session_whose_shell_is_gone`,
  `a_record_from_before_a_reboot_ends_nothing`,
  `a_clock_change_since_the_record_still_ends_what_it_names`,
  `a_record_others_may_write_ends_nothing`,
  `a_record_behind_a_link_ends_nothing` and
  `a_record_is_written_for_its_owner_alone_and_never_through_a_link`.
- Rust, `chat/runtime.rs`: `what_a_stopped_agent_left_stays_recorded_until_it_is_gone`,
  `a_stopped_agent_stays_recorded_until_it_is_gone`,
  `a_terminal_is_recorded_with_its_shells_start_though_the_shell_exited_first` and
  `what_a_crashed_daemon_left_stays_recorded_until_it_is_gone`.
- Rust, `moonletd/tests/daemon.rs`:
  `a_daemon_started_after_a_crash_ends_what_its_agents_left_running`;
  `moonletd/tests/upgrade.rs`: `upgrade_keeps_sessions_alive` and
  `after_an_upgrade_a_crash_still_ends_what_an_exited_shell_left`.
- Rust, `chat/runtime.rs`, with a fake agent that leaves a server running in a
  process group of its own, ignoring SIGHUP and SIGTERM:
  `stopping_a_chat_stops_what_its_agent_left_running`,
  `an_agent_that_exits_leaves_nothing_running`,
  `an_agent_that_exits_leaves_nothing_running_though_its_server_keeps_writing`,
  `a_long_reply_is_read_to_its_end_though_the_agent_exits_before_it_is`,
  `new_settings_restart_the_agent_but_keep_what_it_left_running`,
  `what_an_agent_left_running_ends_with_its_chat_after_a_restart_that_failed`,
  `the_daemon_stops_only_once_what_agents_left_running_is_gone`,
  `the_daemon_stops_only_once_a_just_stopped_agents_server_is_gone` and
  `no_agent_starts_once_the_daemon_is_stopping`.
- Rust, `moonletd/tests/daemon.rs`:
  `a_daemon_stopped_with_sigterm_leaves_nothing_its_agents_started` and
  `chats_start_agents_again_after_a_live_upgrade_that_failed`.

## Open questions

- None.
