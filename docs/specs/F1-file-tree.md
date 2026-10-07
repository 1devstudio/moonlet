# F1: File tree

- **Status:** implemented
- **Priority / phase:** P0 · phase 1
- **PRD refs:** F1, journey J6

## Behaviour and acceptance criteria

- [x] `fs.list {path, show_ignored}` returns one directory, directories first, case-insensitive. It respects `.gitignore`, global excludes and `.git/info/exclude`, and always hides `.git` and `.DS_Store`.
- [x] Ignored entries are hidden by default and flagged when `show_ignored` is set.
- [x] `fs.read` caps reads at 4 MiB by default and reports `truncated`, `binary` and `size`. `fs.write` saves atomically and keeps permissions.
- [x] `fs.watch` / `fs.unwatch` are reference-counted per client and released on disconnect.
- [x] UI: the tree roots at the workspace path (or the pane's OSC 7 cwd), loads lazily and refreshes on `fs.changed`.
- [x] UI: file-type icons, Add to chat and Open in per row, and the explorer as the whole Files tab come from [X25](X25-file-explorer.md).
