# X49 — Queued messages, Send now and Ask aside

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X6 (structured agent view), X16 (turn footer)
- **Related ADRs:** none

## Summary

A message sent while Claude is working waits in Claude Code's queue until the running tool call returns. During a long command (an 8-minute stack check) the chat looked as if Claude ignored the user: the message was drawn as a sent bubble and nothing answered it. moonlet now shows such a message as **queued** until Claude reads it, and offers two ways out: **Send now**, which asks Claude to take the message at once (Claude stops or backgrounds the running command), and **Ask aside**, which answers the message from the conversation in a side card without touching the running turn, as Claude Code's `/btw` does in the terminal.

## User journey

1. Claude runs `pnpm stack:check`. The user types "wait, which port did we end up on for the api?" and presses ↵.
2. The message shows as a dashed bubble under the running command, with `Queued · Claude reads it after pnpm stack:check` above it and **Send now** and **Ask aside** below it. The footer says `Working 8:12 · 1 queued`.
3. When the command returns, Claude reads the message: the bubble becomes an ordinary message where Claude took it in, and the reply follows.
4. Or the user hovers **Send now**: the running command's row gets an amber ring and the line reads `Send now stops pnpm stack:check (running 8:12)`. They click it: the line reads `Stopping pnpm stack:check…`, then `Interrupted by you · pnpm stack:check stopped at 8:12` divides the turn from the message, and Claude answers it.
5. Or the user clicks **Ask aside** (or sends with ⌥↵): the message leaves Claude's queue, and an Aside card shows it with `Answering from the conversation`. The answer arrives in a few seconds with its time and cost. **Queue for Claude** puts the message back in Claude's queue; **Close** (or esc) drops the card. The running command was never touched.

## Behaviour and acceptance criteria

### Daemon (Claude)

- [x] Every user message moonlet writes to Claude carries a `uuid`. A message sent while the chat is `working` or `blocked` goes into `ChatState.queued` as `{id, text}`, not into the transcript. (`claude.rs` a_message_sent_during_a_tool_call_waits_in_the_queue_until_claude_reads_it)
- [x] Claude's `command_lifecycle` frame `started` for a queued message moves it into the transcript as a user message, at the point where Claude read it, with its uuid as the item's id. A message sent while the chat is idle goes straight into the transcript, as before. (`claude.rs` a_message_sent_during_a_tool_call_waits_in_the_queue_until_claude_reads_it, `runtime.rs` runs_a_turn_persists_and_restores)
- [x] Stop leaves queued messages queued: Claude keeps them (`still_queued`) and runs them as the next turn once the stopped one ends. (`claude.rs` a_message_queued_before_a_stop_runs_next)
- [x] `command_lifecycle` `cancelled` removes the message from the queue; `refused` and `discarded` remove it with an error naming it, since Claude will not read it. (`claude.rs` unqueueing_withdraws_the_message_from_claudes_queue, a_message_claude_refuses_leaves_the_queue_with_an_error)
- [x] `chat.send_now {id, message?}` writes Claude's `interrupt` with `send_now: true`, naming `message` as `message_uuid` when given (without it every queued message counts), and marks the messages `sending`. A turn Claude stops for it is shown as `Interrupted`, not as an error; a turn that takes the message in without stopping (`send_now: "delivering"`) ends as usual. When Claude finds nothing to send (`send_now: "nothing_waiting"`) or refuses the request, the messages wait again, no longer `sending`. (`claude.rs` send_now_asks_claude_to_take_the_message_and_the_stopped_turn_is_not_an_error, send_now_without_a_message_sends_every_queued_one, a_turn_that_takes_the_message_in_without_stopping_ends_as_usual, send_now_that_finds_nothing_waiting_lets_the_message_wait_again, `runtime.rs` send_now_delivers_a_queued_message_in_place_of_the_running_turn)
- [x] `chat.unqueue {id, message}` writes Claude's `cancel_async_message` for the message; the queue changes when Claude reports `cancelled`. Unqueueing a message that is not queued is an error. (`claude.rs` unqueueing_withdraws_the_message_from_claudes_queue, `runtime.rs` only_a_queued_message_can_be_unqueued)
- [x] When the agent process is stopped or crashes, or the daemon restarts, with messages still queued, each moves into the transcript followed by `Not delivered: Claude stopped before reading this message.` (`runtime.rs` a_message_still_queued_when_the_agent_stops_is_not_delivered, a_message_queued_when_the_agent_crashes_is_not_delivered, a_message_still_queued_at_a_daemon_restart_is_not_delivered)
- [x] `chat.aside {id, text}` answers `text` from the conversation in a separate, tool-less Claude that forks the chat's conversation without saving it (`--resume <session> --fork-session --no-session-persistence --tools ""`), in the chat's folder, model and Claude profile. It returns `{text, cost_usd, duration_ms}`, or Claude's error. The question tells Claude that a tool call still running in the main session is running, not interrupted. The main chat's state is not changed. A chat whose workspace switched Claude profiles since its conversation started is refused with `This conversation is in another Claude profile: send Claude a message to start one in <profile>.`, as a start would begin a new conversation (X33). An aside that takes over 120 s fails with `The aside took too long.` (`claude.rs` an_aside_forks_the_conversation_without_tools_or_a_saved_session, an_asides_answer_carries_its_text_cost_and_time, a_failed_aside_reports_claudes_error, `runtime.rs` an_aside_answers_from_a_fork_and_leaves_the_running_turn_alone, an_aside_after_a_profile_switch_asks_for_a_message_first)
- [x] `chat.aside` on a Codex chat, or a Claude chat with no conversation yet, is an error. (`runtime.rs` an_aside_needs_a_claude_conversation, an_aside_needs_a_conversation_to_ask_about)

