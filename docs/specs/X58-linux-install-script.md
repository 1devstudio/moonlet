# X58 — Install moonlet on a Linux host with one command

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** R2 (remote helper), journey J5
- **Related ADRs:** [0011](../adr/0011-machines-connect-over-the-tailnet.md) (this is its second slice), [0009](../adr/0009-central-host-workers-live-copies.md) (a Linux central host needs a systemd service)
- **Related specs:** [X57](X57-tailnet-hosts.md) (pairing over the tailnet), [R2](R2-remote-helper-install.md) (the same binaries, installed over SSH), [S3](S3-live-upgrade.md) (live upgrade), [X3](X3-distribution.md) (releases)

## Summary

Tailnet hosts (X57) cannot be installed by the app, so a Linux machine gets moonlet from a script published with every release:

```sh
curl -fsSL https://github.com/1devstudio/moonlet/releases/latest/download/install.sh | sh
```

The script:
- downloads the static `moonletd` and `moonlet` for the machine;
- checks their SHA-256 and installs them in `~/.moonlet/bin`, where R2 puts them too;
- runs the daemon as a systemd user service that starts at boot;
- turns on tailnet access;
- starts pairing, so the last thing it prints is the code to type on the Mac.

Running it again updates moonlet without ending any session.

## User journey

1. On the Linux server `build-box`, already on the tailnet, the user runs the command above.
2. The script prints:

   ```
   moonlet 0.1.27 for Linux x86_64
   ✓ Downloaded and checked moonletd and moonlet
   ✓ Installed in ~/.moonlet/bin
   ✓ moonletd runs as a systemd user service and starts at boot
   ✓ Tailnet access is on: listening on 100.88.1.20:47428

   Pair a Mac: in moonlet, Settings › Machines › Hosts › Add host, enter
     Name: build-box
     Code: 7KQ2M-X9PDA      (expires in 5:00)
   ```

3. The user types the name and code on the MacBook (X57). The script prints "Paired with Alex's MacBook Pro" and exits.
4. Weeks later the MacBook's row for `build-box` reads "Update moonlet on build-box". The line offers the same command with **Copy**. The user runs it on `build-box`. The script upgrades the running daemon in place, and the agents running there carry on.

## Behaviour and acceptance criteria

### Release assets

- [ ] Every release publishes, next to the DMG:
  - `moonlet-linux-x86_64.tar.gz` and `moonlet-linux-aarch64.tar.gz`, each holding `moonletd` and `moonlet` built by `scripts/build-remote.sh`;
  - `SHA256SUMS`, with one line per archive;
  - `install.sh`.

  They are uploaded while the release is still a draft, so `releases/latest` never points at a release without them (as for `latest.json`).
- [ ] The `install.sh` published with release `vX.Y.Z` installs `X.Y.Z`. The workflow writes the version into the script. So `releases/latest/download/install.sh` installs the latest release, and `releases/download/v0.1.27/install.sh` installs 0.1.27.
- [ ] The release workflow fails if any of these assets is missing, or if a `SHA256SUMS` line does not match its archive.

### The script

