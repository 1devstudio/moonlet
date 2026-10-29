# X72 — Every session has a copy on the central host, and the phone reaches every session through it

- **Status:** draft
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

### Session records in the account state

- [ ] Every session of a member that has a central host has an account record of kind `session`, keyed by the session's id. Its fields are `name`, `project` (the project's identity), `workspace`, `section`, `branch`, `owner` (the owner's worker id), `created_at`, `archived`, and `state`: `idle`, `working` or `needs_you`, as the sidebar's dot shows.
- [ ] A session made on a member before X72 gets its record on that member's first start with X72.
- [ ] Archiving a session sets `archived`, and its copies go as X60's copies go when their session is archived.
- [ ] A session's id is the same on every member: a copy keeps its session's id.

### The copy on the central host

- [ ] The central host keeps a copy of every session another member owns, as soon as its record arrives, and while it is not archived. It is made and kept in sync as an X60 copy is, with two changes:
  - the session's owner decides each reconciliation, as the central host does in X60;
  - the copy never offers changes of its own: it is read only until X73 makes its member the owner.
- [ ] The copy sits at the session's own path when X60's same-path rule allows, otherwise under `~/.moonlet/copies/<owner's name>/<project>/<session>`. Its project's identity is mapped to the central host's clone, or cloned, as in X60.
- [ ] The copy's project setup is not run until the copy is first needed to run something (X73). Copies of sessions the user never continues cost no install.
- [ ] A copy edited on disk by hand is replaced by the owner's next update, and the hand-made changes go to `sync-leftovers` (X60).

### The chat and the transcript

- [ ] The owner sends its chat (X6's saved chat: its items, the agent's session id, queued messages, pending asks) to the central host whenever it changes, at most once a second. The central host keeps it as a read-only chat on the copy.
- [ ] The owner sends the new lines of Claude Code's transcript for the session: the file named after the agent's session id under the profile's `projects/` folder. The central host keeps it under its own profile's folder for the copy's path, so Claude Code there can resume it (X73).
- [ ] A **checkpoint** is sent after each tool result in the chat, and at the end of each turn. It holds the worktree's snapshot tree (X60) taken after that tool result, and the transcript's length up to that tool result. The central host keeps the last checkpoint whose tree and transcript lines it holds in full.
- [ ] A checkpoint never names transcript lines the central host lacks, or a tree it lacks: the owner sends both before the checkpoint.
- [ ] A PTY agent tab (a terminal running `claude`) has no session id moonlet knows. Its transcript is found as the newest one for the worktree's path in the profile's `projects/` folder.
- [ ] Plain terminals are not copied. The copy lists them with their titles, "on MacBook".

### The phone

- [ ] `session.list` on the central host lists its own sessions and the copies, each with `owner: {worker, name}` and `reachable: bool`.
- [ ] A request from a phone for a copy's session (by session or terminal id) is forwarded to the owner over the link while the owner is reachable. The reply comes back unchanged. The forwarded set is the phone's session methods: `chat.*`, `terminal.attach`, `terminal.detach`, `terminal.list`, `git.*`, `gh.*`, `pr.*`, `job.*` and `session.archive`.
- [ ] Events for a forwarded chat or terminal (`chat.item`, `chat.state`, terminal output) come back from the owner to the phone while the phone is attached.
- [ ] While the owner is unreachable, reading methods (`chat.state`, `chat.summaries`, `git.status`, `git.diff`, `git.log`, `gh.prs`, `pr.status`) answer from the copy. Every other method answers `owner_offline` naming the owner. The phone shows "MacBook is asleep · read only".
- [ ] A forwarded request never reaches a method the phone may not call on the owner directly (`forward_from_phone`'s list, X39).

## UI

- The phone's sessions list: a session another member owns ends with "on MacBook" in the muted style of the desktop sidebar (X68). While that member is unreachable, the text reads "MacBook is asleep", and the session opens read only, with a line above the composer: "MacBook is asleep. This is the copy on studio-mini, read only."
- The desktop app shows no copies: it already lists every member's own sessions (X68). The central host's copy appears only in Settings › Machines › studio-mini, as "Copies: 12 sessions, 1.2 GB".

## Protocol and RPCs

- The account log gains the record kind `session`. Older members keep it and pass it on unread (X68).
- `session.offer {session, tree, base?}` with a pack, and `session.chat {session, saved}`, `session.transcript {session, from, lines}` and `session.checkpoint {session, tree, transcript_len, seq}`: owner → central host, worker connections only.
- `session.forward {session, method, params}`: central host → owner, for a phone's request. Events come back as `session.event {session, event}`.
- `session.list` gains `owner` and `reachable`. The new error code `owner_offline` carries `{owner}`.

## Data and config

- `~/.moonlet/sync/copies.json` (X60) records copies of both directions, with `kind: central` for these.
- The read-only chat of a copy is `~/.moonlet/chats/<terminal id>.json`, marked `copy: true`.
- The transcript copy is under the central host's profile folder, `<CLAUDE_CONFIG_DIR>/projects/<the folder Claude Code uses for the copy's path>/<agent session id>.jsonl`.

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
