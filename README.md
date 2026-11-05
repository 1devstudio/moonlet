# moonlet

**Your coding agents, on every machine you own, following you to your phone.** moonlet links your MacBook, an always-on Mac mini or Linux box, and your iPhone into one mesh. Start a session at your desk, close the lid, and carry on from your phone: the session keeps running on another machine and comes back to the Mac when you type there again.

Each agent (Claude Code, Codex or your own) runs in its own git worktree, and you review its work without leaving the app. Prototype a UI against your project's own design system before any code is written, and start work straight from a Linear, Jira, ClickUp or GitHub issue.

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#license)
[![Platform: macOS 14+](https://img.shields.io/badge/platform-macOS%2014%2B%20(Apple%20Silicon)-lightgrey.svg)](#requirements)
[![Status: early development](https://img.shields.io/badge/status-early%20development-orange.svg)](#project-status)

## Contents

- [One mesh of machines, and your phone](#one-mesh-of-machines-and-your-phone)
- [Design systems and quick prototypes](#design-systems-and-quick-prototypes)
- [Start from a task](#start-from-a-task)
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

## One mesh of machines, and your phone

Most agent tools tie a session to the laptop it started on. moonlet treats the machines you own as one **account**: a MacBook, an always-on Mac mini or Linux VPS that acts as the **central host**, and your iPhone. They reach each other over your [Tailscale](https://tailscale.com) tailnet and pair once, with no SSH keys or port forwarding.

- **The same workspaces everywhere.** Every member of the account keeps the same workspaces, sections, design systems and designs. A change made on one machine shows up on the others within seconds.
- **Every session has a copy.** The machine running an agent sends the central host a checkpoint of the worktree and the transcript after every tool call. Nothing lives only on the laptop.
- **Sessions follow you.** Close the MacBook's lid and the central host carries on from the last checkpoint, including a turn that sleep cut off. Type into the session on another Mac and it moves there once the current turn ends. Choosing **Move to** a machine in the session's menu pins the session there when you want it to stay put.
- **Switch to your phone in one step.** Pair the moonlet iPhone app by scanning a code. It lists every session of the account, wherever it runs, and answers permission prompts and plans in place. It opens any session's chat, terminal, changes (with line comments to the agent) and pull request, and starts new sessions. A message from the phone goes to whichever machine runs the session, so the phone never moves a session by itself.
- **The parts that git ignores come along.** `.env` files, and any other patterns you list per project, are copied between members outside git. Sign-ins such as `gh auth login` open the browser on the machine you are using.
- **Heavy work goes to free machines.** Commands you mark as heavy, such as a test suite, run on the least busy machine of the account, or on a cloud machine that moonlet creates for the job and removes when it is idle. Each run is a job you can follow from the session's **Jobs** tab.

Remote machines can also be plain SSH hosts. See [Remote hosts](#remote-hosts) for setup.

## Design systems and quick prototypes

Work out what a screen should look like before an agent writes the code, without running the project.

- **A design system from your code.** An agent reads a project's source and writes its design system as static HTML and CSS: the tokens as they are, colours, type and spacing, one card per component with every variant labelled, and whole layouts. Each card is checked by rendering it, then graded. Because the cards are plain HTML, this works with any stack. A later sync rewrites only the cards whose source changed, and proposes a change instead of overwriting a card you edited by hand.
- **Design mode (⌃⌘D).** Describe a screen and a design agent builds it as HTML pages on one of your design systems, shown live on a canvas at the viewport you pick. Iterate by chatting, by pinning comments on elements and sending them to the agent, or by editing directly in a visual editor: move, resize, restyle, insert components and edit text. Every agent turn and every burst of hand edits is a snapshot you can go back to.
- **From prototype to pull request.** **Build it** starts a session with the design's pages attached. Inside a session, `/moonlet-design` makes a session design in the worktree under `docs/design/`, so the prototype, its spec and the code ship in the same pull request.

## Start from a task

moonlet connects to the trackers your team already uses: **Linear**, **Jira Cloud**, **ClickUp** and **GitHub Issues**.

- **Tasks mode** shows a tracker's board with its own columns, filters and sprint, and the sessions, worktrees and pull requests working on each issue. Drag a card to another column to move the issue in its tracker, or press `+` on a column to create one.
- **Start a session from a task.** **Start** on a card opens the composer with the issue's title and description as the first message, the matching project picked, and a branch named after the issue. One click can also move the issue to In Progress and assign it to you.
- **The tracker keeps in step.** A session is linked to its task by its branch, its pull request or by hand, and shows the task above the conversation. moonlet can move the issue when the session starts, when its pull request opens and when it merges, and flags a task whose state no longer matches its work. Read and post the issue's comments without leaving the app.
- **On the phone too.** The iPhone app has the same boards: move tasks, comment, create issues and start a session from a task while you are away from the desk.

## Features

- **Workspaces, projects and sessions.** A workspace groups projects (repository folders). Every session is a git worktree on its own branch, with its agent, terminals and diff. See the [glossary](CONTEXT.md).
- **Knows what agents are doing.** Agent hooks report *working*, *needs input*, *done* and *failed*. You get a notification, a badge, and one place listing every blocked agent (⌘K).
- **Review in place.** Changes against the base branch with hunk staging and comment-to-agent, a file tree, a code editor and Markdown preview with Mermaid. Create pull requests through `gh`.
- **Sessions you cannot lose.** The `moonletd` daemon owns every PTY. Reattaching restores the screen and scrollback, and daemon upgrades hand live PTYs to the new binary.
- **Remote hosts.** The same sessions on another Mac or a Linux machine, paired once over your tailnet or reached through your existing SSH config. They survive disconnects.
- **Per-workspace Claude profiles.** Each workspace can use its own Claude Code login, so work and personal subscriptions never mix.
- **Scriptable.** The `moonlet` CLI and a local socket API expose sessions, terminals and every daemon method.

## Project status

moonlet is in early development (version 0.1). Expect rough edges and breaking changes between releases.

- Builds target **Apple Silicon** Macs running **macOS 14 or later**.
- Release builds are signed with an Apple Developer ID and notarized by Apple.
- The mesh features (session copies, sessions that follow you, routed commands and cloud workers) are new and not yet tried between real machines. Expect rough edges there.
- Feature status is tracked per feature in the [spec index](docs/specs/README.md), and open items are listed in the [plan](docs/plan.md).

## Installation

### Download a release

1. Download the latest `.dmg` from [GitHub Releases](https://github.com/1devstudio/moonlet/releases).
2. Open it and drag **moonlet** to Applications.
3. Open moonlet.

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

A remote host is another machine running `moonletd`: a Mac, or a Linux machine (x86_64 or aarch64). Its sessions keep running when your Mac sleeps or loses the connection, and the app reconnects when it can.

### Over your tailnet

The simplest way: both machines are on the same [Tailscale](https://tailscale.com) tailnet, and your Mac pairs with the host once. No SSH keys or `~/.ssh/config` entries are needed.

1. Put moonlet on the host.
   - **A Mac:** install moonlet.app. In **Settings › Machines › Hosts**, turn on **Allow connections from my tailnet**, then click **Let another Mac connect**.
   - **A Linux machine:** run

     ```sh
     curl -fsSL https://github.com/1devstudio/moonlet/releases/latest/download/install.sh | sh
     ```

     The script checks the SHA-256 of `moonletd` and `moonlet`, installs them in `~/.moonlet/bin`, runs the daemon as a systemd user service, turns on tailnet access and shows a pairing code. It never uses `sudo`. Run it again to update: sessions keep running. Ending the command with `| sh -s -- --uninstall` instead removes moonlet and keeps your data in `~/.moonlet`.
2. On your Mac, open **Settings › Machines › Hosts › Add host**. Enter the code (such as `7KQ2M-X9PDA`) and the host's name on your tailnet (such as `build-box`), or paste the pairing link.

A code works once, for five minutes. To take access back, remove the Mac from the host's list, or the host from your Mac's. On a Linux host, `moonletd pair` shows a new code. When the host and your Mac speak different protocol versions, the host's row says which one to update.

### Over SSH

**Settings › Machines › Hosts › Add host › Add an SSH host** offers the aliases in your `~/.ssh/config`. moonlet connects with your own OpenSSH config, keys and agent. After you confirm, it installs a checksum-verified `moonletd` built for the host's platform into `~/.moonlet/bin` on that host. The app checks the helper's version on every connection and offers to reinstall it on a mismatch.

To build the Linux helpers yourself, run `scripts/build-remote.sh`, which needs [`cargo-zigbuild`](https://github.com/rust-cross/cargo-zigbuild).

## Command-line interface

The app bundles two binaries:

- `moonletd`, the session daemon. It owns every PTY and runs under launchd on a Mac, or systemd on Linux.
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
moonletd tailnet on              # let paired Macs and phones connect over Tailscale
moonletd pair                    # show a one-time pairing code
```

Run `moonlet --help` for the full list. The socket protocol is documented in [docs/protocol.md](docs/protocol.md).

## Architecture

```
┌──────────────────────┐        Unix socket         ┌──────────────────────┐
│  moonlet.app (Tauri) │ ◀── framed JSON + PTY ───▶ │       moonletd       │
│  React, xterm.js,    │          bytes             │  PTYs, sessions, git │
│  Monaco              │                            │  agent state, files  │
└──────────────────────┘                            └──────────┬───────────┘
          ▲                                                    │ tailnet or SSH
          │ moonlet CLI, agent hooks                           ▼
                                                    moonletd on remote hosts
```

| Path | Contents |
|---|---|
| [`crates/moonlet-proto`](crates/moonlet-proto) | Wire protocol: framed JSON messages and raw PTY bytes |
| [`crates/moonlet-core`](crates/moonlet-core) | PTYs, terminal state, sessions, agent state, git, files, workspaces, shell integration |
| [`crates/moonletd`](crates/moonletd) | The daemon: socket server, tailnet listener and pairing, SSH `proxy`, live upgrade, launchd and systemd services |
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
