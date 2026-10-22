# X41 — Worker link and project identity

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (new scope: sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0009](../adr/0009-central-host-workers-live-copies.md), [0011](../adr/0011-machines-connect-over-the-tailnet.md) (the tailnet transport), [0008](../adr/0008-phone-link-over-tailscale.md) (`moonlet-link`)
- **Depends on:** [X57](X57-tailnet-hosts.md), ADR 0011's pairing slice (a desktop pairs with a remote host over the tailnet, and `moonlet-link` gets the tailnet connector).

## Summary

The first slice of [ADR 0009](../adr/0009-central-host-workers-live-copies.md).

- **The link:** a Mac can be linked to a **central host** as a **worker**. Its own `moonletd` dials out to the central host's tailnet listener ([ADR 0011](../adr/0011-machines-connect-over-the-tailnet.md)), authenticates with the token this Mac got when it paired with the host, and registers itself.
- **The worker list:** the central host keeps a list of linked workers. It notices within about 30 s when one goes away, for example when the lid closes.
- **Project identity:** every project gets one, its normalized origin plus its root commit. The central host can then tell which worker has which repository, whatever the path.

Nothing is routed or synced yet. Everything that only routing uses waits for the routing slice: slots, tool detection, live project updates and a Workers screen.

## User journey

1. On the MacBook, Settings › Hosts already lists `studio-mini`, added and paired over the tailnet (ADR 0011). You mark it **Central host**.
2. Settings › This Mac has **Use this Mac for heavy commands**. You turn it on.
3. The line under the toggle reads "Linked to studio-mini since 10:42". If studio-mini runs a moonlet that speaks another protocol version, it reads "Update moonlet on studio-mini". If studio-mini has removed this Mac, it reads "studio-mini no longer accepts this Mac. Pair it again."
4. On the Mac mini, `moonlet rpc worker.list` shows "Alex's MacBook Pro", macOS arm64, 10 cores, its projects and its round trip.
5. You close the lid. Within about 30 s the worker is gone from the Mac mini's list. You open the lid, and it is back without you doing anything.

## Behaviour and acceptance criteria

### Link settings

- [x] `link.set {central, worker: {enabled, name}}` stores the link settings in `$MOONLET_HOME/link.json`, written with mode 0600. `link.get` returns them together with the link's state, without the token. (`the_file_is_private_and_the_shown_settings_have_no_token`, `a_linked_worker_is_listed_on_the_central_host_with_its_projects`)
- [ ] `central` is `null` or `{name, addrs, token}`:
  - `name` is the host's label, such as `studio-mini`;
  - `addrs` are one or more `ip:port` addresses of the host's tailnet listener;
  - `token` is the device token this Mac got when it paired with the host.

  When the user chooses **Central host**, the app's Rust side fills these in from its own entry for the host and calls `link.set` itself, so the token never reaches the webview (X57). The Mac is one paired device, so the app and its daemon share the token, and removing the Mac on the central host cuts both.
