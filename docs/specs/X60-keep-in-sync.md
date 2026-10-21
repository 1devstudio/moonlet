# X60 — Keep in sync: a live copy of a remote session on this Mac

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0009](../adr/0009-central-host-workers-live-copies.md) (live copies), [0011](../adr/0011-machines-connect-over-the-tailnet.md) (the tailnet transport)
- **Depends on:** [X41](X41-worker-link-and-project-identity.md): the worker link, requests from the central host to a worker, and project identity.

## Summary

A session on the central host, such as the Mac mini `studio-mini`, can be **kept in sync with this Mac**. This Mac's daemon then holds a **live copy** of the session's worktree: a real git worktree on the local disk, at the same path when it can be, kept in sync both ways while the two machines can reach each other. The agent keeps running on the central host. The user can open the copy in VS Code or Cursor, run commands in it, and edit it, and the edits reach the agent within a second. Edits made while the link is down sync when it comes back.

Git's own rules decide what syncs, as ADR 0009 decided: tracked files and untracked files that are not ignored. `node_modules`, `target/` and `.env` stay on each machine, so the copy runs the project's `setup` script once it is made, after the user approves the command. Commits sync too, as git objects. When both sides change the same file differently, neither side's version is lost: the user is notified, and the file stays different on each side until they pick one.

A project on the central host can be set to keep its new sessions in sync with this Mac, so the user doesn't turn it on for each session.

This spec delivers ADR 0009's two live-copy slices ("one way, then both ways") together. A copy that silently overwrites the user's own edits would be worse than no copy, so the first PR of the stack already detects edits made on this Mac and treats them as conflicts (see Delivery).

## User journey

1. The MacBook is paired with `studio-mini` (X57), which is its central host (X41). In the sidebar, the session `fix-cart` of project `shop` sits under the `studio-mini` header.
2. The user right-clicks `fix-cart` and picks **Keep in sync with this Mac**. A sync mark appears after the session's name, and its tooltip reads "Copying to this Mac…".
3. Once the files are copied, a modal asks: "Run shop's setup in the copy on this Mac? `pnpm install` (from .moonlet/config.toml)". The user clicks **Run setup**. The tooltip reads "Running setup…", then "In sync · ~/.moonlet/worktrees/shop/fix-cart".
4. The user picks **Open in › Cursor** in the Files tab. Cursor opens the local copy, which is already on branch `fix-cart` with the agent's uncommitted edits and its own `node_modules`.
5. The agent on `studio-mini` edits `src/cart.ts`. The change shows in Cursor within a second. The user fixes a typo in `README.md` in Cursor, and the agent's next `Read` sees it.
6. The user closes the lid and keeps editing `docs/notes.md` on a train with no network. The tooltip reads "Waiting for studio-mini. Changes made on this Mac sync when it is back." Back online, the note reaches `studio-mini` and the mark goes back to "In sync".
7. While the user was offline, the agent also edited `src/cart.ts`, and so did the user, differently. A notification says "fix-cart: src/cart.ts changed on both studio-mini and this Mac. Pick a version." The mark turns to the accent colour: "1 file differs". Clicking the notification opens the mark's popover, which lists `src/cart.ts` with **Keep studio-mini's**, **Keep this Mac's** and **Compare**. The user compares, keeps the Mac's version, and both sides now have it.
8. The agent commits. The copy's branch moves to the new commit, and `git log` in the copy shows it.
9. The session is archived on `studio-mini`. The copy on this Mac goes away, and nothing is lost: no file differed.
10. The user wants every `shop` session on the Mac. In Settings › Projects › shop (studio-mini), they turn on **Keep new sessions in sync with this Mac**. The next session they start in `shop` has **Keep in sync with this Mac** ticked in the composer. A session the agent opens with `moonlet session new` on `studio-mini` is kept in sync too. The setup modal does not ask again while `pnpm install` stays the command.

## Behaviour and acceptance criteria

### Turning it on and off

- [ ] **Keep in sync with this Mac** is in the right-click menu of a session on this Mac's central host, as a checked item. Sessions on other hosts, SSH hosts and this Mac don't have it.
- [ ] Turning it on for a session on a tailnet host that is not the central host asks, in the confirm modal (X23): "Keeping fix-cart in sync needs studio-mini as this Mac's central host. Make it the central host?" Confirming does what choosing **Central host** in Settings does (X41), then turns sync on.
- [x] The worker link (X41) is open while **Use this Mac for heavy commands** is on *or* at least one session is kept in sync. Keep in sync does not turn on heavy commands. This replaces X41's "with `enabled: false` … no link is opened". (`a_copy_has_the_sessions_files_and_commit_under_copies_when_its_path_is_taken`)
- [ ] Turning it off asks: "Stop keeping fix-cart in sync? The copy on this Mac is removed." When files differ, the modal adds "2 files that differ are saved to ~/.moonlet/sync-leftovers/fix-cart-20261021-184500 first." The copy's worktree is then removed (`git worktree remove --force`). The branch stays in the Mac's repository. `sync.stop {copy}` does the daemon's part and returns `{folder, leftovers}`, the files it saved. The central host hears of it then, or when the link is back, which stays open until it has. (daemon: `turning_sync_off_removes_the_copy_and_keeps_what_would_be_lost`; the modal comes with the desktop)
- [x] What is saved is everything only this Mac has: files that differ, files changed here since the last round, untracked secrets (the never-synced list, such as `.env`), and files that stopped syncing because they became ignored or grew past the limit. A link is saved as the link, never as what it points at. Plain ignored files, such as `node_modules` or `target`, are build output and are not saved. (`turning_sync_off_keeps_secrets_and_files_that_stopped_syncing_but_not_build_output`, `files_only_this_machine_has_are_the_secrets_and_those_that_stopped_syncing`)
- [x] Leftovers go to `$MOONLET_HOME/sync-leftovers/<copy folder>-<YYYYMMDD-HHMMSS>` on this Mac's clock, with `-2`, `-3`… when that is taken, so a later stop never writes over an earlier one. (`stopping_the_same_session_twice_keeps_both_leftovers`)
- [x] A copy is removed only once everything is saved. When a file cannot be saved, the copy stays, paused with "Paused: could not save docs/notes.md before removing the copy: <error>", and `sync.stop` fails with `not_saved`. When the worktree cannot be removed, the copy stays, paused with "Paused: could not remove the copy: <error>", and `sync.stop` fails with `failed`. Archiving behaves the same. (`a_copy_whose_files_cannot_be_saved_is_kept_and_paused`, `a_copy_that_cannot_be_removed_is_kept_and_paused`)
- [ ] A copy is kept in sync until it is turned off or its session is archived. It survives restarts of either daemon, live upgrades (S3) and the app being closed.
- [x] Several Macs may keep copies of one session. The central host serves them one change at a time. (`two_macs_keeping_one_session_in_sync_each_get_the_others_edits`)

