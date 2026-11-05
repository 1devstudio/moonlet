---
title: Add an always-on host
description: A Mac mini or a Linux VPS that stays on keeps a copy of every session, carries on when your MacBook sleeps, and is what your phone connects to.
group: Mesh
order: 1
tags: [5 minutes, macOS or Linux, Needs Tailscale]
---

## Before you start

Both machines need to be on the same [Tailscale](https://tailscale.com) tailnet. You do not need SSH keys or `~/.ssh/config` entries: your Mac pairs with the host once, with a code.

- A Mac running moonlet, such as your MacBook.
- The host: a Mac, or a Linux machine on x86_64 or aarch64.

## Put moonlet on the host

<div class="tabs">
<div class="tabs__bar" role="tablist"><button class="tabs__tab tabs__tab--on" role="tab" aria-selected="true" data-tab="linux">Linux</button><button class="tabs__tab" role="tab" aria-selected="false" data-tab="mac">Mac</button></div>
<div class="tabs__panel" data-panel="linux">

Run this on the host:

```sh
curl -fsSL https://github.com/1devstudio/moonlet/releases/latest/download/install.sh | sh
```

The script checks the SHA-256 of `moonletd` and `moonlet`, installs them in `~/.moonlet/bin`, runs the daemon as a systemd user service, turns on tailnet access and shows a pairing code. It never uses `sudo`. Run it again to update: sessions keep running.

</div>
<div class="tabs__panel" data-panel="mac" hidden>

Install moonlet.app on the host. In **Settings › Machines › Hosts**, turn on **Allow connections from my tailnet**, then click **Let another Mac connect**. The host shows a pairing code.

</div>
</div>

## Pair your Mac

1. On your Mac, open **Settings › Machines › Hosts › Add host**.
2. Enter the code, such as `7KQ2M-X9PDA`, and the host's name on your tailnet, such as `studio-mini`. Or paste the pairing link.
3. On the host's row, choose **Make central host**.

> **Note:** A code works once, for five minutes. On a Linux host, `moonletd pair` shows a new one.

When the host and your Mac speak different protocol versions, the host's row says which one to update.

## What changes

Once your Mac has a central host, it joins your **account**: the machines that share your workspaces.

- Every session gets a copy on the central host, checkpointed after each tool call.
- When your MacBook sleeps, the central host continues its sessions from the last checkpoint.
- Phones you pair connect to the central host, and see every session of the account.

See [Sessions that follow you](/docs/sessions-that-follow-you) for how sessions move between machines.

### Let it take heavy commands

List the commands a project may run elsewhere in its `.moonlet/config.toml`, then approve them in **Project settings**:

```toml
[heavy]
commands = ["pnpm test", "pnpm build"]
outputs = ["coverage"]
```

An approved command runs on the least busy machine, and its output comes back to the agent. See [Heavy commands](/docs/heavy-commands).

## Take access back

Remove your Mac from the host's list, or the host from your Mac's. To remove moonlet from a Linux host and keep your data in `~/.moonlet`:

```sh
curl -fsSL https://github.com/1devstudio/moonlet/releases/latest/download/install.sh | sh -s -- --uninstall
```

## Commands on the host

| Command | What it does |
|---|---|
| `moonletd status` | Daemon info |
| `moonletd tailnet on` | Let paired Macs and phones connect over Tailscale |
| `moonletd pair` | Show a one-time pairing code |
| `moonletd upgrade` | Hand live sessions to a newer daemon |
