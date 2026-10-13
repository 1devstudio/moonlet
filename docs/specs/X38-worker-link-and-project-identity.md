# X38 — Worker link and project identity

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (new scope: sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0008](../adr/0008-central-host-workers-live-copies.md)

## Summary

The first slice of [ADR 0008](../adr/0008-central-host-workers-live-copies.md). A Mac can be linked to a **central host** as a **worker**: its own `moonletd` dials out to the central host over the SSH transport moonlet already uses, registers what it is (name, platform, cores, slots, tools, projects), and stays linked across sleep and network changes. The central host keeps the list of linked workers and measures each one's round trip. Every project gets a **project identity**, its normalized origin URL plus its root commit, so the central host can tell which worker has which repository whatever its path.

Nothing is routed or synced yet. This slice gives the next ones (live copies, routing) a link, a registry and a way to name projects across machines.

## User journey

1. On the MacBook, Settings › Hosts already lists `studio-mini` (R1). You mark it **Central host**.
2. Settings › This Mac has **Use this Mac for heavy commands**, with **Slots: 2**. You turn it on.
3. The row under the toggle reads "Linked to studio-mini". If moonlet isn't installed there, it reads "Install moonlet on studio-mini first", with the R2 install button.
4. On the Mac mini (or in the MacBook app's view of it), Settings › Workers lists "Alex's MacBook Pro · macOS arm64 · 10 cores · 2 slots · 12 ms", with its tools and projects.
5. You close the lid. Within seconds the worker disappears from the Mac mini's list. You open the lid, and it is back without you doing anything.

## Behaviour and acceptance criteria

### Link settings

- [ ] `link.set {central, worker: {enabled, slots, name}}` stores the link settings in `$MOONLET_HOME/link.json`. `link.get` returns them together with the link's state.
- [ ] The first time the daemon reads `link.json`, it gives this machine a **worker id**: a random UUID that never changes afterwards and is not editable through `link.set`. A worker is told apart from others by this id, never by its name.
- [ ] `name` is only a label. It defaults to the Mac's computer name (the hostname on Linux) and can be changed.
- [ ] `central` must be a valid SSH alias by R1's rules (no leading `-`, no whitespace) or `null`. An invalid alias is rejected with an error and nothing is stored.
- [ ] `slots` is an integer from 1 to 16 and defaults to 2.
- [ ] With `enabled: false` or `central: null`, no link is opened, and an open link is closed within 1 s.

### The link

- [ ] With the worker enabled and a central host set, the daemon spawns `ssh <alias> ~/.moonlet/bin/moonletd proxy` with R1's ssh options, except connection sharing. The link uses a connection of its own (`ControlMaster=no`, no `ControlPath`), so a stale shared connection after sleep cannot hang it, and it cannot hang the app's connection. It sends `Hello {client: "moonletd-worker"}` and then `worker.register`.
- [ ] Before linking, the daemon checks the remote helper's version the way the app does (R2). A missing or different helper puts the link in state `needs_install` with the alias. It does not retry until `link.set` or `link.retry` is called.
- [ ] A dropped link reconnects with backoff: 300 ms, doubling, capped at 5 s. The same as the app's host links.
- [ ] `link.get` reports the state: `off`, `connecting`, `linked {since}`, `needs_install`, or `error {message}`. The event `link.changed` fires on every change.
- [ ] When a worker connects with the same worker id as a worker already linked, the newer link replaces the older one, and the older connection is closed. Two workers with the same name and different ids are both linked.

### Registration and the worker list (central host)

- [ ] `worker.register` carries:
  - `id`: the worker id;
  - `name`: the label, by default the Mac's computer name or the hostname on Linux;
  - `os` and `arch`: `macos`/`linux`, `arm64`/`x86_64`;
  - `cores` and `slots`;
  - `tools`: see below;
  - `version`;
  - `projects`: the worker's projects, each with its identity and path.
- [ ] `worker.list` on the central host returns every linked worker with those fields, plus `connected_since` and `rtt_ms`.
- [ ] A worker whose connection closes is gone from `worker.list` at once. The event `workers.changed` fires on every register, update or disconnect.
- [ ] The central host sends `worker.ping` over the worker's connection every 30 s. It is the first request that goes from the central host to the worker. `rtt_ms` is the last round trip in milliseconds. A worker that misses three pings in a row is disconnected.
- [ ] A worker that adds or removes a project sends `worker.update {projects}`, and `worker.list` reflects it.

### Tools

- [ ] `tools` lists which of a fixed set are found by the user's login shell (`$SHELL -lic`): `git`, `node`, `pnpm`, `npm`, `yarn`, `bun`, `cargo`, `rustc`, `go`, `python3`, `docker`, `xcodebuild`.
- [ ] Worked example: on the trial Mac mini, `cargo` and `rustc` are not found, so they are not listed. A routed `cargo test` could then never be placed there (X41).

### Project identity

- [ ] Every project has an `identity {origin, root}`. It is computed when the project is added, and on daemon start for projects added before this change.
- [ ] `origin` normalizes the `origin` remote. Worked examples:

  | `git remote get-url origin` | `origin` |
  |---|---|
  | `https://github.com/1devstudio/moonlet.git` | `github.com/1devstudio/moonlet` |
  | `git@github.com:1devstudio/moonlet.git` | `github.com/1devstudio/moonlet` |
  | `ssh://git@github.com/1devstudio/moonlet` | `github.com/1devstudio/moonlet` |
  | `ssh://git@github.com:22/1devstudio/moonlet.git/` | `github.com/1devstudio/moonlet` |
  | `https://user:token@GitHub.com/1devstudio/moonlet.git` | `github.com/1devstudio/moonlet` |
  | `https://gitlab.example.com:8443/team/app.git` | `gitlab.example.com:8443/team/app` |
  | `/Users/me/src/app` (a local path) | `null` |
  | (no `origin` remote) | `null` |

  Credentials are removed, the scheme and user are removed, the host is lowercased, a port is kept only when it is not the scheme's default, a trailing `.git` or `/` is removed, and the path's case is kept.
- [ ] `root` is the root commit of `HEAD`'s history (`git rev-list --max-parents=0 HEAD`). Worked example: this repository's root is `4171b03ff0d2bd434751f17bc9d34da784f97e72`.
  - With several roots (merged histories), it is the oldest by committer date, with ties broken by the smallest hash.
  - A shallow clone, or a repository with no commits, has `root: null`.
- [ ] Two projects are the same project when their roots are equal and not `null`, and their origins are equal or one of them is `null`. `project.identity {path}` returns the identity of any folder.
- [ ] The origin URL as written, with any credentials, is never stored or sent. Only the normalized `origin` is.

## UI

- **Settings › Hosts:** each remote host row gets a **Central host** choice. At most one host is the central host, and choosing another moves it.
- **Settings › This Mac:** a new section with **Use this Mac for heavy commands** (a toggle), **Slots** (a stepper, 1–16), and a status line:
  - "Not linked"
  - "Linking to studio-mini…"
  - "Linked to studio-mini since 10:42"
  - "Install moonlet on studio-mini first" (with the install button)
  - the ssh error, with **Retry**
- **Settings › Workers:** shown when the connected host has linked workers. One row per worker: name, `os arch`, cores, slots, round trip, tools, and the number of projects.
- **Settings › This Mac** also lets you rename this worker. The name is only a label.
- Until routing ships (X41), the toggle's help text says it only links the Mac; commands are not routed yet.

## Protocol and RPCs

- **New methods:**
  - `link.get`, `link.set`, `link.retry` (local daemon);
  - `worker.register`, `worker.update`, `worker.list` (central host);
  - `worker.ping` (central host to worker);
  - `project.identity`.
- **New events:** `link.changed` (local), `workers.changed` (central host).
- **Requests both ways:** on a connection whose Hello says `moonletd-worker`, the central host may send `request` messages, and the worker answers with `response`. Other clients never receive requests.
- **Changed type:** `Project` gains `identity {origin: string | null, root: string | null}`.
- `PROTOCOL_VERSION` goes from 3 to 4.
- **Code moves:**
  - The ssh spawn, version check and backoff move from `apps/desktop/src-tauri/src/hosts.rs` and `remote.rs` into `moonlet-core`, and the app uses them from there.
  - `moonlet_core::client::Client` works over any `AsyncRead + AsyncWrite` pair as well as the Unix socket.

## Data and config

- `$MOONLET_HOME/link.json`:

  ```json
  {
    "central": "studio-mini",
    "worker": {
      "id": "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37",
      "name": "Alex’s MacBook Pro",
      "enabled": true,
      "slots": 2
    }
  }
  ```

- `state.json`: each project gains `identity`. The migration on load fills it in for existing projects. A failure to compute one leaves `null` fields, never a failed load.
- The central host keeps its worker list in memory only. It reflects live connections and is rebuilt as workers reconnect after a central restart or a live upgrade.

## Security considerations

- The link is the user's own SSH, with `BatchMode=yes`. moonlet stores no keys. A worker connects only to the alias in `link.json`.
- Linking makes the worker a daemon that answers the central host's requests. In this slice the only such request is `worker.ping`. Later slices (X41) add routed commands, with their own checks on the worker.
- Normalizing removes credentials from origin URLs before anything is stored or sent, so a token in a remote URL never reaches the central host.
- Tool detection runs the user's login shell once at registration and again when the user asks. It never runs on a timer.

## Out of scope

- Live copies and file sync (X40), routed commands and the scheduler (X41), and the central host setup switch, Linux service and data folder (X39).
- Phone access, takeover, cloud workers.
- Cloning a project on a worker. This slice only reports which projects a worker already has.

## Test plan

- **Unit, `moonlet-core`:**
  - origin normalization with the worked examples above as literals;
  - choosing the root among several, with captured `git log --format='%H %ct'` output;
  - parsing tool detection output;
  - `link.json` load and save, including invalid aliases and `slots` bounds.
- **Daemon end-to-end, `crates/moonletd/tests/link.rs`:** two `TestDaemon`s with separate `MOONLET_HOME`s. A test-only override (`MOONLET_LINK_COMMAND`) lets the worker spawn the central host's `moonletd proxy` directly, as in `proxy.rs`, without ssh. Tests:
  - a registered worker appears in `worker.list` with the literal name, os, arch, slots and tools;
  - killing the link removes the worker and fires `workers.changed`;
  - the worker reconnects after the central daemon restarts;
  - `rtt_ms` is filled after a ping;
  - `project.identity` on a repo with origin `git@github.com:acme/shop.git` returns `github.com/acme/shop` and its root commit;
  - a second link with the same worker id replaces the first;
  - two workers with the same name and different ids are both listed;
  - the worker id stays the same across daemon restarts and `link.set` calls.
- **Vitest, `apps/desktop/src/lib/`:** the status line text for each link state.
- **e2e:** turning on **Use this Mac for heavy commands** against a scratch central host shows "Linked to …" (saving settings is a crucial feature, X12).

## Decisions

- **Worker identity (2026-10-13):** workers are told apart by a generated id. The name is a label that defaults to the computer name and can be changed. Matching by name would make two Macs both called "MacBook Pro" replace each other's links over and over.
- **Connection sharing (2026-10-13):** the link uses its own ssh connection. Sharing speeds up repeated short connections, but the link is one connection that stays open for days. A stale shared connection after sleep would hang both the link and the app for up to 30 s.
