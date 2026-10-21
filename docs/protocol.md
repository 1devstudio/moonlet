# moonlet wire protocol

`moonletd` speaks one protocol to every client: the desktop app, the `moonlet` CLI, remote connections tunnelled through `ssh host moonletd proxy`, and the phone app (X39). The Rust source of truth is `crates/moonlet-proto`.

## Transport

- **Local:** Unix socket at `~/.moonlet/run/moonletd.sock`. The directory is `0700` and the socket is `0600`. The daemon also checks that the peer's uid matches its own.
- **Remote:** `ssh <host> ~/.moonlet/bin/moonletd proxy` bridges stdio to the remote daemon's socket and starts that daemon if it is not running. The daemon outlives the SSH connection.
- **Tailnet (X39, X57):** TCP port 47428 on the host's Tailscale addresses only, while tailnet access is on. Paired phones and Macs connect here. The first frame must be `auth`; see Messages.

## Framing

```
[u32 BE length of kind + payload][u8 kind][payload]
```

| kind | name | payload | direction |
|---|---|---|---|
| 1 | JSON | one `Message` (see below) | both |
| 2 | Output | `[u32 BE session id][raw PTY bytes]` | daemon to client |
| 3 | Input | `[u32 BE session id][raw bytes]` | client to daemon |
| 4 | Pack | `[u32 BE transfer id][git pack bytes]` | both, between a worker and its central host (X60) |

Frames are at most 16 MiB. A git pack goes as Pack frames of at most 1 MiB each, so it never holds up terminal output, and an empty one ends it. The JSON message that uses the pack follows its frames and names it by transfer id (`pack`). PTY bytes are never wrapped in JSON. The daemon coalesces output per client and flushes every 8 ms or at 64 KiB.

## Messages

Every JSON message is an object with a `t` tag:

- `hello` `{protocol, client}` is sent by the client first. The daemon answers `welcome` `{protocol, daemon_version, host, pid}`, or closes the connection if `protocol` differs from its own.
- `request` `{id, method, params}` gets exactly one `response` `{id, result | error}`. `error` is `{code, message}`.
- `event` `{name, data}` is a daemon broadcast to every connected client.
- On a worker's connection to its central host (hello `client` `moonletd-worker`, X41), requests also go the other way: the central host sends `request`, numbered from 1, and the worker answers with `response`. `id` 0 stays the reply that ends a link. No other client ever receives a request.
- `auth` `{token?, pair?, device?, kind?, route?}` comes first on a tailnet connection, before `hello` (X39). `kind` (`phone` or `desktop`, X57) says what is pairing; it defaults to `phone`. The daemon answers `authed` `{device_id, token?, protocol, daemon_version, host, os}` (`token` only after a pairing; `os` is `macos` or `linux`, X58; daemons before X57 leave out the last four) or one `response` with `id` 0 and error `unauthorized`, then closes. With `route`, everything after `authed` comes from `ssh <route> moonletd proxy`.

## Attach ordering

`session.attach` returns `{info, snapshot}`. `snapshot` is an escape-sequence stream that redraws scrollback, the screen, the cursor and terminal modes on a freshly reset terminal. The daemon takes the snapshot and subscribes the client under the same lock, so the first Output frame after the response continues exactly where the snapshot ends.

## Methods

Method names and parameter structs are in `crates/moonlet-proto/src/methods.rs`; result types are in `types.rs`. Groups:

