# F2: Read-mostly code viewer with light editing

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** F2

## Behaviour and acceptance criteria

- [x] Opening a file from the tree (or a terminal link) shows Monaco read-only with syntax colouring for ~40 languages. It runs offline, with one editor worker and no language servers.
- [x] An explicit Edit toggle makes it writable; ⌘S saves atomically through `fs.write`, keeping permissions. A dirty marker shows unsaved changes.
- [x] Binary files and files truncated at 4 MiB cannot be edited.
- [x] It opens at a line when one is given (`path:line` links).
