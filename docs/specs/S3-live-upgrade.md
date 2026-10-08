# S3: Daemon upgrade without killing sessions

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** S3, goal 1, risk "daemon lifecycle bugs"
- **Related ADRs:** [0002](../adr/0002-rust-daemon-own-pty.md)

## Summary

A new `moonletd` binary takes over every live PTY from the running daemon. Agents keep running, screens and scrollback are preserved, and clients just reconnect. The trigger is independent of the protocol version, so it works even when the old and new daemons cannot talk RPC to each other.

## Flow

1. `moonletd upgrade` (run from the *new* binary) reads `~/.jaunt/run/jauntd.pid`, writes `~/.jaunt/run/upgrade.json` with its own path, and sends `SIGUSR2` to the old daemon. `daemon.upgrade {binary}` does the same over RPC.
2. The old daemon opens a private handoff socket (`run/handoff-<pid>.sock`, `0600`) and starts `<binary> daemon --handoff <path>` detached.
3. The new daemon connects and receives:
   - a JSON header: each live session's `SessionInfo`, size and screen snapshot;
   - the PTY master fds via `SCM_RIGHTS`, in chunks of up to 64.
4. The new daemon rebuilds terminal state by replaying each snapshot, installs the sessions under the **same ids**, and replies `A` (adopted).
5. The old daemon stops listening, removes its pid file and exits without touching the PTYs. The new daemon keeps trying to bind the socket for up to 10 s, then serves. Workspace state is reloaded from `state.json`. Restore is a no-op because the sessions are alive.
6. If anything fails before `A`, the old daemon closes the handoff and logs the error. It then restarts the terminal I/O it stopped for the export and keeps serving, so no session is lost. A terminal's exit code may be unknown afterwards, because the child handle was released for the handoff. Only one upgrade runs at a time; a second request is refused while one is in progress.

## Behaviour and acceptance criteria

- [x] After `moonletd upgrade`, `session.list` returns the same ids and the processes keep running (same pids).
- [x] Reattaching shows the screen from before the upgrade, and new output keeps flowing.
- [x] Input works after the upgrade.
- [x] The daemon pid changes, and the new version is reported by `daemon.info`.
- [x] The app compares `daemon_version` with its own version on connect. If they differ, or the handshake fails with `protocol_mismatch`, it runs the bundled `moonletd upgrade` once and reconnects.
- [x] `moonletd proxy` on a remote host does the same before bridging, so installing a new helper upgrades the running remote daemon.

## Limits

- Upgrades work from the first build that has the pid file and the SIGUSR2 handler (this commit) onward. An older running daemon has to be restarted once.
- The exit codes of adopted processes are unknown (they are not our children). They are reported as `null`.
- Agent state carries over as reported. Hook-shadowing timers restart.

## Security considerations

The handoff socket lives in the `0700` run directory with mode `0600`, and the peer uid is checked. The upgrade request file is read only from the private run directory.

## Test plan

`crates/moonletd/tests/upgrade.rs`: start a daemon, run a session, upgrade, then assert the same id and pid, the snapshot contents, working input, and a changed daemon pid.