### Keeping new sessions in sync

- [ ] The project page of a project on the central host (Settings › Projects › shop, X43) has **Keep new sessions in sync with this Mac**, off by default. It is this Mac's setting, saved by this Mac's daemon, not in `.moonlet/config.toml`, because another Mac paired with the same host decides for itself. Projects on other hosts don't have it.
- [ ] Projects are matched by identity (X41), so the setting holds when the project is removed and added again on the central host.
- [ ] The new-session composer (X54), for a project on the central host, has a **Keep in sync with this Mac** checkbox. It is ticked when the project's setting is on, and the user can untick it for one session. A ticked box turns sync on as soon as the session is made.
- [ ] A session made on the central host any other way while the setting is on, such as from the phone or by an agent's `moonlet session new`, is kept in sync too. While linked, this Mac's daemon sees such a session within 5 s. A session made while the link is down is picked up once it is back, unless it is gone by then.
- [ ] Turning the setting off leaves the existing copies alone. It only changes what happens to new sessions.

### Making the copy

- [x] The copy lives in a repository on this Mac with the same project identity (X41) as the session's project:
  - this Mac's own project with that identity, when there is one;
  - otherwise a clone moonlet makes once per identity at `$MOONLET_HOME/clones/<origin>/repo` (such as `~/.moonlet/clones/github.com/acme/shop/repo`), from the URL the central host sends. The `repo` folder keeps one origin's clone from sitting inside another's (`git.example.com/acme` and `git.example.com/acme/shop`), and a clone never goes into, or removes, a folder it didn't make. (`one_origins_clone_never_sits_inside_anothers`, `a_clone_never_removes_a_folder_it_did_not_make`) That clone is not added to the sidebar. (`a_mac_with_the_project_keeps_the_copy_in_its_own_clone_out_of_its_worktree_list`, `a_copy_has_the_sessions_files_and_commit_under_copies_when_its_path_is_taken`, `a_copy_under_copies_takes_the_first_free_folder`)
