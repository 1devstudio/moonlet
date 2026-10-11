# X30: Open project files from agent messages

- **Status:** implemented (2026-10-11): unit tests pass. The click has not been checked in the running app yet.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2
- **Related:** [X9](X9-chat-links.md) (web links in agent messages), [F3](F3-open-from-terminal.md) (file links in terminal output), [X26](X26-file-tabs.md) (files open as editor tabs)

## Summary

Agents name the files they read and change, as `src/lib/chat.ts`, as `apps/desktop/src/lib/markdown.ts:42` in prose, or as a Markdown link. X9 left those paths inert. X30 renders a project path in an agent message as a link, and a click opens the file in an editor tab of the main window, at the line when the path has one.

## User journey

1. The agent's answer mentions `src/lib/chat.ts:12`. The path shows as a link.
2. The user clicks it. The file opens in an editor tab of the main window, scrolled to line 12. If the tab is already open, it becomes active.
3. Dragging across the link to select text does not open the file.

## Behaviour and acceptance criteria

- [x] An inline code span that is exactly a relative path with an extension (optionally `:line[:col]`) renders as a file link around the code.
- [x] A name without a directory (`README.md`) counts only with a common file extension, so code such as `item.text` stays plain.
- [x] In plain text, a relative path with at least one directory (`docs/specs/X9-chat-links.md`) renders as a file link; punctuation around it stays outside. Bare names, version numbers, URLs and fenced code are not linked.
- [x] Paths with a leading `__` segment (`pkg/__init__.py`) and dotfiles (`config/.eslintrc.json`) link too; elsewhere `__bold__` stays bold.
- [x] A Markdown link whose target is a relative project path (optionally `:line`) becomes a file link; web links keep X9's behaviour.
- [x] Absolute paths, `~/` paths and any path with a `..` segment are never file links, so agent output cannot point outside the worktree.
- [x] Only files that exist in the project become links: a path missing from the project's file list stays plain text, and while the list is unknown no path is linked (`renderChatMarkdown` with and without `exists`).
- [x] The file list is the daemon's `fs.files` for the agent's working directory (non-ignored files, up to 20,000). It loads when the agent view opens and again when a turn starts and ends (`turnRunning` flips; waiting on a permission stays inside the turn), so files the agent creates become links. The hook that loads it is component behaviour, checked manually.
- [x] A file link resolves against the agent's working directory and keeps its line (`fileToOpen`).
- [x] A plain click or Enter opens the file in an editor tab of the main window; a click that ends a text selection does nothing (`fileToOpen`; the click handler itself is checked manually).
- [ ] File links in the Plan tab ([X24](X24-plan-panel.md)) and in the plan card of an expanded `ExitPlanMode` row open the same way, resolved against the session's worktree, and check the worktree's file list again whenever the plan changes (component behaviour, manual check).

## UI

File links look like other links in the agent view (accent colour, underline on hover). They have no Open/Copy toolbar: X9's toolbar only shows for web and mail links.

## Protocol and RPCs

None new. The file list comes from `fs.files {root}` ([X6](X6-structured-agent-view.md), the `@` mention list). Opening uses the existing editor tabs (`openFileTab`, X26).

## Data and config

None.

## Security considerations

Agent output is untrusted. File links are built by the renderer, then sanitized by DOMPurify like the rest of the message. Only relative paths without `..` are linked, and the click re-checks the path before joining it to the worktree, so a crafted `data-file` cannot open a file elsewhere. Paths that are not in the project's file list are not linked at all.

## Out of scope

- Linking gitignored files (`.env`, `dist/`, `target/`) and files past the 20,000-file cap of `fs.files`: they exist but are not in the list, so they stay plain text.
- Absolute paths inside the worktree.
- File paths in tool rows (other than the plan text of `ExitPlanMode`), tool output, diffs and user messages.

## Test plan

- Unit (`src/lib/markdown.test.ts`, "file links in chat (X30)"): inline code, bare names, prose paths with punctuation, underscores and dotfiles, Markdown links, rejected paths, only existing files, no links without a file list, `fileToOpen` with and without a selection.
- Unit (`src/lib/chat.test.ts`, "turn running (X30)"): when the file list reloads.
- Manual: ask the agent which files it changed; click a path; the file opens at the line. A made-up path in the answer stays plain text.

## Open questions

- None.
