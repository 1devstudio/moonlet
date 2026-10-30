# X74 — Files copied between members although git ignores them, `.env` by default

- **Status:** implemented (untried on real Macs; see Implementation notes)
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0015](../adr/0015-sessions-follow-the-user.md) (sessions follow the user), [0014](../adr/0014-one-account-across-hosts.md) (one account across hosts)
- **Depends on:** [X68](X68-account-state.md) (the account state), [X60](X60-keep-in-sync.md) (live copies), [X72](X72-session-copies-on-the-central-host.md) (copies of every session on the central host)

## Summary

A worktree often needs files that git ignores before it runs: `.env` with the database URL and API keys, `.env.local` with a feature flag. X60 never copies them, on purpose, so a session the Mac mini continues from the MacBook (X73) fails at its first `pnpm dev`.

Each project gets a list of **copied files**: patterns of files that moonlet copies between members although git ignores them, `.env` and `.env.*` by default. A file matching the list is copied wherever the project's work goes:
- between the members' checkouts of the project;
- into each new worktree, from its member's checkout;
- between a session's worktree and every copy of it.

The files travel over the link outside git, so they never enter a git object store.

## User journey

1. The user's project `shop` has `.env` in its checkout on the MacBook, and `.env.local` in the session `fix-cart`'s worktree. `studio-mini` is the central host and has a clone of `shop`.
2. After the update, `studio-mini`'s checkout of `shop` gets `.env` within a few seconds. Settings › Projects › shop shows **Copied between your Macs**, holding `.env` and `.env.*`.
3. The copy of `fix-cart` on `studio-mini` (X72) gets `.env` and `.env.local`.
4. The user closes the lid. `studio-mini` continues `fix-cart` (X73), and the agent's `pnpm dev` reads the same `.env` as on the MacBook.
5. The agent on `studio-mini` adds a line to `.env.local`. When the user is back and types into `fix-cart` on the MacBook, the MacBook's worktree already has that line.
6. The user adds `config/local.yaml` to the list on the MacBook. Every member's checkout and every session of `shop` copies it from then on.

## Behaviour and acceptance criteria

### The list

- [ ] Each project, by project identity (X41), has a list of patterns in the account state, so every member has the same list. A project without a list uses `.env` and `.env.*`.
- [ ] A pattern uses `.gitignore`'s syntax for one line, relative to the worktree's root: `.env` matches in any folder, `/.env` only at the root, `config/*.yaml` inside `config/`. `!` lines, absolute paths and patterns with `..` are refused with `invalid_params`.
- [ ] A file is copied when it matches the list and git does not track it. That includes files `.gitignore` ignores and files on X60's list of usual secret files. A tracked file already travels with git (X60) and is left to it.
- [ ] Never copied, whatever the list says: anything under `.git/`, a link of any kind, and a file over 1 MiB.
- [ ] At most 200 files and 16 MiB are copied per worktree. Matches are taken in the byte order of their relative paths (`/`-separated, from the worktree's root), so every member picks the same files. The 201st match and every later one are skipped. So is the first file that would take the total past 16 MiB, and every file after it, even a smaller one. A skipped file is listed with its reason (see UI).
- [ ] Only the Mac's own app changes the list (`project.copied_files.set`). A paired Mac, a phone, the `moonlet` CLI and an agent get `forbidden`, as `sync.project_set` does (X60). So an agent cannot widen the list to carry files of its choosing to other members.

### Where files are copied

- [ ] **Checkouts.** For each project held by more than one member, matching files are kept the same in every member's checkout of the project (the folder the project was added from, X5). A member without a clone of the project gets nothing.
- [ ] **New worktrees.** A new session's worktree starts with the matching files of its member's checkout, copied before the project's setup runs.
- [ ] **Sessions and their copies.** Matching files are kept the same between a session's worktree and every copy of it: the central host's copy (X72) and copies kept in sync (X60).
- [ ] A change reaches the other side within 3 s of its file settling, while both members are linked. A change made while unlinked is sent when the link is back.
- [ ] While X60 pauses a copy, copied files are neither sent nor applied for it. On resume, each side sends the files that differ from their last agreed version, and the conflict rule below applies to them.
- [ ] When a copy is stopped, archived, or dropped because the central host changed (X60), copied files on that side that differ from their last agreed version are saved to its leftovers folder with X60's other files, before the copy is removed.
- [ ] Copied files go over the link in their own messages (`files.update`). They are never written into a git object store, on any member, and never shown in the session's changes.
- [ ] A file is written with mode 0600 into place through a temporary file in the same folder, so a reader never sees half of it. Its folder is created, mode 0700, when missing.
- [ ] A deleted file is deleted on the other side too.
- [ ] When both sides changed a file since they last agreed, the owner's version wins: the session's owner for a worktree, and for a checkout, the member whose change has the later stamp. That is X68's hybrid logical clock stamp, taken on that member when it noticed the change, and ordered by time, then counter, then log name. The losing version is saved to `$MOONLET_HOME/sync-leftovers/<project>-<session or "checkout">-<YYYYMMDD-HHMMSS>/` on the member that loses it (X60's folder). The same happens to a deleted file's last content. So no version of a secret is lost.
- [ ] Cloud workers (X63) get no copied files, unless the project's **Also to cloud machines** switch is on. Then a routed command's copy (X62) gets them for the command, and they go with the machine.

