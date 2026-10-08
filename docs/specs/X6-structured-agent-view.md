# X6: Structured agent view (Claude Code and Codex)

- **Status:** implemented for Claude Code (verified live); Codex adapter implemented and tested against synthetic streams, not yet live (needs `codex login`). Approved by user decision on 2026-10-03: option 3 over the TUI-plus-composer alternatives.
- **Priority / phase:** P1 (pulled forward from PRD A7 "ACP side channel", P2)
- **PRD refs:** A1, A3, A5, A7, goal 2; PRD non-goal "chat UI replacing the agent's TUI" is **overridden** by this decision for Claude Code and Codex. The TUI remains available on demand.
- **Related:** [T6](T6-input-editor.md) (editor), [X5](X5-workspaces-projects-sessions.md) (sessions), [A1](A1-agent-state.md) (agent state)

## Summary

Agent tabs show a native conversation view instead of the agent's terminal UI: messages, thinking, tool calls with their output and diffs, permission requests as buttons, and an input editor as the only input. The agent runs headless under the daemon, so the view survives app restarts like terminals do. "Open in terminal" opens the same conversation in the agent's own TUI.

## How the agents run

- **Claude Code:**
  - Command: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio`, plus `--model`, `--effort`, `--session-id <uuid>` (first start) or `--resume <id>` (restore).
  - The host sends `control_request {subtype: initialize}` first.
  - User turns are written as `{"type":"user","message":{"role":"user","content":[{"type":"text","text":…}]},"parent_tool_use_id":null}`.
  - Permission requests arrive as `control_request {subtype: can_use_tool}` and are answered with `control_response {subtype: success, response: {behavior: allow, updatedInput} | {behavior: deny, message}}`.
  - Interrupt: `control_request {subtype: interrupt}`.
  - Reference: `@anthropic-ai/claude-agent-sdk` 0.3.288 type definitions.
- **Codex:**
  - Command: `codex app-server` (JSON-RPC over stdio).
  - Sequence: `initialize`, then `thread/start {cwd, model, approvalPolicy: on-request}` (or `thread/resume`), then `turn/start {threadId, input, effort}`.
  - Item and turn notifications stream the conversation. Approval server-requests (command execution, file change) are answered from the UI. Interrupt is `turn/interrupt`.
  - Reference: `codex app-server generate-ts` from codex-cli 0.160.0.

## Model

Both agents map onto one normalized chat model in `moonlet-proto`.

- **`ChatItem`**: id (stable; streaming deltas update the same item), kind (`user`, `assistant`, `thinking`, `tool`, `system`, `error`), text, an optional `ToolCall`, and a timestamp.
  - `ToolCall` holds the name, a one-line summary, the input, the output, a status (`running`, `ok`, `error`, `denied`) and an optional unified diff.
- **`PermissionAsk`**: id, tool, summary, input, reason, and whether "always allow" is offered.
- **`ChatState`**: items, pending asks, status (idle, working, blocked, done, error), model, effort, cost, tokens, turn start time, the agent's own session/thread id, and slash commands.

A structured agent is a **terminal** with `chat: true` (no PTY). It appears in `terminal.list` and session layouts, drives `agent_state` and `agent.attention` like any agent terminal, and is killed, removed and restored through the same calls.

## RPCs and events

- `terminal.create {agent, chat: true, model?, effort?}` starts one. `session.create` uses the structured view for Claude Code and Codex unless `tui: true`. The session's first prompt is sent as the first message.
- `chat.state {id}` returns the `ChatState`.
- `chat.send {id, text}` sends a message. During a running turn, Claude Code takes it as queued input. Codex steers the running turn with it (`turn/steer`). Before a Codex thread exists, messages wait in the adapter until it is created. If a saved Codex thread cannot be resumed, a new thread is started and the note says so. `ChatState.queued` is reserved and currently always empty.
- `chat.permission {id, ask, decision: allow|always|deny, message?, answers?}` answers a permission request. `answers` (question text → answer) is only used for Claude's `AskUserQuestion`, see "Questions" below.
- `chat.interrupt {id}` stops the current turn. Stopping the process (`terminal.kill` without remove, or a settings restart) also closes a running turn with a "Stopped" note. Open permission requests are denied first. The turn ends with an "Interrupted" note and status `idle`, not an error.
- `chat.settings {id, model?, effort?, mode?}` changes the model, effort or (Claude only) permission mode, see [X7](X7-agent-permission-mode.md). The agent restarts with resume before the next message.
- `fs.files {root}` lists the project's non-ignored files for `@` mentions.
- Events: `chat.item {id, item}`, `chat.state {id, state}` (everything except the items), and the usual `terminal.*`.
- Item ids for moonlet's own items (user, system, error) include a timestamp. A resumed agent starts a fresh adapter, and its ids must not clash with the saved transcript.

## UI

- **Conversation:**
  - User messages are right-aligned bubbles. Assistant text renders as sanitized Markdown with code highlighting. Thinking is a one-line row (`Thinking` and the start of the thought) that expands to the full text, see [X14](X14-collapsed-tool-calls.md).
  - Tool calls are compact rows: an icon, a summary (`Bash  git status`, `Edit  src/app.ts  +12 −3`, `Read  README.md`) and a status mark, expandable to show the output or the diff. By default, runs of tool calls are folded into one `N tool calls` row ([X14](X14-collapsed-tool-calls.md)).
  - Permission requests are an inline card with the tool and summary, the reason, and **Allow**, **Always allow** and **Deny** buttons.
  - Questions from Claude (`AskUserQuestion`) get a question card instead, see below.
- **Footer:** a status line (spinner and elapsed time while working; cost and tokens), Stop (⌘.) while running, then the editor.
- **Editor:**
  - Multi-line with mouse editing.
  - **Enter** sends; **⇧Enter** adds a new line; **↑** in an empty editor recalls the previous prompt.
  - `@` completes project files (fuzzy, from `fs.files`: non-ignored files, relative to the session); `/` lists the agent's slash commands.
  - Ghost text suggests from the user's previous prompts to that agent.
  - Unsent text stays with its chat: switching to another session and back shows it again, ready to finish. It is kept in memory until sent or the chat terminal is removed, not across an app restart.
- **Header menu:**
  - Model and effort switch, applied from the next turn (Claude restarts with `--resume`; Codex passes them per turn).
  - "Open in terminal", which runs `claude --resume <id>` or `codex resume <id>` in a new terminal tab.
  - "Copy transcript".
- **Composer integration:** a new session's first prompt becomes the first `chat.send`.

## Questions (Claude `AskUserQuestion`)

Claude asks the user multiple-choice questions through the `AskUserQuestion` tool. Headless, it arrives as a `can_use_tool` request like any other tool. The host answers it by allowing the tool with the answers added to the input: `updatedInput = {questions, answers: {"<question text>": "<answer>"}}` (`AskUserQuestionInput.answers` in the Agent SDK types).

- The card shows each question (1–4) with its header chip and text, and its options (2–4) as buttons with label and description.
  - Single-select questions take one option. `multiSelect` questions toggle any number of options.
  - Every question also has an "Other" text field. Typing in it replaces the selected option (single-select) or is added to the selected options (multi-select).
- The answer to a question is the chosen label, the typed text, or for multi-select all chosen labels and the typed text joined with ", ".
- **Submit** is enabled once every question has an answer. It sends `chat.permission {decision: allow, answers}`.
- **Skip** sends `deny` with the message "The user declined to answer the questions.", so Claude continues without answers.
- The footer status reads "Waiting for your answer" while only questions are pending.
- Option previews and per-question notes (`annotations`) are not shown or sent.

## Persistence and restore

- The chat state is persisted to `~/.moonlet/chats/<terminal id>.json` (debounced), together with the agent session or thread id.
- After a daemon restart, a chat terminal is re-created and re-spawned with resume, and its items are restored from the file. A turn in flight at the time is reported as interrupted.
- A live daemon upgrade hands chats over by restarting them with resume. The transcript is kept, but a running turn is interrupted. Pipe handoff is a possible later improvement.
- Restored chats keep their terminal id. The agent process is only started by the next message, so a restart costs nothing until the user continues.
- Permission cards for edits include the diff. Paths inside the session worktree are shown relative to it.
- The floating agent card is not shown for chat terminals in the open session, because the conversation already shows the outcome or the approval.

## Security

- Tool output and agent text are rendered as sanitized text or Markdown, with no raw HTML.
- Permission answers only come from explicit button presses.
- The agent process gets the same clean environment as terminals (S1).

## Acceptance criteria

- [x] **Claude live, Haiku in a scratch repo** (2026-10-03, $0.11 total):
  - streaming text appears incrementally;
  - a Bash call asks for permission and is allowed or denied from the card;
  - an Edit shows a diff;
  - Stop interrupts;
  - quitting and reopening the app shows the full conversation;
  - "Open in terminal" continues it in the TUI. The TUI first asks Claude's folder-trust question, which headless mode skips.
- [ ] **Codex live** (after `codex login`): the same flow.
- [x] Agent state, sidebar dots and notifications work for chat terminals (verified live). The approval inbox uses the same agent state but was not checked separately.
- [x] A daemon restart restores the conversation and resumes the agent (verified through two live upgrades).
- [x] Adapter unit tests replay recorded/synthetic protocol streams for both agents.
- [x] **Questions, protocol** (2026-10-04, Haiku, $0.04): answering `AskUserQuestion` with `updatedInput.answers` gives the tool result `Your questions have been answered: "…"="Blue"` and Claude continues with the answer. The adapter round trip is unit-tested.
- [x] Unsent text in the editor survives switching to another session and back (`chat.test.ts`, `agent-view.e2e.ts`).
- [ ] **Questions, UI:** the question card (options, multi-select, Other, Submit, Skip) has not been checked in the app.
