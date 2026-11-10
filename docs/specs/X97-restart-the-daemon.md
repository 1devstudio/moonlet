# X97 — Restart the daemon from the app, and force it when it's stuck

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** S1 (daemon lifecycle), S3 (upgrade keeps sessions)
- **Related ADRs:** —

## Summary

Until now, the app had no way to restart this Mac's `moonletd`. A daemon that stopped answering stayed stuck until the user found its pid and killed it in a terminal. Settings › General now has a **Restart** button under Background daemon. It first hands every terminal to a fresh daemon process, the way an upgrade does (S3), so nothing ends. If the daemon doesn't answer or doesn't hand over, the app says so and offers **Force restart**. That kills the stuck process and starts a new daemon. Its terminals end, and chats carry on from disk as after any daemon restart. The same thing works from a terminal: `moonletd restart [--force]`.

## User journey

1. The app looks stuck: sessions don't load, or terminals don't respond. The user opens Settings › General.
2. Under Background daemon they click **Restart**.
3. If the daemon is healthy enough to hand over, a new process takes over within a few seconds. The toast reads "Daemon restarted. Terminals kept running."
4. If it isn't, a dialog explains why ("The daemon isn't answering.") and that a force restart ends its terminals. The user clicks **Force restart**. A new daemon starts, and the toast reads "Daemon restarted. Its terminals ended; chats carry on."
5. The app reconnects to the new daemon right away.

## Behaviour and acceptance criteria

- [x] `moonletd restart` on a daemon that answers hands its terminals to a new daemon process: the same terminal, with the same shell pid, keeps running under a new daemon pid. (`tests/restart.rs` restart_keeps_terminals_on_a_daemon_that_answers)
- [x] `moonletd restart` on a daemon that doesn't answer within 3 s exits with code 3 after those 3 s, says "the daemon isn't answering" on stderr, and leaves the daemon alone. (`tests/restart.rs` restart_leaves_a_daemon_that_does_not_answer_and_exits_3)
- [x] `moonletd restart --force` on a daemon that doesn't answer kills it and starts a new daemon on the same socket, which answers. (`tests/restart.rs` force_restart_replaces_a_daemon_that_does_not_answer)
- [x] `moonletd restart --force` never kills a process that isn't a moonletd: when the pid file names a live process that isn't one (a stale file whose pid was reused), that process keeps running and a new daemon starts. (`tests/restart.rs` force_restart_never_kills_a_process_that_is_not_moonletd)
- [x] `moonletd restart --force` never kills a moonletd that started after the pid file was written, such as another home's daemon that got a stale file's pid. (`tests/restart.rs` force_restart_never_kills_another_homes_moonletd_that_got_a_stale_pid)
- [x] `moonletd restart` with no daemon running starts one. (`tests/restart.rs` restart_starts_a_daemon_when_none_runs)
- [x] `moonletd restart --force` finds a daemon whose pid file is gone by the pid it greets with, and replaces it. A daemon too stuck to greet, with no pid file, can't be found: the command fails and says so, and the user has to find and kill its process by hand. (`tests/restart.rs` force_restart_finds_a_daemon_whose_pid_file_is_gone, which covers a daemon that still greets)
- [x] `moonletd restart --force` doesn't wait for the killed daemon to be reaped: a zombie whose parent never waits on it counts as gone. (`tests/restart.rs` force_restart_does_not_wait_for_a_killed_daemon_to_be_reaped)
- [x] The app reads `moonletd restart`'s exit 3 as `not_responding` and any other failure as `failed`, with moonletd's message. (`src-tauri/src/lib.rs` moonletd_restart_exiting_3_asks_the_app_to_offer_a_force_restart)
- [x] In the app, Restart asks for nothing when the handoff works, and tells the user that terminals kept running. (`settingsPage.test.ts` "restarts with a handoff and keeps terminals")
- [x] When the daemon can't hand over, the app shows the reason and offers Force restart. Only after the user agrees does it force the restart, and it says that terminals ended. (`settingsPage.test.ts` "forces the restart only after the user agrees")
- [x] Cancelling that dialog leaves the daemon as it is, with no toast. (`settingsPage.test.ts` "leaves a stuck daemon alone when the user cancels")
- [x] Any other failure (moonletd missing, the start failed) shows as an error, without offering a force restart. (`settingsPage.test.ts` "reports other failures without offering a force restart")
- [x] Settings search finds the row by "restart", "stuck", "force restart" and "not answering". (`settingsSearch.test.ts` "finds Restart the daemon by what a stuck daemon looks like (X97)")

