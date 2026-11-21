# X110 — Slash commands in the new-session composer

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** agent sessions (X54 new-session composer, X29 chat `+` menu)
- **Related ADRs:** none

## Summary

A session's chat offers the agent's slash commands: typing `/` opens a menu of them, and the `+` menu has **Slash commands ›** (X29). The new-session composer offered neither, because no agent runs there yet to ask. X110 gives the composer the same two ways in for Claude. The daemon starts a Claude in the picked project's folder only to answer `initialize`, as X105 does for the models, and its reply lists every command and skill that Claude would offer: the user's and plugins', the built-in ones, and the project's own `.claude/commands` and `.claude/skills`.

## User journey

1. The user opens a new session on project `shop`, with Claude picked.
2. They type `/rev`. A menu opens under the prompt with `/review`, `/security-review` and the project's own `/release-notes`, best match first.
3. They press ↵. The prompt becomes `/review `, and they type the rest: `/review the cart changes`.
4. Create starts the session; its first message is `/review the cart changes`, so Claude runs the command.
5. Instead of typing, they can open `+` › **Slash commands ›** and pick a command, which puts `/<name> ` at the start of the prompt.
6. With Codex or Terminal only picked, `/` opens no menu and `+` has the file items only.

## Behaviour and acceptance criteria

- [x] `claude.commands {project_id, workspace?}` answers the slash commands Claude Code offers in that project's folder and that workspace's Claude profile, from its answer to `initialize`. No message is sent and no conversation is made. (`moonletd/tests/daemon.rs` `claude_commands_come_from_a_claude_started_in_the_project`)
- [x] An unknown project is refused; a Claude that ends without answering gives an empty list, not an error. (`moonletd/tests/daemon.rs` `claude_commands_are_empty_when_claude_does_not_answer`)
- [x] Typing `/` at the start of a word in the composer's prompt, with Claude picked, lists the commands that match, as the chat's `/` menu does; ↵ or Tab puts in the highlighted one; Escape closes the menu. With another agent picked, no menu. (`composer.test.ts` "offers Claude's slash commands while a / word is typed")
- [x] The composer's `+` menu has **Slash commands ›** after the file items while Claude is picked; picking one puts `/<name> ` at the start of the prompt. (`plusMenu.test.ts` "offers slash commands in the composer only for Claude")
- [x] Attachments (a task, a PR, a design) keep coming first in the first message; a command typed in the prompt then follows them. (unchanged; `composer.test.ts` firstMessage tests)
- [x] The composer offers the project's own commands and the user's, and the first message starts with the chosen command. (`slash-commands-in-new-session.e2e.ts`)

## UI

```
┌ shop ▾ · New branch ──────────────────────────────┐
│ /rev                                               │
│ ┌──────────────────────┐                           │
│ │ /review              │                           │
│ │ /security-review     │                           │
│ │ /release-notes       │                           │
│ └──────────────────────┘                           │
│ Opus 5.5 · High   Auto                 +  Create ↵ │
└────────────────────────────────────────────────────┘
```

The menu looks and behaves as the chat's `/` menu. Until the list arrives the menu is empty and stays closed; `+` › Slash commands says `No commands`.

## Protocol and RPCs

- `claude.commands` `{ project_id: string, workspace?: string }` → `string[]`, each a command's name without the `/`. Refused for calls forwarded from another member (X68), from a phone (X40) and from unproven local callers, as every method not on those lists is.

## Data and config

The daemon keeps each (profile, project folder) list in memory for 5 minutes, so opening the composer again does not start Claude again, while a command or skill added since shows within minutes. An empty answer, as from a Claude that is not signed in, is kept for 1 minute, as X105 does for the models. Nothing is written to disk. Probes share X105's one-at-a-time lock, timeout and process-group kill.

## Security considerations

The daemon starts Claude only in a project the host already has, picked by its id: a caller cannot name any other folder. The probe runs the user's own `claude` with the workspace's environment and sends nothing but `initialize`. A project's own MCP servers may start while Claude answers; the whole process group is killed when the answer arrives.

## Out of scope

- Codex's commands, and the phone's new-session screen.
- Showing a command's description or argument hint in the menu (the chat's menu shows names only).
- Moving a typed command ahead of the attachments: with a task or PR attached, the first message starts with the attachment (user decision, 2026-11-21).

## Test plan

- Daemon e2e: `claude.commands` with a fake `claude` that lists a command only when started in the project's folder; an unknown project; a Claude that does not answer.
- Vitest: the composer's `/` menu by agent, token and dismissal; the `+` menu's composer entries.
- App e2e: a fake `claude` answering `initialize` with a project command; the composer's `/` menu lists it and Create sends it as the first message.

## Open questions

- None.
