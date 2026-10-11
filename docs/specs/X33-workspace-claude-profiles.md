# X33: A Claude Code profile per workspace

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **Related:** [X32](X32-workspaces-and-sections.md) (workspaces), [A2](A2-hook-install.md) (hooks), [X6](X6-structured-agent-view.md) (structured agent view), [glossary](../../CONTEXT.md).
- **References:** user request of 2026-10-09. A client pays for one Claude subscription for work; the user's own subscription covers private projects. Both are used on the same Mac, and each workspace must keep the right one. The design "Workspaces & Sections" (2026-10-11) shows the profile in the New workspace dialog and in the sidebar footer.

## Summary

A **Claude profile** is a Claude Code config folder: its own login, settings, MCP servers, plugins, skills, memory and conversation history. moonlet points Claude Code at a profile with `CLAUDE_CONFIG_DIR`. Every workspace (X32) uses the **default profile** (`~/.claude`, the variable unset) unless the user picks another one for it. Every Claude process started for a session, whether a TUI tab or the structured view, uses the profile of the session's workspace. So "CipherHealth" can run on the client's subscription and "Personal" on the user's own, with no logging out and in.

Checked on Claude Code 2.1.292: with `CLAUDE_CONFIG_DIR` pointing at an empty folder, `claude auth status --json` reports `"loggedIn": false` while the default profile is signed in. So the login is kept per folder, and `.claude.json` (MCP servers) and `projects/` (transcripts) move into that folder too.

## User journey

1. In **New workspace** or **Workspace settings…** (X32), the **Claude profile** select lists **Default — ~/.claude**, every profile moonlet knows (for example "Work profile — ~/.claude-work"), and **New profile…**.
2. **New profile…** asks for a name ("Work profile") and a folder: either a new `~/.claude-<slug>` (default), or an existing folder the user already uses with `CLAUDE_CONFIG_DIR`. moonlet creates the folder if needed and installs its hooks and skill into it.
3. The new profile is not signed in yet, so moonlet offers **Sign in…**. It opens a terminal running `claude auth login` with that profile's `CLAUDE_CONFIG_DIR`. The user finishes the browser login, and the profile then shows its account (for example `jane@cipherhealth.com`).
4. The sidebar footer shows "Claude · Work profile" for the current workspace. Hovering it shows the account and the folder.
5. Every new session in that workspace starts Claude signed in to the client's account. Sessions in "Personal" keep using `~/.claude`.

## Behaviour and acceptance criteria

### Profiles

