# X120 — Restart a tailnet host's daemon from the app

- **Status:** implemented (2026-11-28). Untried between real machines.
- **Priority / phase:** P2 · phase 4
- **PRD refs:** S1 (daemon lifecycle), S3 (upgrade keeps sessions)
- **Related ADRs:** [0011](../adr/0011-machines-connect-over-the-tailnet.md) (machines over the tailnet), [0014](../adr/0014-one-account-across-hosts.md) (headless hosts managed from the app)
- **Related specs:** [X97](X97-restart-the-daemon.md) (restart this Mac's daemon), [X69](X69-update-hosts-from-the-app.md) (update a tailnet host), [X57](X57-tailnet-hosts.md) (tailnet hosts), [X40](X40-mobile-app.md) (what a phone may call)

## Summary

X97 restarts this Mac's `moonletd`, and X69 updates another host's. A host that already runs this Mac's version has no way to get a fresh daemon from here. That matters when something happens only at daemon start: the clone naming repair of #697, a changed `~/.moonlet` file the daemon reads once, or a daemon that has grown slow. The user has to walk to the Mac mini, or ssh into the Linux box, and run `moonletd restart` there. This spec adds a **Restart** button to each tailnet host's row in Settings › Machines › Hosts. The host's daemon hands every session to a fresh process of its own binary, the way an update does (S3), so every agent there keeps running.

## User journey

1. The Mac mini runs the same moonlet as the MacBook, but its sessions still show projects named after clone folders. The user opens Settings › Machines › Hosts.
2. The mini's row reads "Connected · moonletd 0.2.2 · 12 sessions", with **Restart** among its buttons.
3. The user clicks it. The button reads "Restarting…". A few seconds later the toast reads "studio-mini restarted. Its sessions kept running." The projects now have their repositories' names.
4. When the restart can't happen, the row says why: "studio-mini runs moonlet 0.2.1, which can't be restarted from here", or the host's own reason ("an update or upgrade is already in progress").

## Behaviour and acceptance criteria

### The daemon restarts itself

- [x] `daemon.restart` hands every session to a new process of the daemon's own binary (S3) and answers `{pid}`, the pid of the daemon that answered, once the handoff is about to start. Every terminal keeps its id and its shell's pid under a new daemon pid. (`tests/update.rs` the_app_restarts_its_host_and_every_session_carries_on)
- [x] A paired Mac may ask in place of `hello`, as for `daemon.update`, so it works whatever protocol either side speaks; a daemon from before X120 closes the connection, which the app reads as `too_old`. (`tests/update.rs` a_mac_restarts_its_host_before_hello_but_a_phone_may_not; `tailnet.rs` a_host_from_before_the_restart_request_is_too_old)
- [x] The handoff starts only once the reply is on its way: after the reply is written and the connection closed, for the request before `hello`; 300 ms after the reply is queued, after `hello` (as X69). (both tests above get their reply)
- [x] One update, upgrade or restart at a time: during one, `daemon.restart` and `daemon.update` fail with `busy`. (`tests/update.rs` a_second_restart_during_one_is_busy) A restart whose handoff fails leaves the old daemon serving, as a failed S3 upgrade does (the shared `hand_off_claimed` path, tested by `an_update_whose_new_daemon_fails_puts_the_old_binaries_back`).
- [x] On Linux, a daemon whose binary an update replaced still finds its own path (`/proc/self/exe` reads `<path> (deleted)` then), and restarts into the binary now at that path. (`update.rs` unit test own_binary_drops_linuxs_deleted_mark)

### Who may ask

- [x] `daemon.restart` answers only a paired **Mac** over the tailnet (a `desktop` device) and the Mac's own app on the local socket. A phone, an agent's CLI and a worker's link get `forbidden`, before `hello` and after it. A cloud machine (X63) gets `forbidden`, since `CLOUD_METHODS` leaves it out and its device is not a `desktop` one (no test connects as a cloud machine yet, as in X69). (`tests/update.rs` a_paired_mac_may_restart_its_host_but_a_phone_and_an_agent_may_not, for a phone and local callers; `tests/link.rs` a_members_link_credential_is_refused_the_apps_methods_whatever_it_says_it_is, for a member's real link credential before and after `hello`)

