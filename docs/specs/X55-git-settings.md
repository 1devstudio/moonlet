# X55 — Git settings

- **Status:** implemented (2026-10-19; checked with e2e and screenshots of the e2e app, remote hosts untried)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X5 (sessions and branches), X13 (pull the base branch), X23 (archive confirm), X43 (settings page), D2 (commit), X2 (pull requests), R1 (remote hosts)
- **Related ADRs:** none

## Summary

Settings gains a **Git** page under App: how new sessions name and start their branches, what archiving a session does with its worktree folder and branch, how the Commit and Create pull request dialogs start, and how base branches are kept current. Each host keeps its own Git settings in its daemon, so sessions an agent opens through the daemon follow them too. Archiving also learns to warn before it removes work that exists only on this machine: uncommitted files, and commits not on origin.

## User journey

1. The user opens Settings › Git. A switch at the top picks the host (This Mac, or a connected remote host such as `devbox`); the page shows that host's settings.
2. Under **New sessions** they set a branch prefix (`marcin/`, empty for none) and whether new branches start from the local `main` or from `origin/main` after a fetch. The worktrees folder is shown with Reveal in Finder.
3. Under **Archiving a session** they choose whether the worktree folder is removed or kept, what happens to the local branch (Ask each time, Keep, Delete when its PR merged, Always delete), whether a merged PR's branch is also deleted on origin, and whether moonlet warns before losing unpushed work.
4. Under **Commits and pull requests** they choose how the Commit dialog's "Stage all changes first" and the Create pull request dialog's "Draft" start.
5. Under **Keeping base branches current** they choose how often projects fetch from origin (5 min, 15 min, Manually) and whether a base branch that is only behind origin is fast-forwarded without a click.
6. Later, archiving a session with uncommitted files or unpushed commits shows them in the archive prompt, with "Push, then archive" and "Archive anyway".

## Behaviour and acceptance criteria

### Page and storage

- [x] The nav's App group lists **Git** after Agents, with a branch icon. The breadcrumb reads `Settings › Git`.
- [x] The heading reads "Git" with "Branches, worktrees and archiving. Each host keeps its own, so sessions an agent opens follow them too."
- [x] A Host switch lists This Mac and each connected remote host by its label; it is hidden when there is no remote host. Picking one shows that host's settings.
- [x] Settings save as soon as they change, through the host's daemon (`git.set_settings`), and survive an app restart and a daemon restart.
- [x] A daemon that does not know `git.settings` (older than this change) shows "<host>'s moonletd is too old for Git settings. Reinstall the helper from Hosts." and the defaults are used for that host.
- [x] Each setting is found by Search settings, under `App › Git`.

### Commits and pull requests

- [x] "Stage all changes before committing" (default on): the Commit dialog's "Stage all changes first" starts this way for sessions on that host.
- [x] "Open pull requests as drafts" (default off): the Create pull request dialog's "Draft" starts this way for sessions on that host.

### New sessions

