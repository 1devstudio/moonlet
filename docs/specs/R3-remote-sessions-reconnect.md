# R3: Remote sessions survive disconnects

- **Status:** implemented
- **Priority / phase:** P0 · phase 2
- **PRD refs:** R3, journey J5, metric "reattach < 1.5 s remote"

## Summary

`ssh <host> ~/.jaunt/bin/jauntd proxy` is a short-lived stdio bridge to the long-lived daemon on the host, and starts it if needed. When the link drops, only the bridge dies; agents keep running. The app reconnects with backoff and resyncs every visible pane from a snapshot.

## Behaviour and acceptance criteria

- [x] `jauntd proxy` starts the daemon detached (`setsid`) if it is not running, then copies bytes both ways until either side closes.
- [x] App reconnect loop: status `reconnecting` with backoff from 300 ms doubling to 5 s. Pending RPCs fail with `disconnected`. On reconnect the host is reloaded and every terminal re-attaches, receiving a fresh snapshot.
- [x] The workspace view shows a banner, "Reconnecting to <host>… agents keep running", while the link is down.
- [x] Remote file tree, diffs, Markdown preview and git all go through the same RPCs, so they behave the same as local.

## Test plan

`crates/jauntd/tests/proxy.rs`: `proxy_autostarts_daemon_and_sessions_survive_link_loss` kills the bridge mid-session, opens a new one and checks the snapshot.
