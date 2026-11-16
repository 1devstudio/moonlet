# X73 — Sessions follow you: the central host continues them when the MacBook sleeps, and typing brings them back

- **Status:** implemented (untried on real Macs and a phone; see Implementation notes)
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0015](../adr/0015-sessions-follow-the-user.md) (sessions follow the user), [0014](../adr/0014-one-account-across-hosts.md) (one account across hosts, delivery slice 4), [0009](../adr/0009-central-host-workers-live-copies.md) (the ownership number)
- **Depends on:** [X72](X72-session-copies-on-the-central-host.md) (copies on the central host, checkpoints, the phone through the central host), [X60](X60-keep-in-sync.md) (live copies, leftovers), [X6](X6-structured-agent-view.md) (the structured chat)

## Summary

The user works on the MacBook, closes its lid and leaves with the phone. Today the session stops until the MacBook wakes.

With this spec, a session's agent runs where the user works, and moves on its own:
- **When the owner goes to sleep,** its daemon stops its agents, sends a last checkpoint and hands its busy sessions to the central host: those with a turn running, an ask open or a message queued in a structured chat. The central host continues each from there. A turn that was cut off continues, with a note to the agent; an ask stays open there, and a queued message runs there. An idle session stays where it is, so a short idle sleep with the lid open moves nothing.
- **When the user types into a session in the app on another member,** that member takes the session over once the current turn ends, and the message runs there.
- **The phone never moves a session.** Its messages reach the owner through the central host (X72). Only when the owner has been unreachable for 30 s, asleep or not, does a phone message make the central host take the session over.

**Run only on…** overrides all of this: it pins the session to one member until the user unpins it, and **Move now** cuts a running turn off to move at once.

Every move raises the session's **ownership number**. Only the member holding the highest number runs the agent (ADR 0009).

## The sleep notice

The design takes nothing from a spike; it relies only on what macOS documents:
- a process in the user's session that registers with `IORegisterForSystemPower` gets `kIOMessageSystemWillSleep` before every system sleep;
- macOS waits for its answer (`IOAllowPowerChange`) for up to 30 s before sleeping anyway.

What is not known is whether the network still carries data in that window when the lid closes. So the design works either way:
- **Stopping the agents needs no network.** The owner stops them first, so a session never runs a step after the notice, whatever happens next.
- **Checkpoints are sent continuously** (X72, after every tool call). At sleep only the last few changes are left to send, and a failed send loses only those. The busy sessions' go first, each on its own, so dozens of idle sessions or one slow send cannot use up the hold before a busy session is handed over.
- **When the hand-over cannot be sent,** the sessions stay with the sleeping owner until it can be, at the next wake (below), and the central host's copy shows the cut-off turn. The phone offers **Continue on studio-mini** (below), and a message from the phone continues it too.
- **A hand-over that could not be sent is sent at the next wake,** dark wakes (Power Nap) included, so a MacBook in a bag usually hands its busy sessions over within minutes even when the lid closed with no network.

Manual check M12 (`docs/manual-checks.md`) measures, on a real MacBook, how long the hold lasts and whether the network works during it. Its results can shorten the hold below; they do not change the design.

## User journey

1. On the MacBook, the session `fix-cart` runs a long turn: the agent is running the tests. The user closes the lid and leaves.
2. Within seconds, the phone shows `fix-cart` "on studio-mini". Its chat reads "Continued on studio-mini after the MacBook went to sleep." The agent on `studio-mini` checks whether the test run finished, runs the tests again, and goes on.
3. On the bus, the user answers the agent's question from the phone. `studio-mini` runs the session, so nothing moves.
4. At home, the user opens the MacBook. `fix-cart` shows "on studio-mini" in the sidebar, and its chat has everything that happened, live. The MacBook's worktree has the agent's latest edits.
5. The user types a message in `fix-cart` on the MacBook. The agent on `studio-mini` is in the middle of a turn, so the composer shows "Moves here when studio-mini's turn ends · Move now". The turn ends, and the session moves to the MacBook. The agent there reads the user's message and answers.
6. The user starts a long refactor in the session `big-refactor` and wants it to run on `studio-mini` whatever happens. They pick **Where it runs › Run only on studio-mini** in its menu. `big-refactor` now shows "Kept on studio-mini". Typing in it on the MacBook sends the message to `studio-mini`, and nothing moves.

## Behaviour and acceptance criteria

### The ownership number

- [ ] A session's record (X72) gains `epoch`, a number that starts at 1, and `pinned`, a member's worker id or null.
- [ ] Only the central host changes `owner` and `epoch`. It does so in one step, and only for a request that names the current `epoch`. Of two members asking to take one session at once, one gets it and the other gets `stale` (`of_two_takes_at_once_one_gets_the_session_and_the_other_stale`; until 2026-11-16 the second got `internal`, as both renamed the branch). The one exception is **Take over anyway**, below, while the central host is offline.
- [ ] Only the member named as `owner` with the current `epoch` runs the session's agent. A member that sees a record giving its session to another member stops its agent at once, before anything else.
- [ ] The member that gives a session up keeps its worktree as a copy, where it is and a git worktree still, kept in sync as X72's copy on the central host is. Only the files it changed since the last checkpoint go to `sync-leftovers`; the new owner's files then replace them in the worktree (`a_member_that_lost_its_session_keeps_its_gap_and_follows_the_new_owner`). A file changed there after that keeps its version. A worktree on another branch keeps its files: its copy pauses first, as X60's copies do (`a_lost_session_whose_worktree_is_on_another_branch_pauses_its_copy_and_leaves_its_files`). One with commits the new owner lacks keeps them and goes on as X60's copies do (2026-11-14; until then it paused). Ahead of the new owner, its commits and the files changed there since go to the session there, on top of the new owner's uncommitted files; a file both changed differs and keeps each side's version, so nothing in the worktree is overwritten, and the gap is in leftovers too (`a_lost_session_whose_worktree_has_commits_of_its_own_sends_them_to_the_new_owner`). The new owner decides each reconciliation from then on. The central host keeps its copy whoever owns the session.
- [ ] Every member that keeps a copy of a session gets its chat, transcript and checkpoints as the central host does (X72). This covers a copy it gave up and a copy kept in sync (X60). So that member can continue the session without the central host.
- [ ] Cloud machines never own a session.

