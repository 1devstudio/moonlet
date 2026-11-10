# X96 — Restart the daemon from the app, and force it when it's stuck

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
- [x] `moonletd restart` on a daemon that doesn't answer within 3 s exits with code 3, says "the daemon isn't answering" on stderr, and leaves the daemon alone. (`tests/restart.rs` restart_leaves_a_daemon_that_does_not_answer_and_exits_3)
- [x] `moonletd restart --force` on a daemon that doesn't answer kills it and starts a new daemon on the same socket, which answers. (`tests/restart.rs` force_restart_replaces_a_daemon_that_does_not_answer)
- [x] `moonletd restart --force` never kills a process that isn't a moonletd: when the pid file names a live process that isn't one (a stale file whose pid was reused), that process keeps running and a new daemon starts. (`tests/restart.rs` force_restart_never_kills_a_process_that_is_not_moonletd)
- [x] `moonletd restart` with no daemon running starts one. (`tests/restart.rs` restart_starts_a_daemon_when_none_runs)
- [x] In the app, Restart asks for nothing when the handoff works, and tells the user that terminals kept running. (`settingsPage.test.ts` "restarts with a handoff and keeps terminals")
- [x] When the daemon can't hand over, the app shows the reason and offers Force restart. Only after the user agrees does it force the restart, and it says that terminals ended. (`settingsPage.test.ts` "forces the restart only after the user agrees")
- [x] Cancelling that dialog leaves the daemon as it is, with no toast. (`settingsPage.test.ts` "leaves a stuck daemon alone when the user cancels")
- [x] Any other failure (moonletd missing, the start failed) shows as an error, without offering a force restart. (`settingsPage.test.ts` "reports other failures without offering a force restart")

## UI

Settings › General › Background daemon gets a row below the login-item toggle:

```
Restart the daemon                                         [Restart]
Hands terminals to a fresh moonletd. If it's stuck, you can force it.
```

The button shows "Restarting…" and is disabled while the command runs. The force dialog is the app's usual confirm (`askConfirm`): title "Force restart the daemon", the reason, then "Force restart ends every terminal it holds. Agents' chats carry on from where they were.", action **Force restart**.

## Protocol and RPCs

- New CLI command `moonletd restart [--force]`.
  - Without `--force`: no daemon listening and no live moonletd in the pid file means it starts one. A daemon that answers `daemon.info` within 3 s gets the S3 handoff to the running `moonletd` binary (`moonletd upgrade`). Otherwise, or when the handoff fails, it exits **3** with the reason on stderr.
  - With `--force`: the pid in `run/moonletd.pid` gets SIGKILL, but only when `ps` names that process `moonletd`. moonletd then waits up to 5 s for it to exit and starts a new daemon (`moonletd start`).
- New Tauri command `restart_daemon { force: bool }`. It runs the bundled `moonletd restart [--force]`. Exit 3 maps to the error code `not_responding`, any other failure to `failed`, each with moonletd's message. On success, the app reconnects to the local host straight away.

## Data and config

None. The pid file `run/moonletd.pid` already existed (S3).

## Security considerations

- Only the user's own processes can be signalled, and only one whose executable is named `moonletd`. That rules out a stale pid file killing an unrelated process that got the same pid.
- A force restart is destructive (terminals end), so the app always asks first. The CLI's `--force` is explicit.

## Out of scope

- **Remote and tailnet hosts.** Restart is for this Mac's daemon. A remote host's daemon is restarted on that host.
- **Restarting under launchd.** After a force restart, the new daemon is started the way the app starts one when none runs. When launchd (the login item) restarts the killed job at the same moment, one of the two daemons binds the socket and the other exits with "already listening", as before X96. Either way exactly one daemon serves.
- **Detecting a stuck daemon by itself.** The user decides when to restart.

## Test plan

- Rust e2e tests in `crates/moonletd/tests/restart.rs`. A daemon that doesn't answer is a real daemon stopped with SIGSTOP.
- Vitest in `apps/desktop/src/lib/settingsPage.test.ts` for the app's restart flow (`restartDaemon`), against stand-ins for the Tauri command and the confirm dialog.
- By hand in the dev app: Restart with a terminal open (it keeps running). Then `kill -STOP` the dev daemon, click Restart, and confirm Force restart (a new daemon answers).
