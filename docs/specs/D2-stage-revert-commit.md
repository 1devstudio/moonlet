# D2: Stage, unstage, revert and commit

- **Status:** implemented (daemon); UI in progress
- **Priority / phase:** P1 · phase 3
- **PRD refs:** D2

## Behaviour and acceptance criteria

- [x] `git.stage`, `git.unstage` and `git.revert` work per file. Revert restores tracked files to HEAD, deletes untracked files, and removes added files.
- [x] Per-hunk operations: the UI builds a one-hunk patch and calls `git.apply_patch` with `cached` (stage), `cached + reverse` (unstage), or `reverse` (discard from the work tree). `--recount` tolerates edited line counts.
- [x] `git.commit {message, all}` commits the index (or everything with `all`) and returns the new SHA.
- [x] `git.log {base}` lists the commits on the branch since the base.
- [ ] UI: stage/unstage/discard buttons per file and per hunk; a commit box.

## Security considerations

Discarding is destructive, so the UI asks for confirmation before `git.revert` and before reverse-applying to the work tree.
