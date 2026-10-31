# X72 — Every session has a copy on the central host, and the phone reaches every session through it

- **Status:** implemented (untried between two real Macs and a phone)
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0015](../adr/0015-sessions-follow-the-user.md) (sessions follow the user), [0014](../adr/0014-one-account-across-hosts.md) (one account across hosts, delivery slice 3), [0009](../adr/0009-central-host-workers-live-copies.md) (live copies)
- **Depends on:** [X68](X68-account-state.md) (the account log and its sync), [X60](X60-keep-in-sync.md) (snapshots, offers and leftovers), [X6](X6-structured-agent-view.md) (the structured chat), [X39](X39-phone-pairing-and-link.md) and [X40](X40-mobile-app.md) (the phone)

## Summary

A session started on the MacBook lives only on the MacBook today. The phone, paired with the Mac mini, does not see it. When the MacBook sleeps, nothing anywhere has the session's files or conversation.

With this spec, every session of a member has a **copy on the central host**. The copy holds:
- the worktree, kept up to date as X60 keeps a copy;
- the chat as the app shows it;
- Claude Code's own transcript.

After every tool call, the owner sends a **checkpoint**: the worktree's tree and the transcript up to that call, which agree with each other. X73 continues a session from its last checkpoint.

The phone, connected to the central host, lists every session of the account. Its requests for a session another member owns are forwarded to that member over the link. While the owner is unreachable, the phone reads the copy.

This spec does not move sessions. Ownership, its number and moves are X73.

## User journey

1. The MacBook and the phone are both paired with `studio-mini`, the central host. On the MacBook the user starts the session `fix-cart` in `shop` and chats with its agent.
2. On the phone, the sessions list shows `fix-cart` under "1devstudio", marked "on MacBook". Opening it shows the chat so far, live.
3. From the phone the user answers the agent's plan with **Approve**. The MacBook's agent goes on. The MacBook's app shows the approval as if it had been given there.
4. The user closes the MacBook. On the phone, `fix-cart` now says "MacBook is asleep · read only" (until X73, which continues it). Its chat, changes and PR are still there, from `studio-mini`'s copy.
5. In Finder on `studio-mini`, `~/.moonlet/worktrees/shop/fix-cart` holds the same files as the MacBook's worktree had at its last tool call.

## Behaviour and acceptance criteria

Tests named here are in `crates/moonletd/tests/central_copies.rs` unless another file is given.

### Session records in the account state

