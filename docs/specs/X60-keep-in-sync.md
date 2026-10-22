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
- [ ] The worker link (X41) is open while **Use this Mac for heavy commands** is on *or* at least one session is kept in sync. Keep in sync does not turn on heavy commands. This replaces X41's "with `enabled: false` … no link is opened".
- [ ] Turning it off asks: "Stop keeping fix-cart in sync? The copy on this Mac is removed." When files differ, the modal adds "2 files that differ are saved to ~/.moonlet/sync-leftovers/fix-cart first." The copy's worktree is then removed (`git worktree remove --force`). The branch stays in the Mac's repository.
- [ ] A copy is kept in sync until it is turned off or its session is archived. It survives restarts of either daemon, live upgrades (S3) and the app being closed.
- [ ] Several Macs may keep copies of one session. The central host serves them one change at a time.

### Keeping new sessions in sync

- [ ] The project page of a project on the central host (Settings › Projects › shop, X43) has **Keep new sessions in sync with this Mac**, off by default. It is this Mac's setting, saved by this Mac's daemon, not in `.moonlet/config.toml`, because another Mac paired with the same host decides for itself. Projects on other hosts don't have it.
- [ ] Projects are matched by identity (X41), so the setting holds when the project is removed and added again on the central host.
- [ ] The new-session composer (X54), for a project on the central host, has a **Keep in sync with this Mac** checkbox. It is ticked when the project's setting is on, and the user can untick it for one session. A ticked box turns sync on as soon as the session is made.
- [ ] A session made on the central host any other way while the setting is on, such as from the phone or by an agent's `moonlet session new`, is kept in sync too. While linked, this Mac's daemon sees such a session within 5 s. A session made while the link is down is picked up once it is back, unless it is gone by then.
- [ ] Turning the setting off leaves the existing copies alone. It only changes what happens to new sessions.

### Making the copy

- [ ] The copy lives in a repository on this Mac with the same project identity (X41) as the session's project:
  - this Mac's own project with that identity, when there is one;
  - otherwise a clone moonlet makes once per identity at `$MOONLET_HOME/clones/<origin>` (such as `~/.moonlet/clones/github.com/acme/shop`), from the URL the central host sends. That clone is not added to the sidebar.
- [ ] The URL the central host sends is its `origin` remote with any password or token removed and the scheme and user kept: `git@github.com:acme/shop.git` stays as it is, and `https://alex:ghp_x@github.com/acme/shop.git` becomes `https://github.com/acme/shop.git`. The clone uses this Mac's own git credentials.
- [ ] A clone that fails pauses the copy with git's message: "Paused: cannot clone github.com/acme/shop: Repository not found." **Retry** tries again. A project with no origin (identity origin `null`) and no matching project on this Mac pauses with "Paused: add shop on this Mac first. studio-mini's shop has no origin to clone from."
- [ ] Commits the session has and this Mac lacks, such as unpushed ones, come from the central host as a git pack after this Mac has fetched origin. No push to origin is needed.
- [ ] The copy is a worktree on the session's branch. It sits at the session's own absolute path when this Mac can create it and nothing is there yet. When the two Macs share the user name, `/Users/alex/.moonlet/worktrees/shop/fix-cart` matches on both. Otherwise it sits at `$MOONLET_HOME/copies/<host>/<project>/<session>`, such as `~/.moonlet/copies/studio-mini/shop/fix-cart`.
- [ ] When the session's branch is already checked out in another worktree on this Mac, the copy pauses with "Paused: fix-cart is checked out in ~/src/shop on this Mac."
- [ ] A copy is never listed as a worktree of this Mac's project (the composer's existing worktrees, X46's worktrees without a session).
- [ ] Once made, the copy's files and `HEAD` match the session's: the same tree, by the rule in "What syncs", and the same commit.

### Setup in the copy

- [ ] Once the copy is made, when the copy's `.moonlet/config.toml` has a `setup` script (X1), the app asks in the confirm modal: "Run shop's setup in the copy on this Mac? `pnpm install` (from .moonlet/config.toml)", with **Run setup** and **Skip**. The modal shows the command exactly as the file has it.
- [ ] The approval is remembered for this project (by identity) and this exact command. A later copy with the same command runs it without asking. A copy whose command differs in any way, such as one an agent changed in the session, asks again and shows the new command.
- [ ] Setup runs in the copy's folder the way X1 runs it (`$SHELL -lic`, with the session env vars of A4, the paths being the copy's). Files keep syncing while it runs. Ignored files it writes, such as `node_modules`, stay on this Mac.
- [ ] While setup runs, the copy reads "Running setup…". When it fails, the copy reads "Setup failed (exit 1)". Both states, and **Skip**, still sync files. The popover offers **Show output** and **Run setup again**. The output goes to `$MOONLET_HOME/sync/logs/<copy id>.log`, and only the last run is kept.
- [ ] Setup runs once per copy. Later edits to the setup script don't run it again by themselves. **Run setup again** runs the current command, and asks first if that command hasn't been approved.
- [ ] Turning the copy off, or archiving its session, stops a setup that is still running, as X1 stops a script whose tab closes.

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

  A file that an earlier snapshot took in leaves a snapshot only once it is gone from disk. One that becomes ignored, and that HEAD doesn't track, stays at the version the last snapshot took while it exists: `.git/info/exclude` doesn't sync, so a file ignored on one side only would otherwise read as deleted on the other, and freezing it keeps anything written to it after it was ignored on its own machine. Files HEAD tracks are always in and follow their edits, also ignored ones committed later. (`a_snapshot_follows_gits_rules_without_global_excludes`, `a_file_ignored_after_a_snapshot_stays_at_its_last_version`, `a_file_head_tracks_is_in_even_when_force_added_later`, `thousands_of_paths_fit_whatever_the_command_line_allows`)

