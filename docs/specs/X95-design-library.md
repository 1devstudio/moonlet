# X95 — One design library for the account: every workspace sees every design system, and a design can be shared

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X64 (design systems), X65 (Design mode), X71 (designs on every member), X33 (Claude profiles), X32 (workspaces)
- **Related ADRs:** [0013](../adr/0013-design-systems-and-designs.md) (changed by this spec: design systems are no longer per workspace), [0014](../adr/0014-one-account-across-hosts.md)

## Summary

Since X64 a design system belongs to one workspace. A user who keeps one product's web app and its marketing site in two workspaces has to build the same design system twice, and the two copies drift. X64 left sharing out of scope.

This spec moves design systems into one **library** for the account. Every workspace lists every design system, and a design in any workspace can be built on any of them. A system still has its sources, its sync agent and its owner (X71), but no workspace.

Designs stay per workspace. A workspace design can be **shared**: it moves into the library and every workspace lists it, under **Shared designs**. **Stop sharing** moves it into the workspace the user is in.

## User journey

1. The user has the workspaces "Acme app" and "Acme site". Last month, in "Acme app", they built the design system "Acme web" from `acme-web`.
2. After upgrading, they open Design mode in "Acme site". "Acme web" is listed under **Design systems**, with its cards, as in "Acme app".
3. They press **New design**, pick "Acme web" and describe a pricing page. The design is made in "Acme site", and its agent reads "Acme web".
4. In "Acme app" they press **Sync** on "Acme web". The pricing page in "Acme site" picks up the new styles at its next reload, as a design in "Acme app" does.
5. They open the pricing design's `⋯` and choose **Share with every workspace**. It leaves "Acme site"'s **Designs** and shows under **Shared designs** in both workspaces.
6. In "Acme app" they open it, comment, and press **Build it**. The session starts in "Acme app", on a project of "Acme app".
7. Later, in "Acme app", they choose **Stop sharing**. The design moves into "Acme app" and is no longer listed in "Acme site".

## Behaviour and acceptance criteria

### The library on disk (core)

- [ ] Design systems live in `~/.moonlet/design/library/systems/<slug>/`, with their records in `~/.moonlet/design/library/.records/<slug>.toml`. `library` is reserved: a workspace id is 12 hex digits and never `library`.
- [ ] A system's slug is unique in the library. A new system whose name is in use gets the next free suffix (` 2`, `-2`), as within a workspace today.
- [ ] Creating, listing, syncing, checking, settling and removing a system act on the library whatever workspace the call names.
- [ ] A workspace design's `system` names a library system. Its pages keep linking `../../../systems/<slug>/styles.css`: a workspace's `systems/<path>` resolves to `library/systems/<path>`, for the store's resolver and the `moonlet-design://` scheme. Pages written before X95 need no rewrite.
- [ ] A session design keeps its pinned copy of the system (ADR 0013). `design.system.update` and "Design system updated" compare with the library system.
- [ ] Shared designs live in `~/.moonlet/design/library/designs/<slug>/`, with their records in `library/.records/designs/<slug>.toml`. Their pages link `../../../systems/<slug>/styles.css`, which resolves inside `library/`.

### Moving existing systems into the library (core and daemon)

- [ ] On start, the daemon moves each workspace's `systems/<slug>/` and its record into the library, for the systems this member owns (X71), or every system when there is no account. It moves the workspaces in the account's order, so on a clash the first workspace's system keeps its slug.
- [ ] A slug already in the library keeps both: the moved system gets the next free slug (`acme-web-2`) and name ("Acme web 2"). The designs of its workspace that use it are repointed to the new slug. So are the session designs of that workspace's open sessions, so their **Update** keeps comparing with the system they were made from.
- [ ] The move keeps a journal in `library/.records/move.toml`. A daemon stopped midway finishes the move at its next start, and never moves a system twice or loses one. A second start with nothing to move changes nothing.
- [ ] A system's sync agent is stopped before its folder moves, and the moved record names no chat, as after a workspace merge (X71): the next **Sync** starts a new one, in the library folder.
- [ ] A copy of another member's system (X71) under a workspace is deleted, not moved. It comes back in the library once its owner has moved it.
- [ ] The owner gives each moved system's account record `workspace = "library"` and its new slug. Other members drop their copies at the old place and fetch them at the new one (X71).
- [ ] A system record from a member older than X95, at a workspace's `systems/`, is ignored: its system shows once that member upgrades.
- [ ] `workspace.merge` no longer moves systems, only the merged workspace's designs (X71).

