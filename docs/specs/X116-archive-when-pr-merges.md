# X116 — Archive a session when its PR merges

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X2 (pull requests), X55 (Git settings, archiving), X108 (saved PR states), X86 (archived sessions keep their chats), X83 (session processes), X49 (queued messages), X11 (stacks), X68/X72 (sessions across hosts)
- **Related ADRs:** none

## Summary

A session's work is usually over once its pull request merges, but the session stays in the sidebar, with its worktree, terminals and agents, until the user archives it by hand. With many sessions this is a chore, and the worktrees fill the disk. With this feature, a host can archive a session by itself once the session's PR merges, and optionally once it is closed without merging. The daemon watches the PRs, so this works while the app is closed. It never loses work: a session with uncommitted files, or with commits that exist only on this machine, is left alone and marked instead.

## User journey

1. The user opens Settings › Git and turns on **Archive when its pull request merges** under "Archiving a session".
2. They open a PR from a session, and go on with other work. The app may be closed.
3. A reviewer merges the PR on GitHub. Within 5 minutes the session's host sees the merge, and archives the session as a click on Archive would, with the Git page's choices for the worktree folder and branch.
4. The session leaves the sidebar's live list. In Archived it reads "Archived when #12 merged". Restore brings it back as with any archived session (X86).
5. Another session's PR merges while its worktree still has an uncommitted file. That session is not archived. Its sidebar row shows "Merged · not archived: work only on this Mac", and the archive prompt lists the file, as X55 does.

## Behaviour and acceptance criteria

### Settings

- [ ] Settings › Git › Archiving a session gains **Archive when its pull request merges** (default off), with the hint "Archives a session, as Archive does, once its pull request merges. Sessions with uncommitted files or commits not on origin are left alone."
- [ ] Under it, indented and enabled only while it is on: **Also when its pull request is closed without merging** (default off), with the hint "A closed pull request can be reopened. Its branch and commits stay unless the settings above delete them."
- [ ] Both save through `git.set_settings` per host, like every Git setting, and are found by Search settings under `App › Git`.

### Which sessions are archived

- [ ] A session is archived when the setting is on, its PR is the session's PR as X2 defines it, and that PR is merged (or closed, with the second switch on). A session without a PR is never archived.
- [ ] Only the host that runs the session archives it. A central host's copy of another member's session (X72) is not archived by the central host.
- [ ] It waits, and tries again at the next check, while any of the following holds. The sidebar row shows the reason, for example "Merged · archives when the agent is done":
  - an agent in the session is working or blocked (`AgentState::Working` or `Blocked`);
  - a chat of the session has queued messages (X49) or an open permission ask;
  - a heavy command of the session runs (X62).
