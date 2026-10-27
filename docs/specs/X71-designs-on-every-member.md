# X71 — Design systems and workspace designs on every member

- **Status:** implemented (untried between two real Macs over Tailscale)
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0014](../adr/0014-one-account-across-hosts.md) (one account across hosts, delivery slice 7), [0013](../adr/0013-design-systems-and-designs.md) (design systems and designs)
- **Depends on:** [X68](X68-account-state.md) (the account log and its sync), [X64](X64-design-systems.md) (design systems), [X65](X65-design-mode.md) (workspace designs), [X60](X60-keep-in-sync.md) (the git plumbing that moves snapshots)

## Summary

Since X68 the app shows a shared workspace once, but Design mode still lists that workspace's design systems and designs from one member only. A design system built on the Mac mini does not appear on the MacBook, and a workspace merged with **Merge with…** leaves its design systems behind under the old workspace's id.

This spec gives every design system and workspace design an **owner**, the member where its agent runs, and a **read-only copy on every other member** of the account. Copies stay up to date over the link and remain readable while the owner is offline. **Move here** makes another member the owner, so its sync or design agent runs there from then on.

Rendering for the agent still needs the moonlet app on the owner (ADR 0013). Rendering on members without the app is ADR 0014's slice 6 and is out of scope.

## User journey

1. `studio-mini` and the MacBook are members of one account (X68). Months ago, on `studio-mini`, the user built the design system "Acme web" in the workspace "Acme".
2. After upgrading both, the user opens Design mode on the MacBook. "Acme web" is listed under Design systems, marked "from studio-mini". Its cards render from the MacBook's own copy.
3. The user opens a card. The view is the same as on `studio-mini`. **Sync** and the card settings are replaced by a line: "A copy from studio-mini · read only", with a **Move here** button.
4. On `studio-mini`, the sync agent updates three cards. Within a few seconds of the change being saved there, the MacBook's copy shows them.
5. `studio-mini` goes offline. The MacBook still shows "Acme web" and its cards.
6. The user presses **Move here** and confirms. The MacBook becomes the owner and maps the system's sources to its own clones by project identity. **Sync** is offered there now. When `studio-mini` comes back, its folder becomes a copy.
7. The workspace designs in "Acme" behave the same way: each is listed on every member, read only where it is a copy, with **Move here**.

## Behaviour and acceptance criteria

An **item** is one design system (`systems/<slug>/`) or one workspace design (`designs/<slug>/`) of a workspace. Session designs live in the worktree and are not items (X65).

### What an item's snapshot holds (core)

- [ ] A snapshot of an item is a git tree built from its folder. It leaves out `.cache/` (progress, render check, screenshots) and `.claude/`, which may hold settings that grant an agent permissions.
- [ ] A design system's snapshot also carries the portable part of its record as `record.toml`. That part is each source's identity, subdir and commit, plus `synced_at`, `last_sync` and `kept`. It never carries a source's project id or folder, the agent's terminal or launch, or `sync_start`.
- [ ] A workspace design's snapshot holds `design.toml` without `session`, and its pages, assets, comments and history.
- [ ] The same folder content gives the same tree id on every member.
- [ ] A link in an item's folder is left out of its snapshot, never followed (X64's folders never hold one).

### Owners and copies (daemon)