### When the owner goes to sleep

- [ ] On the sleep notice, the owner's daemon:
  1. stops (`SIGSTOP`) the process group of every structured chat agent it runs (a PTY agent tab is neither stopped nor handed over, so a session at work only in one stays);
  2. sends the last changes of its unpinned sessions that are busy, before anything else: a chat with a turn running (`working` or `blocked`), an ask of the main agent open, or a message queued (`only_a_session_at_work_or_waiting_on_something_goes_to_the_central_host_at_sleep`). A subagent alone, running or asking, does not make a session busy for this (below). Each session's last changes are its chats, its transcript up to its last complete tool result, the worktree as it is now and its checkpoint (X72). Its copied files (X74) go too, but, as before, one that cannot be sent does not hold the hand-over back. Each session is sent on its own, all at once, so one that is slow or fails never holds back another (`a_busy_session_slow_to_send_stays_on_the_mac_and_holds_back_no_other`);
  3. asks the central host to take each of those sessions (`session.yield`) as soon as all its last changes are sent. A session is not handed over when sending its chats, its transcript, its files and commit or its checkpoint fails, or has not ended when the hold does. The central host's copy of it would be short of its last changes. It stays with the sleeping member, noted in `moves.json`, and goes at the next wake as a hand-over that could not be sent (below);
  4. then sends the last changes of its other sessions, idle and pinned ones included, as far as the time left allows (`a_busy_session_is_handed_over_before_an_idle_one_slow_to_send`);
  5. lets the Mac sleep once that is done, or after 25 s, inside macOS's 30 s limit.
- [ ] A hand-over is written down in `moves.json` before it is sent: each session with the `epoch` it had. It is cleared only once the central host answers it. One the central host did not answer is sent again (2026-11-16; until then it was sent once, and lost when the hold ran out or the link dropped):
  - **At the next wake, dark wakes included,** once the wake's check has reached the central host (below). Until the central host answers it, those sessions' stopped agents stay stopped; the rest go on as the wake's check decides. A session the hand-over sent again leaves goes on then (`a_hand_over_that_could_not_be_sent_before_the_sleep_is_sent_at_the_wake`).
  - **Not when the wake's check cannot reach the central host.** There is no answer to wait for then, so the stopped agents go on, as for any session at such a wake (ADR 0014), and the hand-over is withdrawn: never sent again, so a session the user goes on with here never moves when the network comes back, and the next sleep hands over afresh (`a_hand_over_still_unsent_when_the_mac_wakes_without_the_central_host_is_dropped_and_its_agent_goes_on`). Once the central host is heard from, a withdrawn session it took all the same, the hand-over having reached it with its answer lost, comes back as any (below); the rest is forgotten (`moonletd` `power::tests::a_hand_over_not_answered_is_sent_again_while_still_this_members_at_its_epoch_and_one_taken_comes_back`). A hand-over sent again whose answer does not come (the link drops, or 2 minutes pass) is withdrawn the same way, and an empty hand-over then tells the central host to stop taking in what it has not taken yet.
  - **At daemon start,** once linked, settled by the central host's word after the start: a session it took comes back as any (below). One still this Mac's goes again only while something in it waits, an ask open or a message queued (`moonletd` `power::tests::after_a_restart_a_session_is_handed_over_again_only_while_an_ask_or_a_message_still_waits`); one whose turn the stop cut off is idle here now, and stays (`a_hand_over_whose_turn_a_restart_cut_off_stays_on_the_mac`).
  - A session the account gives another member by then was taken while the Mac slept, and comes back as one whose hand-over was answered (Coming back when the Mac is back).
- [ ] The central host takes a session handed to it only at the `epoch` the member names, while the member owns it and has not pinned it: it raises `epoch` and makes itself the owner. It does not take one whose `epoch` moved on since the member handed it over, nor go on with a hand-over once that member linked again or sent a newer one: the member is awake then, and says itself what it still hands over. A hand-over sent again after its answer was lost answers that the central host took what it took (`moonletd` `power::tests::the_central_host_takes_a_handed_over_session_only_at_the_epoch_named_while_its_member_has_not_woken`). A member from before names no `epoch`, and its sessions are taken as before.
- [ ] A session pinned to the member going to sleep is not handed over. It waits, and the phone shows "Kept on MacBook · asleep".
- [ ] A session with nothing running, open or queued stays on the member going to sleep. It is listed as the member's while it sleeps, and a phone message reaches it as for any unreachable owner, after 30 s (`an_idle_session_stays_on_the_mac_through_sleep`, `a_session_whose_member_is_away_goes_on_on_the_central_host_from_its_copy`).
- [ ] A session whose turn was cut off continues on the central host with this message to the agent: "This session moved from MacBook to studio-mini because MacBook went to sleep, and your last turn was cut off. The last tool call may not have finished: check its effects before running it again." When the worktree's path differs, the message adds: "The worktree is now at <new path>. Earlier messages name <old path>."
- [ ] A session with an ask open (a permission, a plan or a question, X6) moves with the ask open. The ask shows on the phone, and the answer goes to the central host. The agent that asked is ended with the Mac's frozen one, and a resumed Claude Code holds no pending tool call, so each kind goes on as it does through a daemon restart (X6) (2026-11-16; until then every ask was dropped as the session moved, and the agent sat idle there):
  - **A plan or a question of the main agent** stays open on the central host, with no agent started for it. Its answer reaches the resumed agent as its first message, with the cut-off note before it in the same message: `I approve your plan. Go ahead with it.` in the mode chosen, `Answers to your questions:` with each answer, the feedback typed for **Keep planning**, or Skip's message (`moonlet-core` `chat::runtime::tests::a_plan_open_as_its_session_moves_waits_here_and_its_approval_goes_on_with_the_note_then_the_queued_message`, `a_question_open_as_its_session_moves_waits_here_and_its_answers_go_on_with_the_note`; `a_plan_open_as_the_mac_sleeps_is_open_on_the_central_host_and_its_approval_goes_on_there`). A message typed instead drops the ask, and Stop ends it, as after a restart; the note goes before the next message either way, and the held messages after it (`a_message_typed_on_a_moved_plan_goes_after_the_note_and_the_held_messages`, `stop_on_a_moved_plan_ends_it_and_the_held_messages_run_next`). A daemon restart there keeps the ask, the note and the held messages (`a_restart_after_a_move_keeps_the_plan_its_note_and_the_held_messages`). **Move now** away from there moves the ask on, still open: it has no turn running to cut off (`move_now_leaves_a_plan_kept_from_a_move_open_to_move_on`). Until it is answered the session counts as busy there, as with any open ask, so it neither comes back by itself nor moves on typing before then; an answer given there counts as an answer, not as typing, as for an ask the agent holds live.
  - **A tool's permission** is not kept: the tool never ran, so the turn goes on with the cut-off note, and the agent asks for it again on the central host, where answering it has the same effect (`a_tool_permission_open_as_its_session_moves_is_asked_again_as_the_turn_goes_on`).
  - **A subagent's ask** goes with its subagent: see below.