## UI

Settings › General › Background daemon gets a row below the login-item toggle:

```
Restart the daemon                                         [Restart]
Hands terminals to a fresh moonletd. If it's stuck, you can force it.
```

The button shows "Restarting…" and is disabled while the command runs: a few seconds for a handoff, up to about 33 s when the daemon answers but never hands over. Settings search finds the row (`daemon-restart`). The force dialog is the app's usual confirm (`askConfirm`): title "Force restart the daemon", the reason, then "Force restart ends every terminal it holds. Agents' chats carry on from where they were.", action **Force restart**.

## Protocol and RPCs

- New CLI command `moonletd restart [--force]`.
  - Without `--force`: no daemon listening and no live moonletd in the pid file means it starts one. A daemon that answers `daemon.info` within 3 s gets the S3 handoff to the running `moonletd` binary (`moonletd upgrade`, which waits up to 30 s). Otherwise, or when the handoff fails, it exits **3** with the reason on stderr.
  - With `--force`: the pid in `run/moonletd.pid`, or when that file is gone the pid the daemon greets with, gets SIGKILL. A pid from the file is used only when `ps` names that process `moonletd` and its start time (`etime`) isn't later than the file's. moonletd then waits up to 5 s for it to exit (or become a zombie) and starts a new daemon (`moonletd start`).
- New Tauri command `restart_daemon { force: bool }`. It runs the bundled `moonletd restart [--force]`. Exit 3 maps to the error code `not_responding`, any other failure to `failed`, each with moonletd's message. On success, the app reconnects to the local host straight away.

## Data and config

None. The pid file `run/moonletd.pid` already existed (S3).

## Security considerations

- Only the user's own processes can be signalled, and only one whose executable is named `moonletd` and that was already running when the pid file was last written. A stale pid file can't get an unrelated process killed, nor another home's moonletd (a dev daemon, say) that got the same pid later. `etime` counts whole seconds, so the check allows 2 s of slack. What's left is a daemon that dies, and whose pid goes to another moonletd, within 2 s of writing its pid file. A 1-hour-old file is tested; that 2 s window isn't.
- A force restart is destructive (terminals end), so the app always asks first. The CLI's `--force` is explicit.

## Out of scope

- **Remote and tailnet hosts.** Restart is for this Mac's daemon. A remote host's daemon is restarted on that host.
- **Restarting under launchd.** After a force restart, up to three starters see the killed daemon's stale socket at once: this command, the app's reconnect (`moonletd start`) and, with the login item on, launchd. Each new daemon checks that nothing listens before it binds, and one that finds a daemon listening exits with "already listening". So one daemon serves. In theory, two daemons that both check in the microseconds before either binds could both bind, and one would end up on a socket file that no longer exists. That race predates X97 (`server::bind`), and 8 daemons started together on a stale socket didn't hit it in 4 tries.
- **Detecting a stuck daemon by itself.** The user decides when to restart.

## Test plan

- Rust e2e tests in `crates/moonletd/tests/restart.rs`. A daemon that doesn't answer is a real daemon stopped with SIGSTOP. A unit test in `apps/desktop/src-tauri/src/lib.rs` covers the exit code mapping.
- Vitest in `apps/desktop/src/lib/settingsPage.test.ts` for the app's restart flow (`restartDaemon`), against stand-ins for the Tauri command and the confirm dialog.
- By hand in the dev app: Restart with a terminal open (it keeps running). Then `kill -STOP` the dev daemon, click Restart, and confirm Force restart (a new daemon answers).
