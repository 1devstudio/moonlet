# X63 — Cloud workers: machines made for heavy commands and removed when idle

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0012](../adr/0012-cloud-workers.md) (cloud workers), [0009](../adr/0009-central-host-workers-live-copies.md), [0011](../adr/0011-machines-connect-over-the-tailnet.md)
- **Depends on:** [X62](X62-routed-commands.md) (routing, routing copies, the Workers screen), [X58](X58-linux-install-script.md) (the install script), [X57](X57-tailnet-hosts.md) (pairing), [X61](X61-remote-hosts-for-heavy-commands.md) (`link.pair`).

## Summary

The central host can rent machines from a cloud provider to run heavy commands. It makes one when a project that allows it has more heavy commands than its Macs and the central host can take, or when someone asks for one. It removes the machine once it has had no command for the configured idle time, or as soon as its command ends when the idle time is 0. Hetzner Cloud comes first. Everything specific to a provider sits behind a small adapter, so adding another provider is one module.

A cloud machine is a worker like any other in X62. It runs routed commands in a routing copy, and the agent stays on the central host. It comes up on its own: it joins the tailnet, installs moonlet and pairs with the central host. It holds none of the user's secrets.

## User journey

1. On the MacBook, the user opens Settings › Machines › Cloud workers for `studio-mini`, the central host. They click **Add provider › Hetzner Cloud** and paste an API token for a Hetzner project they made for moonlet. Under **Tailscale**, they paste an OAuth client id and secret with the `auth_keys` scope and the tag `tag:moonlet-worker`. They leave **Remove a machine after [15] minutes idle**, **At most [2] machines** and **[40] machine-hours a month** as they are.
2. In Settings › Projects › shop (studio-mini), under **Cloud workers**, they turn on **Use cloud machines when every worker is busy**. They pick machine type `cpx41`, location `fsn1` and image `ubuntu-24.04`. `shop`'s config has `[heavy] machine_setup = "scripts/ci-deps.sh"`, which installs Node and pnpm.
3. Two agents run test suites while the MacBook's lid is closed and `studio-mini` is busy. The command runs on `studio-mini`, and moonlet starts `moonlet-shop-7k2q` at Hetzner. The Workers screen shows it as "Starting · 0:40".
4. About two minutes later it reads "Ready". The next `pnpm test` runs there, and the chat chip reads **on moonlet-shop-7k2q**.
5. Fifteen minutes pass with no heavy command. The machine is removed. The Workers screen keeps a line "moonlet-shop-7k2q removed after 15 min idle" for an hour, and the Cloud workers page reads "0.6 of 40 machine-hours this month".
6. For a session with a big refactor, the user ticks **Run heavy commands in the cloud** in the new-session composer. Its first `pnpm test` waits, with "moonlet: waiting for moonlet-shop-m3x9 to start (1:10)", then runs there.
7. The agent in another session runs `moonlet worker up` to warm a machine before a long build. It counts against the same limits.
8. The user sets the idle time to 0. The next machine is removed as soon as its command ends.

## Behaviour and acceptance criteria

### Providers

- [ ] A provider is an adapter with five operations:
  - `machine_types(location)` returns `[{name, cores, memory_gb, arch}]`;
  - `create({name, type, location, image, user_data, labels})` returns `{id}`;
  - `get(id)` returns `{state: starting | running | gone, ipv4}`;
  - `list(labels)` returns `[{id, name, labels, created_at}]`;
  - `destroy(id)` is done when the provider says the machine is gone.

  Nothing else knows the provider. Each adapter describes its settings fields: names, which are secret, and help text. The settings form is built from that description.
- [ ] **Hetzner Cloud** calls `https://api.hetzner.cloud/v1` with `Authorization: Bearer <token>`:
  - create: `POST /servers` with `name`, `server_type`, `image`, `location`, `user_data`, `labels` and `start_after_create: true`;
  - `GET /servers/{id}`;
  - `GET /servers?label_selector=moonlet-host=<host id>`;
  - `DELETE /servers/{id}`;
  - `GET /server_types`.

  A 404 on get or delete means `gone`. Responses are parsed from captured real responses.
- [ ] Provider errors:
  - 401 or 403: "Hetzner refused the token. Check it in Settings › Cloud workers.";
  - 429: retried after the provider's reset time, or 5 s;
  - other errors: shown with the provider's message.

  No error is retried forever without the user seeing it: the Cloud workers page shows the last error with its time.
- [ ] **A fake provider for tests**, enabled only by `MOONLET_CLOUD_FAKE=<dir>`, "creates" a machine by starting a scratch `moonletd` that runs the same join steps. "Destroy" stops it. It is the only provider that daemon and e2e tests use.

