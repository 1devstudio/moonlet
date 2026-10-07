# X27 — Move from jaunt to moonlet without losing anything

- **Status:** implemented (2026-10-07). Not yet tried against a real `jaunt` 0.1.10 install.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** S3 (live upgrade), A1 (agent hooks), X8 (project settings), X22 (agent opens a session)
- **Related ADRs:** —

## Summary

The app was renamed from jaunt to moonlet. Everything with the old name that lives outside the binary has to move as well: the data folder `~/.jaunt`, each project's `.jaunt/config.toml`, the `JAUNT_*` variables in running shells, the daemon's socket, pid and log files, the hooks and skill installed into Claude Code and Codex, the launchd agent, and the helper on remote hosts. X27 moves all of it the first time a moonlet binary runs. Open terminals and agents keep running through the switch, the same way they do through a live upgrade (S3).

## User journey

1. The user has jaunt 0.1.10 running with several sessions open, and installs moonlet.
2. They open moonlet. It moves `~/.jaunt` to `~/.moonlet`, takes over the running jaunt daemon's terminals, and shows every session as before.
3. An agent in a terminal that jaunt opened finishes its turn. Its hook, now `moonlet hook claude`, still reports the state to the right terminal.
4. The user opens Project settings and saves. The project's `.jaunt/config.toml` becomes `.moonlet/config.toml`.

## Behaviour and acceptance criteria

### Data folder

- [x] The data folder is `$MOONLET_HOME`, else `$JAUNT_HOME`, else `~/.moonlet`.
- [x] When neither variable is set, `~/.moonlet` does not exist and `~/.jaunt` is a real folder, the first moonlet binary to run (`moonlet`, `moonletd` or the app) renames `~/.jaunt` to `~/.moonlet` and leaves a symlink `~/.jaunt` pointing at it. Worktree paths in `state.json` and in git's worktree metadata, and the working folder of open shells, keep resolving through the symlink.
- [x] The move happens once: with `~/.moonlet` present, or `~/.jaunt` already a symlink, nothing changes.
- [x] Installing the helper on a remote host runs the same move there before it creates `~/.moonlet/bin`.

### Daemon

- [x] The daemon's files are `run/moonletd.sock`, `run/moonletd.pid` and `logs/moonletd.log`. The pid file and the upgrade request file sit next to the socket the daemon listens on, named after it.
- [x] `moonletd start` (which the app and `moonletd proxy` call) finds a jaunt daemon still running on `run/jauntd.sock` and takes over its terminals with the S3 handoff. Terminal ids, scrollback and the processes in them survive; the jaunt daemon exits.
- [x] The daemon does not read `JAUNT_SOCK`: a jaunt daemon's environment, inherited during the handoff, must not send moonlet back to the old socket.

### Environment of terminals

- [x] A daemon with its own data folder passes `MOONLET_HOME` to its terminals, so `moonlet` in them uses the same folder and never moves `~/.jaunt`.
- [x] Terminals and structured agents get `MOONLET_TERMINAL_ID`, `MOONLET_SOCK`, `MOONLET_SESSION`, `MOONLET_BIN`, `MOONLET_ROOT_PATH`, `MOONLET_SESSION_PATH`, `MOONLET_SESSION_NAME`, `MOONLET_BRANCH` and `MOONLET_CLASSIC_FILE`, and none of the `JAUNT_*` names.
- [x] `moonlet hook` and the other CLI commands that act on "this terminal" read `MOONLET_TERMINAL_ID`, then `JAUNT_TERMINAL_ID`, then `JAUNT_SESSION_ID`, so agents in terminals jaunt opened still report to their terminal.
- [x] Shells report their PATH and node with the OSC 1337 markers `MoonletPath=` and `MoonletNodePath=`. The daemon also accepts `JauntPath=` and `JauntNodePath=` from shells that jaunt's integration set up.
- [x] Installing the shell integration removes the old fish file `vendor_conf.d/jaunt.fish`, so fish does not load the integration twice.

### Project config

- [x] A project's config is `.moonlet/config.toml`. When only `.jaunt/config.toml` exists, moonlet reads that one, and Project settings names it.
- [x] Saving Project settings writes `.moonlet/config.toml` and removes `.jaunt/config.toml` (and `.jaunt/` when nothing else is in it).

