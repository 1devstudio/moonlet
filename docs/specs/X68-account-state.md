# X68 — One account: the same workspaces and sections on every host

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0014](../adr/0014-one-account-across-hosts.md) (one account across hosts), [0009](../adr/0009-central-host-workers-live-copies.md), [0011](../adr/0011-machines-connect-over-the-tailnet.md)
- **Depends on:** [X41](X41-worker-link-and-project-identity.md) (the link to the central host, project identity), [X32](X32-workspaces-and-sections.md) (workspaces and sections)

## Summary

The first slice of [ADR 0014](../adr/0014-one-account-across-hosts.md). Every host linked to the same central host is a **member** of one account, and every member keeps the **account state**: the workspaces and their sections, with the projects of each section named by their project identity. A change made on any member reaches the others within a few seconds while they are linked. A member that is offline keeps working, and its changes and the others' meet when it links again, with no step from the user.

The app then shows a workspace once, whichever members hold it, and lists its sessions from every connected member under it.

Session records, settings, devices and secrets join the account state in later slices (ADR 0014's delivery).

## User journey

1. The MacBook is linked to `studio-mini` (X41). Both have had moonlet for a while: the MacBook has the workspaces "Personal" and "Acme", `studio-mini` has "Personal".
2. The switcher lists "Personal", "Personal" and "Acme" once each, with no host headers; the two "Personal" rows differ in their summaries. Sessions running on `studio-mini` show in the MacBook's sidebar, marked "on studio-mini".
3. With the second "Personal" shown, the user picks **Merge with…** in the switcher, chooses the first, and confirms. One "Personal" remains, holding the sections of both, on both Macs.
4. On the MacBook the user renames section "Side projects" to "Experiments". A few seconds later the phone, connected to `studio-mini`, shows "Experiments".
5. On a train, offline, the user adds project `shop` to section "1devstudio" on the MacBook. At home, when the MacBook links again, `studio-mini` shows `shop` in "1devstudio" as well, marked "not on studio-mini" if it has no clone of it and the MacBook is not connected.

## Behaviour and acceptance criteria

### The account log (core)

- [x] The account state is a set of **records**, each with a kind (`workspace`, `section`), an id and named fields. A change sets one field of one record, or deletes a record; its wire form is `{stamp, seq, kind, id, op}`. (`a_change_reads_and_writes_as_the_protocol_says`)
- [x] Every change carries a **stamp**: a hybrid logical clock (wall time in ms, a counter) and the name of the log that made it. Stamps are totally ordered: time, then counter, then log name. (`changes_stamped_at_the_same_time_are_ordered_by_member`)
- [x] A member's clock never goes backwards: a change it makes is stamped later than every change it has seen, from itself or others, even when its wall clock is behind. A counter at its limit moves on to the next millisecond. (`a_change_made_here_comes_after_every_change_seen_even_with_a_clock_behind`, `a_counter_at_its_limit_moves_the_clock_on_instead_of_overflowing`)
- [x] A field's value is the one with the latest stamp, whatever order the changes arrive in. Applying the same change twice changes nothing. (`a_field_takes_the_latest_change_whatever_order_the_changes_come_in`, `a_member_that_missed_a_change_gets_exactly_what_it_lacks_and_both_agree`)
- [x] Deleting a record wins over every change to it with an earlier stamp, and a deleted record stays deleted: later field changes do not bring it back. (`a_deleted_record_stays_deleted_whatever_changes_it_later`)
- [x] Two members that have seen the same changes have the same state. (`a_member_that_missed_a_change_gets_exactly_what_it_lacks_and_both_agree`)
- [x] Each member keeps a **version**: for every log, the number of its changes seen, up to the first one missing. Given another member's version, it returns the changes the other has not seen; a change the other already holds past a gap is sent again and counts once. (`a_member_that_missed_a_change_gets_exactly_what_it_lacks_and_both_agree`)
- [x] Order inside a list (sections in a workspace) comes from **sort keys**: a key can always be made between two keys, before the first or after the last, and never ends in `0`. Two members placing a section at once can give two sections the same key; neither is lost, and a key asked for between equal keys comes after them. A bound with a character outside base 36, from another member, still gets a key between it and the other bound. (`sort_keys_fit_between_before_and_after_any_keys`, `a_key_between_keys_that_leave_little_room_stays_between_them`, `a_key_from_another_member_outside_base_36_still_gets_a_key_between`)
- [x] A saved log loads with its changes and goes on numbering its own. (`a_saved_log_reloads_with_its_changes_and_goes_on_counting`)

### Workspaces and sections from the log (daemon)

- [x] A workspace is a record with `name`, `color`, `claude_profile` (a profile name, mapped to a folder on each member) and `created_at`. A section is a record with `workspace`, `order` (a sort key), `name`, `view` and `created_at`, and one field per project, `project:<origin>|<root>`, holding the project's identity with its own sort key, or `null` once it is removed. So two members adding projects to one section at once both keep theirs, and a change touches only the projects it is about. A project added goes after the last one; only putting one's own projects in another order gives them new keys, so a member that lacks some of a section's projects never reorders it by changing something else. (`a_workspace_renamed_on_one_member_is_renamed_on_the_other`, `projects_two_members_add_to_one_section_at_once_are_both_kept`, `a_project_kept_here_for_its_sessions_does_not_come_back_on_the_other_member`, `another_members_section_keeps_its_project_order_through_this_members_changes`, `projects_reordered_on_one_member_are_in_that_order_on_the_other`)
- [x] Every RPC that changes workspaces or sections (`workspace.create`, `.update`, `.delete`, `section.create`, `.update`, `.delete`, `.move`, `.add_project`, `.remove_project`) writes changes to the log, and `workspace.list` and `section.list` are worked out from it. Their requests and replies keep their current shape, so older apps keep working; the X32 tests in `session.rs` run unchanged. (`sections_reordered_on_one_member_are_in_that_order_on_the_other`)
- [x] `section.list` gives each section's `project_ids` as this member's project ids, for the identities it has a project for. Identities it has no project for are listed in a new field, `missing: [ProjectIdentity]`; one leaves `missing` as soon as a clone of it is added here. A project without a root commit is this member's alone and stays out of the log. Two checkouts of one repository on one member are one project to the account, and both stay in the sections that hold them. (`a_sections_projects_are_this_members_clones_and_the_rest_are_missing`, `a_clone_added_here_is_no_longer_missing`, `two_checkouts_of_one_repository_on_one_member_both_stay`)
- [x] The rules X32 checks before a change (the last workspace cannot be deleted, a workspace with sections cannot be deleted, a section's projects move to another section) are checked against this member's state when the change is made. A deleted section's projects that this member lacks move with the rest. (`a_section_deleted_with_projects_this_member_lacks_hands_them_on`)
- [x] A shared project no section holds any more was removed on another member, and goes here too, unless it has live sessions here: then it stays, in this member's own first section, without coming back on the others. (`a_project_removed_on_one_member_goes_on_the_other`, `a_project_removed_elsewhere_stays_while_it_has_live_sessions_here`, `a_project_kept_here_for_its_sessions_does_not_come_back_on_the_other_member`)
- [x] Changes from different members can break those rules together, for example two members each deleting a different one of the last two workspaces. Every member then repairs the state the same way:
  - with no workspace left, or while a section names it, the workspace with the id `default`, named "Personal", is made; once `default` was deleted, `default-2`, and so on;
  - with no section left, the section `default-section`, "My projects", in the first workspace;
  - a section whose workspace is deleted moves to the workspace with the earliest `created_at`.

  (`members_that_deleted_the_last_workspaces_apart_make_the_same_one_and_fill_it_alike`, `a_section_moved_into_a_workspace_deleted_meanwhile_lands_in_the_same_place_on_both`)
- [x] The log is saved in `$MOONLET_HOME/account.json`, mode 0600, written through a temporary file. A request's changes are written beside it and moved into place only once `state.json` is saved, so an edit whose state could not be saved does not come back after a restart. (`the_log_is_readable_only_by_the_user`, `an_edit_whose_state_could_not_be_saved_does_not_come_back_after_a_restart`)
- [x] A file that cannot be read is moved aside to `account.json.<ms>.bad`, never over an earlier one, and the member makes its log again from `state.json` under a new name. Those changes are stamped as old as can be, so they give way to every change other members made meanwhile. (`an_unreadable_log_is_kept_aside_and_made_again_from_the_state`, `a_log_made_again_gives_way_to_changes_it_had_not_seen_and_keeps_every_bad_file`)
- [x] **Migration:** the first start with this slice turns `state.json`'s workspaces and sections into changes stamped by this member, keeping their ids. `state.json` keeps them as well, so going back to an older moonlet loses nothing made before the upgrade. Changes an older moonlet makes after that are not in the log, and the next start with this slice lays the log over them. (`a_state_from_before_the_account_becomes_its_changes_with_the_same_ids`)
- [x] A field whose value does not fit takes its default, and names lose control characters and surrounding space. (`a_field_that_does_not_fit_takes_its_default`)

### Syncing between members

- [x] A member with a central host (X41's `link.json`) keeps its link open while it has one, not only while heavy commands or copies need it. (`the_link_is_open_while_a_central_host_is_set_and_something_needs_it`, `turning_the_link_off_drops_the_worker_at_once_and_a_restarted_central_host_gets_it_back`)
- [x] A live copy (X60) waits until the link is registered before it asks for the session, since the link is now open before a copy starts. A routing copy (X62) does not wait: the central host asks for one only from a registered worker. (`a_copy_started_before_this_mac_is_registered_waits_for_it`)
- [x] Over the link, the member sends its version with `account.sync {version, changes}`. The central host applies the changes and replies with the changes the member lacks and its own version; the member then sends what that version lacks. (`changes_made_apart_meet_when_a_member_links_again`)
- [x] The central host sends `account.changed {changes}` to every other linked member when it takes in changes from a member or makes one itself: only the changes it had not seen and kept, and never to the member that sent them, to cloud machines, phones or apps. A member takes in news only from its current central host. A member that misses one catches up at its next `account.sync`, which it sends on every link and every 60 s. Of two changes sent under one number, only the first is kept and passed on. (`a_rename_on_one_member_reaches_the_others_within_three_seconds`, `a_member_that_missed_a_change_has_it_at_its_next_exchange`, `a_phone_never_hears_the_accounts_changes`, `a_change_the_central_host_already_holds_is_not_passed_on_again`, `two_changes_sent_under_one_number_reach_the_others_as_the_first_only`)
- [x] A central host whose account could not be loaded answers `account.sync` with `no_account`, and its members stop asking until they link again, as with a central host from before X68 (`unknown_method`). So does a machine the central host takes for no member (`forbidden`), such as one that joined as a cloud machine after its daemon started. (`a_central_host_whose_account_cannot_be_read_answers_no_account`)
- [x] A change made on a member reaches another member linked to the same central host within 3 s. (`a_rename_on_one_member_reaches_the_others_within_three_seconds`)
- [x] A member that is not linked keeps making changes. When it links again, both sides end with the same state, with every change of both kept per the rules above. (`changes_made_apart_meet_when_a_member_links_again`)
- [x] A change only ever reaches members of the same central host. A paired phone, or the `moonlet` CLI, cannot send `account.sync` (`forbidden`); nor can a cloud machine, which is not a member and keeps no account. (`only_a_linked_mac_syncs_the_account`, `a_cloud_device_may_call_only_worker_methods`)
- [x] `workspaces.changed`, `sections.changed`, `projects.changed` and `sessions.changed` fire on a member when it takes in changes from another member. (`another_members_change_says_workspaces_changed_to_this_macs_app`)

### The app

- [x] Each host says which account it shares, `account.get`: its central host's, named after that host's worker id, once the central host has said so in `account.sync`, else its own worker id. `account.info` says when it changes, as when a Mac links or its central host is removed. A daemon from before X68 says none, and the app takes it as its own account. (`a_host_says_which_account_it_shares`)
- [x] Each workspace of an account shows once in the switcher, whichever connected members of the account list it, with the sessions of all of them in its summary. A host outside the account keeps its own workspaces under its name, even one whose id matches, and the headers show only when more than one host has rows of its own. (`lists the account's workspaces once with every member's sessions, and a host outside it apart`)
- [x] Settings lists each workspace of an account once too, in its nav and its search, opening this Mac's copy while this Mac lists it and its daemon is connected, else a connected member's, with no host tag; a host outside the account keeps its own, tagged with its name, and named in the search's path. A workspace page opened on another member's copy highlights the account's entry. (`lists each workspace of an account once, this Mac's copy first and untagged, and a host outside the account apart under its name`, `lists a shared workspace from another member, untagged, while this Mac does not list it yet`, `lists a shared workspace from a connected member while this Mac's daemon is disconnected`, `leaves a shared workspace untagged when another member's workspaces arrive before this Mac's`, `highlights a shared workspace's entry when its page is open on another member's copy`, `names the host of a workspace outside this Mac's account, so two of one name differ`)
- [x] A workspace is shown on every member of its account, never on a host outside it; the shown workspace stays while a member of its account lists it, and moves to that member. (`shows a shared workspace on every member of its account, never on a host outside it`, `keeps showing a shared workspace from a member that still lists it`)
- [x] Each section of the shown workspace shows once, from the shown member first, with the sessions of every member of the account holding it. A project's sessions from several members are one group, matched by identity; the shown member's project filter picks the same projects on every member. A project only another member has shows there, marked "on studio-mini", as are session rows from another member; a project no connected member has is marked "not on <shown host>", and clicking it opens Get <name> on <shown host> (X70). A section several members hold has no `@host` tag. (`shows each project once with every member's sessions, newest first, and says where the rest are`, `filters every member by the projects picked on the shown one`, `lists the shown workspace's sections once, from the shown member first, with every member of its account holding each`, `builds each member's side of a section from what that member lists`)
- [x] ⌘1–9 go through the sessions in the sidebar's order, every member's merged, skipping folded sections and groups. (`orders sessions for ⌘1–9 as the sidebar shows them, skipping collapsed sections and groups`)
- [x] Switching back to a shared workspace reopens the session last open in it, on the member it is on. (`reopens the session last open in a shared workspace on the member it is on`)
- [x] A session started from the composer goes into the shown workspace on whichever member has the project. (`starts a session in the shown workspace on whichever member has the project`)
- [x] A workspace's Tasks board, and the task lines in the sidebar, take the sessions of every member of its account, each opened on its own member and matched to the board's GitHub repository by project identity. Keep in step (X46) acts on this Mac's own sessions only, so two apps never move one issue twice. (`takes every member's sessions of the workspace, each with its host and its project's repository`, `lists the hosts of a workspace's account that list it, its own host first`)
- [x] A shared workspace shows the attention dot when a session on any member needs you. (`marks a shared workspace when a session on any member needs you`)
- [x] Two workspaces with the same name on different members are both shown until the user merges them, each saying which Mac made it ("from studio-mini"): each member gives the account its name, and a workspace's maker is the member whose change made it. **Merge with…** in the switcher lists the other workspaces of the same account, asks first, saying what a new Claude profile does to running agents, and merges on a member that lists both. A merge moves the merged workspace's sessions into the chosen one on every member. (`a_workspace_says_which_member_made_it`, `merges a workspace only into another of its account, on a member that lists both`, `asks before merging, saying what moves and what goes, and what a new profile does to running agents`, `warns of a new Claude profile only when merging moves running agents to another one`, `sessions_of_a_merged_workspace_join_the_chosen_one_on_the_other_member_too`)
- [x] The first time this Mac shares an account, the app says "Workspaces are now shared with studio-mini", once. (`says once that this Mac's workspaces are now shared with its central host`)
- [x] A Mac whose central host is removed is its own account again and keeps the workspaces it got while it was a member, as every member keeps the whole account. They can be merged or deleted like any other. The e2e specs that link the app's daemon remove them afterwards, so later specs see only their own. (`a_host_says_which_account_it_shares`)

## UI

- Switcher: one list for the account's workspaces, no host headers; a host outside the account keeps its header and its workspaces below. Two workspaces of one name each say "from <Mac>" under their name.
- Switcher menu: **Merge with…** under Workspace settings…, which opens the list of the account's other workspaces; picking one asks "Move the 1 section of this Personal, with its sessions, into the other Personal, and delete this one? Every Mac sharing them gets the change." and, when the target uses another Claude profile and agents run, what that does to them.
- Section: one block per shared section. Rows and project groups from another member end with "on studio-mini" in the faint mono style of the old `@host` tag; a project no connected member has shows a dashed square for its mark and "not on <host>", and clicking it opens Get blog on This Mac ([X70](X70-get-a-missing-project.md)).
- A toast, once per account: "Workspaces are now shared with studio-mini".

## Protocol and RPCs

- `account.sync {version: {<member id>: u64}, changes: [Change]}` → `{changes: [Change], version}`. Members only.
- Event `account.changed {changes: [Change]}`, from the central host to members.
- `Change`: `{stamp: {ms, n, member}, seq, kind, id, op}`, where `op` is `{"set": {field, value}}` or `"delete"`, and `seq` counts the changes its member has made, from 1; versions are built from it.
- `section.list`: each section gains `missing: [ProjectIdentity]`.
- `workspace.merge {id, into}` → `true`: moves the sections of `id` into `into`, after its own, with every session of `id`, and deletes `id`. Merging a workspace into itself, or with one that does not exist, fails and changes nothing. (`a_merged_workspace_hands_its_sections_and_sessions_to_the_chosen_one_on_every_member`, `a_workspace_merges_only_into_another_existing_one`, `workspaces_merged_on_one_member_are_one_on_the_others`)
- `account.sync`'s reply gains `account`, the account the central host shares.
- `account.get` → `{account, central}`, and the event `account.info` with the same, when it changes.
- `workspace.list`: each workspace gains `made_by`, the name of the member that made it.
- The log gains two kinds of record: `member` (by log name: `name`) and `merge` (by merged workspace: `into`).
- No protocol change: the methods are new and the fields optional. A central host from before X68 answers `unknown_method`, and the member keeps its workspaces to itself until moonlet is updated there.

## Data and config

- `$MOONLET_HOME/account.json`: `{member, changes: [Change], former?: [log name]}`, mode 0600. The clock and this member's count are worked out again from the changes when it loads, so they never disagree with them.
- `$MOONLET_HOME/workers.json` on a central host: `{<worker id>: <paired device id>}`, mode 0600.
- `state.json` keeps its workspaces and sections, written from the account state on every change, so an older daemon reads the current ones.
- Each log has its own id, named after X41's worker id from `link.json` with a random suffix (`7d3f1c2a-….k3x9q2`). A log made again, after the file was lost or unreadable, gets a new one, so it never numbers its changes as the lost log did. A log named after another worker id, as when `link.json` was made again, goes on under a new name after the current one, keeping its earlier changes under their old name, since the central host takes changes only under the sender's worker id (`a_log_named_after_an_older_worker_id_goes_on_under_the_new_one`, `a_central_host_whose_worker_id_changed_goes_on_under_the_new_one_and_keeps_its_history`).

## Security considerations

- Only linked members send changes: `account.sync` is answered only on a paired Mac's connection that has registered as a worker (X41), whatever client name a connection gives. A phone or the CLI cannot write the log directly; they go through the RPCs, as today. (`only_a_linked_mac_syncs_the_account`)
- Only a Mac or a cloud machine registers as a worker: a phone could otherwise take a Mac's worker id before it, and keep it from linking. (`a_phone_never_registers_as_a_worker`)
- Which paired device owns each worker id is saved in `$MOONLET_HOME/workers.json`, mode 0600, so a restart of the central host never frees a worker id for another paired Mac to take. A device that was removed owns nothing any more. (`a_worker_id_stays_with_its_mac_across_a_restart_of_the_central_host`, `a_mac_removed_and_paired_again_links_with_its_worker_id`)
- A member sends only the changes it made: the central host drops any change in `account.sync` whose log name is not exactly `<worker id>.<6 letters or digits>` for the worker registered on that connection, so a member cannot take another member's change numbers first. No worker id this host's own logs ever had, current or former, is one a member may claim: every version names them. A central host that lost its log loses nothing by this, since its state already holds every member's work and becomes its new log. (`a_member_sends_only_its_own_changes`, `no_member_sends_changes_as_the_central_host`, `a_central_host_whose_worker_id_changed_goes_on_under_the_new_one_and_keeps_its_history`) The central host passes every member's changes on to the others; members trust it with the account, as ADR 0014 trusts every member. The log's history is guarded too:
  - a change under a member and number already seen never replaces the first one, nor moves the clock (`a_change_that_comes_again_with_other_content_does_not_replace_the_first`);
  - a change stamped more than a day ahead of the receiving member's clock is refused and logged, and never passed on, since it would win every field from then on and pull every clock forward with it (`a_change_stamped_more_than_a_day_ahead_is_refused`).
- A log named after an older worker id (link.json made again) goes on under a new name and takes over the old log's changes as its own, with their times, so changes made before the rename still reach the central host. The old name stays reserved. (`edits_made_before_a_macs_worker_id_changed_reach_the_central_host`, `a_log_named_after_an_older_worker_id_goes_on_under_the_new_one`)
- Values are checked again when applied: names lose control characters and surrounding space, colours must be known, a `view` must parse, and project identities must parse. A field whose value fails its check takes its default (the name "Personal" or "My projects", the default colour and view, no projects); the change stays in the log, so versions stay in step.
- The log never holds paths or secrets.

## Out of scope

- Session records, owners and copies on the central host (ADR 0014's slices 3 and 4). Sessions stay on the member that has them; the app only lists them under the shared workspace.
- Cloning a project that a member does not have.
- Settings, paired devices and secrets in the account state.
- Merging workspaces automatically by name.
- Adding a project that another member has on this one (a clone from its origin).
- Shortening the log. It grows with every change; compaction comes once it matters.

## Test plan

- **Rust unit (`moonlet-core`, the account log):** stamps and clock order, a clock behind wall time, last change wins in any order, duplicates, deletion beats earlier and later field changes, two members converging from the same changes in different orders, versions and the changes they select, sort keys between, before and after.
- **Rust unit (`moonlet-core`, workspaces from the log):** migration from a captured `state.json`, X32's checks, the repairs for concurrent deletes, `missing` identities.
- **Daemon e2e (`crates/moonletd/tests/account.rs`):** two members linked to one central host see each other's rename within 3 s; an unlinked member's changes and the central host's meet after linking; a phone is refused `account.sync`.
- **Vitest (`apps/desktop/src/lib/`):** one switcher list from several members, sessions of a shared workspace from every member, missing projects, workspaces kept apart until merged.
- **e2e:** none in this slice; it needs two daemons linked over the tailnet.
- **Manual:** the MacBook and `studio-mini` over a real tailnet: rename on one, see it on the other and on the phone.

## Open questions

None open. Decided by the user on 2026-10-26:

- **Same-name workspaces stay apart until the user merges them** with **Merge with…**, never merged by name on their own: two "Personal" workspaces on different machines may not be the same.