- [x] Every session of a member has an account record of kind `session`, keyed by the session's id, with `name`, `project` (the project's identity, or `null` for a project without one), `workspace`, `branch`, `owner` (the owner's worker id), `created_at` and `archived`. The records come from the same state diff as workspaces (X68). A session's state (idle, working, needs you) is not in the record, since every turn would add to a log that is never shortened; the central host reads it from the copied chat. Decided by the user on 2026-10-29. (`a_session_made_on_a_member_is_listed_on_the_central_host_with_its_owner`)
- [x] A session made before X72, or while the log was away, gets its record when the log loads. (`sessions_made_before_the_member_shared_its_account_reach_the_central_host`; `moonlet-core` `sessions_from_before_x72_get_records_the_other_members_read`)
- [x] Archiving a session sets `archived`: it leaves the central host's list, and its copy is removed, with edits made in the copy kept in `sync-leftovers`. (`an_archived_session_leaves_the_central_hosts_list`, `an_archived_sessions_copy_is_removed`)
- [x] A copy keeps its session's id.

### The copy on the central host

- [x] A member sends each of its live sessions to its central host whenever the worktree changes (file events, and a look every 5 s for commits): an X60 snapshot tree, the commit and the branch, with only the git objects the central host lacks (`session.open` says what it has, `session.offer` carries the pack). (`an_edit_on_the_member_reaches_the_central_hosts_copy`, `a_commit_on_the_member_moves_the_copys_branch_to_it`)
- [x] The copy goes in the central host's project of the same identity, or in a clone from the origin in X60's `clones/` folder. The clone URL comes from the member, so it is cloned only when it names the origin of the identity in the session's record. (`a_central_host_without_the_project_clones_it_from_its_origin`; unit `a_clone_url_is_taken_only_for_the_projects_own_origin`)
- [x] The copy sits at the session's own path when X60's rule allows, otherwise under `~/.moonlet/copies/<owner's name>/<project>/<session>`. (`a_central_host_without_the_project_clones_it_from_its_origin`)
- [x] The copy is on a branch of its own, `moonlet-copy/<session id>`, so a member never moves one of the central host's own branches. A copy switched to another branch by hand goes back to its own without moving that one. (`a_copy_never_moves_a_branch_of_the_central_hosts_own`, `a_copy_switched_by_hand_to_another_branch_goes_back_without_moving_it`)
- [x] The copy is read only: it never offers changes. One edited by hand is put back at the owner's next update, and the edits go to `sync-leftovers`. (`an_edit_made_in_the_copy_is_put_back_and_kept_in_leftovers`)
- [x] The copy's project setup never runs in X72. X73 runs it when the copy is first needed.

### The chat and the transcript

- [x] The owner sends each chat of the session when it changes (`session.chat`). The central host keeps it with the copy, and `session.copy` gives it. (`a_members_chat_reaches_the_central_hosts_copy`)
- [x] The owner sends what was added to its agent's Claude Code transcript, `<id>.jsonl` and the files below `<id>/` (subagents, long tool results), in whole lines. The central host writes them, mode 0600 and never through a link, where its own Claude Code reads them for the copy's folder: `<profile>/projects/<the copy's path with every character but a letter or digit as ->`. (`the_agents_transcript_reaches_the_central_host_where_claude_code_reads_it`; `moonlet-core` `transcript::tests`)
- [x] After a tool call or a turn ends, the owner sends a **checkpoint**: the files and commit just sent, and the transcript up to its last tool result, or all of it once the turn is over. The transcript goes before the files, so a checkpoint never names a transcript ahead of its files. The central host keeps the checkpoint only when it holds both, and the owner sends it again until it is kept. (`a_checkpoint_after_the_turn_names_its_files_and_its_whole_transcript`; `moonlet-core` `a_checkpoint_ends_after_the_last_tool_result_while_a_turn_runs`)
- [ ] A PTY agent tab (a terminal running `claude`) has no conversation id moonlet knows; its transcript is not copied yet.
- [x] An agent's default Claude folder is the one the terminals' environment gives (`CLAUDE_CONFIG_DIR`, else `~/.claude`), not the daemon's own.

### The phone and other clients of the central host

- [x] `session.list {copies: true}` on the central host adds the sessions other members own, each with `owner: {worker, name, reachable}` and the copy's `path`. Without the flag the list is unchanged, so the desktop app, which lists every member itself, never shows one twice. (`a_session_made_on_a_member_is_listed_on_the_central_host_with_its_owner`, `a_session_whose_member_is_gone_is_listed_as_unreachable`)
- [x] `session.forward {session, method, params}` passes a request to the session's owner while it is linked. The owner lets through only what concerns that session, as for a paired device:
  - its own chats, by terminal id: `chat.state`, `.send`, `.send_now`, `.unqueue`, `.interrupt`, `.permission`, `.aside`, `.stop_agent`, `.settings` (never turning on `bypassPermissions`);
  - git and GitHub, aimed at its own worktree whatever path was named: `git.status`, `.diff`, `.file_versions`, `.log`, `.stage`, `.unstage`, `.revert`, `.apply_patch`, `.commit`, `.branches`, `.base_status`, `.pull_base`, `.unpushed`, `.push`, `gh.prs`, `.pr_context`, `.pr_status`, `.pr_stack`;
  - its own archive;
  - `chat.summaries` and `terminal.list`, which keep only the session's own.

  Anything else, `chat.add_dir`, `chat.mcp`, git settings and terminal attach included, is `forbidden`. (`a_message_through_the_central_host_reaches_the_owners_agent`, `git_status_through_the_central_host_comes_from_the_owner`, `a_chat_that_is_not_the_sessions_cannot_be_reached_through_it`; unit `a_request_passed_on_reaches_only_its_sessions_chats_and_worktree`)
- [x] A member passes its sessions' chat events to the central host. The central host gives them to its apps and phones as `session.event {session, event}`, never to an agent's CLI or a worker. (`the_owners_chat_events_reach_the_central_hosts_clients`)
- [x] While the owner is unreachable, `chat.state`, `chat.summaries`, `git.status`, `git.diff`, `git.log`, `gh.prs` and `gh.pr_status` answer from the copy. Anything else answers `owner_offline`, naming the member. (`with_the_owner_away_reads_come_from_the_copy_and_the_rest_waits_for_it`)
- [x] `session.attach {session, terminal}` follows a terminal of the session through the central host, under a relay id of its own (from `0x4000_0000`, starting at a different point each run). Output comes as output frames of that id, and input sent to it is typed into the member's terminal. Only the central host sets a relay up (`session.relay`): a client cannot name one through `session.forward`, and a member refuses a relay id it already holds. `session.detach`, or either side going away, ends the relay. (`a_terminal_of_the_owners_session_is_followed_and_typed_into_through_the_central_host`, `a_terminal_that_is_not_the_sessions_is_not_followed_through_it`, `a_client_cannot_pick_a_relay_through_a_forwarded_request`)
- [x] The phone lists the sessions other members own with "on MacBook", or "MacBook is asleep" while that member is unreachable. It opens one under its copy host, `<central host>#copy:<session>`, so every screen's calls go through `session.forward` and `session.attach` (`apps/desktop/src/lib/copyHost.test.ts`). While the member is away, it shows "MacBook is asleep. This is the copy on studio-mini, read only." (`apps/mobile/src/lib/copies.test.ts`)
- [x] On the phone, a copy offers what its member can be asked through the central host and no more: no new terminal, no jobs, no PR creation, and no archive while its member is away. A session the phone also gets from its member shows once. (`apps/mobile/src/lib/copies.test.ts`)
- [ ] A session another member owns, of a project the central host has no clone of, is not listed on the phone yet: it has no project there to sit under.
- [ ] The phone's session list does not show a copy's state (working, needs you) until the session is opened: the central host does not yet add the copied chat's state to `session.list`.

## UI

- The phone's sessions list: a session another member owns ends with "on MacBook" in the muted style of the desktop sidebar (X68). While that member is unreachable, the text reads "MacBook is asleep", and the session's screen shows "MacBook is asleep. This is the copy on studio-mini, read only." under its tabs.
- The desktop app shows no copies: it already lists every member's own sessions (X68). (Not built: the central host's copies in Settings › Machines.)

