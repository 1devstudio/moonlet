# X64 — Design systems from a project's code

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X65 (Design mode), X22 (the `moonlet` skill), X32 (workspaces), X54 (new session composer)
- **Related ADRs:** none yet (see Open questions)

## Summary

A **design system** is a folder of plain HTML and CSS that shows a project's UI as it is in the code. It holds the project's tokens (colours, type, spacing, radius, shadows), one **card** per component (with each variant and state), the custom elements only this project has, and **layouts**: whole screens such as an app shell or a settings page. An agent builds it by reading the source and writing static HTML. No build step and no running app are needed, so it works for any stack. The design system belongs to a moonlet workspace, and every project and every design (X65) in that workspace can use it. A later sync updates only the cards whose source changed. It never replaces the whole folder, so manual fixes to cards are kept.

The card format follows Claude Design's (`<!-- @dsCard … -->` on the first line, `_ds_manifest.json`), so a design system can also be pushed to Claude Design with `/design-sync` if the user wants.

## User journey

1. In Design mode (X65), the user clicks **New design system**, names it (for example "moonlet desktop"), and picks one or more projects of the workspace as its sources.
2. moonlet starts a **sync agent**: Claude Code, running in the design system's folder, with read access to the source projects. It follows the `moonlet-design` skill and goes through four steps: **Inventory**, **Tokens**, **Cards**, **Layouts**. The Design system view shows its progress as each step finishes.
3. The **Design system view** shows the cards grouped as the agent grouped them (Foundations, Buttons, Forms, Navigation, Data display, Feedback, Custom, Layouts). Each card renders in a frame at its viewport. A card the check flagged has a warning badge.
4. The user opens a card that looks wrong, comments on it (X65 comments work on cards too) or edits it in the visual editor, and the agent fixes it.
5. Weeks later, the source has moved on. The design system's header says **3 sources changed since sync**. **Sync** starts the agent again. It reads the commits since the recorded one and rewrites only the cards whose sources changed. A card the user edited by hand is shown as a proposed change, not overwritten.
6. An agent in any session can start the same thing: the user types `/moonlet-design sync` in a Claude Code session of a project, and the agent runs `"$MOONLET_BIN" design system new --from <project>`.

## Behaviour and acceptance criteria

### Storage

- [ ] A design system lives in `~/.moonlet/design/<workspace id>/systems/<slug>/`. Its slug comes from its name, and a name already in use gets a ` 2` suffix.
- [ ] `system.toml` holds the name, the source projects (by project identity, X41, plus the path on this Mac), the commit each source was synced at, and the created and synced times. A setting at its default is not written.
- [ ] The folder holds `tokens.css` (`:root` custom properties only), `base.css` (resets, fonts, the classes the cards share), `components/<group>/<name>.html`, `layouts/<name>.html`, `assets/` (fonts, icons, images copied from the source), `GUIDE.md` (when to use which component, written for agents) and a generated `_ds_manifest.json`.
- [ ] A workspace lists its design systems in Design mode. Deleting one asks first and leaves the designs that use it. Those designs then show "Design system removed".

### Cards

- [ ] A card's first line is `<!-- @dsCard group="<group>" name="<name>" source="<path>[,<path>…]" viewport="<w>x<h>" -->`. `source` lists the files, relative to the source project, that the card was made from.
- [ ] A card links only `../../tokens.css` and `../../base.css` (or `../tokens.css` from `layouts/`) and files under `assets/`. It has no script and no URL outside the design system.
- [ ] Each variant and state the source defines (for example a button's primary, secondary, ghost, danger, small, disabled, loading) is one labelled example in the card.
- [ ] Each example is also a **snippet**: `<template data-ds-snippet="<group>/<name>/<variant>">` with the markup a design inserts. The component palette (X65) lists snippets.
- [ ] A custom element, one the project defines and no common library has (in moonlet: the session row, the state glyph, the agent turn footer), is a card in group **Custom**.
- [ ] A layout composes snippets into a whole screen with realistic data, at the viewport its card names.

### Check (`moonlet design check`)

- [ ] `"$MOONLET_BIN" design check <system>` reports, per file:
  - a missing or malformed `@dsCard` line
  - a `var(--x)` that `tokens.css` does not define
  - a URL outside the design system (`http:`, `https:`, `//`, an absolute path)
  - a `<script>` element or an `on*` attribute in a card
  - two snippets with the same id

  It exits non-zero when a file has a problem.
- [ ] The check rewrites `_ds_manifest.json` from the cards' `@dsCard` lines: group, name, path, viewport, source and snippet ids, sorted by group then name.
- [ ] The sync agent is told by the skill to run the check after each step and fix what it reports before it moves on.

### Sync

- [ ] **New design system** and **Sync** start a sync agent: a Claude Code terminal owned by moonletd, in the design system's folder, with each source project's path given to Claude Code with `--add-dir`. Its prompt names the step to run and the skill.
- [ ] The agent reports progress with `"$MOONLET_BIN" design system progress <system> <step> [<note>]`. The Design system view shows the steps with the current one highlighted.
- [ ] At the end, the agent runs `"$MOONLET_BIN" design system synced <system>`, which records each source's current `HEAD` in `system.toml`.
- [ ] On a later sync, moonlet gives the agent the files changed in each source since its recorded commit, and the cards whose `source` lists one of them. The agent rewrites only those cards and adds cards for new components. A card whose source file was deleted is listed as **orphaned**, and the user removes it.
- [ ] A card changed since the last sync by something other than the sync agent (the visual editor, a design agent) is not overwritten. The sync writes the new version beside it as `<name>.proposed.html`, and the Design system view offers **Keep mine** or **Use synced**.
- [ ] The header shows `<n> sources changed since sync` when a source project's `HEAD` differs from the recorded commit in a file some card lists. It checks when Design mode opens and when the user switches to the design system.

### Skill and CLI

- [ ] moonlet installs a `moonlet-design` skill beside the `moonlet` skill (X22), in `~/.claude/skills/moonlet-design` and `~/.codex/skills/moonlet-design`, marked as moonlet's and refreshed on upgrade the same way.
- [ ] The skill describes the folder layout, the card format, the four sync steps, the check, and the CLI commands of X64 and X65. It tells the agent to copy values from the source and not to invent them, and to keep the project's own names for components.
- [ ] `/moonlet-design sync` in a session of a project makes the agent run `design system new --from <that project>`, or `design system sync <system>` when the workspace already has a design system with that project as a source. The new or synced design system opens in Design mode with a toast, and the user's focus does not move (as X22 does).
- [ ] CLI: `moonlet design system ls|new|sync|progress|synced|rm` and `moonlet design check`. Each prints JSON, like the other `moonlet` commands (A6).

## UI

```
┌ Design ──────────┬──────────────────────────────────────────────────────────┐
│ Workspace ▾      │ moonlet desktop · 2 sources · synced 3 days ago  [Sync]   │
│ Sessions Tasks D │ ⚠ 3 sources changed since sync                            │
│                  ├─────────────┬────────────────────────────────────────────┤
│ DESIGN SYSTEMS   │ Foundations │ ┌ Buttons ───────────────────────────────┐ │
│ ● moonlet desktop│  Colours    │ │ [Primary] [Secondary] [Ghost] [Danger] │ │
│ ○ storefront     │  Type       │ │  small · disabled · loading            │ │
│ + New design sys │ Buttons     │ └────────────────────────────────────────┘ │
│                  │ Forms       │ ┌ Session row (Custom) ⚠ ────────────────┐ │
│ DESIGNS          │ Custom      │ │ …                                      │ │
│ …  (X65)         │ Layouts     │ └────────────────────────────────────────┘ │
└──────────────────┴─────────────┴────────────────────────────────────────────┘
```

- Empty: "No design system yet. Build one from a project's code." with **New design system**.
- While syncing: the four steps with the current one spinning, and **Open agent** to watch the chat.
- A card's `⋯`: **Open source** (the first file in `source`, in the project's code viewer, F2), **Comment**, **Edit**, **Copy snippet**.

