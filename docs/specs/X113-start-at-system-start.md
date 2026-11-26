# X113: moonletd starts at system start, before anyone logs in

- **Status:** in progress (running as the user before login checked with a throwaway bundle, see Findings)
- **Priority / phase:** P2 · phase 3
- **PRD refs:** NFR reliability ("the daemon runs as a launchd LaunchAgent, independent of the app process")
- **Related:** [X56](X56-login-item.md) (the login item this builds on), [S3](S3-live-upgrade.md) (the handoff the login takeover reuses), [X58](X58-linux-install-script.md) (Linux hosts already start at boot through `loginctl enable-linger`), ADR [0004](../adr/0004-launchagent-plist.md)

## Summary

X56 starts moonletd at login. A Mac that restarts, such as a Mac mini central host after a power cut or an update, runs no daemon until someone logs in: the phone and the other hosts cannot reach it, and its sessions are not restored.

This adds a second switch, "Start moonletd at system start, before login". With an administrator's password, the app writes a launch daemon plist to `/Library/LaunchDaemons` that runs the user's `moonletd` as that user (`UserName`). At boot, launchd starts it. That daemon serves sessions, terminals and heavy commands before login. Nothing of moonlet runs as root (see Security considerations).

A daemon started at boot can never read the user's login Keychain, before login or after (see Findings). Claude keeps its sign-in there, so before login a chat waits. When the user logs in, the X56 login item starts a daemon in the login session, which takes every terminal over from the boot daemon and restarts the chats with the Keychain available. Settings explains how automatic login shortens that wait, and when Tailscale or FileVault stop the Mac being reachable before login.

## User journey

1. On their Mac mini, a user opens Settings › App › General › Background daemon and turns on "Start moonletd at system start". macOS asks for an administrator's password. macOS may show its "Background Items Added" notice naming moonlet.
2. The line reads "Starts at system start · moonlet in System Settings › Login Items". If Tailscale is the App Store or Standalone app, a second line says "Tailscale joins the tailnet only after login. To reach this Mac before then, use tailscaled." If FileVault is on, it says "FileVault is on: after a restart nothing starts until someone unlocks the disk."
3. The Mac restarts and nobody logs in. From the phone, the user sees the Mac mini online. Its sessions and terminals are back, and heavy commands from other hosts run on it.
4. They start a Claude chat from the phone. It shows "Claude starts once you log in on studio-mini" and waits.
5. The user logs in on the Mac mini. Within a few seconds the chat starts. Every terminal is still running.

## Behaviour and acceptance criteria

### The launch daemon plist

- [ ] The app writes `/Library/LaunchDaemons/dev.onedevstudio.moonlet.boot.<uid>.plist`, owned by root and mode 0644, one per user who turns the switch on. Its keys (Test: `the_boot_plist_runs_moonletd_as_its_user`, which also passes `plutil -lint`):
  - `Label` `dev.onedevstudio.moonlet.boot.<uid>`;
  - `Program` the running app's own `moonletd` (`…/moonlet.app/Contents/MacOS/moonletd`), `ProgramArguments` `moonletd daemon --boot`;
  - `UserName` and `GroupName` the user's, `InitGroups` true, `WorkingDirectory` their home;
  - `EnvironmentVariables` `HOME`, `USER`, `LOGNAME`, `SHELL` from the account and a system `PATH`: launchd sets none of them for a daemon (Findings);
  - `RunAtLoad`, `KeepAlive {SuccessfulExit: false}`, `ProcessType Interactive`;
  - `AssociatedBundleIdentifiers` `dev.onedevstudio.moonlet`, so Login Items shows moonlet's name.
- [ ] The privileged step is one `do shell script … with administrator privileges`. It writes the plist from base64 inside the command (`/usr/bin/base64 -D`), with `umask 022`, to the fixed path, then `chown root:wheel`. It never copies a file the user can write, and the command holds only base64 and fixed paths. Test: `the_privileged_command_writes_only_the_plist`.

### The daemon started at boot

- [x] The daemon, already its user, reads `~/.moonlet/app.toml`: only `start_daemon_at_boot = true` lets it serve, and anyone else's daemon exits 0 without listening, so a plist left behind starts nothing. Tests: `only_users_who_turned_it_on_get_a_daemon`, `the_boot_choice_is_read_from_app_toml`.
- [x] Without a `TMPDIR`, the daemon sets the user's own temporary folder (`confstr(_CS_DARWIN_USER_TEMP_DIR)`, as `getconf DARWIN_USER_TEMP_DIR` prints it), so its terminals and agents get the one a login gives. Test: `a_boot_daemon_gives_its_terminals_the_users_temporary_folder`.
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