- [ ] A message queued in a chat as its session moves (X49) goes to the agent on the central host in order, after the cut-off note, or after the answer to an ask kept open. It stays queued, as the same message, until that agent reads it, and is never marked "Not delivered" for the move (`moonlet-core` `chat::runtime::tests::messages_queued_as_a_session_moves_go_to_the_agent_here_after_the_note_in_order`, `session::tests::a_continued_chat_closes_what_its_member_had_running`; `a_message_queued_as_the_mac_sleeps_goes_to_the_agent_on_the_central_host_after_the_note`). **Send now** sends what is held at once, all of it in order; taking one out of the queue drops it (`send_now_sends_what_a_moved_chat_holds_and_a_held_message_taken_out_never_goes`).
- [ ] A session whose only work is a subagent, running in the background or asking, is not handed over at sleep. Claude Code does not start a subagent again on `--resume`, so on the central host its work would end. It stays frozen with the Mac's agent, and goes on at the wake, as any session the Mac still owns (`moonletd` `power::tests::a_session_whose_only_work_is_a_subagent_stays_on_the_mac_at_sleep`). A session whose main turn runs as well goes, as before, and its subagents stop on the way.

### Continuing on a member

- [ ] The member taking a session over:
  1. brings its copy's files and commit to the ones the session had where it ran, as that member gave it up; a file it changed in the copy meanwhile keeps its version (`a_session_brought_back_has_the_central_hosts_last_files`). No commit is lost on either side (2026-11-14; until then a bring while each side had commits the other lacked answered `diverged`, and the session stayed where it ran):
     - **This Mac's branch is ahead** (the session's commit is in it): the session comes with this Mac's commits, and with the files the session had uncommitted where it ran (`a_bring_with_commits_only_this_mac_has_brings_the_session_with_them`).
     - **Each side has commits the other lacks:** this Mac's commits go on a branch of their own, the session's branch with `-this-mac` (`moonlet/fix-cart-this-mac`; `-2`, `-3` and so on when taken), as X60's **Use studio-mini's branch** does. The session's branch moves to the commit it had where it ran, and the session comes here. The bring and Run only on… name that branch (`kept_on`); a bring that fails after it names it in its error (`a_bring_while_each_side_has_commits_the_other_lacks_keeps_this_macs_on_a_branch_of_their_own`). A session coming back by itself after a sleep does not: it stays where it runs until the user brings it (`a_session_whose_commits_diverged_while_the_mac_slept_stays_there_until_brought`);
  2. runs the project's setup there, when it has not run yet and its command is approved for this member (X60);
  3. puts the transcript up to the last checkpoint in its profile's `projects/` folder for the copy's path (X72);
  4. resumes the agent with `claude --resume <agent session id>` for a structured chat, with the chat's next message (the cut-off note, a message it had queued, the answer to an ask it kept open, or the message typed), so a session that moves idle starts no agent (`a_continued_chat_resumes_its_conversation_in_the_workspaces_profile_with_its_next_message`); or `claude --continue` in a new terminal tab for a PTY agent tab;
  5. sends the waiting messages, in order: the cut-off note, then the messages the chat had queued, then the message the user typed. While an ask it kept open waits, they wait for its answer. When typing or **Move now** brings a session back, the messages it had queued go to the agent here before the one typed (`moonlet-core` `chat::runtime::tests::a_brought_chat_sends_its_queued_messages_before_the_one_typed`).
- [ ] Setup that is not approved does not stop the move. The chat then says "Setup has not run on studio-mini: approve `pnpm install` to run it", with **Run setup**.
- [ ] Plain terminals and their processes do not move. The new owner's session starts with its agent only. The old owner's terminals are listed as "on MacBook" until it wakes, and close when the session moves away from it.

### Typing on another member

- [ ] A message typed in the app on a member that does not own the session, and with no pin, brings the session to that member:
  - **The owner is idle:** the move happens at once, and the message runs on the new owner.
  - **The owner is in a turn:** the message waits on this member, and the composer shows "Moves here when studio-mini's turn ends", with **Move now**. The move happens at the end of the turn, then the message runs.
  - **A message reaches the owner while the session moves:** the owner keeps the session and its message, and the move waits for that turn to end, as above (`a_message_typed_while_the_session_moves_keeps_it_on_the_central_host`).