- [ ] It runs with POSIX `sh`. It needs `curl` or `wget`, `tar`, and `sha256sum` or `shasum`. A missing tool stops it with "moonlet's installer needs curl or wget." (or the tool it lacks), and nothing is installed.
- [ ] `uname -sm` picks the archive: `Linux x86_64` → x86_64; `Linux aarch64` or `Linux arm64` → aarch64. On macOS it stops with "On a Mac, install moonlet.app from https://github.com/1devstudio/moonlet/releases/latest." Any other system stops with "moonlet runs on Linux x86_64 and aarch64, not <uname -sm>."
- [ ] It downloads the archive and `SHA256SUMS` from the same release into a fresh temporary directory, which it deletes at exit. If the archive's SHA-256 is not the one in `SHA256SUMS`, it stops with "The download of moonlet-linux-x86_64.tar.gz is damaged (checksum mismatch). Nothing was changed."
- [ ] It installs each binary as R2 does: written to `~/.moonlet/bin/<name>.new` with `umask 077`, then moved into place. An SSH host's version check (R2) therefore sees the same binaries.
- [ ] When `~/.moonlet/bin/moonletd --version` already prints the version being installed, it skips the download and says "moonlet 0.1.27 is already installed." `--force` installs anyway.
- [ ] It never uses `sudo` and never writes outside `~/.moonlet`, `~/.config/systemd/user` (or `$XDG_CONFIG_HOME/systemd/user`) and the temporary directory.
- [ ] Options:
  - `--no-pair` skips pairing;
  - `--uninstall` stops and removes the service and the binaries, keeps `~/.moonlet`'s data, and says how to delete it;
  - `--from <dir>` takes the archives and `SHA256SUMS` from a folder instead of the release, for tests and offline machines.

### The service

- [ ] `moonletd service install`, `uninstall` and `status`, today macOS's LaunchAgent (ADR 0004), manage a systemd user unit on Linux, at `~/.config/systemd/user/moonletd.service` (or under `$XDG_CONFIG_HOME`). `install` writes the unit, then runs `systemctl --user daemon-reload` and `systemctl --user enable --now moonletd`. The unit, with the binary's absolute path:

  ```ini
  [Unit]
  Description=moonlet daemon
  After=network-online.target

  [Service]
  Type=notify
  NotifyAccess=all
  ExecStart=/home/alex/.moonlet/bin/moonletd daemon
  Restart=on-failure
  RestartSec=2

  [Install]
  WantedBy=default.target
  ```

- [ ] With `NOTIFY_SOCKET` set, the daemon sends `READY=1` once its socket is bound. A daemon that takes over in a live upgrade (S3) sends `MAINPID=<its pid>` and `READY=1` before it answers the old daemon's handoff. systemd then follows the new daemon, and the sessions it adopted stay in the unit. Without `NOTIFY_SOCKET` nothing changes.
- [ ] The script runs `moonletd service install`, then `loginctl enable-linger` so the service starts at boot without a login. If lingering cannot be turned on, it says: "moonletd will stop when you log out. To keep it running, ask an administrator to run: sudo loginctl enable-linger alex"
- [ ] Without a systemd user instance (`systemctl --user` fails, for example in a container), the script starts the daemon with `moonletd start` and says "moonletd is running, but nothing will start it after a reboot."
- [ ] When a daemon is already running, the script runs the new `moonletd upgrade` (S3) instead of starting another. Every session keeps its id and its processes, and `systemctl --user is-active moonletd` stays `active`.

### Tailnet access and pairing

- [ ] The script runs `moonletd tailnet on` (X57) and prints its status line. Without a Tailscale address it prints "Tailscale is not running on this machine. Start it, then run: ~/.moonlet/bin/moonletd pair" and exits 0 without pairing, because the install itself worked.
- [ ] Unless `--no-pair` is given, the script then runs `moonletd pair` with the machine's tailnet name as the name to type. That name is the first label of the MagicDNS name from `tailscale status --json` when the `tailscale` command exists, and the host name otherwise. When stdout is not a terminal, it skips pairing and prints the `moonletd pair` command instead.
- [ ] The script is safe to pipe into `sh`. Its whole body is inside a function that is called on the last line, so a download cut off midway runs nothing.

### Updating from the app

- [ ] The `authed` reply (X57) also carries `os`: `macos` or `linux`.
- [ ] A Linux host in `needs_update` because it is older shows "Update moonlet on build-box: run this there", with the install command and **Copy**. A Mac host shows "Update moonlet on studio-mini from its Settings › Updates."

## UI

- **Settings › Machines › Hosts:** the `needs_update` line for a Linux host shows the command in a monospace field with **Copy**, as above.
- No other app UI. The script's output is the journey's text.

## Protocol and RPCs