- [x] The URL the central host sends is its `origin` remote with any password or token removed. The scheme stays. An ssh URL keeps its user, so `git@github.com:acme/shop.git` stays as it is. An https URL loses its whole user part, since a token can sit there alone: `https://alex:ghp_x@github.com/acme/shop.git` and `https://ghp_x@github.com/acme/shop.git` both become `https://github.com/acme/shop.git`. The clone uses this Mac's own git credentials. Only `https://`, `ssh://` and `user@host:path` URLs are cloned, and git may reach the origin over https and ssh only: a local path, `file://` or another transport from the central host would copy one of this Mac's own repositories into the clone. Any other URL pauses the copy with "Paused: cannot clone git.example.com/acme/shop: only https and ssh origins are cloned: git://git.example.com/acme/shop.git". (`a_url_loses_its_password_or_token_but_keeps_its_scheme_and_user`, `only_https_and_ssh_origins_are_cloned`, `an_origin_this_mac_does_not_clone_from_pauses_the_copy`)
- [x] A clone that fails pauses the copy with git's message: "Paused: cannot clone github.com/acme/shop: Repository not found." **Retry** tries again. A project with no origin (identity origin `null`) and no matching project on this Mac pauses with "Paused: add shop on this Mac first. studio-mini's shop has no origin to clone from." (`a_clone_that_fails_pauses_the_copy_with_gits_message`, `a_failed_clone_says_why_in_one_line`, `a_project_without_an_origin_must_be_added_on_this_mac_first`)
- [x] Commits the session has and this Mac lacks, such as unpushed ones, come from the central host as a git pack after this Mac has fetched origin. No push to origin is needed. (`a_copy_has_the_sessions_files_and_commit_under_copies_when_its_path_is_taken`, `a_mac_with_the_project_keeps_the_copy_in_its_own_clone_out_of_its_worktree_list`)
- [x] The copy is a worktree on the session's branch. It sits at the session's own absolute path when that path is `~/.moonlet/worktrees/<project>/<session>` on this Mac, exactly two folders down, with symlinks resolved and no `..`; nothing is there yet; no repository holds it (no `.git` in the worktrees folder, the project folder or the path); and no other copy has it. When the two Macs share the user name, `/Users/alex/.moonlet/worktrees/shop/fix-cart` matches on both. Otherwise it sits at `$MOONLET_HOME/copies/<host>/<project>/<session>`, where `<session>` is the session's folder name, such as `~/.moonlet/copies/studio-mini/shop/fix-cart`; when something is already there, or another copy holds it, at `fix-cart-2`, `fix-cart-3` and so on. (`a_copy_takes_the_sessions_path_when_it_is_free`, `a_copy_takes_the_sessions_path_only_inside_this_macs_worktrees`, `a_copy_takes_only_a_project_and_session_folder_no_repository_holds`, `a_copy_has_the_sessions_files_and_commit_under_copies_when_its_path_is_taken`, `a_copy_under_copies_takes_the_first_free_folder`)
- [x] Each folder name under `clones/` and `copies/` that comes from the central host (an origin's parts, the host, project and session names) is used as it is only when it is up to 100 of `[A-Za-z0-9._-]` and not `.` or `..`. A port's `:` becomes `_` (`clones/gitlab.example.com_8443/team/app`). Any other name becomes the first 16 hex digits of its SHA-256, so `github.com/../../x` is `clones/github.com/5ec1f7e700f37c3d/5ec1f7e700f37c3d/x`. (`folders_named_by_the_central_host_stay_under_copies_and_clones`)
- [x] When the session's branch is already checked out in another worktree on this Mac, the copy pauses with "Paused: moonlet/fix-cart is checked out in ~/src/shop on this Mac." (the branch with the default `moonlet/` prefix) (`a_branch_checked_out_on_this_mac_pauses_the_copy`, `a_path_in_the_home_folder_is_shown_from_tilde`)
- [x] The session's branch name and commit come from the central host, so the copy is made only for a name `git check-ref-format --branch` accepts and a full commit id. A branch of that name already on this Mac is used when it is at the session's commit, and moved up to it when behind. With commits of its own, it is left alone and the copy pauses with "Paused: moonlet/fix-cart on this Mac has commits studio-mini's doesn't." (`a_worktree_needs_a_branch_name_git_accepts_and_a_full_commit_id`, `a_branch_already_here_moves_only_forward`, `a_branch_on_this_mac_with_commits_of_its_own_pauses_the_copy_and_stays`, `a_branch_on_this_mac_behind_the_sessions_moves_up_to_it`)
- [x] A copy is never listed as a worktree of this Mac's project (the composer's existing worktrees, X46's worktrees without a session). (`a_mac_with_the_project_keeps_the_copy_in_its_own_clone_out_of_its_worktree_list`)
- [x] Once made, the copy's files and `HEAD` match the session's: the same tree, by the rule in "What syncs", and the same commit. (`a_copy_has_the_sessions_files_and_commit_under_copies_when_its_path_is_taken`, `a_copy_under_copies_takes_the_first_free_folder`)

### Setup in the copy

- [ ] Once the copy is made, when the copy's `.moonlet/config.toml` has a `setup` script (X1), the app asks in the confirm modal: "Run shop's setup in the copy on this Mac? `pnpm install` (from .moonlet/config.toml)", with **Run setup** and **Skip**. The modal shows the command exactly as the file has it.
- [x] The approval is remembered for this central host, this project (by identity) and this exact command. A later copy with the same command runs it without asking. A copy whose command differs in any way, such as one an agent changed in the session, asks again and shows the new command. (`an_approved_setup_runs_unasked_until_its_command_changes`, `an_approval_not_given_for_this_central_host_does_not_count`)
- [x] Setup runs in the copy's folder the way X1 runs it (`$SHELL -lic`, with the session env vars of A4, the paths being the copy's). Files keep syncing while it runs. Ignored files it writes, such as `node_modules`, stay on this Mac. (`a_copy_runs_the_projects_setup_once_the_user_approves_the_command`, `a_failed_setup_says_how_it_exited_and_keeps_its_output`)
- [ ] While setup runs, the copy reads "Running setup…". When it fails, the copy reads "Setup failed (exit 1)". Both states, and **Skip**, still sync files. The popover offers **Show output** and **Run setup again**. The output goes to `$MOONLET_HOME/sync/logs/<copy id>.log`, and only the last run is kept.
- [ ] Setup runs once per copy. Later edits to the setup script don't run it again by themselves. **Run setup again** runs the current command, and asks first if that command hasn't been approved.
- [x] Turning the copy off, or archiving its session, stops a setup that is still running, as X1 stops a script whose tab closes: the setup runs in its own session, which gets SIGHUP, then SIGTERM after 1.5 s, then SIGKILL after 3 s more, so jobs its shell moved to their own group stop too. (`turning_sync_off_stops_a_setup_still_running`; archiving removes the copy the same way)
- [x] Only the Mac's app approves or skips a setup: `sync.run_setup` and `sync.skip_setup` from a paired device or the `moonlet` CLI are refused with `forbidden`. (`a_copy_runs_the_projects_setup_once_the_user_approves_the_command`)

### What syncs

- [x] A side's **snapshot** is the git tree of its worktree under git's rules: tracked files and untracked files that `.gitignore` and `.git/info/exclude` don't ignore. The user's global excludes (`core.excludesFile`) are not applied, so two machines with different global ignores agree. Worked example, for a worktree with these files:

  | file | git's view | in the snapshot |
  |---|---|---|
  | `src/cart.ts` | tracked, modified | yes |
  | `src/new.ts` | untracked | yes |
  | `node_modules/left-pad/index.js` | ignored by `.gitignore` | no |
  | `.env` | ignored by `.gitignore` | no |
  | `scratch.txt` | ignored only by the user's global excludes | yes |
  | `run.sh` | tracked, mode 755 | yes, as 755 |
  | `link` | a symlink to `src/cart.ts` | yes, as a symlink |
  | `.env.local`, `deploy.pem`, `.npmrc` | untracked, not in `.gitignore` | no, on moonlet's own list |
  | `config/dev.key` | tracked | yes |

  A file that an earlier snapshot took in leaves a snapshot only once it is gone from disk. One that becomes ignored, and that HEAD doesn't track, stays at the version the last snapshot took while it exists: `.git/info/exclude` doesn't sync, so a file ignored on one side only would otherwise read as deleted on the other, and freezing it keeps anything written to it after it was ignored on its own machine. Files HEAD tracks are always in and follow their edits, also ignored ones committed later. (`a_snapshot_follows_gits_rules_without_global_excludes`, `a_file_ignored_after_a_snapshot_stays_at_its_last_version`, `a_file_head_tracks_is_in_even_when_force_added_later`, `thousands_of_paths_fit_whatever_the_command_line_allows`)
- [x] Untracked files that usually hold secrets never sync, even when `.gitignore` doesn't ignore them: `.env`, `.env.local`, `.env.*.local`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `.npmrc` and `.netrc`. An agent on the other side can edit `.gitignore`, so this list lives in moonlet, not the repository. Both sides apply the same list in place of the user's global excludes, so they still agree. A `!` rule in `.gitignore`, such as `!.env.local`, cannot bring them back: moonlet matches the list against file names itself and never hashes such a file. A file renamed to such a name leaves the snapshot. A tracked file on the list still syncs, edits included, because git already has it. (`untracked_secrets_stay_out_even_when_no_gitignore_says_so`, `secrets_stay_out_whatever_the_gitignore_lets_back_in`)