- [ ] Settings › App › General › Background daemon gets "Start moonletd at system start" under the X56 switch. It is shown only for the login-item mechanism (release and `pnpm bundle` builds) and is disabled, with "Needs Start the moonlet daemon at login", while that switch is off: without the login item nothing takes over at login. An app outside `/Applications` says "Move moonlet to Applications first", as X56 does. Vitest: "offers start at system start only with the login item on".
- [ ] Turning it on saves `start_daemon_at_boot = true` in `~/.moonlet/app.toml`, then asks for the password and writes the plist. A cancelled password puts the choice back to off. Tests: `the_boot_choice_is_kept_in_app_toml`; the password: M13.
- [ ] Turning it off saves `start_daemon_at_boot = false` at once, so a boot daemon started from the plist exits without serving. Then the app asks for the password to delete the plist; it never boots the job out, so no running daemon stops. Cancelled, the plist stays, harmless, and the line offers **Remove**. M13.
- [ ] Its line follows the plist and Login Items (Vitest: "says what starts moonletd at system start"; Rust: `the_boot_state_follows_the_plist`):
  - the plist is the one the app would write and Login Items allows it: "Starts at system start · moonlet in System Settings › Login Items";
  - switched off in Login Items (`SMAppService.statusForLegacyPlist`): "Turned off in System Settings › Login Items", with **Open Login Items**;
  - the plist differs, as when the app moved: "Points at another copy of moonlet", with **Repair** (the password again);
  - choice off but the plist still there: "Not starting at system start", with **Remove**;
  - no plist: no line.
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
- Tauri command `daemon_boot` with `install | uninstall | status`, returning `{ state }`: `on`, `requires_approval`, `stale`, `left_behind` or `off`, and the warnings that apply. `open_login_items` is reused.

## Data and config

- `~/.moonlet/app.toml`, key `start_daemon_at_boot` (bool), missing until the user changes the switch. The same rules as `start_daemon_at_login` apply.
- `/Library/LaunchDaemons/dev.onedevstudio.moonlet.boot.<uid>.plist`, written by the app with an administrator's password.

## Security considerations

- Nothing of moonlet runs as root. launchd starts `moonletd` as the user named in the plist, so the plist's `Program`, inside the user-writable app bundle, can only ever run with that user's rights: replacing it gains nothing.
- An earlier design ran a root launcher from the bundle through `SMAppService.daemon`, whose sealed plist cannot name the user. The commit security review found that any process of the user's, such as an agent or a package script in a moonlet terminal, could replace that binary and run as root at the next restart. Apple documents no protection for it: a `SpawnConstraint` "exists to prevent substitution" (DTS, forums 762200) but is not documented for `SMAppService` plists, and DTS advises a program run as root lives where only root can write (782026). The user chose the most secure option: no root at all.
- The privileged step writes the plist from content inside its own command, never from a temporary file: a process of the user's could swap such a file between its writing and its install and get a root-owned plist with no `UserName`.
- The plist lives where only root can write, so no process of the user's can change it to run something else, as someone else.
- `daemon.hand_over` hands every terminal to the caller. It is limited to a daemon started at boot, a peer of the same uid, and a peer running the same `moonletd` executable. The S3 upgrade signal already lets any process of the user hand the terminals to a binary of its choice, so this adds no new reach for a process of the user's.
- A daemon started at boot runs in a "mixed context" (Apple DTS): a user's process in the system's security session. Anything that needs the login session, such as the Keychain or the pasteboard, fails in it. That is why chats wait and login takes over.

## Out of scope

- After a logout without a restart, nothing runs until the next login or restart: the boot daemon already handed over.
- gh and git credentials in the Keychain: commands that need them fail before login, as they would over SSH.
- Linux hosts, which start at boot already (X58).
- Unlocking FileVault after a restart (macOS can do it over SSH with Remote Login on, or `fdesetup authrestart` before a planned restart).
- Dev and e2e builds: they have no bundle, so no switch.
- Supervising a boot daemon after a live upgrade (S3): the old daemon exits 0 once it hands over, so launchd is done with the job, and the new one runs detached, as under X56.
- `SMAppService.daemon`, `SpawnConstraint` and any root launcher (see Security considerations).

## Test plan

