# X42 — Agents view: the subagents a chat launches

- **Status:** implemented (2026-10-14). The daemon side checked against captured claude 2.1.296 output; the UI covered by e2e with a fake `claude`. Not yet looked at in the running app by a person.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2 (agent-first)
- **Related:** [X14](X14-collapsed-tool-calls.md) (tool rows), [X24](X24-plan-panel.md) (right panel tabs), [X29](X29-chat-plus-menu-and-mcp.md) (subagent definitions in the `+` menu)

## Summary

When Claude splits work across subagents (its `Agent` tool, formerly `Task`), moonlet shows one collapsed tool row per launch. It drops everything the subagents do afterwards, and when a subagent asks for permission, the card does not say which subagent is asking. X42 keeps each subagent's progress in the daemon. The UI then shows it in four places: an **Agents** tab in the right panel with a detail view per agent, a strip above the chat input, a "N agents" chip on the session row, and cards in the conversation.

Design: `Moonlet Subagents View.html` (Claude Design bundle with five boards: the session with the Agents panel, the agent detail, the strip states, the row states and the in-conversation cards), and `Agents strip animation` (how the strip moves as agents finish). Some parts of the design have no data behind them in Claude Code, so they were left out or replaced (see Out of scope).

## User journey

1. The user asks Claude for work that Claude splits across subagents. A "Launched 3 agents" card appears in the conversation, with one row per agent, and **Show in panel** opens the Agents tab.
2. The strip above the chat input reads "3 agents · 2 running · 1 done" with one coloured dot per agent and the time since the first one started. **Agents ›** opens the tab.
3. The Agents tab lists every agent with its status, elapsed time and what it is doing now ("Running pnpm test"). The header shows the count, the elapsed time and the tokens used, plus **Stop all**.
4. One agent asks to run a command. Its row and the strip turn yellow ("1 needs you"), and the row shows "Wants to run `pnpm add …`" with **Allow** and **Deny**. The conversation's permission card is headed by the name of the agent that asks.
5. Clicking a row opens the agent's detail: its brief (the prompt Claude gave it), each tool call with `+a −r` for edits, the pending permission card, and **Stop**.
6. An agent finishes. Its row turns green, and the conversation shows "Explore the host protocol · finished" with its report. In the strip its dot turns green with a small pop, the "N done" count flashes green, and the dot hides a moment later. When all agents are done, the strip reads "✓ All 3 done", holds for a moment, then folds away; the conversation's "3 agents finished" card keeps the diff and **Review changes**.
7. An agent fails. Its row shows the error in red with **Retry**, and the strip reads "1 failed" with **Retry**. Retry asks Claude, in the chat, to run that agent again.
8. While any agent runs, the session row in the sidebar shows "N agents".

## Behaviour and acceptance criteria

Daemon (PR 1):

- [x] Claude's `system` `task_started` line adds a subagent to the chat's state: its task id, the id of the `Agent` tool call that launched it, its description, its type and its prompt, with status `running`. (`subagents_follow_task_events`)
- [x] A `task_progress` line sets the agent's activity (its `description`, such as "Running Create made.txt and echo made"), its tokens and its tool-call count. (`subagents_follow_task_events`)
- [x] A `task_notification` line ends the agent as `done` (`completed`), `failed` (`failed`) or `stopped` (`stopped`, `killed`), with the final token count and the duration. A done agent keeps the summary as its report; a failed one keeps the error from `task_updated`, else the summary. (`subagents_follow_task_events`, `a_failed_subagent_keeps_its_error`, `stopping_a_subagent_sends_stop_task`)
- [x] An `assistant` line from inside a subagent (`parent_tool_use_id` set) adds its tool calls to that agent's tool list, with name, one-line summary and `+a −r` counts for edits, and sets the agent's model. The matching `user` line marks each call `ok` or `error`. None of these lines reaches the main transcript. (`subagent_tool_calls_stay_with_their_agent`)
- [x] A `can_use_tool` request that carries an `agent_id` becomes a pending ask that names that agent. (`a_subagent_ask_names_its_agent`)
- [x] A `control_cancel_request` removes the pending ask with that id. (`stopping_a_subagent_sends_stop_task`)
- [x] When the main turn ends (`result`) while a subagent waits on an ask, that ask stays pending. (`a_subagent_ask_outlives_the_main_turn`)
- [x] `chat.stop_agent {id, agent}` sends Claude a `stop_task` control request for that task id. It fails unless that id is a running subagent of that chat; Codex chats have none. (`stopping_a_subagent_sends_stop_task`, `a_running_subagent_can_be_stopped`)
- [x] When the agent process exits, or the daemon restarts, every agent still running becomes `stopped`. (runtime test)
- [x] The chat terminal's `TerminalInfo.subagents` counts its running subagents. (runtime test)
- [x] While a subagent runs, the chat terminal's agent state is working, even after Claude's own turn ended ([X47](X47-quieter-notifications.md)).

Agents tab (PR 2):

