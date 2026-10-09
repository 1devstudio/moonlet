# X31 — The agent reads a terminal tab, with the user's approval

- **Status:** draft (part 1 implemented: reading, approval, CLI and modal)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2 (agent-first), A6 (CLI and socket API), journey J2
- **Related:** [T3](T3-shell-integration.md) (shell integration), [T8](T8-block-styling.md) (copy a block to the agent), [T9](T9-real-command-blocks.md) (daemon-owned blocks, draft), [X22](X22-agent-opens-session.md) (moonlet skill), [X23](X23-confirm-modal.md) (confirm modal), [A3](A3-sidebar-and-notifications.md) (attention)
- **Related ADRs:** [0003](../adr/0003-vt100-terminal-state.md)

## Summary

A command fails in a terminal tab and the user asks the session's agent to "check it". Today the agent cannot see the tab: the user has to copy the output into the chat, or press ⌘↵ on the block (T8). X31 lets the agent fetch it: `moonlet term ls` lists the terminal tabs of the agent's own session, and `moonlet term read <id>` returns the output of the last command (or the last lines) as plain text. Terminal output often holds secrets, so every read asks the user first. moonlet shows exactly the text the agent would get, and the user allows or denies it, once or for the rest of the session. The moonlet skill teaches Claude Code and Codex when to use this, and moonlet keeps the installed skill up to date by itself.

## User journey

1. In session "Fix login", the user runs `pnpm test` in the session's Terminal tab. It fails.
2. The user switches to the agent and writes "the tests fail, check the terminal".
3. The agent runs `"$MOONLET_BIN" term ls` and sees `3  shell  zsh  ~/work/api  at prompt  exit 1`. It runs `"$MOONLET_BIN" term read 3`.
4. moonlet opens a modal: **Let Claude read a terminal?** "Claude in Fix login wants the output of `pnpm test` (exit 1, 84 lines) from terminal zsh." Under it, a scrollable monospace preview of exactly that text, an unticked box "Allow for the rest of this session", and **Deny** and **Allow**.
5. The user scrolls the preview, sees nothing secret, and clicks Allow. The agent's command prints the output; the agent reads the failing test and fixes it.
6. Later, with the box ticked on a previous read, the agent reads the dev server's Run tab without a modal.
7. Had the user been in another session when the agent asked, the "Fix login" row would show it waiting for the user, with the usual sound and dock badge; opening the session shows the modal.

## Behaviour and acceptance criteria

### Reading a terminal (stack part 1)

- [x] `terminal.read { caller, id, lines? }` returns the terminal's last `lines` lines (default 200, at most 2000) of scrollback and screen as plain text: no escape sequences, trailing spaces and trailing blank lines removed, and rows the terminal wrapped joined back into one line. (`crates/moonletd/tests`: a shell that prints a long line and 300 numbered lines)
- [x] `caller` is the reading terminal's id. The daemon resolves its session from that terminal, not from anything the caller claims about its session. A caller outside any session is refused with `this terminal is not in a session`.
- [x] Only terminals of the caller's session can be read, and only `shell`, `run` and `setup` terminals. Any other id (another session's terminal, an agent terminal, an unknown id) fails with the same `no terminal <id> in this session`, so a refusal does not reveal that a terminal exists elsewhere. (`crates/moonletd/tests`: two sessions)
- [x] A terminal that has exited can still be read until it is removed; the result carries its exit code. (`terminal_read_e2e.rs`)
- [x] `moonlet term read <id> [--lines N] [--json]` calls `terminal.read` with `caller` from `$MOONLET_TERMINAL_ID` and prints the text. `--json` prints `{ terminal, title, command?, exit?, running, truncated, text }`. Without `$MOONLET_TERMINAL_ID` it fails with `moonlet: term read runs inside a moonlet terminal or agent`. (`crates/moonlet-cli/tests`)
- [x] `moonlet term ls [--json]` lists the readable terminals of the caller's session (`terminal.read_list`): id, kind, title, directory, and status (`running`, `at prompt`, `exited <code>`). It needs no approval and shows no output and no command text. (`terminal_read_e2e.rs`)

### Approval (stack part 1)

