# A6: Local CLI and socket API

- **Status:** implemented (first slice)
- **Priority / phase:** P1 · phase 3, started early because hooks need it
- **PRD refs:** A6

## Summary

`moonlet` is the scripting entry point. It talks to the daemon over the same socket and protocol as the app.

## Commands

| Command | Does |
|---|---|
| `moonlet notify --state <s> [-m msg] [--session id]` | Reports agent state. The session defaults to `$MOONLET_SESSION_ID`. |
| `moonlet hook claude\|codex [payload]` | Entry point for agent hooks (see [A1](A1-agent-state.md)). |
| `moonlet hooks install\|status\|uninstall` | Manages hooks (see [A2](A2-hook-install.md)). |
| `moonlet ls [--json]` | Lists sessions. |
| `moonlet pane run <id> <cmd…>` | Types a command into a pane and presses Enter. |
| `moonlet agent start [--agent claude] [--cwd dir] [prompt…]` | Starts an agent session through the login shell and prints its id. |
| `moonlet project ls [--json]` | Lists projects (see [X22](X22-agent-opens-session.md)). |
| `moonlet session new <project> [prompt…]` | Creates a session in a project and starts its agent with the prompt (see [X22](X22-agent-opens-session.md)). |
| `moonlet session ls\|wait\|read\|send` | Lists sessions, waits for a session's agent, prints its last reply, sends it a message (see [X22](X22-agent-opens-session.md)). |

## Behaviour and acceptance criteria

- [x] The socket comes from `--socket`, then `$MOONLET_SOCK`, then `~/.moonlet/run/moonletd.sock`.
- [x] Errors print `moonlet: <message>` and exit 1. `hook` never fails.
- [ ] `moonlet agent start --workspace` once workspaces exist ([A4](A4-new-workspace.md)).

### Local callers (security audit, 2026-11-15)

Every process of the user can connect to the daemon's socket, and `hello` names whatever client the caller likes. So a local connection is one of these, decided when it connects and never from that name alone: this Mac's app, which proved it is the app ([X75](X75-sign-ins-open-where-you-are.md): its credential and its kernel-checked executable); a paired phone another Mac routes here over SSH ([X40](X40-mobile-app.md)), which `moonletd proxy`, run as an SSH session's command, vouches for as it does for the app; or an unproven local caller: the `moonlet` CLI an agent or the user runs, the hooks, `moonletd`'s own commands, a script, anything else. The client name is still used for display and for refusing more, never to allow.

- [x] An unproven local caller may call only what the CLI's commands, the hooks and `moonletd`'s own commands send, and this host's lists that scripts read with `moonlet rpc` (the user's choice, 2026-11-17): `daemon.info`, `daemon.shutdown`, `daemon.hand_over` (X113, which checks its caller itself: see below), `agent.report`, `browser.open`, `project.list`, `session.list`, `session.create`, `chat.send`, `chat.state`, `terminal.list`, `terminal.create`, `terminal.write`, `terminal.read_list`, `terminal.read`, `session.processes`, `session.kill_processes`, `exec.run`, `exec.route`, `exec.cancel`, `cloud.machines`, `cloud.up`, `cloud.down`, the `design.*` calls of `moonlet design` (`design.systems`, `design.system.create`, `.sync`, `.synced`, `.progress`, `.remove`, `design.list`, `design.create`, `design.open`, `design.check`, `design.snap`, `design.remove`), the `artifact.*` calls of `moonlet artifact` (`artifact.list`, `artifact.search`, `artifact.read`, and `artifact.attach` for the caller's own session, named by its terminal, X114), `workspace.list`, `repo.list`, `project.identity`, `worker.list` and `sync.list`. Anything else, a method added later included, answers `forbidden: only the moonlet app does that`, whatever client name it gave: among them `session.forward`, `session.attach`, `session.continue_here`, `terminal.attach` and `daemon.upgrade`. (`daemon.rs` › `a_local_connection_that_proves_nothing_reaches_only_what_the_cli_does`; `central_copies.rs` › `a_local_process_that_proves_nothing_reaches_no_members_session`)
- [x] An unproven local caller hears no event, another member's `session.event` included: what the CLI waits for, such as `exec.exited` and a routed command's output, comes on its own connection. (same tests)
- [x] It may still type into this host's terminals: `moonlet pane run` (`terminal.write`) and Input frames (the user's choice, 2026-11-17). Input for another member's terminal is relayed only after `session.attach`, which needs the app. (`daemon.rs` › `a_local_connection_that_proves_nothing_reaches_only_what_the_cli_does`)
- [x] Frames only a member's daemon sends (Pack, RunOutput, a relayed terminal's Output) and `exec.cancel` for a member's run are a worker's only over the tailnet, never on the local socket, whatever client name it gives. (`daemon.rs` › `a_local_connection_named_as_a_worker_sends_no_pack`)
- [x] Rules stricter than this stay: a worker's name is still refused a session's processes, though the CLI may list them (`daemon.rs` › `a_workers_link_neither_lists_nor_stops_a_sessions_processes`); a phone still never manages phones (`mobile.rs` › `phones_and_agents_cannot_manage_phones`); `moonlet rpc` still neither answers nor reads a read request (`terminal_read_e2e.rs` › `the_agent_cannot_answer_or_peek_through_moonlet_rpc`).
- [x] A routed phone keeps what it had: it is not an unproven local caller, and it is not the host's app either (`forbidden: only the moonlet app manages sign-ins`), while the Mac still answers for it the requests that would manage the host (X40), and the host itself refuses it `daemon.shutdown` and `daemon.upgrade`, as any paired device. The Mac sends a routed device's `hello` as a phone's whatever name it gives, so a phone cannot pass for the host's app. The same `hello` from a proxy no SSH login started proves nothing. (`proxy.rs` › `a_phone_routed_over_ssh_reaches_the_host_but_is_not_its_app`; `mobile.rs` › `a_phone_reaches_an_ssh_host_through_the_mac`)
- [x] The CLI's own commands still work, each through the real `moonlet` binary: `session new|ls|wait|read|send`, `ps` and `kill` (`crates/moonlet-cli/tests/session_e2e.rs`), `term ls|read` and `moonlet rpc` (`terminal_read_e2e.rs`), `exec` and the hook (`exec.rs`, `hook_e2e.rs`), `design …` (`design_e2e.rs`), `worker up|ls|down` (`worker.rs`).