## UI

- Settings › Projects › shop: a **Copied between your Macs** section, after Scripts. It shows a list of patterns, each with a remove button, and an input to add one. The note under it reads: "Files git ignores that moonlet copies to your other Macs, such as secrets a worktree needs to run. They never enter git." Below that comes the **Also to cloud machines** switch, off by default.
- The session's sync popover (X60) gets a line "3 copied files" that opens a list of them. Skipped files are listed with their reason: "secrets.json is over 1 MiB and stays on each Mac."
- A toast when a version was saved to leftovers: "fix-cart: .env.local changed on both Macs. studio-mini's version is in ~/.moonlet/sync-leftovers/…", with **Show in Finder**.

## Protocol and RPCs

- `project.copied_files.get {project}` → `{patterns: [string], cloud: bool, default: bool}`.
- `project.copied_files.set {project, patterns, cloud}` → `true`. Only the Mac's own app may call it. Errors: `invalid_params` naming the refused pattern, `forbidden`.
- `files.update {scope, files: [{path, mode, content?, deleted?, base, stamp}]}` between linked members, where `scope` is `{checkout: <identity>}` or `{session: <session id>}`. `base` is the SHA-256 of the version both sides last agreed on, or `null` when the sender knows of no earlier version. The receiver applies a file whose `base` matches what it holds for that path (with `null` matching no file); otherwise both changed it, and the conflict rule above decides. It answers the paths it kept its own version of. Worker connections only, like `sync.*`.
- The account log gains the record kind `project_files`, keyed by project identity, with fields `patterns` and `cloud`. Each field follows X68's rules: the change with the latest stamp wins, also between members that changed it while unlinked. Older members keep it and pass it on unread (X68).

## Data and config

- The list is in the account state (`account.json`), never in `.moonlet/config.toml`, because the repository and an agent may change that file.
- `$MOONLET_HOME/copied-files.json` on each member records, for each scope, the content hash each path last agreed on (the base). It is mode 0600 and holds no contents.

## Security considerations

- Copied files are usually secrets. They go only over a member's paired tailnet link, to members of the same account, and to cloud machines only when the user turned that on for the project. They are never hashed into git, so they never reach a pack, a push or another member's object store.
- An agent on any member can write a file that matches the list, such as a `.env` with `NODE_OPTIONS=--require ./evil.js`, and it reaches every member. This is ADR 0014's "trust is the weakest member's", now with secrets in both directions. Removing a member offers to rotate the secrets it held (ADR 0014); X74 adds the copied files of each project to what that offer names.
- Paths come from the other member: a path with `..`, an absolute path, a name that is not text, or one that does not match this member's own copy of the list is refused. Files are written through the worktree's `cap-std` handle, which never follows a link (as X71 writes copies).
- The list cannot name a folder outside the worktree, and a matching link is never followed.

## Out of scope

- Build output (`node_modules`, `target/`), which each member makes with the setup command (X60).
- Files outside the project's folder, such as `~/.aws/credentials` or a tool's credentials (ADR 0014 and ADR 0015: sign in on each member instead, X75).
- A merge of two versions of one file. The owner's wins and the other is kept in leftovers.
- Encrypting copied files at rest beyond file modes.

## Test plan

Test names are planned. Each criterion cites its test once it is built, with the name exactly as implemented.

