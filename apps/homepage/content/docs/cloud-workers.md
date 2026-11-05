---
title: Cloud workers
description: Let the central host rent machines for heavy commands when your own are busy, and remove them once they sit idle.
group: Mesh
order: 4
tags: [Hetzner Cloud, Google Cloud, Tailscale]
---

## What a cloud worker is

When your machines are busy, the central host can rent a machine from a cloud provider to run [heavy commands](/docs/heavy-commands). It makes the machine when it is needed and removes it once it has sat idle for the time you set. A cloud machine only runs routed commands: agents and sessions stay on the central host. It is a worker, never a member of your account.

> **Note:** Cloud workers are new and not yet tried with a real provider account. Expect rough edges.

## Providers

Two providers are on offer:

- **Hetzner Cloud**, with an API token for a Hetzner project. The token can create and delete anything in its project, so use a project made for moonlet.
- **Google Cloud**, with a service-account key (JSON) for a Google Cloud project with Compute Engine turned on. The service account needs the **Compute Instance Admin (v1)** role. **Longest a machine lives (hours)** sets when Google deletes a machine by itself, even while the central host is off. Empty means 12.

## Set up the central host

Open **Settings › Machines › Cloud workers** for your central host, such as studio-mini.

1. Click **Add provider** and pick a provider. Paste its token or key. A saved secret shows "Saved", with **Replace**.
2. Under **Tailscale**, choose how machines join your tailnet with **Machines join with**:
   - **OAuth client (recommended)**: an OAuth client with the Auth Keys scope and the tag `tag:moonlet-worker`. The central host makes a one-off key for each machine. **Check** makes a test key with the saved client and revokes it at once.
   - **Auth key**: a reusable, ephemeral, pre-approved key with the tag. It works until it expires, at most 90 days.
3. Add the lines the page shows to your tailnet policy, so tagged machines reach only the central host's port:

   ```json
   "tagOwners": { "tag:moonlet-worker": ["autogroup:admin"] },
   "acls": [
     { "action": "accept", "src": ["tag:moonlet-worker"], "dst": ["100.101.102.103:47428"] }
   ]
   ```

4. Set the limits: **Remove a machine after** (15 minutes idle by default), **At most** (2 machines by default) and **Monthly limit** (40 machine-hours by default).

The central host must allow connections from your tailnet, so a new machine can pair with it.

## Turn it on for a project

In **Settings › Projects › shop (studio-mini)**, the **Cloud workers** section has **Use cloud machines when every worker is busy**, then **Provider**, **Location**, **Machine type** and **Image**. A script that installs the project's tools on each new machine goes in the project config:

```toml
[heavy]
commands = ["pnpm test"]
machine_setup = "scripts/ci-deps.sh"
```

`machine_setup` runs as root on each new machine, after it pairs. It must be a file in the repository of at most 16 KiB.

## When a machine is made

- **Overflow.** When no worker has room for a command, central host included, the command still runs on the central host. A machine starts and takes the next one.
- **A session that asks for the cloud.** Tick **Run heavy commands in the cloud** in the new-session composer. Its routed commands go to the project's cloud machine first. When none is ready, a command starts one and waits for it. In the Jobs tab, **Run on studio-mini now** runs a waiting job on the central host instead.
- **On request.** **Start a machine** on the project page, or `moonlet worker up` from a terminal or an agent. `moonlet worker ls` lists the machines, and `moonlet worker down <name>` removes one once its commands end.

Agents can start machines, but only you change the tokens and limits.

## How a machine joins

A machine is named like `moonlet-shop-7k2q`. Its first-boot script:

1. joins your tailnet with a one-off, ephemeral, tagged key that expires within an hour;
2. installs the central host's exact moonlet version;
3. pairs with the central host using a join code that works once, for 30 minutes, for that machine only;
4. runs `machine_setup`.

The Workers page and the Jobs tab show these steps with their times. A machine not ready 15 minutes after it was created is removed.

## Idle time and removal

A machine is removed after the idle time with no routed command running on it. With 0, it goes as soon as its command ends. One that has run nothing yet stays at least 5 minutes. **Remove now** on the Workers page removes an idle machine at once.

Hetzner bills every started hour, so an idle machine stays until shortly before the hour you paid for ends. Google bills by the second, with a one-minute minimum, so its machines go at the idle time.

A machine whose link has been down for 10 minutes is removed too. Every 10 minutes the central host also destroys any machine labelled with its id that it has no record of.

## What a machine gets, and what it never gets

A cloud machine gets the session's current files and its `HEAD` commit, from the central host and never from origin. That includes every tracked file and every untracked file that is not ignored, and the `[heavy] env` variables you approved. It gets no older history: a secret only in earlier commits never reaches it. A secret in a tracked file does, so remove secrets from the files, not only from the history.

A cloud machine never gets:

- your git credentials;
- the provider token or key, or the Tailscale secret;
- `.env` and the project's other copied files, unless you turn on **Also to cloud machines** in the project's **Copied between your Macs** section, see [Sessions that follow you](/docs/sessions-that-follow-you);
- access to sessions, terminals or settings: its token reaches only the worker methods for its own routing copies.

A Google Cloud machine also has no service account and no SSH keys.

## Costs

The machines run in your own provider account, and your provider bills you for them. moonlet shows no prices. The Cloud workers page shows the usage, such as "12.5 of 40 machine-hours this month", counted as your provider bills it. At a limit, no new machine starts.

If a machine cannot be removed, a toast says so, with **Retry**: a machine is billed until it is removed.