- [ ] It is not archived, and is not tried again until something changes, when `git.unpushed` (with the merged PR's head as `merged_head`) finds uncommitted files, or commits not on origin. The row reads "Merged · not archived: work only on this Mac" (or "…on <host>"). The check runs again when the session's git status changes, so committing and pushing, or discarding the files, lets the next check archive it.
- [ ] A PR merged before the setting was turned on counts too. The first check after turning it on archives every such session that passes the rules above. The setting's hint says so after the first change: "<n> sessions with merged PRs will be archived." (Counted from `gh.pr_known`.)
- [ ] A session the user restores after it was archived this way is not archived again for the same PR.

### What archiving does

- [ ] It is `session.archive` as the Archive prompt sends it, run by the daemon: the archive script runs, terminals end, chats are kept (X86).
- [ ] The worktree folder follows "Worktree folder" (Remove or Keep).
- [ ] The local branch follows "Local branch": Keep keeps it; "Delete when its PR merged" deletes it for a merged PR and keeps it for a closed one; Always delete deletes it. Ask each time keeps it, since nobody is there to ask.
- [ ] "Also delete the branch on origin" applies as in X55: only for a merged PR whose local branch is deleted.
- [ ] A failed archive (git refuses to remove the worktree, say) leaves the session live. Its row reads "Merged · could not archive: <error>", and it is not tried again for that PR until the app's Archive is used or the daemon restarts.
- [ ] In a stack (X11), only the session of the merged PR is archived. The sessions of the PRs above it stay live.

### Where the user sees it

- [ ] An archived session in the Archived list reads "Archived when #<n> merged" (or "…was closed") under its name, and keeps it after a daemon restart.
- [ ] When the app is open, a toast says "Archived <session name>: #<n> merged" with a Restore button.
- [ ] When the archived session is the one open in the window, the window goes to the session shown after it, as for a manual archive.

### How the daemon watches PRs

- [ ] While the setting is on, the daemon checks the PR of each of its live sessions that has an open or draft PR saved in `prs.json` (X108) every 5 minutes, through `gh.pr_status`'s own lookup, and saves the answer as X108 does. A session with no saved PR, or with a closed one, is checked at most every 15 minutes, so a PR an agent opened in a session the app never polled is found.
- [ ] A PR state the app's own polls find (`gh.pr_status` from the app) triggers the same rules at once, without waiting for the daemon's next check.
- [ ] Checks run a few sessions at a time (at most 4), as the app's background polls do.
- [ ] With the setting off, the daemon runs no checks of its own.
- [ ] A failed lookup (`gh` missing, offline, not logged in) archives nothing and is retried at the next check.

## UI

- Settings › Git: two rows under "Archiving a session", after "Warn before losing unpushed work": a switch row, and an indented switch row under it (as the design's "Open as draft" under "Open pull requests automatically").
- Sidebar row of a merged session that waits or was refused: the merged icon (X2) and a muted second line with the reason. Hovering it shows the full text.
- Archived list: a second line "Archived when #12 merged".

## Protocol and RPCs

- `GitSettings` gains `archive_on_merge: bool` and `archive_on_close: bool` (both default `false`). An older app ignores them; an older daemon leaves them out, and the app hides the rows.
- `Session` gains `auto_archive: { pr: number, state: "waiting" | "refused" | "failed" | "archived", reason: string, merged: bool } | null`, sent in `sessions.changed`. Archived sessions keep it.
- No new methods.

## Data and config

- Git settings: two new fields in the host's daemon settings file, as X55 keeps the others.
- `state.json`: the session's `auto_archive` record, and for a restored session the PR number it will not be archived for again.
- `prs.json` (X108): written by the daemon's own checks too.

## Security considerations

Nothing crosses a new trust boundary. The daemon runs the same `gh` lookups the app asks it for today, and the same archive. Archiving is destructive for the worktree, so the rules never archive a session with work only on this machine, and a restored session is not archived again for the same PR. The settings change only through `git.set_settings`, which only the proven app may call.

## Out of scope

- Opening pull requests automatically when an agent pushes.
- Archiving sessions without a PR, or after an idle time.
- Archiving on another member's behalf (X72 copies).
- GitHub webhooks: the daemon polls.

## Test plan

- Pure decision function in `moonlet-core` (`auto_archive::decide`), unit tests with literal inputs: merged PR, idle session, no unpushed work → archive with the settings' worktree and branch choices; closed PR with the second switch off → nothing; working agent → waiting with its reason; uncommitted files → refused; restored for #12 → nothing for #12, archive for a later #13; Ask each time → keeps the branch; a stack's merged bottom entry → only that session.
- Daemon test in `crates/moonletd/tests/` with the fake `gh` the X108 tests use: a session whose PR turns merged is archived within one check, its worktree removed, `auto_archive.state` is `archived` in `session.list`; with the setting off, no `gh` call is made.
- Daemon test: a merged session with an uncommitted file is not archived and reads `refused`; after the file is committed and pushed, the next check archives it.
- `apps/desktop/src/lib/` tests for the sidebar's reason line and the Archived list's second line.
- e2e (saving settings and archiving are crucial): `e2e/specs/git-settings.e2e.ts` turns the switch on, restarts the app and finds it on; a fake merged PR's session leaves the live list and shows in Archived with "Archived when #12 merged".

## Open questions

- Should a session pinned to the top (X112) be skipped?
- Is 5 minutes right, or should the open session's minute poll (X2) be the only fast path?
