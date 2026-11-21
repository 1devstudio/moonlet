# X110 — Slash commands in the new-session composer

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** agent sessions (X54 new-session composer, X29 chat `+` menu)
- **Related ADRs:** none

## Summary

A session's chat offers the agent's slash commands: typing `/` opens a menu of them, and the `+` menu has **Slash commands ›** (X29). The new-session composer offered neither, because no agent runs there yet to ask. X110 gives the composer the same two ways in for Claude. The list is what a Claude started in the project would offer, put together without starting one there: the user's, the plugins' and the built-in commands come from a Claude started in the profile's home folder only to answer `initialize`, as X105 does for the models; the project's own `.claude/commands` and `.claude/skills` are read from its folder. A Claude started in the project folder would run the project's hooks and could start its MCP servers, so opening the composer on a cloned repo would run that repo's code before the user starts anything.

## User journey

1. The user opens a new session on project `shop`, with Claude picked.
2. They type `/re`. A menu opens under the prompt with `/review`, the project's own `/release-notes` and `/security-review`, best match first.
3. They press ↓ and ↵. The prompt becomes `/release-notes `, and they type the rest: `/release-notes for v2`.
4. Create starts the session; its first message is `/release-notes for v2`, so Claude runs the command.
5. Instead of typing, they can open `+` › **Slash commands ›** and pick a command, which puts `/<name> ` at the start of the prompt.
6. With Codex or Terminal only picked, `/` opens no menu and `+` has the file items only.

## Behaviour and acceptance criteria

- [x] `claude.commands {project_id, workspace?}` answers the slash commands of that workspace's Claude profile, from a Claude started in the profile's home folder only to answer `initialize`, then the project's own, read from its folder. No Claude starts in the project's folder, so none of its hooks or MCP servers run. The same start answers `claude.models`, and a second ask within minutes starts no Claude. (`moonletd/tests/daemon.rs` `claude_commands_list_the_projects_own_without_starting_claude_in_it`)
- [x] A project's own commands are named as Claude Code 2.1.330 names them: a skill in `.claude/skills/<folder>/SKILL.md` by its front matter's `name`, else its folder; a command in `.claude/commands/` by its path without `.md`, folders joined by `:` (`sub/nested-cmd.md` is `sub:nested-cmd`); other files are not commands. (`claude.rs` `a_projects_own_commands_are_named_as_claude_code_names_them`)
- [x] An unknown project is refused; a Claude that ends without answering gives an empty list, not an error. (`moonletd/tests/daemon.rs` `claude_commands_are_empty_when_claude_does_not_answer`)
- [x] Typing `/` at the start of a word in the composer's prompt, with Claude picked, lists the commands that match, as the chat's `/` menu does. With another agent picked, no menu. (`composer.test.ts` "offers Claude's slash commands while a / word is typed", "offers nothing for another agent, outside a / word, or once dismissed")
- [x] ↑/↓ move the highlight round the ends, ↵ or Tab puts in the highlighted command, Escape closes the menu; Shift+↵ and other keys are the prompt's. (`composer.test.ts` "moves the highlight with the arrows, round the ends", "puts in the highlighted command on Tab or Enter, and closes on Escape", "leaves other keys, Shift+Enter and a closed menu to the prompt")
- [x] Escape closes the menu but not the composer, and an edit opens the menu again. (`slash-commands-in-new-session.e2e.ts` "lists the project's own command for a typed / and sends it as the first message")
- [x] The composer's `+` menu has **Slash commands ›** after the file items while Claude is picked; picking one puts `/<name> ` at the start of the prompt. (`plusMenu.test.ts` "offers slash commands in the composer only for Claude (X110)"; `slash-commands-in-new-session.e2e.ts` "puts a command from + › Slash commands at the start of the prompt")
- [x] Attachments (a task, a PR, a design) keep coming first in the first message; a command typed in the prompt then follows them. (unchanged; `composer.test.ts` "sends the attachments, then what the user typed, a blank line apart; nothing when there is neither")
- [x] Create sends the chosen command as the session's first message. (`slash-commands-in-new-session.e2e.ts` "lists the project's own command for a typed / and sends it as the first message")

## UI

```
┌ shop ▾ · New branch ──────────────────────────────┐
│ /re                                                │
│ ┌──────────────────────┐                           │
│ │ /review              │                           │
│ │ /release-notes       │                           │
│ │ /security-review     │                           │
│ └──────────────────────┘                           │
│ Opus 5.5 · High   Auto                 +  Create ↵ │
└────────────────────────────────────────────────────┘
```

The menu looks and behaves as the chat's `/` menu. Until the list arrives the menu is empty and stays closed; `+` › Slash commands says `No commands`.

## Protocol and RPCs

- `claude.commands` `{ project_id: string, workspace?: string }` → `string[]`, each a command's name without the `/`: the profile's, then the project's own that are not among them. Refused for calls forwarded from another member (X68), from a phone (X40) and from unproven local callers, as every method not on those lists is.

## Data and config

The daemon keeps each Claude profile's list in memory for 5 minutes, so opening the composer again does not start Claude again, while a command or skill added since shows within minutes. An empty answer, as from a Claude that is not signed in, is kept for 1 minute, as X105 does for the models. The probe that gives the list gives the profile's models too, and the other way round, so one Claude start serves both. A project's own commands are read from its folder on each ask. Nothing is written to disk. Probes share X105's one-at-a-time lock, timeout and process-group kill.

## Security considerations

No Claude is started in the project's folder. Claude Code 2.1.330, started there only to answer `initialize`, ran the project's `SessionStart` hook and, with `enableAllProjectMcpServers` in the project's settings, its `.mcp.json` server (checked by hand on 2026-11-21), so a probe there would run a cloned repo's code when the composer opens. `--setting-sources user --strict-mcp-config` stops both but also drops the project's commands. So the probe runs in the profile's home folder, as X105's does, with the user's own settings, and the project's commands are only read as files. Only a project the host already has can be named, by its id. The project's folder is read, not written; nothing in it is run. Its files are untrusted: only regular files are read (a FIFO or device is skipped, not waited on), at most 8 KiB of each, the scan stops at 8 folders deep and 1,000 entries, a link to a folder is not followed, and the scan runs off the daemon's async threads. (`claude.rs` `a_skill_file_that_is_not_a_regular_file_is_skipped`)

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