- [ ] A member that has no copy of the session makes one first (X60's copy), then brings the session. So does a member whose copy has no folder: one paused before it was made, or whose folder is gone. The session goes on where it runs until then (`a_member_without_a_copy_of_the_session_makes_one_and_brings_it`, `a_member_whose_copy_paused_before_it_was_made_makes_it_and_brings_the_session`, `a_member_whose_copy_folder_is_gone_makes_it_again_and_brings_the_session`). Coming back by itself after a sleep does not make one: it waits for the copy (2026-11-14; until then a bring with no copy answered `no_copy`).
- [ ] When the copy cannot be made, the bring answers `copy_failed` with the copy's reason, such as "moonlet/fix-cart is checked out in ~/src/shop on this Mac.", and the session goes on where it runs (`a_bring_whose_copy_cannot_be_made_says_why_and_leaves_the_session_there`).
- [ ] A session that cannot come here does not send the message anywhere by itself (2026-11-14; until then an error showed and the message went to studio-mini). A sticky toast says why and holds the message: "fix-cart can't come to this Mac: moonlet/fix-cart is checked out in ~/src/shop on this Mac." with **Send it there**, which sends the message to studio-mini, where the session runs, and **Try again**, which brings it again with the message (`followStore.test.ts` › "says why a session can't come here, and sends the message there only when asked", "brings it again with the message on Try again", "never sends the message there by itself on Try again, though the session is no longer listed there").
  - More typed into that chat while the toast shows goes with the held message, in order ("keeps a message typed while the toast shows with the first, and sends both there in order").
  - Closing the toast drops the message ("drops the message when the toast is closed, and brings the next one by itself"). A message that could not be sent there is held again ("holds the message again when sending it there fails").
  - A turn running there is not such a case: the message waits with **Move now**, as above. Nor is a session kept there since the app last heard (`pinned`): the message goes there, as for any session kept elsewhere ("sends the message to the owner when the session was pinned there since the app last heard").
  - When this Mac's commits went on a branch of their own (`kept_on`), the app says "fix-cart is here. Its commits from this Mac are on moonlet/fix-cart-this-mac: merge that branch into moonlet/fix-cart to keep them.", after a bring and after Run only on… ("names the branch this Mac's commits went on", "names the branch this Mac's commits went on when Run only on brings it here").
- [ ] The copy that becomes the session's worktree is held while the central host gives the session up, so stopping it then waits. When this member then cannot take the session in, the copy stays kept, in the same folder, rather than a folder no one keeps (`a_bring_that_cannot_take_the_session_in_keeps_its_copy`).
- [ ] When this member cannot take the session in after the central host gave it up, it hands the session back (`session.give_back`): the central host owns it again, its worktree is back on the session's own branch, and its chats go on there as they were, not paused (`a_bring_whose_mac_fails_after_the_hand_over_leaves_the_session_running_on_the_central_host`).
- [ ] A bring cut off half way never leaves a session that no host runs (2026-11-16; until then a lost answer, a timeout, a sleep or a daemon stop between the take and taking it in left the account naming this member while nobody ran it, for good). The member writes the take down in `takes.json` before it sends it. Once the central host is heard from again, within seconds and with nobody doing anything, exactly one host runs the session and the account names it: this member took it in, or it hands it back (`session.give_back`) and the central host goes on with its chats as they were:
  - the take's answer lost, the network down right after it left (`a_bring_whose_answer_is_lost_ends_with_one_host_running_the_session`);
  - this member's daemon stopping between the take and taking it in (`a_bring_cut_off_by_the_macs_daemon_stopping_ends_with_one_host_running_the_session`);
  - the hand-back itself not delivered at first: it is sent again once the link is back (`a_hand_back_not_delivered_at_first_is_sent_again_and_the_central_host_runs_the_session`);
  - a session the account names this member the owner of and that it does not run, with no take noted, as a version from before left it: handed back at the daemon's start and each time the link comes up (`a_session_an_older_version_left_given_to_the_mac_and_not_taken_in_goes_on_on_the_central_host`).
  A take the central host has not given yet is waited on for 2 minutes, past the link's 60 s for an answer, in case it still gives it, and then forgotten. The decision is `moonletd` `takes::settle` (`takes::tests::a_bring_cut_off_half_way_is_handed_back_waited_on_or_dropped`).
- [ ] A take or a hand-back sent twice has the effect of one: the same take again is `stale` and changes nothing, and the same hand-back again answers the session as it runs on the central host (`a_take_or_a_hand_back_sent_twice_has_the_effect_of_one`). One member brings a session one bring at a time.
- [ ] A give cut off by the central host stopping leaves it able to give again: after it moved the worktree to the copy's branch, the next give puts it back on the session's own first (`a_give_cut_off_after_its_branch_moved_leaves_the_central_host_able_to_give_again`); after the account named the member, before it gave the session up, the member's hand-back makes the central host the owner again, the session never having left it (`a_give_cut_off_after_it_named_the_new_owner_ends_with_one_host_running_the_session`).
- [ ] Typing on the phone never moves a session. Neither does opening or reading a session on any member.
- [ ] A message typed on a member for a session pinned elsewhere goes to the owner, as from the phone.

### When the owner is unreachable

- [ ] An owner whose link to the central host has missed its pings for 30 s (X41's 3 misses), asleep or not, keeps the sessions it did not hand over while nobody acts on them elsewhere.
- [ ] A message, an answer to an ask, or **Move now** for such a session, from the phone or another member, makes the central host take it over first. The phone shows "MacBook is not reachable. Continuing on studio-mini."
- [ ] For a session whose owner is unreachable and whose copy shows a turn that was running, the phone shows "MacBook is not reachable · fix-cart was working" with **Continue on studio-mini**. Pressing it takes the session over as a message would, and continues the turn with the cut-off note.
- [ ] Until the owner has been unreachable for 30 s, the phone holds **Continue on studio-mini** back and counts down: "Continue on studio-mini in 12 s". The central host would refuse it before then.
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
- [ ] The central host takes a change as forced only from a member that was cut off from it since the session became the central host's: the central host started since, or that member's link was made since. From a member that stayed linked, it is an ordinary take: a pin or a running turn refuses it (`a_takeover_from_a_member_that_never_lost_the_central_host_is_not_forced`).
- [ ] The phone, connected only to the central host, never offers it. While the central host is offline, the phone shows that, as today.

### Waking up, and finding out the session moved

- [ ] On wake, before its stopped agents go on, the owner asks the central host for each session's `epoch`, waiting for up to 5 s:
  - **The session was handed over** (the yield was answered, or the record says another owner): the stopped agent is ended, and the worktree becomes a copy.
  - **Its hand-over was not answered:** it is sent again, and the agent waits for the answer, as above (`moonletd` `power::tests::a_hand_over_not_answered_is_sent_again_while_still_this_members_at_its_epoch_and_one_taken_comes_back`).
  - **The session is still this member's:** the agent goes on (`SIGCONT`).
  - **The central host cannot be reached:** the agent goes on, as ADR 0014 accepts for offline work.
- [ ] The answer counts only if it came after the wake. The link's state from before the sleep does not count: the central host drops a member after three missed pings, so a Mac that slept longer than about 30 s can still take a closed link for up. The link first proves itself with a round trip: one that gives no answer within 2 s is made again, once. A link that answers has the rest of the 5 s for the account to catch up (`a_session_the_central_host_took_while_the_mac_slept_is_not_resumed_at_wake`, `a_link_that_stays_silent_after_the_wake_is_made_again_before_agents_go_on`).
- [ ] An agent goes on only at the `epoch` its session had as the Mac slept. A session this member owns again at another epoch has its stopped agent ended; its next message resumes the conversation (`moonletd` `power::tests::on_waking_a_chat_goes_on_only_at_the_epoch_its_session_had_as_the_mac_slept`).
- [ ] A member that learns it lost a session it went on running does the following:
  1. it stops the agent;
  2. its files changed since the session moved go to `$MOONLET_HOME/sync-leftovers/` (X60), and the files it deleted are listed there in `moonlet-deleted.txt` (`a_member_that_lost_its_session_lists_the_files_it_deleted_meanwhile`);
  3. its transcript after the last checkpoint is kept as `<agent session id>.fork-<YYYYMMDD-HHMMSS>.jsonl` beside the transcript;
  4. the chat says "MacBook ran this session while it could not reach studio-mini. Its work is saved in <folder>."
- [ ] The same checks run when a daemon starts.

### Coming back when the Mac is back

- [ ] A session the central host took for a member's sleep comes back to that member once the member is awake and linked, as soon as it is idle on the central host and nobody typed into it there since it moved. What its chats held as the central host took it in never counts as typed: the member's last message, a message it had queued (which keeps its id as it goes to the agent there), and moonlet's cut-off note. It comes back to the same worktree, and its chats resume with their next message (`a_member_going_to_sleep_hands_its_running_session_to_the_central_host`, `a_session_comes_back_only_while_idle_and_untouched_since_it_moved`).
- [ ] While its turn runs on the central host, the member asks again every few seconds, for up to about ten minutes. Once someone typed into it there, from the phone or the central host's app, it stays there for good (`a_session_someone_typed_into_on_the_central_host_while_the_mac_slept_stays_there`). Typing on the member still brings it back as before (`typing_on_the_member_brings_the_session_back_from_the_central_host`).
- [ ] The central host decides (`session.take {returning: true}`): it answers `busy` or `used` (`a_session_comes_back_only_while_idle_and_untouched_since_it_moved`), and a session pinned there, as with Run only on…, is never brought back this way (`a_session_pinned_on_the_central_host_while_the_mac_slept_stays_there`).
- [ ] Right after a wake, a record from before the hand-over (its news not in yet) does not count as the session being back: the member remembers the ownership number each session had as it was handed over.
- [ ] A session the central host took for a sleep comes back so too when the member never heard the answer: the hold ran out while the hand-over was in flight, or the daemon stopped before the answer came. The record the central host gives after the wake, or after the start, says it took it (`a_session_taken_for_a_sleep_whose_answer_never_came_comes_back_after_the_wake`, `a_session_taken_for_a_sleep_whose_answer_the_daemon_never_heard_comes_back_after_its_start`).
- [ ] The first time a member runs this version, it brings back every idle, untouched session it made that the central host runs: an older version handed every session over at every sleep (`the_first_start_of_this_version_brings_back_the_untouched_sessions_the_central_host_runs`).
- [ ] Nothing comes back while the member sleeps (`a_member_going_to_sleep_hands_its_running_session_to_the_central_host`). A dark wake (Power Nap) counts as awake, as macOS says it powered on.

### Run only on…

- [ ] A session's menu has one **Where it runs** submenu (2026-11-14; before that, one item each, "Run only on MacBook" and so on, at the menu's top level). A click on it opens it, as hovering does, so the keyboard reaches it too.
  - **Bring to this Mac**, for a session the central host runs and nobody kept anywhere, brings it here as typing does, with no message, and does not pin it: it still follows the user. A message typed while it waits goes with it, and is held, or sent to a session kept there, as any typed message is when the session can't come. A message held in a toast goes with it too, and that toast closes. When it can't come with no message, a toast says why, with **Try again**; for a session kept there, with nothing to try again (`followStore.test.ts` › "brings a session here from its menu, with no message", "says why a session can't come here from its menu, with Try again only", "brings it again on Try again, from its menu", "says a session kept there since the app last heard can't come from its menu, with nothing to try again", "brings a message typed while the menu's bring waits, with it", "holds a message typed while the menu's bring waits, when the session can't come", "sends a message typed while the menu's bring waits to the owner, when the session is kept there", "brings the message held in a toast with it, when brought from the menu").
  - **Run only on MacBook** and **Run only on studio-mini**, for this Mac and the central host by name (a session moves only between a member and the central host, see Implementation notes). Every member is listed, the one running the session too, since choosing it keeps the session there. The member the session is kept on is checked; an unpinned session has none checked. Choosing one pins the session there (`pinned`) and moves it at the end of the current turn, or at once when idle (`follow.test.ts` › "offers Where it runs as one submenu, with Bring to this Mac for a session the central host runs and nobody kept anywhere"; `session-moves.e2e.ts` › "groups Bring to this Mac and Run only on in one Where it runs submenu of the session's menu").
- [ ] **Move now** moves it at once: a running turn is cut off and continues on the chosen member with the cut-off note.
- [ ] A pinned session never moves on its own: not on sleep, not on typing, and not when unreachable. **Unpin** in its menu, or **Run only on** another member, changes that.
- [ ] Choosing a member that is not reachable is refused: "studio-mini is not reachable."

### Where a session runs, in the app

- [ ] A session whose agent runs on another member than the app's own Mac shows a small host icon at the end of its sidebar row. The tooltip names the member: "Running on studio-mini". The icon replaces X68's "on studio-mini" text on session rows. Project headers keep their text.
- [ ] A session that runs on the app's own Mac shows nothing.
- [ ] A session two members list at once, as while it moves between them, shows once: in the sidebar and its ⌘1–9 order, the workspace switcher's count, the board and the command palette, from the first member that lists it (`lists a session two members both list, as while it moves between them, once (X73)`, `holds a session once in a group even when two parts bring it, so its row has one key (X73)`, `orders a session both members list, as while it moves between them, once for ⌘1–9 (X73)`, `counts a session both members list, as while it moves between them, once (X73)`, `takes a session two members list, as while it moves between them, once (X73)`, `lists a session two hosts list, as while it moves between them, once, from the first`).
- [ ] A member stops listing a session as its own (`session.list`, `sessions.changed`) as soon as the account names another owner, before it has let go of it, and `session.list {copies: true}` holds each session once. One it runs whatever the record says stays listed, and is not let go of: one taken over anyway until the central host answers, and one brought here until the news of it comes (`a_session_the_account_gives_another_member_is_no_longer_listed_as_this_members`, `a_member_lets_go_of_a_lost_session_once_its_worktree_is_free_again`, `a_session_taken_over_while_the_central_host_was_offline_is_kept_when_it_is_back`, `a_session_brought_here_is_listed_as_this_macs_own_before_the_account_says_so`).
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
- The session menu: a **Where it runs** submenu with **Bring to this Mac** and **Run only on** each member, **Move now** (while a turn runs), **Unpin**.
- The phone, for an unreachable owner's session whose turn was running: a line above the composer, "MacBook is not reachable · fix-cart was working", with **Continue on studio-mini**.
- The readiness mark: a small hollow triangle after the session's name, in the muted colour.

## Protocol and RPCs

- `session.yield {sessions: [id], epochs: {id: epoch}}`: owner → central host, for a sleep (`why: "moved"` and `pin: true` for Move to…). Answers the sessions taken. The `epoch`s go beside the ids, not in them, so a central host from before reads the list of ids as before, and a member from before, which sends ids alone, is taken as before (`moonlet-proto` `a_sleep_hand_over_names_each_sessions_epoch_beside_ids_a_central_host_from_before_reads`).
- `session.take {session, epoch, reason}`, where `reason` is `typed`, `unreachable` or `move`: member → central host. Answers `{epoch}`, or `stale` or `pinned`. With `returning: true` (coming back after a sleep), also `busy` or `used`.
- `session.release {session, to, now}`: central host → owner. "Stop at the end of this turn (or now), send the last checkpoint and answer."
- `session.bring {session, message?}`: app → its own daemon, when the user types into a session this member does not own.
- `session.give_back {session, epoch}`: member → central host, when the member could not take in the session the central host just gave it at `epoch`, at once or once the central host is heard from after a bring cut off half way. Accepted only from that member, at that epoch, before it opened the session; the central host takes it back with the chats it gave. Sent again after its answer was lost, it answers the session as the central host runs it. A give cut off before the central host gave the session up is taken back where it is.
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
- `$MOONLET_HOME/moves.json` on each member: sessions it handed over before a sleep and has not yet heard answered, `{"sessions": {"<id>": <epoch>}, "withdrawn": {"<id>": <epoch>}}`; `withdrawn` holds those whose agents went on here with no answer, never sent again, kept until the central host is heard from. Written whole: into a file beside it, flushed to the disk, then renamed over it, so a crash leaves the old file or the new one (`moonletd` `moves::tests::a_hand_over_is_kept_across_a_restart_until_it_is_answered`, `a_write_cut_off_by_a_crash_leaves_the_last_whole_file`).
- `$MOONLET_HOME/takes.json` on each member: the sessions it asked the central host for (`session.take`) and has neither taken in nor handed back, `{"sessions": {"<id>": {"epoch": <asked at>, "at": <ms>}}}`. Written whole, as `moves.json` is, before the take is sent; cleared when the session is taken in, handed back, refused, or the record shows it was never given (`moonletd` `takes::tests::a_take_is_kept_across_a_restart_until_it_is_settled`).
- Forked transcripts sit beside the transcript in the profile's `projects/` folder.

## Security considerations

- Only the central host changes `owner` and `epoch`, and only for a member's worker link. A phone, the CLI and an agent cannot move a session: `session.move`, `.unpin` and `.bring` are app-only, and a phone's messages move a session only in the unreachable case, through the central host.
- The cut-off note is moonlet's own text, with only the hosts' names and paths filled in. Names come from the account's `member` records, and control characters are stripped (X68).
- A stopped agent stays stopped until its member knows it still owns the session, so after a handover a waking Mac never runs a step of the old turn.
- ADR 0014's split-brain note stands: while the network is split, an owner the central host cannot reach and a member that took the session over can both run its agent. This spec narrows it to three cases: the user acted from elsewhere, pressed **Take over anyway** after a warning that names the risk, or the Mac woke away from the central host after a hand-over that reached it but whose answer did not reach the Mac (its agents go on, as offline work does, and the session comes back once idle and untouched there). In all, the losing side's work is kept.

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
  - a sleep notice hands a busy session to the central host, and `session.list` there shows it owned; an idle one stays;
  - a busy session goes even though another session's last changes take longer than the hold to send; a busy session whose own take that long stays (`central_copies.rs`, a clean filter that sleeps standing in for a slow send);
  - a sleep notice in the middle of a turn: the central host's agent gets the cut-off note;
  - a pinned session stays and is not taken;
  - a session the central host took while the member slept, no yield answered, its link cut and back (the same network, or another one where the old link stays silent): at wake its agent never goes on, and the session is let go of;
  - `session.bring` while the owner works waits for the turn's end, then the message runs on the new owner;
  - two members taking one session: one gets `stale` (built 2026-11-16, with the bring cut off half way: see Implementation notes);
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

## Implementation notes

Built as the gh stack branches `x73/continue`, `x73/lost`, `x73/bring-back`, `x73/sleep`, `x73/move`, `x73/ready` and `x73/desktop`. The tests are in `crates/moonletd/tests/central_copies.rs` unless another file is named.

What works as specified:
- **Who owns a session.** Only the session's maker and the central host (the referee) change `owner`, `epoch` and `pinned`. The maker owns what it makes, and only the referee moves it to another member. (`moonlet-core` `only_its_maker_and_the_central_host_move_a_session_and_its_owner_records_it_then`, `a_member_cannot_claim_another_members_session_nor_make_one_in_its_name`)
- **Continue on the central host.** It continues a session whose member is unreachable, from its copy, on the session's own branch, resuming the conversation. A cut-off turn gets the note. (`a_session_whose_member_is_away_goes_on_on_the_central_host_from_its_copy`, `a_turn_cut_off_on_the_member_goes_on_with_a_note_to_the_agent`, `a_session_whose_member_is_reachable_is_not_continued_elsewhere`, `a_continued_chat_never_takes_bypass_permissions_from_the_member`)
- **The member that lost a session.**
  - It keeps its gap: changed files in leftovers, and the conversation as `<id>.fork-<time>.jsonl`.
  - Its worktree stays where it is and becomes its X60 live copy, with the new owner's files; only the gap goes to leftovers. (Until 2026-11-13 the whole worktree moved into leftovers, git forgot it, and a fresh copy was made beside it; a copy whose branch here had commits the new owner's lacked then paused.)
  - It then follows the new owner with an X60 live copy, as the user chose. (`a_member_that_lost_its_session_keeps_its_gap_and_follows_the_new_owner`)
