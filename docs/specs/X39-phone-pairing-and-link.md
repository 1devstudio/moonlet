# X39 — Pair a phone and let it reach the daemon over Tailscale

- **Status:** implemented (daemon; desktop Settings and the iPhone untried)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2 (agent-first), A5 (approval inbox), A6 (CLI and socket API)
- **Related:** [X40](X40-mobile-app.md) (the phone app), [R1](R1-ssh-hosts.md)–[R4](R4-unified-hosts-sidebar.md) (remote hosts), [X31](X31-agent-reads-terminal.md) (who may answer read requests)
- **Related ADRs:** [0008](../adr/0008-phone-link-over-tailscale.md)

## Summary

The moonlet phone app (X40) needs to reach the daemon on the user's Mac while the user is away from the desk. X39 gives the daemon a second listener, a TCP port on the Mac's Tailscale addresses only, and a pairing flow: Settings › Mobile on the Mac shows a QR code, the phone scans it, and from then on the phone holds a device token that the daemon checks on every connection. The phone then speaks the daemon's normal protocol, so it can do what the desktop app does. Through the same connection it also reaches the Mac's SSH hosts: the daemon runs `ssh <host> moonletd proxy` for it, as the desktop does.

## User journey

1. On the Mac, the user opens Settings and scrolls to Mobile. It says "Off".
2. The user turns on **Allow phones on my tailnet**. The page shows "Listening on 100.101.102.103:47428".
3. The user clicks **Pair a phone**. The section shows a QR code, the same link as text with a Copy button, and "Expires in 5:00".
4. On the iPhone, which is on the same tailnet, the user opens the moonlet app, taps **Pair a Mac**, and scans the code (or pastes the link). The app shows "Paired with studio-mac".
5. On the Mac the QR code goes away, the section says "Paired with iPhone", and the list under "Paired phones" shows "iPhone" with "paired just now · connected".
6. Later, the user loses the phone. In Settings, under Mobile, they click **Remove** next to it. The phone's open connection drops at once and its token no longer works.

## Behaviour and acceptance criteria

### Listener

- [x] Phone access is off by default. `mobile.set_enabled { enabled }` turns it on or off and is kept in `~/.moonlet/mobile.json`, so a daemon restart or upgrade keeps the choice. (`tests/mobile.rs`: `phone_access_is_off_until_the_user_allows_it`)
- [x] While on, the daemon listens on TCP port 47428 (the `port` field of `mobile.json` changes it) on every local address in `100.64.0.0/10` or `fd7a:115c:a1e0::/48`, and on no other address. With no such address it listens nowhere and `mobile.status` reports `tailscale: false`. It looks again every 30 seconds, so starting Tailscale later starts the listener without a daemon restart; a failed bind (a daemon handing over still holds the port) is retried after 2 seconds. `MOONLET_MOBILE_ADDRS` replaces the detected addresses for tests. (`mobile.rs` unit test `only_tailscale_addresses_count`; `tests/mobile.rs` binds to 127.0.0.1)
- [x] Turning phone access off closes the listener and every phone connection. (`phone_access_is_off_until_the_user_allows_it`)
- [x] The listener is closed when the daemon shuts down or hands over in a live upgrade (S3); the new daemon opens it from `mobile.json`.

### Auth exchange