- [x] The first time the daemon reads `link.json`, it gives this machine a **worker id**. The id is a random UUID that never changes afterwards and that `link.set` cannot edit. Workers are told apart by id, never by name. (`the_first_load_makes_a_worker_id_that_later_loads_keep`, `link_set_cannot_change_the_worker_id`, `a_worker_id_links_once_and_names_may_repeat`) A `link.json` that cannot be parsed (not JSON, not text) is moved aside to `link.json.bad` rather than written over, and this machine starts afresh with a new id. One that exists but cannot be opened is left as it is and not written at start. (`a_link_json_that_is_not_text_is_kept_aside_too`, `a_link_json_that_cannot_be_opened_is_never_written_over`) A `link.set` whose settings cannot be written fails, and the settings stay as they were. (`a_link_json_that_cannot_be_read_is_kept_aside_not_written_over`, `link_set_fails_and_keeps_the_settings_when_link_json_cannot_be_written`)
- [x] `name` is a label. It defaults to the Mac's computer name (the hostname on Linux) and `link.set` can change it. (`the_name_defaults_to_the_computer_name_and_link_set_changes_it`)
- [x] An invalid `central` is rejected with an error, and nothing is stored: an empty `name` or one with control characters, no `addrs` or one that is not `ip:port`, or a `token` that is not 64 hex characters. (`an_invalid_central_is_refused_and_nothing_is_stored`)
- [x] With `enabled: false` or `central: null`, no link is opened, and an open link is closed within 1 s. [X60](X60-keep-in-sync.md) also opens the link while a session is kept in sync, whatever `enabled` says. (`the_link_is_open_while_heavy_commands_are_on_or_a_session_is_kept_in_sync`, `turning_the_link_off_drops_the_worker_at_once_and_a_restarted_central_host_gets_it_back`)
- [x] The central host never links to itself. When one of `central.addrs` is one of this machine's own Tailscale addresses, `link.set` is rejected with "this Mac is the central host". Later slices count the central host as a worker directly. (`the_central_host_never_links_to_itself`, `a_mac_cannot_link_to_itself`)
- [x] Only the Mac's app sets or retries the link, as only it manages phone access (X39). `link.set` and `link.retry` from a paired device over the tailnet, from a phone routed through the Mac, or from the `moonlet` CLI are refused with `forbidden`. A paired device or an agent could otherwise point this Mac's link at a host of its choosing, which X60 would then let write into copies. (`only_the_macs_app_sets_or_retries_the_link`, `a_phone_reaches_an_ssh_host_through_the_mac`)

### The link

- [x] The link is a `moonlet-link` `Host` with the tailnet `Connector` from ADR 0011's pairing slice. It tries `central.addrs` in order, 5 s each, and sends `auth {token}` as its first frame. The link is its own TCP connection, separate from the app's. (`a_linked_worker_is_listed_on_the_central_host_with_its_projects`)
- [x] After `authed`, the worker sends `Hello {client: "moonletd-worker"}` and then `worker.register`. The central host accepts that client name on a tailnet connection and serves it as any paired device (X57): `mobile.*` other than `mobile.hosts` and `mobile.unpair` is refused. The worker never calls `mobile.unpair`, which would also remove this Mac's app. (`the_central_hosts_requests_start_at_id_1_and_a_worker_manages_no_devices`)
- [x] A central host whose `authed` reply reports another protocol (the pairing slice adds `protocol` and `daemon_version` to it) puts the link in state `needs_update {daemon_version}`. An `unauthorized` reply to `auth` puts it in state `refused`, which the app words "studio-mini no longer accepts this Mac". In both states the link does not retry until `link.set` or `link.retry` is called; any `link.set` retries it. `link.retry` leaves a link that is connected or connecting alone. (`a_retry_leaves_a_working_link_alone`, `a_central_host_on_another_protocol_needs_an_update_and_waits_for_a_retry`, `a_mac_the_central_host_removed_says_so_and_waits_for_a_retry`)
- [x] A dropped link reconnects with `moonlet-link`'s backoff: 300 ms, doubling, capped at 5 s, as for the apps' host links. (`retries_wait_longer_each_time_up_to_five_seconds`, `turning_the_link_off_drops_the_worker_at_once_and_a_restarted_central_host_gets_it_back`)
- [x] The link's state is `off`, or one of `moonlet-link`'s host statuses: `connecting`, `connected {since}`, `reconnecting`, `needs_update {daemon_version}`, `refused` or `error {message}`. `link.get` reports it, and the event `link.changed` fires on every change, once for each `link.set`. (`a_linked_worker_is_listed_on_the_central_host_with_its_projects`, `one_link_set_says_link_changed_once`, `a_central_host_on_another_protocol_needs_an_update_and_waits_for_a_retry`)
- [x] A worker linking with the same worker id as a linked worker replaces it, and the older connection is closed. Two workers with the same name and different ids are both linked. (`a_worker_id_links_once_and_names_may_repeat`)
- [x] A worker id belongs to the paired device that first registered it since the central host started. Another paired device registering the same id is refused with `forbidden`, and the real worker keeps its link. Removing that device (revoked on the central host, or unpaired by itself) releases its ids, so the same Mac pairing again links with its worker id. (`another_paired_device_cannot_take_a_workers_id`, `a_mac_removed_and_paired_again_links_with_its_worker_id`)