- [x] "Branch prefix" (default `moonlet/`) is put before the name of every new session branch the daemon derives from the session name. Empty means none. A branch given explicitly (an existing branch, a task's branch template, a PR) is used as is.
- [x] A project's `branch_prefix` in `.moonlet/config.toml` wins over the host's prefix. The project page's Git section edits it.
- [x] Under the field, a preview shows `<prefix>add-search-to-the-product-list`.
- [x] A prefix git would reject shows an error and is not saved: spaces or any of `~ ^ : ? * [ \` ("Branch names cannot hold spaces or ~ ^ : ? * [ \"), `..`, `//` or `@{` ("Branch names cannot hold .., // or @{"), a first character of `/`, `.` or `-` ("Start with a letter or digit."), or a part that starts with `.` or ends with `.lock` before a `/` ("No part can start with . or end with .lock"). Control characters are refused with the first message. The daemon refuses the same prefixes. A valid prefix is saved when the field is left, on Enter, or when the page closes.
- [x] "Start new branches from" offers `main` (default: the local branch as it is) and `origin/main` (fetches the base branch first). With `origin/main`, a session started without an explicit start point begins at the fetched `origin/<base>`, and its branch does not track `origin/<base>`. When the fetch fails, it starts from the local base branch.
- [x] The composer's default start item reads "Start from origin/main (default)" when the host starts from origin.
- [x] "Worktrees folder" shows `~/.moonlet/worktrees/‹project›/‹session›`; Reveal in Finder opens it on This Mac and is absent for a remote host.

### Archiving a session

- [x] "Worktree folder": Remove (default) or Keep. Kept folders stay on disk and the archive prompt says so; unarchiving reuses them (as today).
- [x] "Local branch": Ask each time (the prompt's "Also delete the branch" checkbox, as today), Keep, Delete when its PR merged (default), Always delete. The hint under it explains the picked option. A kept folder keeps its branch (it is checked out there), and the project's base branch is never deleted.
- [x] With "Delete when its PR merged", the branch is deleted when the session's PR is known to be merged, and kept otherwise. The prompt says which.
- [x] "Also delete the branch on origin" (default off): when the session's PR merged and the local branch is deleted, `origin/<branch>` is deleted too. A failure to delete it on origin does not stop the archive; it shows as a toast.
- [x] "Warn before losing unpushed work" (default on): before archiving, moonlet reads the session's uncommitted files (shown when the folder will be removed) and its commits not on origin (shown when the folder is removed or the branch deleted). Commits not on origin are those on the session's branch, or on a detached HEAD, that no other branch or remote has. It is the session's branch even when an agent checked out another one in the folder: that other branch is kept, and its commits with it. A merged PR's head commit, and every commit it contains, counts as on origin: GitHub keeps it after a squash merge and once the branch is deleted. (`git.rs` tests `commits_on_a_branch_the_worktree_moved_to_are_not_lost`, `the_session_branch_is_read_when_another_is_checked_out`, `a_squash_merged_prs_commits_are_not_lost`; daemon test `unpushed_work_is_read_from_the_session_branch_over_rpc`; `unpushedParams` in `lib/gitSettings.test.ts`)

### Archive prompt with unpushed work

- [x] When there is such work, the prompt shows an amber box "This work is only on this Mac" (or "…only on <host>") listing up to 8 uncommitted files with their status letter, and a line "<n> uncommitted files · <n> commits not pushed to origin/<branch>".
- [x] Its buttons are Cancel, "Push, then archive" and "Archive anyway" (danger). "Push, then archive" is disabled while there are uncommitted files, titled "Commit the changes first"; otherwise it runs `git push -u origin <session branch>`, then archives. (`git.rs` test `push_sends_the_session_branch_not_the_checked_out_one`) A failed push shows the error and archives nothing.
- [x] Without such work, or with the warning off, the prompt is the X23 archive prompt as today.

### Keeping base branches current

- [x] "Fetch from origin": 5 min (default), 15 min, Manually. Projects on that host fetch their base branch at that interval; Manually never fetches on a timer (connecting to the host and a session's PR merging still fetch).
- [x] "Fast-forward base branches automatically" (default off): after a fetch finds the base branch only behind origin, moonlet pulls it as the ↓ chip would, with the chip's toast ("Pulled 3 commits into main. New sessions start from …"). A diverged branch keeps its chip.

## UI

As the design (`Settings · Git` and `Archive prompt · unpushed work`): page heading with the host switch on the right; four sections of cards. The prefix row is a two-column grid (label and hint, input with preview); "Start new branches from" is two radio cards; the rest are rows with a segmented control, a select or a switch.

## Protocol and RPCs

- `git.settings` `{}` → `GitSettings`.
- `git.set_settings` `{ ...partial GitSettings }` → `GitSettings` (the whole, after the change). Refuses an invalid branch prefix.
- Event `git.settings_changed`: the whole `GitSettings` after a change, to every client (a change made with the CLI reaches the app).
- `git.unpushed` `{ path, branch?, merged_head? }` → `{ files: [{ status, path }], commits, upstream }`. `branch` is the session's branch (absent: the checked-out one); `merged_head` the head commit of its merged PR. `upstream` is `branch`'s.
- `git.push` `{ path, branch? }`: `git push -u origin <branch>`, else HEAD.
- `PullRequest` gains `head_oid` (gh's `headRefOid`).
- `session.archive` gains `delete_remote` (default false) and returns `{ remote_error }`: why origin refused the delete, if it did.
- `session.create` reads the host's prefix and start point when `branch` and `from` are absent. New branches are created with `--no-track`.
- `daemon.info` gains `data_dir`, the daemon's data folder (the page shows its `worktrees`).

## Data and config

- `~/.moonlet/git.toml` on each host (`$MOONLET_HOME/git.toml`):

  ```toml
  branch_prefix = "moonlet/"
  start_from = "local"          # or "origin"
  archive_worktree = "remove"   # or "keep"
  archive_branch = "merged"     # "ask", "keep", "merged" or "always"
  delete_remote_branch = false
  warn_unpushed = true
  stage_all = true
  draft_prs = false
  fetch_minutes = 5             # 0: manually
  fast_forward_base = false
  ```

  Missing keys take their defaults. A file that does not parse gives the defaults; saving rewrites it.
- `.moonlet/config.toml` gains `branch_prefix`.

## Security considerations

The prefix ends up in a `git worktree add -b` argument: it is validated on the daemon too, and git is run without a shell. `git.push` and `git.unpushed` take a path, like the other `git.*` RPCs. Their `branch` is used only once `refs/heads/<branch>` exists, so it cannot be read as an option; `merged_head` only when it is hex and a commit git has.

## Out of scope

- PR sessions keep `moonlet/pr-<n>`; tracker branch templates keep their own names.
- Changing the worktrees folder.
- Settings for hosts that are not connected.

## Test plan

- Rust unit tests: `git.toml` defaults, partial files, a bad file, prefix validation, the branch name with a prefix, start point from origin, `git.unpushed` parsing.
- Daemon tests (`crates/moonletd/tests/daemon.rs`): settings round trip over RPC and in `git.toml`; a session starting from `origin/main`; a prefixed branch; archive with `delete_remote`; `git.unpushed` on a real repository.
- Vitest: host switch options, defaults for an old daemon, prefix validation, archive plan (which flags, prompt text), fetch interval due, auto fast-forward decision.
- e2e (`git-settings.e2e.ts`): change a setting, leave and come back, it is kept.

## Open questions

- None.
