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
- [x] Order inside a list (sections in a workspace) comes from **sort keys**: a key can always be made between two keys, before the first or after the last, and never ends in `0`. Two members placing a section at once can give two sections the same key; neither is lost, and a key asked for between equal keys comes after them. (`sort_keys_fit_between_before_and_after_any_keys`, `a_key_between_keys_that_leave_little_room_stays_between_them`)
- [x] A saved log loads with its changes and goes on numbering its own. (`a_saved_log_reloads_with_its_changes_and_goes_on_counting`)

### Workspaces and sections from the log (daemon)

- [ ] A workspace is a record with `name`, `color`, `claude_profile` (a profile name, mapped to a folder on each member) and `created_at`. A section is a record with `workspace`, `order` (a sort key), `name`, `view`, `projects` (project identities) and `created_at`.
- [ ] Every RPC that changes workspaces or sections (`workspace.create`, `.update`, `.delete`, `section.create`, `.update`, `.delete`, `.move`, `.add_project`, `.remove_project`) writes changes to the log, and `workspace.list` and `section.list` are worked out from it. Their requests and replies keep their current shape, so older apps keep working.
- [ ] `section.list` gives each section's `project_ids` as this member's project ids, for the identities it has a project for. Identities it has no project for are listed in a new field, `missing: [ProjectIdentity]`.
- [ ] The rules X32 checks before a change (the last workspace cannot be deleted, a workspace with sections cannot be deleted, a section's projects move to another section) are checked against this member's state when the change is made.
- [ ] Changes from different members can break those rules together, for example two members each deleting a different one of the last two workspaces. Every member then repairs the state the same way: with no workspace left, the workspace with the id `default`, named "Personal", is made; a section whose workspace is deleted moves to the workspace with the earliest `created_at`.
- [ ] The log is saved in `$MOONLET_HOME/account.json`, written atomically. A file that cannot be read is moved aside to `account.json.bad` and the member starts from its `state.json`.
- [ ] **Migration:** the first start with this slice turns `state.json`'s workspaces and sections into changes stamped by this member, keeping their ids. `state.json` keeps them as well, so going back to an older moonlet loses nothing made before the upgrade.

### Syncing between members

- [ ] A member with a central host (X41's `link.json`) keeps its link open while it has one, not only while heavy commands or copies need it.
- [ ] Over the link, the member sends its version with `account.sync {version, changes}`, carrying the changes it believes the central host lacks. The central host applies them and replies with the changes the member lacks.
- [ ] The central host sends `account.changed {changes}` to every other linked member when it applies a change from any member or makes one itself. A member that misses one catches up at its next `account.sync`, which it sends on every link and every 60 s.
- [ ] A change made on a member reaches another member linked to the same central host within 3 s.
- [ ] A member that is not linked keeps making changes. When it links again, both sides end with the same state, with every change of both kept per the rules above.
- [ ] A change only ever reaches members of the same central host. A paired phone, or the `moonlet` CLI, cannot send `account.sync` (`forbidden`).
- [ ] `workspaces.changed` and `sections.changed` fire on a member when changes from another member change what it lists.

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
- `PROTOCOL_VERSION` goes up.

## Data and config

- `$MOONLET_HOME/account.json`: `{member, changes: [Change]}`, mode 0600. The clock and this member's count are worked out again from the changes when it loads, so they never disagree with them.
- `state.json` keeps its workspaces and sections, written from the account state on every change, so an older daemon reads the current ones.
- The member id is X41's worker id from `link.json`.

## Security considerations

- Only linked members, authenticated by their device token (X41), send or receive changes. A phone or the CLI cannot write the log directly; they go through the RPCs, as today.
- Values are checked again when applied: names are cut and cleaned as `workspace.create` cleans them, colours must be known, a `view` must parse, and project identities are normalized origins without credentials (X41). A change that fails a check is kept in the log, so versions stay in step, but is not applied.
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
