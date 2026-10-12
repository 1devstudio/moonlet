# moonlet

**An agent-first terminal for macOS.** Run Claude Code, Codex and other coding agents side by side, each in its own git worktree, and review their work without leaving the app. Sessions keep running when you quit the app, close the lid or lose the network, on your Mac and on remote Linux hosts over SSH.

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#license)
[![Platform: macOS 14+](https://img.shields.io/badge/platform-macOS%2014%2B%20(Apple%20Silicon)-lightgrey.svg)](#requirements)
[![Status: early development](https://img.shields.io/badge/status-early%20development-orange.svg)](#project-status)

## Contents

- [Features](#features)
- [Project status](#project-status)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Remote hosts](#remote-hosts)
- [Command-line interface](#command-line-interface)
- [Architecture](#architecture)
- [Development](#development)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Features

- **Workspaces, projects and sessions.** A workspace groups projects (repository folders). Every session is a git worktree on its own branch, with its agent, terminals and diff. See the [glossary](CONTEXT.md).
- **Knows what agents are doing.** Agent hooks report *working*, *needs input*, *done* and *failed*. You get a notification, a badge, and one place listing every blocked agent (⌘K).
- **Review in place.** Changes against the base branch with hunk staging and comment-to-agent, a file tree, a code editor and Markdown preview with Mermaid. Create pull requests through `gh`.
- **Sessions you cannot lose.** The `moonletd` daemon owns every PTY. Reattaching restores the screen and scrollback, and daemon upgrades hand live PTYs to the new binary.
- **Remote hosts.** The same sessions on Linux machines over your existing SSH config, surviving disconnects.
- **Per-workspace Claude profiles.** Each workspace can use its own Claude Code login, so work and personal subscriptions never mix.
- **Scriptable.** The `moonlet` CLI and a local socket API expose sessions, terminals and every daemon method.

## Project status

moonlet is in early development (version 0.1). Expect rough edges and breaking changes between releases.

- Builds target **Apple Silicon** Macs running **macOS 14 or later**.
- Builds are **not yet signed with an Apple Developer ID** or notarized, so the first launch needs a manual approval (see [Installation](#installation)).
- Feature status is tracked per feature in the [spec index](docs/specs/README.md), and open items are listed in the [plan](docs/plan.md).

## Installation

### Download a release

1. Download the latest `.dmg` from [GitHub Releases](https://github.com/1devstudio/moonlet/releases).
2. Open it and drag **moonlet** to Applications.
3. Open moonlet. macOS blocks the first launch because the build is unsigned: open **System Settings › Privacy & Security** and click **Open Anyway**.

Installed apps update themselves from **Settings › Updates**.

### Build from source

See [Development](#development). `pnpm --filter @moonlet/desktop bundle` builds `moonlet.app` and a DMG, with `moonletd` and `moonlet` inside the app, under `target/release/bundle/`. The [release guide](docs/release.md) covers signing and publishing.

## Getting started

1. Launch moonlet and add a project: any local git repository.
2. Install agent hooks in **Settings** (or run `moonlet hooks install`), so moonlet can see what Claude Code and Codex are doing.
3. Start a session from the composer ("What do you want to work on?"). moonlet creates a worktree on a new branch and starts the agent in it.
4. Review the agent's changes in the **Changes** tab, stage or revert hunks, comment back to the agent, and create a pull request when you are done.

## Configuration

Each repository can carry a `.moonlet/config.toml`. Edit it by hand or in **Project settings** (the gear on a project in the sidebar, or `⋯` › **Project settings…**):

```toml
setup = "pnpm install"        # runs when a session's worktree is created
run = "pnpm dev"              # the Run button (⌘R)
archive = "docker compose down"
default_agent = "claude"      # claude, codex or a name from [agents]
base_branch = "main"

[agents]
claude-yolo = "claude --dangerously-skip-permissions"
```

| Key | Purpose |
|---|---|
| `setup` | Command run in a new session's worktree. |
| `run` | Command started by the Run button (⌘R). |
| `archive` | Command run before a session is archived. |
| `default_agent` | Agent started for new sessions. |
| `base_branch` | Branch that new sessions start from and diffs compare against. |
| `[agents]` | Custom agent commands, selectable like the built-in `claude` and `codex`. |

App data lives in `~/.moonlet`. Set `MOONLET_HOME` to use another directory.

## Remote hosts

**Settings › Remote hosts** lists the aliases in your `~/.ssh/config`. After you confirm, moonlet installs a checksum-verified `moonletd` built for the host's platform into `~/.moonlet/bin` on that host. The app checks the helper's version on every connection and offers to reinstall it on a mismatch.

Linux helpers are built with `scripts/build-remote.sh`, which needs [`cargo-zigbuild`](https://github.com/rust-cross/cargo-zigbuild).

## Command-line interface

The app bundles two binaries:

- `moonletd`, the session daemon. It owns every PTY and runs under launchd.
- `moonlet`, the command-line client for scripts and agents.

```sh
moonlet ls                       # list sessions
moonlet project ls               # list known projects
moonlet session new <project> "Fix the login form"   # new worktree + agent
moonlet hooks install            # install Claude Code and Codex hooks
moonlet notify --state done -m "Tests pass"   # report agent state for this terminal
moonlet rpc repo.list            # call any daemon method, print JSON

moonletd status                  # daemon info
moonletd upgrade                 # hand live sessions to a newer daemon
```

Run `moonlet --help` for the full list. The socket protocol is documented in [docs/protocol.md](docs/protocol.md).

## Architecture

```
┌──────────────────────┐        Unix socket         ┌──────────────────────┐
│  moonlet.app (Tauri) │ ◀── framed JSON + PTY ───▶ │       moonletd       │
│  React, xterm.js,    │          bytes             │  PTYs, sessions, git │
│  Monaco              │                            │  agent state, files  │
└──────────────────────┘                            └──────────┬───────────┘
          ▲                                                    │ SSH (proxy)
          │ moonlet CLI, agent hooks                           ▼
                                                    moonletd on remote hosts
```

| Path | Contents |
|---|---|
| [`crates/moonlet-proto`](crates/moonlet-proto) | Wire protocol: framed JSON messages and raw PTY bytes |
| [`crates/moonlet-core`](crates/moonlet-core) | PTYs, terminal state, sessions, agent state, git, files, workspaces, shell integration |
| [`crates/moonletd`](crates/moonletd) | The daemon: socket server, SSH `proxy`, live upgrade, launchd service |
| [`crates/moonlet-cli`](crates/moonlet-cli) | The `moonlet` CLI: agent hooks, `notify`, `ls`, `session`, `rpc` |
| [`apps/desktop`](apps/desktop) | Tauri 2 desktop app: React, xterm.js and Monaco |
| [`vendor/vt100`](vendor/vt100) | Patched fork of the `vt100` crate (see its [PATCHES.md](vendor/vt100/PATCHES.md)) |
| [`docs`](docs) | Plan, protocol, feature specs, ADRs, manual checks, release guide |

Design decisions are recorded as [architecture decision records](docs/adr).

## Development

### Requirements

- macOS 14 or later
- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 22 or later and [pnpm](https://pnpm.io)
- Xcode Command Line Tools (`xcode-select --install`)

### Build and run

```sh
pnpm install
pnpm dev     # builds moonletd and moonlet, starts Vite and the app
pnpm --filter @moonlet/desktop bundle   # release build: moonlet.app and a DMG
```

Keep development state away from your real data with `MOONLET_HOME`:

```sh
MOONLET_HOME=/tmp/moonlet-dev pnpm dev
```

The debug binaries are in `target/debug/` (for example `target/debug/moonlet ls`).

### Tests

```sh
pnpm test        # cargo test --workspace, then Vitest
pnpm e2e:build   # build the app with an embedded WebDriver server (a few minutes)
pnpm e2e         # drive the real app against a scratch daemon and repository
```

End-to-end tests never touch `~/.moonlet` or start a real agent. A failing test saves a screenshot in `apps/desktop/e2e/artifacts/`. The testing rules are in [CONTRIBUTING.md](CONTRIBUTING.md#tests).

## Documentation

- [Glossary](CONTEXT.md): the terms used in the UI, code and protocol
- [Plan](docs/plan.md): technology choices and implementation status
- [Feature specs](docs/specs/README.md): one spec per feature, with acceptance criteria
- [Architecture decision records](docs/adr)
- [Protocol](docs/protocol.md): the daemon's socket API
- [Manual checks](docs/manual-checks.md) and [release guide](docs/release.md)

## Contributing

Contributions are welcome: bug reports, feature ideas, documentation and code.

- **Found a bug?** [Open a bug report](https://github.com/1devstudio/moonlet/issues/new?template=bug_report.yml).
- **Have an idea?** [Suggest a feature](https://github.com/1devstudio/moonlet/issues/new?template=feature_request.yml).
- **Want to send code?** Read [CONTRIBUTING.md](CONTRIBUTING.md) first. It covers the development setup, the test rules, commit messages and the pull request process.

Please search [existing issues](https://github.com/1devstudio/moonlet/issues) before opening a new one.

## Security

Do not report security vulnerabilities in public issues. See [SECURITY.md](SECURITY.md) for how to report them privately.

## License

moonlet is licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or <https://www.apache.org/licenses/LICENSE-2.0>)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or <https://opensource.org/licenses/MIT>)

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.

Third-party code keeps its own license: [`vendor/vt100`](vendor/vt100) is MIT-licensed, and the fonts in `.design-sync/fonts` are under the SIL Open Font License.
