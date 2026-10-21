# X56: The daemon starts at login as moonlet's login item

- **Status:** implemented (login item untried on a signed release, see M7 and M11)
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

- [x] `moonlet.app/Contents/Library/LaunchAgents/dev.onedevstudio.moonlet.moonletd.plist` is in the release bundle, and its signature is sealed with the app. Test: `the_bundled_agent_runs_the_bundles_moonletd_as_moonlet`; the release workflow's "App is signed with the Developer ID and notarized" step fails without the file. Its keys:
  - `Label` `dev.onedevstudio.moonlet.moonletd`. This is a new label: the S1b agent `dev.onedevstudio.moonlet.daemon` may still be loaded during migration, and two jobs cannot share a label.
  - `BundleProgram` `Contents/MacOS/moonletd`, `ProgramArguments` `moonletd daemon`;
  - `RunAtLoad`, `KeepAlive {SuccessfulExit: false}` and `ProcessType Interactive`, as in S1b;
  - `AssociatedBundleIdentifiers` `dev.onedevstudio.moonlet`, so Login Items shows the app's name and icon.

  The plist has no log paths and no `MOONLET_HOME`: the daemon writes its own log under `~/.moonlet/logs`, and a custom home is a dev and e2e concern, served by the plist path.

### Which mechanism a build uses

- [x] The app uses the login item when it runs from a bundle that contains the agent plist; otherwise it uses `moonletd service` as in S1b. `pnpm tauri dev` and e2e builds (`--no-bundle`) therefore keep the plist; a local `pnpm bundle` build uses the login item. Test: `the_agent_plist_is_looked_up_inside_the_running_bundle`; manual: M7.
- [x] An app opened from its DMG (`/Volumes/…`) or from a copy that App Translocation made registers nothing at launch, and turning the toggle on there says "Move moonlet to Applications first": the login item would start the daemon from that path. Test: `only_an_installed_app_registers_its_login_item`.

### On by default

- [x] On launch, the app registers the login item unless the user has turned it off. It registers it when macOS reports it not registered or not found: macOS reports an agent it has never registered as not found, so only `register()` can tell a missing plist apart (see Findings). The user's choice is kept in `~/.moonlet/app.toml` as `start_daemon_at_login`. When the key is missing, the default is on, so existing installs that never turned the S1b toggle on are registered once too. Tests: `a_first_launch_registers_the_login_item`, `a_launch_leaves_the_login_item_alone_when_the_user_turned_it_off`, `the_choice_is_kept_in_app_toml_and_missing_until_made`.
- [x] Registering a login item that is already registered changes nothing and never stops the running daemon. Test: `a_launch_does_nothing_when_the_login_item_is_already_on`; the app does not even call `register()` then, and a second `register()` kept the same process in the findings below.
- [x] A second daemon started by the login item while one is already listening exits with code 0 (S1b), so launchd does not restart it. Test: `a_second_daemon_exits_with_0_while_one_is_listening`.

### The Settings toggle

- [x] The toggle shows the login item's state (Vitest: "points at Login Items when the login item starts the daemon", "says when the login item was switched off in System Settings", "says the daemon only runs with the app when the login item is not registered", "shows the toggle on only while something starts the daemon at login", "offers Open Login Items only when the login item was switched off there"):
  - registered and enabled: on, "Starts at login · moonlet in System Settings › Login Items";
  - turned off in Login Items (`requiresApproval`): off, "Turned off in System Settings › Login Items", with **Open Login Items**;
  - not registered: off, "Not starting at login: moonletd runs while moonlet is open";
  - not found by macOS, after registering failed: off, "macOS cannot find moonlet's login item. Reinstall moonlet." (Vitest: "says when macOS cannot find the login item").
- [x] Turning it off asks for confirmation first when the daemon runs under launchd, as in S1b. It then unregisters the login item and, once that worked, saves `start_daemon_at_login = false`. Vitest: "asks before turning off only when that stops the daemon launchd runs"; the rest: M7.
- [x] Turning it on saves `start_daemon_at_login = true` and registers the login item, also when macOS reports it not found; a plist that is really missing fails with macOS's reason. If it was switched off in Login Items, the app opens System Settings › Login Items instead of registering, and says "Allow moonlet in System Settings › Login Items". Tests: `turning_the_toggle_on_registers_or_sends_the_user_to_login_items`, Vitest "says what turning the toggle did, or that macOS still needs the user"; the rest: M7.
- [x] A launch and a toggle never interleave: each holds one lock while it reads the state, acts and saves the choice, so a quick toggle-off is not undone by the launch. No automated test: it needs `SMAppService`.
- [x] Search settings finds the toggle under "Login Items", "Background Items" and "SMAppService", as well as the existing terms. Vitest: "finds the daemon's login item by the names macOS uses (X56)".

### Moving from the S1b plist

