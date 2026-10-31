# X73 — Sessions follow you: the central host continues them when the MacBook sleeps, and typing brings them back

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0015](../adr/0015-sessions-follow-the-user.md) (sessions follow the user), [0014](../adr/0014-one-account-across-hosts.md) (one account across hosts, delivery slice 4), [0009](../adr/0009-central-host-workers-live-copies.md) (the ownership number)
- **Depends on:** [X72](X72-session-copies-on-the-central-host.md) (copies on the central host, checkpoints, the phone through the central host), [X60](X60-keep-in-sync.md) (live copies, leftovers), [X6](X6-structured-agent-view.md) (the structured chat)

## Summary

The user works on the MacBook, closes its lid and leaves with the phone. Today the session stops until the MacBook wakes.

With this spec, a session's agent runs where the user works, and moves on its own:
- **When the owner goes to sleep,** its daemon stops its agents, sends a last checkpoint and hands its sessions to the central host. The central host continues each from there. A turn that was cut off continues, with a note to the agent.
- **When the user types into a session in the app on another member,** that member takes the session over once the current turn ends, and the message runs there.
- **The phone never moves a session.** Its messages reach the owner through the central host (X72). Only when the owner has been unreachable for 30 s with no sleep notice does a phone message make the central host take the session over.

**Move to…** overrides all of this: it pins the session to one member until the user unpins it, and **Move now** cuts a running turn off to move at once.

Every move raises the session's **ownership number**. Only the member holding the highest number runs the agent (ADR 0009).

## The sleep notice

The design takes nothing from a spike; it relies only on what macOS documents:
- a process in the user's session that registers with `IORegisterForSystemPower` gets `kIOMessageSystemWillSleep` before every system sleep;
- macOS waits for its answer (`IOAllowPowerChange`) for up to 30 s before sleeping anyway.

What is not known is whether the network still carries data in that window when the lid closes. So the design works either way:
- **Stopping the agents needs no network.** The owner stops them first, so a session never runs a step after the notice, whatever happens next.
- **Checkpoints are sent continuously** (X72, after every tool call). At sleep only the last few changes are left to send, and a failed send loses only those.
- **When the hand-over cannot be sent,** the sessions stay with the sleeping owner, and the central host's copy shows the cut-off turn. The phone offers **Continue on studio-mini** (below), and a message from the phone continues it too.
- **A hand-over that could not be sent is sent at the next wake,** dark wakes (Power Nap) included, so a MacBook in a bag usually hands its sessions over within minutes even when the lid closed with no network.

Manual check M12 (`docs/manual-checks.md`) measures, on a real MacBook, how long the hold lasts and whether the network works during it. Its results can shorten the hold below; they do not change the design.

## User journey

1. On the MacBook, the session `fix-cart` runs a long turn: the agent is running the tests. The user closes the lid and leaves.
2. Within seconds, the phone shows `fix-cart` "on studio-mini". Its chat reads "Continued on studio-mini after the MacBook went to sleep." The agent on `studio-mini` checks whether the test run finished, runs the tests again, and goes on.
3. On the bus, the user answers the agent's question from the phone. `studio-mini` runs the session, so nothing moves.
4. At home, the user opens the MacBook. `fix-cart` shows "on studio-mini" in the sidebar, and its chat has everything that happened, live. The MacBook's worktree has the agent's latest edits.
5. The user types a message in `fix-cart` on the MacBook. The agent on `studio-mini` is in the middle of a turn, so the composer shows "Moves here when studio-mini's turn ends · Move now". The turn ends, and the session moves to the MacBook. The agent there reads the user's message and answers.
6. The user starts a long refactor in the session `big-refactor` and wants it to run on `studio-mini` whatever happens. They pick **Move to… › studio-mini** in its menu. `big-refactor` now shows "Kept on studio-mini". Typing in it on the MacBook sends the message to `studio-mini`, and nothing moves.

## Behaviour and acceptance criteria

### The ownership number

