# X69 — Update a tailnet host from the app

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** NFR distribution
- **Related ADRs:** [0011](../adr/0011-machines-connect-over-the-tailnet.md) (machines over the tailnet), [0014](../adr/0014-one-account-across-hosts.md) (headless hosts managed from the app)
- **Related specs:** [X35](X35-in-app-update.md) (the app updates itself), [S3](S3-live-upgrade.md) (live upgrade), [X57](X57-tailnet-hosts.md) (tailnet hosts, `needs_update`), [X58](X58-linux-install-script.md) (Linux install script), [X56](X56-login-item.md) (login item), [R2](R2-remote-helper-install.md) (SSH hosts, which already update over SSH)

## Summary

Updating a tailnet host is manual today. When the MacBook updates and the Mac mini or a Linux VPS does not, the Hosts row reads "Update moonlet on studio-mini (it runs 0.1.26, this Mac 0.1.30)". The user then has to run `install.sh` on the Linux host, or open the app on the other Mac and click Settings › Updates. A headless host, which ADR 0014 wants managed from the app alone, has no one sitting at it to do that. This spec adds an **Update** button to the row. The host's own daemon downloads the release this Mac runs, checks its signature, installs it and hands its sessions to the new binary (S3), so every agent there keeps running.

## User journey

1. The MacBook updates to 0.1.34. The Mac mini and `build-box` (Linux) still run 0.1.33.
2. A toast says "2 hosts run an older moonlet" with **Update all**. Settings › Machines › Hosts shows **Update all (2)** above the list, and each host's row has an **Update to 0.1.34** button next to **Retry**. The sidebar notice under each host gets the same button.
3. The user clicks it on `build-box`. The button reads "Updating…". About 10 seconds later the row reconnects and reads "Connected · moonletd 0.1.34 · 3 sessions". The agents that ran on `build-box` are still running.
4. The user does the same on the Mac mini (or clicked **Update all** and both run at once). The daemon there replaces `/Applications/moonlet.app` and hands over to the new bundle's `moonletd`. The moonlet app open on the mini notices that its bundle on disk is now 0.1.34 and restarts itself into it. If it has unsaved edits (a file tab, a design page), it doesn't restart: its footer shows "Restart to update" until someone there clicks it.
5. A host still on 0.1.33 or older came before this spec, so it cannot update itself. Clicking the button there shows the manual way, as today: "studio-mini runs 0.1.33, which can't be updated from here. Update it from its Settings › Updates.", or the `install.sh` command with **Copy** for Linux.

## Behaviour and acceptance criteria

### The daemon updates itself

- [ ] `daemon.update {version}` installs release `version` of moonlet on this host and hands every session to its `moonletd` (S3). It answers once the new files are in place and the handoff has started: `{from, to}`, with this daemon's version and `version`.
- [ ] It downloads from the release for `v<version>` only (`https://github.com/1devstudio/moonlet/releases/download/v<version>/…`), never from `latest`. The host therefore ends up running exactly what the Mac that asked runs.
- [ ] A `version` that is not newer than the daemon's own fails with `not_newer` and changes nothing. A version that is not `X.Y.Z` fails with `invalid_params`.
- [ ] **Linux and `~/.moonlet/bin`:** a daemon that runs as `~/.moonlet/bin/moonletd` takes `moonlet-linux-<arch>.tar.gz` and its `.sig`. It installs each binary the way `install.sh` does (X58): written to `~/.moonlet/bin/<name>.new` with `umask 077`, then renamed into place. It then runs the live upgrade. Under systemd the unit stays `active` and follows the new pid (`MAINPID=`, X58).
- [ ] **Mac app bundle:** a daemon that runs from `<bundle>.app/Contents/MacOS/moonletd` takes `latest.json`'s `darwin-aarch64` entry from the `v<version>` release, the same `.app.tar.gz` and signature that the app's updater (X35) uses. It unpacks the archive next to the bundle, swaps the two folders, and hands over to the new bundle's `moonletd`. The old bundle is removed only after the new daemon answers. If the handoff fails, the old bundle is put back.
- [ ] A daemon that runs from anywhere else (a dev build, `cargo run`, a test) fails with `unsupported` and changes nothing.
- [ ] Every archive is checked against the minisign public key compiled into `moonletd` (the same key as `tauri.conf.json`) before anything is unpacked. A missing or wrong signature fails with `bad_signature`, and nothing is written outside a temporary folder that is then removed.
- [ ] A download that fails, or is not a release asset (404), fails with `download_failed` and its message.
- [ ] One update or upgrade at a time: during one, another `daemon.update`, or a `daemon.upgrade` on the local socket, fails with `busy`. An update that fails before the handoff leaves the daemon serving, as a failed S3 upgrade does.
- [ ] Every session keeps its id and its processes, and an agent working through the update carries on.