- **Sleep.** The member freezes its chat agents, sends what is new, and hands its unpinned busy sessions over with `session.yield`, holding sleep for at most 25 s. An idle session stays (2026-11-13: a 90 s idle sleep with the lid open had handed over 64 idle sessions; `an_idle_session_stays_on_the_mac_through_sleep`). On wake, an agent goes on only while its session is still its own, as the central host says after the wake. (`a_member_going_to_sleep_hands_its_running_session_to_the_central_host`, `a_session_not_handed_over_before_sleep_goes_on_here_after_waking`, `a_session_the_central_host_took_while_the_mac_slept_is_not_resumed_at_wake`, `a_link_that_stays_silent_after_the_wake_is_made_again_before_agents_go_on`)
- **Typing brings a session back.** It waits for the end of the turn, or moves at once with Move now. (`typing_on_the_member_brings_the_session_back_from_the_central_host`, `a_session_in_the_middle_of_a_turn_comes_back_only_when_asked_now`; in the app, listed once before and after: `session-moves.e2e.ts` › "moves the session here when you type into it, and the message runs here". A message typed for a session already back here, as when it came back by itself while the message waited, runs here: `a_message_typed_for_a_session_already_back_here_runs_here`)
- **Run only on… pins, and Unpin.** (`a_session_moved_to_the_central_host_stays_there`, `a_session_moved_to_this_mac_stays_through_sleep_until_unpinned`)
- **Take over anyway.** (`a_session_taken_over_while_the_central_host_was_offline_is_kept_when_it_is_back`)
- **Readiness.** (`the_central_host_says_whether_it_could_continue_each_copy`)
- **The app's marks, menu and lines.** (`apps/desktop/src/lib/follow.test.ts`, `apps/mobile/src/lib/copies.test.ts`)

