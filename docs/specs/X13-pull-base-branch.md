# X13: Pull the base branch

- **Status:** implemented
- **Priority / phase:** P1 · phase 3 (extends [X5](X5-workspaces-projects-sessions.md))
- **Design:** "Pull Base Branch" in the Project settings dialog design (Claude Design export, 2026-10-04)

## Summary

New sessions branch from the project's local base branch (`main` unless `.moonlet/config.toml` sets `base_branch`). After a PR merges on GitHub, the local branch is stale until the user pulls it by hand, so the next session starts without the merged work. The sidebar shows when the base branch is behind `origin`, lists the incoming commits on hover, and fast-forwards it with one click.

## User journey

1. A session's PR merges on GitHub. moonlet fetches `origin/<base>` for that project.
2. The project row in the sidebar shows a chip next to the project name: an arrow and the number of commits `main` is behind, for example `↓ 3`.
3. Hovering the chip opens a popover: "main is 3 commits behind origin", the incoming commits (short sha and subject, newest first), when moonlet last fetched, and **Later** / **Pull main**.
4. Clicking the chip, or **Pull main** in the popover, fast-forwards the local branch. The chip shows `pulling` meanwhile, then disappears, and a toast says "Pulled 3 commits into main. New sessions start from 9c41e2a."
5. When the local branch has commits that are not on `origin`, the chip reads `diverged`. Hovering or clicking it opens a popover that explains that moonlet only fast-forwards, changed nothing, and offers a `git pull --rebase` command to copy.

## Behaviour and acceptance criteria

- [x] `git.base_status {path, branch, fetch}` compares `refs/heads/<branch>` with `refs/remotes/origin/<branch>` and returns `ahead`, `behind` and the incoming commits (at most 20, newest first).
- [x] It returns `null` when the repository has no `origin` remote-tracking branch for `branch`, or no local branch of that name.
- [x] With `fetch: true` it runs `git fetch origin <branch>` first. A failed fetch (offline, no access) does not fail the call: the status comes from the refs already there and `fetch_error` carries the message.
- [x] It reports the work tree that has the branch checked out, if any (`checkout`).
- [x] `git.pull_base {path, branch}` fast-forwards the local branch to `origin/<branch>` without fetching again, so it pulls exactly the commits the popover showed. It returns how many commits it pulled and the new head.
- [x] When the branch is checked out in a work tree, the pull runs `git merge --ff-only` there, so the files on disk follow. Otherwise it moves the ref with a compare-and-swap `update-ref`.
- [x] `git.pull_base` refuses a diverged branch and changes nothing.
- [x] The chip shows the behind count, `pulling` while a pull runs, `diverged` when the branch is both ahead and behind, and nothing when the branch is up to date or only ahead.
- [x] The app fetches when a host loads, every 5 minutes, when the project list changes (for example a new base branch in Project settings), and when one of the project's session PRs turns merged. A fetch after a merge labels the popover footer "after PR #N merged".
- [x] Hovering the chip shows the popover. Clicking a behind chip pulls straight away; clicking a diverged chip opens the popover, and clicking while a pull runs does nothing.
- [x] Only one pull popover is open at a time. Opening another project's popover closes the first, so a Pull click cannot land on the wrong project's popover.
- [x] The diverged popover's command targets the work tree that has the branch checked out. When none does, it switches to the branch first.

## UI

`Sidebar.tsx`, the project header row: the chip sits right after the project name, on the left. It is 22 px high, mono 11.5 px, `bg-panel-2` with a strong border.

- Behind: `ArrowDown` icon and the count, accent colour. Accessible label "main is 3 commits behind origin/main" (no native tooltip, which would cover the popover).
- Pulling: spinning `Loader2` and "pulling", muted.
- Diverged: `ShieldAlert` and "diverged", error colour.

The popover is fixed below the chip, 276 px wide, like the row context menu. It opens when the pointer enters the chip and closes 150 ms after the pointer leaves both the chip and the popover, so the pointer can cross the gap. A mousedown outside or Escape closes it too. Only one pull popover is open at a time: opening another project's closes the first. The pure logic (chip, texts, command) lives in `lib/baseSync.ts`.

## Protocol and RPCs

- `git.base_status {path, branch, fetch}` → `BaseStatus | null`: `{branch, upstream, ahead, behind, commits: Commit[], checkout: string | null, fetch_error: string | null}`.
- `git.pull_base {path, branch}` → `{pulled, head}`.

Both run on the host that owns the project, so remote projects work the same way.

## Security considerations

`branch` comes from the project's config and reaches git as a positional argument, so both RPCs reject a name that starts with `-` or fails `git check-ref-format --branch`. Fetching uses the user's git credentials; `GIT_TERMINAL_PROMPT=0` keeps it from prompting.

## Out of scope

- Rebasing or merging a diverged branch (the user runs the shown command).
- Remotes other than `origin`.
- Updating existing sessions' branches.
- The chip in the "group by status" and "no grouping" views, which have no project row.

## Test plan

- Integration (`crates/moonlet-core/src/git.rs`): a clone of a bare origin that is behind, up to date, diverged, and missing the remote branch; a failed fetch; pulling with the branch checked out (work tree updated) and not checked out (ref moved); a refused diverged pull.
- Unit (`apps/desktop/src/lib/baseSync.test.ts`): chip states, what a chip click does, popover texts, fetched label, pull toast, the diverged command, and the newly merged PR detection that triggers a fetch.
- e2e (`apps/desktop/e2e/specs/pull-base.e2e.ts`): with an origin that has new commits, the chip shows the count, hovering it lists the commits, and clicking it moves the local branch. With a second project behind, hovering its chip and then the first project's leaves one popover open.
