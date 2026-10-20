# moonlet wire protocol

`moonletd` speaks one protocol to every client: the desktop app, the `moonlet` CLI, remote connections tunnelled through `ssh host moonletd proxy`, and the phone app (X39). The Rust source of truth is `crates/moonlet-proto`.

## Transport

- **Local:** Unix socket at `~/.moonlet/run/moonletd.sock`. The directory is `0700` and the socket is `0600`. The daemon also checks that the peer's uid matches its own.
- **Remote:** `ssh <host> ~/.moonlet/bin/moonletd proxy` bridges stdio to the remote daemon's socket and starts that daemon if it is not running. The daemon outlives the SSH connection.
- **Phone (X39):** TCP port 47428 on the Mac's Tailscale addresses only, while phone access is on. The first frame must be `auth`; see Messages.

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
- `auth` `{token?, pair?, device?, kind?, route?}` comes first on a phone connection, before `hello` (X39). `kind` (`phone` or `desktop`, X57) says what is pairing; it defaults to `phone`. The daemon answers `authed` `{device_id, token?, protocol, daemon_version, host}` (`token` only after a pairing; daemons before X57 leave out the last three) or one `response` with `id` 0 and error `unauthorized`, then closes. With `route`, everything after `authed` comes from `ssh <route> moonletd proxy`.

## Attach ordering

`session.attach` returns `{info, snapshot}`. `snapshot` is an escape-sequence stream that redraws scrollback, the screen, the cursor and terminal modes on a freshly reset terminal. The daemon takes the snapshot and subscribes the client under the same lock, so the first Output frame after the response continues exactly where the snapshot ends.

## Methods

Method names and parameter structs are in `crates/moonlet-proto/src/methods.rs`; result types are in `types.rs`. Groups:

- `daemon.*`: info (with `data_dir`, the daemon's data folder, X55), shutdown, upgrade.
- `terminal.*`: create, list, attach, detach, resize, kill, write, search.
- `agent.report`: state reports from agent hooks (`moonlet hook …`).
- `workspace.*`, `section.*`, `project.*` and `session.*`: workspaces, their sections, projects, worktree sessions, scripts (X32). `session.archive` takes `delete_remote` and returns `{ remote_error }` (X55; older daemons return `true`).
- `profile.*`: Claude profiles, the config folders workspaces run Claude with (X33).
- `claude.*`: version (the installed Claude Code, and whether an update runs) and update (runs `claude update`) (X36). Events: `claude.update_output` per line while it runs, `claude.update_done` when it ends.
- `chat.*`: state, summaries (every chat's state without items, X40), send, send_now and unqueue (a queued message, X49), aside (a side question answered by a tool-less fork of the conversation, X49), permission, interrupt, settings (model, effort, permission mode) for structured agents (X6, X7). Events: `chat.item`, `chat.state`.
- `git.*` and `gh.*`: status, diffs, staging, commit, log, PRs, issues.
- `git.settings` and `git.set_settings`: the host's Git settings, kept in `~/.moonlet/git.toml` (X55). `git.unpushed` (uncommitted files and commits not on origin) and `git.push` (`push -u origin HEAD`) for the archive prompt. Event: `git.settings_changed`, the whole settings after a change.
- `fs.*`: list, files, read, write, watch.
- `shell.history`: the login shell's history for input suggestions.
- `mobile.*`: status, set_enabled, pair_start, pair_cancel, revoke, hosts, unpair for tailnet access (X39, X57). Only the desktop app may call them, except `mobile.hosts`, which phones use, and `mobile.unpair`, with which a paired device removes itself from its own connection. Events: `mobile.changed`, `mobile.paired`, `mobile.pair_ended`.

## Versioning

`PROTOCOL_VERSION` is bumped on any incompatible change. When versions differ, the client shows an "upgrade daemon" action, which calls `daemon.upgrade` on an old daemon that still understands it, or restarts the daemon.
