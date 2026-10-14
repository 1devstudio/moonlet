# X26 — Files open as editor tabs, with VS Code syntax colours

- **Status:** implemented (2026-10-07). Covered by unit tests and `file-tabs.e2e.ts`; the look not yet checked in the running app by a person.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** F2, F3
- **Related:** [X25](X25-file-explorer.md) (file explorer), [F2](F2-code-viewer.md) (code viewer, replaced), [F3](F3-open-from-terminal.md) (open file from terminal output), [T2](T2-tabs-splits-workspaces.md) (tabs)

## Summary

A file opened from the Files tab used to show in a read-only viewer squeezed under the tree in the right panel. X26 opens it as a tab of the main window, next to the terminals and agents, in an editor that is writable straight away. Code is coloured with VS Code's TextMate grammars (through Shiki) instead of Monaco's simpler built-in rules, and the colour theme is a setting, Dark+ by default.

## User journey

1. The user clicks `src/App.tsx` in the Files tab. A tab with the file's icon and name opens in the main window and becomes active; the code shows in Dark+ colours.
2. Clicking the same file again switches to its tab instead of opening a second one.
3. The user types. The tab shows a dot for unsaved changes. ⌘S saves the file and the dot goes away.
4. Closing the tab (its ×, or ⌘W) with unsaved changes asks "Discard unsaved changes to App.tsx?" first.
5. An agent edits the file while its tab is open. With no unsaved changes the tab shows the new content; with unsaved changes it keeps the user's text.
6. Clicking `src/App.tsx:42` in terminal output opens the file's tab at line 42. Markdown files open as source tabs too, with a Source / Preview switch in the tab's header. Preview shows the rendered page in the tab itself, from the editor's current text, unsaved edits included; Source goes back to the editor.
7. In **Settings › Appearance › Editor and diffs** (Settings › Editor before X43), "Colour theme" lists the dark themes; picking one recolours every open editor and diff at once.

## Behaviour and acceptance criteria

- [x] Opening a file adds a file tab after the existing tabs and makes it active; opening a file that already has a tab activates that tab. A file tab's pane holds no terminal, so syncing terminals keeps it, and a stored layout with file tabs reads back. (`openFile`, `reconcile`, `parseLayout` in `layout.test.ts`)
- [x] Closing a file tab removes it and activates its neighbour, as closing a terminal tab does. (`closeFile` in `layout.test.ts`)
- [x] A file's language is picked by its name, then its extension, among Shiki's languages: `App.tsx` is `tsx`, `Cargo.toml` is `toml`, `.env.local` is `dotenv`, `Makefile` is `make`, `Dockerfile` is `docker`; an unknown file is plain text. (`editorLanguage` in `syntax.test.ts`)
- [x] The colour theme setting holds a Shiki dark theme id; a missing or unknown stored value reads as `dark-plus`. (`resolveEditorTheme` in `syntax.test.ts`)
- [x] Code is coloured with the theme's TextMate colours: in Dark+, the `const` of `const a = 1;` is `#569CD6`, the `1` is `#B5CEA8` and the `;` is `#D4D4D4`. (`syntax.test.ts`)
- [x] Clicking a file in the Files tab opens its tab in the main window; typing marks the tab unsaved; ⌘S writes the file. (`file-tabs.e2e.ts`)
- [x] Picking another theme in Settings recolours the open file. (`file-tabs.e2e.ts`)
- [x] Closing an unsaved file tab asks first, and keeps the tab when the user cancels. (`file-tabs.e2e.ts`)
- [x] A markdown file's tab switches between its source and its rendered preview, in the tab; the right panel keeps its tab. (`file-tabs.e2e.ts`)

## UI

    [⌘ claude]  [▣ zsh]  [{} package.json ●  ×]   + ⌄
    ┌──────────────────────────────────────────────────────────┐
    │ apps/desktop/package.json            [Source|Preview] (md)│  ← path bar
    │  1  {                                                    │
    │  2    "name": "@moonlet/desktop",                          │  ← Monaco, Dark+
    └──────────────────────────────────────────────────────────┘

- The file tab is as wide as a terminal tab and shows the file-type icon (X25), the name, a dot while unsaved and × on hover.
- The editor keeps moonlet's #121212 background whatever the theme, so it matches the terminals.
- Binary files show "Binary file" and their size; files over 4 MiB open read-only with a "truncated" note, as in F2.
- The right panel's code viewer and its markdown preview are gone; the Files tab shows only the tree.

## Protocol and RPCs

None new: `fs.read`, `fs.write` (F2) and `fs.changed` (F1). File tabs are part of the session's layout, which the daemon stores as opaque JSON (S4), so they come back after a restart.

## Data and config

- Layout: a pane can be `{ "type": "file", "path": "/abs/path", "line": 42 }` besides `{ "type": "leaf", "session": 3 }`.
- App setting `editorTheme` (localStorage `moonlet.settings`), default `dark-plus`.
- Dependency: `shiki` (MIT) on its Oniguruma (WebAssembly) regex engine, as in VS Code. Its JavaScript regex engine was tried first: under WebKit it dropped patterns it could not run, and TypeScript's `;` came out in the number colour. Each grammar and theme is a separate chunk, loaded the first time it is used.

## Out of scope

- Splitting a file tab, or a file and a terminal in one tab.
- Language services (completion, go to definition), find in files.
- Light themes.

## Test plan

- Vitest: `layout.test.ts`, `syntax.test.ts`.
- e2e: `file-tabs.e2e.ts` opens a file from the Files tab, edits and saves it, and closes an unsaved tab.
