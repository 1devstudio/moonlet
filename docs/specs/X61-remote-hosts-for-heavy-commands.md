# X61 — Remote hosts take heavy commands

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0009](../adr/0009-central-host-workers-live-copies.md), [0011](../adr/0011-machines-connect-over-the-tailnet.md)
- **Depends on:** [X41](X41-worker-link-and-project-identity.md), [X57](X57-tailnet-hosts.md)

## Summary

X41 lets only this Mac become a worker of its central host, from the **Use this Mac for heavy commands** switch. A remote host on the tailnet, such as a Linux build box or a second Mac, can lend its CPU too, but today it can only be linked from that host's own app, and a Linux server has none.

This spec gives every connected tailnet host in Settings › Machines › Hosts its own **Use for heavy commands** switch. Turning it on links that host to this Mac's central host as a worker. The first time, the remote host needs its own pairing with the central host: the app asks for a pairing code from the central host and hands it to the remote host's daemon, which pairs itself. The token never leaves the remote host.

As in X41, nothing is routed yet: the switch links the host as a worker, and routing comes in ADR 0009's routing slice.

## User journey

1. On the MacBook, Settings › Machines › Hosts lists `studio-mini`, marked **Central host**, and `build-box`, a Linux server added over the tailnet. Both are connected.
2. `build-box`'s row has a **Use for heavy commands** switch with the status line "Not linked". `studio-mini`'s row has none: it is the central host.
3. You turn the switch on. `build-box` has never paired with `studio-mini`, so a dialog asks for a pairing code from `studio-mini`. It says where to get one: **Let another Mac connect** in moonlet on `studio-mini`, or `moonletd pair` there.
4. On `studio-mini` you run `moonletd pair` and type the code into the dialog. The line under `build-box`'s switch reads "Linking to studio-mini…", then "Linked to studio-mini since 10:42".
5. On `studio-mini`, `moonlet rpc worker.list` lists `build-box`, and Settings › Hosts › Macs that can connect lists it too.
6. You turn the switch off: the line reads "Not linked" again. Turning it on later needs no code, since `build-box` kept its pairing.

## Behaviour and acceptance criteria

### Daemon

- [ ] `link.pair {central: {name, addrs}, code}` pairs this daemon with the central host at `addrs`, using a pairing code from that host, as a `desktop` device named after the worker's name. It stores `central` as `{name, addrs, token}` with the new token, exactly as `link.set` does, and returns `link.get`'s answer. The token is never returned. (`a_remote_host_pairs_with_the_central_host_and_links_as_a_worker`)
- [ ] `link.pair` checks `name` and `addrs` as `link.set` checks `central` (X41): a bad name, no addresses, an address that is not `ip:port`, or one of this machine's own Tailscale addresses is refused, before any pairing is tried. (`link_pair_refuses_a_bad_central_before_pairing`)
- [ ] A pairing that fails (a wrong or expired code, a host that cannot be reached) is an error with the reason as X57 words it, and the link settings stay as they were. (`a_wrong_code_leaves_the_link_as_it_was`)
- [ ] `link.set`, `link.retry` and `link.pair` are accepted from the Mac's own app, as before, and now also from a paired **Mac** (a `desktop` device) over the tailnet. A paired phone and the `moonlet` CLI are still refused with `forbidden`. (`a_paired_mac_sets_the_link_and_a_phone_or_the_cli_cannot`)
- [ ] From a paired Mac, `link.set` may change `worker` only. A `central` in it is refused with `forbidden`, so a paired Mac never hands a remote host a token; the central host changes only through `link.pair`. (`a_paired_mac_cannot_set_the_central_host_directly`)
- [ ] A daemon from before this spec answers `link.pair` with an unknown-method error. The app then shows "Update moonlet on build-box". `PROTOCOL_VERSION` does not change. (`linkPair.test.ts` an older host)

### Desktop

- [ ] Each tailnet host in **Remote hosts** has a **Use for heavy commands** row while it is connected, with a switch and the status line of its link, read with `link.get` from that host and following its `link.changed`. A disconnected host shows no such row. SSH hosts never do. (`remoteLink.test.ts` which hosts get the switch, `remote-worker.e2e.ts`)
- [ ] The central host's own row has no switch: the central host never links to itself (X41). (`remoteLink.test.ts` which hosts get the switch)
- [ ] While this Mac has no central host, the switch is off and disabled, and the line reads "Choose a central host first". (`remoteLink.test.ts` the remote status line)
- [ ] Turning the switch on: (`remoteLink.test.ts` what turning on needs, `remote-worker.e2e.ts`)
  - if the host's central host is this Mac's central host and its state is not `refused`, the app calls `link.set {worker: {enabled: true}}` on the host;
  - otherwise (no central host there, another one, or `refused`) the app asks for a pairing code from this Mac's central host, calls `link.pair` on the host with this Mac's entry for the central host (its name and addresses, never its token) and the code, and then `link.set {worker: {enabled: true}}`. Cancelling the dialog leaves the switch off.
