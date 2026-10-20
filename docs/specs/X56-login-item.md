# X56: The daemon starts at login as moonlet's login item

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** NFR reliability ("the daemon runs as a launchd LaunchAgent, independent of the app process"), NFR distribution
- **Related ADRs:** [0004](../adr/0004-launchagent-plist.md), which this spec supersedes for release builds

## Summary

Release builds are now signed with a Developer ID ([X3](X3-distribution.md)), so the daemon's launch agent can move from a plist that `moonletd service install` writes into `~/Library/LaunchAgents` ([S1b](S1b-launchd.md)) to `SMAppService`. The agent's plist ships inside `moonlet.app`, and the app registers it. macOS then lists the daemon under System Settings › General › Login Items as **moonlet**, with the team's name, and the user controls it there as well as in Settings. The agent is on by default, so sessions outlive the app window for everyone. Existing installs move over without stopping the running daemon. Dev builds, e2e builds and the CLI keep the plist from S1b.

## User journey

1. A user installs moonlet and opens it for the first time. The app registers its login item. macOS shows its own "Background Items Added" notice naming moonlet. The daemon now starts at every login and restarts if it crashes.
2. In Settings › App › General › Background daemon, "Start the moonlet daemon at login" is on. The line under it reads "Starts at login · moonlet in System Settings › Login Items".
3. The user turns the toggle off. The app asks first, as today, because the daemon serving their sessions may stop. The login item is removed and stays off on later launches.
4. A user who instead switches moonlet off in System Settings › Login Items sees the toggle off. The line reads "Turned off in System Settings › Login Items", with an **Open Login Items** button. Turning the toggle on again opens Login Items, because only the user can re-allow it there.
5. A user upgrading from a version that used the plist keeps every session. The old plist is removed without stopping the daemon. From the next login, the login item starts the daemon.

## Behaviour and acceptance criteria

### The bundled agent

- [ ] `moonlet.app/Contents/Library/LaunchAgents/dev.onedevstudio.moonlet.moonletd.plist` is in the release bundle, and its signature is sealed with the app. Its keys:
  - `Label` `dev.onedevstudio.moonlet.moonletd`. This is a new label: the S1b agent `dev.onedevstudio.moonlet.daemon` may still be loaded during migration, and two jobs cannot share a label.
  - `BundleProgram` `Contents/MacOS/moonletd`, `ProgramArguments` `moonletd daemon`;
  - `RunAtLoad`, `KeepAlive {SuccessfulExit: false}` and `ProcessType Interactive`, as in S1b;
  - `AssociatedBundleIdentifiers` `dev.onedevstudio.moonlet`, so Login Items shows the app's name and icon.

  The plist has no log paths and no `MOONLET_HOME`: the daemon writes its own log under `~/.moonlet/logs`, and a custom home is a dev and e2e concern, served by the plist path.

### Which mechanism a build uses

- [ ] The app uses the login item when it runs from a bundle that contains the agent plist; otherwise it uses `moonletd service` as in S1b. `pnpm tauri dev` and e2e builds therefore keep the plist.

### On by default

- [ ] On launch, the app registers the login item unless the user has turned it off. The user's choice is kept in `~/.moonlet/app.toml` as `start_daemon_at_login`. When the key is missing, the default is on, so existing installs that never turned the S1b toggle on are registered once too.
- [ ] Registering a login item that is already registered changes nothing and never stops the running daemon.
- [ ] A second daemon started by the login item while one is already listening exits with code 0 (S1b), so launchd does not restart it.

### The Settings toggle

- [ ] The toggle shows the login item's state:
  - registered and enabled: on, "Starts at login · moonlet in System Settings › Login Items";
  - turned off in Login Items (`requiresApproval`): off, "Turned off in System Settings › Login Items", with **Open Login Items**;
  - not registered: off, "Not starting at login: moonletd runs while moonlet is open".
- [ ] Turning it off asks for confirmation first when the daemon runs under launchd, as in S1b. It then unregisters the login item and saves `start_daemon_at_login = false`.
- [ ] Turning it on saves `start_daemon_at_login = true` and registers the login item. If macOS reports that the user must allow it, the app opens System Settings › Login Items.
- [ ] Search settings finds the toggle under "login item" and "Login Items", as well as the existing terms.

