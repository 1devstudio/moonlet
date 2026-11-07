# X89 — Every host runs heavy commands for every other host

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0009](../adr/0009-central-host-workers-live-copies.md) (routing), [0014](../adr/0014-one-account-across-hosts.md) (one account across hosts), [0015](../adr/0015-sessions-follow-the-user.md) (sessions follow the user), [0012](../adr/0012-cloud-workers.md) (cloud workers)
- **Depends on:** [X62](X62-routed-commands.md) (routed commands), [X90](X90-heavy-commands-in-practice.md) (the project's list, background calls), [X68](X68-account-state.md) (the account state), [X72](X72-session-copies-on-the-central-host.md) (the central host passes requests between members), [X63](X63-cloud-workers.md) (cloud machines)
- **Changes:** X62's "Only Bash calls of Claude Code agents in sessions on the central host are routed", its per-worker approval, and X41/X61's "the central host's row has no switch". Slots and the heavy-commands switch move from each host's `link.json` into the account state.

## Summary

Since ADR 0015, a session's agent runs where the user works, usually the MacBook. But X62 routes only the central host's sessions. When the MacBook is loaded (21.3 / 10 one afternoon) and the central host `studio-mini` sits at 2.6 / 10, the MacBook's `pnpm check` still runs on the MacBook. Its daemon has no workers, so it picks itself.

With this spec, routing works as a mesh. Every member of the account routes its own sessions' heavy commands, and every member can run them for the others. The **session's host** picks the free member with the lowest load, as X62's central host does now, and runs the command there in a routing copy. Its candidates are:

- the central host;
- every other member, through the central host;
- the project's cloud machines;
- itself, when no other machine is free.

For now, members other than the central host reach each other through the central host, which passes the routing messages on. Members already link only to it, and it already passes the phone's requests to session owners (X72). Direct links between members can come later and carry the same messages.

Two settings make a host a worker:

- **Takes heavy commands from other hosts**, off by default;
- **Run at most N at once**, the host's slots, 2 by default.

They are kept in the account state, so the app on any Mac sets them for any member, the central host included, and a member that is offline gets them when it links. The approval of a project's heavy commands moves into the account state too: approved once, the list is approved on every member.

## User journey

The account has three members: the central host `studio-mini`, the MacBook `Alex's MacBook Pro`, and `devbox`, a Linux server linked as a remote host (X61). Project `shop` lists `pnpm check` in `[heavy] commands` in its main checkout on the MacBook (X90).

1. On the MacBook, Settings › Machines › Workers lists all three members. Each row has a **Takes heavy commands from other hosts** switch and a **Run at most [− 2 +] at once** stepper. All three switches are off.
2. The user turns the switch on for `studio-mini` and for `devbox`, and sets `devbox` to 4. A toast reads "studio-mini takes heavy commands from your other hosts". `devbox`'s row reads "Linux · 16 cores · 0 of 4".
3. In Settings › Projects › shop (Alex's MacBook Pro), **Heavy commands** shows `pnpm check` as **Not approved**. The user clicks **Approve**. The toast reads "Approved pnpm check for shop on every host of your account".
4. In session `fix-cart` on the MacBook, the agent runs `pnpm check` in the background (X90). The MacBook is busy and `studio-mini` is free, so the Bash row's chip reads **on studio-mini**. `studio-mini` has no routing copy of `fix-cart` yet, so it makes one and runs shop's setup in it, once, after the user approves the setup in the modal (X60).
5. The output streams into the chat. After the command exits, its changes are in the MacBook's worktree before the agent reads the result. The session's **Jobs** tab, on the MacBook, lists the job: "studio-mini · exit 0".
6. Later `studio-mini` runs two commands and has no free slot, so the next `pnpm check` goes to `devbox`, through `studio-mini`. The chip reads **on devbox**.
7. The user restarts `studio-mini` mid-run. The output gets "moonlet: devbox went away. Running again on Alex's MacBook Pro.", and the command runs again on the MacBook.
8. On the MacBook's Hosts page, `studio-mini`'s row now has the same switch and stepper as the Workers page.

## Behaviour and acceptance criteria

### Worker settings

- [x] Every member of the account has two **worker settings**:
  - `heavy`: whether it takes heavy commands from other hosts' sessions, `false` by default;
  - `slots`: how many routed commands it runs at once, 1 to 64, 2 by default.

  They are kept in the account state, keyed by the member's worker id (X41), so every member holds every member's settings. (`a_new_member_takes_no_other_hosts_commands_and_has_two_slots`)
- [x] `worker.settings.set {worker, heavy?, slots?}` on any member changes a member's settings, its own or another's. It reaches the member it names within 3 s while both are linked, and at the member's next `account.sync` otherwise (X68). Each field follows X68's rule: the change with the latest stamp wins. (`worker_settings_set_on_one_member_reach_the_host_they_name`, `settings_set_for_an_offline_member_apply_when_it_links`)
- [x] Only an app or a paired desktop changes worker settings. A phone and the `moonlet` CLI are refused with `forbidden`, so an agent cannot turn on a host to run its commands. (`only_an_app_or_a_paired_mac_changes_worker_settings`)
- [x] `slots` outside 1 to 64 is refused with `invalid_params`, and nothing is stored. (`slots_outside_one_to_sixty_four_are_refused`)
- [x] `link.set {worker: {enabled, slots}}` (X41, X61, X62) now writes the host's own worker settings in the account state, with `enabled` as `heavy`. `link.get` reports the account's values. The switches on the Hosts page work as before, and agree with the Workers page. (`link_set_writes_the_hosts_own_worker_settings`)
- [x] The first time a member starts with this spec and the account has no settings for it, it writes its `link.json` values (`worker.enabled` and `worker.slots`) as its settings, stamped as old as can be, so any change made meanwhile on another member wins. (`link_json_settings_become_the_accounts_at_first_start`)
- [ ] A host applies a change to its own settings within 1 s. Turning `heavy` off refuses new commands from other hosts and removes the routing copies it keeps for them, as X62 does. Commands already running finish. Lowering `slots` never stops a running command. (`turning_heavy_off_takes_no_new_commands_and_lets_running_ones_finish`)
- [ ] `heavy` covers other hosts' commands only. A host always runs its own sessions' commands when no other machine is free, as X62's central host does. (`a_host_runs_its_own_sessions_commands_when_no_other_is_free`)

### Which commands are routed

- [x] The Bash calls of Claude Code agents in sessions on **any member** are routed, under X62's rules as X90 changes them: the hook, the session's worktree, plan mode, the approved list read from the session's host's main checkout, and the user's Claude Code deny and ask rules. (`a_members_session_runs_its_heavy_command_on_the_central_host`, `a_host_with_heavy_commands_off_takes_none_from_other_hosts`)
- [x] The session's host does the routing: its `exec.run` picks the machine, fences the routing copy, starts the command, streams the output to `moonlet exec`, applies the run's changes, and keeps the job. Every X62 rule that says "the central host" for these steps now means the session's host. (`a_members_session_runs_its_heavy_command_on_the_central_host`)

### Approval for the whole account

- [x] A project's approval is kept in the account state, keyed by project identity: the exact `commands` and the exact `env` names, as X62 keeps them in `heavy.json`. `heavy.approve {project, commands, env}` on any member writes it, so every member holds it. X62's rules stand: the lists must be the config's as it is now on the member that approves, approving replaces the previous lists, and only an app or a paired desktop approves. (`an_approval_on_one_member_lets_every_member_route_and_run_the_list`)
- [x] The session's host routes a command when it matches an entry that is both in its own main checkout's list and in the account's approval, and when every `env` name of its list is approved. These are X62's rules, applied to the account's record. (`an_approval_on_one_member_lets_every_member_route_and_run_the_list`)
- [x] A host that runs a command for another host checks it again: it runs only a command that matches an entry of the account's approval for the project's identity, with only approved `env` names. Otherwise it refuses with `not_approved`. (`a_worker_runs_what_the_account_approved_without_approving_itself`; X62's `a_worker_that_has_not_approved_refuses_and_the_next_one_runs_it`, now with a worker from before X89, which keeps only its own approval)
- [x] A member's main checkout whose list differs from the approved one shows the difference on its project page, as X62 does ("pnpm build was added since you approved the list"). Approving there replaces the account's approval with that member's list, and the other members' project pages show the new approval at once, keeping any edits not saved yet (`heavy.approval_changed`). (`approving_on_a_member_with_another_list_replaces_the_accounts`; Vitest "keeps the page's list and takes another member's approval (X89)")
- [x] The first time a member starts with this spec, each approval in its `heavy.json` with no approval in the account for that identity is written into the account, stamped as old as can be. The per-worker approvals in `sync/projects.json` (`approved_heavy`) are no longer read. (`approvals_from_heavy_json_reach_the_account_at_first_start`)

### Picking a machine

- [x] The session's host asks its central host for `worker.list` when a command is routed. The list now has every linked member, the central host included, each with its worker settings, the slots it uses now (`used`) and its last load. A member before this spec, and a member with `heavy` off, is never a candidate. (`a_host_with_heavy_commands_off_takes_none_from_other_hosts`)
- [ ] The candidates for a session on host H are:
  - every other member with `heavy` on, linked now, with a free slot and a load below busy (X62's 0.7 × cores), on the project's `os`;
  - H itself;
  - the project's ready cloud machines (X63).
- [x] Order:
  1. other members, by lowest load per core, then lowest round trip, then worker id;
  2. H;
  3. ready cloud machines, by lowest load per core.

  A session that asked for the cloud (X63) tries cloud machines first. The round trip to a member reached through the central host is H's round trip to the central host plus the central host's to that member. Worked examples, for a session on the MacBook (load / cores, slots used of total):

  | Machines | Runs on |
  |---|---|
  | MacBook 21.3/10, studio-mini 2.6/10 on (0 of 2) | studio-mini |
  | MacBook 21.3/10, studio-mini 2.6/10 **off** | MacBook (the session's host, busy or not) |
  | MacBook 1.0/10, studio-mini 2.6/10 on (0 of 2) | studio-mini (another member before the session's host) |
  | MacBook 21.3/10, studio-mini 2.6/10 on (2 of 2), devbox 1.0/16 on (0 of 4) | devbox |
  | MacBook 21.3/10, studio-mini 3.0/10 on, devbox 1.0/16 on | devbox (0.0625 < 0.3) |
  | MacBook 21.3/10, studio-mini 8.0/10 on (busy), a ready cloud machine | the cloud machine |
  | MacBook 21.3/10, studio-mini 8.0/10 on (busy), no cloud machine | MacBook anyway |

  (`picks_as_in_the_mesh_order_table`)
- [x] The central host's own sessions pick in the same order. For them, the central host is H. The order of X62's table is unchanged: a linked member with `heavy` on comes before the central host. (`picks_as_in_the_mesh_order_table`, X62's `picks_as_in_the_order_table`)
- [x] A command never waits for a slot. When no candidate is free, it runs on H, and a project that allows cloud overflow gets a machine for the next command (X63).
- [x] A host's `slots` count every routed command it runs, for its own sessions and for other hosts' sessions. A host with every slot in use refuses another host's command with `busy`, and the session's host tries the next candidate. It never refuses its own sessions' commands, as they have nowhere else to go. A member also sees the central host's slots in use in `worker.status`, so a full central host is not asked at all. (`a_host_with_no_free_slot_refuses_busy_and_the_next_one_runs_it`, `slots_count_every_routed_command_a_host_runs`)
- [x] Two sessions' hosts may pick the same member at once. The member takes what its slots allow, refuses the rest with `busy`, and each session's host goes on to its next candidate. (`two_hosts_picking_one_slot_run_one_there_and_one_elsewhere`)

### Reaching another member

- [x] The session's host talks to the central host over its link (X41). It reaches any other member through the central host, with `peer.call {to, method, params}`. The central host passes the call on over `to`'s link as `peer.call {from, method, params}`, and passes the answer back. When `to` is the central host itself, the central host answers it. (`a_members_session_runs_its_heavy_command_on_another_member_through_the_central_host`)
- [x] The central host sets `from` to the worker id registered on the connection the call came from. A `from` in the sender's params is refused with `invalid_params`. (`a_member_cannot_name_another_sender_through_the_relay`)
- [x] Only the **routing methods** go through `peer.call`. Anything else is refused with `forbidden`. (`the_central_host_passes_on_only_the_routing_methods`)
  - From the session's host to the machine that runs the command: `exec.prepare`, `exec.start`, `exec.cancel`, `sync.update` (the fence) and `sync.closing`.
  - From the machine back to the session's host: `sync.open {kind: "run"}`, `sync.fetch`, `sync.close`, `exec.done` and `session.files_fetch` (X74).
- [x] The session's host answers a runner's `sync.open {kind: "run"}`, `sync.fetch` and `session.files_fetch` only for a session it has routed a command of to that machine. It takes `exec.done` only from the machine that runs that run in that copy, as X62 does. (`a_runner_reads_only_the_sessions_routed_to_it`)
- [x] Output frames take the same path. For a run it passes on, the central host gives `exec.start`'s run a relay id of its own, apart from X72's terminal relays. It sends the runner's `Output` frames for that id to the session's host under the session's host's run id. `exec.cancel` and `exec.done` are mapped back in the same way. Each stream keeps its order. (`output_through_the_relay_reaches_moonlet_exec_in_order`)
- [x] A member registers with `peer: true` in `worker.register` when it serves the routing methods for other hosts. The central host passes `peer.call` only to members that did, and answers others with `unsupported`. The session's host then skips that member. (`a_member_before_this_spec_is_not_offered_other_hosts_commands`)

### Routing copies

- [ ] A host keeps a routing copy of another host's session at `$MOONLET_HOME/runs/<the session's host>/<project>/<session>/`, as X62 does for its central host. It is made, fenced and brought back as X62 says, with the session's host in the central host's place. (`a_members_session_runs_its_heavy_command_on_the_central_host`)
- [x] Setup in a routing copy follows X62: on a Mac, the user approves the exact setup command once per project and session's host. Until then the Mac refuses with `setup_pending`. The command is the one in the session's host's main checkout (X90), sent with `exec.prepare` as `setup`, since a copy made from git may have no `.moonlet/config.toml`; a copy falls back to its own config's when none is sent. (`a_routing_copy_runs_the_setup_of_the_sessions_main_checkout`)
- [x] A routing copy for another host is removed:
  - when that session is archived: the session's host sends `sync.closing` to each machine it routed the session to;
  - when this host turns `heavy` off;
  - when the session's host leaves the account;
  - after 7 days unused, as in X62.

  (`archiving_a_members_session_removes_its_routing_copies_on_other_hosts`)

### When something goes away

- [x] A run whose machine goes away, or whose relay stops because the central host went away, runs again on the session's host from the same fence, with the line "moonlet: devbox went away. Running again on Alex's MacBook Pro." The exit status is the second run's. The abandoned run's changes never reach the session. (`a_runner_that_goes_away_mid_run_makes_the_command_run_again_on_the_sessions_host`, `a_member_reached_through_the_central_host_that_goes_away_mid_run_runs_it_again_on_the_sessions_host`, `losing_the_central_host_mid_relay_runs_the_command_again_on_the_sessions_host`)
- [x] A runner that loses the session's host mid-run, directly or through the central host, stops the command, as X62's worker does when its central host's daemon stops. Through the central host, it hears so from the central host, which cancels the runs of a member that went away. (`a_runner_that_loses_the_sessions_host_stops_the_command`)
- [x] While the session's host has no link to its central host, every command of its sessions runs on it. (`a_member_without_its_central_host_runs_its_own_commands`)

### Cloud machines

- [x] A session on any member may use the project's cloud machines, under X63's rules for the project: overflow when the project allows it, and the composer's cloud checkbox. The machines stay the central host's, made with its provider and limits. (`a_members_session_runs_on_the_projects_cloud_machine`)
- [x] The session's host asks for them with `worker.peers {identity}`: the central host adds the project's ready machines, found by identity, marked `cloud`, and the session's host ranks them as cloud machines (after itself). When nothing is free, it sends `cloud.overflow {identity}`, and the central host starts a machine when the project's overflow is on. A session that asked for the cloud sends `cloud.overflow {identity, asked: true}`: the machine on its way, or a new one, whatever the overflow setting; it then waits for it as X63 says, "waiting for moonlet-shop-m3x9 to start (0:10)", up to 20 minutes, and **Run on … now** still runs it on the session's host. (`a_members_busy_command_starts_an_overflow_machine`, `a_members_cloud_session_waits_for_the_central_hosts_machine`)
- [x] The session's host reaches the machine through the central host with `peer.call`. The central host passes `exec.prepare` to a machine only with the identity of the machine's own project, and the other calls only once that member prepared it. A cloud machine sends only the calls back to that member. It runs what its central host passes on, as it runs the central host's own commands (X63): the central host is the one that checked the member. (`a_cloud_machine_takes_a_members_command_of_its_own_project_only`)
- [x] A cloud machine gets a member's copied files (X74) when the project's **Also to cloud machines** is on: it asks the member with `session.files_fetch` through the central host, and the member answers only a machine the central host offered it, for a session it asked that machine to run. (`a_cloud_machine_gets_a_members_copied_files_when_the_switch_is_on`)

### Jobs and the Workers page

- [x] Jobs are kept on the session's host, with X62's states, phases, timeline and output. The app's Jobs tab reads them there, as now.
- [x] A host's `worker.ping` answer gains `used` and `running: [{host, session, command, started_at}]`: what it runs now for other hosts, for whom. The central host's `worker.list` carries them for every member; its own, for members, are `exec.status`'s `serving`. (`worker_list_lists_every_member_with_what_it_runs`)
- [x] Settings › Machines › Workers lists every member of the account: its settings, load, slots in use, round trip from this Mac, and its running commands, each with its session and the session's host. (Vitest "lists every member with its switch and slots")
- [x] A member that is not linked now shows "Not connected · changes apply when it links", with its switch and stepper still enabled. (Vitest "an offline member's row")

### Older daemons

- [ ] A central host from before this spec answers `peer.call` with an unknown-method error. Its members then run their own sessions' commands themselves, and the app's Workers page says "Update moonlet on studio-mini to run commands between your hosts". (`a_central_host_before_this_spec_leaves_members_running_their_own_commands`; Vitest "says to update an older central host")
- [ ] A member from before this spec keeps and passes on the new account records unread (X68). It is never offered other hosts' commands, and its own sessions route only if it is the central host.
- [ ] No protocol version change. The methods are new and the fields optional.

## UI

- **Settings › Machines › Workers** ([workers-page.png](design/x62-x63/workers-page.png) as the starting point):
  - The title badge names the account's central host, "studio-mini · Central host", as now. The text under it changes to: "Your hosts run each other's heavy commands. A command goes to the free host with the lowest load, and runs where its session is when none is free."
  - **Macs and hosts**: one row per member of the account. Badges are "This Mac" and "Central host". Columns: Worker (name, OS and cores, skip reasons in the attention colour), Load, Slots ("1 of 2"), Round trip.
  - Under each row's name: a **Takes heavy commands from other hosts** switch and a **Run at most [− 2 +] at once** stepper, as on the Hosts page. They are enabled for every member, linked or not. A change shows at once, and a toast reads "studio-mini takes heavy commands from your other hosts" (or "… no longer takes …").
  - A running command sits under its row: spinner, "fix-cart on Alex's MacBook Pro", command, elapsed time.
  - The summary line: "3 commands running · 3 of 8 slots in use", over every member with `heavy` on, the session's host's own runs, and ready cloud machines.
  - The empty state, when no member has `heavy` on: "No host runs heavy commands for the others yet. Turn on Takes heavy commands from other hosts on a host below." The rows stay, so the switch is right there.
- **Settings › Machines › Hosts:** This Mac's **Use this Mac for heavy commands** reads **Takes heavy commands from other hosts**, with "Run at most [− 2 +] at once" under it. The central host's row gets the same switch and stepper; X41 and X61 gave it none. A remote host that is not yet a member keeps X61's pairing flow.
- **Project page, Heavy commands:** the approval banner reads "Approving the list lets agents run it without asking, on every host of your account that takes heavy commands." The toast after **Approve** reads "Approved pnpm check for shop on every host of your account".
- **Chat chip and Jobs tab:** as X62. The chip names the host that ran the command, a server icon for a host without the desktop app.

## Protocol and RPCs

**Member to its central host (over the link):**

- `peer.call {to, method, params}` → the answer of `to`. Only the routing methods. Refused with `forbidden` from a phone, the CLI, or a connection that has not registered as a worker. Cloud machines may send it only for runs they were given.
- `worker.list`: now also from a linked member, with every member and the central host itself. Each entry gains `heavy`, `slots`, `used`, `running` and `peer`.
- `cloud.overflow {identity, asked?}`: a member's command found no free machine (`asked` false: a machine starts when the project's overflow is on), or its session asked for the cloud (`asked`: the machine on its way or a new one, answered as `{id, name}`). `worker.peers {identity}` adds the project's ready machines, with `cloud: true`.

**Central host to a member:**

- `peer.call {from, method, params}`: a routing method from another member, or from the central host itself when it runs a member's command (then `from` is the central host's worker id).
- `Output` frames of a passed-on run, under the session's host's run id.

**Any member, from an app or a paired desktop:**

- `worker.settings.set {worker, heavy?, slots?}` → `true`. Errors: `invalid_params`, `forbidden`, `not_found` (no member with that id).
- `worker.settings` → `[{worker, name, heavy, slots}]`, every member's settings as this member holds them.
- `heavy.approve {project, commands, env}` writes the account's approval. The `identity` form X62 gave workers is no longer used: the account carries the approval to every member.

**Changed:**

- `worker.register` gains `peer: bool`.
- The `worker.ping` answer gains `used` and `running`.
- `link.get`/`link.set`'s `worker.enabled` and `worker.slots` read and write the account's settings for this host.
- `docs/protocol.md` gets the methods and the relay's frames.

## Data and config

- **Account state (X68):** two new record kinds. Each field follows X68's rules, and older members keep and pass them on unread.
  - `worker`, keyed by worker id, with `heavy` and `slots`;
  - `heavy_approval`, keyed by project identity, with one field `approved: {commands, env}`, so two approvals made apart never mix their lists: the later one stands whole.
- **`link.json`:** `worker.enabled` and `worker.slots` are read once, at the first start with this spec, and then follow the account.
- **`heavy.json`:** read once, at the first start with this spec, and then no longer written.
- **Routing copies:** `$MOONLET_HOME/runs/<session's host>/…`, as in X62.
- **Central host:** relay ids for passed-on runs, in memory only. A restart drops them, and the runs go on as "went away".

## Security considerations

- **Turning a host on is the consent.** A host with `heavy` on runs the account's approved commands for every member's sessions, including code an agent wrote there, as the user. ADR 0009 accepted this for workers of the central host. This spec extends it to every member, and keeps it off by default. A phone and an agent's CLI cannot turn a host on.
- **One approval for the account.** Approving on one member approves on all of them, including members that were offline. The two lists are one value in the account, so an `env` name approved with one list never comes with another list's commands; a member that shares the account runs only by the account's approval, never by an older one of its own (`two_approvals_made_apart_never_mix_their_lists`). The banner says so before the user clicks. The approval is still the exact list the approving member's page showed, and every runner checks the command against it again.
- **Any member changes any member's settings.** ADR 0014 already trusts every member with the account. Only an app or a paired desktop writes the settings through the RPC. A member's daemon sends only its own changes to the account log (X68).
- **The relay.** The central host fills in `from` from the authenticated connection, passes on only the routing methods, and passes a cloud machine's calls only for its runs. A session's host serves files only for sessions it routed to the caller. The central host sees every relayed byte, as it already holds a copy of every session (X72).
- **Cloud machines and members.** A cloud machine runs what its central host passes on without an approval of its own (X63), so the central host checks a member's command against the account's approval of the machine's own project before passing it on, and gives the machine its own project's setup command, never a member's. A member names the project in `exec.prepare`; any member with the repository could, so the approval is what bounds it: the machine runs only that project's approved commands. Routing copies of different members' sessions on one machine run as one user, as all of one central host's routing copies do (X62): a member's command can read the others' copies there, which ADR 0014's trust in every member of the account covers. (`the_central_host_checks_a_members_command_for_a_cloud_machine_against_the_accounts_approval`)
- **Calls back.** A runner calls its router back only while that router's run goes on there, or within 15 minutes of the router's `exec.prepare`.
- **Environment.** Only the approved `[heavy] env` names cross, to whichever machine runs the command, as in X62.

## Out of scope

- Direct links between members. `peer.call` is the relay's envelope, and a direct link would carry the same routing methods.
- Keeping a project off some hosts (for example, a work project that may run on the MacBook and the central host but nowhere else). Cloud machines already have X63's per-project opt-in.
- Routing between two accounts.
- Codex, chained and piped commands (X62).

## Test plan

Every acceptance criterion maps to at least one test below. Expected values are literals from this spec.

Where the tests live:

- **Rust unit:** `crates/moonlet-core/src/heavy.rs` (picking), the account log's record kinds in `moonlet-core`.
- **Daemon end-to-end:** `crates/moonletd/tests/mesh.rs`, with a central host and two member `TestDaemon`s linked as in `tests/link.rs`, a test-only load setting, and approvals made through the account. The cloud cases are in `tests/cloud.rs` with X63's fake provider.
- **Vitest:** `apps/desktop/src/lib/workers.test.ts`, `workerLink.test.ts`, `heavyApproval.test.ts`.
- **e2e:** `apps/desktop/e2e/specs/routing.e2e.ts`. Saving settings is a crucial feature.

| Criterion | Tests |
|---|---|
| Defaults | `a_new_member_takes_no_other_hosts_commands_and_has_two_slots` |
| Set from any member, offline members | `worker_settings_set_on_one_member_reach_the_host_they_name`, `settings_set_for_an_offline_member_apply_when_it_links` |
| Who changes them | `only_an_app_or_a_paired_mac_changes_worker_settings` |
| Slots range | `slots_outside_one_to_sixty_four_are_refused` |
| `link.set` and the Hosts page | `link_set_writes_the_hosts_own_worker_settings`; Vitest "the Hosts page switch and the Workers page agree" |
| From `link.json` | `link_json_settings_become_the_accounts_at_first_start` |
| Turning off, lowering slots | `turning_heavy_off_takes_no_new_commands_and_lets_running_ones_finish` |
| Own sessions always run at home | `a_host_runs_its_own_sessions_commands_when_no_other_is_free` |
| A member's session is routed | `a_members_session_runs_its_heavy_command_on_the_central_host` |
| Approval for the account | `an_approval_on_one_member_lets_every_member_route_and_run_the_list`, `a_worker_runs_what_the_account_approved_without_approving_itself`, `approvals_from_heavy_json_reach_the_account_at_first_start`; core `a_heavy_approval_on_one_member_is_every_members`; Vitest "the approval toast names the account", "each machine, on a host from before X89" |
| Candidates, `heavy` off | `a_host_with_heavy_commands_off_takes_none_from_other_hosts` |
| Order (worked examples) | `picks_as_in_the_mesh_order_table`, `picks_as_in_the_order_table` |
| Slots across hosts | `a_host_with_no_free_slot_refuses_busy_and_the_next_one_runs_it`, `slots_count_every_routed_command_a_host_runs`, `two_hosts_picking_one_slot_run_one_there_and_one_elsewhere` |
| The relay | `a_members_session_runs_its_heavy_command_on_another_member_through_the_central_host`, `a_member_cannot_name_another_sender_through_the_relay`, `the_central_host_passes_on_only_the_routing_methods`, `a_runner_reads_only_the_sessions_routed_to_it`, `output_through_the_relay_reaches_moonlet_exec_in_order` |
| `peer` and older members | `a_member_before_this_spec_is_not_offered_other_hosts_commands`, `a_central_host_before_this_spec_leaves_members_running_their_own_commands` |
| Routing copies | `a_routing_copy_runs_the_setup_of_the_sessions_main_checkout`, `archiving_a_members_session_removes_its_routing_copies_on_other_hosts` |
| Going away | `a_runner_that_goes_away_mid_run_makes_the_command_run_again_on_the_sessions_host`, `a_member_reached_through_the_central_host_that_goes_away_mid_run_runs_it_again_on_the_sessions_host`, `losing_the_central_host_mid_relay_runs_the_command_again_on_the_sessions_host`, `a_runner_that_loses_the_sessions_host_stops_the_command`, `a_member_without_its_central_host_runs_its_own_commands` |
| Cloud machines | `a_members_session_runs_on_the_projects_cloud_machine`, `a_members_busy_command_starts_an_overflow_machine`, `a_members_cloud_session_waits_for_the_central_hosts_machine`, `a_cloud_machine_takes_a_members_command_of_its_own_project_only` |
| `worker.list` and the Workers page | `worker_list_lists_every_member_with_what_it_runs`, `exec_status_lists_what_a_host_runs_for_other_hosts`; Vitest "lists what each host runs for other hosts, and for whom", Vitest "lists every member with its switch and slots", "an offline member's row", "the summary line counts the account's slots", "says to update an older central host" |
| Saving from the app | e2e `worker-link.e2e.ts` "turning another host's heavy commands on from the Workers page saves it (X89)", `routing.e2e.ts` "a host's switch and slots on the Workers page are saved (X89)"; Vitest "says what a change of the switch or slots did" |

**Manual, before the status says implemented:** with the real central host and MacBook, a session on the MacBook routes `pnpm check` to the central host with the central host's switch turned on from the MacBook. Then a third member gets a command through the central host.

## Open questions

- **Different lists on different members.** Each member reads `[heavy]` from its own main checkout (X90), and the account keeps one approval. If two members list different commands for one project, approving on one makes the other's extra entries Not approved. Is one list per project, kept in the account state instead of `.moonlet/config.toml`, worth a later spec?
- **Routing copy folders by name.** X62 names a routing copy's folder after the session's host's name, and X41 allows two hosts with one name. With every member routing, two such hosts could share a folder. Name it after the worker id instead?
- **The central host as a single point.** While the central host is down, members other than the central host run everything themselves. Direct links would remove that. When do they come?

Decided by the user on 2026-11-07:

- **A mesh.** Every host routes its own sessions and runs commands for every other host.
- **Settings from any app.** From any Mac's app, the user sets every host's switch and slots, the central host's included.
- **Relay now, direct links later.** The protocol is written so that direct links carry the same messages.
- **Off by default.** A host takes other hosts' commands only once it is turned on.
- **One approval for the account**, kept in the account state.
- **Cloud machines for every member's sessions**, under the project's existing rules.
