# ADR 0008: The phone app is a Tauri 2 iOS app that talks to the Mac's daemon over Tailscale

- **Status:** accepted (2026-10-13)
- **Changed by:** [ADR 0014](0014-one-account-across-hosts.md) (proposed, 2026-10-26). Phones pair with the central host, whichever app shows the code, and every member of the account accepts a paired device.
- **Related:** [X39](../specs/X39-phone-pairing-and-link.md) (pairing and the phone link), [X40](../specs/X40-mobile-app.md) (the phone app's screens), [R1](../specs/R1-ssh-hosts.md)–[R4](../specs/R4-unified-hosts-sidebar.md) (remote hosts)

## Context

The user wants a phone app that follows the agents away from the desk: answer permission asks and plans, read a session's chat and terminal, review and commit changes, and watch a PR's checks. Today the daemon only listens on a Unix socket in `~/.moonlet/run` and only accepts peers with its own uid (`crates/moonletd/src/server.rs`). Remote hosts are reached by the desktop app, which runs `ssh <host> ~/.moonlet/bin/moonletd proxy` and speaks the daemon protocol over the pipes. A phone can do neither.

## Decision

**App.** The phone app is a separate Tauri 2 app in `apps/mobile` with an iOS target, built with React, Vite and Tailwind v4 like the desktop app. Its webview code reuses the desktop's design tokens (`moonlet.css`), its pure `src/lib` modules and its small components. Its Rust core exposes the same command surface as the desktop core (`rpc`, `send_input`, `host_subscribe`, the `daemon-event` and `host-status` events), so `lib/daemon.ts` works unchanged on the phone. The same app also builds for macOS, which is how it is developed and checked without Xcode.

Alternatives: Expo / React Native gives native push and Face ID with less glue, but none of the desktop's DOM components carry over. A web app served by the daemon is the fastest to build, but iOS gives a home-screen web app no actionable notifications and no biometric gate. The user chose Tauri.

**Transport.** The daemon gains a TCP listener bound only to the Mac's Tailscale addresses (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`). Tailscale's WireGuard tunnel encrypts the traffic and admits only the user's tailnet. On top of that the daemon authenticates each phone with a device token handed out at pairing. The connection carries the daemon's existing framed protocol (`docs/protocol.md`) after one new `auth` exchange, so every request handler, event and PTY stream works for the phone as it does for the desktop.

Alternatives: a WebSocket from the webview would need TLS (WebKit blocks `ws://` from the app's secure origin) and a second framing. Listening on the LAN as well would need TLS with a certificate pinned at pairing; the user chose Tailscale only.

**Remote hosts.** The phone reaches the Mac's SSH hosts through the Mac: an `auth` with `route: "<alias>"` makes the daemon run the same `ssh … moonletd proxy` the desktop runs and pipe the frames through. The phone never needs SSH keys.

**Shared link code.** The code that drives one connection (request ids, timeouts, events, output batching), now inside the desktop's `hosts.rs`, moves to a new crate `crates/moonlet-link` that both apps use, so the phone gets the same behaviour on reconnects and slow replies.

## Consequences

- The daemon has a network listener for the first time. It is off until the user turns it on in Settings › Mobile, binds only to Tailscale addresses, and accepts only paired devices. X39 lists the checks.
- Push notifications (APNs) are not part of this decision. They need a paid Apple Developer account and a key the user provides; until then the phone app shows what the daemon reports while it is open.
- The iOS build needs Xcode and an Apple ID; the macOS build of the phone app does not.