### Making a machine

- [ ] A machine is made for one project, with the project's provider, type, location and image. Its name is `moonlet-<project>-<4 random lowercase letters and digits>`, cut to the provider's length limit. Its labels are `moonlet-host=<host id>`, `moonlet-machine=<machine id>` and `moonlet-project=<first 12 hex of sha256 of the identity>`. `host id` is a random id that the central host makes once and keeps in `cloud.json`, so two central hosts sharing a provider project never touch each other's machines.
- [ ] The machine is recorded in `$MOONLET_HOME/cloud/machines.json` as `creating` before the create call, so a crash between the two is caught by the sweep.
- [ ] Its `user_data` is a cloud-init script that:
  1. makes the user `moonlet`;
  2. installs Tailscale and runs `tailscale up --auth-key=<key> --hostname=<name>`;
  3. runs the X58 install script of the central host's exact version, as `moonlet`, with `--no-pair --no-listen`;
  4. runs the project's `[heavy] machine_setup`, as root;
  5. runs `moonletd join <central host addresses> <code> --name <name>` as `moonlet`.

  The rendered script for a fixed input equals a literal in the test.
- [ ] The Tailscale key is minted for each machine with the user's OAuth client: one-off, ephemeral, preauthorized, tagged with the configured tag, expiring in 1 hour. The OAuth secret never leaves the central host.
- [ ] `machine_setup` is a path in the repository, read from the session's worktree when the machine is made and embedded in `user_data`. A script over 16 KiB, or a path outside the worktree, fails with that reason, and no machine is made.
- [ ] **Joining:**
  - The central host makes a **join code** for the machine: one use, valid 30 minutes, bound to the machine id, device kind `cloud`.
  - `moonletd join` does what X61's `link.pair` does, with device kind `cloud`, then turns the link on (`enabled: true`). The token stays on the machine.
  - A join code used twice, after 30 minutes, or for another machine id is refused.
