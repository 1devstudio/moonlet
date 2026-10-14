# X41 — Worker link and project identity

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (new scope: sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0009](../adr/0009-central-host-workers-live-copies.md), [0008](../adr/0008-phone-link-over-tailscale.md) (`moonlet-link`)

## Summary

The first slice of [ADR 0009](../adr/0009-central-host-workers-live-copies.md).

- **The link:** a Mac can be linked to a **central host** as a **worker**. Its own `moonletd` dials out to the central host over the SSH transport moonlet already uses and registers itself.
- **The worker list:** the central host keeps a list of linked workers. It notices within about 30 s when one goes away, for example when the lid closes.
- **Project identity:** every project gets one, its normalized origin plus its root commit. The central host can then tell which worker has which repository, whatever the path.

Nothing is routed or synced yet. Everything that only routing uses waits for the routing slice: slots, tool detection, live project updates and a Workers screen.

## User journey

1. On the MacBook, Settings › Hosts already lists `studio-mini` (R1). You mark it **Central host**.
2. Settings › This Mac has **Use this Mac for heavy commands**. You turn it on.
3. The line under the toggle reads "Linked to studio-mini since 10:42". If moonlet isn't installed there, it reads "Install moonlet on studio-mini first", with the R2 install button.
4. On the Mac mini, `moonlet rpc worker.list` shows "Alex's MacBook Pro", macOS arm64, 10 cores, its projects and its round trip.
5. You close the lid. Within about 30 s the worker is gone from the Mac mini's list. You open the lid, and it is back without you doing anything.

## Behaviour and acceptance criteria

### Link settings

- [ ] `link.set {central, worker: {enabled, name}}` stores the link settings in `$MOONLET_HOME/link.json`. `link.get` returns them together with the link's state.
- [ ] The first time the daemon reads `link.json`, it gives this machine a **worker id**. The id is a random UUID that never changes afterwards and that `link.set` cannot edit. Workers are told apart by id, never by name.
- [ ] `name` is a label. It defaults to the Mac's computer name (the hostname on Linux) and `link.set` can change it.
- [ ] `central` must be a valid SSH alias by R1's rules (no leading `-`, no whitespace) or `null`. An invalid alias is rejected with an error, and nothing is stored.
- [ ] With `enabled: false` or `central: null`, no link is opened, and an open link is closed within 1 s.
- [ ] The central host never links to itself. When `central` names the machine the daemon runs on, `link.set` is rejected with "this Mac is the central host". Later slices count the central host as a worker directly.

### The link

- [ ] The link is a `moonlet-link` `Host` whose `Connector` runs `ssh <alias> ~/.moonlet/bin/moonletd proxy` with R1's options except connection sharing: `ControlMaster=no` and no `ControlPath`. A stale shared connection after sleep then cannot hang the link, and the link cannot hang the app's connection.
- [ ] Over the link, the worker sends `Hello {client: "moonletd-worker"}` and then `worker.register`.
- [ ] Before linking, the daemon checks the remote helper's version, as the app does (R2). A missing or different helper puts the link in state `needs_install`. It does not retry until `link.set` or `link.retry` is called.
- [ ] A dropped link reconnects with `moonlet-link`'s backoff: 300 ms, doubling, capped at 5 s, as for the apps' host links.
- [ ] The link's state is `off`, or one of `moonlet-link`'s host statuses: `connecting`, `connected {since}`, `reconnecting`, `needs_install` or `error {message}`. `link.get` reports it, and the event `link.changed` fires on every change.
- [ ] A worker linking with the same worker id as a linked worker replaces it, and the older connection is closed. Two workers with the same name and different ids are both linked.

### Registration and liveness (central host)

- [ ] `worker.register` carries:
  - `id` and `name`;
  - `os` and `arch` (`macos`/`linux`, `arm64`/`x86_64`);
  - `cores`;
  - `version`;
  - `projects`: the worker's projects, each with its identity and path.

  The worker registers again, with current values, every time it links.
- [ ] `worker.list` returns every linked worker with those fields, plus `connected_since` and `rtt_ms`. The event `workers.changed` fires when a worker registers or disconnects.
- [ ] The central host sends `worker.ping` over each worker's connection every 10 s. This is the first request that goes from the central host to a worker. `rtt_ms` is the last round trip in milliseconds.
- [ ] A worker that misses 3 pings in a row is disconnected and removed from `worker.list`, about 30 s after it stops answering. A sleeping laptop does not close its connection, so the pings are what notice a closed lid.
- [ ] A worker whose connection closes is removed from `worker.list` at once.