- `authed` gains `os: "macos" | "linux"`.
- `moonletd service install|uninstall|status` work on Linux.
- The daemon speaks the systemd notify protocol when `NOTIFY_SOCKET` is set.
- `PROTOCOL_VERSION` stays.

## Data and config

- `~/.config/systemd/user/moonletd.service` (above).
- Release assets: `moonlet-linux-x86_64.tar.gz`, `moonlet-linux-aarch64.tar.gz`, `SHA256SUMS` and `install.sh`.
- The script lives in the repository as `scripts/install.sh`. The packaging for both the release and the tests is `scripts/package-linux.sh`, which writes the archives and `SHA256SUMS` into a folder.

## Security considerations

- `curl | sh` trusts the GitHub release and TLS. The checksum catches a damaged or truncated download, but not a release someone replaced, because the sums come from the same place. Signing the helpers (`docs/release.md`, "Still open") is what would prove where they came from. This spec leaves it open, and the script's output says nothing that suggests otherwise.
- The script runs as the user, never with `sudo`, and writes only to the user's own folders.
- Tailnet access is turned on by the install. The listener stays limited to Tailscale addresses, and only paired devices get in (X39, X57).
- Anyone who can run commands on the host can run `moonletd pair` (ADR 0011).

## Out of scope

- Signing the Linux helpers.
- Package managers (apt, Homebrew on Linux, Nix).
- Installing or configuring Tailscale.
- macOS without the app (headless `moonletd` on a Mac).
- Updating automatically.

## Test plan

- **Rust unit tests:**
  - `moonletd` `service` module: the systemd unit for `/home/alex/.moonlet/bin/moonletd` renders exactly the text above, and the unit path honours `XDG_CONFIG_HOME`;
  - the notify message: with a test datagram socket as `NOTIFY_SOCKET`, a daemon start sends `READY=1`, and a takeover sends `MAINPID=<pid>\nREADY=1` before its handoff reply.
- **CI, a new `linux-install` job in `test.yml` on `ubuntu-latest`:**
  - It builds the x86_64 helpers, packages them with `scripts/package-linux.sh`, and turns on lingering for the runner user, so `systemctl --user` works.
  - Install: `scripts/install.sh --from dist --no-pair` installs `~/.moonlet/bin/moonletd`, whose `--version` prints the workspace version; writes the unit above; and leaves `systemctl --user is-active moonletd` reporting `active`.
  - A damaged archive (one byte changed) stops the script with the checksum message, and `~/.moonlet/bin` is unchanged.
  - Update: with a session running `sleep 600` (created through `moonlet`), `install.sh --from dist --force --no-pair` keeps the session's id and pid in `session.list`, and the unit stays `active`. `systemctl --user show -p MainPID moonletd` names the new daemon's pid.
  - Running it again without `--force` prints "moonlet 0.1.27 is already installed." with the workspace version.
  - `--uninstall` removes the unit and the binaries and keeps `~/.moonlet/state.json`.
  - `uname` faked through `PATH` to print `Darwin arm64` gives the moonlet.app message; `FreeBSD amd64` gives the "runs on Linux" message.
- **Release workflow:** a step after packaging checks that the four assets exist and that `sha256sum -c SHA256SUMS` passes.
- **Vitest, `apps/desktop/src/lib/`:** the `needs_update` lines for a Linux host and a Mac host, with the literal texts above.
- **Manual:** run the published command on a real aarch64 Linux machine on the tailnet, pair the MacBook with the printed name and code, start a session there, run the command again from a later release, and check the session survived.

## Open questions

- **Does systemd follow the handover?** systemd's documentation says `MAINPID=` changes the service's main process and that `NotifyAccess=all` accepts it from any process in the unit. It does not describe a handover from one daemon to another. The CI update test decides this. If systemd still stops the unit when the old daemon exits, the fallback is `ExitType=cgroup` (systemd 250 and later). It keeps the unit running while any of its processes runs, at the cost of no restart after a crash that leaves agents behind.
