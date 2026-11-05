---
title: Installation
description: Install moonlet on your Mac, keep it up to date, or build it from source.
group: Start here
order: 2
tags: [macOS 14+, Apple Silicon]
---

## Requirements

- A Mac with **Apple Silicon**, running **macOS 14 or later**. Releases are built for Apple Silicon only.
- `git`, since every session is a git worktree.
- The agents you want to use, such as Claude Code (`claude`) or Codex (`codex`). moonlet starts them in your login shell, so it finds the ones on your `PATH`.
- The GitHub CLI, `gh`, signed in, to create pull requests and to clone private repositories.
- [Tailscale](https://tailscale.com), only if you want to link more machines or your phone.

## Download the app

1. Download the latest `.dmg` from [GitHub Releases](https://github.com/1devstudio/moonlet/releases).
2. Open it and drag **moonlet** to Applications.
3. Open moonlet from Applications.

Release builds are signed with an Apple Developer ID and notarized by Apple.

### The background daemon

The app talks to `moonletd`, a daemon that owns every terminal and agent. It keeps running when you close the app window, so your sessions keep running too.

On first launch, moonlet registers the daemon as a login item, and macOS shows its own "Background Items Added" notice. The daemon then starts at every login and restarts if it crashes. It is listed as **moonlet** in System Settings › General › Login Items.

You control it in **Settings › General › Background daemon** with **Start the moonlet daemon at login**. Turning it off asks first, because the daemon serving your sessions may stop.

> **Note:** Open moonlet from Applications, not from the mounted DMG. An app opened from the DMG registers no login item, and the switch says **Move moonlet to Applications first**.

## Updates

moonlet checks GitHub for a new release ten seconds after launch and every hour after that.

1. When it finds one, a toast says, for example, "moonlet 0.1.15 is available", with an **Install** button. An **Update to 0.1.15** button also appears in the sidebar footer.
2. Click **Install**. The footer button shows the download progress, then **Restart to update**.
3. Click **Restart to update**. moonlet relaunches as the new version and upgrades the daemon. Every terminal and agent is still there.

**Settings › General › Updates** shows the running version and a **Check now** button. Turn off **Check for updates automatically** to check only when you ask. The same page shows your Claude Code version, with **Update to** a newer one when there is one.

> **Note:** In-app updates are new and have not yet been tried with a real release.

## Build from source

You need:

- macOS 14 or later
- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 22 or later and [pnpm](https://pnpm.io)
- Xcode Command Line Tools (`xcode-select --install`)

Clone the repository and run:

```sh
pnpm install
pnpm dev     # builds moonletd and moonlet, starts Vite and the app
```

To build `moonlet.app` and a DMG, with `moonletd` and `moonlet` inside the app:

```sh
pnpm --filter @moonlet/desktop bundle
```

The output is under `target/release/bundle/`. The [release guide](https://github.com/1devstudio/moonlet/blob/main/docs/release.md) covers signing and publishing.

Keep development state away from your real data with `MOONLET_HOME`:

```sh
MOONLET_HOME=/tmp/moonlet-dev pnpm dev
```

The debug binaries are in `target/debug/`, for example `target/debug/moonlet ls`. [CONTRIBUTING.md](https://github.com/1devstudio/moonlet/blob/main/CONTRIBUTING.md) covers tests and the pull request process.

## Install on a Linux host

A Linux machine (x86_64 or aarch64) can run `moonletd` as an always-on host for your Mac. It gets moonlet from a script published with every release:

```sh
curl -fsSL https://github.com/1devstudio/moonlet/releases/latest/download/install.sh | sh
```

The script checks the SHA-256 of `moonletd` and `moonlet`, installs them in `~/.moonlet/bin`, runs the daemon as a systemd user service, turns on tailnet access and shows a pairing code. It never uses `sudo`. Run it again to update: sessions keep running.

[Add an always-on host](/docs/add-an-always-on-host) walks through pairing the host with your Mac, and setting up a Mac as a host.

## Where your data lives

moonlet keeps its data in `~/.moonlet`, including session worktrees under `~/.moonlet/worktrees/`. Set `MOONLET_HOME` to use another directory.

Next, [start your first session](/docs/your-first-session).
