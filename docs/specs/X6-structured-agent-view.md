# X6: Structured agent view (Claude Code and Codex)

- **Status:** approved (user decision 2026-10-03: option 3 over the TUI-plus-composer alternatives)
- **Priority / phase:** P1 (pulled forward from PRD A7 "ACP side channel", P2)
- **PRD refs:** A1, A3, A5, A7, goal 2; PRD non-goal "chat UI replacing the agent's TUI" is **overridden** by this decision for Claude Code and Codex. The TUI remains available on demand.
- **Related:** [T6](T6-input-editor.md) (editor), [X5](X5-workspaces-projects-sessions.md) (sessions), [A1](A1-agent-state.md) (agent state)

## Summary

Agent tabs show a native conversation view instead of the agent's terminal UI: messages, thinking, tool calls with their output and diffs, permission requests as buttons, and a Warp-style editor as the only input. The agent runs headless under the daemon, so the view survives app restarts like terminals do. "Open in terminal" opens the same conversation in the agent's own TUI.

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

Both agents map onto one normalized chat model in `jaunt-proto`.

- **`ChatItem`**: id (stable; streaming deltas update the same item), kind (`user`, `assistant`, `thinking`, `tool`, `system`, `error`), text, an optional `ToolCall`, and a timestamp.
  - `ToolCall` holds the name, a one-line summary, the input, the output, a status (`running`, `ok`, `error`, `denied`) and an optional unified diff.
- **`PermissionAsk`**: id, tool, summary, input, reason, and whether "always allow" is offered.
- **`ChatState`**: items, pending asks, status (idle, working, blocked, done, error), model, effort, cost, tokens, turn start time, the agent's own session/thread id, and slash commands.

A structured agent is a **terminal** with `chat: true`. It appears in `terminal.list` and session layouts, drives `agent_state` and `agent.attention` like any agent terminal, and is killed, removed and restored through the same calls.

## RPCs and events

- `chat.state {id}` returns the `ChatState`.
- `chat.send {id, text}` sends a message. Queued if a turn is running (Claude accepts queued input; Codex starts the next turn when the current one completes).
- `chat.permission {id, ask, decision: allow|always|deny, message?}` answers a permission request.
- `chat.interrupt {id}` stops the current turn.
- Events: `chat.item {id, item}`, `chat.state {id, state}` (status, pending, cost), and the usual `terminal.*`.

## UI

- **Conversation:**
  - User messages are right-aligned bubbles. Assistant text renders as sanitized Markdown with code highlighting. Thinking is collapsed into one line ("Thought for 6s").
  - Tool calls are compact rows: an icon, a summary (`Bash  git status`, `Edit  src/app.ts  +12 −3`, `Read  README.md`) and a status mark, expandable to show the output or the diff.
  - Permission requests are an inline card with the tool and summary, the reason, and **Allow**, **Always allow** and **Deny** buttons.
- **Footer:** a status line (spinner and elapsed time while working; cost and tokens), Stop (⌘.) while running, then the editor.
- **Editor:**
  - Multi-line with mouse editing.
  - **Enter** sends; **⇧Enter** adds a new line; **↑** in an empty editor recalls the previous prompt.
  - `@` completes project files (fuzzy, from `fs.list`/`git ls-files`); `/` lists the agent's slash commands.
  - Ghost text suggests from the user's previous prompts to that agent.
- **Header menu:**
  - Model and effort switch, applied from the next turn (Claude restarts with `--resume`; Codex passes them per turn).
  - "Open in terminal", which runs `claude --resume <id>` or `codex resume <id>` in a new terminal tab.
  - "Copy transcript".
- **Composer integration:** a new session's first prompt becomes the first `chat.send`.

## Persistence and restore

- The chat state is persisted to `~/.jaunt/chats/<terminal id>.json` (debounced), together with the agent session or thread id.
- After a daemon restart, a chat terminal is re-created and re-spawned with resume, and its items are restored from the file. A turn in flight at the time is reported as interrupted.
- A live daemon upgrade hands chats over by restarting them with resume. The transcript is kept, but a running turn is interrupted. Pipe handoff is a possible later improvement.

## Security

- Tool output and agent text are rendered as sanitized text or Markdown, with no raw HTML.
- Permission answers only come from explicit button presses.
- The agent process gets the same clean environment as terminals (S1).

## Acceptance criteria

- [ ] **Claude live, Haiku in a scratch repo:**
  - streaming text appears incrementally;
  - a Bash call asks for permission and is allowed or denied from the card;
  - an Edit shows a diff;
  - Stop interrupts;
  - quitting and reopening the app shows the full conversation;
  - "Open in terminal" continues it in the TUI.
- [ ] **Codex live** (after `codex login`): the same flow.
- [ ] Agent state, sidebar dots, notifications and the approval inbox work for chat terminals.
- [ ] A daemon restart restores the conversation and resumes the agent.
- [ ] Adapter unit tests replay recorded/synthetic protocol streams for both agents.
