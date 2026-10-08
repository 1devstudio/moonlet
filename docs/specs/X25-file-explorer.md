# X25 — File explorer in the Files tab, changed files in the Changes tab

- **Status:** implemented (2026-10-07). Covered by unit tests and `file-explorer.e2e.ts`; the look not yet checked in the running app by a person.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** F1, D1
- **Related:** [F1](F1-file-tree.md) (file tree), [D1](D1-changes-panel.md) (Changes panel), [F2](F2-code-viewer.md) (code viewer), [T8](T8-block-styling.md) (text sent to the composer)

## Summary

The Files tab used to open on the list of changed files, with the file tree behind a small "all files" toggle. The Changes tab listed the same files again, flat, above a diff. X25 gives each tab one job. **Files** is a file explorer: the workspace's tree with an icon per file type, and per-row actions to add a file to the chat or open it in another app. **Changes** opens on the changed files grouped by folder, with the summary line; clicking a file opens its diff in the full height of the tab, with a way back to the list.

## User journey

1. The user opens the Files tab. The workspace's tree shows, folders first. Each file has an icon for its type: `{}` for JSON, the YAML mark for `.yml`, the git mark for `.gitignore`, a gear for `.env`, a plain page for anything unknown.
2. Hovering a row highlights it and shows its actions on the right: `+` (files only) and `⌄`.
3. `+` puts `@<path relative to the workspace>` into the session's agent composer, after what is already typed. With no agent running, a new agent tab opens with it.
4. `⌄` opens an "Open in" menu with the apps that can open the entry: Finder (which reveals the entry), then the installed editors, then, for folders, the installed terminals.
5. Clicking a folder expands it; clicking a file opens it in an editor tab of the main window ([X26](X26-file-tabs.md)).
6. The user opens the Changes tab. The summary line (`+12 −3 · 4 files → main`) sits above the changed files, grouped by folder, each with a status icon and its `+/−` counts. Hovering a file shows stage, unstage and discard buttons.
7. Clicking a changed file shows its diff in the full height of the tab, under a bar with a back button and the file's path. The back button returns to the list.

## Behaviour and acceptance criteria

- [x] A file's icon is picked by its full name first, then by its longest known extension, case-insensitively; an unknown file gets the plain file icon. (`fileIcon` in `fileIcons.test.ts`)
- [x] The Open in menu of a local file lists Finder and the installed editors, not the terminals. A local folder's menu lists Finder, the editors and the terminals. Finder reveals the entry and never opens it: `open` would run a file with its default app, and launch a folder named `Foo.app`. On a remote host both list only VS Code and Cursor. (`openInChoices` in `openIn.test.ts`)
- [x] `+` adds `@<relative path>` to the composer: into an empty composer as is, after typed text with a space, so several files can be added in a row. Other text sent to the composer (T8) still follows a blank line. (`fileMention`, `joinDraft` in `chat.test.ts`)
- [x] The Files tab shows the tree only; the "changed / all files" toggle and the summary line are gone from it. (`file-explorer.e2e.ts`)
- [x] Each changed file shows `+a −d`, `+a`, `−d` or `bin`. (`changeCount` in `changes.test.ts`)
- [x] *Superseded by [X28](X28-changes-tree-and-list.md):* changed files were grouped by folder, folders in path order and the root folder shown as `/`. X28 shows them as a tree or a list instead.
- [x] The Changes tab opens on the changed files with the summary line (X28: tree or list, `N files changed` header); clicking a file shows its diff with a back button; back returns to the list. (`file-explorer.e2e.ts`)

## UI

Files tab:

    ~/…/moonlet/my-session                         👁
    ─────────────────────────────────────────────
     🗀  apps
     🗀  docs                                     ⌄    ← hovered folder
     {} package.json                          +  ⌄    ← hovered file
     Y  pnpm-workspace.yaml
     M↓ README.md

Rows are 30px high with rounded hover highlights, a 16px icon and the name in the monospace UI font; each level indents by 16px. Ignored entries are dimmed and shown only with the eye toggle, as before (F1).

Changes tab, list:

    [Against main | Uncommitted]  +12 −3      ⟳  Commit…
    +12 −3 · 4 files · → main
    ⌄ apps/desktop/src
       ⊡ RightPanel.tsx                       +40 −12
    ⌄ docs/specs
       ⊞ X25-file-explorer.md                     +80

Changes tab, diff:

    [Against main | Uncommitted]  +12 −3      ⟳  Commit…
    ←  apps/desktop/src/components/RightPanel.tsx   @12 + ↺   💬 Split
    ┌ Monaco diff, full height ┐

## Protocol and RPCs

None new. The tree uses `fs.list` (F1); Open in uses the app's `open_targets` and `open_in` commands, with `open_in("reveal", file)` for Finder on a file.

## Data and config

The icons are SVGs from the MIT-licensed `material-icon-theme` package, bundled at build time; only the icons the mapping names are included.

## Security considerations

Paths come from `fs.list` on the workspace, so their names are the repository's and not trusted. Finder always reveals (`open -R`), since a plain `open` runs a file with its default app and launches a folder named `Foo.app`; terminals are offered for folders only, since a terminal app given a file runs it as a script. Paths are absolute, so none can be read as an option of `open`. `open_in` already rejects unknown targets and remote paths for local-only apps.

## Out of scope

- Creating, renaming and deleting files from the explorer.
- Git status colours in the explorer.
- Icons in the Changes list (status icons stay).

## Test plan

- Vitest: `fileIcons.test.ts`, `openIn.test.ts`, `chat.test.ts`, `changes.test.ts`.
- e2e: `file-explorer.e2e.ts` drives the Files and Changes tabs against a scratch repo.
