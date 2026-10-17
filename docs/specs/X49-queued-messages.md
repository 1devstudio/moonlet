# X49 — Queued messages, Send now and Ask aside

- **Status:** draft
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

- [ ] Every user message moonlet writes to Claude carries a `uuid`. A message sent while the chat is `working` or `blocked` goes into `ChatState.queued` as `{id, text}`, not into the transcript.
- [ ] Claude's `command_lifecycle` frame `started` for a queued message moves it into the transcript as a user message, at the point where Claude read it. A message sent while the chat is idle goes straight into the transcript, as before.
- [ ] `command_lifecycle` `cancelled`, `discarded` or `refused` removes the message from the queue; `refused` and `discarded` add an error naming the message, since Claude will not read it.
- [ ] `chat.send_now {id, message?}` writes Claude's `interrupt` with `send_now: true`, naming `message` as `message_uuid` when given (without it every queued message counts). The interrupted turn's failed `result` is shown as `Interrupted`, not as an error.
- [ ] `chat.unqueue {id, message}` writes Claude's `cancel_async_message` for the message; the queue changes when Claude reports `cancelled`. Unqueueing a message that is not queued is an error.
- [ ] When the agent process ends, or the daemon restarts, with messages still queued, each moves into the transcript followed by `Not delivered: Claude stopped before reading this message.`
- [ ] `chat.aside {id, text}` answers `text` from the conversation in a separate, tool-less Claude that forks the chat's conversation without saving it (`--resume <session> --fork-session --no-session-persistence --tools ""`), in the chat's folder, model and Claude profile. It returns `{text, cost_usd, duration_ms}`. The question tells Claude that a tool call still running in the main session is running, not interrupted. The main chat's state is not changed.
- [ ] `chat.aside` on a chat with no Claude conversation yet, or a Codex chat, is an error.

### Desktop

- [ ] Queued messages sit after the transcript as dashed bubbles. Above them a line names what they wait for: `Queued · Claude reads it after <command>` while a tool call runs, `Queued · Claude reads it at its next step` otherwise; with two or more, `<n> queued · Claude reads them after <command>`.
- [ ] Below the last queued bubble: **Send now** (`Send <n> now` for several) and **Ask aside**. Hovering Send now while a command runs rings the command's row amber and changes the line to `Send now stops <command> (running m:ss)`.
- [ ] After Send now the buttons go and the line reads `Stopping <command>…` until Claude reads the message.
- [ ] An `Interrupted` that ends a turn stopped by Send now reads `Interrupted by you · <command> stopped at m:ss`.
- [ ] Ask aside takes the last queued message out of Claude's queue and opens the Aside card: the question, `Answering from the conversation` while it waits, then the answer, its time and cost, **Queue for Claude** and **Close**. The card's header reads `Aside · Not added to the session · can't run tools`; esc closes it. A failed aside shows its error in the card.
- [ ] While Claude works, the composer's placeholder reads `Queue a message for Claude`, a `⌥↵ ask aside` hint shows, and ⌥↵ sends the typed text as an aside without queueing it. The footer adds `· <n> queued`.
- [ ] Codex chats never show queued messages: Codex steers the running turn with a message (X6).

## UI

From the design export "Moonlet Queued Message" (states 01–08 and the prototype):

- **Queued bubble:** right-aligned, `max-width: 85%`, radius `16px 16px 6px 16px`, `1px dashed #3a3a3a`, text `#b8b8b8`, 14px. Meta line 12px faint with a clock icon; the command in mono 11.5px.
- **Buttons:** `Send now` subtle small with a corner-down-left icon; `Ask aside` ghost small with a dashed speech-bubble icon.
- **Hover warning:** meta line in `--color-blocked` with a filled square; the running tool row gets `1px solid rgba(242,201,76,0.45)`, radius 8px.
- **Stopping:** spinner in accent, `Stopping <command>…` muted.
- **Interrupted divider:** centred 12px faint line.
- **Aside card:** `--color-panel-2`, `1px solid --color-border-strong`, radius 12px; header with the accent icon, `Aside` in fg 500, the note muted, a close button; the question 14px; a shimmering `Answering from the conversation` with a spinner; the answer as markdown 13.5px; footer with `3s · $0.0015` in mono faint, `Queue for Claude` ghost and `Close` subtle.

## Protocol and RPCs

- `ChatState.queued: [{id, text}]` (was `string[]`, always empty).
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
- Asides on the phone app.

## Test plan

- Rust: adapter tests replay lines captured from Claude Code 2.1.301 (lifecycle frames, the send-now reply, the cancel reply); runtime tests drive the fake `claude` for the queue, Not delivered and the aside.
- Vitest: the meta line, button labels, divider text and composer hint in `apps/desktop/src/lib/queued.ts`.
- e2e: `queued-messages.e2e.ts` drives a fake `claude` that holds a tool call open.

## Open questions

- Claude may move the running command to the background instead of stopping it (`send_now: "delivering"`); the probes only saw it stop. The UI follows what Claude reports either way.
