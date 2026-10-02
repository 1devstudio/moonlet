# jaunt wire protocol

`jauntd` speaks one protocol to every client: the desktop app, the `jaunt` CLI, and remote connections tunnelled through `ssh host jauntd proxy`. The Rust source of truth is `crates/jaunt-proto`.

## Transport

- **Local:** Unix socket at `~/.jaunt/run/jauntd.sock`. The directory is `0700` and the socket is `0600`. The daemon also checks that the peer's uid matches its own.
- **Remote:** `ssh <host> ~/.jaunt/bin/jauntd proxy` bridges stdio to the remote daemon's socket and starts that daemon if it is not running. The daemon outlives the SSH connection.

## Framing

```
[u32 BE length of kind + payload][u8 kind][payload]
```

| kind | name | payload | direction |
|---|---|---|---|
| 1 | JSON | one `Message` (see below) | both |
| 2 | Output | `[u32 BE session id][raw PTY bytes]` | daemon to client |
| 3 | Input | `[u32 BE session id][raw bytes]` | client to daemon |

Frames are at most 16 MiB. PTY bytes are never wrapped in JSON. The daemon coalesces output per client and flushes every 8 ms or at 64 KiB.

## Messages

Every JSON message is an object with a `t` tag:

- `hello` `{protocol, client}` is sent by the client first. The daemon answers `welcome` `{protocol, daemon_version, host, pid}`, or closes the connection if `protocol` differs from its own.
- `request` `{id, method, params}` gets exactly one `response` `{id, result | error}`. `error` is `{code, message}`.
- `event` `{name, data}` is a daemon broadcast to every connected client.

## Attach ordering

`session.attach` returns `{info, snapshot}`. `snapshot` is an escape-sequence stream that redraws scrollback, the screen, the cursor and terminal modes on a freshly reset terminal. The daemon takes the snapshot and subscribes the client under the same lock, so the first Output frame after the response continues exactly where the snapshot ends.

## Methods

Method names and parameter structs are in `crates/jaunt-proto/src/methods.rs`; result types are in `types.rs`. Groups:

- `daemon.*`: info, shutdown, upgrade.
- `session.*`: create, list, attach, detach, resize, kill, write, search.
- `agent.report`: state reports from agent hooks (`jaunt hook …`).
- `repo.*` and `workspace.*`: repos, worktree workspaces, scripts.
- `git.*` and `gh.*`: status, diffs, staging, commit, log, PRs.
- `fs.*`: list, read, write, watch.

## Versioning

`PROTOCOL_VERSION` is bumped on any incompatible change. When versions differ, the client shows an "upgrade daemon" action, which calls `daemon.upgrade` on an old daemon that still understands it, or restarts the daemon.
