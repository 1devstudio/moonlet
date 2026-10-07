# X14 — Collapsed tool calls in the agent view

- **Status:** implemented (2026-10-04)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2 (agent-first), journeys J2 and J3
- **Related:** [X6](X6-structured-agent-view.md) (structured agent view), [X10](X10-attention-sounds.md) (Settings › Agents)

## Summary

A long agent turn is mostly tool calls, which push the agent's answers off screen. X14 folds each run of consecutive tool calls into a single row, such as `› 2 tool calls`, that expands on click. Everything the agent writes stays visible: assistant text always renders in full, and each thinking block keeps its own one-line row. Collapsed is the default; Settings can switch back to one row per call.

## User journey

1. The user asks the agent for a change. The agent thinks, runs `Bash` twice, then answers.
2. The conversation shows a `Thinking` row with the first words of the thought, one `› 2 tool calls` row, and the answer in full.
3. The user clicks `› 2 tool calls`. The two `Bash` rows appear below it, and each expands to show its output, as in X6.
4. In **Settings › Agents › Tool calls in the conversation**, the user picks **Expanded**. Every tool call now has its own row, as before X14.

## Behaviour and acceptance criteria

- [x] With **Collapsed**, consecutive tool calls form one group row labelled `N tool call(s)`. A single call is a group too (`1 tool call`). (`chat.test.ts`, `agent-view.e2e.ts`)
- [x] Assistant text, thinking, user messages, errors and notes are never inside a group. They end a run, so `Thinking, Bash, Thinking, Bash` shows two groups. (`chat.test.ts`)
- [x] Items that render nothing (assistant text not yet streamed, redacted thinking) do not split a run. (`chat.test.ts`)
- [x] A group starts closed. Clicking it shows the tool rows, which work as in X6 (expand for output or diff). The group stays open while more calls stream into it. (`agent-view.e2e.ts`)
- [x] The group row shows the distinct icons of its tools (up to 4) and a status mark: a spinner while any call runs, otherwise the red mark of an error or a denial. No mark when every call succeeded. (`chat.test.ts` for the status)
- [x] Thinking is a row like a tool call: a brain icon, `Thinking`, and the thought on one line (whitespace collapsed, truncated to the width). Clicking it shows the full thought. While streaming it shows the `Thinking…` shimmer, as before. (`chat.test.ts` for the preview, `agent-view.e2e.ts`)
- [x] A shell call's row shows only the first line of its command, truncated to the width. Opening the row shows the whole command, every line wrapped, as `$ <command>` above the output. A running call with no output yet can be opened too. (`chat.test.ts` for `toolCommand`, `agent-view.e2e.ts`)
- [x] With **Expanded**, every tool call has its own row as in X6. Thinking keeps its row in both modes. (`chat.test.ts`, `agent-view.e2e.ts`)
- [x] The setting defaults to Collapsed, also for users with settings saved by an older version. It applies to open conversations immediately.

## UI

    ⌄ 2 tool calls  >_                      ← group row, open
        >_ Bash  cd /tmp && curl …     ✓
        >_ Bash  rm -f jar3; curl …    ✓
    🧠 Thinking  That "no connections enabled" error on …
    Found the error, and it's a one-setting fix. …

Settings › Agents, under the default permission mode:

    Tool calls in the conversation
    [Collapsed · one row per run of calls ▾]

## Protocol and RPCs

None. Grouping happens in the app from the existing `ChatItem`s.

## Data and config

`moonlet.settings` in localStorage gains `toolCalls: "collapsed" | "expanded"`. A missing value means `collapsed`.

## Security considerations

None new. Tool output and thinking are still rendered as plain text, as in X6.

## Out of scope

- A message count in the group label (the agent's text is never folded, so there is nothing to count).
- Remembering which groups were opened across reloads or app restarts.
- Folding a whole turn into one row.

## Test plan

- Unit (`apps/desktop/src/lib/chat.test.ts`): `chatBlocks` for both views, `toolGroupLabel`, `toolGroupStatus`, `thinkingPreview`, `toolCommand`.
- E2E (`apps/desktop/e2e/specs/agent-view.e2e.ts`): a fake `claude` replays a turn with thinking, two `Bash` calls and an answer. The first command has two lines. The spec checks the collapsed group, opening it, the whole command in an opened row, the thinking row, and the Expanded setting.

## Open questions

- None.