### Hooks, skill and launchd

- [x] Installing hooks replaces hook commands written by `jaunt`, writes the `moonlet` skill to `skills/moonlet/SKILL.md`, and removes a `skills/jaunt/SKILL.md` that jaunt installed. A `skills/jaunt` the user wrote is left alone. Hooks are reinstalled from Settings, as after any move of the app.
- [x] After the takeover, `run/jauntd.sock` is a symlink to moonlet's socket, so hooks and CLI calls from jaunt's binary keep reaching the daemon until the hooks are reinstalled.
- [x] The launchd agent is `dev.onedevstudio.moonlet.daemon`. After taking over jaunt's daemon, moonlet unloads and removes jaunt's `dev.onedevstudio.jaunt.daemon` agent, if there is one, and installs its own. A daemon with its own data folder (`MOONLET_HOME`, `JAUNT_HOME`) leaves launchd alone.

### App settings and bundle identifier

- [x] The bundle identifier is `dev.onedevstudio.moonlet`. The webview keeps its storage in a folder named after it, so on the first launch, before the window opens, moonlet copies `~/Library/WebKit/dev.onedevstudio.jaunt` to `~/Library/WebKit/dev.onedevstudio.moonlet`. It never overwrites moonlet's folder, and jaunt keeps its own. The e2e build (identifier `e2e`) copies nothing.
- [x] App state in localStorage lives under `moonlet.settings`, `moonlet.ui` and `moonlet.prompts`. Until moonlet saves a value, it reads the one jaunt saved under `jaunt.*`.
- macOS sees a new app: notification permission has to be granted again.

## UI

No new UI. Copy that names files (Project settings, the remote helper confirm) now says `.moonlet/config.toml` and `~/.moonlet/bin`.

## Protocol and RPCs

No RPC changes. The OSC 1337 markers change as above, with the old ones still parsed.

## Data and config

`~/.moonlet` (was `~/.jaunt`), `~/Library/WebKit/dev.onedevstudio.moonlet` (copied from `dev.onedevstudio.jaunt`), localStorage `moonlet.*` (was `jaunt.*`), `<repo>/.moonlet/config.toml` (was `.jaunt/config.toml`), `~/Library/LaunchAgents/dev.onedevstudio.moonlet.daemon.plist`, `~/.claude/skills/moonlet`, `~/.codex/skills/moonlet`.

## Security considerations

- The move only renames a real folder owned by the user; a `~/.jaunt` that is a symlink is never followed or moved.
- The handoff from a jaunt daemon uses the same peer-uid check and private socket as S3.
- The removed skill file is deleted only when it carries jaunt's "Installed by jaunt" marker.

## Out of scope

- A home folder long enough that jaunt put its socket under `/tmp/jaunt-*` (over about 85 characters). moonlet starts a fresh daemon there; the jaunt daemon's terminals stay with it.
- Both `~/.jaunt` and `~/.moonlet` existing as real folders. moonlet uses `~/.moonlet` and leaves `~/.jaunt` alone.
- A nested zsh started inside a terminal jaunt opened falls back to `$HOME` for the user's own zsh files when they set a custom `ZDOTDIR`.
- The GitHub repository name.

## Test plan

- `moonlet-core` unit tests: data folder resolution and the move (`paths`), config fallback and save (`project_config`), OSC markers (`term`), fish cleanup (`shell`), legacy skill removal (`hooks`).
- `moonletd` tests: the move on start (`tests/migrate.rs`), taking over a daemon on `run/jauntd.sock` and reaching the new daemon through it (`tests/upgrade.rs`), the launchd label and removing jaunt's agent (`service`).
- `moonlet-cli` tests: the move on start (`tests/migrate.rs`), a hook in a terminal that only has `JAUNT_TERMINAL_ID` (`tests/hook_e2e.rs`), `MOONLET_HOME` in terminals (`tests/session_e2e.rs`).
- `moonlet-app` test: the host-side move script (`remote`).
- `moonlet-app` test: copying the webview data (`webview_data`).
- Vitest: `configName` in `lib/projectSettings.test.ts`; `readStored` and the prompt history in `lib/storage.test.ts`.
- Manual: install the bundle over a running jaunt 0.1.10 and check that sessions, terminals and settings survive.