- `daemon.*`: info (with `data_dir`, the daemon's data folder, X55), shutdown, upgrade.
- `terminal.*`: create, list, attach, detach, resize, kill, write, search.
- `agent.report`: state reports from agent hooks (`moonlet hook …`).
- `workspace.*`, `section.*`, `project.*` and `session.*`: workspaces, their sections, projects, worktree sessions, scripts (X32). Each project has an `identity {origin, root}`, its normalized origin without credentials and its root commit, and `project.identity {path}` returns that of any folder (X41). `session.archive` takes `delete_remote` and returns `{ remote_error }` (X55; older daemons return `true`).
- `profile.*`: Claude profiles, the config folders workspaces run Claude with (X33).
- `claude.*`: version (the installed Claude Code, and whether an update runs) and update (runs `claude update`) (X36). Events: `claude.update_output` per line while it runs, `claude.update_done` when it ends.
- `chat.*`: state, summaries (every chat's state without items, X40), send, send_now and unqueue (a queued message, X49), aside (a side question answered by a tool-less fork of the conversation, X49), permission, interrupt, settings (model, effort, permission mode) for structured agents (X6, X7). Events: `chat.item`, `chat.state`.
- `git.*` and `gh.*`: status, diffs, staging, commit, log, PRs, issues.
- `git.settings` and `git.set_settings`: the host's Git settings, kept in `~/.moonlet/git.toml` (X55). `git.unpushed` (uncommitted files, and commits on the session's `branch` or a detached HEAD that no other branch or remote has; `merged_head`, a merged PR's head commit, counts as on origin) and `git.push` (`push -u origin <branch>`, else HEAD) for the archive prompt. Event: `git.settings_changed`, the whole settings after a change.
- `repo.*`: adding a project from GitHub (X59). gh_status (gh installed, and the signed-in login), lookup (a repository's details, through gh or `git ls-remote`), list (the signed-in user's repositories, each marked when a project already has it as origin), clone_target (what is at the folder a clone would go to), clone (starts a clone under an id the app chooses and answers at once) and clone_cancel. Events: `repo.clone_progress` with git's step and counts, `repo.clone_done` with the new project, an error or `cancelled`.
- `fs.*`: list, files, read, write, watch.
- `shell.history`: the login shell's history for input suggestions.
- `mobile.*`: status, set_enabled, pair_start, pair_cancel, revoke, hosts, unpair for tailnet access (X39, X57). Only the desktop app may call them, except `mobile.hosts`, which phones use, and `mobile.unpair`, with which a paired device removes itself from its own connection. Events: `mobile.changed`, `mobile.paired`, `mobile.pair_ended`.
- `link.*` (X41): get, set and retry this Mac's link to its central host, kept in `~/.moonlet/link.json`. `link.get` returns `{central: {name, addrs} | null, worker: {id, name, enabled}, state}`, never the token; `state.kind` is `off`, `connecting`, `connected` (`since`), `reconnecting`, `needs_update` (`daemon_version`), `refused` (the central host no longer accepts this Mac) or `error` (`message`). A link in `needs_update`, `refused` or `error` tries again on `link.retry` or any `link.set`. `link.set {central?, worker?: {enabled?, name?}}` changes only what it is given; `central: null` clears it. Event: `link.changed`, the same as `link.get`.
- `sync.*` (X60): live copies. On this Mac's daemon, `sync.start {session}` (a session on the central host), `sync.list` and `sync.retry {copy}`, each giving `Copy {id, host, session, path, state, setup, differs, too_big, diverged}`; `state.kind` is `copying`, `in_sync`, `syncing` (`files`), `waiting` or `paused` (`reason`). Event: `sync.changed`, the copy. Over the worker link, the worker asks `sync.open` and `sync.fetch` (only from a `moonletd-worker` connection, for its own copies), and the central host sends `sync.update`; their objects travel in Pack frames.
- `worker.*` (X41): on the central host, `worker.register` (only from a `moonletd-worker` connection over the tailnet) and `worker.list`, each worker with `{id, name, os, arch, cores, version, projects: [{identity, path}], connected_since, rtt_ms}`. The central host sends `worker.ping` to each worker every 10 s and drops one that misses three in a row. Event: `workers.changed`, the list.

## Versioning

`PROTOCOL_VERSION` is bumped on any incompatible change. When versions differ, the client shows an "upgrade daemon" action, which calls `daemon.upgrade` on an old daemon that still understands it, or restarts the daemon.
