# X33: A Claude Code profile per workspace

- **Status:** implemented (sign-in with a real second account unchecked)
- **Priority / phase:** P1 · phase 3
- **Related:** [X32](X32-workspaces-and-sections.md) (workspaces), [A2](A2-hook-install.md) (hooks), [X6](X6-structured-agent-view.md) (structured agent view), [glossary](../../CONTEXT.md).
- **References:** user request of 2026-10-09. A client pays for one Claude subscription for work; the user's own subscription covers private projects. Both are used on the same Mac, and each workspace must keep the right one. The design "Workspaces & Sections" (2026-10-11) shows the profile in the New workspace dialog and in the sidebar footer.

## Summary

A **Claude profile** is a Claude Code config folder: its own login, settings, MCP servers, plugins, skills, memory and conversation history. moonlet points Claude Code at a profile with `CLAUDE_CONFIG_DIR`. Every workspace (X32) uses the **default profile** (`~/.claude`, the variable unset) unless the user picks another one for it. Every Claude process started for a session, whether a TUI tab or the structured view, uses the profile of the session's workspace. So "Acme" can run on the client's subscription and "Personal" on the user's own, with no logging out and in.

Checked on Claude Code 2.1.292: with `CLAUDE_CONFIG_DIR` pointing at an empty folder, `claude auth status --json` reports `"loggedIn": false` while the default profile is signed in. So the login is kept per folder, and `.claude.json` (MCP servers) and `projects/` (transcripts) move into that folder too.

## User journey

1. In **New workspace** or **Workspace settings…** (X32), the **Claude profile** select lists **Default — ~/.claude**, every profile moonlet knows (for example "Work profile — ~/.claude-work"), and **New profile…**.
2. **New profile…** asks for a name ("Work profile") and a folder: either a new `~/.claude-<slug>` (default), or an existing folder the user already uses with `CLAUDE_CONFIG_DIR`. moonlet creates the folder if needed and installs its hooks and skill into it.
3. The new profile is not signed in yet, so moonlet offers **Sign in…**. It opens a terminal running `claude auth login` with that profile's `CLAUDE_CONFIG_DIR`. The user finishes the browser login, and the profile then shows its account (for example `jane@acme.com`).
4. The sidebar footer shows "Claude · Work profile" for the current workspace. Hovering it shows the account and the folder.
5. Every new session in that workspace starts Claude signed in to the client's account. Sessions in "Personal" keep using `~/.claude`.

## Behaviour and acceptance criteria

### Profiles

