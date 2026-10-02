# D1: Changes panel

- **Status:** implemented (daemon); UI in progress
- **Priority / phase:** P0 · phase 1
- **PRD refs:** D1, goal 3, journey J4

## Summary

The right panel's Changes tab lists every file the workspace changed and shows a side-by-side or inline Monaco diff. The diff is against the workspace's base (merge-base) or against HEAD.

## Behaviour and acceptance criteria

- [x] `git.status {path, base}`:
  - returns branch, HEAD, upstream, ahead/behind and `against` (the merge-base with the base, or HEAD);
  - lists files with status (`added`, `modified`, `deleted`, `renamed` with `old_path`, `untracked`, `conflicted`), staged/unstaged flags, `+/-` counts and a binary flag;
  - includes committed work when diffing against the base, so an agent's commits stay visible.
- [x] A repository without commits diffs against the empty tree.
- [x] `git.file_versions` returns the original and modified text. Renames follow the old path. Binary files and files over 2 MiB return `binary: true` with no text.
- [x] `git.diff` returns a unified patch for one file or all files, including untracked files (via `--no-index`).
- [x] Paths must be relative; `..` and absolute paths are rejected.
- [x] Status refreshes live: `fs.watch` on the worktree emits `fs.changed`, debounced to 150 ms, including `.git/index` and `HEAD` changes.
- [ ] UI: file list with diffstat, a toggle between base and HEAD, a split/inline toggle, Cmd+Shift+D.

## Test plan

- `git.rs`: `status_against_head_and_base`, `versions_diff_stage_revert_commit`, `fresh_repo_without_commits`.
