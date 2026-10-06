# X22 — An agent opens a session in another project

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** A6 (CLI and socket API), X5 (workspaces, projects and sessions)
- **Related ADRs:** [0005](../adr/0005-workspace-project-session-terminal.md)

## Summary

An agent working in one project sometimes needs a change in another project. Until now it did that work in the background, in a checkout it found on disk, and the user only saw the resulting PR. X22 lets the agent hand the work to a proper jaunt session instead: `jaunt session new <project> "<prompt>"` creates a worktree and branch in that project and starts an agent there with the prompt, exactly like the composer does. The new session shows up in the sidebar, marked with the session that started it, and the user can take it over. The parent agent can also follow it with `jaunt session wait`, `read` and `send`. A `jaunt` skill, installed with the hooks, teaches Claude Code and Codex when and how to do this.

## User journey

1. The user works with an agent in session "Add billing export" of project `api`. The agent finds it needs a new endpoint in project `web`.
2. The agent runs `"$JAUNT_BIN" project ls` and sees `web`.
3. It runs `"$JAUNT_BIN" session new web "Add a download button for the billing export (api PR #12)"`. The command prints the new session as JSON.
4. jaunt shows a toast "Add billing export started Add a download button… in web" with **Go to**. The user's focus does not move. In the sidebar, the new session's row says "from Add billing export".
5. The new session's agent works in its own worktree. Approvals it asks for go to the user, like any other session.
6. The parent agent runs `"$JAUNT_BIN" session wait <id>` and then `"$JAUNT_BIN" session read <id>` to get the reply, and continues. Or the user opens the new session and drives it themselves.

## Behaviour and acceptance criteria

### Creating the session (`session.create`, `jaunt session new`)

- [x] `session.create {…, spawned_by: <terminal id>}` records the parent: the new session's `spawned_by` is the id of the session that terminal belongs to. A terminal outside any session records nothing, and an unknown terminal id is rejected and creates nothing.
- [x] With `spawned_by`, the new session's permission mode defaults to the parent's current mode: the chat's mode for a structured agent, otherwise the parent session's `mode`. No mode on the parent means Manual.
- [x] With `spawned_by`, a requested mode more permissive than the parent's is rejected and nothing is created. The order is Plan < Manual < Accept edits < Auto < Bypass permissions. An equal or less permissive mode is used as asked.
- [x] Without `spawned_by` (the app's composer, scripts), modes behave as before (X7).
- [x] `jaunt session new <project> [prompt…] [--name --branch --from --agent --model --effort --mode]` calls `session.create` with `spawned_by` from `$JAUNT_TERMINAL_ID` and prints the session as JSON (`id`, `name`, `project_id`, `branch`, `path`, `terminals`, `spawned_by`, …).
- [x] `<project>` matches a project id, then a path (`~` expanded, trailing `/` ignored), then a name, case-insensitively. No match or more than one name match fails with `jaunt: no project "x"; known projects: api, web` (or `… matches several projects: …`) and creates nothing. jaunt never adds a project on its own.
- [x] `jaunt project ls [--json]` lists projects: name, base branch, path.

### Following it (`jaunt session ls/wait/read/send`)

- [ ] `jaunt session ls [--json]` lists live (not archived) sessions: id, project, name, agent status, and the parent when there is one.
- [ ] `jaunt session wait <session> [--timeout <secs>]` returns once the session's agent is no longer `working`, and prints the status (`done`, `idle`, `blocked` or `error`). It exits 1 with `jaunt: timed out …` when the timeout passes first (default 30 minutes).
- [ ] `jaunt session read <session>` prints the agent's last assistant message, and pending approval questions if any.
- [ ] `jaunt session send <session> <text…>` sends a message to the session's agent (as `chat.send`).
- [ ] The session's agent is its first structured agent terminal. A session without one fails with `jaunt: session "x" has no structured agent`.

### Environment and skill

- [x] Every terminal and structured agent jaunt starts gets `JAUNT_SOCK` and `JAUNT_BIN` (the `jaunt` CLI next to `jauntd`) in its environment. Structured agents get `JAUNT_TERMINAL_ID` and `JAUNT_SESSION` as before.
- [ ] `jaunt hooks install` (and the app's one-click hook install) also writes a `jaunt` skill to `~/.claude/skills/jaunt/SKILL.md` and `$CODEX_HOME/skills/jaunt/SKILL.md` (default `~/.codex`). `hooks uninstall` removes those two files, and `hooks status` reports whether each is installed.
- [ ] The skill tells the agent to act only when `$JAUNT_SOCK` is set, to use `"$JAUNT_BIN"`, to hand work in another project to a new session instead of editing that project's files, and to write a self-contained prompt (what, why, where the related work is).

### App

- [ ] When a session with a `spawned_by` appears that the app had not seen, it shows a toast "‹parent› started ‹child› in ‹project›" with **Go to**. It does not switch to the new session.
- [ ] A session with a `spawned_by` shows "from ‹parent›" in its sidebar row tooltip, archived parents included. A parent that is no longer in the list shows "from a removed session".

## UI

- **Toast:** the usual info toast, top right, with a **Go to** action that opens the new session.
- **Sidebar:** no new row elements; the row's tooltip gets a "from ‹parent›" line.

## Protocol and RPCs

- `session.create` takes an optional `spawned_by: TerminalId`.
- `Session` gets an optional `spawned_by: String` (the parent session id). Old state files load with `None`.
- No new methods: `jaunt session ls/wait/read/send` use `session.list`, `terminal.list`, `chat.state` and `chat.send`.

## Data and config

- `state.json`: `spawned_by` on sessions.
- `~/.claude/skills/jaunt/SKILL.md` and `$CODEX_HOME/skills/jaunt/SKILL.md`, written by hook install.

## Security considerations

- The socket is private to the user (S1), so only the user's own processes can create sessions; an agent could already run any command as the user.
- The mode cap stops an agent from starting a more permissive agent by accident or because a prompt asked it to. It is not a hard boundary: an agent with shell access can still call `jaunt rpc session.create` without `spawned_by`. It does not need one to get around a cap either, since it can already run `claude` itself.
- The parent cannot answer the new session's permission prompts through the CLI; they reach the user through the approval inbox (A5).
- The prompt is passed to `session.create` as JSON and to the agent through `chat.send`, never through a shell.

## Out of scope

- Reporting back automatically: the new session does not post its result into the parent's chat. The parent uses `wait` and `read`.
- Adding a project that jaunt does not know yet.
- Answering permission prompts or interrupting the agent from the CLI.
- Agents in the terminal UI (not structured): `session new` can start them (`--tui` is not exposed), but `wait`, `read` and `send` work only with structured agents.

## Test plan

- `jaunt-core` `session.rs`: `spawned_by` recorded; unknown terminal rejected; mode inherited from a parent chat; a more permissive mode rejected; no `spawned_by` unchanged; the mode order.
- `jaunt-cli` unit tests: project matching (id, path, name, none, several); picking the agent terminal of a session; the reply `read` prints; when `wait` stops.
- `jaunt-cli/tests`: `jaunt session new` against a real daemon records the parent and prints the session; a terminal sees `JAUNT_BIN` and `JAUNT_SOCK`.
- `jaunt-core` `hooks.rs`: install writes both skills, uninstall removes them, status reports them.
- `apps/desktop/src/lib/spawned.test.ts`: which sessions get a toast (new and spawned only, not on the first load), the toast text, the "from" line.

## Open questions

- None.