### Who may ask

- [ ] `daemon.update` answers only a paired **Mac** over the tailnet (a `desktop` device) and the Mac's own app on the local socket. A phone, a cloud machine (X63) and an agent's CLI get `forbidden`. A phone routed to an SSH host gets `forbidden` from the Mac.
- [ ] `daemon.upgrade` and `daemon.shutdown` stay local-socket only, which was fixed before this spec. `daemon.update` takes no path, only a version.

### Across protocol versions

- [ ] `daemon.update` also works when the two sides speak different protocols, the case `needs_update` is about. After `authed`, a client may send the request `{"t": "request", "id": 1, "method": "daemon.update", "params": {"version": "0.1.34"}}` in place of `hello`. The daemon answers it as above, whatever protocol the client speaks, and then closes the connection.
- [ ] This form never changes: the message type, the method name, `version`, the reply `{from, to}` and the error codes stay as they are for every later protocol version. `moonlet-proto` has a test that pins the bytes.
- [ ] A daemon from before X69 answers anything but `hello` by closing the connection. The client then reports `too_old`: "<host> runs moonlet <version>, which can't be updated from here", followed by the manual way (X58).

### The app

- [ ] A tailnet host row gets **Update to <this Mac's version>** when the host's `daemon_version` is older than the app's, whether it is `needs_update` or `connected` (same protocol, older version). A host that is newer, a host with no `daemon_version`, an SSH host (which has **Reinstall**, R2) and a phone get no button.
- [ ] While an update runs, the button reads "Updating…" and is disabled. A host that comes back newer, or any reconnect after the reply, clears it. When there is no reconnect within 60 s, the row shows the error "<host> did not come back after the update".
- [ ] An error shows on the row with its message. `too_old` keeps today's manual text (the `install.sh` command with **Copy** for Linux, Settings › Updates for a Mac).
- [ ] The sidebar notice for a host (R4) offers the same button.

### Update all

- [ ] When at least one tailnet host could get the button above, Settings › Machines › Hosts shows **Update all (<n>)** above the list. It starts `daemon.update` on every such host at once; each row then shows its own state, as if its button had been clicked. A host that fails doesn't stop the others.
- [ ] The first time the app finds older hosts after it starts as a new version, a toast says "<n> hosts run an older moonlet" ("studio-mini runs an older moonlet" for one) with **Update all**. It doesn't come back for that app version, as X35's update toast doesn't.

### The app on an updated Mac restarts itself

