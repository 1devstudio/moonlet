# X89 — Every host runs heavy commands for every other host

- **Status:** implemented (untried between real machines)
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
7. The user restarts `studio-mini` mid-run. `devbox` may have run part of `pnpm check`, which is not listed under `[heavy] rerun`, so it is not run again: the agent gets exit status 125 and "moonlet: devbox went away during the run. The command may have run in part there; it was not run again.", and `devbox` stops the command once it finds its link connected again. A command listed under `rerun` would get "moonlet: devbox went away. Running again on Alex's MacBook Pro." and run again on the MacBook.
8. On the MacBook's Hosts page, `studio-mini`'s row now has the same switch and stepper as the Workers page.

## Behaviour and acceptance criteria

### Worker settings

- [x] Every member of the account has two **worker settings**:
  - `heavy`: whether it takes heavy commands from other hosts' sessions, `false` by default;
  - `slots`: how many routed commands it runs at once, 1 to 64, 2 by default.

  They are kept in the account state, keyed by the member's worker id (X41), so every member holds every member's settings. (`a_new_member_takes_no_other_hosts_commands_and_has_two_slots`)
- [x] `worker.settings.set {worker, heavy?, slots?}` on the central host changes any member's settings, and on any other member that member's own. A member asked for another host's settings answers `forbidden` ("only the central host, studio-mini, or Alex's MacBook Air itself changes Alex's MacBook Air's worker settings") once its central host referees permissions (below). The Workers page sets them on the central host, and the Hosts page on the host itself, so the user still sets every host's from any Mac's app. A change reaches the member it names within 3 s while both are linked, and at the member's next `account.sync` otherwise (X68). Each field follows X68's rule: the change with the latest stamp wins. (`worker_settings_set_on_the_central_host_reach_the_host_they_name`, `settings_set_for_an_offline_member_apply_when_it_links`)
- [x] Only an app or a paired desktop changes worker settings. A phone and the `moonlet` CLI are refused with `forbidden`, so an agent cannot turn on a host to run its commands. (`only_an_app_or_a_paired_mac_changes_worker_settings`)
- [x] `slots` outside 1 to 64 is refused with `invalid_params`, and nothing is stored. (`slots_outside_one_to_sixty_four_are_refused`)
- [x] `link.set {worker: {enabled, slots}}` (X41, X61, X62) now writes the host's own worker settings in the account state, with `enabled` as `heavy`. `link.get` reports the account's values. The switches on the Hosts page work as before, and agree with the Workers page. (`link_set_writes_the_hosts_own_worker_settings`)
- [x] The first time a member starts with this spec and the account has no settings for it, it writes its `link.json` values (`worker.enabled` and `worker.slots`) as its settings, stamped as old as can be, so any change made meanwhile on another member wins. (`link_json_settings_become_the_accounts_at_first_start`)
- [x] A host applies a change to its own settings within 1 s. Turning `heavy` off refuses new commands from other hosts and removes the routing copies it keeps for them, as X62 does. Commands already running finish. Lowering `slots` never stops a running command. (`turning_heavy_off_takes_no_new_commands_and_lets_running_ones_finish`)
- [x] `heavy` covers other hosts' commands only. A host always runs its own sessions' commands when no other machine is free, as X62's central host does. (`a_host_runs_its_own_sessions_commands_when_no_other_is_free`)

### Who a permission counts from

The worker settings, a project's approval and its copied files (X74) act as permissions: they decide what runs on a host, and which files leave it. Since the 2026-11-15 security audit, each counts only from those allowed to make it, and not from whichever member wrote it into the account log.