- [x] `profile.create {name, path?}` creates a profile. Without `path`, the folder is `~/.claude-<slug>`, made unique. The folder is created with mode 0700 when missing. An existing folder is used as-is. Tests: `a_workspaces_profile_reaches_its_sessions_terminals` (folder and mode), `claude_profiles_over_rpc`; the folder rules in `profiles.rs` (`a_new_profile_gets_a_claude_folder_named_after_it`, `an_existing_folder_can_be_used_with_a_home_relative_path`).
- [x] Creating a profile installs moonlet's Claude hooks and the `moonlet` skill into that folder's `settings.json` and `skills/moonlet/SKILL.md`, the same way A2 does for `~/.claude`. A profile whose hooks cannot be installed is not kept. Starting the daemon refreshes an outdated skill in every profile's folder, as it does for `~/.claude`. Tests: `claude_profiles_over_rpc`, `a_profile_whose_hooks_fail_is_not_created`, `starting_refreshes_the_skill_of_every_profile`.
- [x] `hooks.install` and `hooks.uninstall` cover the default folder and every profile's folder. `profile.list` reports `hooks_installed` for each profile, so Settings can show it per profile; `hooks.status` stays about `~/.claude` and Codex. Test: `hooks_install_and_uninstall_cover_profile_folders`.
- [x] `profile.list` returns every profile with its name, folder, hook state and last known account. `profile.status {id?}` runs `claude auth status --json` with that profile's `CLAUDE_CONFIG_DIR` (no id: the default profile), remembers the account, and sends `profiles.changed`. The account is signed in or not, plus the email and organisation when the CLI reports them. Every change to profiles sends the full list as `profile.list` returns it. Tests: `profile_status_reads_who_a_profile_is_signed_in_as` (a fake `claude`), and the parser with captured output (`reads_the_account_of_a_signed_in_profile`, `a_signed_out_profile_has_no_account`).
- [x] `profile.update {id, name?}` renames a profile. `profile.delete {id}` forgets it and moves the workspaces using it back to the default. The folder on disk and its login stay; the confirm says so. Test: `claude_profiles_over_rpc`.
- [x] Two profiles cannot share a folder, and a profile cannot use the default folder (`~/.claude`, or the daemon's own `CLAUDE_CONFIG_DIR`), a folder inside a project, or a relative path (`~` and `~/…` are the home folder; `~bob/…` is refused). The checks resolve symlinks, so a link to `~/.claude` or `/var` vs `/private/var` cannot slip past. Test: `refuses_the_default_folder_a_taken_one_a_project_and_relative_paths`.

### Workspaces and sessions

- [x] `workspace.create` and `workspace.update` take `claude_profile`, a profile id; in an update `null` means the default and leaving it out keeps it. An unknown id is refused. The choice survives a daemon restart. Tests: `claude_profiles_over_rpc`, `a_workspaces_profile_survives_a_restart`.
- [x] A session's profile is its workspace's profile (`Session.workspace_id`, X32). So a project shared by two workspaces runs with each workspace's account. Test: `a_shared_project_runs_with_each_workspaces_profile`.
- [x] A Claude TUI tab started in a session gets `CLAUDE_CONFIG_DIR` set to the workspace profile's folder, and the default profile gets no variable at all. TUI agents start through `$SHELL -lic`, which runs the user's rc files after moonlet sets the environment. So the variable is also put in front of the agent command itself, and an `export CLAUDE_CONFIG_DIR` in `.zshrc` cannot override it. Test: `a_workspaces_profile_reaches_its_sessions_terminals`.
- [x] The structured view's Claude process gets the same variable. Test: `the_structured_agent_starts_in_the_workspaces_profile`, with a fake `claude` that records its `CLAUDE_CONFIG_DIR`.
- [x] Shell tabs and run scripts in a session also get `CLAUDE_CONFIG_DIR`, so typing `claude` in a session's shell uses the workspace's profile. Tests: `a_workspaces_profile_reaches_its_sessions_terminals`, `run_scripts_get_the_workspaces_profile`.
- [x] The profile is resolved each time a process starts, never stored in a chat's saved environment. After the workspace's profile changes, or the session's section moves to another workspace (X32), a running agent keeps its account until it restarts. The next start uses the new profile, and a restored tab whose agent left the repo's config gets the new profile in place of the one it started with. Tests: `the_structured_agent_starts_in_the_workspaces_profile`, `a_restored_custom_agent_tab_takes_the_current_profile`.
- [x] A Claude conversation lives in the profile, so a session whose profile changed cannot resume it. The structured view starts a new conversation instead of failing on `--resume`, and shows a notice ("Started a new conversation: this workspace now uses Work profile", or "the default Claude profile"). A Claude TUI tab restored after the profile changed starts `claude` without `--continue`. Tests: `the_structured_agent_starts_in_the_workspaces_profile`, `a_restored_claude_tab_continues_only_in_the_same_profile` (which also checks the TUI process sees the folder).
- [x] Changing a workspace's profile in Workspace settings, creating a workspace with sections moved into it, or moving a section to a workspace with another profile, asks first when the sessions affected run Claude agents (Codex and custom agents do not count). The confirm names the number of sessions and the new profile, and says running agents switch when they next start, without their old conversation. Tests: `switchConfirm`, `profileChangeConfirm`, `runningClaudeAgents`, `movingSessions` in `profiles.test.ts`.
- [x] The profile select offers the default, every profile and New profile… (its folder hint is the daemon's default folder for the name). Under it, the picked profile's account: signed in as …, or Not signed in with **Sign in…**, for the default profile too. The sidebar footer names the shown workspace's profile, warns when it is not signed in (the default profile included), and shows the account on hover. Tests: `profileOptions`, `footerLabel`, `accountLabel`, `accountState`, `defaultFolder` in `profiles.test.ts`, and `workspace-profile.e2e.ts`.
- [x] A profile created in the New workspace dialog is picked for the workspace, and a session started there gets its folder. Test: `workspace-profile.e2e.ts`.

### Codex and other agents

- [x] Codex and custom agents are not affected: no `CODEX_HOME`, no extra variables, and a Claude profile change never stops Codex resuming (its history is in `~/.codex`). A custom agent command that runs `claude` does get `CLAUDE_CONFIG_DIR`, because every session terminal gets it. Test: `a_restored_codex_tab_resumes_whatever_the_claude_profile`.

## UI

- **New workspace and Workspace settings:** the **Claude profile** select, as in the design ("Work profile — ~/.claude-work", "Default — ~/.claude", "New profile…"). Under it, the hint "Every session in this workspace signs in with this account.", and the picked profile's account, with **Sign in…** when it is not signed in.
- **Sidebar footer:** a person icon and "Claude · <profile name>", or "Claude · Default". It adds "not signed in" in the warning colour when the profile has no login; hovering shows the account and the folder; clicking opens Workspace settings.
- **Switcher menu (X32):** each workspace's summary line ends with its profile name.
- **Settings → Claude profiles:** a row for the default profile and one per profile (this Mac's) with its name, folder, account and the workspaces using it, and **Sign in…** or **Sign out**; profiles also have **Rename** and **Remove** (`removeProfileConfirm` in `profiles.test.ts`).
- **Sign in… / Sign out:** a modal holding a terminal. Signing in first asks how the profile is billed: **Claude subscription** runs `claude auth login`, **Anthropic Console (API billing)** runs `claude auth login --console`; Sign out runs `claude auth logout`. A success closes the modal; a failure keeps it open with the output and the exit code. Closing it stops the command, even when the terminal had not started yet, and the account refreshes.

## Protocol and RPCs

- New `profile.list`, `profile.create {name, path?}`, `profile.update {id, name?}`, `profile.delete {id}`, `profile.status {id?}` (runs `claude auth status --json` again; no id: the default profile), and the event `profiles.changed`, which carries the same list as `profile.list`.
- `Workspace` gains `claude_profile: Option<String>`. `workspace.create` and `workspace.update` accept it (`null` in an update: the default).
- `profile.list` reports whether each profile's folder has the hooks; `hooks.install` and `hooks.uninstall` cover every profile's folder too.
- `docs/protocol.md` is updated.

## Data and config

- Profiles are stored in the daemon's `state.json`: `{id, name, path, created_at}`. Each host has its own profiles, because the folders are on that host.
- Nothing about profiles goes into `.moonlet/config.toml`: a repo cannot choose an account.
- moonlet never reads or stores credentials. Logins stay where Claude Code keeps them for each folder.

## Security considerations

- The profile folder path is user input. It is canonicalised, must be absolute after `~` expansion, must not be the default folder, and must not be inside a project.
- New folders are created with mode 0700, because Claude Code keeps settings and history there.
- The value goes into a shell command line for TUI agents, so it is shell-quoted with the existing quoting helper.
- `claude auth status --json` prints the account's email. It is shown in the app only and is not logged.

## Out of scope

- Codex profiles (`CODEX_HOME`). The data model leaves room for them.
- A profile per project or per session. The workspace is the only place a profile is chosen.
- Copying settings, MCP servers or plugins from `~/.claude` into a new profile.
- API key and `CLAUDE_CODE_OAUTH_TOKEN` profiles. A profile is always a config folder.

## Test plan

- **Rust unit:** profile path validation; the agent command and env for default and profiled workspaces; parsing `claude auth status --json` from captured output; dropping `--resume`/`--continue` after a profile change.
- **Session tests with real PTYs (`moonlet-core`):** a fake `claude` records the folder it sees in the TUI and the structured view; profile changes, restarts, Codex and custom agents.
- **Daemon e2e (`crates/moonletd/tests/`):** profiles over RPC with a scratch HOME (hooks, rename, delete, rollback, uninstall, skill refresh), and `profile.status` against a fake `claude`.
- **Vitest:** the footer label and its states; the profile-change confirm text; the profile select options.
- **E2e (`apps/desktop/e2e/specs/workspace-profile.e2e.ts`):** crucial, because starting an agent on the wrong account is noticed at once. Create a profile, pick it for a new workspace, start a session with a fake `claude` agent, and read `CLAUDE_CONFIG_DIR` in the session's terminal.
- **Manual:** sign in to two real accounts. Check that each workspace's agent reports its own account (`/status`), and that signing in to one profile does not sign out the other. That shows the macOS Keychain entries are separate: a [reported bug](https://claudeissues.com/issue/70697-bug-claude-config-dir-does-not-isolate-macos-keychain-credentials-per-config-dir) says all folders shared one entry in some version.

## Open questions

- None so far.