## Protocol and RPCs

- The account log gains the record kind `session`. Older members keep it and pass it on unread (X68).
- Member → central host, worker links only, and only for sessions whose record names that member:
  - `session.open {session, path, project, origin_url?}` → `{have}`;
  - `session.offer {session, tree, head, branch, pack?}` → `{tree, head}`, or `not_open`;
  - `session.chat {session, terminal, state}`;
  - `session.transcript {session, agent_session, file, from, pack}` → `{len}`;
  - `session.checkpoint {session, terminal, agent_session, tree, head, len, at}` → whether it was kept;
  - `session.event {session, event}`.
- Central host → member: `session.forward {session, method, params}` and `session.relay {op, session, terminal, relay, cols?, rows?}`.
- Clients of the central host (its app and phones, never a worker, a cloud machine or the CLI): `session.forward`, `session.attach {session, terminal, cols?, rows?}` → `terminal.attach`'s reply under a relay id, `session.detach {relay}`, `session.copy {session}` → `{path, tree, head, chats, checkpoint}`.
- `session.list` takes `{copies}`; a session gains `owner: {worker, name, reachable}`. Only the changes of the member that made a session record count, and its `owner` must be that member. The new error code `owner_offline`. The event `session.event {session, event}`.

## Data and config

- `$MOONLET_HOME/session-copies.json`: on a member, what the central host holds of each of its sessions; on the central host, each copy (its repository, worktree, last offer, last checkpoint and the transcript files written for it).
- `$MOONLET_HOME/session-copies/<session>/chats/<terminal>.json` on the central host: a copy's chats, as last sent.
- The transcript copy is under the central host's profile folder, `<profile>/projects/<the folder Claude Code uses for the copy's path>/<agent session id>.jsonl` and `<agent session id>/`, mode 0600.

## Security considerations

- `session.offer`, `.chat`, `.transcript` and `.checkpoint` take only a member's worker link, and only for sessions whose record names that member as owner. Phones, the CLI and cloud machines are refused, as `sync.*` refuses them (X60).
- The transcript holds everything the agent read, including secrets it printed. It already lives on the owner; it now lives on the central host too, written mode 0600. ADR 0014's "trust is the weakest member's" covers it.
- A transcript line from the owner is written as it came. The central host never interprets it until Claude Code resumes it (X73). Its file name comes from the agent's session id, which must be a UUID, never a path.
- A forwarded phone request is checked twice: by the central host's phone rules, and by the owner's, with the phone's device id passed along so the owner applies `forward_from_phone` to it as well.

## Out of scope

- Moving a session, the ownership number and continuing on the central host (X73).
- Copies on members other than the central host, beyond X60's **Keep in sync**.
- Plain terminals and the processes in them.
- Pairing the phone with the central host from any app (ADR 0014 slice 2).

## Test plan

- Core unit: the folder Claude Code uses for a path, against a captured literal (`/Users/alex/.moonlet/worktrees/shop/fix-cart` → its folder name under `projects/`); a checkpoint is kept only once its tree and lines are both held.
- Daemon integration (`crates/moonletd/tests/central_copies.rs`), two daemons linked through the `tests/account.rs` helpers, with a fake agent that writes a transcript as Claude Code does:
  - a session made on a member gets a record and a copy on the central host;
  - an edit on the owner reaches the copy within 1 s;
  - after a tool result, the central host's checkpoint names that tree and transcript length;
  - a phone's `chat.send` to the central host reaches the owner's chat;
  - with the owner gone, `chat.state` answers from the copy and `chat.send` answers `owner_offline`;
  - a copy edited by hand is put back, and the edit lands in leftovers.
- Phone Vitest: "on MacBook" and the read-only line.
- Manual: the journey with the MacBook, `studio-mini` and the phone over a real tailnet.

## Open questions

- Should the central host's copies of archived sessions be kept for a while, so the phone can still show their chats? This spec removes them with the session.