- [ ] The staging area does not sync. When a side receives commits that move its branch, its index is reset to the new `HEAD` and its files are left alone (as `git reset --mixed`), so anything staged there is unstaged.
- [ ] A file over 100 MiB stays on its own machine. The copy's popover lists it: "big.bin is over 100 MB and stays on each machine." The rest syncs. A file that grows past the limit keeps the version last synced, so the other side never reads it as deleted. The limit holds for files HEAD tracks that are committed past an ignore rule too. (`a_file_over_the_limit_stays_on_its_machine_and_never_reads_as_deleted`, `a_file_committed_past_its_ignore_rule_is_still_held_to_the_size_limit`)
- [ ] Submodule entries sync as commit ids. Submodule contents don't.
- [x] A file name that is not text (only Linux allows one) stays out of the snapshot, and the snapshot lists it apart: carried as text it would be renamed, or folded into another name. A tree from the other side naming one is refused. (`a_name_that_is_not_text_stays_out_of_the_snapshot`, `a_tree_naming_a_file_in_bytes_that_are_not_text_is_refused`)

### Keeping it in sync

- [ ] Each side watches its worktree with the file watcher the Files tab already uses (F1). A change produces a new snapshot. When it differs from the last snapshot both sides agreed on (the **base**), the change is sent.
- [ ] The central host decides. Both sides send their changes to it, it reconciles them with the base, applies the result to its worktree, and sends the result to every copy. Two daemons never reconcile at the same time.
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

- [ ] A path that differs stays different, and the other paths keep syncing. When one side's file later changes to match the other's, the path no longer differs.
- [ ] When a path starts to differ, the app shows a desktop notification: "fix-cart: src/cart.ts changed on both studio-mini and this Mac. Pick a version." Several paths that start to differ in one reconcile give one notification: "fix-cart: 3 files changed on both studio-mini and this Mac. Pick a version for each." Clicking it opens the session with the mark's popover. A path that still differs is not notified again.
- [ ] The notification has its own switch in Settings › Notifications, "A file differs between machines", on by default and next to X47's per-event switches. With it off, the mark and the popover still show the differing files.
- [ ] **Keep studio-mini's** and **Keep this Mac's** put that side's version on both sides. **Compare** opens the two versions side by side in a file tab (X26).
- [ ] A file this Mac changes while a change to it from the central host is being applied is not overwritten. It is reconciled as a change on this Mac.
- [ ] With both daemons on one machine, as in the tests, an edit on either side shows on the other within 1 s.
- [ ] Applying a change from the other side does not send it back. Once the last edit has synced, both sides report the same snapshot and stay `in_sync`.

### Commits

- [ ] A commit on either side moves the branch on the other. The other side receives the commit as a git pack and fast-forwards its branch.
- [ ] When both sides have commits the other lacks, the branch has **diverged**. Files keep syncing, and the branch stays where it is on each side. The copy reads "fix-cart has diverged: 1 commit on this Mac, 2 on studio-mini. Files still sync." **Use studio-mini's branch** moves this Mac's branch to the central host's commit and keeps this Mac's commits on a new branch, `fix-cart-this-mac`.
- [ ] When either side checks out another branch, or detaches `HEAD`, the copy pauses with "Paused: the copy is on main, not fix-cart." It resumes when the branch is checked out again.

### Disconnects and restarts

- [ ] While the link is down, the copy reads "Waiting for studio-mini. Changes made on this Mac sync when it is back." Both sides keep working on their own.
- [ ] When the link is back, both sides send what changed since the base, and the central host reconciles them as above. No edit made on either side while the link was down is lost.
- [ ] The base, the copy list and each copy's differing paths are saved on both sides. After a restart of either daemon, syncing resumes from the saved base.
- [ ] The objects of each side's base are kept from `git gc` by a ref, `refs/moonlet/sync/<copy id>`. Turning the copy off deletes the ref.

### When the session goes away