- [x] Every `terminal.read` waits for the user's answer unless the session has a standing grant. The daemon takes the text when the request arrives and returns exactly that text on Allow, so the agent gets what the user saw, never output printed after the preview. (`crates/moonletd/tests`: output printed after the request is not in the result)
- [x] The request reaches the app as a `terminal.read_request` event `{ request_id, session_id, caller, agent?, terminal_id, title, command?, exit?, lines, text }`, and `terminal.read_requests` lists the waiting ones for a window that connects later. The app answers with `terminal.read_answer { request_id, allow, remember }`. The first answer wins; the others get `already answered`. (`terminal_read_e2e.rs`)
- [x] The `moonlet` CLI cannot answer a request or list the waiting ones (`forbidden: only the moonlet app answers read requests`), so an agent cannot approve its own read or see the text with `moonlet rpc`. (`terminal_read_e2e.rs`)
- [x] When the window shows the requesting session, the app opens the modal at once. The title is `Let <agent> read a terminal?`. The message reads `<agent> in <session> wants the output of <command> (exit <code>, <n> lines) from terminal <title>.`, or `wants the last <n> lines of terminal <title>.` when no command is known. (`lib/terminalRead.test.ts` with these literals)
- [x] Titles, commands and the session name in the message are cleaned of escape sequences and control characters and cut to 60 characters, so a program cannot write a misleading paragraph into the question. (`terminalRead.test.ts`)
- [x] The modal shows the text in a monospace box, scrollable, at most 16 lines tall, plus the box `Allow for the rest of this session`, a ghost **Deny** and a primary **Allow**. Allow has focus. Esc, ×, a click outside and Deny all deny.
- [x] When the window shows another session, the requesting session's sidebar row shows `needs input`. The dock badge and the X10 sound fire as for a blocked agent, and an unfocused window gets the notification `<session> needs you` with `Wants to read terminal <title>`. Opening the session opens the modal. Answering returns the row to its previous state. (`agent-reads-terminal.e2e.ts`, `terminalRead.test.ts` for `readWaits`)
- [x] Requests queue: one modal at a time, in arrival order. Another confirm (X23) opening while a read request is shown does not deny the request; the modal comes back when the other confirm closes. (`lib/terminalRead.test.ts`)
- [x] Deny makes the CLI exit 1 with `moonlet: the user declined to share terminal <id>`. No answer within 5 minutes makes it exit 1 with `moonlet: the user did not answer; ask them to share the output`. The terminal closing while a request waits withdraws it, closes the modal, and the CLI exits 1 with `moonlet: terminal <id> closed`.
- [x] Allow with the box ticked stores a grant for the session. Further reads of any of the session's terminals return at once, with no modal and no blocked row. The grant lives in the daemon's memory only: archiving the session or restarting the daemon clears it.
- [x] While a grant exists, the session's ⋯ menu shows **Ask before the agent reads terminals**, which clears it. (`lib/terminalRead.test.ts` for the menu item; e2e for the effect)
- [ ] A session on a remote host (R3) asks in the same way: the host's daemon sends the event over the existing connection. (Not tried against a remote host yet.)

### The last command (stack part 2)

- [ ] The daemon records each terminal's most recent command from its OSC 133 marks: where its output starts (`C`), where it ends (`D`), and its exit code. A command that has not finished yet counts as the last command, with `running: true`.
- [ ] The zsh, bash and fish hooks also report the command line in their preexec hook as `OSC 1337;MoonletCommand=<percent-encoded command>`. The daemon keeps it with the last command. (`shell.rs` tests with real shells: `false` reports `MoonletCommand=false` then `133;D;1`)
- [ ] `terminal.read` without `lines` returns the last command when the terminal has one: the line `$ <command>`, then its output. Without shell marks it returns the last 200 lines as before. `--lines N` always returns the last N lines.
- [ ] Output longer than 2000 lines keeps the last 2000 lines, starts with `… <n> earlier lines omitted`, and sets `truncated`. Output whose start has already left the 10,000-line scrollback starts with `… earlier output is no longer in the scrollback`. (`term.rs` unit tests)
- [ ] `moonlet term ls` shows the last command's exit code (`at prompt  exit 1`).

### Skill (stack part 3)

- [ ] The moonlet skill gets a section "Read the user's terminals". When the user mentions a terminal, a failed command, a test run or a server log, the agent runs `term ls` and picks the tab that fits; if several fit, it asks the user which one. It then runs `term read <id>` and reads only that output. It tells the user it asked for the output, never retries a declined read, and never sends input to the terminal to reproduce the output. The skill's description mentions reading terminal output.
- [ ] When the daemon starts, it rewrites each installed skill file (`~/.claude/skills/moonlet/SKILL.md`, `$CODEX_HOME/skills/moonlet/SKILL.md`) that carries the `Installed by moonlet` marker and differs from the current skill. It never creates a missing file and never touches a file without the marker. (`hooks.rs` tests: outdated, current, missing, and foreign files)

## UI

    ┌ Let Claude read a terminal? ──────────────────────────────────────── × ┐
    │ Claude in Fix login wants the output of pnpm test (exit 1, 84 lines)    │
    │ from terminal zsh.                                                      │
    │ ┌─────────────────────────────────────────────────────────────────────┐ │
    │ │ $ pnpm test                                                         │ │
    │ │  FAIL  src/login.test.ts > rejects an expired token                 │ │
    │ │ AssertionError: expected 200 to be 401                              │ │
    │ │ …                                                                   │ │
    │ └─────────────────────────────────────────────────────────────────────┘ │
    │ ☐ Allow for the rest of this session                    Deny    Allow   │
    └─────────────────────────────────────────────────────────────────────────┘