- [ ] Each time the app connects to its own daemon (at launch and after every reconnect, which a live upgrade causes), it reads the version of its bundle on disk (`Contents/Info.plist`, `CFBundleShortVersionString`). It reads it the same way when the connection is refused with `protocol_mismatch`, so this works when the protocol changed too.
- [ ] When the bundle on disk is newer than the running app, the app relaunches into it (`relaunch`, as X35's "Restart to update"). Sessions are the daemon's, so every terminal and agent is still there after the relaunch.
- [ ] Before relaunching, the app checks for unsaved edits (a dirty file tab, X26, or a design page with unsaved changes, X65). If there are any, it doesn't relaunch. Its footer button reads "Restart to update", as X35's does, and nothing is lost.
- [ ] A dev or e2e build, which has no bundle to read, never relaunches this way.

## UI

Settings › Machines › Hosts, a tailnet host row:

    build-box      Update moonlet on build-box (it runs 0.1.33, this Mac 0.1.34)   [Update to 0.1.34] [Retry]
                   Updating…                                                       [◌ Updating…]
                   Connected · moonletd 0.1.34 · 3 sessions
                   build-box runs moonlet 0.1.32, which can't be updated from here: run this there
                   [curl -fsSL …/install.sh | sh]  [Copy]

A connected but older host (same protocol):

    studio-mini    Connected · moonletd 0.1.33 · 2 sessions                         [Update to 0.1.34]

## Protocol and RPCs

- **`daemon.update {version}` → `{from, to}`**, new. The app's relaunch needs no RPC: the app reads its own bundle. Errors: `forbidden`, `invalid_params`, `not_newer`, `unsupported`, `download_failed`, `bad_signature`, `install_failed`, `busy`, `too_old` (client side only).
- **Before `hello`:** the one request above, on a tailnet connection after `authed`.
- `PROTOCOL_VERSION` stays: the method is new, and the pre-`hello` request only adds to what a daemon accepts.
- `docs/protocol.md` documents both forms and states that the pre-`hello` form never changes.

## Data and config

- `moonletd` gains the minisign public key, read at build time from `apps/desktop/src-tauri/tauri.conf.json` so the two never differ.
- **Release workflow:** signs `moonlet-linux-x86_64.tar.gz` and `moonlet-linux-aarch64.tar.gz` with the updater key (`TAURI_SIGNING_PRIVATE_KEY`) and uploads each `.sig`. `SHA256SUMS` stays for `install.sh`.
- Downloads go to a temporary folder under `~/.moonlet/run/`, removed when done or failed.
- A test-only seam (`MOONLET_RELEASES`, honoured only in debug builds) points the daemon at a fake release server. Release builds always use GitHub and the built-in key.

## Security considerations

- The request is a version, not a path or URL. The host decides where it downloads from and checks the signature itself, so a paired Mac can only make the host install a release signed by moonlet's key, and only one newer than it runs.
- Only `desktop` devices may ask. A phone that holds a token can't swap the code a headless host runs.
- Without signed Linux archives, the HTTPS download from GitHub would be the only guard, so this spec requires them.
- Downgrades are refused (`not_newer`), so an old release with a known bug can't be pushed onto a host.
- The `MOONLET_RELEASES` seam is compiled out of release builds, so an environment variable can't change the source or the key.
- The Mac bundle swap keeps the old bundle until the new daemon answers, so a broken archive can't leave the host without moonlet.

## Out of scope

- SSH hosts: **Reinstall** (R2) already updates them over SSH.
- Updating a host from the phone (X40).
- Hosts that are not this Mac's Hosts rows, such as other members of the account (X68) seen only through the central host.
- Release channels, skipping a version, and updating to a version other than this Mac's.
- Updating hosts automatically without a click when the Mac updates. **Update all** and its toast still need the user.

## Test plan

- **Rust, `moonletd` integration (`tests/update.rs`):** a fake release server on 127.0.0.1, with archives signed by a test key passed through `MOONLET_RELEASES` (debug builds), serving `v9.9.9` whose archive holds the built `moonletd` and `moonlet`. The daemon runs from a scratch `~/.moonlet/bin/moonletd`.
  - `daemon.update {version: "9.9.9"}` from a paired `desktop` device answers `{from: <workspace version>, to: "9.9.9"}`; a session running `sleep 600` keeps its id and pid; `daemon.info` answers from a new pid; `~/.moonlet/bin/moonletd` is the archive's file.
  - The same request before `hello`, with no `hello` sent, gets the same reply, then the connection closes.
  - A phone, a cloud machine and the CLI get `forbidden`; a routed phone gets `forbidden` from the Mac.
  - A tampered archive gives `bad_signature`, and the binary and pid are unchanged; a 404 gives `download_failed`; `0.0.1` gives `not_newer`; a daemon run from `target/debug` gives `unsupported`; a second request during the first gives `busy`.
- **Rust unit (`moonletd`):** the Mac bundle swap on a fake `.app` folder in a temp dir (new bundle in place, old one restored when the handoff fails, removed after it succeeds), and the asset choice per layout, os and arch.
- **Rust unit (`moonlet-proto`):** the pre-`hello` request and its reply, pinned as literal JSON.
- **Vitest (`hostUpdate.test.ts` or `settingsPage.test.ts`):** which hosts **Update all** takes and its count; the toast's text for one and for several hosts, and that it shows once per app version; one failed host leaves the others running.
- **Vitest (`updater.test.ts`):** the decision to relaunch: a newer bundle on disk relaunches; the same or an older one doesn't; unsaved edits give "Restart to update" instead; a dev build (no bundle version) never relaunches.
- **Vitest (`settingsPage.test.ts`):** `hostActions`/`updateAction` show **Update to 0.1.34** for older tailnet hosts in `needs_update` and `connected`, and not for newer, unknown, SSH or phone hosts; the "Updating…" state, its timeout line, and the `too_old` text for Linux and Mac with the literal strings above.
- **Release:** the workflow fails when a Linux archive has no `.sig`, or its `.sig` doesn't verify against the public key.
- **No e2e spec:** e2e builds are debug builds without a release to fetch. The Rust integration tests drive the whole path with a real daemon.
- **Manual, once two releases carry X69:** update the user's Mac mini and a Linux VPS from the MacBook over Tailscale with **Update all**; sessions and the login item (X56) survive; the mini's open app restarts into the new version, and with an unsaved file tab it shows "Restart to update" instead; `systemctl --user is-active moonletd` stays `active`.

## Decided

User decisions, 2026-10-27:

1. **The app window on an updated Mac host restarts.** The app relaunches into the new bundle by itself, unless it has unsaved edits, in which case it shows "Restart to update" (see "The app on an updated Mac restarts itself").
2. **Phones may not update a host.** Only a paired Mac, and the Mac's own app on the local socket.
3. **Update all.** One action updates every older tailnet host at once, offered in Settings and as a toast once per app version.
4. **The Mac's own app may call `daemon.update` on the local socket.**

## Open questions

- None.
