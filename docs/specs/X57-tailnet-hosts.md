# X57 — Add a remote host over the tailnet

- **Status:** implemented (unchecked in the real app between two Macs; a few criteria below still lack a test)
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
- [x] A pairing code pairs only the kind it was made for: `mobile.pair_start {kind?}`, `phone` by default, and `moonletd pair` and the Hosts page ask for `desktop`. A device whose `auth` says another kind (no kind reads as `phone`) is refused, and the code still works for the right kind. A phone therefore never gets a Mac's rights by saying it is one. No code is made for `cloud`: a cloud machine (X63) pairs only with its join code. (`a_device_pairs_only_as_the_kind_its_code_was_made_for`, `no_pairing_code_is_made_for_a_cloud_machine`; `tailnet-host.e2e.ts` pairs with a code from `moonletd pair`)
- [x] Every `authed` reply carries the daemon's `protocol`, `daemon_version` and `host` (the host label, as in `mobile.pair_start`). They are sent before `hello`, so a client learns the daemon's version even when their protocols differ. Phone apps that do not read these fields keep working. (`authed_says_which_daemon_answered_before_hello`; the phone's `tests/macs.rs` talks to a daemon from before X57)
- [x] A paired desktop gets what a paired phone gets: X39's rules apply to every tailnet connection, whatever its kind. Later specs set some kinds apart: a paired Mac manages links and heavy commands (X61, X62), and only a paired phone approves a copy's setup (X60, X40). In particular `mobile.*` methods other than `mobile.hosts` and `mobile.unpair` are refused with `forbidden: manage phones from the Mac`. (`a_paired_mac_can_remove_itself_but_manage_nothing_else`)
- [x] Turning tailnet access off while a code is shown ends the pairing with `mobile.pair_ended {reason: "cancelled"}`, so no page keeps showing a code that no longer works. (`turning_access_off_ends_the_pairing`)
- [x] `mobile.unpair` on a tailnet connection removes the calling device, as `mobile.revoke` would, and its connection closes. It is refused on the Unix socket with `invalid_params: not a paired device`. (`a_paired_mac_can_remove_itself_but_manage_nothing_else`)

### A shorter pairing code

- [x] `mobile.pair_start` makes a code of 10 characters from Crockford's base32 alphabet (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), 50 random bits, shown as two groups of five: `7KQ2M-X9PDA`. The link carries it without the dash. This replaces X39's 32 hex characters for phones too. One use, 5 minutes, 5 wrong attempts and the 1 s delay after a wrong one stay as in X39. (`a_pairing_code_is_ten_crockford_characters`, `a_paired_phone_comes_back_with_its_token_and_uses_the_daemon`)
- [x] The daemon compares codes after normalizing what the client sent: uppercase, spaces and dashes removed, `O` read as `0`, and `I` and `L` read as `1`. So `7kq2m x9pda` and `7KQ2MX9PDA` are both accepted. (`typed_codes_are_read_the_way_people_type_them`; the daemon test pairs with the code in lowercase with a space)
- [x] The phone's link parser accepts the new code. It still accepts 32 hex characters, so a new phone can pair with a Mac that has not updated yet. (`pairLink.test.ts`)
- [x] When this ships, X39's `mobile.pair_start` criterion is updated to the new code.

### Pairing from a terminal

- [x] `moonletd tailnet on`, `moonletd tailnet off` and `moonletd tailnet status` call `mobile.set_enabled` and `mobile.status` on the running daemon. `status` prints the X39 status line, such as `Listening on 100.101.102.103:47428`. (`tests/cli.rs`: `tailnet_on_off_and_status_say_where_it_listens`; `tailnet_cli` unit test `the_status_line_says_where_it_listens`)
- [x] `moonletd pair` calls `mobile.pair_start` and prints:
  - the host's name and the code, as `Name: build-box` and `Code: 7KQ2M-X9PDA`,
  - the link,
  - "Expires in 5:00",
  - a QR code of the link when stdout is a terminal, drawn light-on-dark like `qrencode -t UTF8`.

  It then waits. On `mobile.paired` it prints "Paired with <device>" and exits 0. On `mobile.pair_ended` it prints X39's reason and exits 1. Ctrl-C calls `mobile.pair_cancel`. (`pair_prints_the_code_and_link_and_says_who_paired`, `ctrl_c_cancels_the_pairing`; unit tests `a_code_shows_in_two_groups_of_five`, `the_time_left_rounds_up_to_the_second`, `the_qr_code_is_square_with_a_quiet_zone`)
- [x] With tailnet access off, `moonletd pair` exits 1 with "Tailnet access is off. Run `moonletd tailnet on` first." Without a Tailscale address it exits 1 with "Tailscale is not running on this machine." (`pair_needs_tailnet_access_and_tailscale`)

### Adding a host (app)

- [x] The Add host dialog takes one input, "Pairing link or code": (`addHost.test.ts`; `tailnet-host.e2e.ts` pastes a link)
  - a `moonlet://pair?…` link (parsed as the phone parses it) gives the name, addresses and code;
  - anything else is a code. After the normalization above it must be 10 characters of the alphabet, otherwise the dialog says "This is not a pairing link or code." For a code, the dialog also asks for "Name on your tailnet", such as `studio-mini` or `build-box:47500`.
- [x] For a typed name, the app resolves it with the system resolver and keeps only the Tailscale addresses (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), with the given port or 47428. When it resolves to no Tailscale address, the code is not sent, and the dialog says "studio-mini is not on your tailnet (it resolves to 203.0.113.7)." or "studio-mini was not found. Is Tailscale running on this Mac?" (`moonlet-core` `tailnet` tests `a_name_on_the_tailnet_gives_its_listener_addresses`, `a_name_off_the_tailnet_gets_no_code`)
- [x] Addresses from a pasted link must be Tailscale addresses, or loopback (a daemon on this Mac, as in the e2e tests). Otherwise nothing is sent, and the dialog says "The link points at 203.0.113.7:47428, which is not on your tailnet." A forged link could otherwise point the app at a machine off the tailnet, which would then run its sessions. (`moonlet-core` `tailnet` test `a_link_may_point_only_at_the_tailnet_or_this_machine`)
- [x] The host's id and label are its name. A name already used by another host is refused with "A host named studio-mini already exists." (`tailnet-host.e2e.ts`; `hosts.rs` test `a_tailnet_host_is_named_without_its_port`)
- [x] The app pairs with `auth {pair, device: <this Mac's name>, kind: "desktop"}`. On `authed` it saves the host and connects. On failure the dialog shows the daemon's message, X39's `this phone is not paired with this Mac` reading "The code was not accepted. Start pairing again on studio-mini.", and nothing is saved. (`tailnet-host.e2e.ts`: the host lists a `desktop`; `hosts.rs` test `a_refused_code_says_to_start_again_on_the_host`)

### Connecting (app and `moonlet-link`)

- [x] `moonlet-link` gains a tailnet `Connector`, moved from the phone app's `MacConnector` so that the desktop, the phone and X41's worker share it. It tries each address in order, 5 s each, sends `auth {token}`, and waits up to 10 s for the answer. (`moonlet-link` `tests/tailnet.rs`: `a_token_connects`, `pairing_returns_the_token_and_says_who_answered`; `tests/mobile.rs`: `a_mac_pairs_and_connects_through_the_shared_tailnet_connector`; the phone's `tests/macs.rs`)
- [x] An `authed` whose `protocol` differs from the client's puts the host in a new status, `needs_update`, carrying the daemon's version in `daemon_version`. Like `needs_install`, it waits for a retry and does not reconnect by itself. (`a_daemon_with_another_protocol_needs_an_update_and_waits_for_a_retry`)
- [x] An `unauthorized` answer puts the host in a new status, `refused`, with the daemon's message, and it does not reconnect until the user retries. This holds for phones too: a removed phone waits for its Retry instead of trying every 5 s. (`a_refused_token_stops_retrying_until_asked`, `a_mac_pairs_and_connects_through_the_shared_tailnet_connector`)
- [x] The desktop shows `refused` as "studio-mini no longer accepts this Mac. Pair it again." (`settingsPage.test.ts`: "says a host that removed this Mac needs pairing again")
- [ ] Any other failure (no address answers, the connection drops) reconnects with `moonlet-link`'s backoff, as SSH hosts do (R3).
- [ ] After `authed` the connection is a normal host connection: R3's reconnect banner, R4's sidebar grouping, notifications that name the host, the palette and the approval inbox all work for tailnet hosts.
- [x] **Remove** on a tailnet host calls `mobile.unpair` when the host is connected, then forgets the host and its token. When the host is not connected, it forgets them only, and the dialog says "studio-mini will still list this Mac until you remove it there." (`tailnet-host.e2e.ts` for a connected host; `settingsPage.test.ts` "asks before removing a tailnet host it cannot tell")

### Where the app keeps its tokens (2026-11-19)

Until this change the token for each tailnet host sat in `app-hosts.json`. The file is 0600, but every process of the user can read it, agents included, and the token gives everything a paired Mac's app may do on the host.

- [x] On a Mac, the app keeps each tailnet host's token in the Keychain, in X91's one item (service `dev.onedevstudio.moonlet.trackers`, account `tokens`) under the key `host:<device id>`, beside the tracker tokens. The app reads that item once per start for both, so a start still asks for the password once at most, and the signed release, which created the item or was allowed with **Always Allow**, does not ask. `app-hosts.json` keeps the host's id, device id and addresses, `"token": ""`, and `token_sha256`, the token's SHA-256 in hex. (`host_tokens.rs` a_token_in_the_file_moves_into_the_keychain_and_out_of_the_file, a_host_already_moved_needs_nothing_written; `tailnet-host.e2e.ts` "pairs with a pasted link and connects")
- [x] A host is keyed by this Mac's device id on it, not by its name, so a dev build with a scratch home that pairs with the same host never replaces the app's token. Pairing again gives a new device id and puts the new token in the Keychain; Remove deletes the host's key. A token found in the file for a host already in the Keychain (written by a build from before) replaces the Keychain's. (`host_tokens.rs` pairing_again_puts_the_new_token_in_the_keychain; `tailnet-host.e2e.ts` "removes it, and the host forgets this Mac")
- [x] An existing install moves its tokens at the first start of this version: the app reads them from the file, connects with them, saves them in the Keychain, and writes the file without them only after the Keychain has kept them. When the Keychain refuses (the user cancels the prompt, or the save fails), the file stays as it was and the host connects with the file's token; the move is tried again at the next save or start. Nothing is lost, and the user never has to pair again. (`host_tokens.rs` a_keychain_that_refuses_the_token_leaves_the_file_as_it_was)
- [x] The app writes `app-hosts.json` once per start, after every host is known, so a prompt left open never leaves a host out of the file. (manual; the start path is in `hosts.rs` `HostManager::new`)
- [x] A token the Keychain does not give at start (the user cancelled the prompt) leaves the host without a token for that start, and the file as it was. The host's line says "moonlet could not read this Mac's token for the host from the Keychain. Quit moonlet and open it again." in place of connecting, and Make central host and Update refuse with the same words. (`host_tokens.rs` a_token_the_keychain_cannot_read_leaves_the_host_without_one_and_the_file_as_it_was)
- [x] A host whose token moved keeps `"token": ""` in the file, so a build from before still lists every host (it cannot connect to them) instead of reading the file as empty and saving over it. (`ssh.rs` a_host_whose_token_moved_still_reads_in_builds_from_before)
- [x] This Mac's daemon tells "the app handed its token to the link" from "only the link holds it" (X41) by the token in the file or, once moved, by `token_sha256`. It never reads the Keychain. (`tests/link.rs` a_link_set_with_the_apps_token_kept_in_the_keychain_leaves_the_app_its_token, a_link_set_with_the_apps_own_token_leaves_the_app_its_token)
- [x] e2e builds keep the tokens in `$MOONLET_HOME/secrets.json` (0600), X91's store for them, so a test never reads or writes the user's Keychain. Which store a build uses is fixed at compile time (the `e2e` feature), not by an environment variable, so a release build cannot be pointed at the file (#672). (`tailnet-host.e2e.ts`)

### What differs from SSH hosts

- [x] A tailnet host has no Install helper or Reinstall helper button. (`tailnet-host.e2e.ts`)
- [x] "Open in" offers no editors for workspaces on a tailnet host, because VS Code's and Cursor's `ssh-remote+` needs SSH (ADR 0011). (`openIn.test.ts`)
- [x] On a tailnet host, an MCP sign-in whose `redirect_uri` is a `localhost` port (X29) is cancelled as soon as its sign-in page shows it, before the browser opens or the link is copied. A toast says "Signing in to <server> isn't available for sessions on studio-mini yet." Sign-ins without a local callback work as before. (`oauthRedirect.test.ts`)
- [x] Phones keep routing only to SSH hosts: `mobile.hosts` lists only the SSH hosts in `app-hosts.json`. (`phones_route_only_to_ssh_hosts`)

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
    - the error with **Retry**, `needs_update` with **Retry** (after updating the host), or **Pair again** for `refused`, which forgets the host and opens Add host with its name
  - **Remove** works as described above.
- **Sidebar:** a host that is not connected shows its line in the notice under its name (R4), the same words as Settings for `needs_update` and a host that no longer accepts this Mac.

## Protocol and RPCs

- **`auth`** gains `kind?: "phone" | "desktop"`.
- **`authed`** gains `protocol: number`, `daemon_version: string` and `host: string`.
- **`mobile.status`:** each device gains `kind`.
- **New method:** `mobile.unpair` (tailnet connections only).
- **`moonlet-link`:** `HostStatus` gains `needs_update` and `refused`, and the crate gains the tailnet `Connector`.
- **CLI:** `moonletd tailnet on|off|status` and `moonletd pair`. They connect as clients `moonletd-tailnet` and `moonletd-pair`, following `moonletd status` (`moonletd-status`). The daemon refuses `mobile.*` only to `moonlet-cli` (`daemon.rs:429`), so it serves these as it serves the app.
- **Desktop (Tauri) commands:**
  - `host_pair {name, addrs?, code}` returns the new host or the dialog's error. The webview reads the input (`lib/addHost.ts`): a link gives `name`, `addrs` and `code`; a typed code gives `code`, with the name typed beside it and no `addrs`;
  - `host_list` entries, and every `host-status` event, gain `kind: "local" | "ssh" | "tailnet"`.
- `PROTOCOL_VERSION` stays. The Unix socket protocol is unchanged, and the new fields appear only on tailnet connections. `docs/protocol.md` gets the new fields and method.

## Data and config

- `~/.moonlet/mobile.json`: each device gains `kind`. A missing kind reads as `phone`.
- `~/.moonlet/app-hosts.json` is written with mode 0600. `remotes` stays as it is, so phones' routing and older builds keep reading it. Since 2026-11-19 the token is in the Keychain (see [Where the app keeps its tokens](#where-the-app-keeps-its-tokens-2026-11-19)); `token` is `""` and `token_sha256` is its SHA-256 in hex. A non-empty `token` is one not moved yet:

  ```json
  {
    "remotes": ["build-box-ssh"],
    "tailnet": [
      {
        "id": "studio-mini",
        "device_id": "…",
        "addrs": ["100.101.102.103:47428"],
        "token": "",
        "token_sha256": "…"
      }
    ]
  }
  ```
- Keychain: X91's item (service `dev.onedevstudio.moonlet.trackers`, account `tokens`) gains a key `host:<device id>` per tailnet host. Tracker connection ids are `<kind>:<site>`, so none starts with `host:`.

## Security considerations

- A typed name sends the code only to a Tailscale address, so a typo that resolves to a public host cannot receive it. A pasted link's addresses must be on the tailnet too (or loopback), so a forged link cannot point the app at a machine off the tailnet. The tailnet encrypts the pairing, and X39's limits apply: one use, 5 minutes, 5 wrong attempts.
- A desktop token gives the same full access as a phone token (X39). Since 2026-11-19 the app keeps it in the login Keychain, in X91's item, and `app-hosts.json` keeps only its SHA-256. The webview never receives it, and `host_list` does not include it.
- What that protects against: a process of the user that reads files (an agent, a script, a tool that copies `~/.moonlet`) no longer finds the token. Reading the Keychain item from a binary the item does not trust makes macOS show its password prompt naming the item, and without the user's password and approval it gets nothing.
- What it does not protect against:
  - The item trusts the binary that created it and every binary the user allowed with **Always Allow**, such as a dev build. Those read it without a prompt.
  - The token is in the app's memory while it runs. A dev build has no hardened runtime, so a debugger run by the same user can read that memory; the notarized release has the hardened runtime (notarization requires it) and does not allow that.
  - A process the user has granted Accessibility (macOS asks first) can drive the app's window and do what the app's UI does on the host.
  - A process can talk to this Mac's daemon as an unproven local caller, limited to A6's allowlist; the app's proof on the local socket (X75) is unchanged by this. The daemon's `link.json` holds the link's worker credential (X41). After **Make central host** it holds the app's own token until the link has traded it for a worker link, and keeps it while the central host is from before worker links.
  - Deleting the Keychain item is not prevented. The hosts would then need pairing again.
- On Linux there is no desktop app, and nothing writes these tokens. The app's store off macOS is X91's 0600 file under `$MOONLET_HOME`, as ADR 0014 says.
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
  - `host_tokens.rs` (2026-11-19), against a stand-in for the Keychain: a token in the file moves into the Keychain and out of the file; a refused save leaves the file as it was; an already-moved host writes nothing; an unreadable token leaves the host without one and the file as it was; pairing again stores the new token. `ssh.rs`: a file with a moved token still reads in builds from before. `tests/link.rs`: the daemon's X41 check works with only the token's hash in the file.
- **`crates/moonlet-link/tests/tailnet.rs`** (a fake daemon on 127.0.0.1):
  - pairing with a code returns the token and who answered, and sends `kind`;
  - a token connects;
  - an `authed` with `protocol: 99, daemon_version: "9.9.9"` gives `needs_update` with `9.9.9`, and no reconnect follows until a retry;
  - an `unauthorized` answer gives `error` with the daemon's message, and no reconnect follows until a retry.
- **`crates/moonletd/tests/mobile.rs`, through `moonlet-link`:** a Mac pairs with the real daemon, connects, and after `mobile.revoke` stops at `error` without trying again.
- **`crates/moonletd/tests/mobile.rs`:**
  - `authed` carries `protocol`, `daemon_version` and `host`;
  - a desktop device is refused `mobile.pair_start`, `mobile.revoke` and `mobile.status` with `forbidden`;
  - `mobile.unpair` removes the calling device and closes its connection, and is refused on the Unix socket.
- **Rust unit tests for the code:** a made code is 10 characters of the alphabet. Normalizing turns `7kq2m x9pda`, `7KQ2M-X9PDA` and `7KQ2MX9PDA` into `7KQ2MX9PDA`, and `OIL` into `011`. Display of `7KQ2MX9PDA` is `7KQ2M-X9PDA`.
- **`crates/moonletd/tests/mobile.rs`, the code:** pairing with the lowercase, spaced form of the code works. The existing X39 tests run unchanged with the new code.
- **`crates/moonletd/tests/cli.rs`** (new): `moonletd pair` against a test daemon prints a code matching `^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$` and a `moonlet://pair?v=1&` link, then exits 0 with "Paired with Test Mac" when a TCP client pairs with that code. It exits 1 with the "Tailnet access is off" line when access is off.
- **Vitest, `apps/desktop/src/lib/`:**
  - `pairLink.test.ts` moves here from the phone app (done), and the phone imports `parsePairLink` from `@desktop/lib/pairLink`. Its existing link with the 32 hex characters still parses, and a link with `code=7KQ2MX9PDA` parses too;
  - the Add host input: a link, `7KQ2M-X9PDA`, `7kq2m x9pda`, and `hello`, which gives "This is not a pairing link or code.";
  - the status line for each tailnet state, including both `needs_update` directions with the literal lines above;
  - "Open in" offers nothing for a tailnet host and VS Code and Cursor for an SSH host;
  - the MCP sign-in message for a tailnet host with a `localhost` redirect, and no message without one.
- **e2e, `apps/desktop/e2e/specs/tailnet-host.e2e.ts`:** a crucial feature (adding a host is how sessions start on it). The fixture starts a second scratch daemon with tailnet access on 127.0.0.1 and gets a pairing link from it with `mobile.pair_start`. The spec:
  - pastes the link into Add host;
  - sees "Connected · moonletd";
  - sees the host in the Add project dialog's Host list (the sidebar lists a host only once it has projects);
  - is refused a second host with the same name;
  - removes it and sees the second daemon no longer list the device.
  - (2026-11-19) after pairing, `app-hosts.json` has `"token": ""` and a `token_sha256`, and the e2e build's `secrets.json` holds `host:<device id>`; after Remove it no longer does.
- **Manual:** pair the MacBook with the real Mac mini over Tailscale by name and code, open a session there, close the lid, and reopen it.

## Open questions

None open. Decided on 2026-10-20:

- **The `mobile.*` methods and `mobile.json` keep their names.** Only the UI text changes. Renaming would touch the phone app and the protocol and change no behaviour. The glossary records the exception.
- **The pairing code is shorter.** A 32 hex code is tedious to copy by hand from a server's terminal. 50 bits with one use, 5 minutes and 5 attempts leaves a guess no real chance.
