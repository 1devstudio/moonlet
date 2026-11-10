# X96 — Open a file by name and line

- **Status:** implemented (2026-11-10)
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X26 (file tabs), X19 (Run action), X43 (Keyboard shortcuts settings), X30 (chat file links)
- **Related ADRs:** none

## Summary

A reviewer, an agent or a log often names a place in the code as `name:line` or `name:start-end`, for example `tenant-acme.yaml:49-53`. Today the user has to find that file in the Files tab by hand and scroll to the line. **Open file…** (⌘P) asks for a file name, lists the selected session's files that match, and opens the picked one in an editor tab at that line, with a range selected.

## User journey

1. In a session, the user presses ⌘P. The **Open file** dialog opens with the placeholder "File name, then :line or :start-end".
2. They paste `tenant-acme.yaml:49-53`. The list shows `config/tenants/tenant-acme.yaml` first, with "lines 49–53" beside the field.
3. ↵ opens the file in an editor tab of the session's main window, scrolled to line 49, with lines 49 to 53 selected.
4. Opening `app.ts:12` instead puts the cursor at the start of line 12. `app.ts` alone opens the file where it was.

## Behaviour and acceptance criteria

### The action and its shortcut

- [x] Run action (⌘K) lists **Open file…** in a **Files** group, after Panels, with the default key ⌘P. (`runActions.test.ts` lists all 30 actions in catalogue order; opens a file by name with ⌘P, leaving ⇧⌘P to Create pull request (X96))
- [ ] Settings › Keyboard shortcuts lists **Open file…** under **Files** with ⌘P, and its key can be recorded, cleared and reset like any other action's (X43). (`runActions.test.ts` groups every action in catalogue order, with its key or none; recording, clearing and resetting are X43's tests; the row seen in the app with `e2e/snap.ts`)
- [ ] ⌘P (or the key the user gave the action) opens the dialog from anywhere in the app's main window, also from a terminal or an open editor tab. With no session selected it opens nothing and says "Select a session to open its files". (Partly: `open-file.e2e.ts` presses ⌘P with the session shown and again with the file's editor focused; the no-session message has no test)

### What is typed

- [ ] The text is a file name or a project-relative path, optionally followed by `:line`, `:line:column` or `:start-end`. Spaces around it and a leading `./` are ignored. A column is ignored. A range given backwards (`:53-49`) is the same range. A line of 0 or a trailing `:` with no number opens the file with no line. (`openFileQuery.test.ts` what is typed in Open file (X96))

### Which files match

- [x] The list holds the session's files that the daemon lists for its worktree (the same list as `@` in the chat, ignored files left out, up to the daemon's 20,000 files), at most 50 rows. (`openFileQuery.test.ts` keeps at most 50 rows; `open-file.e2e.ts` opens name:start-end from ⌘P with the range selected)
- [x] A file whose name is exactly the typed name comes first, shortest path first; then a file whose name starts with it; then the rest, by the fuzzy match the `@` list uses (letters in order, the file name preferred over the directory). A typed path with a `/` matches the end of a file's path exactly first. Case is ignored. (`openFileQuery.test.ts` which files match in Open file (X96))
- [x] An empty name lists nothing and says "Type a file name". A name that matches nothing says "No file matches “<name>”". (`openFileQuery.test.ts` lists nothing for an empty name or one nothing matches; `open-file.e2e.ts` moves the open file to a single line, and says when nothing matches)

### Opening it

- [ ] ↵ or a click opens the selected file in an editor tab of the session's main window (X26), or switches to its tab when it is open, and closes the dialog. From Tasks or Design mode it switches to Sessions mode first. ↑↓ move the selection; Esc closes the dialog. (Partly: `open-file.e2e.ts` opens with ↵, switches to the open tab, closes with Esc; a click, ↑↓ and the mode switch have no test)
- [ ] With a line the editor scrolls the line into the middle and puts the cursor at its start. With a range it selects from the start of the first line to the end of the last. A file whose tab is open switches to it, at the new line or range. A line past the end of the file goes to its last line. (Partly: `layout.test.ts` opens a file at a range of lines, and an open one at a new range (X96); `open-file.e2e.ts` checks lines 49–53 drawn selected with the cursor on 53, then the cursor on line 12 with nothing selected; a line past the end has no test)

## UI

Same frame as Run action: a field at the top with a file icon, the line or range typed ("line 49", "lines 49–53") at the field's right, the rows below (file name, then its directory in faint text), and a footer with ↑↓ select, ↵ open, esc close.

## Protocol and RPCs

None. The file list comes from the existing `fs.files` RPC.

## Data and config

The editor tab's pane node gets an optional `endLine` next to `line`, stored with the layout like `line`. `settings.shortcuts["open-file"]` holds a custom key, like other actions.

## Security considerations

Only files the daemon lists for the session's worktree can be opened, so a typed `../` path opens nothing outside it.

## Out of scope

- Files outside the session's worktree, absolute paths and `~/`.
- Searching the files' contents.

## Test plan

- Vitest: `openFileQuery.test.ts` (parsing and ranking), `layout.test.ts` (a range kept on the tab), `runActions.test.ts` (the action, its group and key).
- e2e: `open-file.e2e.ts` opens `name:start-end` with ⌘P and checks the editor's selected lines.
- Screenshot of the dialog with `e2e/snap.ts`.

## Open questions

- Opening the same file at the same line or range again does nothing once the cursor has moved, as with terminal links (F3).