- [ ] Each item has an account record of kind `design` under an id of its own, since a deleted record never comes back (X68). Its fields are `workspace`, `kind` (`system` or `design`), `slug`, `name`, `owner` (the owner's worker id), `tree` (the latest published snapshot) and one `agent:<worker id>` field per member that owned it, in which that member says whether its agent is working. Only the current owner's field counts, so a former owner's late "not working" never hides the new owner's agent. A removed item's record is deleted.
- [ ] On first start with X71, each item on disk that has no record gets one, owned by this member. When another member already owns that key, this member's item is renamed to the next free slug (`<slug>-2`) before it is published, so neither is lost.
- [ ] A member with no central host owns every item it holds, as today.
- [ ] The owner publishes a new snapshot within 3 s of a change to the item's folder settling. A member owner first sends the objects the central host lacks (`design.offer`). Only once the central host holds the tree does it change `tree` in its record.
- [ ] Every other member that sees a `tree` it has not applied fetches the missing objects from the central host (`design.fetch`). It then replaces its copy's folder with that tree in one step, so a reader never sees half of a snapshot.
- [ ] A copy of a design system gets a record of its own. Each source maps to this member's project with the same identity (X41), and a source with no such project has no folder.
- [ ] Changes are carried by git objects, so a new snapshot sends only the files that changed.
- [ ] A copy is read only. Every RPC that changes an item, or starts or messages its agent, answers `not_owner` naming the owner. This covers `design.system.sync` and `.remove`, the sync agent's `design.system.progress` and `.synced`, `design.settle`, `design.check` of a design system (it rewrites the generated files) and of a design with `fix`, `design.write_page`, `design.comment.put` and `.resolve`, `design.snapshot.restore`, `design.viewport` and `design.remove`. Reading RPCs work on copies, and so do calls that make a new item of this member's own, such as `design.create` on a copied design system.
- [ ] A copy's sync or design agent never starts.
- [ ] A copy edited on disk by hand is replaced at the next snapshot it applies.
- [ ] When the owner removes an item, every copy of it is deleted.

### Move here

- [ ] `design.move` on a member makes it the owner of an item. It changes `owner` in the record to this member.
- [ ] Move refuses while this member's copy is older than the record's `tree`.
- [ ] Move refuses while the record says the owner's agent is working, unless `force` is set. A forced move is for an owner that is offline.
- [ ] After a move, the new owner's copy becomes its own item. Its sources stay mapped to its own clones, and its next sync works from them.
- [ ] A member that learns it no longer owns an item stops that item's agent. It then compares its folder with the record's `tree`. If its folder holds changes the new owner never received, they are kept under `$MOONLET_HOME/sync-leftovers/design-<workspace>-<slug>-<YYYYMMDD-HHMMSS>/` (X60's leftovers folder). Its folder then becomes a copy of the new owner's tree.
- [ ] When two members move the same item at once, both end with the same owner: the one with the later stamp (X68's last-writer-wins).
- [ ] An owner whose record names a tree it did not publish (a former owner's change sent late) takes that tree into its folder when its own folder has not changed since its last snapshot; otherwise it keeps its folder and writes the late tree to its leftovers. So a change made offline by the former owner is never lost.

### Merged workspaces

- [ ] `workspace.merge` moves the merged workspace's items into the workspace it merges into, on the member that owns them. A slug already taken there gets the next free suffix.
- [ ] The owner changes each moved item's record to its new workspace and slug. Members drop their copies under the merged workspace, and copies at the new place follow on every member.
- [ ] On start, items left under a workspace id that the account's `merges` maps to another workspace move the same way. This repairs merges made with v0.1.33.

### The app

- [ ] Design mode reads a shown workspace's design systems and designs from the app's own host whenever that host is a member of the workspace's account, since it holds a copy of every item. Otherwise it reads them from the shown host, as today.
- [ ] A copied item's row says "from <owner's name>". The design system view and the design screen show "A copy from <owner's name> · read only" and **Move here**. The design system view hides **Sync**, **Remove**, the settle actions and **Ask the sync agent to fix**; the design screen opens read only, as a snapshot preview does (no editing, no new comments, no restore), and hides **Remove**.
- [ ] While the owner's agent is working, a copy's row shows "Syncing on <host>" or "Working on <host>".
- [ ] **Move here** opens a confirmation naming the current owner. If the owner's agent is working, it says the owner looks busy and offers **Move anyway**.
- [ ] A copied design system with a source this host has not cloned says which project is missing after a move, and refuses **Sync** until it is cloned.

## UI

The design system view's header on a copy:

```
Acme web                                       from studio-mini
A copy from studio-mini · read only                [Move here]
```

The sidebar row of a copy carries the owner's host label in the muted style of the sidebar's "on <host>" (X68). The **Move here** confirmation: "Make this Mac the owner of Acme web? Its sync agent will run here from now on, with this Mac's clones of acme-web. studio-mini keeps a read-only copy." **Move here** / **Cancel**.

## Protocol and RPCs

- `design.offer {workspace, kind, slug, tree, base?}` with a pack (member → central host, worker connections only). It answers `true` once the central host holds every object of `tree`.
- `design.fetch {tree, have[]}` (member → central host, worker connections only). It answers with a pack of the objects needed for `tree` that are missing from the `have` trees.
- `design.move {workspace, kind, slug, force?}` (app → its member) → `true`, or `not_current` / `busy`.
- `design.systems` and `design.list` gain `owner: {worker, host_label} | null` (null when this member owns it) and `owner_agent: bool`.
- The new error code `not_owner` carries `{owner}`.
- The account log gains the record kind `design`. Older members keep it and pass it on unread (X68).

## Data and config

- `~/.moonlet/design/.store/` is a bare git repository holding every item's snapshots. `~/.moonlet/design/.store/copies.json` maps each item's record id to where its folder is, the tree it holds and whether this member owns it. Both are host-local.
- `$MOONLET_HOME/account.json` holds the `design` records (X68).
- The leftovers go in `$MOONLET_HOME/sync-leftovers/` (X60).

## Security considerations

- `design.offer` and `design.fetch` take only connections from a member's worker link. Phones, the CLI and cloud workers are refused. This is the gate `sync.*` uses (X60).
- An offered pack is unpacked into a quarantine repository and checked there; only the objects a tree that passes reaches go to the store, so a refused pack, or anything else a pack carries, leaves nothing behind. A pack over 256 MiB is refused before it is read. It must hold only regular files and folders: no links, no submodules, no `..`, no absolute paths, and no file an agent takes as instructions (a `.md` file whose name starts with `claude` or `agents`, in any case), which the sync agent would read after **Move here**. It must not exceed 256 MiB unpacked, and it must not hold `.cache/` or `.claude/`. A copy is written through the item's `cap-std` handle (`fsx`), which never follows a link.
- `record.toml` from a snapshot gives only the portable fields, and a source's `subdir` that is empty, absolute or has a `..` refuses the snapshot. A copy's source folders come from this member's own projects. A copied record never names a folder that the next sync agent would get as `--add-dir`.
- Settings that grant an agent permissions are never copied, because `.claude/` is left out. After **Move here**, the new owner installs its own, as at creation.
- ADR 0014's trust note applies: any member can publish items that every other member renders. Cards render in the sandboxed, no-network `moonlet-design://` frames, with site isolation (ADR 0013).

## Out of scope

- Rendering and the render check on a member without the app (ADR 0014 slice 6).
- Editing a copy, or merging edits made on two members. The owner alone writes.
- Session designs, which travel with their worktree (X65).
- The phone's Design view.
- Showing a design that lives only on a remote host that is not a member of the app's account.

## Test plan

- Core unit tests (`design/replica.rs`):
  - a snapshot's tree id for a fixed folder, compared with a literal;
  - `.cache/` and `.claude/` are left out;
  - a link is left out;
  - the portable record has no paths;
  - applying a tree replaces the folder and keeps no stale file;
  - a pack with a link, a `..` path or `.claude/` is refused.
- Core: `merge_workspace` moves the design folders, and a taken slug gets `-2`.
- Daemon integration (`crates/moonletd/tests/design_sync.rs`), with two or three daemons through the `tests/account.rs` helpers:
  - a system created on a member shows in the other member's `design.systems` with `owner`;
  - an edit on the owner reaches the copy within 5 s;
  - a copy answers `not_owner` to `design.system.sync`;
  - `design.move` changes the owner on both members, and the old owner's unpublished change lands in `sync-leftovers`;
  - removal deletes the copies;
  - a workspace design and its comments reach the copy;
  - items orphaned by a v0.1.33 merge move on start.
- Desktop Vitest (`lib/designReplica.test.ts`): which host Design mode reads from, a copy's labels, and which actions are hidden.
- e2e (`design-copies.e2e.ts`): with a second daemon linked as a member, a copied system shows "from <host>" and read only, and **Move here** makes **Sync** appear.
- Manual: two real Macs over Tailscale, the case from the journey.

## Open questions

- Should a copy's history (`history/`) stay bounded at 50 snapshots like the owner's, or follow whatever the owner has? This spec copies the owner's folder as is.
