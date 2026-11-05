---
title: Socket protocol
description: How the app, the CLI and the phone talk to moonletd, and how to call it from a script.
group: Reference
order: 2
---

## One protocol for every client

`moonletd` speaks one protocol to every client: the desktop app, the `moonlet` CLI, remote connections over SSH and the phone app. This page is a short overview. The full reference is [docs/protocol.md](https://github.com/1devstudio/moonlet/blob/main/docs/protocol.md), and the Rust source of truth is [crates/moonlet-proto](https://github.com/1devstudio/moonlet/blob/main/crates/moonlet-proto).

## Transport

- **Local:** a Unix socket at `~/.moonlet/run/moonletd.sock`. Its folder is `0700` and the socket is `0600`, and the daemon checks that the peer runs as the same user.
- **Over SSH:** `ssh <host> ~/.moonlet/bin/moonletd proxy` bridges stdin and stdout to the remote daemon's socket, and starts that daemon if it is not running. The daemon outlives the SSH connection.
- **Over the tailnet:** TCP port 47428 on the host's Tailscale addresses only, while tailnet access is on. Paired Macs and phones connect here, and their first message must authenticate.

## Framing

Every frame has a length, a kind and a payload:

```
[u32 BE length of kind + payload][u8 kind][payload]
```

The main kinds:

| Kind | Name | Payload |
|---|---|---|
| 1 | JSON | one message |
| 2 | Output | a session id, then raw PTY bytes, from the daemon |
| 3 | Input | a session id, then raw bytes, to the daemon |

Two more kinds carry git packs and the output of routed commands between machines. Frames are at most 16 MiB. Terminal bytes are never wrapped in JSON.

## Messages

Every JSON message is an object with a `t` tag.

The client speaks first with `hello`. The daemon answers `welcome`, or closes the connection when the protocol versions differ:

```json
{"t": "hello", "protocol": 6, "client": "my-script"}
```

```json
{"t": "welcome", "protocol": 6, "daemon_version": "0.1.37", "host": "studio-mini", "pid": 4242}
```

Protocol 6 is the version at the time of writing. A client must send the daemon's own version.

After that:

- A `request` `{id, method, params}` gets exactly one `response` `{id, result}` or `{id, error}`. An error is `{code, message}`.
- An `event` `{name, data}` is broadcast by the daemon to every connected client.

```json
{"t": "request", "id": 1, "method": "project.identity", "params": {"path": "~/code/storefront"}}
```

## Methods

Methods are grouped by prefix. A few of them:

| Group | What it covers |
|---|---|
| `daemon.*` | info, shutdown and upgrade |
| `terminal.*` | create, list, attach, detach, resize, kill, write and search |
| `workspace.*`, `section.*`, `project.*`, `session.*` | workspaces, sections, projects and worktree sessions |
| `chat.*` | structured agent chats: send a message, answer a permission, interrupt |
| `git.*`, `gh.*` | status, diffs, staging, commits, pull requests and issues |
| `repo.*` | adding a project from GitHub |
| `fs.*` | list, read, write and watch files |
| `design.*` | design systems and designs |

For example, `project.identity {path}` returns the identity of any folder: its normalized origin and its root commit. `session.attach` returns the session's info and a snapshot that redraws the screen; the first Output frame after it continues exactly where the snapshot ends.

Some methods answer only the Mac's own app or a paired Mac. A phone or the CLI gets `forbidden`.

## Call it from a script

You rarely need to speak the protocol yourself. `moonlet rpc` opens the socket, says hello, sends one request and prints the JSON result:

```sh
moonlet rpc repo.list
moonlet rpc project.identity '{"path": "~/code/storefront"}'
```

It uses the same socket as the other `moonlet` commands: `--socket`, else `$MOONLET_SOCK`, else `~/.moonlet/run/moonletd.sock`. See [Command line](/docs/command-line).

## Versioning

The protocol version is bumped on any incompatible change. When the app and a daemon speak different versions, the app offers to upgrade the daemon. On the command line, `moonletd upgrade` replaces the running daemon and keeps every session.