- [ ] When the host's central host is another host, the dialog says so first: "build-box is linked to other-mini. Link it to studio-mini instead?". (`remoteLink.test.ts` what turning on needs)
- [ ] Turning the switch off calls `link.set {worker: {enabled: false}}` on the host. Its pairing stays, so turning it on again needs no code. (`remote-worker.e2e.ts`)
- [ ] The status line, one per link state, names the host: (`remoteLink.test.ts` the remote status line)
  - "Not linked"
  - "Linking to studio-mini…"
  - "Linked to studio-mini since 10:42"
  - "Reconnecting to studio-mini…"
  - "Update moonlet on studio-mini", with **Retry**
  - "studio-mini no longer accepts build-box", with **Pair again**, which opens the code dialog
  - "Linked to other-mini, not to studio-mini" when the host's central host is another one
  - any other connection error, with **Retry**
- [ ] A failed `link.pair` or `link.set` shows its error in the dialog or as a toast, and the switch shows the host's real state. (`remote-worker.e2e.ts`)

## UI

- **Settings › Machines › Hosts › Remote hosts:** under a connected tailnet host's row, a **Use for heavy commands** row like This Mac's: label, status line, the help text "For now this only links build-box to the central host. Commands are not routed there yet.", **Retry** or **Pair again** when the state calls for it, and the switch.
- **Pairing code dialog:** title "Pair build-box with studio-mini", one code field, the help text "Get a code on studio-mini: Let another Mac connect in moonlet, or `moonletd pair`.", **Cancel** and **Pair**. While pairing, **Pair** reads "Pairing…" and is disabled. An error shows under the field and keeps the dialog open.
- Settings search finds the row by "heavy commands".

## Protocol and RPCs

- **New method:** `link.pair {central: {name, addrs}, code}` → `LinkInfo` (local daemon, or a paired Mac over the tailnet).
- **Changed permission:** `link.set`, `link.retry` and `link.pair` accept a paired `desktop` device. `link.set` from one refuses `central`.
- No new events, no protocol bump: an older daemon refuses the unknown method.

## Data and config

- The remote host's `$MOONLET_HOME/link.json`, as in X41. `link.pair` writes the token it gets there, mode 0600.
- The central host's `mobile.json` gains the remote host as a paired `desktop` device, as for any Mac (X57).

## Security considerations

- **The token stays on the host that paired.** `link.pair` sends a pairing code, never a token, and a paired Mac cannot set `central` with `link.set`. The central host lists the remote host as its own device, so it can be removed on its own.
- **A paired Mac may now point a remote host's link at a host of its choosing.** X41 refused this because a linked host serves X60's copies. A paired Mac can already run any command on that host through a terminal (X57), so this gives it no new power. Phones keep the X41 refusal, as does an agent's `moonlet` CLI on the host itself.
- The pairing code crosses from this Mac to the remote host over the app's authenticated tailnet connection. It is single-use and expires as in X57.
- Linking makes the remote host a daemon that answers its central host's requests (X41's trust note). In this slice the only such request is `worker.ping`.

## Out of scope

- Routing commands to workers, slots and placement: ADR 0009's routing slice.
- SSH hosts. They have no tailnet listener to pair over.
- The central host minting codes for another device on request, which would let any paired Mac add devices to it.
- Clearing a remote host's central host from this Mac. Turning the switch off unlinks it; its pairing stays.
- Keep in sync (X60) on a remote host.

## Test plan

Every acceptance criterion maps to a test. Expected values are literals from this spec.

- **Daemon end-to-end, `crates/moonletd/tests/link.rs`:** three scratch daemons, as in X41's tests: a central host, a remote host on the tailnet, and a paired Mac that drives the remote host over its tailnet listener with its device token.
  - A paired Mac calls `link.pair` on the remote host with a code from `mobile.pair_start` on the central host, then `link.set {worker: {enabled: true}}`; the central host's `worker.list` has the remote host's name, and its devices list a `desktop` device with that name. The remote host's `link.get` has no `token`.
  - A wrong code: `link.pair` fails and `link.get` is unchanged.
  - A bad `central` (empty name, `studio-mini` as an address, one of the host's own addresses) is refused without contacting the central host.
  - A paired phone and the CLI get `forbidden` for `link.set`, `link.retry` and `link.pair`; a paired Mac gets `forbidden` for `link.set` with `central`.
- **Vitest, `apps/desktop/src/lib/remoteLink.test.ts`:** which host rows get the switch; the status line for each state; what turning on needs (enable, pair, or confirm a move), from literal `LinkInfo` values.
- **e2e, `apps/desktop/e2e/specs/remote-worker.e2e.ts`:** two scratch daemons: a central host on `::1` and a remote host on 127.0.0.1, which counts 127.0.0.1 as its own address and so never takes `::1` for itself. The app pairs with both and marks the first **Central host**. On the remote host's row, turning the switch on asks for a code (from `moonletd pair` on the central host), and the line reads "Linked to …"; the central host's `worker.list` lists the remote host. Turning it off reads "Not linked"; turning it on again links without a code. Saving settings is a crucial feature (X12).

## Open questions

None open. Decided by the user on 2026-10-22:

- **Every connected tailnet host gets the switch**, not only the central host.
- **The remote host pairs with the central host with its own code**, rather than reusing this Mac's token or letting the central host mint codes for paired Macs. It costs one code per host, once.