- [x] On launch, a login-item build that finds `~/Library/LaunchAgents/dev.onedevstudio.moonlet.daemon.plist` deletes the file without booting the agent out. The daemon it runs keeps serving every session until logout. If that daemon crashes before then, launchd still restarts it from the loaded job. The plist is deleted only once the login item is enabled; while it cannot take over (registering failed, switched off in Login Items), the old plist stays. Tests: `the_old_plist_is_replaced_by_the_login_item_and_counts_as_on`, `the_old_plist_stays_while_no_login_item_can_take_over`; on a real upgrade: M11.
- [x] An old plist that sets `MOONLET_HOME`, as dev agents do, is left alone and does not count as a choice: the login item would run the daemon on `~/.moonlet`. Tests: `an_old_plist_that_sets_moonlet_home_is_told_apart`, `an_old_plist_with_its_own_moonlet_home_is_left_alone`.
- [x] If the old plist was there, the user's choice counts as on, whatever `app.toml` says. Test: `the_old_plist_is_replaced_by_the_login_item_and_counts_as_on`.
- [x] A failed deletion is logged and retried on the next launch. It never blocks the app: the launch runs on its own thread. Manual: M11 (deleting a real file under `~/Library/LaunchAgents` has no automated test).

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

- Tauri command `daemon_service` keeps its `install | uninstall | status` actions and returns `{ mechanism: "login_item" | "plist", state, plist? }`. `state` is `enabled`, `requires_approval`, `not_registered`, `not_found` or, for the plist, `loaded`, `installed` or `not_installed`.
- New Tauri command `open_login_items` calls `SMAppService.openSystemSettingsLoginItems()`.
- `moonletd service` and its CLI output are unchanged.

## Data and config

- `~/.moonlet/app.toml`, key `start_daemon_at_login` (bool). It is missing until the user changes the toggle or the migration records an earlier choice. A file that does not parse counts as no choice, and a save leaves it as it is with an error instead of dropping its other keys (test: `a_save_never_overwrites_an_app_toml_that_does_not_parse`).
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
- A daemon that takes over jaunt's (X27) still writes the S1b plist through `moonletd service`; the next launch replaces it with the login item.
- A local `pnpm bundle` build registers the same label as the release; launching one next to an installed release moves the login item to it until the release is opened again.

## Test plan

- **Rust (desktop):**
  - the bundled plist parses and has the keys above (a test reads the file from `src-tauri/launchd/`);
  - the launch decision as a pure function of the stored choice, whether the old plist exists and the login item's state: when to register, when to delete the old plist and what to record;
  - reading and writing `app.toml`: a missing key, a file that does not parse, and an update.
- **Vitest:** `daemonLine` for each state of both mechanisms, the Open Login Items action for `requires_approval`, and the search terms.
- **Release workflow:** the check step also asserts that `Contents/Library/LaunchAgents/dev.onedevstudio.moonlet.moonletd.plist` is in the signed app.
- **e2e:** none. Toggling the plist mechanism in e2e would load and boot out the real `dev.onedevstudio.moonlet.daemon` agent in the user's launchd domain, and e2e builds have no bundle for the login item. The Background daemon card in each login item state was checked with `e2e/snap.ts`.
- **Manual, on a signed release build,** listed in `docs/manual-checks.md`:
  - a first launch registers the item, and Login Items lists moonlet;
  - killing `moonletd` brings it back;
  - the toggle off unregisters it and the setting survives a relaunch;
  - switching moonlet off in Login Items shows the right line;
  - an upgrade from 0.1.24 with the S1b agent loaded keeps every session, and after logging out and in again the daemon runs under the new label only.

## Findings

Checked on macOS with a throwaway bundle that registers an agent with `SMAppService` (2026-10-20):

- An ad-hoc signed bundle registers its agent (`enabled`) and launchd runs it, so the mechanism rule needs no Developer ID check: a local `pnpm bundle` build uses the login item too.
- `unregister()` stops a running agent, as `launchctl bootout` does. Turning the toggle off therefore keeps the S1b confirmation.
- `register()` on an agent that is already registered and running keeps the same process.
- An agent killed by a signal is restarted by launchd (`KeepAlive {SuccessfulExit: false}`).

On the signed 0.1.27 release (2026-10-21, macOS 27.0.1): the app in `/Applications`, notarized and carrying the agent plist, read its login item as `notFound`. `sfltool dumpbtm` listed the app but no agent, so it had never been registered, and the app neither registered it at launch nor from the toggle. Both now call `register()` for `notFound` too.

A throwaway ad-hoc signed bundle on the same Mac confirmed it: its never-registered agent read `notFound`, `register()` made it `enabled`, and `unregister()` left it `notRegistered`. With the plist removed from the bundle, `register()` failed with "Unable to read plist" (`SMAppServiceErrorDomain` 108) and the state stayed `notFound`.