- [x] The first frame on a phone connection must be `{"t":"auth", "token"?: string, "pair"?: string, "device"?: string, "route"?: string}`. Anything else gets the `unauthorized` error below; no frame within 10 seconds closes the connection. (`bad_auth_is_refused_without_saying_why`)
- [x] With a valid `token`, the daemon answers `{"t":"authed","device_id":"…"}` and the connection continues with the normal `hello` and the rest of the protocol (`docs/protocol.md`). The device's `last_seen` is updated. (`a_paired_phone_comes_back_with_its_token_and_uses_the_daemon`)
- [x] With a `pair` code that is current, the daemon creates a device named after `device` (cut to 60 characters, control characters removed, "Phone" when empty), answers `{"t":"authed","device_id":"…","token":"…"}`, and the code stops working. The token is 32 random bytes in hex, and only its SHA-256 is stored. (`a_paired_phone_comes_back_with_its_token_and_uses_the_daemon`, `device_names_are_cleaned`)
- [x] Any failure answers one error response `{"t":"response","id":0,"error":{"code":"unauthorized","message":"…"}}` and closes the connection: an unknown or revoked token, a used or expired code, both or neither of `token` and `pair`, `pair` with `route`. The message is always `this phone is not paired with this Mac`. (`bad_auth_is_refused_without_saying_why`)
- [x] Each failed attempt waits one second before the reply. After 5 failed `pair` attempts the current code is cancelled, and the Mac's pairing dialog says "Too many wrong attempts. Start again." (`five_wrong_codes_end_the_pairing`, `five_wrong_codes_cancel_the_pairing`)
- [x] A phone connection's `hello` may use any client name; the daemon treats the connection as the app (not the CLI), so the phone can answer X31 read requests. The CLI client name `moonlet-cli` is refused on phone connections with `forbidden`. (`phones_and_agents_cannot_manage_phones`)

### Pairing

- [x] `mobile.pair_start` returns `{ code, url, expires_at, addresses, host }`, where `code` is 16 random bytes in hex, valid for 5 minutes and for one pairing, and `url` is `moonlet://pair?v=1&host=<Mac name>&addr=<ip:port>[&addr=…]&code=<code>`, every value percent-encoded, and `addresses` are the listener's `ip:port`s. The Mac name is its host name without `.local`. A new `pair_start` replaces the previous code. Fails with `mobile_off` while phone access is off and `no_tailscale` while nothing listens. (`the_pairing_link_carries_the_host_every_address_and_the_code`, `a_paired_phone_comes_back_with_its_token_and_uses_the_daemon`)
- [x] `mobile.pair_cancel` cancels the current code.
- [x] A successful pairing broadcasts `mobile.paired { device }`, and a cancelled or exhausted code broadcasts `mobile.pair_ended { reason }` with `reason` one of `expired`, `cancelled`, `too_many_attempts`.

### Devices

- [x] `mobile.status` returns `{ enabled, port, tailscale, addresses, listening, host, devices: [{ id, name, created_at, last_seen, connected }] }`: `addresses` are the Tailscale addresses, `listening` the bound `ip:port`s (empty while off), devices in pairing order.
- [x] `mobile.revoke { id }` removes the device from `mobile.json`, closes its open connections, and broadcasts `mobile.changed` with the new status. A phone that authenticated just before its removal, or just before phone access was turned off, is dropped when it registers its connection, so a removal never misses a connection being set up. So do turning access on or off, the listener starting or stopping, and phones connecting and disconnecting. (`removing_a_phone_cuts_its_connection_and_its_token`)
- [x] `mobile.json` is written with mode 0600, like the rest of `~/.moonlet`. (`mobile_json_round_trips_and_defaults_the_port`)
- [x] The `mobile.*` methods except `mobile.hosts` are refused on phone connections (`forbidden: manage phones from the Mac`) and from the `moonlet` CLI (`forbidden: only the moonlet app manages phones`), so neither a phone nor an agent can pair another device. (`phones_and_agents_cannot_manage_phones`)

### Routing to SSH hosts

- [x] `mobile.hosts` (allowed on phone connections) lists the SSH hosts the desktop app has added (`~/.moonlet/app-hosts.json`, R4) as `[{ id, label }]`.
- [x] An `auth` with a valid `token` and `route: "<alias>"` for a host in that list makes the daemon run `ssh <the desktop's ssh options> <alias> ~/.moonlet/bin/moonletd proxy` and pipe frames both ways. The `authed` reply comes first, then everything the remote daemon sends, starting with its `welcome`. A `route` not in the list fails like a bad token. When ssh exits, the phone connection closes, and ssh's last stderr line is sent first as an error response with code `route_failed`. (`a_phone_reaches_an_ssh_host_through_the_mac`, with a fake `ssh` that runs `moonletd proxy` against a second daemon)
- [x] On a routed connection the Mac reads the phone's frames and answers `mobile.*` requests other than `mobile.hosts` itself with `forbidden: manage phones from the Mac`. The host's daemon cannot tell the phone from the desktop app, and a phone that turned on phone access there and paired itself would keep access after the Mac removes it. (`a_phone_reaches_an_ssh_host_through_the_mac`)