- [ ] `profile.create {name, path?}` creates a profile. Without `path`, the folder is `~/.claude-<slug>`, made unique. The folder is created with mode 0700 when missing. An existing folder is used as-is. Test: daemon e2e, creates a profile and checks the folder and its mode.
- [ ] Creating a profile installs moonlet's Claude hooks and the `moonlet` skill into that folder's `settings.json` and `skills/moonlet/SKILL.md`, the same way A2 does for `~/.claude`. Test: the folder's `settings.json` holds the moonlet hook entries after `profile.create`.
- [ ] `hooks.install` installs into the default folder and into every profile's folder. `hooks.status` reports each folder. Test: `hooks.status` lists the profile's folder as installed.
- [ ] `profile.list` returns every profile with its name, folder and account. The account comes from `claude auth status --json`, run with that profile's `CLAUDE_CONFIG_DIR`: signed in or not, plus the email and organisation when the CLI reports them. The parsing is a pure function, tested with captured output of a signed-out and a signed-in profile.
- [ ] `profile.update {id, name?}` renames a profile. `profile.delete {id}` forgets it and moves the workspaces using it back to the default. The folder on disk and its login stay; the confirm says so. Test: deleting a profile leaves the folder and sets the workspace back to default.
- [ ] Two profiles cannot share a folder, and a profile cannot use the default folder (`~/.claude`, or the daemon's own `CLAUDE_CONFIG_DIR`). Test: both are refused with a message.

### Workspaces and sessions

- [ ] `workspace.create` and `workspace.update` take `claude_profile`, a profile id; `null` means the default. Test: `workspace.list` returns the value after an update, and after a daemon restart.
- [ ] A session's profile is its workspace's profile (`Session.workspace_id`, X32). So a project shared by two workspaces runs with each workspace's account. Test: one project in two workspaces with different profiles; a fake `claude` in each workspace's session prints a different folder.
- [ ] A Claude TUI tab started in a session gets `CLAUDE_CONFIG_DIR` set to the workspace profile's folder, and the default profile gets no variable at all. TUI agents start through `$SHELL -lic`, which runs the user's rc files after moonlet sets the environment. So the variable is also put in front of the agent command itself, and an `export CLAUDE_CONFIG_DIR` in `.zshrc` cannot override it. Test: the agent command for a session in a profiled workspace names the folder; a session in a default workspace has no `CLAUDE_CONFIG_DIR`.
- [ ] The structured view's Claude process gets the same variable. Test: daemon e2e with a fake `claude` that prints its `CLAUDE_CONFIG_DIR`.
- [ ] Shell tabs and run scripts in a session also get `CLAUDE_CONFIG_DIR`, so typing `claude` in a session's shell uses the workspace's profile. Test: a session shell's environment has the variable.
- [ ] The profile is resolved each time a Claude process starts, never stored in a chat's saved environment. After the workspace's profile changes, or the session's section moves to another workspace (X32), a running agent keeps its account until it restarts. The next start uses the new profile. Test: change the profile, restart the agent, and the fake `claude` prints the new folder.
- [ ] Conversation history lives in the profile, so a session whose profile changed cannot resume its old conversation. The structured view starts a new conversation instead of failing on `--resume`, and shows a notice ("Started a new conversation: this workspace now uses Work profile"). A TUI tab restored after the profile changed starts `claude` without `--continue`. Tests: a chat whose last start used another profile starts without `--resume`; a restored TUI agent in the same case has no `--continue`.
- [ ] Changing a workspace's profile, or moving a section to a workspace with another profile, asks first when sessions have agents. The confirm names the number of sessions and says running agents switch when they next start, without their old conversation. Test: the `lib/` function that builds the confirm text, in vitest.

### Codex and other agents

- [ ] Codex and custom agents are not affected: no `CODEX_HOME` and no extra variables. A custom agent command that runs `claude` does get `CLAUDE_CONFIG_DIR`, because every session terminal gets it.

## UI

- **New workspace and Workspace settings:** the **Claude profile** select, as in the design ("Work profile — ~/.claude-work", "Default — ~/.claude", "New profile…"). Under it, the hint "Every session in this workspace signs in with this account.", and **Sign in…** when the picked profile is not signed in.
- **Sidebar footer:** a person icon and "Claude · <profile name>", or "Claude · Default". It shows "not signed in" in the warning colour when the profile has no login; clicking it opens Workspace settings.
- **Switcher menu (X32):** each workspace's summary line ends with its profile name.
- **Settings → Claude profiles:** one row per profile with its name, folder, account, the workspaces using it, and **Sign in…**, **Sign out**, **Rename**, **Remove**.
- **Sign in…:** a modal holding a terminal that runs `claude auth login`. When the command exits, the profile's account refreshes. A second button runs `claude auth login --console`, to use Console (API) billing instead of a subscription.

## Protocol and RPCs

- New `profile.list`, `profile.create {name, path?}`, `profile.update {id, name?}`, `profile.delete {id}`, `profile.status {id}` (runs `claude auth status --json` again), and the event `profiles.changed`.
- `Workspace` gains `claude_profile: Option<String>`. `workspace.create` and `workspace.update` accept it.
- `hooks.status` returns one entry per Claude folder.
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
- **Daemon e2e (`crates/moonletd/tests/`):** create a profile, check the folder, mode and hooks; set it on a workspace; create a session and check that a fake `claude` sees the folder in both the TUI and the structured view; change the profile and restart the agent.
- **Vitest:** the footer label and its states; the profile-change confirm text; the profile select options.
- **E2e (`apps/desktop/e2e/specs/workspace-profile.e2e.ts`):** crucial, because starting an agent on the wrong account is noticed at once. Create a profile, pick it for a new workspace, start a session with a fake `claude` agent, and read `CLAUDE_CONFIG_DIR` in the session's terminal.
- **Manual:** sign in to two real accounts. Check that each workspace's agent reports its own account (`/status`), and that signing in to one profile does not sign out the other. That shows the macOS Keychain entries are separate: a [reported bug](https://claudeissues.com/issue/70697-bug-claude-config-dir-does-not-isolate-macos-keychain-credentials-per-config-dir) says all folders shared one entry in some version.

## Open questions

- None so far.