### Desktop

- [x] Queued messages sit after the transcript as dashed bubbles. Above them a line names what they wait for: `Queued · Claude reads it after <command>` while a tool call runs, `Queued · Claude reads it at its next step` otherwise; with two or more, `<n> queued · Claude reads them after <command>`. (`queued.test.ts` names the running command a queued message waits for, says Claude reads it at its next step when no command runs, counts two or more; `queued-messages.e2e.ts` shows a message sent during a command as queued, with Send now and Ask aside)
- [x] Below the last queued bubble: **Send now** (`Send <n> now` for several) and **Ask aside**. Hovering Send now while a command runs rings the command's row amber and changes the line to `Send now stops <command> (running m:ss)`. (`queued.test.ts` counts the messages it sends, warns that it stops the running command, and for how long it ran; `queued-messages.e2e.ts` warns that Send now stops the command while it is pointed at)
- [x] After Send now the buttons go, the command's row stays ringed and the line reads `Stopping <command>…` (`Sending…` with no command running) until Claude reads the message, or the messages wait again. (`queued.test.ts` says what it is stopping until Claude reads the message, is the queued line, the hover warning, or the stopping line after Send now, rings nothing when no command runs)
- [x] An `Interrupted` right after a tool call (Send now, or Stop) reads `Interrupted by you · <command> stopped at m:ss`. (`queued.test.ts` names the command a stop ended and when, leaves other notes, and a stop while Claude wrote, alone; `queued-messages.e2e.ts` delivers the message with Send now and marks where the command stopped)
- [x] Ask aside asks Claude to give the last queued message back, and once Claude reports it cancelled opens the Aside card: the question, `Answering from the conversation` while it waits, then the answer, its time and cost, **Queue for Claude** and **Close**. The card's header reads `Aside · Not added to the session · can't run tools`; esc closes it. If Claude read the message first, no aside is asked and a toast says `Claude read the message before it could be asked aside`. (`queued.test.ts` waits while the message is queued, is cancelled when the message left the queue without being read, is taken when Claude read the message first, shows how long the answer took and what it cost; `queued-messages.e2e.ts` takes the message out of Claude's queue to ask it aside, and puts it back)
- [x] A failed aside shows its error in the card; a reply to an aside that was closed or replaced is dropped. (`queued.test.ts` keeps the answer or the error of the question still open, drops a late reply to a question that was closed or replaced)
- [x] While Claude works, the composer's placeholder reads `Queue a message for Claude`, a `⌥↵ ask aside` hint shows, and ⌥↵ sends the typed text as an aside without queueing it (not while the input answers a plan). The footer adds `· <n> queued`. (`queued.test.ts` offers to queue a message for Claude, counts the queue in the footer, is offered while Claude works, and not while a plan is revised; `queued-messages.e2e.ts` asks the typed text aside with ⌥↵ and closes the card with esc)
- [x] Codex chats never show queued messages: Codex steers the running turn with a message (X6). (`codex.rs` a_message_during_a_codex_turn_steers_it_and_is_never_queued)

### Phone

- [x] The phone's chat shows queued messages as dashed bubbles under the same line as the desktop (`Queued · …`, or `Stopping …` after a Send now from the desktop), without Send now or Ask aside. (`queued.test.ts` is the queued line, the hover warning, or the stopping line after Send now; the phone's `QueuedView` has no test of its own, as React components have none)

## UI

From the design export "Moonlet Queued Message" (states 01–08 and the prototype):

- **Queued bubble:** right-aligned, `max-width: 85%`, radius `16px 16px 6px 16px`, `1px dashed #3a3a3a`, text `#b8b8b8`, 14px. Meta line 12px faint with a clock icon; the command in mono 11.5px.
- **Buttons:** `Send now` subtle small with a corner-down-left icon; `Ask aside` ghost small with a dashed speech-bubble icon.
- **Hover warning:** meta line in `--color-blocked` with a filled square; the running tool row gets `1px solid rgba(242,201,76,0.45)`, radius 8px.
- **Stopping:** spinner in accent, `Stopping <command>…` muted.
- **Interrupted divider:** centred 12px faint line.
- **Aside card:** `--color-panel-2`, `1px solid --color-border-strong`, radius 12px; header with the accent icon, `Aside` in fg 500, the note muted, a close button; the question 14px; a shimmering `Answering from the conversation` with a spinner; the answer as markdown 13.5px; footer with `3s · $0.0015` in mono faint, `Queue for Claude` ghost and `Close` subtle.