- [x] The staging area does not sync. When a side receives commits that move its branch, its index is reset to the new `HEAD` and its files are left alone (as `git reset --mixed`), so anything staged there is unstaged. (`a_commit_on_the_central_host_moves_the_copys_branch_and_unstages_it`)
- [ ] A file over 100 MiB stays on its own machine. The copy's popover lists it: "big.bin is over 100 MB and stays on each machine." The rest syncs. A file that grows past the limit keeps the version last synced, so the other side never reads it as deleted. The limit holds for files HEAD tracks that are committed past an ignore rule too. (`a_file_over_the_limit_stays_on_its_machine_and_never_reads_as_deleted`, `a_file_committed_past_its_ignore_rule_is_still_held_to_the_size_limit`)
- [x] Submodule entries sync as commit ids. Submodule contents don't. (`a_submodule_is_its_commit_not_its_files`)
- [x] A file name that is not text (only Linux allows one) stays out of the snapshot, and the snapshot lists it apart: carried as text it would be renamed, or folded into another name. A tree from the other side naming one is refused. (`a_name_that_is_not_text_stays_out_of_the_snapshot`, `a_tree_naming_a_file_in_bytes_that_are_not_text_is_refused`)

### Keeping it in sync

- [x] Each side watches its worktree with the file watcher the Files tab already uses (F1). A change produces a new snapshot. When it differs from the last round's, the change is sent: the central host sends `sync.update`, and a copy offers its files with `sync.offer`. (`an_edit_on_the_central_host_shows_in_the_copy_within_a_second`, `an_edit_in_the_copy_reaches_the_central_host_within_a_second`)
- [x] The central host decides. A copy takes an update only while its own files are still the base; otherwise it offers its files, and the central host reconciles them with its own against the copy's base, applies its part to the session, answers what the copy applies, and sends the change to the session's other copies. It takes one offer at a time per session, so two daemons never reconcile at the same time. An update that arrives while the copy's offer is under way gives way to it, and that offer, reconciled with the session as it is then, brings the update's changes. (`a_file_both_sides_change_differs_until_one_version_is_kept`, `two_macs_keeping_one_session_in_sync_each_get_the_others_edits`)
- [x] Reconciling goes path by path. Worked examples, where `a`, `b` and `c` are contents:

  | base | studio-mini | this Mac | result |
  |---|---|---|---|
  | `a` | `a` | `b` | `b` on both |
  | `a` | `b` | `a` | `b` on both |
  | `a` | `b` | `b` | `b` on both |
  | `a` | `b` | `c` | **differs**: each side keeps its own |
  | `a` | deleted | `a` | deleted on both |
  | `a` | deleted | `b` | **differs** |
  | `a` | `a`, now mode 755 | `a` | `a`, mode 755 on both |
  | none | `a` | none | `a` on both |
  | none | `a` | `a` | `a` on both |
  | none | `a` | `b` | **differs** |
  | none (`Readme.md`) | `a` | none, but `README.md` is `b` | both names **differ**: a Mac's disk holds only one of them |
  | `a` | `b` | deleted | **differs** |
  | `a` | `a` | deleted | deleted on both |
  | `a` | deleted | deleted | deleted on both |

  A file on one side where the result would also have a folder of that name, such as `a` from studio-mini and `a/x` from this Mac, differs too: one tree can't hold both. So do new names that differ only in case, files or folders (`Readme.md` from studio-mini and `README.md` from this Mac, or `Docs/x.md` and `docs/y.md`): a Mac's disk would keep one and overwrite it with the other. Names that already sat side by side in the base are left alone. (`names_that_differ_only_in_case_differ_when_new`) (`reconciling_follows_the_worked_examples`, `a_file_against_a_folder_of_the_same_name_differs`, `reconciling_trees_writes_each_sides_tree`)

- [x] A path that differs stays different, and the other paths keep syncing. When one side's file later changes to match the other's, the path no longer differs. (`a_file_both_sides_change_differs_until_one_version_is_kept`, `a_path_stops_differing_once_both_sides_match`)
- [ ] When a path starts to differ, the app shows a desktop notification: "fix-cart: src/cart.ts changed on both studio-mini and this Mac. Pick a version." Several paths that start to differ in one reconcile give one notification: "fix-cart: 3 files changed on both studio-mini and this Mac. Pick a version for each." Clicking it opens the session with the mark's popover. A path that still differs is not notified again. The daemon names those paths in `sync.changed`'s `newly_differing`, once each, so the app needs no memory of what it notified (daemon: `a_path_that_starts_to_differ_is_named_once`).
- [ ] The notification has its own switch in Settings › Notifications, "A file differs between machines", on by default and next to X47's per-event switches. With it off, the mark and the popover still show the differing files.
- [ ] **Keep studio-mini's** and **Keep this Mac's** put that side's version on both sides. **Compare** opens the two versions side by side in a file tab (X26). The daemon side is `sync.resolve {copy, path, keep}` (`a_file_both_sides_change_differs_until_one_version_is_kept`); the buttons come with the desktop PR.
- [x] A file this Mac changes while a change to it from the central host is being applied is not overwritten. It is reconciled as a change on this Mac. (`an_edit_since_the_snapshot_is_never_overwritten`, `an_edit_made_while_an_update_waits_is_offered_not_overwritten`)
- [x] With both daemons on one machine, as in the tests, an edit on either side shows on the other within 1 s. (`an_edit_on_the_central_host_shows_in_the_copy_within_a_second`, `an_edit_in_the_copy_reaches_the_central_host_within_a_second`)
- [x] Applying a change from the other side does not send it back. Once the last edit has synced, both sides stay `in_sync` with no further round. (`a_change_applied_on_one_side_is_not_sent_back`)

### Commits