- [ ] A session's record (X72) gains `epoch`, a number that starts at 1, and `pinned`, a member's worker id or null.
- [ ] Only the central host changes `owner` and `epoch`. It does so in one step, and only for a request that names the current `epoch`. Of two members asking to take one session at once, one gets it and the other gets `stale`. The one exception is **Take over anyway**, below, while the central host is offline.
- [ ] Only the member named as `owner` with the current `epoch` runs the session's agent. A member that sees a record giving its session to another member stops its agent at once, before anything else.
- [ ] The member that gives a session up keeps its worktree as a copy, kept in sync as X72's copy on the central host is. The new owner decides each reconciliation from then on. The central host keeps its copy whoever owns the session.
- [ ] Every member that keeps a copy of a session gets its chat, transcript and checkpoints as the central host does (X72). This covers a copy it gave up and a copy kept in sync (X60). So that member can continue the session without the central host.
- [ ] Cloud machines never own a session.

### When the owner goes to sleep

- [ ] On the sleep notice, the owner's daemon:
  1. stops (`SIGSTOP`) the process group of every agent it runs, structured chats and PTY agent tabs alike;
  2. sends each session's last checkpoint (X72): the worktree as it is now, and the transcript up to its last complete tool result;
  3. asks the central host to take its unpinned sessions (`session.yield`);
  4. lets the Mac sleep once the central host answers, or after 25 s, inside macOS's 30 s limit.
- [ ] A hand-over the central host did not answer is kept in `moves.json` and sent again at the next wake, dark wakes included. Until the central host answers it, the stopped agents stay stopped.
- [ ] The central host takes every session handed to it: it raises `epoch` and makes itself the owner.
- [ ] A session pinned to the member going to sleep is not handed over. It waits, and the phone shows "Kept on MacBook · asleep".
- [ ] A session with no turn running moves and stays idle on the central host.
- [ ] A session whose turn was cut off continues on the central host with this message to the agent: "This session moved from MacBook to studio-mini because MacBook went to sleep, and your last turn was cut off. The last tool call may not have finished: check its effects before running it again." When the worktree's path differs, the message adds: "The worktree is now at <new path>. Earlier messages name <old path>."
- [ ] A session with an ask open (a permission, a plan or a question, X6) moves with the ask open. The ask shows on the phone, and the answer goes to the central host.

### Continuing on a member

- [ ] The member taking a session over:
  1. brings its copy's files to the latest it holds;
  2. runs the project's setup there, when it has not run yet and its command is approved for this member (X60);
  3. puts the transcript up to the last checkpoint in its profile's `projects/` folder for the copy's path (X72);
  4. starts the agent with `claude --resume <agent session id>` for a structured chat, or `claude --continue` in a new terminal tab for a PTY agent tab;
  5. sends the waiting message, if any: the cut-off note, or the message the user typed.
- [ ] Setup that is not approved does not stop the move. The chat then says "Setup has not run on studio-mini: approve `pnpm install` to run it", with **Run setup**.
- [ ] Plain terminals and their processes do not move. The new owner's session starts with its agent only. The old owner's terminals are listed as "on MacBook" until it wakes, and close when the session moves away from it.

### Typing on another member

- [ ] A message typed in the app on a member that does not own the session, and with no pin, brings the session to that member:
  - **The owner is idle:** the move happens at once, and the message runs on the new owner.
  - **The owner is in a turn:** the message waits on this member, and the composer shows "Moves here when studio-mini's turn ends", with **Move now**. The move happens at the end of the turn, then the message runs.
  - **A message reaches the owner while the session moves:** the owner keeps the session and its message, and the move waits for that turn to end, as above (`a_message_typed_while_the_session_moves_keeps_it_on_the_central_host`).