- [ ] A machine is **ready** once its worker has registered, its routing copy of the triggering session is made, and the project's `setup` has finished. A cloud machine runs `setup` without asking for approval. It holds none of the user's secrets.
- [ ] A cloud machine gets the project from the central host (X60's `sync.fetch`, with nothing in `have`), never from origin.
- [ ] A machine not ready 15 minutes after the create call is removed, with "moonlet-shop-7k2q did not come up in 15 minutes", plus the last state the provider or the worker reported.

### When a machine is made

- [ ] **Overflow.** When X62 finds no free worker for a command of a project with **Use cloud machines when every worker is busy** on, the central host starts a machine for that project. It does not start one if one is already starting for the project, or if a limit would be passed. The command runs on the central host.
- [ ] **A session that asked for the cloud.** The composer checkbox **Run heavy commands in the cloud** (`cloud: true` on the session) sends its routed commands to the project's ready cloud machine first. When there is none, the command starts one and waits for it. Every 10 s it prints "moonlet: waiting for moonlet-shop-m3x9 to start (1:10)". If the machine fails or a limit is reached, the command runs on the central host with "moonlet: no cloud machine (<reason>). Running on studio-mini."
- [ ] **`moonlet worker up [--project <name>]`** (the session's project by default) starts a machine and prints its name. `moonlet worker ls` lists the machines, and `moonlet worker down <name>` removes one, after its running commands end. Agents may use these. Only the limits bound them.
- [ ] **Start a machine** on the project page does what `moonlet worker up` does.

### Idle time and removal

- [ ] **Remove a machine after [N] minutes idle** takes 0 to 1440 and defaults to 15. A machine is idle while no routed command runs on it. It is removed after N minutes of continuous idleness, counted from ready or from its last command's end. With 0 it is removed when its last running command ends, or as soon as it is ready if nothing is waiting for it. Worked examples, with N = 15:

  | Events | Removed at |
  |---|---|
  | ready 10:00, nothing runs | 10:15 |
  | ready 10:00, command 10:05–10:12 | 10:27 |
  | ready 10:00, commands 10:05–10:20 and 10:10–10:30 | 10:45 |
  | N = 0, ready 10:00, command 10:01–10:04 | 10:04 |
  | N = 0, `worker up` ready 10:00, nothing waiting | 10:00 |

- [ ] **Removing:**
  1. The machine leaves the candidates.
  2. The central host revokes its device token.
  3. It asks the worker to `worker.retire`, which runs `tailscale logout` and answers within 10 s.
  4. It calls `destroy`, retrying with backoff from 300 ms, doubling, up to 5 minutes, until the provider says the machine is gone.

  After 3 failed attempts, the app shows a notification: "Could not remove moonlet-shop-7k2q at Hetzner: <error>. It is billed until removed." It has **Retry**.
- [ ] A machine whose link has been down for 10 minutes is removed.
- [ ] **The sweep.** At start, and every 10 minutes, the central host lists the provider's machines labelled with its host id. It destroys every machine with no record, or with a record that says `removing` or `removed`, and it drops records of machines the provider says are gone. Worked example: records {A ready, B removing}, provider {A, B, C} → destroy B and C, keep A.
- [ ] Turning off a project's cloud setting removes its machines once their running commands end. Removing a provider removes all its machines first, and the setting stays until they are gone.
- [ ] Archiving a session removes no machine by itself. The idle time applies.

### Limits

- [ ] **At most [N] machines** (default 2) counts machines that are starting, ready or removing. **[H] machine-hours a month** (default 40) counts, for each machine, the time from the create call to the confirmed removal, in the current calendar month (UTC). The Cloud workers page shows "12.5 of 40 machine-hours this month".
- [ ] At a limit, no machine is made. Overflow is skipped, and a requested machine fails with "Cloud limit reached: 40 of 40 machine-hours this month". Running machines keep their idle time.
- [ ] Tokens, the OAuth client and the limits change only from the Mac's app or a paired desktop. `cloud.set` from the `moonlet` CLI or a phone is refused with `forbidden`. The `moonlet` CLI may call `cloud.up`, `cloud.down` and `cloud.machines`.

### What a cloud machine may do

- [ ] A device of kind `cloud` may call only `worker.register`, `sync.open`, `sync.fetch`, `sync.offer`, `sync.close` (for its own routing copies) and the worker's side of `exec.*`. Anything else is refused with `forbidden`, so a compromised machine cannot open terminals, read sessions or change settings on the central host.
- [ ] A cloud device never shows in the paired-device list as a phone or desktop. It is listed under its machine, and it goes away when the machine is removed.

## UI

- **Settings › Machines › Cloud workers** (central host page):
  - **Providers:** **Add provider** (Hetzner Cloud), and each provider's fields from its adapter description, with secrets shown as "saved" and a **Replace** button.
  - **Tailscale:** OAuth client id, secret and tag. The help text includes an ACL snippet that lets the tag reach only the central host's port 47428.
  - **Idle time, machine limit, monthly hours,** and the usage line.
  - The last provider error, with its time.
- **Project page, Cloud workers:**
  - the overflow toggle;
  - provider, machine type (from `machine_types`), location and image;
  - `machine_setup` as read from the config;
  - **Start a machine**.
- **Workers screen (X62):** cloud machines with their state:
  - "Starting · 0:40";
  - "Ready";
  - "Running 2";
  - "Idle · removed in 12 min";
  - "Removing";
  - "Could not remove: <error>", with **Retry**.
- **Composer (X54):** **Run heavy commands in the cloud**, shown when the project has a cloud setting.

## Protocol and RPCs

- `cloud.get` returns the settings, with `has_token: true` in place of each secret.
- `cloud.set` updates the settings. It needs the app or a paired desktop.
- `cloud.types {provider, location}`.
- `cloud.machines` returns `[{id, name, project, state, since, error}]`, and the event `cloud.changed` fires on changes.
- `cloud.up {project, session?}` returns the machine. `cloud.down {machine}`.
- Central host to worker: `worker.retire`.
- Pairing: a join code is accepted by X57's pairing step, as X61's `link.pair` uses it, with `kind: "cloud"` and the machine id.
- New command `moonletd join <addrs> <code> --name <name>`.
- New CLI commands `moonlet worker up|ls|down`.
- `scripts/install.sh` gains `--no-listen`.
- `Session` gains `cloud: bool`, and `session.new` takes it.
- `PROTOCOL_VERSION` is raised once with X62, as both ship in one release.

## Data and config

- **`$MOONLET_HOME/cloud.json`, mode 0600 (central host):**

  ```json
  {
    "host_id": "c3f1a9e2b7d04c55",
    "providers": { "hetzner": { "token": "…" } },
    "tailscale": { "client_id": "…", "client_secret": "…", "tag": "tag:moonlet-worker" },
    "idle_minutes": 15,
    "max_machines": 2,
    "max_hours_month": 40,
    "projects": {
      "github.com/acme/shop 4171b03ff0d2bd434751f17bc9d34da784f97e72": {
        "overflow": true, "provider": "hetzner", "type": "cpx41",
        "location": "fsn1", "image": "ubuntu-24.04"
      }
    }
  }
  ```

- **`$MOONLET_HOME/cloud/machines.json`:** each machine's id, provider id, name, project, state, times and last error.
- **`$MOONLET_HOME/cloud/usage.json`:** machine-seconds per month.
- **`.moonlet/config.toml`:** `[heavy] machine_setup`, a repository path.
- **`mobile.json`:** devices gain kind `cloud` and `machine`.

## Security considerations

- **The provider token** can create and delete anything in its provider project. It is stored only in `cloud.json` (mode 0600) on the central host, never returned by `cloud.get`, and never written to logs or `user_data`. The UI recommends a dedicated provider project.
- **The Tailscale OAuth secret** stays on the central host. A machine gets a one-off key that expires within an hour and is tagged. An untagged or unrestricted tag would let a machine reach the whole tailnet, so the help text gives an ACL that limits the tag to the central host's listener.
- **`user_data` is readable** through the provider's API and from inside the machine. It holds the one-off Tailscale key and the join code: each is usable once, expires within an hour, and the join code is bound to its machine.
- **What a machine holds:** the project's files and history from the central host, including untracked files that are not ignored. It never gets `.env` or the other never-synced files (X60), git credentials, or the user's tokens. Variables in `[heavy] env` do reach it (X62), and the project page warns about secret-looking ones.
- **`machine_setup` runs as root** with content the agent can edit, but only on a fresh, disposable machine with no user secrets.
- **A compromised machine** holds a `cloud` device token that reaches only worker methods for its own routing copies. Removing the machine revokes it.
- **Join codes are minted by the central host for machines it creates, and nothing else.** No RPC makes one on request, so X61's rule stands: a paired Mac cannot add devices to the central host.
- **Spending** is bounded by the machine and monthly limits, which agents cannot change. The sweep removes labelled machines that the central host has lost track of.

## Out of scope

- Providers other than Hetzner. The adapter is the extension point.
- Whole sessions or agents on cloud machines (ADR 0012 rejected this).
- Prices in the UI, spot or preemptible machines, GPUs, snapshots or custom images made by moonlet (a provider image id typed in **image** works).
- Several projects sharing one machine.
- Takeover (ADR 0009's last slice).

## Test plan

- **Unit, `crates/moonlet-cloud`:**
  - the Hetzner adapter against captured `POST /servers`, `GET /servers/{id}`, `GET /servers?label_selector=…`, `DELETE`, `GET /server_types`, 401 and 429 responses (captured once with a sandbox token, sanitised);
  - the cloud-init rendering against a literal;
  - machine names (characters, length limit);
  - the idle timer against every row of its table;
  - the sweep decision against its worked example and against a record of a machine the provider says is gone;
  - the limits: a fourth machine with `max_machines` 3, hours crossing a month boundary.
- **Daemon end-to-end, `crates/moonletd/tests/cloud.rs`,** with the fake provider:
  - overflow starts a machine while the command runs on the central host, and the next command runs on the machine;
  - a session with `cloud: true` waits for the machine and runs there;
  - idle removal with a shortened minute (test-only setting), and idle 0;
  - a machine that never joins is removed at the deadline;
  - a recorded machine missing from records after a restart is swept;
  - a dropped link removes the machine after the (shortened) 10 minutes;
  - a limit refuses `cloud.up` with the message;
  - a `cloud` device calling `session.list` gets `forbidden`;
  - a reused join code is refused;
  - `cloud.set` from the CLI is `forbidden`, and `cloud.get` has no secrets.
- **Vitest, `apps/desktop/src/lib/`:**
  - the settings form built from an adapter description;
  - the machine state lines;
  - the usage line;
  - the composer checkbox's visibility.
- **e2e, `apps/desktop/e2e/specs/cloud-workers.e2e.ts`,** with the fake provider:
  - saving the Cloud workers settings (crucial: saving settings, X12);
  - **Start a machine** shows "Starting", then "Ready", on the Workers screen.
- **Manual, once before release:** a real Hetzner machine runs `pnpm test` for `shop` and is removed after the idle time, and the Hetzner console shows no machine left.

## Open questions

- **Hetzner's billing step** (per started hour or finer) decides whether a short idle time saves money. Check it against Hetzner's current pricing page before release. The default stays 15 minutes either way.
- **Big histories.** A fresh machine fetches the whole history from the central host. A shallow fetch would be faster, but X60's packs assume full history.
- **The Tailscale key API's field names** (`capabilities.devices.create.ephemeral`, `preauthorized`, `tags`, `expirySeconds`) are to be confirmed against a captured response when the adapter is built.

Decided by the user on 2026-10-22:

- cloud machines run routed commands only;
- Hetzner first, with providers easy to add;
- the idle time is configurable, and 0 removes a machine as soon as its command ends;
- machines are made both on overflow and on request.