### Project identity

- [ ] Every project has an `identity {origin, root}`.
  - It is computed when the project is added, and on daemon start for projects added before this change.
  - `project.list` returns it.
  - `project.identity {path}` returns the identity of any folder.
- [ ] `origin` normalizes the `origin` remote. Worked examples:

  | `git remote get-url origin` | `origin` |
  |---|---|
  | `https://github.com/1devstudio/moonlet.git` | `github.com/1devstudio/moonlet` |
  | `git@github.com:1devstudio/moonlet.git` | `github.com/1devstudio/moonlet` |
  | `ssh://git@github.com/1devstudio/moonlet` | `github.com/1devstudio/moonlet` |
  | `ssh://git@github.com:22/1devstudio/moonlet.git/` | `github.com/1devstudio/moonlet` |
  | `https://user:token@GitHub.com/1devstudio/moonlet.git` | `github.com/1devstudio/moonlet` |
  | `https://gitlab.example.com:8443/team/app.git` | `gitlab.example.com:8443/team/app` |
  | `/Users/alex/src/app` (a local path) | `null` |
  | (no `origin` remote) | `null` |

  The rules behind the examples:
  - credentials, the scheme and the user are removed;
  - the host is lowercased;
  - a port is kept only when it is not the scheme's default;
  - a trailing `.git` or `/` is removed;
  - the path's case is kept.
- [ ] `root` is the root commit of `HEAD`'s history. Worked example: this repository's root is `4171b03ff0d2bd434751f17bc9d34da784f97e72`.
  - With several roots (merged histories), it is the oldest by committer date, with ties broken by the smallest hash.
  - A shallow clone (`git rev-parse --is-shallow-repository` prints `true`) and a repository with no commits have `root: null`. A shallow clone's boundary commits look like roots but are not.
- [ ] Two projects are the same project when their roots are equal and not `null`, and their origins are equal (two `null` origins count as equal). A local clone without an origin therefore never matches a fork that happens to share its root.
- [ ] Only the normalized `origin` is stored or sent. A token in a remote URL never appears in `project.list`, `project.identity` or `worker.list`.

## UI

- **Settings › Hosts:** each remote host row gets a **Central host** choice. At most one host is the central host; choosing another moves it, and choosing it again clears it.
- **Settings › This Mac:** a new section with a **Use this Mac for heavy commands** toggle and a status line, one per link state:
  - "Not linked"
  - "Linking to studio-mini…"
  - "Linked to studio-mini since 10:42"
  - "Reconnecting to studio-mini…"
  - "Install moonlet on studio-mini first" (with the R2 install button)
  - the ssh error, with **Retry**
- The toggle's help text says it only links this Mac for now; commands are not routed yet.

## Protocol and RPCs

- **New methods:**
  - `link.get`, `link.set`, `link.retry` (local daemon);
  - `worker.register`, `worker.list` (central host);
  - `worker.ping` (central host to worker);
  - `project.identity`.
- **New events:** `link.changed` (local), `workers.changed` (central host).
- **Requests both ways:** on a connection whose Hello says `moonletd-worker`, the central host may send `request` messages, and the worker answers with `response`. Other clients never receive requests.
- **Changed type:** `Project` gains `identity {origin: string | null, root: string | null}`.
- `PROTOCOL_VERSION` goes from 3 to 4.
- **Reused code:** the link is `moonlet-link`'s `Host` (ADR 0008), with a new ssh `Connector` for the daemon. The version check moves from the app's `remote.rs` into that connector, so the app and the worker share it.
- **`moonlet-link` gains request handling:** a `Host` can be given a handler for `request` messages from the daemon, and it answers with `response`. The worker uses it for `worker.ping`.

## Data and config

- `$MOONLET_HOME/link.json`:

  ```json
  {
    "central": "studio-mini",
    "worker": {
      "id": "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37",
      "name": "Alex's MacBook Pro",
      "enabled": true
    }
  }
  ```

- `state.json`: each project gains `identity`. The migration on load fills it in for existing projects. A failure to compute one leaves `null` fields, never a failed load.
- The central host keeps its worker list in memory only. It reflects live connections and is rebuilt as workers reconnect after a central restart or a live upgrade.

## Security considerations