- **Rust (moonletd unit):** reading `start_daemon_at_boot`.
- **Rust (moonletd e2e, `crates/moonletd/tests/boot.rs`):** a `--boot` daemon says so, serves only when its user turned it on, sets `TMPDIR` and keeps `--boot` through an upgrade; a daemon started after it takes every terminal (same pid, same output) and the boot daemon exits 0; a takeover from another executable is refused; a failed takeover leaves the boot daemon serving; a chat waits in a boot daemon and starts after the takeover (with the test's fake `claude`).
- **Rust (desktop):** the plist the app writes, the privileged command, the state read back from the plist; the boot choice in `app.toml`.
- **Vitest:** the switch's lines for each state, the disabled state, the Tailscale, FileVault and automatic-login lines, the chat's waiting line, search terms.
- **e2e:** none, as for X56: e2e builds have no bundle, and writing a launch daemon needs an administrator's password. The card in each state is checked with `e2e/snap.ts`.
- **Manual, on a signed build in /Applications, in `docs/manual-checks.md` (M13):** turn the switch on and give the password; Login Items lists moonlet; restart (with FileVault on, `sudo fdesetup authrestart`) and do not log in; from the phone, the host is online and a terminal session runs; a chat says it waits for login; log in; the chat starts and the terminal keeps its pid; `launchctl print system/dev.onedevstudio.moonlet.boot.$UID` shows the job ran as the user (`ps -o user= -p` its pid before login) and is done, and `launchctl print gui/$UID/dev.onedevstudio.moonlet.moonletd` runs the daemon.

## Findings

From Apple's documentation and Apple DTS answers on the Developer Forums, read 2026-11-26:

- A daemon registered with `SMAppService.daemon` reads its plist from the read-only bundle, so `UserName` must be known in advance (forums thread 856568). Without it the daemon runs as root (751439). A plist in `/Library/LaunchDaemons` ("legacy") can name the user; Login Items lists it, by the app's name with `AssociatedBundleIdentifiers` when the team identifiers match ("Updating helper executables from earlier versions of macOS"), and `SMAppService.statusForLegacyPlist(at:)` reports whether it is allowed.
- `register()` asks for no password. macOS does not start the daemon until an administrator allows it in Login Items; until then the state is `requiresApproval` (`SMAppService.register()` documentation, forums 802443).
- A launch daemon runs in the global security context, not a login session's (TN2083). The data protection keychain is "only available in a user login context" (696431). Unlocking or using a user's login keychain from outside their login session is "not really a supported use case", with more hardening in recent macOS 26 releases (841695). Hence the takeover at login rather than Keychain access from the boot daemon.
- Tailscale's App Store and Standalone apps do not run before login; only `tailscaled` does (Tailscale KB 1065, "macOS variants").
- With FileVault on, the data volume stays locked until a user unlocks it at the pre-boot screen; `fdesetup authrestart` skips that once (`man fdesetup`).
- Claude Code on macOS keeps its sign-in in the Keychain (code.claude.com/docs/en/authentication).

A throwaway bundle on macOS 27.0.1 with FileVault on, signed ad hoc, registered with `SMAppService.daemon`, its root program dropping to the user before anything else (2026-11-26):

- `register()` failed with `SMAppServiceErrorDomain` 1 ("Operation not permitted") and the state became `requiresApproval`; allowing it in Login Items made it `enabled`, and launchd ran it at once. Before registering, the state read `notFound`, as X56 found for agents.
- launchd gave the root launcher only `PATH`, `XPC_SERVICE_NAME`, `XPC_FLAGS` and `OSLogRateLimit`: no `HOME`, `USER` or `TMPDIR`.
- After `sudo fdesetup authrestart`, at the login window (`/dev/console` owned by root, a minute after the restart and two before the login), the launcher ran and its child, dropped to uid 501: could not `setuid(0)` again; read `~/.moonlet` and `app.toml`; ran `zsh -l` (exit 0, the full login `PATH`, `git` and `gh` found). `TMPDIR` was empty.
- The Keychain refused the child both before login and while the user was logged in ("User interaction is not allowed"): a boot daemon never gets it, so the takeover at login is needed.
- The App Store Tailscale's CLI did not answer before login (timed out after 10 s), and failed while logged in ("The Tailscale GUI failed to start").
- With FileVault on, only `fdesetup authrestart` gets to the login window with the disk unlocked; a plain restart stops at the FileVault unlock, which logs the user in directly.
