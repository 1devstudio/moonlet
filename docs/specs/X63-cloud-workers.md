# X63 — Cloud workers: machines made for heavy commands and removed when idle

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0012](../adr/0012-cloud-workers.md) (cloud workers), [0009](../adr/0009-central-host-workers-live-copies.md), [0011](../adr/0011-machines-connect-over-the-tailnet.md)
- **Depends on:** [X62](X62-routed-commands.md) (routing, routing copies, the Workers screen), [X58](X58-linux-install-script.md) (the install script), [X57](X57-tailnet-hosts.md) (pairing), [X61](X61-remote-hosts-for-heavy-commands.md) (`link.pair`).

## Summary

The central host can rent machines from a cloud provider to run heavy commands. It makes one when a project that allows it has more heavy commands than its Macs and the central host can take, or when someone asks for one. It removes the machine once it has had no command for the configured idle time, or as soon as its command ends when the idle time is 0. Hetzner Cloud comes first. Everything specific to a provider sits behind a small adapter, so adding another provider is one module.

The screens are in [`design/x62-x63/`](design/x62-x63/), from the design review of PR #339.

A cloud machine is a worker like any other in X62. It runs routed commands in a routing copy, and the agent stays on the central host. It comes up on its own: it joins the tailnet, installs moonlet and pairs with the central host. It never gets the user's git credentials, provider token or Tailscale secret. It does get the project's files, including untracked files that are not ignored, and the variables the user approved in `[heavy] env` (see Security considerations).

## User journey

1. On the MacBook, the user opens Settings › Machines › Cloud workers for `studio-mini`, the central host. They click **Add provider › Hetzner Cloud** and paste an API token for a Hetzner project they made for moonlet. Under **Tailscale**, they paste an OAuth client id and secret with the `auth_keys` scope and the tag `tag:moonlet-worker`. They leave **Remove a machine after [15] minutes idle**, **At most [2] machines** and **[40] machine-hours a month** as they are.
2. In Settings › Projects › shop (studio-mini), under **Cloud workers**, they turn on **Use cloud machines when every worker is busy**. They pick machine type `cpx41`, location `fsn1` and image `ubuntu-24.04`. `shop`'s config has `[heavy] machine_setup = "scripts/ci-deps.sh"`, which installs Node and pnpm.
3. Two agents run test suites while the MacBook's lid is closed and `studio-mini` is busy. The command runs on `studio-mini`, and moonlet starts `moonlet-shop-7k2q` at Hetzner. The Workers screen shows it as "Starting · 0:40".
4. About two minutes later it reads "Ready". The next `pnpm test` runs there, and the chat chip reads **on moonlet-shop-7k2q**.
5. Fifteen minutes pass with no heavy command. The machine is removed. The Workers screen keeps a line "moonlet-shop-7k2q removed after 15 min idle" for an hour, and the Cloud workers page reads "0.6 of 40 machine-hours this month".
6. For a session with a big refactor, the user ticks **Run heavy commands in the cloud** in the new-session composer. Its first `pnpm build` waits, with "moonlet: waiting for moonlet-shop-m3x9 to start (1:10)". In the session's Jobs tab (X62), the job shows the machine's startup checklist: "Created at Hetzner 0:04", "Joined your tailnet 0:31", "Installed moonlet 0.1.29 0:52", "Paired with studio-mini", then "Machine setup scripts/ci-deps.sh" running, and "Removed if it isn't ready by 10:59." The user could click **Run on studio-mini now**, but waits, and the build runs on the machine.
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
- [ ] The machine is recorded in `$MOONLET_HOME/cloud/machines.json` as `creating` before the create call, so a crash between the two is caught by the sweep. The limit check and the `creating` record are one step under one lock, so two `cloud.up` calls at once never pass the machine limit. Worked example: limit 2, one machine ready, two `cloud.up` calls at once → one machine is made, and the other call fails with "Cloud limit reached: 2 of 2 machines".
- [ ] Its `user_data` is a cloud-init script that:
  1. makes the user `moonlet`;
  2. installs Tailscale and runs `tailscale up --auth-key=<key> --hostname=<name>`;
  3. runs the X58 install script of the central host's exact version, as `moonlet`, with `--no-pair --no-listen`;
  4. runs `moonletd join <central host addresses> <code> --name <name>` as `moonlet`;
  5. runs the project's `[heavy] machine_setup` as root. Its output goes to `/var/log/moonlet/machine-setup.log`, and its start and exit status to `/var/lib/moonlet/machine-setup.json`, which the worker reports.

  The machine pairs before its setup runs, so the central host can show the setup's progress.

  The rendered script for a fixed input equals a literal in the test.