- [x] A commit on either side moves the branch on the other. The other side receives the commit as a git pack and fast-forwards its branch. A commit changes no file the watcher sees, so each side also looks at its commit and branch every 0.5 s (two `git` runs per copy each time: a known cost, until the watcher follows the worktree's `HEAD` and refs instead). A branch moves only from the commit it was read at, so a commit made meanwhile is never lost, and a side whose branch is no longer checked out keeps its staging area. (`a_commit_on_the_central_host_moves_the_copys_branch_and_unstages_it`, `a_commit_in_the_copy_moves_the_sessions_branch`)
- [x] When both sides have commits the other lacks, the branch has **diverged**. Files keep syncing, and the branch stays where it is on each side. `Copy.diverged` is `{ahead, behind}`: the commits only on this Mac, and those only on the central host. The copy reads "fix-cart has diverged: 1 commit on this Mac, 2 on studio-mini. Files still sync." **Use studio-mini's branch** (`sync.use_central_branch`) moves this Mac's branch to the central host's commit, leaving the files as they are, and keeps this Mac's commits on a new branch, `fix-cart-this-mac` (`fix-cart-this-mac-2` and so on when that name is taken). On a copy that has not diverged it fails with `invalid_params` "the branch has not diverged". (`commits_on_both_sides_diverge_while_files_still_sync_until_the_central_branch_is_used`)
- [x] When either side checks out another branch, or detaches `HEAD`, the copy pauses, and nothing syncs until it resumes by itself once that side is back on the branch. The reasons, for a session on `fix-cart`:
  - "Paused: the copy is on main, not fix-cart."
  - "Paused: the copy is on a detached HEAD, not fix-cart."
  - "Paused: the session on studio-mini is on main, not fix-cart."
  - "Paused: the session on studio-mini is on a detached HEAD, not fix-cart."

  (`a_side_on_another_branch_pauses_the_copy_until_it_is_back`)

### Disconnects and restarts

- [x] While the link is down, the copy reads "Waiting for studio-mini. Changes made on this Mac sync when it is back." Both sides keep working on their own. (`while_the_link_is_down_the_copy_waits_and_then_catches_up`; the text is the desktop PR's)
- [x] When the link is back, both sides send what changed since the base, and the central host reconciles them as above. No edit made on either side while the link was down is lost. (`edits_on_both_sides_while_the_link_is_down_reach_both_sides`, `a_file_both_sides_change_differs_until_one_version_is_kept`)
- [x] The base, the copy list and each copy's differing paths are saved on both sides. After a restart of either daemon, syncing resumes from the saved base. (`a_restarted_worker_resumes_its_copy`, `while_the_link_is_down_the_copy_waits_and_then_catches_up`, `a_live_upgrade_of_the_central_host_loses_no_edit`)
- [x] The objects of each side's base are kept from `git gc` by a ref, `refs/moonlet/sync/<copy id>`. Turning the copy off deletes the ref, on both sides. (`a_copys_base_survives_gc_until_its_ref_goes`, `turning_sync_off_removes_the_copy_and_keeps_what_would_be_lost`)

### When the session goes away

- [ ] Once the session is archived on the central host, it tells every linked copy (`sync.closing`), which then removes its worktree. What would be lost is first saved as when sync is turned off, and a toast says "fix-cart was archived on studio-mini. 1 file from this Mac is in ~/.moonlet/sync-leftovers/fix-cart-20261021-184500." The `sync.changed` for it carries `removed {reason: "archived", folder, leftovers}`. (daemon: `archiving_the_session_removes_the_copy_and_keeps_what_would_be_lost`; the toast comes with the desktop)
- [x] Archiving waits for no copy: the copies hear of it after the session is archived, and an archive that fails leaves them as they are. A copy that is offline or does not answer hears of it when it reconnects, saves its leftovers in the same way, and is removed. So is a copy never finished whose session is gone. (`a_session_archived_while_this_mac_was_away_takes_its_copy_when_it_is_back`, `archiving_the_session_removes_the_copy_and_keeps_what_would_be_lost`, `archiving_never_waits_for_a_mac_that_does_not_answer`, `a_copy_never_made_whose_session_was_archived_goes`)
- [x] A copy whose folder was deleted on this Mac pauses with "Paused: the copy at ~/.moonlet/worktrees/shop/fix-cart is gone." **Retry** makes it again from the central host. (`a_copy_whose_folder_was_deleted_pauses_until_it_is_made_again`)

## UI

- **Session right-click menu:** **Keep in sync with this Mac**, a checked item (see "Turning it on and off").
- **Project page** (Settings › Projects › shop, for a project on the central host): a row **Keep new sessions in sync with this Mac** with a switch. Its hint: "New sessions in shop on studio-mini get a live copy on this Mac." It saves with the page, like the page's other settings (X43), but to this Mac's daemon.
- **New-session composer:** a **Keep in sync with this Mac** checkbox for projects on the central host, under the branch row.
- **Setup modal:** the confirm modal (X23) with the command in a code block, **Run setup** and **Skip**.
- **Notification:** see "Keeping it in sync". Settings › Notifications gets the "A file differs between machines" switch.
- **Sidebar row:** a sync mark after the session name while it is kept in sync. It is muted while copying, waiting or paused, accent-coloured when a file differs or the branch has diverged, and plain otherwise. Its tooltip is the status line.
- **Status lines** (`lib/sync.ts`), one per state:
  - "Copying to this Mac…"
  - "In sync · ~/.moonlet/worktrees/shop/fix-cart"
  - "Syncing 12 files…"
  - "Running setup…"
  - "Setup failed (exit 1)"
  - "Waiting for studio-mini. Changes made on this Mac sync when it is back."
  - "1 file differs" / "3 files differ"
  - "fix-cart has diverged: 1 commit on this Mac, 2 on studio-mini. Files still sync."
  - "Paused: <reason>", with **Retry**
- **Popover** (click the mark): the status line; the copy's path with **Reveal in Finder** and **Open in…**; the files that differ, each with **Keep studio-mini's**, **Keep this Mac's** and **Compare**; files too big to sync; **Use studio-mini's branch** when diverged; **Show output** and **Run setup again**; **Stop keeping in sync**.
- **Open in VS Code / Cursor** (X25), hidden for tailnet hosts today (ADR 0011), is shown for a session kept in sync and opens the local copy at the same relative path.

## Protocol and RPCs

**This Mac's daemon, for the app:**

- `sync.start {session}`, where `session` is the session's id on the central host. It returns the new `Copy`.
- `sync.stop {copy}`;
- `sync.list` returns every `Copy`;
- `sync.resolve {copy, path, keep: "central" | "worker"}` returns the `Copy`. It is a `sync.offer` with that resolution, so it needs the link: while it is down, it fails with `disconnected`. It fails with `invalid_params` for a path that does not differ, `paused` for a paused copy, `not_ready` for one not made yet, and `busy` when the copy kept changing and the resolution was not made (`resolving_says_why_it_could_not`, `resolving_a_paused_copy_says_it_is_paused`).
- `sync.use_central_branch {copy}`, `invalid_params` when the branch has not diverged;
- `sync.retry {copy}`;
- `sync.run_setup {copy, command}`. It runs only when `command` is the copy's current setup command, and it records the approval. A stale command is refused with `setup_changed`, whose message is the current command.
- `sync.skip_setup {copy}`: a setup waiting for approval becomes `skipped`. Both setup methods answer only the Mac's app.
- `sync.project_get {identity}` and `sync.project_set {identity, keep_new}`, for the project page and the composer;
- the event `sync.changed`: the `Copy`, plus `newly_differing`, the paths that started to differ with this change. A copy that needs approval for setup reports `setup: {state: "needs_approval", command}`, and the app shows the modal.

**Over the worker link (X41), worker to central host:**

- `sync.open {copy, session}` returns `{path, branch, head, name, project, identity, origin_url}`, or `not_found` for a session that is gone.
- `sync.fetch {copy, have, again}` returns the session's files and commit now, `{tree, head, too_big, pack}`, as the copy's base. `have` lists the commits the worker's repository already has (its branches, remote-tracking branches and copy bases), which the pack leaves out. With `again`, a made copy asks for a `sync.update` instead, as after `sync.retry`.
- `sync.offer {copy, base, tree, head, too_big, pack, resolve?}` carries the worker's files against its own base. The central host reconciles them with the session's against that base (its own last base when it lacks the worker's), applies its part, and answers `{from, tree, base, head, differs, too_big, pack}`: the worker goes from `from`, the tree it offered, to `tree`, and both keep `base`. If the worker's files changed meanwhile, it applies the answer to every other file, keeps the ones edited since the offer as they are, and offers again against the new base, except that each file it kept keeps, in that base, the version it was edited from. The central host already took the round, so offering against the old base would read the user's two edits as a conflict with each other; taking the new base whole would read an edit made on the old version of a file the central host changed in that round as made on the central host's version, so the copy's edit would silently replace the agent's. The copy sends that base along with its next offer (`an_answer_keeps_the_files_edited_since_the_offer`, `a_file_edited_during_a_round_keeps_the_base_it_was_edited_from`, `an_edit_kept_through_an_answer_still_differs_from_the_central_hosts`). An offer the central host turns away (`busy`, or any error but a pause) is made again after 300 ms, doubling up to 5 s, until it is taken or the link drops; the copy shows syncing meanwhile (`an_offer_the_central_host_turns_away_is_made_again_until_it_is_taken`). With `resolve {path, keep}`, the kept side's version of `path` stands in the base as unchanged, so the other side's gives way to it.
- `sync.close {copy}`.

**Over the worker link, central host to worker:**

- `sync.update {copy, base, tree, head, too_big, pack, off_branch?}`: the central host's new state, sent after its own changes and after another copy's offer changed the session. The answer is `{applied, tree}`, where `tree` is the worker's files, or `null` when its own offer was under way and it did not look. The worker takes the update only while its own files are its base, and then both keep `tree` as the base. Otherwise, or while its own offer is under way, it answers `applied: false` and offers its files, and that round decides. The worker's base wins in each round, so a reply the central host missed (a lid closed mid-update) cannot leave the two apart.
  With `off_branch` (the branch the session is on, empty for a detached `HEAD`), the session has left its branch: the worker pauses the copy and applies nothing. An offer the central host gets while the session is off its branch fails with `wrong_branch`, its message the branch the session is on, and the worker pauses the copy the same way. Such a pause lifts by itself once the session is back; any other pause replaces it and waits for `sync.retry`. (`a_side_on_another_branch_pauses_the_copy_until_it_is_back`, `a_pause_for_another_reason_outlasts_the_session_coming_back_to_its_branch`)
- `sync.closing {copy, reason: "archived"}`.

**Types:**

- `Copy {id, host, session, path, state, setup, differs: [path], too_big: [path], diverged: {ahead, behind} | null}`.
- `setup` is `null` (no setup script), or `{state, command}`, where `state.kind` is `needs_approval`, `running`, `done`, `failed` (`exit`, -1 when a signal or a daemon restart ended it) or `skipped`.
- `state` is `copying`, `in_sync`, `syncing {files}`, `waiting` or `paused {reason}`.
- `base`, `tree` and `head` are git object ids.

**Packs:**

- A new frame kind 4, `Pack`, with payload `[u32 BE transfer id][bytes]`, carries git pack data. The JSON field `pack` names a transfer id, or is `null` when no objects are needed.
- Chunks are at most 1 MiB, so a large pack never holds up terminal output on the same connection. An empty chunk ends the transfer. A `worker.ping` and its reply go out ahead of queued chunks, so a large pack on a slow link never makes the central host drop the worker (X41's 3 missed pings). (`a_ping_never_waits_behind_a_pack_queued_before_it`, `a_pings_reply_never_waits_behind_a_pack_queued_before_it`)
- Only a worker's daemon may send packs; any other connection that sends one is closed. A pack is at most 1 GiB, at most 1 GiB waits at once on one connection, in at most 16 transfers, and a pack nobody takes, or one whose next chunk doesn't come, is dropped after 60 s. Going over a limit, or sending a chunk for a pack already whole, ends the connection.
- A pack holds only the objects the other side's base lacks (`git rev-list --objects <new> --not <base>`).

**New sessions:** this Mac's daemon subscribes to `sessions.changed` on the central host over the worker link. This is how it learns of sessions made elsewhere in a project set to keep new sessions in sync.

**Versions:** `PROTOCOL_VERSION` goes from 4 (X41) to 5. `docs/protocol.md` gets the frame kind and the methods.

## Data and config

- **On both sides,** `$MOONLET_HOME/sync/copies.json` lists each copy:
  - id, session, path and repository;
  - base tree and base commit;
  - the paths that differ.

  On the central host, it also records each copy's worker id. No token is in it.
- **On this Mac,** `$MOONLET_HOME/sync/projects.json` holds, per central host and project identity (the key is `<host> <origin> <root>`, made only when the root is a full hex commit id and the origin has no spaces, so it reads one way only; otherwise nothing is remembered):
  - `keep_new`, the project page's switch;
  - `approved_setup`, the setup commands the user approved, as exact strings.

  Example:

  ```json
  {
    "studio-mini github.com/acme/shop 4171b03ff0d2bd434751f17bc9d34da784f97e72": {
      "keep_new": true,
      "approved_setup": ["pnpm install"]
    }
  }
  ```

- **On this Mac,** `$MOONLET_HOME/sync/logs/<copy id>.log` holds the last setup run's output.
- **The notification switch** is an app setting, next to X47's.
- **A private index per copy,** `<git dir of the worktree>/moonlet-sync-index`, holds the snapshot. Git's stat cache keeps re-snapshotting cheap. The session's own index is never used for a snapshot.
- **One ref per copy,** `refs/moonlet/sync/<copy id>`, in each side's repository, keeps the base's objects from `git gc`.
- **New directories under `$MOONLET_HOME`:**
  - `clones/<origin>/repo/`, one folder per part of the normalized origin, then `repo`;
  - `copies/<host>/<project>/<session>/`, for copies that cannot sit at the session's path;
  - `sync-leftovers/<copy folder>-<YYYYMMDD-HHMMSS>/`.
- **No new keys** in `.moonlet/config.toml`.

## Security considerations

- **What a central host can write on this Mac.** Any file inside the copy's worktree and the copy's branch, nothing else. The session's path comes from the central host, so the copy takes it only inside this Mac's `~/.moonlet/worktrees`: a path such as `/Users/alex/.ssh`, one that backs out with `..`, or one through a symlink that leads elsewhere puts the copy under `copies/` instead, and no folder is made for it. The names of folders under `copies/` and `clones/` that come from the central host are plain names or hashes, never `..` or a path. The worker refuses a tree that would write outside the worktree, into `.git`, or through a symlink, the way `git checkout` refuses such paths. That includes the spellings macOS and Windows read as `.git` (`.g\u200cit`, `GIT~1`, `.git.`) and a symlinked `.gitmodules`. Packs are checked as git checks a fetch with `transfer.fsckObjects` (`index-pack --strict`): a broken object, or a tree with a `.git` or `..` entry, stores nothing and pauses the copy. A tree with `../x`, `.git/hooks/post-checkout` or `link/x` (where `link` is a symlink) pauses the copy with "Paused: studio-mini sent a path outside the copy." Hooks in `.git` never sync, because `.git` is outside the snapshot.
- **The setup script runs code from the central host on this Mac.** The command comes from a synced file that the agent on the central host can edit. So this Mac never runs a setup command the user hasn't seen. Approval holds for one exact string, and any change to it asks again. The Mac usually holds more secrets than the central host, which is why a command approved there doesn't count here. The check happens in the daemon (`sync.run_setup` refuses a stale command), not only in the app. An approval also holds only for the central host it was given for: a project's identity is something any host can claim, so an approval for `shop` on studio-mini doesn't run setup for a copy from another host that says it has `shop`.
- **Files that run code when opened.** A prompt-injected agent on the central host can write `.vscode/tasks.json`, `.envrc` or a `package.json` script into the copy. Opening the copy in an editor or running commands in it carries the same risk as opening a branch the agent pushed. The popover says so on first use: "Files here come from the agent on studio-mini. Your editor's workspace trust applies."
- **Secrets.** Ignored files never sync, so `.env` stays put. A file that was synced and is ignored afterwards keeps its last synced version on the other side; nothing written to it after that leaves this machine. Neither do untracked files on moonlet's own list of usual secret files (`.env.*.local`, `*.pem`, `*.key`, SSH keys, `.npmrc`, `.netrc`), which the repository cannot change: an agent on the central host could otherwise remove a line from `.gitignore` and have the Mac send it a secret. The list replaces the user's global excludes on both sides, so the two still agree on every snapshot. Any other untracked file that is *not* ignored does sync, and its contents enter both repositories' object stores. This is git's rule, and the first-use note mentions it.
- **Credentials.** The origin URL the central host sends has its password or token removed. The Mac clones with its own credentials.
- **Transport.** Everything travels inside the worker link: the tailnet, authenticated with this Mac's device token (X41).

## Out of scope

- Routing heavy commands to the copy, and the fences that make it exact (ADR 0009's routing slice). This spec's snapshot tree id is what a fence will compare.
- Takeover: running the agent from the copy when the central host is unreachable (**Continue on this Mac**, ADR 0009's last slice).
- Copies of this Mac's own sessions on the central host. Copies go from the central host to workers only.
- Running the project's `run` and `archive` scripts (X1) in the copy. Only `setup` runs there.
- A setting that keeps new sessions in sync for a whole workspace, or for every project. The setting is per project.
- Git LFS. A repository whose `.gitattributes` uses `filter=lfs` pauses with "Paused: Git LFS is not supported yet."
- Copies on phones, and a `moonlet sync` CLI command (`moonlet rpc sync.list` works).

## Delivery

One `gh stack`, each PR with its tests:

1. Snapshots and reconciling in `moonlet-core`: the snapshot rule, the reconcile table, private index and base ref.
2. Packs and the `sync.*` methods over the worker link, the initial copy, and changes from the central host to the copy. Edits made on this Mac are already detected and shown as differing files, never overwritten.
3. Changes from the copy to the central host. With this PR it syncs both ways.
4. Commits, divergence and branch checks.
5. Archive, leftovers, and turning sync off.
6. Setup in the copy, with approval.
7. Keeping new sessions in sync: the project setting, and sessions made on the central host.
8. Desktop: the menu item, sidebar mark, popover, Compare, Open in, the setup modal, the notification, the project page switch and the composer checkbox.

## Test plan

Every acceptance criterion maps to a test. Expected values are literals from this spec or from captured git output.

- **Unit, `moonlet-core`:**
  - `snapshot`: a scratch repository with the worked example's files. Assert `git ls-tree -r` of the snapshot tree as a literal list of paths and modes: `scratch.txt` is in it even with a global excludes file that ignores it, `node_modules/…` and `.env` are not, `run.sh` is `100755`, and `link` is `120000`.
  - `reconcile`: every row of the worked-example table, plus "a path that differs stops differing once both sides match".
  - The size limit, using a test-only limit of 1 KiB and a 2 KiB file.
  - Path safety: trees containing `../x`, `.git/hooks/post-checkout` and a path under a symlink are refused.
  - `scrub_origin_url`: the two URLs in the clone criterion, plus `ssh://git@github.com/acme/shop.git` unchanged.
  - `moonlet-proto`: a `Pack` frame round-trips, and a 3 MiB pack splits into three 1 MiB chunks and an empty one.
- **Daemon end-to-end, `crates/moonletd/tests/sync.rs`:** a central host and a worker as two `TestDaemon`s, linked as in X41's `tests/link.rs`. The project is a scratch repository with a bare "origin" beside it.
  - `sync.start` makes a copy whose files and `HEAD` match, including an unpushed commit and an untracked file, at the session's path when free, and under `copies/` when not.
  - A clone from origin is made when the worker lacks the project. Without an origin, the copy pauses with the literal message.
  - An edit on the central host shows in the copy within 1 s, and the other way round. An ignored file does not sync.
  - Both sides edit one file differently: `sync.list` reports it in `differs` on both. Each `keep` resolves it to the expected literal content.
  - The link is killed, the copy edits one file and the central host another, and the link comes back. Both edits are on both sides.
  - Restarting the worker daemon mid-session, and the central host's live upgrade, both resume with no edit lost.
  - A commit on the central host moves the copy's branch. Commits on both sides report `diverged {ahead: 1, behind: 2}` while files still sync. `sync.use_central_branch` leaves `fix-cart-this-mac` at the worker's commit.
  - Archiving the session removes the copy and writes the leftovers. So does archiving it while the worker is stopped, once the worker restarts.
  - A fake central host that sends a tree with `../x` pauses the copy, and no file outside the worktree appears.
  - Two workers keeping one session in sync both receive an edit made on the central host.
  - Setup, using a scratch project whose setup is `touch ignored-by-setup` (ignored in `.gitignore`):
    - a new copy reports `setup: {state: "needs_approval", command: "touch ignored-by-setup"}`;
    - `sync.run_setup` with that command writes the file in the copy, and the file does not appear on the central host;
    - a second copy of the same project runs setup without asking;
    - a copy whose session changed the command to `touch other` asks again, and `sync.run_setup` with the old command is refused with `setup_changed`;
    - a setup that exits 1 reports `failed {exit: 1}`, and its output is in the log;
    - turning sync off during a long setup ends the processes it started within 10 s.
  - With `keep_new` on for the project, a session made on the central host with `session.new` gets a copy within 5 s, and one made while the link is down gets a copy once it is back. With `keep_new` off, neither does. The setting survives a restart of this Mac's daemon.
  - A reconcile that leaves `src/cart.ts` differing reports it once in `sync.changed`. A later reconcile in which it still differs doesn't report it as new.
- **Vitest, `apps/desktop/src/lib/`:**
  - `sync.test.ts`:
    - the status line for each state;
    - which sessions get the menu item, and which projects get the project page switch and the composer checkbox;
    - the composer checkbox's default from `keep_new`;
    - the notification text for one path and for three.
  - `alerts.test.ts`: the "A file differs between machines" switch turns off the banner only.
  - `openIn.test.ts`: a tailnet session kept in sync offers Open in with the copy's local path.
- **e2e, `apps/desktop/e2e/specs/keep-in-sync.e2e.ts`:** the fixture is a second scratch daemon as central host, as in `tailnet-host.e2e.ts`, with a session. The spec turns on **Keep in sync with this Mac**, approves setup in the modal and sees "In sync". It writes a file on the central host and finds it in the copy, then edits a file on both sides and resolves it from the popover. Losing an edit would show within minutes, so this counts as crucial (X12).
- **Manual:** pair the MacBook with the real Mac mini and keep a session in sync. Edit in Cursor while the agent works. Close the lid, edit offline, reopen, and check both edits. Time the initial copy of this repository.

## Open questions

None open. Decided on 2026-10-21:

- **The name stays "Keep in sync".** It sits next to X46's "Keep in step", but the two do different things in different places.
- **The copy runs the project's `setup` script once it is made,** so an editor opened on it has `node_modules`. The user approves each exact command first, because the agent on the central host can change it.
- **A project can keep its new sessions in sync.** The switch is per project and per Mac. When it is on, the composer's checkbox starts ticked, and sessions made on the central host in other ways are kept in sync too.
- **Conflicts notify the user and let them decide.** Both versions stay, each on its own side, until the user picks one. Neither side wins by itself, because an agent could otherwise overwrite the user's edits.
- **The copy lives in this Mac's own clone of the project when there is one,** and in a clone of moonlet's own otherwise. moonlet already puts local sessions' worktrees and branches in the user's clone, so a copy behaves like one of them: `git log` there sees the session's commits, the repository's hooks apply to commits made in the copy, and no second clone is downloaded. The cost is that the session's branch can't also be checked out elsewhere in that clone. That case is rare, and it pauses the copy with a message naming the folder.