- **Core unit** (`moonlet-core`, copied files):
  - `a_pattern_matches_as_one_gitignore_line`: matches against literal worked examples (`.env` at the root and in `apps/web/`, `.env.production`, `/.env` only at the root).
  - `a_negation_an_absolute_path_or_dotdot_is_refused`: `!x`, `/abs/x` and `../x` answer `invalid_params`.
  - `a_tracked_file_is_left_to_git`.
  - `links_git_files_and_files_over_a_mebibyte_are_never_copied`, each with its reason.
  - `matches_are_taken_in_path_order_before_the_limits`: 201 matching files in a fixed tree. The first 200 by path are copied, and the 201st is skipped as over the count.
  - `the_file_that_passes_sixteen_mebibytes_and_every_later_one_are_skipped`: a later smaller file is skipped too.
  - `a_conflict_on_a_checkout_goes_to_the_later_stamp`: two stamps with the same time and different counters.
- **Daemon integration** (`crates/moonletd/tests/copied_files.rs`), with two daemons linked through the `tests/account.rs` helpers:
  - `an_env_in_one_checkout_reaches_the_other_within_three_seconds_mode_0600`.
  - `a_new_worktree_starts_with_its_checkouts_env`.
  - `a_sessions_env_local_reaches_the_central_copy_and_an_edit_comes_back`.
  - `a_change_made_while_unlinked_is_sent_when_the_link_is_back`.
  - `both_sides_changed_the_owners_version_wins_and_the_other_is_in_leftovers`.
  - `a_deleted_file_goes_on_the_other_side_and_its_content_is_in_leftovers`.
  - `a_batch_with_mixed_bases_and_a_deletion_applies_only_the_files_whose_base_matches`.
  - `a_paused_copy_neither_sends_nor_applies_and_catches_up_on_resume`.
  - `stopping_a_copy_saves_its_differing_copied_files_to_leftovers`.
  - `a_reader_never_sees_half_a_copied_file`: a reader polls the path while a 1 MiB file is written and only ever sees the old or the new content, and no temporary file is left behind.
  - `copied_files_never_enter_a_git_object_store`: checked with `git cat-file --batch-all-objects` on both members.
  - `only_the_macs_app_changes_the_list`: `project.copied_files.set` from the CLI, a paired Mac, a phone and an agent's terminal answers `forbidden`.
  - `patterns_changed_on_two_unlinked_members_meet_at_the_later_change`: each member sets `patterns` while unlinked, and after linking both hold the same list, the later change by X68's stamp.
  - `a_cloud_machine_gets_copied_files_only_when_the_switch_is_on`: a routed command's copy (X62) lacks `.env` with the switch off and has it with the switch on.
- **Desktop Vitest** (`lib/copiedFiles.test.ts`): `the_default_list_is_env_and_env_star`, `a_refused_pattern_says_why`, `the_popover_counts_copied_files_and_lists_skipped_ones`.
- **Manual:** the journey with the MacBook and `studio-mini` over a real tailnet.

## Implementation notes

Built as the gh stack branches `x74/list`, `x74/worktree`, `x74/sessions` and `x74/checkouts`. The daemon tests are in `crates/moonletd/tests/central_copies.rs` unless another file is named, and the core tests in `crates/moonlet-core/src/copied_files.rs`.