### Registration and liveness (central host)

- [x] `worker.register` carries: (`a_linked_worker_is_listed_on_the_central_host_with_its_projects`)
  - `id` and `name`;
  - `os` and `arch` (`macos`/`linux`, `arm64`/`x86_64`);
  - `cores`;
  - `version`;
  - `projects`: the worker's projects, each with its identity and path.

  The worker registers again, with current values, every time it links, and at once when `link.set` renames it while linked. (`a_new_name_reaches_the_central_host_while_linked`) A registration the central host refuses, such as a second Mac with a copied `link.json` and so the same worker id, puts the link in state `error` with the central host's message, which waits for a retry. (`a_second_mac_with_the_same_worker_id_says_so_and_waits`) A device that removed itself cannot register on the connection that stays open a moment for the reply. (`a_mac_that_removed_itself_cannot_register_on_its_closing_connection`)
- [x] `worker.list` returns every linked worker with those fields, plus `connected_since` and `rtt_ms`. The event `workers.changed` fires when a worker registers or disconnects. (`a_linked_worker_is_listed_on_the_central_host_with_its_projects`, `turning_the_link_off_drops_the_worker_at_once_and_a_restarted_central_host_gets_it_back`)
- [x] The central host sends `worker.ping` over each worker's connection every 10 s. This is the first request that goes from the central host to a worker. `rtt_ms` is the last round trip in milliseconds. (`a_linked_worker_is_listed_on_the_central_host_with_its_projects`, `the_central_hosts_requests_start_at_id_1_and_a_worker_manages_no_devices`)
- [x] Requests from the central host to a worker are numbered from 1. Id 0 stays reserved for an error that ends the link, which `moonlet-link` reports as the host's failure. (`the_central_hosts_requests_start_at_id_1_and_a_worker_manages_no_devices`, `a_request_from_the_daemon_gets_the_handlers_answer_with_the_same_id`)
- [x] A worker that misses 3 pings in a row is disconnected and removed from `worker.list`, about 30 s after it stops answering. A sleeping laptop does not close its connection, so the pings are what notice a closed lid. (`a_worker_that_stops_answering_pings_is_dropped`)
- [x] A worker whose connection closes is removed from `worker.list` at once. (`turning_the_link_off_drops_the_worker_at_once_and_a_restarted_central_host_gets_it_back`)

### Project identity

- [x] Every project has an `identity {origin, root}`. (`a_project_has_an_identity_without_credentials`, `projects_saved_without_an_identity_get_one_on_start`)
  - It is computed when the project is added, and refreshed on each daemon start. The origin is read again every start, as a remote can move: a repository without an `origin` remote gets `null`, and a folder that cannot be read keeps the origin it had. The root never changes, so it is read only while it is `null`. (`a_projects_origin_is_read_again_on_start`, `projects_saved_without_an_identity_get_one_on_start`)
  - `project.list` returns it.
  - `project.identity {path}` returns the identity of any folder.
