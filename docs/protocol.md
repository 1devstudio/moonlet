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

Frames are at most 16 MiB. A git pack goes as Pack frames of at most 1 MiB each, so it never holds up terminal output, and an empty one ends it. The JSON message that uses the pack follows its frames and names it by transfer id (`pack`). A `worker.ping` and its reply skip ahead of queued pack chunks (they go out before the next chunk), so a large pack on a slow link never makes the central host drop the worker. The daemon takes Pack frames only from a `moonletd-worker` connection; any other client that sends one is disconnected with an id-0 `forbidden` error. Either side ends the connection (id-0 `too_large` from the daemon) when one pack passes 1 GiB, the packs waiting on it pass 1 GiB together, or more than 16 are waiting. A whole pack no message takes within 60 s is dropped, and so is a pack in part whose next chunk does not come within 60 s; a chunk for a pack already whole ends the connection. The limits hold per connection, with no budget shared across connections: only paired workers may send packs, and each is one of the user's own machines. PTY bytes are never wrapped in JSON. The daemon coalesces output per client and flushes every 8 ms or at 64 KiB.

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
- `link.*` (X41, X61): get, set, retry and pair this machine's link to its central host, kept in `~/.moonlet/link.json`. `link.get` returns `{central: {name, addrs} | null, worker: {id, name, enabled}, state}`, never the token; `state.kind` is `off`, `connecting`, `connected` (`since`), `reconnecting`, `needs_update` (`daemon_version`), `refused` (the central host no longer accepts this Mac) or `error` (`message`). A link in `needs_update`, `refused` or `error` tries again on `link.retry` or any `link.set`. `link.set {central?, worker?: {enabled?, name?}}` changes only what it is given; `central: null` clears it. `link.pair {central: {name, addrs}, code}` (X61) pairs this machine with the central host using a pairing code from it, as a `desktop` device named after the worker, and stores the central host with the token it gets; it fails with `pair_failed` and changes nothing when the pairing does not work, with `conflict` and changes nothing when the central host was set while it ran, and with `pair_unsaved` when the central host paired this machine but the token could not be saved. `link.set`, `link.retry` and `link.pair` answer the Mac's app and a paired Mac over the tailnet, which may not give `link.set` a `central`; a phone and the CLI get `forbidden`. Event: `link.changed`, the same as `link.get`.
- `sync.*` (X60): live copies. On this Mac's daemon, `sync.start {session}` (a session on the central host), `sync.list`, `sync.retry {copy}`, `sync.resolve {copy, path, keep: "central" | "worker"}` and `sync.use_central_branch {copy}` (a diverged copy's branch moves to the central host's commit; this Mac's commits stay on `<branch>-this-mac`), each giving `Copy {id, host, session, path, state, setup, differs, too_big, diverged}`; `state.kind` is `copying`, `in_sync`, `syncing` (`files`), `waiting` or `paused` (`reason`). `setup` is `null` or `{state, command, approved}`, `state.kind` being `needs_approval`, `running`, `done`, `failed` (`exit`) or `skipped`, `command` the copy's setup command now and `approved` whether it was approved. `sync.run_setup {copy, command}` approves and runs the copy's setup, refused with `setup_changed` (message: the current command) when the command is no longer the copy's, and with `no_setup` when the copy has none; `sync.skip_setup {copy}` skips one waiting for approval. `sync.project_get {identity}` and `sync.project_set {identity, keep_new}` → `{keep_new}`: whether new sessions of that project on the central host get a copy here. `sync.project_set` fails with `no_central_host` when this Mac has none and `no_identity` for a project without a root commit. While a project keeps new sessions, the worker link stays open and the worker follows the central host's `sessions.changed` and `projects.changed`; a new session waits 3 s before it is kept, so the composer decides first. `sync.decline {session}` → `true`: that session gets no copy, the composer's unticked checkbox. `sync.run_setup`, `sync.skip_setup`, `sync.project_set` and `sync.decline` answer only the Mac's app: a paired device or the CLI gets `forbidden`. `sync.stop {copy}` removes the copy and returns `{folder, leftovers}`, the files it saved under `~/.moonlet/sync-leftovers/<copy folder>-<YYYYMMDD-HHMMSS>/`; it fails with `not_saved` when a file could not be saved and `failed` when the worktree could not be removed, and the copy then stays, paused. Event: `sync.changed`, the copy plus `newly_differing`, the paths that started to differ with this change, and `removed {reason: "stopped" | "archived", folder, leftovers}` when the copy went. Over the worker link, the worker asks `sync.open`, `sync.fetch` and `sync.offer {copy, base, tree, head, too_big, pack, resolve?}` → `{from, tree, base, head, differs, too_big, pack}` (only from a `moonletd-worker` connection, for its own copies), and `sync.close {copy}` when it stopped keeping one; the central host sends `sync.update` → `{applied, tree}` (`tree` is `null` when the worker was busy offering), and `sync.closing {copy, reason: "archived"}` → `{folder, leftovers}` once it has archived the session, without waiting for the answer. `sync.resolve` fails with `invalid_params`, `paused`, `not_ready`, `disconnected` or `busy` when it could not be done. An offer the central host turns away is made again after 300 ms, doubling up to 5 s. A `sync.update` with `off_branch` (the branch the session is on, empty for a detached `HEAD`) pauses the copy until one without it; a `sync.offer` while the session is off its branch fails with `wrong_branch`, whose message is that branch. Commits move the other side's branch only forward; `diverged {ahead, behind}` counts the commits only on this Mac and only on the central host. The central host reconciles: a worker takes an update only while its files are its base, and otherwise offers them. Their objects travel in Pack frames.
- `worker.*` (X41): on the central host, `worker.register` (only from a `moonletd-worker` connection over the tailnet) and `worker.list`, each worker with `{id, name, os, arch, cores, version, projects: [{identity, path}], connected_since, rtt_ms}`. The central host sends `worker.ping` to each worker every 10 s and drops one that misses three in a row. Event: `workers.changed`, the list.

## Versioning

`PROTOCOL_VERSION` is bumped on any incompatible change. When versions differ, the client shows an "upgrade daemon" action, which calls `daemon.upgrade` on an old daemon that still understands it, or restarts the daemon.