### The app

- [x] A tailnet host that is connected offers **Restart** (`restartOffer`). An SSH host, a host that is not connected, and this Mac don't. (`hostRestart.test.ts` "offers Restart to a connected tailnet host only")
- [x] After the reply, the app asks the host's `daemon.info` every 2 s, and asks a host in error to connect again. The restart is done when it answers with a pid other than the one in the reply. The toast then reads "<label> restarted. Its sessions kept running." (`hostRestart.test.ts` "is done once a daemon with another pid answers", "keeps waiting while the old daemon or no daemon answers, and asks a dropped host to connect again"; `hostRestartStore.test.ts` "follows the host until a fresh daemon answers, then says its sessions kept running")
- [x] When no new daemon answers within 60 s of the reply, the row shows "<label> did not come back after the restart" if the host is unreachable, or "<label> still runs the same moonletd: the restart did not finish there (see its moonletd log)" if the old one answers. (`hostRestart.test.ts` "gives up a minute after the reply, saying whether the old daemon still runs")
- [x] A failed `daemon.restart` shows its message on the row, after an update's failure if both failed. `too_old` reads "<label> runs moonlet <version>, which can't be restarted from here". (`hostRestartStore.test.ts` "shows why a restart failed on its host"; `hostRestart.test.ts` "shows an update's failure first, then a restart's, else none"; the wording: `tailnet.rs` a_host_from_before_the_restart_request_is_too_old)
- [x] The button reads "Restarting…" from the click, while the host takes up to 30 s to answer: the row's old failure goes, and a second click asks nothing. (`hostRestartStore.test.ts` "is restarting from the click: the old failure goes, and a second click asks nothing while the host answers")

## UI

Settings › Machines › Hosts, each tailnet host's row, beside Update and Retry:

```
studio-mini   Connected · moonletd 0.2.2 · 12 sessions   [Restart] …
```

The button shows "Restarting…" and is disabled while the restart runs. A failure shows in red under the row, as an update's does, until the next restart is tried.

## Protocol and RPCs

- New method `daemon.restart`, no parameters, result `DaemonRestarted { pid: u32 }`.
- `moonlet_link::tailnet::restart(addrs, token)` sends it in place of `hello`, as `tailnet::update` does, and waits up to 30 s for the answer.
- New Tauri command `host_restart { id }`. The token stays in the app.

## Data and config

None.

## Security considerations

- A restart keeps every session and runs only the binary the daemon already runs from. Still, it briefly stops the host's terminals' output, and repeated restarts could keep a host busy, so it gets `daemon.update`'s gate: a paired Mac or the local app, never a phone, an agent, a worker link or a cloud machine.
- A phone routed to an SSH host can't reach it: `daemon.restart` is not in `PHONE_METHODS`.

## Out of scope

- **Force restart of a remote host.** A stuck daemon is the process that would have to answer. That needs a watchdog process on each host.
- **SSH hosts (R1).** The Mac restarts those over SSH already, by reconnecting.
- **Restart from the phone.**
- **Settings search for Restart.** The button sits on each host's row, which search already finds by "hosts".

## Test plan

- Rust e2e tests in `crates/moonletd/tests/update.rs`, beside X69's, against a daemon run from `<MOONLET_HOME>/bin`.
- A unit test in `crates/moonletd/src/update.rs` for the binary path.
- Vitest in `apps/desktop/src/lib/hostRestart.test.ts` (offer, follow) and `hostRestartStore.test.ts` (the flow against stand-ins for `host_restart` and `daemon.info`).
- By hand: restart a real Mac mini from the MacBook with an agent working there.