Where it differs from the draft above:
- **Moves.** A session moves between a member and the central host. Bringing back a session that a third member runs, or moving one to it, answers `elsewhere` or `unsupported`.
- **Take over anyway** starts a new conversation on the member: the transcript stayed on the central host. When the central host is back, it keeps its own work from the gap, files and conversation, before the member's work replaces it.
- **The waiting message** is a toast with Move now, not a line above the composer. It waits until the turn there ends, however long, and then the session moves here with it (`followStore.test.ts` › "brings it here once a long turn there ends, however long, and the message runs here"; the line with Move now shows for as long as it waits, and a moment the link is down does not end it: `follow.test.ts` › "waits on through a moment the link is down (X73)"); only when the session cannot be brought does it go where the session runs. More typed into the same chat meanwhile goes with it. Run only on… during a turn waits up to ten minutes. The chat's muted "Continued on…" line is not built: the agent's note says it instead.
- **Only structured chats** are frozen and moved. A PTY agent tab is not.
- **Setup** does not run when a session continues on the central host.
- **Waking:** the member asks the central host with one `daemon.info` round trip, to prove the link, then one `account.sync` made after the wake, which brings every record it lacks, and waits up to 5 s for the answer before it lets agents go on. No new method: a central host from before this answers it too. Until 2026-11-15 the member waited up to 5 s for its link to say it was up, and half a second for the account's news, so after a sleep longer than the central host's 30 s of pings it read its records from before the sleep and let an agent go on in a session the central host had taken.
- **The order of the sleep step** (2026-11-16): until then the member sent every live session's last changes, one after another and idle ones included, and only then the hand-over. With dozens of sessions, or one slow pack or snapshot, the hold could run out first, and no busy session was handed over. Now the busy sessions' last changes go first, each in a task of its own, and each is handed over as soon as its own are in; the rest follow. One hand-over is in flight at a time; the next names the sessions done meanwhile. Each session has its own send lock, so a sleep's send never waits for a round busy with another session. The background round stops at its next session while a sleep sends; a send someone asked for (a wake's, Move to…) does not. The hand-over does not go out ahead of the last changes, with something for the central host to judge its copy by, for two reasons. The central host cannot judge its copy without the session's tree as it is now, and working that tree out is the slow part. A central host from before would also take such a hand-over at once, from whatever copy it has. No method or field changed, so a member and a central host of either version hand over as before. What counts as sent is as before: a transcript the central host took only part of (it holds at most 16 chunks of 4 MB per round, and nothing before its copy is made) and a checkpoint it did not keep count as sent, so a session made just before the sleep can still be handed over before its conversation reached the central host. Not done: telling the central host at the start of the hold that the member is going to sleep (it learns it from the first hand-over, or from 3 missed pings when there is none), and putting a hand-over ahead of a pack already queued on the link (`moonlet-link` sends the frames in the order they were queued).
- **Asks and queued messages that move** (2026-11-16): until then a continued chat started idle: its open ask was cleared, its queued messages were marked "Not delivered", and its subagents stopped, so a hand-over lost what resuming the frozen agent would have kept. Now `ChatManager::create_continuing` keeps the main agent's plan and question asks as a daemon restart does, and holds the queued messages; `ChatManager::go_on` sends the cut-off note and then the held messages, each again with its own uuid (`Adapter::resend`), or keeps the note for the answer while an ask waits. A plan or a question is answered by a message, not by replaying the old tool call: the resumed Claude Code has no pending call to answer, and moonlet already answers asks kept through a restart this way. No method or field changed: the chat states in a copy already carried `pending` and `queued`, so a member and a central host of either version still move sessions, an older one with the old loss. The sleep decision no longer counts a subagent alone (`power::hand_over_at_sleep`). A daemon restart on the new owner keeps the held messages and the kept note (saved with the chat), and **Move now** leaves a kept ask open to move on (`ChatManager::cut_off`) instead of stopping it. Not done: a held message keeps its text but not its images (a copy's queue has none). A bring with **Move now** still sends no cut-off note. With **Move now** while the agent there is live, its queued messages are taken as they are as the turn is cut off; should Claude Code read one in the instant before the agent there stops, it would also run on the new owner.
- **The sleep hold** has not been measured on a real MacBook: manual check M12. `power.simulate` holds a sleep as the Mac does, for 25 s or the test's `MOONLET_TEST_HOLD_MS`, and cuts off what is not done by then.
- **A bring cut off half way** (2026-11-16, from the 2026-11-15 audit): until then the central host's give named the member the owner and gave the session up before it answered, and the member kept no note of the take. A lost answer or a timeout (the link waits 60 s), a sleep, or the daemon stopping before the member took the session in left the account naming the member while no host ran it; a hand-back that failed was only logged. From then on a bring answered "that session is this Mac's own", the phone's messages `not_found`, Continue here `reachable`, and the coming-back pass did nothing. Now:
  - The member notes each take in `takes.json` before sending it, and one bring of a session runs at a time. A refusal (`busy`, `used`, `stale`, `pinned`, `elsewhere` and the like, all decided before the central host gives anything up) clears the note; any other error keeps it. Every 5 s while linked and awake, a noted take is settled by the central host's records after a fresh `account.sync`: handed back when the record names this member and it does not run the session, forgotten when it was never given or has moved on, waited on for up to 2 minutes while the record still names the central host at the number asked. As the link comes up, the daemon's start included, every session the record names this member the owner of that it does not run, with no takeover pending, is handed back the same way, so a session stranded by a version from before comes back too.
  - The member hands back rather than finishing the bring: the hand-back already exists in both versions, needs only the central host, and the central host keeps the session's chats as given until the member opens the session. A message typed for the bring is not resent; the app's toast keeps it with **Try again**, and the coming-back pass brings a session taken for a sleep again.
  - On the central host, gives and hand-backs run one at a time, and a give checks the ownership number before the owner, so the second of two takes is `stale`. A give finds the worktree left on `moonlet-copy/<id>` with no branch of the session's name and puts it back first. A hand-back for a session the central host still has (its give named the member and stopped before giving it up) records the central host the owner again. The same hand-back again answers the session. Tests stop the central host inside a give once through `MOONLET_TEST_STOP_IN_GIVE`, a file whose presence stops it right after the account names the member.
  - No method or field changed. A member of this version with a central host from before hands back as before; a second hand-back then answers `elsewhere`, which the member takes as settled, and a give cut off on such a central host stays as it was. A member from before with a central host of this version keeps no note, so a bring cut off on it stays stranded until that member runs this version, whose first link hands it back; meanwhile that member gets `stale` instead of `internal` from the second of two takes.
  - Not done: a member that stops after taking the session in but before its chats go on runs the session with no chats (the note is cleared once it is taken in); a hand-back the central host refuses with `not_given` (the member opened the session already) is forgotten.