### The agents

- [ ] A system's sync agent runs in the Claude profile (X33) of the first workspace, in the account's order, whose sections hold the system's first source project. When no workspace holds it, the agent runs in the default profile.
- [ ] A shared design's agent runs in the profile of the workspace that holds its system's first source project, by the same rule.
- [ ] The sync agent's `progress`, `synced` and `snap` commands work from a library system's folder, and still act only on the system of their folder.
- [ ] A design's agent gets its library system's folder with `--add-dir` and its deny rule (X65), wherever the design is.
- [ ] `moonlet design system ls` lists the library. `moonlet design new --here` picks the library system built from the session's project, as before within the workspace.

### Sharing a design

- [ ] `design.share {workspace, slug}` moves a workspace design into the library, with its pages, comments, history and record. Its agent is stopped first; the next message starts it again in the library folder. A slug in use in the library gets the next free suffix. The answer is the new slug.
- [ ] `design.unshare {slug, into}` moves a shared design into the workspace `into`, under the next free slug there. The answer is the new slug.
- [ ] Share and unshare refuse while the design's agent is working (`busy`), and on a copy (`not_owner`, X71).
- [ ] `design.list {workspace}` gives the workspace's own designs, then every shared design with `shared: true` and `workspace: "library"`.
- [ ] A shared design is addressed as `{workspace: "library", slug}` in every design RPC.
- [ ] **Build it** on a shared design starts the session in the workspace the user is in, on one of that workspace's projects. A session design made from it records the library as its design's place.
- [ ] Removing a shared design removes it for every workspace, after the same confirmation as today.

### The app

- [ ] Design mode lists the library's design systems in every workspace, the same list in each. A system's row, view, cards and sync work as before.
- [ ] The New design system dialog offers the projects of every workspace as sources, the shown workspace's first, each under its workspace's name.
- [ ] The New design dialog offers every library system.
- [ ] A design's `⋯` menu has **Share with every workspace** for a workspace design, and **Stop sharing** for a shared one. Stop sharing says "Move <name> into <workspace>?".
- [ ] The sidebar shows **Shared designs** after **Designs**, when there is at least one. The Designs index has a **Shared designs** group after **Workspace designs**.
- [ ] A change to a library system reloads the pages that use it, in every workspace's open design.
- [ ] Cards and shared design pages are framed on `moonlet-design://<key>.library/<path>`, and a workspace design's pages on their workspace's host, as today.

## UI

Sidebar in Design mode:

```
+ New design                     ⇧⌘N
  Run action                      ⌘K
Design systems                     +
  Acme web                      2d ago
  Docs kit                      syncing
Designs
  Pricing page                  ● 3h ago
Shared designs
  Onboarding                    ● 1d ago
```

The design screen's `⋯` menu: **Share with every workspace** (or **Stop sharing**), then **Remove design…**. The share confirmation: "Share Pricing page with every workspace? It moves out of Acme site's designs and is listed under Shared designs in each workspace." **Share** / **Cancel**.

The New design system dialog groups its project picker by workspace, the shown workspace first.

## Protocol and RPCs

- The workspace `library` is accepted wherever a design RPC takes a workspace: `design.file`, `design.check`, `design.snap`, `design.cards`, `design.settle`, `design.system.*` and every design RPC that takes `{workspace, slug}` for a shared design.
- `design.systems {workspace}` gives the library's systems. `workspace` must still name an existing workspace or `library`, so an app talking to an older daemon gets that workspace's systems as before.
- `design.system.create {workspace, name, sources, cover?}` makes a library system. Its sources may be any project of this member.
- `design.share {workspace, slug}` → the new slug. `design.unshare {slug, into}` → the new slug. Both are app-only, like `design.move`.
- `design.list` entries gain `shared: bool`.
- `design.changed` for a library system or shared design carries `workspace: "library"`.
- The account record kind `design` (X71) carries `workspace: "library"` for systems and shared designs.

