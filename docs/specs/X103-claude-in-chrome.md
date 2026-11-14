# X103 — Claude in Chrome

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** agent sessions (X6 structured chats, A4 terminal agents)
- **Related ADRs:** none

## Summary

Claude Code reaches the user's Chrome (the Claude in Chrome extension) only when it is started with `--chrome`. Claude's own "enabled by default" setting (`claudeInChromeDefaultEnabled` in `~/.claude.json`) does not apply to headless `claude -p`, which is how moonlet runs chat sessions, so a moonlet session never had the `mcp__claude-in-chrome__*` tools. X103 adds a **Claude in Chrome** switch to Settings › Agents. When it is on, every Claude the host starts gets `--chrome`: chat sessions, design agents and the built-in `claude` agent in a terminal tab.

## User journey

1. The user installs the Claude in Chrome extension and signs in, as Claude Code's docs describe.
2. In Settings › Agents › Browser they turn on **Claude in Chrome**.
3. The next Claude they start, in a new session or when a stopped chat starts again with its next message, can drive Chrome.

## Behaviour and acceptance criteria

- [x] The setting is the host's: its daemon keeps it in `~/.moonlet/claude.toml` as `chrome = true|false`. A missing file, a missing key or a file that does not parse means off. (`chrome_is_off_without_a_file_or_with_one_that_does_not_parse`, `turning_chrome_on_is_saved_in_claude_toml`, `an_update_of_the_wrong_type_is_refused_and_not_saved`)
- [x] `claude.settings` returns the setting; `claude.set_settings` changes some of it, saves it and tells every client with `claude.settings_changed`. (`moonletd/tests/daemon.rs` `claude_in_chrome_is_kept_by_the_daemon_in_claude_toml`)
- [x] With the switch on, a chat's Claude starts with `--chrome`; with it off, without. It is read at each start, so a chat started before the change gets it the next time its Claude starts. (`session.rs` `a_chats_claude_starts_with_chrome_when_the_host_says_so`)
- [x] With the switch on, the built-in `claude` agent of a terminal tab runs as `claude --chrome`. A project's own `[agents]` commands run as written. (`session.rs` `the_built_in_claude_gets_chrome_and_a_projects_own_agents_do_not`)
- [x] A chat's **Open in terminal** resumes its conversation in a Claude TUI with `--chrome` when the switch is on. (`agents.test.ts` "resumes Claude's conversation in the footer's mode, with --chrome when the host's switch is on")
- [x] Settings › Agents shows the switch, and turning it on reaches the daemon. (`claude-in-chrome.e2e.ts` "is off until turned on, and the daemon keeps it", "shows the daemon's setting when Settings opens again")
- [x] Settings search finds the switch by "chrome" and "browser". (`settingsSearch.test.ts` "finds Claude in Chrome by chrome and browser (X103)")
- [x] Forwarded calls from another member cannot read or change it: the forwarding scope refuses methods it does not list, and a regression check names these two. (`session_copies.rs` `a_request_passed_on_reaches_only_its_sessions_chats_and_worktree`)

## UI

Settings › Agents gets a **Browser** section with one switch row:

- **Claude in Chrome** — "New Claude sessions on this Mac start with --chrome and can use the Claude in Chrome extension. Running ones get it when they next start."

The row shows this Mac's setting, read when the page opens. Until the daemon answers, or when it cannot (a daemon too old to know the setting), the switch is disabled.

## Protocol and RPCs

- `claude.settings` `{}` → `ClaudeSettings` `{ chrome: bool }`.
- `claude.set_settings` partial `ClaudeSettings` → the whole, as saved.
- Event `claude.settings_changed` with the whole `ClaudeSettings`.

## Data and config

`~/.moonlet/claude.toml`, beside `git.toml` (X55):

```toml
chrome = true
```

## Security considerations

The flag gives Claude the user's own browser with their sign-ins. It is off by default and only the user turns it on, on that host. Claude's own Chrome permission prompts still apply. Forwarded calls from other members are refused, the same as Git settings.

## Out of scope

- A per-project override. Chrome runs on the machine, so the switch belongs to the host.
- Changing a remote host's switch from this Mac's Settings. Each host keeps its own file.
- Codex.
- Asides (X49): they run with no tools, so they get no `--chrome`.

## Test plan

- Unit (`moonlet-core`): `claude_settings` load and update; chat and terminal command lines with the switch on and off, read from the fake `claude`'s recorded arguments.
- Daemon e2e: the RPCs, the file and the event.
- Vitest: settings search.
- App e2e: the switch reaches the daemon.

## Open questions

- None.