## Implementation notes

- `LOCAL_METHODS` in `crates/moonletd/src/daemon.rs` is the allowlist, checked at the top of `Daemon::handle` next to the cloud machine's (`CLOUD_METHODS`, #652) and the worker link's (`WORKER_LINK_METHODS`, #668). A method a `moonlet` command newly sends must be added there, or the CLI gets `forbidden`.
- `server.rs` refuses `terminal.attach` (answered inline, outside `handle`) and drops every broadcast event for an unproven local connection; worker-only frames need `client == moonletd-worker` on a tailnet connection.
- A routed phone: `moonletd proxy` adds the host's credential to a `hello` from `moonlet-mobile` as it does to one from `moonlet-app`, only when it runs as an SSH session's command; the daemon's proof (X75) then marks the connection `routed_phone` instead of `app` (`Conn::routed_phone`). The name only takes rights away here: without the proof the connection is an unproven local caller.
- Tests' own clients connect as the app: `Client::connect_app` with the daemon started with `MOONLET_TEST_APP_EXE` naming the test binary. The e2e harness's `rpc()` and `socketRpc()` (`apps/desktop/e2e/fixtures.ts`) send the app credential from a Node process, and the world's environment sets `MOONLET_TEST_APP_EXE` to that Node.
- Nothing outside tests called `daemon.upgrade`: `moonletd upgrade` (run by the app, by `moonletd restart` and `start`, by the SSH helper `moonletd proxy`, and by the user) writes `upgrade.json` beside the socket and sends the daemon SIGUSR2 (S3).

## Security considerations

The socket is protected as described in [S1](S1-daemon-owned-sessions.md). There is no network exposure.

What an unproven local caller can still do, and why:

- `moonletd upgrade` replaces the daemon's binary through SIGUSR2 and `upgrade.json`, which any process of the user can send and write. A command line tool the user runs cannot be told from one an agent runs, so this path stays open: closing it would break live upgrades from the installer and the terminal.
- `daemon.shutdown` stays open (`moonletd stop`, and the e2e harness); any process of the user can also signal the daemon.
- `daemon.hand_over` (X113) is reached by the daemon a login starts, which proves nothing to the allowlist: a launchd job is not the app. Its handler answers only a daemon started at system start, and only a local process running the daemon's own executable that sends the app credential; the terminals then go only to that process, after a one-time secret (X113 › Login takes over).
- It may type into this host's terminals by id and send messages to this host's chats (`moonlet pane run`, `moonlet session send`), start sessions and cloud machines, and remove designs and design systems, as the CLI's commands do.
- The app's credential file is readable by any process of the user; the kernel check of the executable is what proves the app (X75), so a process that reads it is still not the app.
- The daemon reads the test seam `MOONLET_TEST_APP_EXE` (X75) in every build. A process that may stop the daemon (`daemon.shutdown`, or a signal) and start it again with that variable naming its own executable is the app to that daemon. Out of scope here; it needs the seam limited to test builds.
- The app over SSH and a routed phone count as proven only when `moonletd proxy` runs under OpenSSH's `sshd` (X75). On a host whose SSH server is something else, they were refused only the app's own methods before; now they reach only what the CLI does. It is named here so it is not mistaken for a bug.