- [x] **The central host referees them.** At its first start with this rule, and when a host becomes the central host, it makes its own every value of them that counts there, each with the time and counter of the change that gave it, then writes a `referee` record. Nothing anyone set changes. From then on, on every member that has that record from its central host:
  - a host's worker settings count only from that host and from the central host;
  - a project's approval and copied files count only from the central host and from the member reading them, whose own app made them.

  (core `a_switch_another_member_writes_does_not_turn_a_host_on`, `an_approval_a_member_writes_without_its_app_counts_on_no_other_member`, `copied_files_a_member_writes_without_its_app_are_not_taken`; `a_member_that_writes_another_hosts_switch_does_not_turn_it_on`, `a_member_that_writes_an_approval_itself_does_not_get_its_command_run_on_another_member`, X74's `a_list_a_members_daemon_writes_without_its_app_is_not_taken`)
- [x] **A member's app's change reaches the others through the central host.** When the app on a member approves a project's heavy commands or sets its copied files, the member's change counts there at once, and the member asks its central host to make it its own: it lists the change in `asks` with each `account.sync` until the central host did. The central host takes only that member's own change, already in its log, to an approval of two lists of names or to copied files X74 accepts, and makes it its own with the member's time and counter, so the latest change still wins. A change a member's daemon writes without its app asks for nothing, and counts on that member alone. (core `an_approval_made_in_a_members_app_counts_everywhere_once_the_central_host_takes_it`, `the_central_host_takes_only_a_members_own_asks_for_what_a_project_allows`; `an_approval_on_one_member_lets_every_member_route_and_run_the_list`, `a_members_session_runs_its_heavy_command_on_the_central_host`, X74's `the_list_set_on_one_member_reaches_the_others`)
- [x] **What was set before still counts**, whichever host updates first. Until the central host writes its `referee` record, every member's change counts, as before, so a member that updates first changes nothing. The central host's taking over keeps every value, also for a member that joins later. Taking over keeps whatever counted before, whoever wrote it: a change a member's daemon wrote before the central host refereed counts on as the user's. A host that becomes the central host keeps what counted under the one before it, and nothing else; so does a central host whose worker id changed (its `link.json` made again). (`settings_made_before_the_central_host_referees_them_still_count`; core `permissions_set_before_the_central_host_referees_them_still_count`, `a_new_central_host_keeps_what_the_old_one_counted_and_nothing_else`, `a_central_host_whose_worker_id_changed_keeps_refereeing_by_what_counted`)
- [x] **A runner checks its own list too.** A host that runs another host's command, and has its own checkout of the project whose main checkout's `[heavy]` lists commands (X90), runs only a command that list names, with only `env` names it lists, besides the account's approval. Otherwise it refuses with `not_approved`, and the session's host goes on to its next candidate. A checkout whose config cannot be read names nothing, so the host refuses too. A host with no checkout of the project, or one that lists no heavy commands (its config is often kept out of git, so a clone may have none), goes by the approval alone. (`a_runner_with_its_own_checkout_runs_only_what_that_checkout_lists_too`)
- [x] **Older hosts.** `asks` and the `referee` record are new; an older host ignores the first and keeps and passes on the second unread (X68). A newer member of an older central host counts every member's change, as before, since no `referee` record comes. An older member of a newer central host still counts every member's change, and its own app's approvals and copied files count on the newer members only after the user makes them again on an updated Mac or on the central host; the switches it sets for other hosts through its own daemon count on no updated host. A change an updated member made, while its central host was still older, to another host's settings, or one an older member's app made, that reached the central host only after it began refereeing, counts on no other updated host: the user sets it again.

### Which commands are routed

- [x] The Bash calls of Claude Code agents in sessions on **any member** are routed, under X62's rules as X90 changes them: the hook, the session's worktree, plan mode, the approved list read from the session's host's main checkout, and the user's Claude Code deny and ask rules. (`a_members_session_runs_its_heavy_command_on_the_central_host`, `a_host_with_heavy_commands_off_takes_none_from_other_hosts`)
- [x] The session's host does the routing: its `exec.run` picks the machine, fences the routing copy, starts the command, streams the output to `moonlet exec`, applies the run's changes, and keeps the job. Every X62 rule that says "the central host" for these steps now means the session's host. (`a_members_session_runs_its_heavy_command_on_the_central_host`)

### Approval for the whole account

