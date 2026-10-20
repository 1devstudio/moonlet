# X57 — Add a remote host over the tailnet

- **Status:** draft (the daemon's part implemented: pairing a desktop, the short code, `authed`'s fields and `mobile.unpair`)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** R1 (remote hosts), journey J5
- **Related ADRs:** [0011](../adr/0011-machines-connect-over-the-tailnet.md) (this is its first slice), [0008](../adr/0008-phone-link-over-tailscale.md) (the tailnet listener and `moonlet-link`)
- **Related specs:** [X39](X39-phone-pairing-and-link.md) (pairing and device tokens), [R1](R1-ssh-hosts.md)–[R4](R4-unified-hosts-sidebar.md) (SSH hosts), [X29](X29-chat-plus-menu-and-mcp.md) (MCP sign-in), [X41](X41-worker-link-and-project-identity.md) (uses this spec's connector)

## Summary

Adding a remote host no longer needs `~/.ssh/config`, SSH keys or a helper install. The remote machine already runs moonlet: moonlet.app on a Mac, or the Linux install from a later slice. It lets other machines on the tailnet connect, and shows a one-time pairing link and code. On this Mac you paste the link, or type the host's tailnet name and the code. The app pairs once, keeps the device token, and from then on reaches the host's daemon through its tailnet listener (X39), exactly as a phone does. Once connected, a tailnet host works like an SSH host: sidebar, sessions, files, git, notifications. SSH hosts keep working under **Add an SSH host**.

## User journey

1. On the Mac mini `studio-mini`, Settings › Machines › Hosts › This Mac has **Allow connections from my tailnet**. The user turns it on. The line under it reads "Listening on 100.101.102.103:47428".
2. The user clicks **Let another Mac connect**. The card shows a code (`7KQ2M-X9PDA`), the `moonlet://pair?…` link with **Copy**, and "Expires in 5:00".
3. On the MacBook, Settings › Machines › Hosts › Remote hosts › **Add host** opens a dialog with "Pairing link or code". The user pastes the link. The dialog fills in the name `studio-mini` from it.
4. The user clicks **Add**. The row reads "Pairing…", then "Connected · moonletd 0.1.26 · 0 sessions". The sidebar now has a `studio-mini` header, and the Add repository dialog offers `studio-mini`.
5. On the Mac mini, the code goes away. The card says "Paired with Alex's MacBook Pro", and the MacBook is listed under "Macs that can connect".
6. Later the MacBook updates to a moonlet with a new protocol and the mini does not. The row reads "Update moonlet on studio-mini (it runs 0.1.26, this Mac 0.1.30)".
7. On a Linux server, the user runs `moonletd pair` instead of steps 1–2, and types `build-box` and the printed code into the dialog.

## Behaviour and acceptance criteria

### Pairing a desktop (daemon)

- [x] The `auth` frame gains an optional `kind`, `"phone"` (the default) or `"desktop"`, read only together with `pair`. The new device is stored with that kind. Devices in `mobile.json` without a kind are phones. (`a_mac_pairs_as_a_desktop`, `a_device_paired_before_x57_is_a_phone`)
- [x] `mobile.status` lists every device with its `kind`. (`a_mac_pairs_as_a_desktop`)
- [x] Every `authed` reply carries the daemon's `protocol`, `daemon_version` and `host` (the host label, as in `mobile.pair_start`). They are sent before `hello`, so a client learns the daemon's version even when their protocols differ. Phone apps that do not read these fields keep working. (`authed_says_which_daemon_answered_before_hello`; the phone's `tests/macs.rs` talks to a daemon from before X57)
- [x] A paired desktop gets exactly what a paired phone gets: X39's rules apply to every tailnet connection, whatever its kind. In particular `mobile.*` methods other than `mobile.hosts` and `mobile.unpair` are refused with `forbidden: manage phones from the Mac`. (`a_paired_mac_can_remove_itself_but_manage_nothing_else`)
- [x] `mobile.unpair` on a tailnet connection removes the calling device, as `mobile.revoke` would, and its connection closes. It is refused on the Unix socket with `invalid_params: not a paired device`. (`a_paired_mac_can_remove_itself_but_manage_nothing_else`)

### A shorter pairing code

- [x] `mobile.pair_start` makes a code of 10 characters from Crockford's base32 alphabet (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), 50 random bits, shown as two groups of five: `7KQ2M-X9PDA`. The link carries it without the dash. This replaces X39's 32 hex characters for phones too. One use, 5 minutes, 5 wrong attempts and the 1 s delay after a wrong one stay as in X39. (`a_pairing_code_is_ten_crockford_characters`, `a_paired_phone_comes_back_with_its_token_and_uses_the_daemon`)
- [x] The daemon compares codes after normalizing what the client sent: uppercase, spaces and dashes removed, `O` read as `0`, and `I` and `L` read as `1`. So `7kq2m x9pda` and `7KQ2MX9PDA` are both accepted. (`typed_codes_are_read_the_way_people_type_them`; the daemon test pairs with the code in lowercase with a space)
- [x] The phone's link parser accepts the new code. It still accepts 32 hex characters, so a new phone can pair with a Mac that has not updated yet. (`pairLink.test.ts`)
- [x] When this ships, X39's `mobile.pair_start` criterion is updated to the new code.

### Pairing from a terminal

- [ ] `moonletd tailnet on`, `moonletd tailnet off` and `moonletd tailnet status` call `mobile.set_enabled` and `mobile.status` on the running daemon. `status` prints the X39 status line, such as `Listening on 100.101.102.103:47428`.
- [ ] `moonletd pair` calls `mobile.pair_start` and prints:
  - the code, as `7KQ2M-X9PDA`,
  - the link,
  - "Expires in 5:00",
  - a QR code of the link when stdout is a terminal.

  It then waits. On `mobile.paired` it prints "Paired with <device>" and exits 0. On `mobile.pair_ended` it prints X39's reason and exits 1. Ctrl-C calls `mobile.pair_cancel`.
- [ ] With tailnet access off, `moonletd pair` exits 1 with "Tailnet access is off. Run `moonletd tailnet on` first." Without a Tailscale address it exits 1 with "Tailscale is not running on this machine."

### Adding a host (app)

- [ ] The Add host dialog takes one input, "Pairing link or code":
  - a `moonlet://pair?…` link (parsed as the phone parses it) gives the name, addresses and code;
  - anything else is a code. After the normalization above it must be 10 characters of the alphabet, otherwise the dialog says "This is not a pairing link or code." For a code, the dialog also asks for "Name on your tailnet", such as `studio-mini` or `build-box:47500`.
- [ ] For a typed name, the app resolves it with the system resolver and keeps only the Tailscale addresses (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), with the given port or 47428. When it resolves to no Tailscale address, the code is not sent, and the dialog says "studio-mini is not on your tailnet (it resolves to 203.0.113.7)." or "studio-mini was not found. Is Tailscale running on this Mac?"
- [ ] Addresses from a pasted link are used as given, because the host itself wrote them.
- [ ] The host's id and label are its name. A name already used by another host is refused with "A host named studio-mini already exists."
- [ ] The app pairs with `auth {pair, device: <this Mac's name>, kind: "desktop"}`. On `authed` it saves the host and connects. On failure the dialog shows the daemon's message, X39's `this phone is not paired with this Mac` reading "The code was not accepted. Start pairing again on studio-mini.", and nothing is saved.

### Connecting (app and `moonlet-link`)

- [ ] `moonlet-link` gains a tailnet `Connector`, moved from the phone app's `MacConnector` so that the desktop, the phone and X41's worker share it. It tries each address in order, 5 s each, sends `auth {token}`, and waits up to 10 s for the answer.
- [ ] An `authed` whose `protocol` differs from the client's puts the host in a new status, `needs_update`, carrying the daemon's version. Like `needs_install`, it waits for a retry and does not reconnect by itself.
- [ ] An `unauthorized` answer puts the host in `error` with "studio-mini no longer accepts this Mac. Pair it again." It does not reconnect until the user retries.
- [ ] Any other failure (no address answers, the connection drops) reconnects with `moonlet-link`'s backoff, as SSH hosts do (R3).
- [ ] After `authed` the connection is a normal host connection: R3's reconnect banner, R4's sidebar grouping, notifications that name the host, the palette and the approval inbox all work for tailnet hosts.
- [ ] **Remove** on a tailnet host calls `mobile.unpair` when the host is connected, then forgets the host and its token. When the host is not connected, it forgets them only, and the dialog says "studio-mini will still list this Mac until you remove it there."

### What differs from SSH hosts

- [ ] A tailnet host has no Install helper or Reinstall helper button.
- [ ] "Open in" offers no editors for workspaces on a tailnet host, because VS Code's and Cursor's `ssh-remote+` needs SSH (ADR 0011).
- [ ] On a tailnet host, an MCP sign-in whose `redirect_uri` is a `localhost` port (X29) is not started. The card says "Signing in to <server> isn't available for sessions on studio-mini yet." Sign-ins without a local callback work as before.
- [ ] Phones keep routing only to SSH hosts: `mobile.hosts` lists only the SSH hosts in `app-hosts.json`.

## UI

- **Settings › Machines › Hosts › This Mac** gains:
  - **Allow connections from my tailnet**, the setting the Phones page calls "Allow phones on my tailnet" today, which both pages now show under the new name;
  - the X39 status line;
  - **Let another Mac connect**, which shows the grouped code, the link with Copy, "Expires in m:ss" and Cancel, then "Paired with <device>" or X39's ending reason;
  - "Macs that can connect": devices of kind `desktop`, each with `paired <when> · connected` or `last seen <when>` and **Remove** (X23 confirm: "Remove <device>?", "It will need to be paired again.").
- **Settings › Machines › Phones** lists only devices of kind `phone`. Its pairing works as before.
- **Settings › Machines › Hosts › Remote hosts:**
  - **Add host** opens the dialog above. Below its input, **Add an SSH host** switches the dialog to today's alias input with `~/.ssh/config` suggestions (R1).
  - A tailnet host's row shows a `Tailnet` tag and its status line:
    - `Pairing…`
    - `Connected · moonletd <version> · <n> sessions`
    - `Update moonlet on studio-mini (it runs 0.1.26, this Mac 0.1.30)`, or `Update moonlet on this Mac (studio-mini runs 0.1.30)` when the host is newer
    - the error, with **Retry**, or **Pair again** for "no longer accepts this Mac"
  - **Remove** works as described above.
- **Sidebar:** `needs_update` shows like `error` (R4), with the Settings line as the dot's tooltip and **update** opening Settings at the host.

## Protocol and RPCs

- **`auth`** gains `kind?: "phone" | "desktop"`.
- **`authed`** gains `protocol: number`, `daemon_version: string` and `host: string`.
- **`mobile.status`:** each device gains `kind`.
- **New method:** `mobile.unpair` (tailnet connections only).
- **`moonlet-link`:** `HostStatus` gains `needs_update`, and the crate gains the tailnet `Connector`.
- **CLI:** `moonletd tailnet on|off|status` and `moonletd pair`. They connect as clients `moonletd-tailnet` and `moonletd-pair`, following `moonletd status` (`moonletd-status`). The daemon refuses `mobile.*` only to `moonlet-cli` (`daemon.rs:429`), so it serves these as it serves the app.
- **Desktop (Tauri) commands:**
  - `host_pair {input, name?}` returns the new host or the dialog's error;
  - `host_list` entries gain `kind: "ssh" | "tailnet"`.
- `PROTOCOL_VERSION` stays. The Unix socket protocol is unchanged, and the new fields appear only on tailnet connections. `docs/protocol.md` gets the new fields and method.

## Data and config

- `~/.moonlet/mobile.json`: each device gains `kind`. A missing kind reads as `phone`.
- `~/.moonlet/app-hosts.json` is written with mode 0600, because it now holds tokens. `remotes` stays as it is, so phones' routing and older builds keep reading it:

  ```json
  {
    "remotes": ["build-box-ssh"],
    "tailnet": [
      {
        "id": "studio-mini",
        "device_id": "…",
        "addrs": ["100.101.102.103:47428"],
        "token": "…"
      }
    ]
  }
  ```

## Security considerations

- A typed name sends the code only to a Tailscale address, so a typo that resolves to a public host cannot receive it. The tailnet encrypts the pairing, and X39's limits apply: one use, 5 minutes, 5 wrong attempts.
- A desktop token gives the same full access as a phone token (X39). It is stored in `app-hosts.json` with mode 0600 inside the private `~/.moonlet`, as X41 stores the worker's token in `link.json`. The webview never receives it, and `host_list` does not include it.
- On the host, a paired desktop cannot pair, list or remove other devices. It can only remove itself.
- `moonletd pair` runs on the host, so anyone who can run commands there, including an agent, can start a pairing. That is X39's accepted boundary for client names (ADR 0011). The code is still useless without a device on the tailnet.

## Out of scope

- The Linux install script, the systemd service and publishing the Linux helpers (the next slice of ADR 0011).
- Carrying MCP sign-in callbacks to tailnet hosts.
- Trusting devices by their Tailscale account instead of pairing.
- Moving existing SSH hosts to the tailnet.
- Renaming the `mobile.*` methods and `mobile.json` (decided below).

## Test plan

Every criterion maps to a test. Expected values are literals from this spec.

- **Rust unit tests:**
  - `moonletd` mobile module: a device paired with `kind: "desktop"` is stored and listed as `desktop`; a `mobile.json` device without `kind` reads as `phone`.
  - The tailnet address filter on resolved names: `studio-mini` resolving to `[100.101.102.103]` gives `["100.101.102.103:47428"]`; `build-box:47500` gives port 47500; `[203.0.113.7]` gives the "not on your tailnet" error with that address; no result gives "was not found".
  - `app-hosts.json`: the round trip keeps `remotes` and `tailnet`, the file's mode is 0600, and `host_list` output contains no `token`.
- **`crates/moonlet-link/tests/link.rs`** (against a `TestDaemon` listening on 127.0.0.1 through `MOONLET_MOBILE_ADDRS`):
  - pairing with a code returns a token, and connecting with it reaches `connected`;
  - a fake daemon whose `authed` says `protocol: 99, daemon_version: "9.9.9"` gives `needs_update` with `9.9.9`, and no reconnect follows until a retry;
  - after `mobile.revoke`, the host goes to `error` with "studio-mini no longer accepts this Mac. Pair it again." and does not reconnect.
- **`crates/moonletd/tests/mobile.rs`:**
  - `authed` carries `protocol`, `daemon_version` and `host`;
  - a desktop device is refused `mobile.pair_start`, `mobile.revoke` and `mobile.status` with `forbidden`;
  - `mobile.unpair` removes the calling device and closes its connection, and is refused on the Unix socket.
- **Rust unit tests for the code:** a made code is 10 characters of the alphabet. Normalizing turns `7kq2m x9pda`, `7KQ2M-X9PDA` and `7KQ2MX9PDA` into `7KQ2MX9PDA`, and `OIL` into `011`. Display of `7KQ2MX9PDA` is `7KQ2M-X9PDA`.
- **`crates/moonletd/tests/mobile.rs`, the code:** pairing with the lowercase, spaced form of the code works. The existing X39 tests run unchanged with the new code.
- **`crates/moonletd/tests/cli.rs`** (new): `moonletd pair` against a test daemon prints a code matching `^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$` and a `moonlet://pair?v=1&` link, then exits 0 with "Paired with Test Mac" when a TCP client pairs with that code. It exits 1 with the "Tailnet access is off" line when access is off.
- **Vitest, `apps/desktop/src/lib/`:**
  - `pairLink.test.ts` moves here from the phone app, and the phone imports `parsePairLink` from `@desktop/lib/pairLink`. Its existing link with the 32 hex characters still parses, and a link with `code=7KQ2MX9PDA` parses too;
  - the Add host input: a link, `7KQ2M-X9PDA`, `7kq2m x9pda`, and `hello`, which gives "This is not a pairing link or code.";
  - the status line for each tailnet state, including both `needs_update` directions with the literal lines above;
  - "Open in" offers nothing for a tailnet host and VS Code and Cursor for an SSH host;
  - the MCP sign-in message for a tailnet host with a `localhost` redirect, and no message without one.
- **e2e, `apps/desktop/e2e/specs/tailnet-host.e2e.ts`:** a crucial feature (adding a host is how sessions start on it). The fixture starts a second scratch daemon with tailnet access on 127.0.0.1 and gets a pairing link from it with `mobile.pair_start`. The spec:
  - pastes the link into Add host;
  - sees "Connected · moonletd";
  - sees the host in the sidebar and in the Add repository host picker;
  - removes it and sees the second daemon no longer list the device.
- **Manual:** pair the MacBook with the real Mac mini over Tailscale by name and code, open a session there, close the lid, and reopen it.

## Open questions

None open. Decided on 2026-10-20:

- **The `mobile.*` methods and `mobile.json` keep their names.** Only the UI text changes. Renaming would touch the phone app and the protocol and change no behaviour. The glossary records the exception.
- **The pairing code is shorter.** A 32 hex code is tedious to copy by hand from a server's terminal. 50 bits with one use, 5 minutes and 5 attempts leaves a guess no real chance.
