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
2. The MacBook's app shows a one-time notice: "Workspaces are now shared with studio-mini". The switcher lists "Personal", "Personal" and "Acme" once each, with no host headers; each "Personal" row says which host it came from.
3. The user picks **Merge with…** on the second "Personal" and chooses the first. One "Personal" remains, holding the sections of both.
4. On the MacBook the user renames section "Side projects" to "Experiments". A few seconds later the phone, connected to `studio-mini`, shows "Experiments".
5. On a train, offline, the user adds project `shop` to section "1devstudio" on the MacBook. At home, when the MacBook links again, `studio-mini` shows `shop` in "1devstudio" as well, marked "Not on studio-mini" if it has no clone of it.

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

- [x] A workspace is a record with `name`, `color`, `claude_profile` (a profile name, mapped to a folder on each member) and `created_at`. A section is a record with `workspace`, `order` (a sort key), `name`, `view` and `created_at`, and one field per project, `project:<origin>|<root>`, holding the project's identity with its own sort key, or `null` once it is removed. So two members adding projects to one section at once both keep theirs, and a change touches only the projects it is about. (`a_workspace_renamed_on_one_member_is_renamed_on_the_other`, `projects_two_members_add_to_one_section_at_once_are_both_kept`, `a_project_kept_here_for_its_sessions_does_not_come_back_on_the_other_member`)
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
- [x] The central host sends `account.changed {changes}` to every other linked member when it takes in changes from a member or makes one itself: only the changes it had not seen and kept, and never to the member that sent them, to cloud machines, phones or apps. A member takes in news only from its current central host. A member that misses one catches up at its next `account.sync`, which it sends on every link and every 60 s. (`a_rename_on_one_member_reaches_the_others_within_three_seconds`, `a_member_that_missed_a_change_has_it_at_its_next_exchange`, `a_phone_never_hears_the_accounts_changes`)
- [x] A central host whose account could not be loaded answers `account.sync` with `no_account`, and its members stop asking until they link again, as with a central host from before X68 (`unknown_method`).
- [x] A change made on a member reaches another member linked to the same central host within 3 s. (`a_rename_on_one_member_reaches_the_others_within_three_seconds`)
- [x] A member that is not linked keeps making changes. When it links again, both sides end with the same state, with every change of both kept per the rules above. (`changes_made_apart_meet_when_a_member_links_again`)
- [x] A change only ever reaches members of the same central host. A paired phone, or the `moonlet` CLI, cannot send `account.sync` (`forbidden`); nor can a cloud machine, which is not a member and keeps no account. (`only_a_linked_mac_syncs_the_account`, `a_cloud_device_may_call_only_worker_methods`)
- [x] `workspaces.changed`, `sections.changed`, `projects.changed` and `sessions.changed` fire on a member when it takes in changes from another member. (`another_members_change_says_workspaces_changed_to_this_macs_app`)

### The app

- [ ] Each workspace shows once in the switcher, whichever connected members list it, without host headers. Sessions of a workspace come from every connected member that lists it, and a session row from another member names it ("on studio-mini").
- [ ] A section lists its projects from every connected member, once per identity. A project that only some members have is shown on the members that have it; one that the shown member does not have is marked "Not on <host>".
- [ ] Two workspaces with the same name on different members are both shown until the user merges them. **Merge with…** in a workspace's menu moves its sections into the chosen workspace and deletes it.
- [ ] Members that are not linked to the same central host (a remote host added over SSH, a host with no central host) keep their own workspaces and show under a host header, as today.

## UI

- Switcher: one list. A workspace that came from only one member before a merge shows that member under its name ("from studio-mini") until merged. Hosts that are not members keep their headers below.
- Workspace menu: **Merge with…**, a list of the other workspaces.
- Section: a project missing on the shown member has a dotted avatar and "Not on studio-mini"; clicking it says that adding it there comes in a later slice.
- The first time the app sees a member's workspaces shared, it shows the notice "Workspaces are now shared with <central host>" once.

## Protocol and RPCs

