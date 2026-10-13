# X38 — Pair a phone and let it reach the daemon over Tailscale

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2 (agent-first), A5 (approval inbox), A6 (CLI and socket API)
- **Related:** [X39](X39-mobile-app.md) (the phone app), [R1](R1-ssh-hosts.md)–[R4](R4-unified-hosts-sidebar.md) (remote hosts), [X31](X31-agent-reads-terminal.md) (who may answer read requests)
- **Related ADRs:** [0008](../adr/0008-phone-link-over-tailscale.md)

## Summary

The moonlet phone app (X39) needs to reach the daemon on the user's Mac while the user is away from the desk. X38 gives the daemon a second listener, a TCP port on the Mac's Tailscale addresses only, and a pairing flow: Settings › Mobile on the Mac shows a QR code, the phone scans it, and from then on the phone holds a device token that the daemon checks on every connection. The phone then speaks the daemon's normal protocol, so it can do what the desktop app does. Through the same connection it also reaches the Mac's SSH hosts: the daemon runs `ssh <host> moonletd proxy` for it, as the desktop does.

## User journey

1. On the Mac, the user opens Settings › Mobile. It says "Phone access is off" and shows the Mac's Tailscale name and address, or "Tailscale is not running on this Mac".
2. The user turns on **Allow phones on my tailnet**. The page shows "Listening on 100.101.102.103:47428".
3. The user clicks **Pair a phone**. A dialog shows a QR code, the same link as text with a Copy button, and "Expires in 5:00".
4. On the iPhone, which is on the same tailnet, the user opens the moonlet app, taps **Pair a Mac**, and scans the code (or pastes the link). The app shows "Paired with studio-mac".
5. On the Mac the dialog closes and the list under "Paired phones" shows "iPhone · paired just now · connected".
6. Later, the user loses the phone. In Settings › Mobile they click **Remove** next to it. The phone's open connection drops at once and its token no longer works.

## Behaviour and acceptance criteria

### Listener

- [ ] Phone access is off by default. `mobile.set_enabled { enabled }` turns it on or off and is kept in `~/.moonlet/mobile.json`, so a daemon restart or upgrade keeps the choice.
- [ ] While on, the daemon listens on TCP port 47428 (the `port` field of `mobile.json` changes it) on every local address in `100.64.0.0/10` or `fd7a:115c:a1e0::/48`, and on no other address. With no such address it listens nowhere and `mobile.status` reports `tailscale: false`. It looks again every 30 seconds, so starting Tailscale later starts the listener without a daemon restart. (Unit test for the address filter with real `ifconfig` addresses; daemon test that binds to an injected address.)
- [ ] Turning phone access off closes the listener and every phone connection.
- [ ] The listener is closed when the daemon hands over in a live upgrade (S3); the new daemon opens it from `mobile.json`.

### Auth exchange

- [ ] The first frame on a phone connection must be `{"t":"auth", "token"?: string, "pair"?: string, "device"?: string, "route"?: string}`. Anything else, or no frame within 10 seconds, closes the connection.
- [ ] With a valid `token`, the daemon answers `{"t":"authed","device_id":"…"}` and the connection continues with the normal `hello` and the rest of the protocol (`docs/protocol.md`). The device's `last_seen` is updated.
- [ ] With a `pair` code that is current, the daemon creates a device named after `device` (cut to 60 characters, control characters removed, "Phone" when empty), answers `{"t":"authed","device_id":"…","token":"…"}`, and the code stops working. The token is 32 random bytes in hex, and only its SHA-256 is stored.
- [ ] Any failure answers one error response `{"t":"response","id":0,"error":{"code":"unauthorized","message":"…"}}` and closes the connection: an unknown or revoked token, a used or expired code, both or neither of `token` and `pair`. The message does not say which of these it was.
- [ ] Each failed attempt waits one second before the reply. After 5 failed `pair` attempts the current code is cancelled and the Mac's pairing dialog says "Too many wrong attempts. Start again."
- [ ] A phone connection's `hello` may use any client name; the daemon treats the connection as the app (not the CLI), so the phone can answer X31 read requests. The CLI client name `moonlet-cli` is refused on phone connections.

### Pairing

- [ ] `mobile.pair_start` returns `{ code, url, expires_at, addresses, port, host }`, where `code` is 16 random bytes in hex, valid for 5 minutes and for one pairing, and `url` is `moonlet://pair?v=1&host=<Mac name>&addr=<ip:port>[&addr=…]&code=<code>`. A new `pair_start` cancels the previous code. Fails with `mobile_off` while phone access is off and `no_tailscale` without a Tailscale address.
- [ ] `mobile.pair_cancel` cancels the current code.
- [ ] A successful pairing broadcasts `mobile.paired { device }`, and a cancelled or exhausted code broadcasts `mobile.pair_ended { reason }` with `reason` one of `expired`, `cancelled`, `too_many_attempts`.

### Devices

- [ ] `mobile.status` returns `{ enabled, port, tailscale, addresses, host, listening, devices: [{ id, name, created_at, last_seen, connected }] }`, devices in pairing order.
- [ ] `mobile.revoke { id }` removes the device from `mobile.json`, closes its open connections, and broadcasts `mobile.changed`. So do pairing, connecting and disconnecting.
- [ ] `mobile.json` is written with mode 0600, like the rest of `~/.moonlet`.
- [ ] The `mobile.*` methods are refused on phone connections (`forbidden: manage phones from the Mac`) and from the `moonlet` CLI (`forbidden: only the moonlet app manages phones`), so neither a phone nor an agent can pair another device.

### Routing to SSH hosts

- [ ] `mobile.hosts` (allowed on phone connections) lists the SSH hosts the desktop app has added (`~/.moonlet/app-hosts.json`, R4) as `[{ id, label }]`.
- [ ] An `auth` with a valid `token` and `route: "<alias>"` for a host in that list makes the daemon run `ssh <the desktop's ssh options> <alias> ~/.moonlet/bin/moonletd proxy` and pipe frames both ways. The `authed` reply comes first, then everything the remote daemon sends, starting with its `welcome`. A `route` not in the list fails like a bad token. When ssh exits, the phone connection closes, and ssh's last stderr line is sent first as an error response with code `route_failed`. (Daemon test with a fake `ssh` on `PATH`.)

### Desktop: Settings › Mobile

- [ ] Settings has a **Mobile** page: the switch **Allow phones on my tailnet**, a line with the Tailscale state (`Listening on <addr>:<port>`, `Tailscale is not running on this Mac`, or `Off`), the **Pair a phone** button (disabled while off or without Tailscale), and the list of paired phones with name, "paired <when>", "connected" or "last seen <when>", and **Remove**. (`lib/mobile.test.ts` for the lines; e2e for the switch and the dialog)
- [ ] **Pair a phone** opens a dialog with the QR code of `url`, the link as text with Copy, and a countdown. It closes by itself with "Paired with <device>" when `mobile.paired` arrives, and shows the `pair_ended` reason otherwise. Closing the dialog calls `mobile.pair_cancel`.
- [ ] **Remove** asks first (X23 confirm): "Remove <device>? It will need to be paired again."

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
- `apps/desktop/e2e/specs/mobile-pairing.e2e.ts`: turn phone access on against a daemon with an injected address, open the pairing dialog, see the link, close it.
- Manual: pair the real iPhone build over Tailscale.

## Open questions

- None.
