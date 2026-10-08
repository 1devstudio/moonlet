# S1: Daemon-owned sessions

- **Status:** implemented
- **Priority / phase:** P0 · phase 1
- **PRD refs:** S1, goal 1, journey J2
- **Related ADRs:** [0002](../adr/0002-rust-daemon-own-pty.md)

## Summary

Every PTY is owned by `moonletd`, a background process separate from the app. If the app quits or crashes, the daemon and every session keep running.

## Behaviour and acceptance criteria

- [x] `moonletd daemon` listens on `~/.jaunt/run/jauntd.sock`. The directory is `0700`, the socket is `0600`, and connections from another uid are rejected.
- [x] A second daemon refuses to start while one is answering on the socket; a stale socket file is replaced.
- [x] `moonletd start` and `moonletd proxy` start the daemon detached in its own session (`setsid`) when it is not running.
- [x] Closing a client connection detaches it from its sessions and never kills them.
- [x] The daemon captures the user's login-shell environment once at startup, so PTYs and git use the same `PATH` as a normal terminal. The login shell runs from a clean environment with only an allowlist (HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LC_*, SSH_AUTH_SOCK, DISPLAY, XDG_RUNTIME_DIR), so tokens and session markers of whatever process started the daemon (e.g. an agent's `CLAUDE_CODE_*`) never reach terminals. Environments handed over in a live upgrade are scrubbed of agent markers.
- [x] Each PTY gets `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=moonlet`, `JAUNT_SESSION_ID`, `JAUNT_SOCK`, and `JAUNT_WORKSPACE_ID` when it belongs to a workspace.
- [x] Process exit is reported with its code or signal (`session.exited`); the record stays until it is removed.
- [x] Clients with a different protocol version get a `protocol_mismatch` error, not undefined behaviour.

## Protocol and RPCs

`daemon.info`, `daemon.shutdown`, `session.create|list|kill|resize|write`, Input/Output frames. See [protocol](../protocol.md).

## Security considerations

Socket permissions plus a peer-uid check. There is no TCP listener. The PTY environment is built explicitly from the captured login environment.

## Out of scope

- launchd registration ([S1b](S1b-launchd.md)).
- Live upgrade ([S3](S3-live-upgrade.md)).

## Test plan

- `crates/moonlet-core/src/session.rs` tests: spawn, exit codes, attention events.
- `crates/moonletd/tests/daemon.rs`: socket permissions, protocol mismatch, survive disconnect.