- [x] `origin` normalizes the `origin` remote. Worked examples (`origins_normalize_as_in_the_worked_examples`):

  | `git remote get-url origin` | `origin` |
  |---|---|
  | `https://github.com/1devstudio/moonlet.git` | `github.com/1devstudio/moonlet` |
  | `git@github.com:1devstudio/moonlet.git` | `github.com/1devstudio/moonlet` |
  | `ssh://git@github.com/1devstudio/moonlet` | `github.com/1devstudio/moonlet` |
  | `ssh://git@github.com:22/1devstudio/moonlet.git/` | `github.com/1devstudio/moonlet` |
  | `https://user:token@GitHub.com/1devstudio/moonlet.git` | `github.com/1devstudio/moonlet` |
  | `https://gitlab.example.com:8443/team/app.git` | `gitlab.example.com:8443/team/app` |
  | `https://github.com/acme/shop.git?access_token=secret` | `github.com/acme/shop` |
  | `https://github.com/acme/shop#readme` | `github.com/acme/shop` |
  | `git@github.com:acme/shop.git?access_token=secret` | `github.com/acme/shop` |
  | `/Users/alex/src/app` (a local path) | `null` |
  | (no `origin` remote) | `null` |

  The rules behind the examples:
  - credentials, the scheme and the user are removed;
  - the host is lowercased;
  - a port is kept only when it is not the scheme's default;
  - a query or fragment is removed, since it may carry a token;
  - a trailing `.git` or `/` is removed;
  - the path's case is kept.
- [x] `root` is the root commit of `HEAD`'s history. (`the_root_is_the_oldest_root_commit`, `a_repository_has_its_origin_and_root_and_a_shallow_or_empty_one_no_root`) Worked example: this repository's root is `4171b03ff0d2bd434751f17bc9d34da784f97e72`.
  - With several roots (merged histories), it is the oldest by committer date, with ties broken by the smallest hash.
  - A shallow clone (`git rev-parse --is-shallow-repository` prints `true`) and a repository with no commits have `root: null`. A shallow clone's boundary commits look like roots but are not.
- [x] Two projects are the same project when their roots are equal and not `null`, and their origins are equal (two `null` origins count as equal). A local clone without an origin therefore never matches a fork that happens to share its root. (`same_project_needs_a_known_root_and_the_same_origin`)
- [x] Only the normalized `origin` is stored or sent. A token in a remote URL never appears in `project.list`, `project.identity` or `worker.list`. (`a_project_has_an_identity_without_credentials`, `a_linked_worker_is_listed_on_the_central_host_with_its_projects`)

## UI

- **Settings › Hosts:** each host paired over the tailnet gets a **Central host** choice. SSH hosts do not (ADR 0011). At most one host is the central host; choosing another moves it, and choosing it again clears it.
- **Settings › This Mac:** a new section with a **Use this Mac for heavy commands** toggle and a status line, one per link state:
  - "Not linked"
  - "Linking to studio-mini…"
  - "Linked to studio-mini since 10:42"
  - "Reconnecting to studio-mini…"
  - "Update moonlet on studio-mini"
  - "studio-mini no longer accepts this Mac. Pair it again."
  - any other connection error, with **Retry**
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
- **Reused code:** the link is `moonlet-link`'s `Host` (ADR 0008) with the tailnet `Connector` that ADR 0011's pairing slice adds for the desktop app, so the app and the worker share it.
- **`moonlet-link` gains request handling:** a `Host` can be given a handler for `request` messages from the daemon, and it answers with `response`. The worker uses it for `worker.ping`.

## Data and config