The modal is the X23 `ConfirmDialog` with a preview slot: the same overlay, panel, header and footer, 560 px wide instead of 440 px to fit 80 columns. The preview uses the terminal font at 12 px on `bg-panel-2`, with `max-h` of 16 lines and its own scroll. React escapes the text. Allow uses the primary tone, not danger: sharing is the action the user asked for.

## Protocol and RPCs

- New `terminal.read { caller: TerminalId, id: TerminalId, lines?: u32 }` returns `{ terminal, title, command?, exit?, running, truncated, text }`. The response waits for the user's answer.
- New `terminal.read_answer { request_id, allow: bool, remember: bool }` returns `{}`.
- New `terminal.read_list { id: caller }` returns the caller's readable terminals (`[TerminalInfo]`).
- New `terminal.read_requests` returns the waiting requests, oldest first, and `terminal.read_grants` the session ids with a standing grant. The app loads both on connect.
- New `terminal.read_grant_clear { session_id }` returns `true`.
- `terminal.read_answer` and `terminal.read_requests` are refused for the `moonlet-cli` client.
- New event `terminal.read_request { request_id, session_id, caller, agent?, terminal_id, title, command?, exit?, lines, text }`, `terminal.read_done { request_id }` when a request is answered, withdrawn or times out, so every window closes its modal, and `terminal.read_grant { session_id, granted }` when a grant is given or cleared.
- `MOONLET_TERMINAL_READ_TIMEOUT_MS` in the daemon's environment shortens the 5-minute wait, for tests.
- Shell integration: `OSC 1337;MoonletCommand=<percent-encoded>` from the preexec hook.
- CLI: `moonlet term ls [--json]`, `moonlet term read <id> [--lines N] [--json]`.

## Data and config

Nothing new on disk except the rewritten skill files. Pending requests, the snapshot text and grants live in the daemon's memory.

## Security considerations

- Terminal output can hold tokens, passwords and environment dumps. The user sees the exact text before the agent gets it, and the agent never gets more than that text.
- The approval guards against accidents and prompt injection, such as a README telling the agent to read every terminal. It is not a hard boundary against a hostile agent. An agent with shell access runs as the user, can call `moonlet rpc terminal.search` or `terminal.attach` directly, and can read the user's files. The socket is private to the user (S1), as in X22.
- An agent cannot answer its own request or read the waiting text through `moonlet rpc`: the daemon refuses `terminal.read_answer` and `terminal.read_requests` from the CLI. A program that speaks the socket protocol itself, under another client name, still can; see the point above.
- The session check uses the caller's terminal id, which the agent could change in its environment. A false id still only reaches terminals of an existing session, and still asks the user, whose modal names the session being read.
- `term ls` shows titles, which shells often set to the running command. It shows no output and no command line.
- A grant never outlives the daemon process or the session.

## Out of scope

- Redacting secrets automatically.
- Reading other agents' terminals, or terminals of other sessions.
- Writing to a terminal or running a command for the agent (`moonlet pane run` exists, but the skill does not use it here).
- Following output live (`term read --follow`). The agent reads again when it needs newer output.
- A `+` menu item for attaching a terminal's output; ⌘↵ on a block (T8) already sends it.
- Full daemon-owned blocks: T9 covers them. Part 2 records only the last command.

## Test plan

- Rust daemon (`crates/moonletd/tests/terminal_read.rs`): tail text and wrap joining; session scoping and the uniform refusal; approval flow with allow, deny, remember, timeout (short timeout in tests) and terminal closing; snapshot taken at request time; grant cleared on archive.
- Rust core (`crates/moonlet-core/src/term.rs`): last-command boundaries, running command, truncation and scrollback-loss markers. `shell.rs`: `MoonletCommand` from zsh, bash and fish. `hooks.rs`: skill refresh.
- Rust CLI (`crates/moonlet-cli/tests`): `term read` without `$MOONLET_TERMINAL_ID`, the exit messages for deny and timeout, `--json` shape.
- Vitest (`apps/desktop/src/lib/terminalRead.test.ts`): modal title and message, cleaning of program-chosen text, the request queue alongside X23 confirms, the waiting state of a session, the ⋯ menu item.
- E2E (`apps/desktop/e2e/specs/agent-reads-terminal.e2e.ts`): the test runs `moonlet term read` as the agent in the session's first terminal would. The modal shows the exact output; Allow gives it to the CLI, Deny gives the decline message; with another session in view the row shows `needs input` until the session is opened; a ticked box lets the next read through without a modal, until the ⋯ menu item clears it.

## Delivery

Three stacked PRs (`gh stack`): part 1 (read, approval, CLI, modal), part 2 (last command), part 3 (skill and refresh). Part 1 alone covers "check my terminal" with the last 200 lines.

## Open questions

- Should the grant cover the whole session, or only the terminal the user approved? This spec uses the whole session, which is simpler to explain; a tab opened later is covered too.
- Is 5 minutes right for the timeout? Claude Code's Bash tool times out after 2 minutes by default unless the agent passes a longer timeout. The skill should tell the agent to pass `timeout: 300000`, or the CLI should return earlier.
