# X98 — File actions in the Files tab

- **Status:** implemented (2026-11-11)
- **Priority / phase:** P1 · phase 4
- **PRD refs:** F1 (file tree), X25 (file explorer), X26 (file tabs)
- **Related ADRs:** none

## Summary

The Files tab ([X25](X25-file-explorer.md)) shows the session's tree, but changing it means going to Finder or a terminal. X98 adds the everyday file actions to the tree: **New file**, **New folder**, **Rename**, **Duplicate**, **Delete**, **Open terminal here**, and dragging a row onto a folder to move it. They live in a context menu on right-click, and under Open in in the row's `⌄` menu. The daemon does the work, so they act the same on a remote host as on this Mac, and never reach outside the session's folder.

## User journey

1. The user right-clicks `src/` in the Files tab. A menu opens at the pointer: New file, New folder, Rename, Duplicate, Delete, Open terminal here.
2. New file expands `src/` and shows a name field as its first row. The user types `util.ts` and presses Enter: the file is created empty and opens in an editor tab. Esc, or leaving the field empty, cancels.
3. Rename turns the row's name into a field with the name selected up to its extension. Enter renames; Esc cancels. An editor tab open on the file, or on a file inside a renamed folder, follows it.
4. Duplicate makes `util copy.ts` next to `util.ts` (`util copy 2.ts` when that exists), and starts renaming it.
5. Delete asks "Move util.ts to the Trash?" on this Mac, and "Delete util.ts? This can't be undone." on a remote host. Confirming removes it, and closes editor tabs open on it.
6. The user drags `util.ts` onto `lib/`. The folder highlights while the row is over it, and the file moves there on drop. Dropping on the panel's empty space moves it to the session's root.
7. Open terminal here, on a folder, opens a terminal tab in the session with that folder as its working directory. On a file it uses the file's folder.

## Behaviour and acceptance criteria

- [x] `fs.create` creates an empty file or a folder inside the root, and refuses a name that already exists. (`create_makes_an_empty_file_or_a_folder_and_never_replaces_one` in `moonlet-core/src/file_actions.rs`)
- [x] Every action refuses a path outside the root, the root itself, a path with `..`, and a path whose folders on the way include a symlink. (`file_actions_stay_inside_the_root` in `file_actions.rs`)
- [x] `fs.rename` moves a file or folder, refuses to replace an existing entry, and refuses to move a folder into itself. A rename that only changes the case (`readme.md` to `README.md`) works on a Mac's case-insensitive volume. (`rename_moves_and_never_replaces` in `file_actions.rs`)
- [x] `fs.duplicate` copies a file or a folder (with its contents, symlinks copied as links) next to the original as `name copy.ext`, then `name copy 2.ext` and up, and returns the new path. A dotfile becomes `.env copy`. (`duplicate_names_the_copy_like_finder`, `duplicate_copies_a_folder_with_its_contents` in `file_actions.rs`)
- [x] `fs.delete` on macOS moves the entry to the Trash and says so (`trashed: true`); elsewhere it deletes it (`trashed: false`). A symlink is removed, never its target. (`delete_removes_a_link_not_its_target`, `delete_moves_to_the_trash_on_a_mac` in `file_actions.rs`; the real Trash, through `NSFileManager`, was tried by hand)
- [x] The Files tab keeps refreshing after an editor tab of the same session closes: the daemon counts each client's watches of a folder, so one `fs.unwatch` ends only one of them. Before X98, closing any file tab stopped the Files tab's updates. (`a_folder_watched_twice_by_one_client_stays_watched_until_both_stop` in `fs.rs`)
- [x] A new name is refused, with a reason, when empty, `.` or `..`, or when it has a `/`. (`nameProblem` in `fileActions.test.ts`)
- [x] Rename selects the name up to its last extension; a dotfile or a folder is selected whole. (`renameSelection` in `fileActions.test.ts`)
- [x] After a rename or a move, editor tabs open on the entry or on files inside it point to the new path; the unsaved marks follow. After a delete, those tabs close. (`moveFiles`, `closeFilesUnder` in `layout.test.ts`)
- [x] A drop is refused on the entry itself, on its own folder (nothing would move), and on a folder inside a dragged folder. A drop on a file's row moves into that file's folder. (`dropTarget` in `fileActions.test.ts`)
- [x] Open terminal here starts in the folder, or in a file's folder. (`terminalFolder` in `fileActions.test.ts`)
- [x] Another member's session (X72) shows no file actions: its member owns the files. (`offersFileActions` in `fileActions.test.ts`)
- [x] In the running app: right-click shows the menu, New file creates and opens a file, Rename renames it, Duplicate makes a copy, a drag moves it into a folder, Delete removes it, Open terminal here opens a terminal tab. (`file-actions.e2e.ts`)

## UI

Context menu (right-click on a row; the same items follow Open in in the `⌄` menu). Right-click on the panel's empty space offers New file, New folder and Open terminal here at the session's root, and the header has New file and New folder buttons:

    New file
    New folder
    ───────────
    Rename
    Duplicate
    Open terminal here
    ───────────
    Delete                ← red

Inline field (new entry, or rename), in the row's place, with its icon:

     🗀  src
        📄 [util.ts            ]

A name the daemon refuses, or one that `nameProblem` flags, keeps the field open with the field outlined red and the reason as a toast.

A folder row highlights (`bg-raised`) while a dragged row is over it; the panel's empty space highlights for a move to the root.

## Protocol and RPCs

New daemon methods, each with `root` (the session's folder) that every path must stay inside:

- `fs.create {root, path, dir}` → `true`
- `fs.rename {root, from, to}` → `true`
- `fs.duplicate {root, path}` → `{path}`
- `fs.delete {root, path}` → `{trashed}`

The tree refreshes from the session's `fs.changed` events, as for any change on disk.

## Data and config

`MOONLET_TRASH_DIR`, for tests only: when set, `fs.delete` moves entries into that folder instead of the user's Trash.

## Security considerations

Paths come from the tree, which lists the repository's own names, and names typed by the user. Every action checks the path lexically against `root` (no `..`, not the root itself) and refuses a symlink among the folders on the way, as `fs.write_inside` (X38) does, so a committed symlink can't point an action at the user's home. The entry itself may be a symlink: rename and delete act on the link, and duplicate copies the link, so its target is never touched. Rename and create never replace an existing entry. Delete always asks first.

## Out of scope

- Cut, copy and paste between folders, and copying a path to the clipboard.
- Keyboard shortcuts in the tree (F2, ⌘⌫), and selecting several rows.
- Dragging files in from Finder, or out of the app.
- Undo, other than taking a file back out of the Trash.

## Test plan

Rust unit tests in `moonlet-core/src/file_actions.rs` for each RPC's behaviour and the root checks; Vitest for names, selection, drop targets and tab retargeting; `file-actions.e2e.ts` drives each action in the app, with `MOONLET_TRASH_DIR` pointing at the scratch world.

## Open questions

- None.