- [x] The right panel has an **Agents** tab between Plan and Files. It shows a dot while an agent needs the user and another tab is selected, and clicking it always shows the list. With no agents it reads "No agents yet". (`agentsTabDot`, `agents.e2e.ts`)
- [x] An agent's displayed state is `needs you` while one of the chat's pending asks names it and it is still running, else `running`, `done`, `failed` or `stopped`. (`agentRows`)
- [x] Each row shows the status dot, the description and the elapsed time (`m:ss`). Its second line depends on the state: the current activity while running; "Wants to run …" with Allow and Deny when it needs the user; the error in red with Retry when it failed; "Stopped" when stopped; nothing when done. (`agentRows`, `agents.e2e.ts`)
- [x] The header reads "N agents · m:ss · 57k tokens", and **Stop all** stops every agent that runs or waits for the user. (`agentsHeader`, `stoppable`)
- [x] The detail shows the agent's state, model, elapsed time and tokens; its brief, collapsed to one line; its tool calls with `+a −r` for edits; the pending ask as a full permission card; its report once done, or its error with Retry once failed; and **Stop** while it runs. (`agents.e2e.ts`)
- [x] Retry sends the chat the message `Run the "<description>" agent again.`; for several failed agents, `Run these agents again: "<a>", "<b>".` (`retryMessage`)
- [x] An ask's row shows a command in full, wrapped, since Allow sits next to it. (`askLine`)

Strip and sidebar (PR 3):

- [x] The strip shows the agents launched since the user's last message. It is hidden when there are none, and after × until a new agent starts. (`stripView`, `stripDismissAt`)
- [x] The strip text for each state (working, one needs you, all finished, one failed, ended with some stopped) is as listed under UI. "Finished" means every agent is done. Retry asks for the batch's failed agents. (`stripView`, `stripRetry`, `agents.e2e.ts`)
- [x] The strip is the top row of the chat input's card. Its dots keep launch order. A finished agent's dot turns green and pops for 0.28 s, the "N done" count shows green for 0.9 s, and 1.2 s after the agent ended its dot shrinks away; failed and stopped dots stay. Running dots pulse. (`stripView`, `agents.e2e.ts`)
- [x] Once every agent is done the strip reads "✓ All N done" ("1 agent done" for one) with **Agents ›**, and 1.6 s after the last one ended it folds up, leaving the input. (`stripView`)
- [x] The session row shows "N agents" while N of its chats' subagents run; "needs input" still wins. (`sessionBadge`)

Conversation cards (PR 4):

- [x] Consecutive `Agent` tool calls show as one "Launched N agents" card, with a row per agent (its state and time) and **Show in panel**. A row opens that agent's detail. (`chatBlocks`, `launchedRows`, `agents.e2e.ts`)
- [x] A subagent's ask gets the same permission card as the main agent's (command, diff, Allow, Always allow, Deny), headed by the agent's name on a line of its own. The name is model-written, so line breaks and control characters in it become spaces. (`askerName`, `agents.e2e.ts`)
- [x] A finished agent's report, or a failed agent's error, shows in the conversation after the last message that shows from before it ended. Once every agent launched after the same user message has ended (two or more), "N agents finished in m:ss" follows, or "N agents ended" when any did not finish, with the agents' own diff and **Review changes**. (`agentNotes`, `notesByBlock`, `agents.e2e.ts`)

## UI

Agents tab:

    Plan  Agents●  Files  Changes  Review
    ─────────────────────────────────────────────
    5 agents · 2:14 · 156k tokens        Stop all
    ─────────────────────────────────────────────
    ● Build the Hosts section in the sidebar  1:02   ← yellow: needs you
      Wants to run pnpm add @tauri-apps/plugin-os
      [Allow] Deny
    ⋮ Draft spec R4                           0:41   ← accent: running
      Writing docs/specs/R4-unified-hosts.md
    ● Explore the host protocol               0:18   ← green: done
    ● Audit SSH key handling                  0:52   ← red: failed
      API error 529 · overloaded             Retry
    ● Benchmark reconnect latency             0:09   ← muted: stopped
      Stopped

Detail:

    ‹ Agents
    ● Build the Hosts section in the sidebar
      Needs you · Haiku 5.5 · 1:02 · 57k tokens
    › Brief · Add a Hosts section under Projects in Sidebar.tsx…
    Read  apps/desktop/src/components/Sidebar.tsx          ✓
    Edit  apps/desktop/src/components/Sidebar.tsx  +2 −1   ✓
    ┌ Allow Bash? ─────────────────────────────┐
    │ >_ pnpm add @tauri-apps/plugin-os        │
    │ [Allow] [Always allow]              Deny │
    └──────────────────────────────────────────┘
    ─────────────────────────────────────────────
                                            Stop

Strip, the top row of the chat input's card:

| State | Left | Right |
|---|---|---|
| working | `●●●●● 5 agents · 2 running · 2 done` | `1:48  Agents ›` |
| one needs you | `… · 1 running · 2 done · 1 needs you` (yellow) | `2:14  Agents ›` |
| all finished | `✓ All 5 done`, then the strip folds away after 1.6 s | `3:40  Agents ›` |
| ended, some stopped | `5 agents · 4 done · 1 stopped` | `3:40  Review changes  ×` |
| one failed | `5 agents · 4 done · 1 failed` (red) | `2:40  Retry  Agents ›` |

Dot colours: running accent (pulsing), needs you `blocked`, done `done` (then hidden), failed `error`, stopped muted. With reduced motion the strip changes without animation (`moonlet.css`; WebDriver cannot emulate the setting, so no test covers it).

## Protocol and RPCs

- `ChatState.subagents: Subagent[]` (new):
  `{id, tool_use_id, description, kind?, prompt, status: running|done|failed|stopped, started_at, ended_at?, duration_ms?, activity?, tokens, tool_uses, model?, report?, error?, tools: SubagentTool[]}`.
  `SubagentTool` is `{id, name, summary, status: running|ok|error|denied, added?, removed?}`.
- `PermissionAsk.agent?: string`: the task id of the subagent that asks.
- `TerminalInfo.subagents: number`: running subagents of a chat terminal.
- `chat.stop_agent {id, agent}` (new): sends `{"subtype":"stop_task","task_id":<agent>}`.

Captured from claude 2.1.296 (haiku, `--permission-prompt-tool stdio`, hooks off). The full runs are in `crates/moonlet-core/src/chat/fixtures/claude-subagents.jsonl` and `claude-subagent-stop.jsonl`. Subagents run in the background: the `Agent` call returns "Async agent launched successfully" at once, and the main turn's `result` can arrive before they finish. Claude then starts a new turn by itself when an agent finishes.

    {"type":"system","subtype":"task_started","task_id":"a9e80d60e7a0f792f","tool_use_id":"toolu_01NfShBYwC6foFSEmz7fW9Rw","description":"Touch a file","subagent_type":"general-purpose","is_backgrounded":true,"prompt":"Run the Bash command: …"}
    {"type":"system","subtype":"task_progress","task_id":"a9e80d60e7a0f792f","description":"Running Create made.txt and echo made","usage":{"total_tokens":9712,"tool_uses":1,"duration_ms":1617},"last_tool_name":"Bash"}
    {"type":"control_request","request_id":"b45af96a-…","request":{"subtype":"can_use_tool","tool_name":"Bash",…,"tool_use_id":"toolu_01QJw5gE4rZn9mBtLEZNTxkW","agent_id":"a9e80d60e7a0f792f"}}
    {"type":"control_cancel_request","request_id":"b45af96a-…"}                       ← after stop_task
    {"type":"system","subtype":"task_updated","task_id":"a9e80d60e7a0f792f","patch":{"status":"killed","end_time":1791970412270}}
    {"type":"system","subtype":"task_notification","task_id":"a9e80d60e7a0f792f","status":"stopped","summary":"…","usage":{…}}

## Data and config

- Subagents are part of the chat's saved state (`~/.moonlet/chats/<id>.json`), so they survive a daemon restart as history.
- An agent keeps at most its last 200 tool calls, without their output (`a_subagent_keeps_its_last_200_tool_calls`).

## Security considerations

- Descriptions, prompts, activities and reports come from the model. They are rendered as text, and reports go through the same markdown renderer as agent messages (no raw HTML).
- `chat.stop_agent` only accepts the id of a running subagent of that chat.

## Out of scope

- **Queued agents and dependencies** ("Waits for 2 agents"): Claude Code does not report them.
- **Open as tab** for an agent's full transcript: the daemon keeps only its tool calls.
- **Per-agent cost**: Claude reports tokens per agent, not dollars, so the UI shows tokens.
- Nested subagents (`spawn_depth` above 1) show as agents of the chat like any other.
- Codex, which has no subagents.

## Test plan

- Unit (Rust, `crates/moonlet-core/src/chat/claude.rs`): replay the captured fixtures through the adapter, as listed under Behaviour.
- Unit (Rust, `crates/moonlet-core/src/chat/runtime.rs`): `chat.stop_agent` and process exit with a fake `claude`.
- Unit (`apps/desktop/src/lib/subagents.test.ts`): `agentRows`, `stoppable`, `agentCount`, `askLine`, `agentsHeader`, `agentsTabDot`, `modelLabel`, `retryMessage`, `stripView`, `stripDismissAt`, `stripRetry`, `launchedRows`, `askerName`, `agentNotes`, `notesByBlock`; (`sidebar.test.ts`) `sessionBadge`; (`chat.test.ts`) the Launched card in `chatBlocks`.
- E2E (`apps/desktop/e2e/specs/agents.e2e.ts`): a fake `claude` launches two subagents. The tab, the strip (the top row of the input's card, its running dot pulsing), the session chip and the conversation cards show them. One asks and is allowed from its row. The detail shows the other's brief and tool calls, and Stop sends `stop_task`.

## Open questions

- None.