## Protocol and RPCs

- `design.systems {workspace}` → `[{slug, name, sources, synced_at, changed_sources, step}]`
- `design.system.create {workspace, name, projects}` → the system. Starts the sync agent.
- `design.system.sync {workspace, slug}` starts the sync agent on an existing system.
- `design.system.progress {workspace, slug, step, note?}`, `design.system.synced {workspace, slug}`
- `design.system.remove {workspace, slug}`
- `design.check {workspace, path}` → `{files: [{path, problems: [{line, kind, message}]}]}`
- `design.file {workspace, path}` → bytes and content type. The app's `moonlet-design://` scheme (X65) is served from it.
- `design.resolve {workspace, path, keep: "mine" | "synced"}` settles a `.proposed.html`.
- Event `design.changed {workspace, paths}` when files under a workspace's design folder change.

## Data and config

- `~/.moonlet/design/<workspace id>/systems/<slug>/…` as above. `system.toml` is the only file moonlet itself writes there, besides `_ds_manifest.json` and `.proposed.html` settling.
- moonletd remembers which agent terminal belongs to which design system with its other terminals, and restores it after a restart (S4).

## Security considerations

- The sync agent reads source projects but writes only inside the design system's folder: its working directory is that folder and the sources come in through `--add-dir`. Its default permission mode is Accept edits.
- Cards are untrusted HTML written by an agent. They render only in the sandboxed canvas of X65, never in the app's own webview.
- `design.file` and `design.check` resolve paths inside `~/.moonlet/design/<workspace id>/` and reject anything that leaves it, including symlinks that point outside.
- Assets copied from a source project are copied as files. Nothing in a card can reach the network (X65's canvas CSP).

## Out of scope

- Compiling a project's real components into the design system. Cards are always static HTML.
- Design systems on remote hosts. Source projects must be on this Mac.
- Pushing to Claude Design from moonlet. The format allows it, and `/design-sync` does it.
- Sharing a design system between workspaces. Copying the folder works, but moonlet offers no UI for it.

## Test plan

- Rust, `moonlet-core` `design` module: card line parsing; each check problem from captured card HTML; manifest generation against a literal expected manifest; the changed-sources computation from a captured `git diff --name-only`; path resolution rejecting `..` and an outside symlink.
- `crates/moonletd/tests/`: `design.system.create` writes `system.toml` and starts a terminal with the expected `--add-dir`; `synced` records `HEAD`; a hand-edited card produces `.proposed.html` and `design.resolve` settles it.
- Desktop `lib/`: grouping the manifest for the sidebar; the "sources changed" label; the proposed-change chooser state.
- e2e `design-systems.e2e.ts`: with a fixture design system in a scratch home, Design mode lists it, shows its cards, and a check warning shows the badge. A sync agent is not started against a real `claude` (see the testing notes): the e2e uses a fake agent binary that writes fixture files.
- Manual: build a design system of moonlet's own desktop app and compare the cards against the running app.

## Open questions

- An ADR for "designs and design systems are daemon-owned files under `~/.moonlet/design/`, per workspace"? It sets where future design work lives.
- Visual self-check: the agent cannot see what a card looks like. Could the app render a card offscreen and give the agent a PNG (`moonlet design snap`)? WKWebView can take a snapshot, but it is not yet clear how to do that from Tauri.
- Should the sync also run on Codex, or only Claude Code (`--add-dir` and skills differ)?