## Data and config

- `~/.moonlet/design/library/` holds `systems/`, `designs/` and `.records/`, laid out like a workspace's folder.
- `~/.moonlet/design/library/.records/move.toml` is the journal of the move from workspaces, removed once the move is done.
- A workspace folder keeps only `designs/` and `.records/designs/`.

## Security considerations

- The scheme's mapping of `<workspace>/systems/` to `library/systems/` resolves inside `~/.moonlet/design/library/systems/` only, never through a link, and never for any other folder of the library. A workspace host still serves no other workspace's files.
- A library system's sources may now come from projects of other workspaces. Each is still a project of this member, resolved by id, with its `subdir` inside it (X64), and the sync agent still cannot edit them.
- The sync agent's profile comes from the record's first source, which the agent cannot edit (`.records` is outside its folder).
- `design.share` and `design.unshare` are app-only: an agent's CLI and a phone get `forbidden`, so a design agent cannot move its own design into another workspace.

## Out of scope

- Per-system sharing, or hiding a system from a workspace. Every workspace sees every system.
- Sharing a design with some workspaces only.
- Merging two systems built from the same sources. The move keeps both.
- Session designs in closed or archived sessions keep their old slug after a rename at the move (Linear 1DE-64).
- The phone's Design view.

## Test plan

- Core (`design/store.rs`, `design/library.rs`):
  - a system made in one workspace is listed from another;
  - the move takes two workspaces' systems into the library, renames a clash to `acme-web-2` and "Acme web 2", and repoints that workspace's designs;
  - a move stopped midway finishes at the next run, and a second run changes nothing;
  - `resolve(<ws>, "systems/acme-web/styles.css")` is the library's file, and a link or `..` out of `library/systems/` is refused;
  - sharing and unsharing a design move its pages, comments and history, and take the next free slug.
- Daemon (`moonletd/tests/daemon.rs`):
  - `design.systems` lists the same systems for two workspaces;
  - a system's sync agent starts in the profile of its first source's workspace, and in the default profile when no workspace holds it;
  - a design made in another workspace's design mode starts its agent with the library system's folder;
  - a daemon started on a home with per-workspace systems lists them in the library, with the clash renamed;
  - `design.share` and `design.unshare` move a design, and an agent's CLI gets `forbidden`.
- Daemon, two members (`moonletd/tests/design_sync.rs`): the owner's move re-keys the account record, and the other member's copy follows at the library place.
- Tauri (`src-tauri/src/design_scheme.rs`): a workspace host serves `systems/<path>` from the library, and refuses a link out of it; a `library` host serves shared designs and cards.
- Desktop Vitest (`lib/designLibrary.test.ts`, `lib/designStore.test.ts`): the systems listed per workspace; the sidebar's Shared designs; the New design system dialog's projects grouped by workspace; a library system's change reloads a workspace design's page.
- e2e (`design-library.e2e.ts`): a system built in one workspace is listed and usable in another; **Share with every workspace** lists the design in both, and **Stop sharing** moves it into the shown workspace.

## Delivery plan

One `gh stack` on `main`. Each entry carries its criteria's tests and leaves `pnpm check` green.

| # | Entry | Scope |
|---|---|---|
| 1 | `x94/spec` | This spec, ADR 0013's change, `CONTEXT.md` |
| 2 | `x94/core-library` | The library folder, systems resolved there, the move from workspaces with its journal and renames |
| 3 | `x94/daemon` | RPC gate for `library`, the move on start with X71's re-keying, the agents' profile, the CLI |
| 4 | `x94/scheme` | The scheme's `systems/` mapping and the `library` host |
| 5 | `x94/shared-designs` | `design.share`, `design.unshare`, `design.list`'s shared designs, Build it from a shared design |
| 6 | `x94/desktop` | Design mode lists, dialogs, the `⋯` actions, Shared designs; e2e |

## Open questions

- None at the time of writing. The user decided on 2026-11-09: one library for every workspace, shared designs, the first source's workspace for the profile, keep both on a clash, and Stop sharing into the shown workspace.