- The link is the user's own SSH, with `BatchMode=yes`. moonlet stores no keys. A worker connects only to the alias in `link.json`.
- Linking makes the worker a daemon that answers the central host's requests. In this slice the only such request is `worker.ping`. Routed commands come later, with their own checks on the worker.
- Normalizing removes credentials from origin URLs before anything is stored or sent.

## Out of scope

Everything else in [ADR 0009](../adr/0009-central-host-workers-live-copies.md)'s later slices, including:

- the central host setup switch;
- live copies and cloning projects onto a worker;
- routed commands, together with what only routing uses: slots, tool detection, project changes sent between reconnects, a Workers screen and renaming a worker in the UI;
- takeover and cloud workers. Phone access is ADR 0008's.

## Test plan

Every acceptance criterion maps to a test. Expected values are literals from this spec or from captured output.

- **Unit, `moonlet-core`:**
  - `normalize_origin`, using every row of the worked-example table.
  - `pick_root`, from captured `git log --format='%H %ct'` output with one root and with two roots (oldest wins), plus a timestamp tie (smallest hash wins).
  - Root on a real shallow clone (`git clone --depth 1` of a scratch repo) is `null`; root of an empty repo is `null`.
  - `same_project`:
    - equal roots and origins: same;
    - equal roots, one origin `null`: different;
    - both origins `null`: same;
    - a root that is `null`: different.
  - `link_ssh_args("studio-mini")` contains `ControlMaster=no`, no `ControlPath`, and R1's other options.
  - `moonlet-link`: a `Host` with a request handler answers a daemon's `request` with a `response` carrying the same id, tested against the fake daemon in `crates/moonlet-link/tests/link.rs`.
  - `link.json`:
    - the first load creates a worker id, and later loads return the same id;
    - `link.set` cannot change the id;
    - an invalid alias is rejected and the file is unchanged;
    - the name defaults to the given computer name.
  - `moonlet-link`'s backoff sequence for successive failures is 300, 600, 1200, 2400, 4800, 5000, 5000 ms (a test added to `crates/moonlet-link`).
- **Daemon end-to-end, `crates/moonletd/tests/link.rs`:** two `TestDaemon`s with separate `MOONLET_HOME`s. A test-only `MOONLET_LINK_COMMAND` makes the worker spawn the central host's `moonletd proxy` directly, as in `proxy.rs`, without ssh.
  - A linked worker appears in `worker.list` with its literal id, name, `os`, `arch`, `cores`, `version` and project identities. `link.get` says `linked`, and `link.changed` fired.
  - `rtt_ms` is filled in after the first ping.
  - A worker that stops answering pings (process stopped with SIGSTOP) is removed after 3 missed pings. The test uses a shortened ping interval through a test-only setting.
  - Killing the link removes the worker at once and fires `workers.changed`. The worker reconnects after the central daemon restarts.
  - `link.set {enabled: false}` closes the link within 1 s.
  - A helper reporting a different version gives `needs_install`. No reconnect happens until `link.retry`.
  - A second link with the same worker id replaces the first. Two workers with the same name and different ids are both listed.
  - `link.set` naming this machine as `central` is rejected.
  - A project whose origin is `https://user:token@github.com/acme/shop.git` shows `github.com/acme/shop` in `project.list`, `project.identity` and `worker.list`, and the text `token` appears in none of them.
  - A daemon started on a `state.json` whose projects have no identity reports identities in `project.list`.
- **Vitest, `apps/desktop/src/lib/`:**
  - the status line text for each link state;
  - choosing a central host moves the choice, so at most one host has it, and choosing it again clears it.
- **e2e, `apps/desktop/e2e/specs/worker-link.e2e.ts`:** the fixture starts a second scratch daemon as the central host and points the app's daemon at it with `MOONLET_LINK_COMMAND`. Turning on **Use this Mac for heavy commands** shows "Linked to …". Saving settings is a crucial feature (X12).

## Open questions

None open. Decided on 2026-10-13:

- **Workers have an id; the name is only a label.** With names, two Macs both called "MacBook Pro" would keep replacing each other's links.
- **The link has its own ssh connection.** The link is one connection that stays open for days, so sharing would gain little. A stale shared connection after sleep would hang both the link and the app for up to 30 s.
- **Pings every 10 s, disconnect after 3 misses**, so a closed lid shows within about 30 s.
- **Slice 1 leaves out slots, tool detection, live project updates, the Workers screen and renaming in the UI.** Only routing uses them. A smaller slice lets every criterion have a real test.