## Protocol and RPCs

- `ChatState.queued: [{id, text, sending}]` (was `string[]`, always empty).
- `chat.send_now {id, message?}` → `true`
- `chat.unqueue {id, message}` → `true`
- `chat.aside {id, text}` → `{text, cost_usd, duration_ms}`

Claude Code side (2.1.301, `@internal` in its schema, advertised in the initialize reply's `capabilities` as `interrupt_send_now_v1` and `msg_lifecycle_v1`):

- A user line's top-level `uuid` makes Claude emit `{"type":"command_lifecycle","command_uuid":…,"state":"queued|started|completed|cancelled|discarded|refused"}`.
- `{"subtype":"interrupt","send_now":true,"message_uuid":…}` answers `{"still_queued":[…],"send_now":"stopped|delivering|nothing_waiting"}`.
- `{"subtype":"cancel_async_message","message_uuid":…}` answers `{"cancelled":bool}`.

## Data and config

`queued` is saved with the chat (`~/.moonlet/chats/<id>.json`). A saved chat from before X49 has `queued: []` and loads unchanged.

## Security considerations

The aside runs the user's own Claude with no tools, so it cannot change files or run commands. Its question is passed as an argument, never through a shell.

## Out of scope

- Codex asides.
- Editing a queued message.
- Send now and Ask aside on the phone: the design covers the desktop only, so the phone shows the queue read-only for now.

## Test plan

- Rust: adapter tests replay lines captured from Claude Code 2.1.301 (lifecycle frames, the send-now reply, the cancel reply); runtime tests drive the fake `claude` for the queue, Not delivered and the aside.
- Vitest: the meta line, button labels, divider text and composer hint in `apps/desktop/src/lib/queued.ts`.
- e2e: `queued-messages.e2e.ts` drives a fake `claude` that holds a tool call open.

## Open questions

- Claude may move the running command to the background instead of stopping it (`send_now: "delivering"`); the probes only saw it stop. The UI follows what Claude reports either way.