- [ ] The Tailscale key is minted for each machine with the user's OAuth client: one-off, ephemeral, preauthorized, tagged with the configured tag, expiring in 1 hour. The OAuth secret never leaves the central host.
- [ ] `machine_setup` is a path in the repository. It is read when the machine is made, and embedded in `user_data`. It is read from the worktree of the session the machine is made for, or, for a machine made without a session (`moonlet worker up` without `--session`, **Start a machine**), from the project's own folder on the central host. A script over 16 KiB, a path outside that folder (including through a symbolic link), or a missing file fails with that reason, and no machine is made.
- [ ] **Joining:**
  - The central host makes a **join code** for the machine: one use, valid 30 minutes, bound to the machine id, device kind `cloud`.
  - `moonletd join` does what X61's `link.pair` does, with device kind `cloud`, then turns the link on (`enabled: true`). The token stays on the machine.
  - A join code used twice, after 30 minutes, or for another machine id is refused.
- [ ] A machine is **ready** once its worker has registered and its machine setup has finished. A machine made for a session (overflow from it, or a session that asked for the cloud) also makes that session's routing copy and runs the project's `setup` before it is ready. A machine made without a session makes a session's routing copy when that session first routes a command to it, and the job waits with "Copying fix-cart to moonlet-shop-7k2q…". A cloud machine runs `setup` without asking for approval: the machine holds no git credentials or user tokens to protect.
- [ ] A cloud machine gets the project from the central host (X60's `sync.fetch`, with nothing in `have`), never from origin.
- [ ] **Startup steps.** A starting machine reports these steps, each `pending`, `running`, `done {took}` or `failed {error}`:

  | Step | Known from |
  |---|---|
  | Created at Hetzner | the create call's answer |
  | Joined your tailnet | the central host's `tailscale status --json` listing a peer with the machine's host name |
  | Installed moonlet 0.1.29 | the join |
  | Paired with studio-mini | the join |
  | Machine setup `scripts/ci-deps.sh` | the worker, from `machine-setup.json` |
  | Copied fix-cart and ran `pnpm install` | the worker's routing copy and setup (X62); only for a machine made for a session |

  A machine without `machine_setup` skips that step. A failed step fails the machine: it is removed, and the error stays on the Workers screen.
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

  After 3 failed attempts, the app shows a toast and a system notification: "Could not remove moonlet-shop-x81c at Hetzner: 503 Service Unavailable. It is billed until removed." Both have **Retry**. The machine's row and the provider's card show the error with "Last error at 10:14 · retrying since 10:09", and the Cloud workers entry in the settings nav gets a dot until the machine is gone.
- [ ] **Remove now**, on an idle machine, removes it at once. On a machine with running commands, `cloud.down` waits for them to end, as `moonlet worker down` does.
- [ ] A machine whose link has been down for 10 minutes is removed.
- [ ] **The sweep.** At start, and every 10 minutes, the central host lists the provider's machines labelled with its host id. It destroys every machine with no record, or with a record that says `removing` or `removed`, and it drops records of machines the provider says are gone. A record still `creating` with no create call in progress (the daemon restarted during it, or the call has run for more than 5 minutes) is reconciled: its machine, found by its `moonlet-machine` label, is destroyed, and the record is dropped once the provider has none. Worked examples:

  | Records | Provider lists | Outcome |
  |---|---|---|
  | A ready, B removing | A, B, C | destroy B and C, keep A |
  | D creating (no call in progress) | D | destroy D, then drop its record |
  | D creating (no call in progress) | nothing | drop D's record |
  | E creating (call in progress, 40 s) | E | keep E |
  | F ready | nothing | drop F's record |
- [ ] Turning off a project's cloud setting removes its machines once their running commands end. Removing a provider removes all its machines first, and the setting stays until they are gone.
- [ ] Archiving a session removes no machine by itself. The idle time applies.

### Limits

- [ ] **At most [N] machines** (default 2) counts machines that are creating, starting, ready or removing. **[H] machine-hours a month** (default 40) counts, for each machine, the time from the create call to the confirmed removal, in the current calendar month (UTC). The Cloud workers page shows "12.5 of 40 machine-hours this month".
- [ ] At a limit, no machine is made. Overflow is skipped, and a requested machine fails with "Cloud limit reached: 40 of 40 machine-hours this month". Running machines keep their idle time.
- [ ] Tokens, the OAuth client and the limits change only from the Mac's app or a paired desktop. `cloud.set` from the `moonlet` CLI or a phone is refused with `forbidden`. The `moonlet` CLI may call `cloud.up`, `cloud.down` and `cloud.machines`.

### What a cloud machine may do

- [ ] A device of kind `cloud` may call only `worker.register`, `sync.open`, `sync.fetch`, `sync.offer`, `sync.close` (for its own routing copies) and the worker's side of `exec.*`. Anything else is refused with `forbidden`, so a compromised machine cannot open terminals, read sessions or change settings on the central host.
- [ ] A cloud device never shows in the paired-device list as a phone or desktop. It is listed under its machine, and it goes away when the machine is removed.

## UI

The screens are in [`design/x62-x63/`](design/x62-x63/). Where this section and a screen differ, this section wins and the difference is listed under Open questions.

- **Settings › Machines › Cloud workers** ([cloud-workers-page.png](design/x62-x63/cloud-workers-page.png)), a page of the central host: the title with a "studio-mini · Central host" badge, and "studio-mini rents machines for heavy commands when its workers are busy, and removes them once they sit idle. A cloud machine only runs commands: agents and sessions stay on studio-mini." Then:
  - **Providers:** one card per provider. The card has the provider's name, a status line ("4 machines · used by shop") and **Remove**, then the adapter's fields. Secrets show "Saved" with **Replace**, and the token's help text is "It can create and delete anything in its Hetzner project, so use a project made for moonlet." A removal error row, in the error colour, has **Retry**. Under the cards: **Add provider** and "Hetzner Cloud is the only provider so far."
  - **Tailscale:** "Each machine joins your tailnet with a one-off key that studio-mini makes from this OAuth client. The secret never leaves studio-mini." The fields are OAuth client ID ("Needs the auth_keys scope and the tag below."), the secret (Saved / Replace) and Tag ("Every cloud machine gets it."). Then the policy snippet, with a copy button, filled in with the tag and the central host's Tailscale address:

    ```json
    "tagOwners": { "tag:moonlet-worker": ["autogroup:admin"] },
    "acls": [
      { "action": "accept", "src": ["tag:moonlet-worker"], "dst": ["100.101.102.103:47428"] }
    ]
    ```

  - **Idle time and limits:** "Agents can start machines with moonlet worker up, but only you can change these." The rows are "Remove a machine after [15] minutes idle" ("With 0, a machine goes as soon as its command ends."), "At most [2] machines" ("Counts machines that are being created, starting, ready or being removed.") and "Monthly limit [40] machine-hours" ("From each create call to its confirmed removal, per calendar month (UTC)."), with a usage bar and "12.5 of 40 machine-hours this month".
  - A save bar: "~/.moonlet/cloud.json on studio-mini", "Unsaved changes", **Discard** and **Save** (⌘↵).
- **Project page, Cloud workers** ([project-page.png](design/x62-x63/project-page.png)): "Machines studio-mini rents to run shop's heavy commands. Tokens and limits are in Settings › Machines › Cloud workers." Then:
  - **Use cloud machines when every worker is busy** ("The command still runs on studio-mini. A machine starts and takes the next one.");
  - **Provider**;
  - **Machine type**, from `machine_types`, shown as "cpx41 · 8 cores · 16 GB · x86";
  - **Location**;
  - **Image** ("An image name, or the id of an image in your provider project.");
  - **Machine setup**, read-only from `[heavy] machine_setup` ("Runs as root on each new machine, after moonlet pairs it.");
  - a footer, "4 machines for shop · 2 running commands · Workers", with **Start a machine**.
- **Workers page, Cloud machines** ([workers-page.png](design/x62-x63/workers-page.png)): the line "4 of 4 machines: at the limit, so no new one starts · 12.5 of 40 machine-hours this month · Cloud workers settings". Each machine's row has the X62 columns and one of these state lines:
  - "Running 2 · Hetzner cpx41 · fsn1 · shop", with its jobs under it;
  - "Starting · 0:40 · for big-refactor, which asked for the cloud";
  - "Idle · removed in 12 min", with **Remove now**;
  - "Removing";
  - "Could not remove: Hetzner answered 503 Service Unavailable. Billed until removed.", with **Retry**.

  Machines removed in the last hour stay as one line each: "moonlet-shop-4hn0 removed after 15 min idle · 10:42".
- **Job waiting for a cloud machine (X62's Jobs tab)** ([job-waiting-for-cloud.png](design/x62-x63/job-waiting-for-cloud.png)): the state line "Waiting for a cloud machine · 1:10 · Claude in fix-cart", "fix-cart runs its heavy commands in the cloud, so this one waits for its machine instead of running on studio-mini.", the machine card with its startup steps, their times, and "Removed if it isn't ready by 10:59.", and **Run on studio-mini now** and **Stop**.
- **Composer (X54)** ([composer-cloud.png](design/x62-x63/composer-cloud.png)): **Run heavy commands in the cloud** in the branch row, after **Keep in sync with this Mac**, shown when the project has a cloud setting. Its tooltip is "Routed commands go to shop's cloud machine first. When none is ready, a command starts one and waits for it."
- **Toast** ([toasts.png](design/x62-x63/toasts.png)): a removal failure, with **Retry**, in the error colour.

## Protocol and RPCs

- `cloud.get` returns the settings, with `has_token: true` in place of each secret.
- `cloud.set` updates the settings. It needs the app or a paired desktop.
- `cloud.types {provider, location}`.
- `cloud.machines` returns `[{id, name, project, provider, type, location, state, since, steps: [{step, state, took}], deadline, idle_until, for_session, error, error_since}]` and the removed machines of the last hour, and the event `cloud.changed` fires on changes.
- `cloud.up {project, session?}` returns the machine. `cloud.down {machine}` removes an idle machine at once, or a busy one once its commands end.
- Worker to central host: `worker.step {step, state, took}`, for the machine setup step and the routing copy's setup.
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
- **What a machine holds:** the project's files and history from the central host, including untracked files that are not ignored, and the variables named in `[heavy] env`. Those reach a cloud machine only after the user has approved the exact names (X62), and the approval banner names secret-looking ones. A machine never gets `.env` or the other never-synced files (X60), git credentials, the provider token or the Tailscale secret. A project that must keep a file away from cloud machines ignores it in git.
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

Every acceptance criterion maps to at least one test below. The names are the ones the implementing pull requests use, word for word. A pull request that renames a test updates this table. Expected values are literals from this spec or from captured real responses.

Where the tests live:

- **Rust unit tests:** in the new crate `crates/moonlet-cloud`, in `hetzner.rs`, `tailscale.rs`, `cloud_init.rs`, `machine.rs`, `idle.rs`, `sweep.rs` and `usage.rs`, each in its `#[cfg(test)] mod tests`. Hetzner and Tailscale responses are captured once with a sandbox token and sanitised.
- **Daemon end-to-end:** `crates/moonletd/tests/cloud.rs`, with the fake provider and test-only settings for minutes and deadlines.
- **CLI end-to-end:** `crates/moonlet-cli/tests/worker.rs`.
- **Vitest:** `apps/desktop/src/lib/cloudSettings.test.ts` and `cloudMachines.test.ts`.
- **e2e:** `apps/desktop/e2e/specs/cloud-workers.e2e.ts`, with the fake provider.

| Criterion | Tests |
|---|---|
| The adapter and its settings description | Vitest "the form from an adapter's description" |
| Hetzner calls | `creates_a_server_as_in_the_captured_request`, `reads_a_captured_server`, `lists_servers_by_label`, `a_404_means_gone`, `reads_captured_server_types` |
| Provider errors | `a_401_says_the_token_was_refused`, `a_429_waits_for_the_reset_time`; Vitest "the last provider error with its time" |
| The fake provider | `the_fake_provider_is_off_without_its_setting` |
| Name and labels | `names_fit_the_providers_limit_and_characters`, `labels_carry_the_host_machine_and_project` |
| Recorded before creating, limit under a lock | `a_machine_is_recorded_before_the_create_call`, `two_cloud_up_calls_at_once_never_pass_the_limit` |
| `user_data` | `renders_the_worked_cloud_init_script` |
| The Tailscale key | `asks_for_a_one_off_ephemeral_tagged_key_as_captured` |
| `machine_setup` | `machine_setup_comes_from_the_sessions_worktree`, `machine_setup_without_a_session_comes_from_the_projects_folder`, `a_machine_setup_over_16_kib_makes_no_machine`, `a_machine_setup_outside_the_folder_makes_no_machine`, `a_missing_machine_setup_makes_no_machine` |
| Joining | `a_join_code_works_once`, `an_expired_join_code_is_refused`, `a_join_code_for_another_machine_is_refused` |
| Ready | `a_machine_made_for_a_session_is_ready_with_its_copy_and_setup`, `a_machine_made_without_a_session_copies_on_its_first_command` |
| The project comes from the central host | `a_cloud_machine_never_contacts_origin` |
| Startup steps | `startup_steps_arrive_in_order_with_durations`, `a_failing_machine_setup_fails_and_removes_the_machine`; Vitest "the startup checklist" |
| Startup deadline | `a_machine_that_never_joins_is_removed_at_the_deadline` |
| Overflow | `overflow_starts_a_machine_and_the_next_command_runs_there` |
| A session that asked for the cloud | `a_cloud_session_waits_for_its_machine_and_runs_there`, `a_cloud_session_runs_on_the_central_host_when_no_machine_can_start` |
| `moonlet worker up`, `ls`, `down` | `worker_up_ls_and_down` |
| Start a machine | e2e "Start a machine shows Starting, then Ready" |
| Idle time (worked examples) | `removes_at_the_times_in_the_worked_examples`, `an_idle_machine_is_removed_after_the_idle_time`, `with_idle_zero_a_machine_goes_when_its_command_ends` |
| Removing | `removing_revokes_the_device_retires_and_destroys`, `a_failing_destroy_is_retried_and_reported_after_three_tries`; Vitest "the removal toast" |
| Remove now | `remove_now_removes_an_idle_machine_at_once`, `cloud_down_waits_for_running_commands` |
| A link down for 10 minutes | `a_machine_whose_link_stays_down_is_removed` |
| The sweep (worked examples) | `sweeps_as_in_the_worked_examples`, `a_machine_left_creating_by_a_restart_is_destroyed` |
| Turning off, removing a provider | `turning_a_projects_cloud_off_removes_its_machines_after_their_commands`, `removing_a_provider_removes_its_machines_first` |
| Archiving | `archiving_a_session_leaves_its_machine_to_the_idle_time` |
| What the limits count | `a_creating_machine_counts_against_the_limit`, `counts_machine_hours_across_a_month_boundary` |
| At a limit | `a_limit_refuses_cloud_up_with_the_message` |
| Who changes the settings | `cloud_set_from_the_cli_or_a_phone_is_forbidden`, `cloud_get_returns_no_secrets` |
| A cloud device's methods | `a_cloud_device_may_call_only_worker_methods` |
| Cloud devices in the device list | `a_cloud_device_goes_away_with_its_machine` |
| Cloud workers page (UI) | Vitest "the policy snippet with the tag and address", "the usage line"; e2e "saving the Cloud workers settings" |
| Workers page, cloud machines (UI) | Vitest "the machine state lines" |
| Composer (UI) | Vitest "the cloud checkbox shows only with a cloud setting" |

**Manual, once before release:** a real Hetzner machine runs `pnpm test` for `shop` and is removed after the idle time, and the Hetzner console shows no machine left.

## Open questions

- **Differences from the design:**
  - the design's checklist puts **Paired with studio-mini** after **Machine setup**. This spec pairs first, because the machine can report nothing before it pairs;
  - the design's policy snippet uses `"dst": ["studio-mini:47428"]`. A Tailscale policy takes a bare machine name only when it is defined under `hosts`, so the snippet uses the central host's Tailscale address;
  - the design shows "At most 4 machines". The default stays 2, and 4 is the example's own setting.

- **Hetzner's billing step** (per started hour or finer) decides whether a short idle time saves money. Check it against Hetzner's current pricing page before release. The default stays 15 minutes either way.
- **Big histories.** A fresh machine fetches the whole history from the central host. A shallow fetch would be faster, but X60's packs assume full history.
- **The Tailscale key API's field names** (`capabilities.devices.create.ephemeral`, `preauthorized`, `tags`, `expirySeconds`) are to be confirmed against a captured response when the adapter is built.

Decided by the user on 2026-10-22:

- cloud machines run routed commands only;
- Hetzner first, with providers easy to add;
- the idle time is configurable, and 0 removes a machine as soon as its command ends;
- machines are made both on overflow and on request.
