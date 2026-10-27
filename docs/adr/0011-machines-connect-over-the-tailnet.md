# ADR 0011: Machines reach each other over the tailnet, and the user installs moonlet on them

- **Status:** accepted (2026-10-20); built in [X57](../specs/X57-tailnet-hosts.md) and [X58](../specs/X58-linux-install-script.md)
- **Changes:** [ADR 0009](0009-central-host-workers-live-copies.md)'s transport (workers no longer dial out over SSH), and the default way to add a remote host ([R1](../specs/R1-ssh-hosts.md)–[R3](../specs/R3-remote-sessions-reconnect.md)).
- **Changed by:** [ADR 0012](0012-cloud-workers.md) (2026-10-22). moonlet installs Tailscale on the cloud machines it creates; the user still sets up their own machines.
- **Changed by:** [ADR 0014](0014-one-account-across-hosts.md) (proposed, 2026-10-26). The first desktop paired with a host is its admin and may manage its devices and link.
- **Builds on:** [ADR 0008](0008-phone-link-over-tailscale.md) and [X39](../specs/X39-phone-pairing-and-link.md) (the daemon's tailnet listener and device tokens).

## Context

Adding a remote host today takes several steps outside the app:

- an alias in `~/.ssh/config`;
- a key the host accepts, loaded in the ssh agent, because ssh runs with `BatchMode=yes` and never prompts;
- the host's key accepted once in a terminal, because BatchMode also refuses unknown host keys;
- then, in the app, the helper install (R2).

The goal is to make connecting a second machine, typically an always-on Mac mini, a matter of typing its name.

Two pieces already exist. Since ADR 0008, the daemon can listen on its Tailscale addresses (TCP 47428), and phones pair with it once and then authenticate with a device token. Every request, event and terminal stream works over that connection. ADR 0009, still proposed, planned for workers to reach the central host over `ssh <alias> moonletd proxy`, and its first slice ([X41](../specs/X41-worker-link-and-project-identity.md)) is specced but not built.

## Decision

**Transport.** The desktop app and other daemons reach a remote daemon over its tailnet listener, the one phones use, with a device token from pairing. After the `auth` exchange the connection carries the normal protocol (`docs/protocol.md`). There is no ssh, no key and no `~/.ssh/config` entry. Tailscale's WireGuard tunnel encrypts the traffic, and its relays carry it when the two machines have no direct path, so moonlet runs no relay of its own.

**The user sets up Tailscale and installs moonlet.** moonlet does not install or configure Tailscale. It expects both machines on the same tailnet and refers to the remote by its tailnet name (the MagicDNS name, such as `studio-mini`) or address. moonlet gets onto the remote machine by one of two routes:

- **A Mac** installs moonlet.app. Its login item ([X56](../specs/X56-login-item.md)) keeps `moonletd` running, and the app updates itself ([X35](../specs/X35-in-app-update.md)).
- **A Linux machine** runs an install script published with each release. The script downloads the static `moonletd` and `moonlet`, checks their SHA-256, installs them in `~/.moonlet/bin` and runs the daemon as a systemd user service with lingering on. Running the script again updates moonlet.

The app never copies binaries over the tailnet.

**Pairing.** A desktop pairs with a remote host the way a phone does:

1. The remote shows a one-time code and link: Settings on a Mac, `moonletd pair` in a terminal on Linux.
2. The user adds the host in the app with its name and the code.
3. The app keeps the token and the host's addresses.

A paired desktop, like a phone, cannot manage the remote's devices, so it cannot pair further devices there.

**Versions.** The app does not pin the remote to its own version, because it no longer installs it. When the protocol versions differ, the host shows which side to update, "Update moonlet on studio-mini" or "Update moonlet on this Mac", instead of R2's install button. A daemon already answers a mismatched `hello` with `protocol_mismatch`. The pairing spec also has the tailnet listener report the daemon's version, so the app can say which side is older.

**Workers.** A worker's daemon links to the central host over the same tailnet connection, with the token of the Mac it runs on. Only machines that something connects to need their listener on: the central host, and any host the app or a phone opens. A laptop that only works as a worker keeps it off.

**SSH hosts stay.** Hosts added over SSH (R1–R4) keep working as they do, under an advanced option. Features that span machines (the worker link, live copies, routing) build on the tailnet connection only.

## Considered options

- **SSH without `~/.ssh/config`:** fields for port, key and jump host, plus host keys accepted in the app. It removes the config edit, but the host still needs the user's key in its `authorized_keys`, and the app still has to install the helper. It may still improve SSH hosts later.
- **A relay of moonlet's own, with end-to-end encryption.** This is Orca's design: both sides dial out to a WebSocket relay, and NaCl box plus an HKDF handshake keep the relay from reading the traffic. It needs a server that is always on and paid for. Tailscale's relays already do this job for free for one user.
- **iroh in the daemon:** encrypted QUIC between peers, with NAT traversal and fallback relays. No Tailscale is needed. But n0's public relays are rate-limited and not meant for production, so a dependable setup comes back to running a relay.
- **Trusting every device signed in to the user's Tailscale account, with no pairing.** The daemon would look up who an incoming address belongs to. It is a possible later convenience. Tagged servers have no user as owner, and the App Store build of Tailscale on macOS makes the lookup harder, so pairing stays the baseline.

## Consequences

- **More clients use the listener.** The "Allow phones on my tailnet" setting becomes "Allow connections from my tailnet", and the device list holds desktops as well as phones. Whether the `mobile.*` methods and `mobile.json` are renamed is decided in the pairing spec. Phones paired today must keep working.
- **Trust.** A paired desktop can do everything the app can on that host, as a paired phone already can (X39). Removing the device takes that back at once. On Linux, `moonletd pair` is a command that an agent on that host could run too. That is the same boundary X39 accepts for an agent that lies about its client name. The code alone is not enough: whoever uses it also needs a device on the tailnet.
- **MCP server sign-in on a remote host.** For a sign-in whose callback goes to `localhost`, X29 forwards the port from the Mac to the host through ssh (`ssh -O forward`). Tailnet hosts have no ssh connection, so a follow-up spec must carry the callback some other way, for example over the daemon protocol. Until then the app says that such a sign-in is not available on that host. Sign-ins that finish on claude.ai need no callback and work as they do today.
- **"Open in VS Code / Cursor"** uses `ssh-remote+<alias>` and does not work for tailnet hosts. It is hidden for them until ADR 0009's live copies give the Mac a local copy to open.
- **Release work.** The release builds the static Linux helpers but only bundles them inside the app. They must also be published as release assets, with their checksums and the install script. Users will now download the helpers themselves, so signing them, already planned in `docs/release.md`, matters more. A checksum fetched from the same release protects the download, not where it came from.
- **ADR 0009 and X41.** The worker link uses the tailnet connector instead of `ssh … moonletd proxy`. ADR 0009's "no machine opens a port" no longer holds for the central host, whose listener is reachable only from the tailnet.
- **Delivery,** each slice with its own spec:
  1. a desktop pairs with a remote host over the tailnet, and the phone's dial-and-auth code moves into `moonlet-link` for both apps ([X57](../specs/X57-tailnet-hosts.md));
  2. the Linux install script and its release assets ([X58](../specs/X58-linux-install-script.md));
  3. X41 on the tailnet connection, then the rest of ADR 0009.