- [ ] Archiving the session on the central host tells every linked copy, which then removes its worktree. Files that differ, and files changed on this Mac since the last sync, are first saved under `$MOONLET_HOME/sync-leftovers/<session>/`, keeping their paths, and a toast says "fix-cart was archived on studio-mini. 1 file from this Mac is in ~/.moonlet/sync-leftovers/fix-cart."
- [ ] Archiving does not wait for a copy that is offline. When the copy reconnects and its session is gone, it saves its leftovers in the same way and is removed.
- [ ] A copy whose folder was deleted on this Mac pauses with "Paused: the copy at ~/.moonlet/worktrees/shop/fix-cart is gone." **Retry** makes it again from the central host.

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
- `sync.resolve {copy, path, keep: "central" | "worker"}`;
- `sync.use_central_branch {copy}`;
- `sync.retry {copy}`;
- `sync.run_setup {copy, command}`. It runs only when `command` is the copy's current setup command, and it records the approval. A stale command is refused with `setup_changed` and the current command.
- `sync.project_get {identity}` and `sync.project_set {identity, keep_new}`, for the project page and the composer;
- the event `sync.changed {copy}`. A copy that needs approval for setup reports `setup: {state: "needs_approval", command}`, and the app shows the modal.

**Over the worker link (X41), worker to central host:**

- `sync.open {copy, session}` returns `{path, branch, head, identity, origin_url}`, or `not_found` for a session that is gone.
- `sync.offer {copy, base, tree, head, pack}` carries the worker's changes. The answer is the reconciled `{base, tree, head, pack, differs}`.
- `sync.close {copy}`.

**Over the worker link, central host to worker:**

- `sync.update {copy, base, tree, head, pack}`: the central host's new state, sent after its own changes and after reconciling another worker's offer. The answer is `{tree}`, the worker's snapshot after applying it.
- `sync.closing {copy, reason: "archived"}`.

**Types:**

- `Copy {id, host, session, path, state, setup, differs: [path], too_big: [path], diverged: {ahead, behind} | null}`.
- `setup` is `null` (no setup script), or `{state, command}`, where `state` is `needs_approval`, `running`, `done`, `failed {exit}` or `skipped`.
- `state` is `copying`, `in_sync`, `syncing {files}`, `waiting` or `paused {reason}`.
- `base`, `tree` and `head` are git object ids.

**Packs:**

- A new frame kind 4, `Pack`, with payload `[u32 BE transfer id][bytes]`, carries git pack data. The JSON field `pack` names a transfer id, or is `null` when no objects are needed.
- Chunks are at most 1 MiB, so a large pack never holds up terminal output on the same connection. An empty chunk ends the transfer.
- A pack holds only the objects the other side's base lacks (`git rev-list --objects <new> --not <base>`).

**New sessions:** this Mac's daemon subscribes to `sessions.changed` on the central host over the worker link. This is how it learns of sessions made elsewhere in a project set to keep new sessions in sync.

**Versions:** `PROTOCOL_VERSION` goes from 4 (X41) to 5. `docs/protocol.md` gets the frame kind and the methods.

## Data and config

- **On both sides,** `$MOONLET_HOME/sync/copies.json` lists each copy:
  - id, session, path and repository;
  - base tree and base commit;
  - the paths that differ.

  On the central host, it also records each copy's worker id. No token is in it.
- **On this Mac,** `$MOONLET_HOME/sync/projects.json` holds, per project identity:
  - `keep_new`, the project page's switch;
  - `approved_setup`, the setup commands the user approved, as exact strings.

  Example:

  ```json
  {
    "github.com/acme/shop 4171b03ff0d2bd434751f17bc9d34da784f97e72": {
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
  - `clones/<origin>/`;
  - `copies/<host>/<project>/<session>/`, for copies that cannot sit at the session's path;
  - `sync-leftovers/<session>/`.
- **No new keys** in `.moonlet/config.toml`.

## Security considerations

- **What a central host can write on this Mac.** Any file inside the copy's worktree and the copy's branch, nothing else. The worker refuses a tree that would write outside the worktree, into `.git`, or through a symlink, the way `git checkout` refuses such paths. A tree with `../x`, `.git/hooks/post-checkout` or `link/x` (where `link` is a symlink) pauses the copy with "Paused: studio-mini sent a path outside the copy." Hooks in `.git` never sync, because `.git` is outside the snapshot.
- **The setup script runs code from the central host on this Mac.** The command comes from a synced file that the agent on the central host can edit. So this Mac never runs a setup command the user hasn't seen. Approval holds for one exact string, and any change to it asks again. The Mac usually holds more secrets than the central host, which is why a command approved there doesn't count here. The check happens in the daemon (`sync.run_setup` refuses a stale command), not only in the app.
- **Files that run code when opened.** A prompt-injected agent on the central host can write `.vscode/tasks.json`, `.envrc` or a `package.json` script into the copy. Opening the copy in an editor or running commands in it carries the same risk as opening a branch the agent pushed. The popover says so on first use: "Files here come from the agent on studio-mini. Your editor's workspace trust applies."
- **Secrets.** Ignored files never sync, so `.env` stays put. A file that was synced and is ignored afterwards keeps its last synced version on the other side; nothing written to it after that leaves this machine. An untracked file that is *not* ignored does sync, and its contents enter both repositories' object stores. This is git's rule, and the first-use note mentions it.
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
    - a setup that exits 1 reports `failed {exit: 1}`, and its output is in the log.
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
