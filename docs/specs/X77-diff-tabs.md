# X77 — A changed file's diff opens in a tab of the main window

- **Status:** implemented (2026-11-02; the look checked in the running app with `snap.ts`)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** D1 (Changes panel), journey J4
- **Related:** [X26](X26-file-tabs.md) (file tabs, Source/Preview), [X28](X28-changes-tree-and-list.md) (changed files as a tree or a list), [X25](X25-file-explorer.md)

## Summary

Clicking a changed file in the Changes tab used to replace the list with a diff, squeezed into the right panel. X77 opens the diff as a tab of the main (centre) window, next to the terminals, agents and file tabs, and leaves the Changes tab on its list. A Markdown file's diff tab has a **Diff / Preview** switch; Preview shows the rendered new version of the file.

## User journey

1. The user opens the Changes tab and clicks `docs/guide.md`. A tab with a diff icon and the name `guide.md` opens in the main window and becomes active. The right panel still shows the list.
2. They click `package.json`; a second diff tab opens. They click `docs/guide.md` again: its existing tab is activated, no second one opens.
3. In the `guide.md` tab they press **Preview**. The page shows the file's new version, rendered. **Diff** goes back to the diff.
4. They switch the Changes tab to **Uncommitted** and click `package.json` again. A separate tab opens, marked `uncommitted`, with hunk stage and discard buttons.
5. They close a diff tab with its × or ⌘W.

## Behaviour and acceptance criteria

- [x] A diff tab holds a file path (relative to the worktree) and a mode, `base` (everything since branching from the base) or `head` (uncommitted changes only). Opening one adds a tab after the existing tabs and makes it active; opening the same file in the same mode activates that tab. (`layout.test.ts` › "opens a changed file's diff as a new active tab after the others", "switches to the diff's tab when that file and mode are already open")
- [x] The same file in the other mode, or its editor tab, is a separate tab. (`layout.test.ts` › "keeps one tab per file and mode", "keeps a file's editor tab and its diff tab apart")
- [x] Syncing terminals keeps diff tabs; a stored layout with diff tabs reads back, and a diff tab without a path or with an unknown mode is dropped. (`layout.test.ts` › "keeps diff tabs when the terminals are synced", "reads diff tabs back from a stored layout and drops ones without a mode")
- [x] Closing a diff tab removes it and activates its neighbour. (`layout.test.ts` › "closes a diff tab and activates its neighbour")
- [x] Clicking a changed file, or pressing Enter or Space on its row, opens its diff tab in the mode the Changes tab is in; the list stays in the right panel. (`file-explorer.e2e.ts` › "opens a file's diff in a tab of the main window from the keyboard", "opens a file's diff from the keyboard with Space too", "opens the diff of the uncommitted changes as a separate, marked tab")
- [x] Opening a diff tab while its workspace is in Design or Tasks mode switches it to Sessions mode, so the tab is seen. (`workspaceStore.test.ts` › "opening a diff tab shows its session in Sessions mode, from Design or Tasks (X77)")
- [x] Clicking the same file again switches to its tab. (`file-explorer.e2e.ts` › "switches to the file's diff tab when it is clicked again")
- [x] A path ending in `.md`, `.markdown` or `.mdx`, in any case, is Markdown; no other path is. (`markdown.test.ts` › "is true for Markdown files by extension, in any case", "is false for anything else")
- [x] A Markdown file's diff tab has a Diff / Preview switch; Preview renders the new version of the file; a file that is not Markdown, and a deleted file, has no switch. (`file-explorer.e2e.ts` › "previews a Markdown file's new version in its diff tab")
- [x] A diff tab is titled with what it compares: `against <base>` or `uncommitted`. (`changes.test.ts` › "says what a diff tab compares")
- [x] The diff keeps what the panel had: split or inline, hunk stage and discard on uncommitted changes, and comments to the agent (⇧⌘M). Preview hides the hunk and comment controls. The `+a −d` totals the panel showed above an open diff are gone.
- [x] A diff tab reads its file when it opens, when the worktree changes (as long as something watches it, which the right panel does while open) and when it comes back to the front; a tab behind another one does not read.

## UI

    [⌘ claude]  [▣ zsh]  [◫ guide.md  ×]  [◫ package.json uncommitted ×]   + ⌄
    ┌──────────────────────────────────────────────────────────────────────┐
    │ docs/guide.md  against main            [Diff|Preview]  ✎  Split      │
    │  ⋯ diff editor ⋯                                                     │
    └──────────────────────────────────────────────────────────────────────┘

- The tab is as wide as a file tab and shows a diff icon and the file's name; a tab of uncommitted changes adds a faint `uncommitted`.
- The Changes tab no longer has a back arrow or a diff of its own.
- Preview hides the comment controls and the hint; the diff editor is hidden, not unmounted, so its scroll stays.

## Protocol and RPCs

None new: `git.file_versions`, `git.diff`, `git.apply_patch` (D1) and `fs.changed`.

## Data and config

Layout: a pane can be `{ "type": "diff", "path": "docs/guide.md", "mode": "base" }`. Layouts are stored by the daemon as opaque JSON (S4), so diff tabs come back after a restart. The store's `diffFile` is gone.

## Security considerations

The preview renders in the same sandboxed frame as file tabs' preview (X26).

## Out of scope

- A rendered side-by-side diff of Markdown: Preview shows the new version only.
- Closing a diff tab when its file stops being changed: the tab stays and shows no differences.
- Closing a diff tab with ⌘W is not covered by a test of its own.

## Test plan

- Vitest: `layout.test.ts`, `markdown.test.ts`.
- e2e: `file-explorer.e2e.ts` opens a diff from the keyboard and by click, switches to it on a second click, and previews a Markdown file.
