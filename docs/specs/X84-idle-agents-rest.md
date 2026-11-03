# X84 — Idle agents rest

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** S1 daemon-owned sessions, S4 restore after restart
- **Related ADRs:** none

## Summary

A chat starts its agent as soon as it is created, so the agent is warm when
the first message comes, and keeps it until the chat is stopped or removed
or the daemon exits. On one Mac 19 idle `claude` processes, about 2.3 GB,
stayed alive for days in chats nobody had written to. An agent that has been
idle for a day is now stopped. Its conversation stays: the next message
starts the agent again with `--resume`, as after a daemon restart. This is
one of the later parts of X79.

## User journey

1. The user leaves a chat after the agent answers and does not come back to
   it for a day. Its `claude` process ends; the chat says it is resting.
2. The user writes to it again. The agent starts with the same conversation
   and answers as before.
3. A dev server the agent started keeps running while the agent rests, and
   stops when the user stops the chat.

## Behaviour and acceptance criteria

- [x] A chat agent idle for 24 hours is stopped (SIGTERM to its process
      group, SIGKILL 3 s later). Idle means no turn running (status neither
      working nor blocked), nothing waiting for the user (no asks or
      approvals, no queued messages) and no running subagents. The chat
      keeps its conversation and shows the note "Resting after a day without
      messages; the next message wakes it"
      (`an_idle_agent_rests_and_the_next_message_resumes_it`).
- [x] A busy agent does not rest: one whose turn runs, one waiting for the
      user's answer, one with a message still queued for it, and one with a
      subagent still running
      (`a_working_agent_does_not_rest`,
      `an_agent_waiting_for_an_answer_does_not_rest`,
      `an_agent_with_a_queued_message_does_not_rest`,
      `an_agent_with_a_running_subagent_does_not_rest`).
- [x] An agent frozen while the Mac sleeps or its session moves (X73) does
      not rest: a stopped process cannot exit on SIGTERM. Once it thaws it
      rests at the next look if it is still idle
      (`an_agent_frozen_while_the_mac_sleeps_rests_only_once_it_thaws`).
- [x] Idle time counts from the last activity: a message sent, an answer to
      an ask, anything the agent says. A chat written to more often than the
      timeout keeps its agent, which rests once the messages stop
      (`an_agent_kept_busy_with_messages_does_not_rest`). Nothing else
      counts: not new settings, which apply from the next message, nor the
      notes and state the daemon changes itself, the resting note among them
      (`new_settings_do_not_keep_an_idle_agent_awake`).
- [x] The next message starts the agent with `--resume` and the chat's
      agent session, as after a daemon restart
      (`an_idle_agent_rests_and_the_next_message_resumes_it`).
- [x] Processes the agent left running (a dev server in a process group of
      its own) are not ended by resting. They stay with the chat: the next
      agent takes them on, and they end when the chat is stopped or that
      agent exits, or the daemon stops, as after a settings restart (X79)
      (`a_resting_agents_server_keeps_running_and_ends_when_the_chat_stops`,
      `a_resting_agents_server_ends_with_the_agent_that_resumes`,
      `the_daemon_stops_only_once_a_resting_agents_server_is_gone`).
- [x] While the agent rests, what it left running stays in the leftovers
      record (X79), so a daemon that crashes meanwhile leaves it to the next
      one to end (`what_a_resting_agent_left_stays_recorded`).

## UI

No new UI. A resting chat looks like a chat restored after a daemon restart:
its tab has no process, and its last item is the system note above.

## Protocol and RPCs

None.

## Data and config

The timeout is 24 hours. Tests set it in milliseconds with
`MOONLET_TEST_AGENT_REST_MS`, read by the daemon once at start
(`a_daemon_rests_an_idle_chat_agent_after_the_time_it_was_given`). Nothing
is persisted: after a daemon restart no agent runs until the next message.

## Security considerations

Resting signals only the agent's own process group, the same as stopping a
chat. Processes the agent left running are signalled later only by the pid
and start time noted for them (X79).

## Out of scope

- A setting for the timeout.
- Resting agents of terminal (non-chat) agent tabs.
- Idle time counts wall-clock time, sleep included: a Mac that wakes after
  a day rests its idle agents within seconds.

## Test plan

- Rust, `chat/runtime.rs`, with the fake `claude` and a timeout of a few
  hundred milliseconds:
  `an_idle_agent_rests_and_the_next_message_resumes_it`,
  `a_working_agent_does_not_rest`,
  `an_agent_waiting_for_an_answer_does_not_rest`,
  `an_agent_with_a_queued_message_does_not_rest`,
  `an_agent_with_a_running_subagent_does_not_rest`,
  `an_agent_frozen_while_the_mac_sleeps_rests_only_once_it_thaws`,
  `an_agent_kept_busy_with_messages_does_not_rest`,
  `new_settings_do_not_keep_an_idle_agent_awake`,
  `a_resting_agents_server_keeps_running_and_ends_when_the_chat_stops`,
  `a_resting_agents_server_ends_with_the_agent_that_resumes`,
  `the_daemon_stops_only_once_a_resting_agents_server_is_gone` and
  `what_a_resting_agent_left_stays_recorded`.
- Rust, `moonletd/tests/daemon.rs`, a daemon started with
  `MOONLET_TEST_AGENT_REST_MS`:
  `a_daemon_rests_an_idle_chat_agent_after_the_time_it_was_given`.

## Open questions

- None.