- `$MOONLET_HOME/link.json`, mode 0600 because it holds the token:

  ```json
  {
    "central": {
      "name": "studio-mini",
      "addrs": ["100.101.102.103:47428"],
      "token": "…"
    },
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

- The link runs inside the user's tailnet, which encrypts it, and the central host checks the device token as it does for phones (X39). A worker connects only to the addresses in `link.json`.
- The token lets anyone holding it act as this Mac on the central host. It is stored only in `link.json` (mode 0600) and the app's host list, and `link.get` never returns it.
- Linking makes the worker a daemon that answers the central host's requests. In this slice the only such request is `worker.ping`. Routed commands come later, with their own checks on the worker.
- Normalizing removes credentials from origin URLs before anything is stored or sent.
- A paired device can say `moonletd-worker` in its hello and register a worker id it knows. That is no new power: a paired device, phone or Mac, can already do everything the app can on the central host (X39).
- On this Mac's Unix socket the `moonlet` CLI is told apart only by the client name it gives, as for phone access (X39). A process running as the user could also edit `link.json` itself, so the socket check guards against mistakes, not against such a process.

## Out of scope

Everything else in [ADR 0009](../adr/0009-central-host-workers-live-copies.md)'s later slices, including:

- the central host setup switch;
- live copies and cloning projects onto a worker ([X60](X60-keep-in-sync.md));
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
  - `moonlet-link`: a `Host` with a request handler answers a daemon's `request` with a `response` carrying the same id, tested against the fake daemon in `crates/moonlet-link/tests/link.rs`. The central host's first request to a worker has id 1.
  - `link.json`:
    - the first load creates a worker id, and later loads return the same id;
    - `link.set` cannot change the id;
    - each invalid `central` (empty name, no addrs, `studio-mini` as an addr, a 10-character token) is rejected and the file is unchanged;
    - the file's mode is 0600, and `link.get` contains no `token`;
    - the name defaults to the given computer name.
  - `moonlet-link`'s backoff sequence for successive failures is 300, 600, 1200, 2400, 4800, 5000, 5000 ms (a test added to `crates/moonlet-link`).
- **Daemon end-to-end, `crates/moonletd/tests/link.rs`:** two `TestDaemon`s with separate `MOONLET_HOME`s. The central host's tailnet listener is on 127.0.0.1 through `MOONLET_MOBILE_ADDRS`, as in `tests/mobile.rs`, and the worker's token comes from pairing with a code from the central host.
  - A linked worker appears in `worker.list` with its literal id, name, `os`, `arch`, `cores`, `version` and project identities. `link.get` says `linked`, and `link.changed` fired.
  - `rtt_ms` is filled in after the first ping.
  - A worker that stops answering pings (process stopped with SIGSTOP) is removed after 3 missed pings. The test uses a shortened ping interval through a test-only setting.
  - Killing the link removes the worker at once and fires `workers.changed`. The worker reconnects after the central daemon restarts.
  - `link.set {enabled: false}` closes the link within 1 s.
  - A fake central host on 127.0.0.1 whose `authed` reports protocol 99 and version `9.9.9` gives `needs_update` with `9.9.9`. No reconnect happens until `link.retry`.
  - Removing the worker's device on the central host gives `refused`. No reconnect happens until `link.retry` or `link.set`.
  - A second link with the same worker id replaces the first. Two workers with the same name and different ids are both listed.
  - `link.set` with one of the worker's own Tailscale addresses (injected through `MOONLET_MOBILE_ADDRS`) in `central.addrs` is rejected.
  - A project whose origin is `https://user:token@github.com/acme/shop.git` shows `github.com/acme/shop` in `project.list`, `project.identity` and `worker.list`, and the text `token` appears in none of them.
  - A daemon started on a `state.json` whose projects have no identity reports identities in `project.list`.
- **Vitest, `apps/desktop/src/lib/`:**
  - the status line text for each link state;
  - choosing a central host moves the choice, so at most one host has it, and choosing it again clears it.
- **e2e, `apps/desktop/e2e/specs/worker-link.e2e.ts`:** the fixture starts a second scratch daemon as the central host, listening on 127.0.0.1, and the app pairs with it. Marking it **Central host** and turning on **Use this Mac for heavy commands** shows "Linked to …". Saving settings is a crucial feature (X12).

## Open questions

None open. Decided on 2026-10-13, and revised for ADR 0011 on 2026-10-20:

- **Workers have an id; the name is only a label.** With names, two Macs both called "MacBook Pro" would keep replacing each other's links.
- **The link is its own connection.** It stays open for days and belongs to the daemon, which keeps running when the app is closed, so it cannot ride on the app's connection.
- **The worker uses the Mac's pairing (2026-10-20).** Pairing the daemon separately would ask the user for a second code for the same Mac. One device per Mac also means one Remove on the central host cuts both.
- **Pings every 10 s, disconnect after 3 misses**, so a closed lid shows within about 30 s.
- **Slice 1 leaves out slots, tool detection, live project updates, the Workers screen and renaming in the UI.** Only routing uses them. A smaller slice lets every criterion have a real test.