### Moving from the S1b plist

- [ ] On launch, a login-item build that finds `~/Library/LaunchAgents/dev.onedevstudio.moonlet.daemon.plist` deletes the file without booting the agent out. The daemon it runs keeps serving every session until logout. If that daemon crashes before then, launchd still restarts it from the loaded job.
- [ ] If the old plist was there, the user's choice counts as on, whatever `app.toml` says.
- [ ] A failed deletion is logged and retried on the next launch. It never blocks the app.

## UI

Settings › App › General › Background daemon:

```
Start the moonlet daemon at login                        [on]
Agents run in moonletd, not in this window. As a login item it starts
at login and restarts if it ever crashes.
● Starts at login · moonlet in System Settings › Login Items
```

When it was turned off in System Settings:

```
Start the moonlet daemon at login                        [off]
● Turned off in System Settings › Login Items     [Open Login Items]
```

Dev and e2e builds show the S1b line and plist path as today.

## Protocol and RPCs

- Tauri command `daemon_service` keeps its `install | uninstall | status` actions and returns `{ mechanism: "login_item" | "plist", state, plist? }`. `state` is `enabled`, `requires_approval`, `not_registered` or, for the plist, `loaded`, `installed` or `not_installed`.
- New Tauri command `open_login_items` calls `SMAppService.openSystemSettingsLoginItems()`.
- `moonletd service` and its CLI output are unchanged.

## Data and config

- `~/.moonlet/app.toml`, key `start_daemon_at_login` (bool). It is missing until the user changes the toggle or the migration records an earlier choice.
- The agent plist in the bundle: `apps/desktop/src-tauri/launchd/dev.onedevstudio.moonlet.moonletd.plist`, copied to `Contents/Library/LaunchAgents/` through `bundle.macOS.files` in `tauri.bundle.json`.

## Security considerations

- The agent plist is inside the signed, notarized bundle, so it cannot be changed without breaking the app's signature. The S1b plist was a user-writable file pointing at a binary path.
- `BundleProgram` is relative to the bundle, so moving the app keeps the login item pointing at the moved app's own `moonletd`. This removes ADR 0004's stale-path consequence.
- `app.toml` is a user file read with the same rules as `git.toml`: a file that does not parse gives the default.

## Out of scope

- Remote hosts: Linux daemons are unaffected.
- Supervising the daemon that a live upgrade (S3) starts. It runs detached, outside launchd, as it does today.
- Removing `moonletd service`: it stays for dev builds, e2e and CLI-only use.
- Intel or universal builds.

## Test plan

- **Rust (desktop):**
  - the bundled plist parses and has the keys above (a test reads the file from `src-tauri/launchd/`);
  - the launch decision as a pure function of the stored choice, whether the old plist exists and the login item's state: when to register, when to delete the old plist and what to record;
  - reading and writing `app.toml`: a missing key, a file that does not parse, and an update.
- **Vitest:** `daemonLine` for each state of both mechanisms, the Open Login Items action for `requires_approval`, and the search terms.
- **Release workflow:** the check step also asserts that `Contents/Library/LaunchAgents/dev.onedevstudio.moonlet.moonletd.plist` is in the signed app.
- **e2e:** the existing Background daemon spec still passes on the plist mechanism.
- **Manual, on a signed release build,** listed in `docs/manual-checks.md`:
  - a first launch registers the item, and Login Items lists moonlet;
  - killing `moonletd` brings it back;
  - the toggle off unregisters it and the setting survives a relaunch;
  - switching moonlet off in Login Items shows the right line;
  - an upgrade from 0.1.24 with the S1b agent loaded keeps every session, and after logging out and in again the daemon runs under the new label only.

## Open questions

- Does `SMAppService.unregister()` stop an agent that is running, as `launchctl bootout` does? The confirmation text depends on it. Check it on a signed build before writing the dialog.
- Does registration work for a locally built, ad-hoc signed bundle? If it does, local `pnpm bundle` builds can use the login item too. If not, the "Which mechanism" rule should also require a Developer ID signature.