What works as specified:
- **The list.** Each project's list is in the account state, with `.env` and `.env.*` by default. It reaches every member, and only the Mac's own app changes it. (`a_project_without_a_list_copies_env_and_env_star`, `the_list_set_on_one_member_reaches_the_others`, `only_the_macs_app_changes_the_list`; core `a_pattern_matches_as_one_gitignore_line`, `a_negation_an_absolute_path_or_dotdot_is_refused`)
- **What is copied.** Only files that match the list and that git does not track. Links, files under `.git/` and files over 1 MiB never go. At most 200 files and 16 MiB go, taken in path order. (core `a_tracked_file_is_left_to_git`, `links_git_files_and_files_over_a_mebibyte_are_never_copied`, `matches_are_taken_in_path_order_before_the_limits`, `the_file_that_passes_sixteen_mebibytes_and_every_later_one_are_skipped`)
- **The receiving side checks too.** It takes only paths its own list names and its own git does not track, within its own limits. (core `a_path_this_sides_list_does_not_name_is_refused`, `a_file_git_tracks_on_this_side_is_never_written`, `a_file_over_the_limits_is_never_written_whatever_the_other_side_sent`)
- **Writing.** A file is written mode 0600 through a temporary file in its folder, and a missing folder is made mode 0700. A link at the file is replaced, never followed, and a linked folder on the way is refused. (core `a_copied_file_is_written_0600_in_a_0700_folder_and_never_through_a_link`)
- **New worktrees** start with their checkout's files, before the setup runs. (`a_new_worktree_starts_with_its_checkouts_env`)
- **Sessions.** The owner's files reach the central host's copy. When the central host runs the session, its files reach the MacBook's live copy, and they come with the session when it is brought back. (`a_sessions_env_local_reaches_the_central_copy_and_an_edit_comes_back`)
- **Conflicts and deletions on a copy.** The owner's version wins, a deleted file goes on the other side too, and the other side's version is kept in leftovers. The files never enter a git object store. (`the_owners_version_wins_and_the_copys_and_a_deleted_one_are_in_leftovers`)
- **Checkouts** are kept in step through the central host, both ways and with deletions. A change made while unlinked goes when the link is back, and the later change wins. (`an_env_in_one_checkout_reaches_the_other_within_three_seconds_mode_0600`, `both_checkouts_changed_while_unlinked_the_later_change_wins_and_the_other_is_in_leftovers`; core `a_conflict_on_a_checkout_goes_to_the_later_stamp`, `a_checkouts_new_changed_and_deleted_files_are_noticed`)
- **Checkouts and the list.** A file that stays in a checkout but is no longer copied, grown past 1 MiB or tracked by git, is not deleted on the other members. A pattern taken off the list stops that file being kept in step, leaves it on each member, and the other files still go. A file of exactly 1 MiB goes. (`a_copied_file_grown_past_one_mebibyte_is_not_deleted_on_the_other_checkout`, `a_pattern_taken_off_the_list_leaves_the_other_files_in_step`, `a_copied_file_of_exactly_one_mebibyte_reaches_the_other_checkout`)
- **Cloud machines** get the files only with **Also to cloud machines** on. Turning it off, or taking a pattern off the list, removes the files a cloud machine had, with no copy kept there. (`crates/moonletd/tests/cloud.rs` `a_cloud_machine_gets_copied_files_only_when_the_switch_is_on`, `turning_the_switch_off_takes_the_copied_files_off_the_cloud_machine`, `a_file_taken_off_the_list_leaves_the_cloud_machine`)
- **Settings › Projects** shows the list, a remove button for each pattern, the input to add one, and the switch. (`apps/desktop/src/lib/copiedFiles.test.ts`)

Where it differs from the draft above:
- **RPCs.** `project.copied_files.get` and `.set` take the project's `id` on this Mac, as other `project.*` methods do. In place of one `files.update`, three messages between members:
  - `session.files`: the owner sends the central host's copy every file's hash, with the bytes of those that changed. The copy answers the paths whose bytes it still needs.
  - `session.files_fetch`: a live copy (X60), or a cloud machine's routed copy, sends what it has and gets what differs.
  - `files.checkout`: the checkout exchange.
- **A session's copy never wins.** The session's owner is the only writer. An edit made in a copy is put back, and the copy's version kept in leftovers, as X72 does with its other files. Edits made where the session runs come back with the session.
- **Stamps.** A changed file is stamped with its change time on its member, and a deletion with when it was noticed, with the member's id breaking ties. Stamps are not X68's hybrid logical clock. A stamp more than a day ahead of the central host's clock is taken as a day ahead.
- **A leading `/`** anchors a pattern at the worktree's root, as in `.gitignore`. Patterns that start with `~` or `//` are refused as absolute.
- **A project without a root commit** keeps the default list and cannot be given another.
- **Files.** `$MOONLET_HOME/copied-files.json` holds each checkout's hashes and stamps. A session's are kept in `session-copies.json`.
- **Paused copies.** A paused live copy neither fetches nor applies. On resume it fetches the owner's versions, which win.
- **Timing.** Members look every second. A change reaches the other side within about 2 s.
- **Not built yet:**
  - the sync popover's "3 copied files" line and its list of skipped files;
  - the leftovers toast with **Show in Finder**;
  - naming copied files in the offer to rotate secrets when a member is removed (ADR 0014).

## Open questions

- Should a project's copied files also go to members that have no session of it, only a clone? This spec keeps every member's checkout in step, so a session started there later has them.
