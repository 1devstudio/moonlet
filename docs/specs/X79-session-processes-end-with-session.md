# X79 — A session's processes end with it

- **Status:** draft
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

- [ ] Closing a shell tab stops every process in the tab's session, including
      jobs in their own process group that ignore SIGHUP: SIGHUP, then SIGTERM
      after 1.5 s, then SIGKILL after 3 s more, as for Run tabs (X1).
- [ ] The same holds for an agent tab that runs in a terminal.

Chat agents:

- [ ] Stopping a chat agent stops the processes it started, including those in
      a process group of their own: SIGTERM, then SIGKILL after 3 s.
- [ ] When a chat agent's process exits by itself, processes it started that
      are still running are stopped the same way.
- [ ] When the daemon stops (SIGTERM, `daemon.shutdown`, live upgrade), it
      waits up to 3 s for every agent to exit and SIGKILLs those still running
      before it exits.

Later parts of this spec, each with its own change:

- [ ] A registry of each session's processes, kept across daemon restarts, and
      a reaper at startup that stops the processes of archived sessions.
- [ ] Archiving a session with processes still running asks first, listing
      them by name.
- [ ] A chat agent idle for 24 hours (no turn running, nothing waiting for the
      user) is stopped; the next message resumes its conversation
      (`--resume`), as after a daemon restart.
- [ ] A session's processes can be listed and stopped from the app and with
      `moonlet ps` and `moonlet kill`, by name only, never with their
      arguments.

## UI

None in this part.

## Protocol and RPCs

None in this part.

## Data and config

None in this part.

## Security considerations

Stopping processes by pid races with pid reuse: a process found as a
descendant is signalled only if its start time is still the one recorded when
it was found. Command-line arguments of other processes can hold tokens; this
feature reads only pids, parent pids, process groups and start times.

## Out of scope

- `nohup cmd &` in a shell tab no longer outlives the tab. To keep a process
  running after its tab, start it outside moonlet (for example with
  `launchctl`).
- Processes that call `setsid()` or double-fork away from their parent before
  the daemon looks are found only by the later registry and reaper.

## Test plan

- Rust, `terminal.rs`: closing a shell tab, and an agent tab, stops a job in
  its own process group that ignores SIGHUP.
- Rust, `chat/runtime.rs`: with a fake agent that starts a background child in
  its own process group, stopping the chat stops the child; an agent that exits
  by itself leaves no child running.
- Rust, `moonletd/tests`: a daemon stopped with SIGTERM leaves no agent and no
  agent child running.

## Open questions

- None.
