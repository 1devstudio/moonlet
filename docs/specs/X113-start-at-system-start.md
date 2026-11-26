# X113: moonletd starts at system start, before anyone logs in

- **Status:** proposed (the launcher's drop to the user before login checked with a throwaway bundle, see Findings)
- **Priority / phase:** P2 · phase 3
- **PRD refs:** NFR reliability ("the daemon runs as a launchd LaunchAgent, independent of the app process")
- **Related:** [X56](X56-login-item.md) (the login item this builds on), [S3](S3-live-upgrade.md) (the handoff the login takeover reuses), [X58](X58-linux-install-script.md) (Linux hosts already start at boot through `loginctl enable-linger`), ADR [0004](../adr/0004-launchagent-plist.md)

## Summary

X56 starts moonletd at login. A Mac that restarts, such as a Mac mini central host after a power cut or an update, runs no daemon until someone logs in: the phone and the other hosts cannot reach it, and its sessions are not restored.

This adds a second switch, "Start moonletd at system start, before login". moonlet ships a launch daemon inside `moonlet.app`, registered with `SMAppService.daemon`. At boot, a small launcher runs as root, drops to every user who turned the switch on, and starts their moonletd. That daemon serves sessions, terminals and heavy commands before login.

A daemon started at boot can never read the user's login Keychain, before login or after (see Findings). Claude keeps its sign-in there, so before login a chat waits. When the user logs in, the X56 login item starts a daemon in the login session, which takes every terminal over from the boot daemon and restarts the chats with the Keychain available. Settings explains how automatic login shortens that wait, and when Tailscale or FileVault stop the Mac being reachable before login.

## User journey

1. On their Mac mini, a user opens Settings › App › General › Background daemon and turns on "Start moonletd at system start". macOS shows its "Background Items Added" notice. The line reads "Allow moonlet in System Settings › Login Items", with **Open Login Items**. They allow it there with an administrator's password.
2. The line now reads "Starts at system start · moonlet in System Settings › Login Items". If Tailscale is the App Store or Standalone app, a second line says "Tailscale joins the tailnet only after login. To reach this Mac before then, use tailscaled." If FileVault is on, it says "FileVault is on: after a restart nothing starts until someone unlocks the disk."
3. The Mac restarts and nobody logs in. From the phone, the user sees the Mac mini online. Its sessions and terminals are back, and heavy commands from other hosts run on it.
4. They start a Claude chat from the phone. It shows "Claude starts once you log in on studio-mini" and waits.
5. The user logs in on the Mac mini. Within a few seconds the chat starts. Every terminal is still running.

## Behaviour and acceptance criteria

### The bundled launch daemon

- [x] `moonlet.app/Contents/Library/LaunchDaemons/dev.onedevstudio.moonlet.boot.plist` is in the release bundle and sealed with the app. Its keys:
  - `Label` `dev.onedevstudio.moonlet.boot`;
  - `BundleProgram` `Contents/MacOS/moonletd`, `ProgramArguments` `moonletd boot`;
  - `RunAtLoad`, `KeepAlive {SuccessfulExit: false}`;
  - `AssociatedBundleIdentifiers` `dev.onedevstudio.moonlet`, so Login Items shows moonlet's name and icon.

  It has no `UserName`: the plist is sealed in the bundle, so it cannot name the user. Test: `the_bundled_boot_daemon_runs_the_launcher_as_moonlet`; the release workflow's signed-app check also asserts that the file is there.

### The launcher

- [x] `moonletd boot` runs as root and refuses to run as anyone else ("moonletd boot runs from launchd at system start"). Test: `the_launcher_refuses_to_run_as_a_user`.
- [x] It goes through the local users once each: accounts with a uid of 501 or more, a home folder under `/Users`, and a login shell other than `/usr/bin/false` or `nologin` (`nobody`'s uid -2 reads as 4294967294 and is left out by its home). For each, it starts `moonletd daemon --boot` in the home folder with only `HOME`, `USER`, `LOGNAME`, `SHELL` and a system `PATH` set, launchd having set none of them. Between fork and exec the child drops to the user (`initgroups`, `setgid`, `setuid`) and fails to start unless `setuid(0)` then fails and its real and effective ids are the user's. Root never reads a user's files. Test: `the_launcher_tries_only_real_local_users`; the drop needs root, so M13 checks it (the probe in Findings did).
- [x] The daemon, already its user, reads `~/.moonlet/app.toml`: only `start_daemon_at_boot = true` lets it serve, and anyone else's daemon exits 0 without listening. Tests: `only_users_who_turned_it_on_get_a_daemon`, `the_boot_choice_is_read_from_app_toml`.
- [x] Without a `TMPDIR`, the daemon sets the user's own temporary folder (`confstr(_CS_DARWIN_USER_TEMP_DIR)`, as `getconf DARWIN_USER_TEMP_DIR` prints it), so its terminals and agents get the one a login gives. Test: `a_boot_daemon_gives_its_terminals_the_users_temporary_folder`.
- [x] The launcher waits for its daemons. One that exits 0 (it handed over at login, or found a daemon already listening) is done. One that exits otherwise is started again after 10 s, as launchd's throttle would. When every daemon is done, the launcher exits 0, so launchd does not restart it. Test: `a_crashed_boot_daemon_is_started_again_and_a_finished_one_is_not`.
- [x] The launcher runs no async runtime and starts no thread, so its children may drop privileges between fork and exec. It never opens a socket, and it logs to `/Library/Logs/moonlet/boot.log`, naming users by uid only. No automated test: M13.

### The daemon started at boot

- [x] `moonletd daemon --boot` serves like any daemon, and `daemon.info` says `started_at_boot: true` (`false` otherwise). Test: `a_boot_daemon_says_so`.
- [x] A boot daemon that upgrades (S3) starts the new daemon with `--boot`: it runs outside a login session too. The new daemon keeps the terminals it takes even if the user has turned the switch off since. Test: `an_upgraded_boot_daemon_still_says_so`.
- [ ] Before login it serves sessions, terminals, restored workspaces, the tailnet listener and heavy commands as usual. It reads no Keychain item, as no daemon does today.
- [ ] A Claude chat that starts or resumes in a boot daemon waits instead of running `claude`. Its state says `waiting_for_login`, and the app and the phone show "Claude starts once you log in on <host>". A message sent to it is queued as usual. Test: `a_chat_in_a_boot_daemon_waits_for_login`; Vitest: "says a chat waits for login on its host".

### Login takes over

- [ ] At login the X56 login item starts moonletd. Today it exits 0 when a daemon is already listening. When that daemon says `started_at_boot`, the new daemon instead asks it to hand over: the boot daemon hands every terminal to the asking daemon over the S3 handoff, then exits 0. Unlike S3, the boot daemon starts no process: the daemon that asked receives the terminals itself, so it stays in the login session, where the Keychain is. Test: `a_daemon_started_at_login_takes_every_terminal_from_the_boot_daemon` (a terminal's process keeps its pid and its output after the takeover).
- [ ] The boot daemon accepts the takeover only from a peer with the same uid (as S3) whose executable is the boot daemon's own `moonletd` (`proc_pidpath`). Test: `a_takeover_from_another_program_is_refused`.
- [ ] The taking daemon resumes chats from disk, as after S3, so a chat that waited for login starts. Test: `a_waiting_chat_starts_after_the_takeover`.
- [ ] A takeover that fails leaves the boot daemon serving, and the login-session daemon exits 0 as today. The failure is logged. Test: `a_failed_takeover_leaves_the_boot_daemon_serving`.
- [ ] Terminals opened before login keep running in the boot daemon's context after the takeover: a command in them still cannot read the Keychain. New terminals can.

### The Settings switch

- [ ] Settings › App › General › Background daemon gets "Start moonletd at system start" under the X56 switch. It is shown only for the login-item mechanism (release and `pnpm bundle` builds) and is disabled, with "Needs Start the moonlet daemon at login", while that switch is off: without the login item nothing takes over at login. Turning the login item off turns this off too. Vitest: "offers start at system start only with the login item on".
- [ ] Its line follows `SMAppService.daemon`'s state: enabled ("Starts at system start · moonlet in System Settings › Login Items"), requires approval ("Allow moonlet in System Settings › Login Items", **Open Login Items**), not registered (no line), not found ("macOS cannot find moonlet's boot daemon. Reinstall moonlet."). Vitest: "says what starts moonletd at system start".
- [ ] Turning it on saves `start_daemon_at_boot = true` in `~/.moonlet/app.toml`, then registers the daemon. Turning it off saves `false`, then unregisters it. The app neither registers nor removes it at launch: unlike X56 it is off by default. Tests: `the_boot_choice_is_kept_in_app_toml`, `turning_boot_on_registers_and_off_unregisters`.
- [ ] Unregistering does not stop the user's daemon: by then the login item's daemon serves, and a boot daemon that is still serving (nobody logged in) cannot be reached from Settings.
- [ ] Below the line, the app shows what still stops the Mac being useful before login, each only when it applies (Vitest: "warns about Tailscale, FileVault and automatic login only when they apply"):
  - Tailscale without `tailscaled` (`/Library/LaunchDaemons/com.tailscale.tailscaled.plist` missing): "Tailscale joins the tailnet only after login. To reach this Mac before then, use tailscaled.";
  - FileVault on (`fdesetup isactive`): "FileVault is on: after a restart nothing starts until someone unlocks the disk.";
  - automatic login off (no `autoLoginUser` in `/Library/Preferences/com.apple.loginwindow.plist`): "Claude chats wait until someone logs in. Automatic login in System Settings › Users & Groups logs in right after a restart (needs FileVault off)."
- [ ] Search settings finds the switch under "boot", "system start", "restart", "before login" and "launch daemon". Vitest: "finds start at system start (X113)".

## UI

Settings › App › General › Background daemon, below X56's switch:

```
Start moonletd at system start                            [on]
Runs moonletd after a restart, before anyone logs in. Claude chats
wait for login, because the Keychain unlocks only then.
● Starts at system start · moonlet in System Settings › Login Items
△ Claude chats wait until someone logs in. Automatic login in System
  Settings › Users & Groups logs in right after a restart (needs FileVault off).
```

## Protocol and RPCs

- `daemon.info` gains `started_at_boot: bool`.
- New method `daemon.hand_over`, local socket only and added to `LOCAL_METHODS`: the caller asks the daemon to hand its terminals to it. It returns the private handoff socket's path, to which the caller connects. It is refused unless the daemon was started at boot.
- Chat state gains `waiting_for_login`.
- Tauri command `daemon_boot` with `install | uninstall | status`, returning `{ state }` with the X56 states. `open_login_items` is reused.

## Data and config

- `~/.moonlet/app.toml`, key `start_daemon_at_boot` (bool), missing until the user changes the switch. The same rules as `start_daemon_at_login` apply.
- The daemon plist in the bundle: `apps/desktop/src-tauri/launchd/dev.onedevstudio.moonlet.boot.plist`, copied to `Contents/Library/LaunchDaemons/` through `bundle.macOS.files`.
- `/Library/Logs/moonlet/boot.log`, written by the launcher.

## Security considerations

- The launcher is the only part of moonlet that runs as root. It drops to a user before reading anything the user can write, and it never opens a socket. A user can make it start a daemon only as themselves.
- The daemon plist is sealed in the signed, notarized bundle, and `BundleProgram` is relative to the bundle. Only an administrator can allow it, in Login Items.
- `daemon.hand_over` hands every terminal to the caller. It is limited to a daemon started at boot, a peer of the same uid, and a peer running the same `moonletd` executable. The S3 upgrade signal already lets any process of the user hand the terminals to a binary of its choice, so this adds no new reach for a process of the user's.
- A daemon started at boot runs in a "mixed context" (Apple DTS): a user's process in the system's security session. Anything that needs the login session, such as the Keychain or the pasteboard, fails in it. That is why chats wait and login takes over.

## Out of scope

- Several users turning it on on one Mac: the launcher starts each one's daemon, but turning the switch off unregisters the daemon for every user.
- After a logout without a restart, nothing runs until the next login or restart: the boot daemon already handed over.
- gh and git credentials in the Keychain: commands that need them fail before login, as they would over SSH.
- Linux hosts, which start at boot already (X58).
- Unlocking FileVault after a restart (macOS can do it over SSH with Remote Login on, or `fdesetup authrestart` before a planned restart).
- Dev and e2e builds: they have no bundle, so no switch.
- Supervising a boot daemon after a live upgrade (S3): the old daemon exits 0 once it hands over, so the launcher is done, and the new one runs detached, as under X56.

## Test plan

- **Rust (moonletd unit):** which accounts the launcher tries, from captured `dscl` entries; restart or done from an exit status; reading `start_daemon_at_boot`.
- **Rust (moonletd e2e, `crates/moonletd/tests/boot.rs`):** a `--boot` daemon says so, serves only when its user turned it on, sets `TMPDIR` and keeps `--boot` through an upgrade; `moonletd boot` refuses a user; a daemon started after it takes every terminal (same pid, same output) and the boot daemon exits 0; a takeover from another executable is refused; a failed takeover leaves the boot daemon serving; a chat waits in a boot daemon and starts after the takeover (with the test's fake `claude`).
- **Rust (desktop):** the bundled plist's keys; the boot choice in `app.toml`.
- **Vitest:** the switch's lines for each state, the disabled state, the Tailscale, FileVault and automatic-login lines, the chat's waiting line, search terms.
- **e2e:** none, as for X56: e2e builds have no bundle, and registering a launch daemon needs an administrator. The card in each state is checked with `e2e/snap.ts`.
- **Manual, on a signed build in /Applications, in `docs/manual-checks.md` (M13):** turn the switch on and allow it; restart (with FileVault on, `sudo fdesetup authrestart`) and do not log in; from the phone, the host is online and a terminal session runs; a chat says it waits for login; log in; the chat starts and the terminal keeps its pid; `launchctl print system/dev.onedevstudio.moonlet.boot` shows the launcher done, and `launchctl print gui/$UID/dev.onedevstudio.moonlet.moonletd` runs the daemon.

## Findings

From Apple's documentation and Apple DTS answers on the Developer Forums, read 2026-11-26:

- A daemon registered with `SMAppService.daemon` reads its plist from the read-only bundle, so `UserName` must be known in advance (forums thread 856568). Without it the daemon runs as root (751439).
- `register()` asks for no password. macOS does not start the daemon until an administrator allows it in Login Items; until then the state is `requiresApproval` (`SMAppService.register()` documentation, forums 802443).
- A launch daemon runs in the global security context, not a login session's (TN2083). The data protection keychain is "only available in a user login context" (696431). Unlocking or using a user's login keychain from outside their login session is "not really a supported use case", with more hardening in recent macOS 26 releases (841695). Hence the takeover at login rather than Keychain access from the boot daemon.
- Tailscale's App Store and Standalone apps do not run before login; only `tailscaled` does (Tailscale KB 1065, "macOS variants").
- With FileVault on, the data volume stays locked until a user unlocks it at the pre-boot screen; `fdesetup authrestart` skips that once (`man fdesetup`).
- Claude Code on macOS keeps its sign-in in the Keychain (code.claude.com/docs/en/authentication).

A throwaway bundle on macOS 27.0.1 with FileVault on, signed ad hoc, registered with `SMAppService.daemon` (2026-11-26):

- `register()` failed with `SMAppServiceErrorDomain` 1 ("Operation not permitted") and the state became `requiresApproval`; allowing it in Login Items made it `enabled`, and launchd ran it at once. Before registering, the state read `notFound`, as X56 found for agents.
- launchd gave the root launcher only `PATH`, `XPC_SERVICE_NAME`, `XPC_FLAGS` and `OSLogRateLimit`: no `HOME`, `USER` or `TMPDIR`.
- After `sudo fdesetup authrestart`, at the login window (`/dev/console` owned by root, a minute after the restart and two before the login), the launcher ran and its child, dropped to uid 501: could not `setuid(0)` again; read `~/.moonlet` and `app.toml`; ran `zsh -l` (exit 0, the full login `PATH`, `git` and `gh` found). `TMPDIR` was empty.
- The Keychain refused the child both before login and while the user was logged in ("User interaction is not allowed"): a boot daemon never gets it, so the takeover at login is needed.
- The App Store Tailscale's CLI did not answer before login (timed out after 10 s), and failed while logged in ("The Tailscale GUI failed to start").
- With FileVault on, only `fdesetup authrestart` gets to the login window with the disk unlocked; a plain restart stops at the FileVault unlock, which logs the user in directly.