- [x] A project's approval is kept in the account state, keyed by project identity: the exact `commands` and the exact `env` names, as X62 keeps them in `heavy.json`. `heavy.approve {project, commands, env}` on any member writes it, so every member holds it. X62's rules stand: the lists must be the config's as it is now on the member that approves, approving replaces the previous lists, and only an app or a paired desktop approves. (`an_approval_on_one_member_lets_every_member_route_and_run_the_list`)
- [x] The session's host routes a command when it matches an entry that is both in its own main checkout's list and in the account's approval, and when every `env` name of its list is approved. These are X62's rules, applied to the account's record. (`an_approval_on_one_member_lets_every_member_route_and_run_the_list`)
- [x] A host that runs a command for another host checks it again: it runs only a command that matches an entry of the account's approval for the project's identity, with only approved `env` names. Otherwise it refuses with `not_approved`. (`a_worker_runs_what_the_account_approved_without_approving_itself`; X62's `a_worker_that_has_not_approved_refuses_and_the_next_one_runs_it`, now with a worker from before X89, which keeps only its own approval)
- [x] A member's main checkout whose list differs from the approved one shows the difference on its project page, as X62 does ("pnpm build was added since you approved the list"). Approving there replaces the account's approval with that member's list, and the other members' project pages show the new approval at once, keeping any edits not saved yet (`heavy.approval_changed`). (`approving_on_a_member_with_another_list_replaces_the_accounts`; Vitest `heavyCommands.test.ts` "keeps the page's list and takes another member's approval (X89)")
- [x] The first time a member starts with this spec, each approval in its `heavy.json` with no approval in the account for that identity is written into the account, stamped as old as can be. The per-worker approvals in `sync/projects.json` (`approved_heavy`) are no longer read. (`approvals_from_heavy_json_reach_the_account_at_first_start`)

### Picking a machine

- [x] The session's host asks its central host when a command is routed: `worker.status` for the central host itself, and `worker.peers` for the other members that take other hosts' commands, each with its slots, the slots it uses now (`used`) and its last load. A member before this spec, and a member with `heavy` off, is never a candidate. (`a_host_with_heavy_commands_off_takes_none_from_other_hosts`)
- [x] The candidates for a session on host H are:
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
- [x] A host's `slots` count every routed command it runs, for its own sessions and for other hosts' sessions. A host with every slot in use refuses another host's command with `busy`, and the session's host tries the next candidate. It never refuses its own sessions' commands, as they have nowhere else to go. A member also sees the central host's slots in use in `worker.status`, so a full central host is not asked at all. (`a_host_with_no_free_slot_refuses_busy_and_the_next_one_runs_it`)
- [x] Two sessions' hosts may pick the same member at once. The member takes what its slots allow, refuses the rest with `busy`, and each session's host goes on to its next candidate. (`two_hosts_picking_one_slot_run_one_there_and_one_elsewhere`)

### Reaching another member

- [x] The session's host talks to the central host over its link (X41). It reaches any other member through the central host, with `peer.call {to, method, params}`. The central host passes the call on over `to`'s link as `peer.call {from, method, params}`, and passes the answer back. The central host itself is called directly, with the same methods, never through `peer.call`. (`a_members_session_runs_its_heavy_command_on_another_member_through_the_central_host`)
- [x] The central host sets `from` to the worker id registered on the connection the call came from. A `from` in the sender's params is refused with `invalid_params`. (`the_central_host_passes_on_only_the_routing_methods`)
- [x] Only the **routing methods** go through `peer.call`. Anything else is refused with `forbidden`. (`the_central_host_passes_on_only_the_routing_methods`)
  - From the session's host to the machine that runs the command: `exec.prepare`, `exec.start`, `exec.cancel`, `sync.update` (the fence) and `sync.closing`.
  - From the machine back to the session's host: `sync.open {kind: "run"}`, `sync.fetch`, `sync.close`, `exec.done` and `session.files_fetch` (X74).
- [x] The session's host answers a runner's `sync.open {kind: "run"}`, `sync.fetch` and `session.files_fetch` only for a session it has routed a command of to that machine. It takes `exec.done` only from the machine that runs that run in that copy, as X62 does. (`the_central_host_passes_on_only_the_routing_methods`)
- [x] Output frames take the same path. For a run it passes on, the central host gives `exec.start`'s run a relay id of its own, apart from X72's terminal relays. It sends the runner's `Output` frames for that id to the session's host under the session's host's run id. `exec.cancel` and `exec.done` are mapped back in the same way. Each stream keeps its order. (`a_members_session_runs_its_heavy_command_on_another_member_through_the_central_host`)
- [x] A member registers with `peer: true` in `worker.register` when it serves the routing methods for other hosts. The central host passes `peer.call` only to members that did, and answers others with `unsupported`. The session's host then skips that member. (`the_central_host_passes_on_only_the_routing_methods`)

### Routing copies

- [x] A host keeps a routing copy of another host's session at `$MOONLET_HOME/runs/<the session's host>/<project>/<session>/`, as X62 does for its central host. It is made, fenced and brought back as X62 says, with the session's host in the central host's place. (`a_members_session_runs_its_heavy_command_on_the_central_host`) (`a_routing_copy_for_another_member_lives_under_runs_of_the_sessions_host`)
- [x] Setup in a routing copy follows X62: on a Mac, the user approves the exact setup command once per project and session's host. Until then the Mac refuses with `setup_pending`. The command is the one in the session's host's main checkout (X90), sent with `exec.prepare` as `setup`, since a copy made from git may have no `.moonlet/config.toml`; a copy falls back to its own config's when none is sent. (`a_routing_copy_runs_the_setup_of_the_sessions_main_checkout`)
- [x] A routing copy for another host is removed:
  - when that session is archived: the session's host sends `sync.closing` to each machine it routed the session to;
  - when this host turns `heavy` off;
  - after 7 days unused, as in X62.

  (`archiving_a_members_session_removes_its_routing_copies_on_other_hosts`)

### When something goes away

- [x] A run whose machine goes away after it took the run's `exec.start`, or whose relay stops because the central host went away, is not run again by default, as in X62: the agent gets exit status 125 and "moonlet: devbox went away during the run. The command may have run in part there; it was not run again." The abandoned run's changes never reach the session. (`a_runner_lost_after_its_run_started_is_not_run_again_by_default`, for a runner reached directly, one reached through the central host, and a central host lost mid-relay)
- [x] A command listed under `[heavy] rerun` runs again on the session's host from the same fence instead, with the line "moonlet: devbox went away. Running again on Alex's MacBook Pro." The exit status is the second run's. (`a_runner_that_goes_away_mid_run_makes_the_command_run_again_on_the_sessions_host`, `a_member_reached_through_the_central_host_that_goes_away_mid_run_runs_it_again_on_the_sessions_host`, `losing_the_central_host_mid_relay_runs_the_command_again_on_the_sessions_host`)
- [x] A runner that loses the session's host mid-run, directly or through the central host, stops the command, as X62's worker does when its central host's daemon stops. Through the central host, it hears so from the central host, which cancels the runs of a member that went away. A member that runs a command over its own link to the central host, directly or relayed, also stops it once that link connects again, since the session's host has counted the run as lost by then, or once it heard nothing from the central host for 25 s. (`a_runner_that_loses_the_sessions_host_stops_the_command`; X62's `a_worker_that_comes_back_stops_a_run_its_central_host_gave_up_on`, `a_worker_whose_central_host_is_gone_stops_the_command_in_a_bounded_time`)
- [x] A member whose command runs on the central host, or through it, gives the run up when its link to the central host goes silent for 25 s, the open connection notwithstanding, as the runner does: the agent gets exit status 125 and the line above, rather than waiting for good. (`a_member_whose_central_host_goes_silent_mid_run_ends_the_run_in_a_bounded_time`)
- [x] A host that runs other hosts' commands stays awake while one runs, as X62's Mac does. (`a_mac_running_another_hosts_command_is_kept_awake_until_it_ends`)
- [x] While the session's host has no link to its central host, every command of its sessions runs on it. (`a_member_without_its_central_host_runs_its_own_commands`)

### Cloud machines

- [x] A session on any member may use the project's cloud machines, under X63's rules for the project: overflow when the project allows it, and the composer's cloud checkbox. The machines stay the central host's, made with its provider and limits. (`a_members_session_runs_on_the_projects_cloud_machine`)
- [x] The session's host asks for them with `worker.peers {identity}`: the central host adds the project's ready machines, found by identity, marked `cloud`, and the session's host ranks them as cloud machines (after itself). When nothing is free, it sends `cloud.overflow {identity}`, and the central host starts a machine when the project's overflow is on. A session that asked for the cloud sends `cloud.overflow {identity, asked: true}`: the machine on its way, or a new one, whatever the overflow setting; it then waits for it as X63 says, "waiting for moonlet-shop-m3x9 to start (0:10)", up to 20 minutes, and **Run on … now** still runs it on the session's host. (`a_members_busy_command_starts_an_overflow_machine`, `a_members_cloud_session_waits_for_the_central_hosts_machine`)
- [x] The session's host reaches the machine through the central host with `peer.call`. The central host passes `exec.prepare` to a machine only with the identity of the machine's own project, and the other calls only once that member prepared it. A cloud machine sends only the calls back to that member. It runs what its central host passes on, as it runs the central host's own commands (X63): the central host is the one that checked the member. (`a_cloud_machine_takes_a_members_command_of_its_own_project_only`)
- [x] The central host counts a member's command on its cloud machine as X63 counts its own, from the `exec.prepare` it passes on until the command's `exec.done` goes back or the member goes away, so the machine's idle time never removes it under the command. (`a_machine_running_a_members_command_outlives_its_idle_time_and_goes_after_it`, `a_members_command_counts_on_its_machine_while_its_copy_is_prepared`, `a_members_command_stops_counting_on_its_machine_once_the_member_goes_silent`)
- [x] A cloud machine gets a member's copied files (X74) when the project's **Also to cloud machines** is on: it asks the member with `session.files_fetch` through the central host, and the member answers only a machine the central host offered it, for a session it asked that machine to run. (`a_cloud_machine_gets_a_members_copied_files_when_the_switch_is_on`)

### Jobs and the Workers page

- [x] Jobs are kept on the session's host, with X62's states, phases, timeline and output. The app's Jobs tab reads them there, as now.
- [x] A host's `worker.ping` answer gains `used` and `running: [{host, session, command, started_at}]`: what it runs now for other hosts, for whom. The central host's `worker.list` carries them for every member; its own, for members, are `exec.status`'s `serving`. (`worker_list_lists_every_member_with_what_it_runs`)
- [x] Settings › Machines › Workers lists every member of the account: its settings, load, slots in use, round trip from the central host, and its running commands, each with its session and the session's host. (Vitest "lists every member with its switch and slots")
- [x] A member that is not linked now shows "Not connected · changes apply when it links", with its switch and stepper still enabled. (Vitest "an offline member's row")

### Older daemons

- [x] A central host from before this spec answers `peer.call` with an unknown-method error. Its members then run their own sessions' commands themselves, and the app's Workers page says "Update moonlet on studio-mini to run commands between your hosts". (`a_central_host_before_this_spec_leaves_members_running_their_own_commands`; Vitest "says to update an older central host")
- [x] A member from before this spec keeps and passes on the new account records unread (X68). It is never offered other hosts' commands, and its own sessions route only if it is the central host. (core `a_record_kind_a_member_does_not_know_is_kept_and_passed_on`; `the_central_host_passes_on_only_the_routing_methods` for a member registered without `peer`)
- [x] No protocol version change. The methods are new and the fields optional. (`PROTOCOL_VERSION` stays 6.)

## UI

- **Settings › Machines › Workers** ([workers-page.png](design/x62-x63/workers-page.png) as the starting point):
  - The title badge names the account's central host, "studio-mini · Central host", as now. The text under it changes to: "Your hosts run each other's heavy commands. A command goes to the free host with the lowest load, and runs where its session is when none is free."
  - **Macs and hosts**: one row per member of the account. Badges are "This Mac" and "Central host". Columns: Worker (name, OS and cores, skip reasons in the attention colour), Load, Slots ("1 of 2"), Round trip.
  - Under each row's name: a **Takes heavy commands from other hosts** switch and a **Run at most [− 2 +] at once** stepper, as on the Hosts page. They are enabled for every member, linked or not. A change shows at once, and a toast reads "studio-mini takes heavy commands from your other hosts" (or "… no longer takes …"). The page sets them on the central host when the app reaches it; on a member whose app does not, a change to another host's row is refused, and the error toast names the central host and that host as where to set it (Who a permission counts from).
  - A running command sits under its row: spinner, "fix-cart on Alex's MacBook Pro", command, elapsed time.
  - The summary line: "3 commands running · 3 of 8 slots in use", over every member with `heavy` on, the session's host's own runs, and ready cloud machines.
  - The empty state, when no member has `heavy` on: "No host runs heavy commands for the others yet. Turn on Takes heavy commands from other hosts on a host below." The rows stay, so the switch is right there.
- **Settings › Machines › Hosts:** This Mac's **Use this Mac for heavy commands** reads **Takes heavy commands from other hosts**, with "Run at most [− 2 +] at once" under it. The central host's row gets the same switch and stepper; X41 and X61 gave it none. A remote host that is not yet a member keeps X61's pairing flow.
- **Project page, Heavy commands:** the approval banner reads "Approving the list lets agents run it without asking, on every host of your account that takes heavy commands." The toast after **Approve** reads "Approved pnpm check for shop on every host of your account".
- **Chat chip and Jobs tab:** as X62. The chip names the host that ran the command, a server icon for a host without the desktop app.

## Protocol and RPCs

**Member to its central host (over the link):**

- `peer.call {to, method, params}` → the answer of `to`. Only the routing methods. Refused with `forbidden` from a phone, the CLI, or a connection that has not registered as a worker. Cloud machines may send it only for runs they were given.
- `worker.status` → `{id, name, heavy, os, cores, load, slots, used}`: the central host as a candidate. `worker.peers {identity?}` → the same for every other member that takes other hosts' commands, with `rtt_ms` from the central host, and the project's ready cloud machines with `cloud: true`. A central host before X89 answers both with `unknown_method`, and the member runs its own commands. `worker.list`'s entries gain `used` and `running` (what each runs for other hosts).
- `cloud.overflow {identity, asked?}`: a member's command found no free machine (`asked` false: a machine starts when the project's overflow is on), or its session asked for the cloud (`asked`: the machine on its way or a new one, answered as `{id, name}`). `worker.peers {identity}` adds the project's ready machines, with `cloud: true`.

**Central host to a member:**

- `peer.call {from, method, params}`: a routing method from another member, or from the central host itself when it runs a member's command (then `from` is the central host's worker id).
- `Output` frames of a passed-on run, under the session's host's run id.
- The event `exec.lost {run}`: the member that ran run `run` through the central host went away.

**Any member, from an app or a paired desktop:**

- `worker.settings.set {worker, heavy?, slots?}` → `true`. Errors: `invalid_params`, `forbidden`, `not_found` (no member with that id).
- `worker.settings` → `[{worker, name, heavy, slots}]`, every member's settings as this member holds them.
- `heavy.approve {project, commands, env}` writes the account's approval. The `identity` form X62 gave workers keeps only that worker's own approval, which a worker from before X89 runs by; the Workers page's **Approve** uses the project form when the approval is the account's.

**Changed:**

- `worker.register` gains `peer: bool`.
- The `worker.ping` answer gains `used` and `running`; `exec.status` gains `serving`, what this host runs for other hosts; `exec.start` gains `session_name`; `exec.prepare` gains `setup` (X90's main checkout) and `identity`.
- `link.get`/`link.set`'s `worker.enabled` and `worker.slots` read and write the account's settings for this host.
- `docs/protocol.md` gets the methods and the relay's frames.
- `account.sync` gains `asks: [{member, seq}]`, optional: the sender's own changes to a project's approval or copied files that its app made, which it asks the central host to make its own (Who a permission counts from).
- `worker.settings.set` on a member other than the central host refuses another host's settings with `forbidden`, once its central host referees permissions.

## Data and config

- **Account state (X68):** two new record kinds. Each field follows X68's rules, and older members keep and pass them on unread.
  - `worker`, keyed by worker id, with `heavy` and `slots`;
  - `heavy_approval`, keyed by project identity, with one field `approved: {commands, env}`, so two approvals made apart never mix their lists: the later one stands whole.
  - `referee`, keyed by the central host's worker id, with `since`: the central host referees the records above and X74's `project_files` (Who a permission counts from). It counts only from the host it names.
- **`account.json`:** gains `asks`, the member's own changes it asks its central host to make its own, by log name and number, until it did.
- **`link.json`:** `worker.enabled` and `worker.slots` are read once, at the first start with this spec, and then follow the account.
- **`heavy.json`:** read once, at the first start with this spec, and then no longer written.
- **Routing copies:** `$MOONLET_HOME/runs/<session's host>/…`, as in X62.
- **Central host:** relay ids for passed-on runs, in memory only. A restart drops them, and the runs end as "went away": not run again unless listed under `rerun`, and stopped on the runner once its link connects again.

## Security considerations

- **Turning a host on is the consent.** A host with `heavy` on runs the account's approved commands for every member's sessions, including code an agent wrote there, as the user. ADR 0009 accepted this for workers of the central host. This spec extends it to every member, and keeps it off by default. A phone and an agent's CLI cannot turn a host on.
- **One approval for the account.** Approving on one member approves on all of them, including members that were offline. The two lists are one value in the account, so an `env` name approved with one list never comes with another list's commands; a member that shares the account runs only by the account's approval, never by an older one of its own (`two_approvals_made_apart_never_mix_their_lists`). The banner says so before the user clicks. The approval is still the exact list the approving member's page showed, and every runner checks the command against it again.
- **Who changes a host's settings.** Only an app or a paired desktop writes them through the RPC, on the central host or on the host itself. In the account log, a host's settings count only from that host and from the central host, so a member's daemon cannot turn another host on by writing the record (Who a permission counts from).
- **Who approves.** A project's approval counts on a member only from the central host and from that member. The central host makes a member's approval its own only when the member asks for one of its own changes; a member's daemon asks only for what its app approved, after checking the lists against its checkout's config. A runner with its own checkout of the project also runs only what that checkout lists.
- **What a fully compromised member can still do (open).** A member's daemon runs as the user, and so does anything else of the user's on that Mac, with the same files and credentials as the app. Without a key agents cannot read, a request the app made cannot be told from one the daemon made. So a fully compromised member can still:
  - have its central host take over an approval or a copied-files list, as its app's changes are;
  - act as its app towards hosts the app is paired with, and change settings or approvals there;
  - have its commands run on a host that is on, within the approved list; an approved command runs code from the session's worktree, which that member controls (as X62 and the first bullet above accept).

  What it can no longer do is turn another host on, or widen what runs or which files are copied elsewhere, by writing account records alone. That holds on hosts that run this version under a central host that does: a host from before, or one whose central host is from before, still counts every member's change (Older hosts). A runner with no checkout of the project a command names goes by the account's approval alone. Closing the rest needs app-made changes signed with a key only the app holds; that needs a design of its own (ADR 0014, Consequences).
- **The relay.** The central host fills in `from` from the authenticated connection, passes on only the routing methods, and passes a cloud machine's calls only for its runs. A session's host serves files only for sessions it routed to the caller. The central host sees every relayed byte, as it already holds a copy of every session (X72).
- **Cloud machines and members.** A cloud machine runs what its central host passes on without an approval of its own (X63), so the central host checks a member's command against the account's approval of the machine's own project before passing it on, and gives the machine its own project's setup command, never a member's. A member names the project in `exec.prepare`; any member with the repository could, so the approval is what bounds it: the machine runs only that project's approved commands. Routing copies of different members' sessions on one machine run as one user, as all of one central host's routing copies do (X62): a member's command can read the others' copies there, which ADR 0014's trust in every member of the account covers. (`the_central_host_checks_a_members_command_for_a_cloud_machine_against_the_accounts_approval`)
- **Calls back.** Through the central host, a runner calls its router back only while that router's run goes on there, or within 15 minutes of the router's `exec.prepare`. Over a member's own link, the member serves `sync.open` only for a session it asked that machine to run. When a member goes away, the central host cancels the runs it routed; when a runner goes away, or its link is replaced by a new connection, its routers hear `exec.lost`. A start that timed out or was cut off is cancelled, and the command runs elsewhere only when the runner answers that it has no such run; otherwise the run counts as gone mid-run, and is not run again unless listed under `rerun`, so it never runs twice by itself.
- **Environment.** Only the approved `[heavy] env` names cross, to whichever machine runs the command, as in X62.

## Out of scope

- Picking a run up again after its link connects again, with its output and exit status still delivered. A reconnect counts as the run being lost on both sides, so the session's host and the runner always agree on it. Picking up needs the runner to keep the run's output while the link is down, and both sides to match the run to the new connection.
- Direct links between members. `peer.call` is the relay's envelope, and a direct link would carry the same routing methods.
- Keeping a project off some hosts (for example, a work project that may run on the MacBook and the central host but nowhere else). Cloud machines already have X63's per-project opt-in.
- Routing between two accounts.
- Codex, chained and piped commands (X62).

## Test plan

Every acceptance criterion maps to at least one test below. Expected values are literals from this spec.

Where the tests live:

- **Rust unit:** `crates/moonlet-core/src/heavy.rs` (picking), the account log's record kinds in `moonlet-core`.
- **Daemon end-to-end:** `crates/moonletd/tests/mesh.rs` (a central host from before X89 is a test daemon with `MOONLET_TEST_BEFORE_X89`, which answers the new methods with `unknown_method`), with a central host and two member `TestDaemon`s linked as in `tests/link.rs`, a test-only load setting, and approvals made through the account. The cloud cases are in `tests/cloud.rs` with X63's fake provider.
- **Vitest:** `apps/desktop/src/lib/workers.test.ts`, `workerLink.test.ts`, `heavyApproval.test.ts`.
- **e2e:** `apps/desktop/e2e/specs/routing.e2e.ts`. Saving settings is a crucial feature.

| Criterion | Tests |
|---|---|
| Defaults | `a_new_member_takes_no_other_hosts_commands_and_has_two_slots` |
| Set from any app, offline members | `worker_settings_set_on_the_central_host_reach_the_host_they_name`, `settings_set_for_an_offline_member_apply_when_it_links` |
| Who changes them | `only_an_app_or_a_paired_mac_changes_worker_settings`, `worker_settings_set_on_the_central_host_reach_the_host_they_name` |
| Who a permission counts from | `a_member_that_writes_another_hosts_switch_does_not_turn_it_on`, `a_member_that_writes_an_approval_itself_does_not_get_its_command_run_on_another_member`, `settings_made_before_the_central_host_referees_them_still_count`, `a_runner_with_its_own_checkout_runs_only_what_that_checkout_lists_too`; X74's `a_list_a_members_daemon_writes_without_its_app_is_not_taken`; core `a_switch_another_member_writes_does_not_turn_a_host_on`, `an_approval_a_member_writes_without_its_app_counts_on_no_other_member`, `an_approval_made_in_a_members_app_counts_everywhere_once_the_central_host_takes_it`, `the_central_host_takes_only_a_members_own_asks_for_what_a_project_allows`, `copied_files_a_member_writes_without_its_app_are_not_taken`, `permissions_set_before_the_central_host_referees_them_still_count`, `a_new_central_host_keeps_what_the_old_one_counted_and_nothing_else`, `a_central_host_whose_worker_id_changed_keeps_refereeing_by_what_counted` |
| Slots range | `slots_outside_one_to_sixty_four_are_refused` |
| `link.set` and the Hosts page | `link_set_writes_the_hosts_own_worker_settings`; Vitest `workerLink.test.ts` "the central host's row gets its own switch, set on it directly (X89)", `settingsSearch.test.ts` "finds Takes heavy commands from other hosts on Hosts, also as the central host" |
| From `link.json` | `link_json_settings_become_the_accounts_at_first_start` |
| Turning off, lowering slots | `turning_heavy_off_takes_no_new_commands_and_lets_running_ones_finish` |
| Own sessions always run at home | `a_host_runs_its_own_sessions_commands_when_no_other_is_free` |
| A member's session is routed | `a_members_session_runs_its_heavy_command_on_the_central_host` |
| Approval for the account | `an_approval_on_one_member_lets_every_member_route_and_run_the_list`, `a_worker_runs_what_the_account_approved_without_approving_itself`, `approvals_from_heavy_json_reach_the_account_at_first_start`; core `a_heavy_approval_on_one_member_is_every_members`; Vitest "the approval toast names the account", "each machine, on a host from before X89" |
| Candidates, `heavy` off | `a_host_with_heavy_commands_off_takes_none_from_other_hosts` |
| Order (worked examples) | `picks_as_in_the_mesh_order_table`, `picks_as_in_the_order_table` |
| Slots across hosts | `a_host_with_no_free_slot_refuses_busy_and_the_next_one_runs_it`, `two_hosts_picking_one_slot_run_one_there_and_one_elsewhere` |
| The relay | `a_members_session_runs_its_heavy_command_on_another_member_through_the_central_host`, `the_central_host_passes_on_only_the_routing_methods`, `a_members_session_runs_its_heavy_command_on_another_member_through_the_central_host` |
| `peer` and older members | `the_central_host_passes_on_only_the_routing_methods`, `a_central_host_before_this_spec_leaves_members_running_their_own_commands` |
| Routing copies | `a_routing_copy_runs_the_setup_of_the_sessions_main_checkout`, `archiving_a_members_session_removes_its_routing_copies_on_other_hosts` |
| Going away | `a_runner_lost_after_its_run_started_is_not_run_again_by_default`, `a_runner_that_goes_away_mid_run_makes_the_command_run_again_on_the_sessions_host`, `a_member_reached_through_the_central_host_that_goes_away_mid_run_runs_it_again_on_the_sessions_host`, `losing_the_central_host_mid_relay_runs_the_command_again_on_the_sessions_host`, `a_runner_that_loses_the_sessions_host_stops_the_command`, `a_member_whose_central_host_goes_silent_mid_run_ends_the_run_in_a_bounded_time`, `a_member_without_its_central_host_runs_its_own_commands` |
| Cloud machines | `a_members_session_runs_on_the_projects_cloud_machine`, `a_members_busy_command_starts_an_overflow_machine`, `a_members_cloud_session_waits_for_the_central_hosts_machine`, `a_cloud_machine_takes_a_members_command_of_its_own_project_only`, `a_machine_running_a_members_command_outlives_its_idle_time_and_goes_after_it`, `a_members_command_counts_on_its_machine_while_its_copy_is_prepared`, `a_members_command_stops_counting_on_its_machine_once_the_member_goes_silent` |
| `worker.list` and the Workers page | `worker_list_lists_every_member_with_what_it_runs`, `exec_status_lists_what_a_host_runs_for_other_hosts`; Vitest "lists what each host runs for other hosts, and for whom", Vitest "lists every member with its switch and slots", "an offline member's row", "the summary line counts the account's slots", "says to update an older central host" |
| Saving from the app | e2e `worker-link.e2e.ts` "turning another host's heavy commands on from the Workers page saves it (X89)", `routing.e2e.ts` "a host's switch and slots on the Workers page are saved (X89)"; Vitest "says what a change of the switch or slots did" |

**Manual, still to do (the status says "untried between real machines" until then):** with the real central host and MacBook, a session on the MacBook routes `pnpm check` to the central host with the central host's switch turned on from the MacBook. Then a third member gets a command through the central host.

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