- **Hand-overs not answered** (2026-11-16): until then the hand-over was sent once, as ids alone, and on an error only logged. When the hold ran out while it was in flight, the central host could still take the sessions, and they never came back by themselves, as the member never noted them as taken; and a hand-over that arrived late moved a session whatever had happened to it since. Now `moves.json` keeps it, the wake and the daemon's start settle it, and it names each session's `epoch`. The test network can go down right after the hand-over leaves (`Network::cut_after`), so it reaches the central host and its answer does not.

Sessions stuck on the central host (2026-11-14). After the 2026-11-13 sleep, seven sessions stayed on the central host. Their MacBook copies had paused before they were made ("has commits studio-mini's doesn't"), so they had no folder. A bring then answered `no_copy`, and the app showed an error and sent the message to the central host. Since then:
- X60 makes such a copy instead of pausing it, whether this Mac is ahead or has diverged.
- Typing and Run only on… make a copy with no folder first. Coming back by itself after a sleep still waits for a copy, so a copy the user stopped stays stopped.
- A bring keeps every commit: ahead, the session comes with this Mac's; diverged, this Mac's go on `<branch>-this-mac`, which the answer names (`kept_on`).
- The app says why a session can't come, and keeps the message until the user sends it there or tries again.
- `owner.reachable` for a session the central host runs reads this Mac's link to it.

A bring right after a copy is made in place, before the central host has opened it, can answer `not_found: no such copy` (seen once in a loaded test run of `typing_on_the_member_brings_the_session_back_from_the_central_host`). **Try again** brings it.

## Open questions

- Does the network carry data during the hold when the lid closes, on battery and on power? Manual check M12 measures it. If it never does, the hold can be cut to a few seconds, and hand-overs then rely on the next dark wake.
- Should the composer offer **Send to studio-mini instead**, which keeps the session where it is for that one message? It is in the UI above; drop it if it confuses.