### Desktop: the Mobile section of Settings

- [x] Settings has a **Mobile** section, after Remote hosts: the box **Allow phones on my tailnet**, a line with the state (`Off`, `Tailscale is not running on this Mac`, `Starting…`, `Listening on <ip:port>`), the **Pair a phone** button (disabled until it listens), and under "Paired phones" each phone's name, `paired <when> · connected` (or `last seen <when>`, `not seen since`) and **Remove**. (`lib/mobile.test.ts` for the lines; `mobile-pairing.e2e.ts`)
- [x] **Pair a phone** shows, in the section, the QR code of `url`, the link as text with Copy, `Expires in m:ss` (rounded up), and Cancel. When `mobile.paired` arrives the code goes away and the section says `Paired with <device>`; on `mobile.pair_ended` it says why (`Too many wrong attempts. Start again.`, `The code expired. Start again.`, `Pairing was cancelled.`). Cancel, or closing Settings, calls `mobile.pair_cancel`. (`mobile.test.ts`; `mobile-pairing.e2e.ts` pairs a TCP "phone" with the code from the link)
- [x] **Remove** asks first (X23 confirm): "Remove <device>?", "It will need to be paired again." (`mobile-pairing.e2e.ts`)

## Protocol and RPCs

New messages: `auth` (phone → daemon, first frame on a phone connection only) and `authed`.

New methods: `mobile.status`, `mobile.set_enabled`, `mobile.pair_start`, `mobile.pair_cancel`, `mobile.revoke`, `mobile.hosts`.

New events: `mobile.changed`, `mobile.paired`, `mobile.pair_ended`.

`PROTOCOL_VERSION` stays: the Unix socket protocol does not change, and the new messages only appear on phone connections.

## Data and config

`~/.moonlet/mobile.json`, mode 0600:

```json
{
  "enabled": true,
  "port": 47428,
  "devices": [
    { "id": "…", "name": "iPhone", "token_sha256": "…", "created_at": 1760000000000, "last_seen": 1760000300000 }
  ]
}
```

## Security considerations

- The listener is reachable only from the tailnet, and Tailscale encrypts and authenticates peers. The daemon still treats the tailnet as untrusted: other users' shared devices and compromised devices can reach the port, so every connection needs a token.
- A phone with a token can do anything the desktop app can: run commands, read files, approve tools. That is the point of the feature. Removing the device is the way to take it back, and it is immediate.
- Tokens are long random values and only their hashes are stored. Pair codes are single use, short lived and limited to 5 wrong attempts.
- The daemon cannot tell an agent's `moonlet` CLI from the desktop app on the Unix socket except by the client name, as in X31. An agent that lies about its name could start a pairing; this is the same trust boundary X31 accepts, and pairing still needs a phone on the tailnet.
- Route aliases come only from the desktop's own host list, and are passed to `ssh` as one argument after the options, so a phone cannot inject ssh options.

## Out of scope

- Listening on the LAN or the internet without Tailscale.
- Push notifications (APNs).
- Several users on one daemon.

## Test plan

- `crates/moonletd` unit tests: Tailscale address filter, token hashing, pair code expiry and attempt limit, `mobile.json` round trip.
- `crates/moonletd/tests/mobile.rs`: a daemon with an injected listen address; pair with a code, reconnect with the token, a wrong token, a reused code, an expired code, revoke cuts an open connection, `mobile.*` refused from a phone and from the CLI name, a route through a fake `ssh`.
- `apps/desktop/src/lib/mobile.test.ts`: the status line and device lines.
- `apps/desktop/e2e/specs/mobile-pairing.e2e.ts`: turn phone access on against a daemon listening on 127.0.0.1, pair a TCP client with the code from the shown link, see it listed, remove it.
- Manual: pair the real iPhone build over Tailscale.

## Open questions

- None.