- `account.sync {version: {<member id>: u64}, changes: [Change]}` → `{changes: [Change], version}`. Members only.
- Event `account.changed {changes: [Change]}`, from the central host to members.
- `Change`: `{stamp: {ms, n, member}, seq, kind, id, op}`, where `op` is `{"set": {field, value}}` or `"delete"`, and `seq` counts the changes its member has made, from 1; versions are built from it.
- `section.list`: each section gains `missing: [ProjectIdentity]`.
- `workspace.merge {id, into}`: moves the sections of `id` into `into`, after its own, and deletes `id`.
- No protocol change: `account.sync` is a new method and `missing` an optional field. A central host from before X68 answers `unknown_method`, and the member keeps its workspaces to itself until moonlet is updated there.

## Data and config

- `$MOONLET_HOME/account.json`: `{member, changes: [Change]}`, mode 0600. The clock and this member's count are worked out again from the changes when it loads, so they never disagree with them.
- `state.json` keeps its workspaces and sections, written from the account state on every change, so an older daemon reads the current ones.
- Each log has its own id, named after X41's worker id from `link.json` with a random suffix (`7d3f1c2a-….k3x9q2`). A log made again, after the file was lost or unreadable, gets a new one, so it never numbers its changes as the lost log did.

## Security considerations

- Only linked members send changes: `account.sync` is answered only on a paired Mac's connection that has registered as a worker (X41), whatever client name a connection gives. A phone or the CLI cannot write the log directly; they go through the RPCs, as today. (`only_a_linked_mac_syncs_the_account`)
- A member sends only the changes it made: the central host drops any change in `account.sync` whose log is not named after the worker id registered on that connection, so a member cannot take another member's change numbers first. A central host that lost its log loses nothing by this, since its state already holds every member's work and becomes its new log. (`a_member_sends_only_its_own_changes`) The central host passes every member's changes on to the others; members trust it with the account, as ADR 0014 trusts every member. The log's history is guarded too:
  - a change under a member and number already seen never replaces the first one, nor moves the clock (`a_change_that_comes_again_with_other_content_does_not_replace_the_first`);
  - a change stamped more than a day ahead of the receiving member's clock is refused and logged, since it would win every field from then on and pull every clock forward with it (`a_change_stamped_more_than_a_day_ahead_is_refused`).
- Values are checked again when applied: names lose control characters and surrounding space, colours must be known, a `view` must parse, and project identities must parse. A field whose value fails its check takes its default (the name "Personal" or "My projects", the default colour and view, no projects); the change stays in the log, so versions stay in step.
- The log never holds paths or secrets.

## Out of scope

- Session records, owners and copies on the central host (ADR 0014's slices 3 and 4). Sessions stay on the member that has them; the app only lists them under the shared workspace.
- Cloning a project that a member does not have.
- Settings, paired devices and secrets in the account state.
- Merging workspaces automatically by name.
- Shortening the log. It grows with every change; compaction comes once it matters.

## Test plan

- **Rust unit (`moonlet-core`, the account log):** stamps and clock order, a clock behind wall time, last change wins in any order, duplicates, deletion beats earlier and later field changes, two members converging from the same changes in different orders, versions and the changes they select, sort keys between, before and after.
- **Rust unit (`moonlet-core`, workspaces from the log):** migration from a captured `state.json`, X32's checks, the repairs for concurrent deletes, `missing` identities.
- **Daemon e2e (`crates/moonletd/tests/account.rs`):** two members linked to one central host see each other's rename within 3 s; an unlinked member's changes and the central host's meet after linking; a phone is refused `account.sync`.
- **Vitest (`apps/desktop/src/lib/`):** one switcher list from several members, sessions of a shared workspace from every member, missing projects, workspaces kept apart until merged.
- **e2e:** none in this slice; it needs two daemons linked over the tailnet.
- **Manual:** the MacBook and `studio-mini` over a real tailnet: rename on one, see it on the other and on the phone.

## Open questions

- **Same-name workspaces:** shown twice until merged by hand (this spec), or merged automatically on the first link? Proposed: by hand, as two "Personal" workspaces may not be the same.