- [ ] A member that has no copy of the session makes one first (X60's copy), showing "Bringing fix-cart to this Mac…".
- [ ] The copy that becomes the session's worktree is held while the central host gives the session up, so stopping it then waits. When this member then cannot take the session in, the copy stays kept, in the same folder, rather than a folder no one keeps (`a_bring_that_cannot_take_the_session_in_keeps_its_copy`).
- [ ] When this member cannot take the session in after the central host gave it up, it hands the session back (`session.give_back`): the central host owns it again, its worktree is back on the session's own branch, and its chats go on there as they were, not paused (`a_bring_whose_mac_fails_after_the_hand_over_leaves_the_session_running_on_the_central_host`).
- [ ] Typing on the phone never moves a session. Neither does opening or reading a session on any member.
- [ ] A message typed on a member for a session pinned elsewhere goes to the owner, as from the phone.

### When the owner is unreachable

- [ ] An owner whose link to the central host has missed its pings for 30 s (X41's 3 misses) without a sleep notice keeps its sessions while nobody acts on them elsewhere.
- [ ] A message, an answer to an ask, or **Move now** for such a session, from the phone or another member, makes the central host take it over first. The phone shows "MacBook is not reachable. Continuing on studio-mini."
- [ ] For a session whose owner is unreachable and whose copy shows a turn that was running, the phone shows "MacBook is not reachable · fix-cart was working" with **Continue on studio-mini**. Pressing it takes the session over as a message would, and continues the turn with the cut-off note.
- [ ] A pinned session is never taken over this way. The phone shows "Kept on MacBook · not reachable".

### When the central host is offline: Take over anyway

- [ ] When the app's member has not reached the central host for 30 s, the app says so:
  - a line at the bottom of the sidebar: "studio-mini is offline since 14:02";
  - in each session the central host owns, a line above the composer: "studio-mini is offline since 14:02. fix-cart runs there, so it can't move here until studio-mini is back."
  - Before the 30 s are up, the line reads "studio-mini is not responding…" and offers nothing.
- [ ] After 30 s, the line offers **Take over anyway** for a session this member holds a copy of. A session this member has no copy of says "This Mac has no copy of fix-cart" instead.
- [ ] **Take over anyway** asks first: "Take over fix-cart without studio-mini? If studio-mini is still running it, cut off from the network, both Macs run its agent until they meet again. Then studio-mini's work from the gap is saved to a folder, and this Mac's is kept." It offers **Take over** and **Cancel**.
- [ ] Taking over raises `epoch` on this member alone, makes it the owner, marks the change `forced`, and continues the session as any move does (Continuing on a member). The chat says "Taken over while studio-mini was offline. Work studio-mini did after 14:02 is not here yet." A turn that was running on the central host continues with the cut-off note, naming the central host as offline.
- [ ] A takeover that cannot take the session in on this member keeps its copy, in the same folder, and sends no forced change: the central host still runs the session when it is back (`a_takeover_that_cannot_take_the_session_in_keeps_its_copy_and_is_never_sent`).
- [ ] When the central host is back, the member sends the forced change:
  - **The central host's record still has the `epoch` the member started from:** the change is kept, and the central host stops its agent if it went on running. Its files from the gap go to `sync-leftovers`, and its conversation from the gap is kept as a fork, as for any member that lost a session.
  - **The record moved on meanwhile** (the central host gave the session to a third member): the forced change loses. This member stops its agent and keeps its own work from the gap the same way.
- [ ] A pinned session can be taken over anyway too. Doing so pins it to this member.
- [ ] The phone, connected only to the central host, never offers it. While the central host is offline, the phone shows that, as today.

### Waking up, and finding out the session moved

- [ ] On wake, before its stopped agents go on, the owner asks the central host for each session's `epoch`, waiting for up to 5 s:
  - **The session was handed over** (the yield was answered, or the record says another owner): the stopped agent is ended, and the worktree becomes a copy.
  - **The session is still this member's:** the agent goes on (`SIGCONT`).
  - **The central host cannot be reached:** the agent goes on, as ADR 0014 accepts for offline work.
- [ ] A member that learns it lost a session it went on running does the following:
  1. it stops the agent;
  2. its files changed since the session moved go to `$MOONLET_HOME/sync-leftovers/` (X60), and the files it deleted are listed there in `moonlet-deleted.txt` (`a_member_that_lost_its_session_lists_the_files_it_deleted_meanwhile`);
  3. its transcript after the last checkpoint is kept as `<agent session id>.fork-<YYYYMMDD-HHMMSS>.jsonl` beside the transcript;
  4. the chat says "MacBook ran this session while it could not reach studio-mini. Its work is saved in <folder>."
- [ ] The same checks run when a daemon starts.

### Move to…

- [ ] **Move to…** in a session's menu lists the account's members, with the current owner checked. Choosing one pins the session there (`pinned`) and moves it at the end of the current turn, or at once when idle.
- [ ] **Move now** moves it at once: a running turn is cut off and continues on the chosen member with the cut-off note.
- [ ] A pinned session never moves on its own: not on sleep, not on typing, and not when unreachable. **Unpin** in its menu, or **Move to…** another member, changes that.
- [ ] Choosing a member that is not reachable is refused: "studio-mini is not reachable."

### Where a session runs, in the app

- [ ] A session whose agent runs on another member than the app's own Mac shows a small host icon at the end of its sidebar row. The tooltip names the member: "Running on studio-mini". The icon replaces X68's "on studio-mini" text on session rows. Project headers keep their text.
- [ ] A session that runs on the app's own Mac shows nothing.
- [ ] The icon follows the session as it moves. It appears when the session moves away from this Mac and goes when it comes back, with no other change to the row.
- [ ] A pinned session's icon carries a pin, and its tooltip reads "Kept on studio-mini". A session pinned to this Mac shows only a pin.
- [ ] While the owner is unreachable, the icon is drawn dimmed, and its tooltip adds "· offline since 14:02".
- [ ] The session's header shows the same icon with the member's name beside it, so the place is clear while reading the chat.

### Readiness

- [ ] For each session another member owns, the central host checks that it could continue it. It looks at three things:
  - the copy is in sync, not paused;
  - the project's setup has run or is approved here;
  - Claude Code starts with the workspace's profile.
- [ ] A session that could not continue shows a mark in the sidebar, with the reason in its tooltip: "studio-mini could not continue fix-cart: setup is not approved there." The mark comes with **Fix**, which opens the step that fixes it.
- [ ] X74 adds its copied files to these checks, and X75 adds its sign-ins.

## UI

- The sidebar row: nothing for a session running on this Mac. A session running elsewhere gets lucide's `Server` icon, 12 px, in the muted text colour, at the row's end, before the attention dot. A pinned session's icon has lucide's `Pin` as a small badge. An unreachable owner's icon is at half opacity.

  ```
  ● fix-cart                  [server]
  ● big-refactor              [server+pin]
  ● docs-pass                            (on this Mac: nothing)
  ```
- The session header: the same icon and "studio-mini" in the muted style, after the session's name.
- The sidebar's bottom line while the central host is offline: "studio-mini is offline since 14:02", in the muted style, with a dimmed `Server` icon.
- The line above the composer while the central host is offline: "studio-mini is offline since 14:02. fix-cart runs there, so it can't move here until studio-mini is back.", with **Take over anyway** after 30 s.
- The chat: one muted line where a session moved: "Continued on studio-mini after MacBook went to sleep.", "Moved to MacBook because you typed here.", "Moved to studio-mini (Move now)."
- The composer, while a typed message waits: "Moves here when studio-mini's turn ends", with **Move now** and **Send to studio-mini instead**.
- The session menu: **Move to…** › members, **Move now** (while a turn runs), **Unpin**.
- The phone, for an unreachable owner's session whose turn was running: a line above the composer, "MacBook is not reachable · fix-cart was working", with **Continue on studio-mini**.
- The readiness mark: a small hollow triangle after the session's name, in the muted colour.

## Protocol and RPCs

- `session.yield {sessions: [{id, epoch}], reason: "sleep"}`: owner → central host. Answers the sessions taken.
- `session.take {session, epoch, reason}`, where `reason` is `typed`, `unreachable` or `move`: member → central host. Answers `{epoch}`, or `stale` or `pinned`.
- `session.release {session, to, now}`: central host → owner. "Stop at the end of this turn (or now), send the last checkpoint and answer."
- `session.bring {session, message?}`: app → its own daemon, when the user types into a session this member does not own.
- `session.give_back {session, epoch}`: member → central host, when the member could not take in the session the central host just gave it at `epoch`. Accepted only from that member, at that epoch, before it opened the session; the central host takes it back with the chats it gave.
- `session.move {session, to, now}` and `session.unpin {session}`: app → its own daemon. Only the Mac's own app may call them.
- `session.take_anyway {session}`: app → its own daemon, only while the central host has been unreachable for 30 s. The forced change goes to the central host as `session.take {session, epoch, reason: "forced", base}` once it is back. Answers `{kept: bool}`.
- `link.status` gains `unreachable_since`, so the app can say since when the central host is offline.
- `session.continue_here {session}`: phone → central host. Allowed only while the owner has been unreachable for 30 s. Answers `{epoch}`, or `reachable` or `pinned`.
- The owner that `session.list {copies: true}` gives for another member's session gains `unreachable_since` (ms since the epoch) while its link is down, so the phone knows when the 30 s are up.
- `session.ready` → `[{session, ready, reason?}]`: on the central host.
- Event `session.moved {session, from, to, epoch, reason}`.
- The session record gains `epoch` and `pinned`.

## Data and config

- The session records are in `account.json` (X68).
- `$MOONLET_HOME/moves.json` on each member: sessions it handed over before a sleep and has not yet heard answered.
- Forked transcripts sit beside the transcript in the profile's `projects/` folder.

## Security considerations

- Only the central host changes `owner` and `epoch`, and only for a member's worker link. A phone, the CLI and an agent cannot move a session: `session.move`, `.unpin` and `.bring` are app-only, and a phone's messages move a session only in the unreachable case, through the central host.
- The cut-off note is moonlet's own text, with only the hosts' names and paths filled in. Names come from the account's `member` records, and control characters are stripped (X68).
- A stopped agent stays stopped until its member knows it still owns the session, so after a handover a waking Mac never runs a step of the old turn.
- ADR 0014's split-brain note stands: while the network is split, an owner the central host cannot reach and a member that took the session over can both run its agent. This spec narrows it to two cases: the user acted from elsewhere, or pressed **Take over anyway** after a warning that names the risk. In both, the losing side's work is kept.

## Out of scope

- Moving plain terminals and their processes (dev servers, watchers).
- Moving after idle time with the lid open (ADR 0015: rejected).
- Continuing a cut-off turn with no sleep notice and nobody acting (ADR 0015's open question).
- Copied files (X74) and sign-ins (X75).

## Test plan

- Core unit:
  - the cut-off note's text for a fixed pair of hosts and paths;
  - the decision on wake for each case (answered yield, newer epoch, same epoch, central unreachable), against a table of literal outcomes;
  - the decision on typing for each owner state (idle, working, pinned, unreachable).
- Daemon integration (`crates/moonletd/tests/follow.rs`), two daemons linked through the `tests/account.rs` helpers, with a fake agent and a test-only sleep notice (`MOONLET_TEST_SLEEP`):
  - a sleep notice hands an idle session to the central host, and `session.list` there shows it owned;
  - a sleep notice in the middle of a turn: the central host's agent gets the cut-off note;
  - a pinned session stays and is not taken;
  - `session.bring` while the owner works waits for the turn's end, then the message runs on the new owner;
  - two members taking one session: one gets `stale`;
  - an owner that ran on while split: its files land in leftovers, its transcript is kept as a fork, and its agent stops;
  - a phone message to an unreachable owner's session makes the central host take it;
  - **Take over anyway** with the central host stopped: the member runs the session; when the central host starts again with the same epoch, the forced change is kept and the central host's gap work lands in leftovers; when the record moved on meanwhile, the forced change loses.
- Desktop Vitest (`lib/follow.test.ts`):
  - the composer's waiting line and the session menu;
  - the row's icon: none for a session on this Mac, the host icon for one elsewhere, the pin badge, dimmed for an unreachable owner;
  - the offline lines, and when **Take over anyway** is offered (30 s, a copy held).
- Screenshot with `e2e/snap.ts`: a sidebar with a local session, one on `studio-mini` and one pinned.
- e2e (`session-moves.e2e.ts`), with a second daemon linked as the central host: typing into a session the other daemon owns moves it to the app's daemon.
- Manual: the journey on the MacBook, `studio-mini` and the phone, with the lid closed for real, on battery and on power.

## Open questions

- Does the network carry data during the hold when the lid closes, on battery and on power? Manual check M12 measures it. If it never does, the hold can be cut to a few seconds, and hand-overs then rely on the next dark wake.
- Should the composer offer **Send to studio-mini instead**, which keeps the session where it is for that one message? It is in the UI above; drop it if it confuses.
