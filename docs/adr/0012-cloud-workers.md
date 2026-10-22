# ADR 0012: The central host makes and removes cloud workers through provider adapters

- **Status:** proposed (2026-10-22)
- **Builds on:** [ADR 0009](0009-central-host-workers-live-copies.md) (central host, workers, routed commands), [ADR 0011](0011-machines-connect-over-the-tailnet.md) (the tailnet transport, pairing).
- **Changes:** ADR 0011's "moonlet does not install or configure Tailscale", for cloud machines only.
- **Specs:** [X62](../specs/X62-routed-commands.md) (routing), [X63](../specs/X63-cloud-workers.md) (cloud workers).

## Context

ADR 0009 lets heavy commands (test suites, builds) run on whichever worker has a free slot: a linked Mac or the central host itself. It names "later a cloud machine" as a worker and leaves the rest to its last slice. When every Mac is busy or closed, a heavy command runs on the central host and waits behind the others. A machine rented by the hour can take that load, but only if it is there when it's needed and gone when it isn't: a forgotten machine costs money every hour.

Today every machine moonlet talks to was set up by the user: they install Tailscale and moonlet, then pair it (ADR 0011). A cloud worker has to come up with nobody at its keyboard.

## Decision

- **Cloud workers run routed commands only.** The agent, the session and its worktree stay on the central host. A cloud machine is one more worker for X62's scheduler, with a routing copy of the session's files. It never runs an agent or a whole session. Decided by the user on 2026-10-22.
- **The central host owns the machines.** Its daemon calls the provider's API, keeps the record of every machine it made, and removes them. The app only edits the settings. A machine serves one project, so its toolchain and setup match that project.
- **Providers are adapters.** Five operations: list machine types, create, get, list by label and destroy. Enrolment, scheduling, idle time, limits and the cleanup sweep are shared and know no provider. Hetzner Cloud comes first. Adding a provider means adding one module and its settings fields. Decided by the user on 2026-10-22.
- **When a machine is made:** in two ways, both decided by the user on 2026-10-22:
  - **overflow:** for a project that allows it, when no worker has a free slot;
  - **on request:** a session set to run its heavy commands in the cloud, `moonlet worker up`, or a button in Settings.

  Overflow never makes a command wait for a machine to boot: the command runs on the central host, and the machine takes the next one. A command that asked for the cloud waits for it.
- **When a machine is removed:** after a configurable idle time with no routed command running on it. `0` removes it as soon as its command ends. Decided by the user on 2026-10-22.
- **Coming up unattended.** The machine's first-boot script (cloud-init `user_data`):
  - joins the tailnet with a one-off, ephemeral, tagged auth key that the central host mints from a Tailscale OAuth client the user gave it;
  - installs the central host's own moonlet version with the X58 install script;
  - pairs with the central host using a one-time join code that the central host made for that machine.

  No long-lived secret is in `user_data`, which the provider keeps readable.
- **Cloud machines are limited devices.** Their device token reaches the worker methods only, not sessions, terminals or settings. A cloud machine gets the project from the central host as git objects, never from origin, so it holds no git credentials.
- **Nothing is left running by mistake.** Every machine is recorded before the create call and labelled with the central host's id. A sweep at start and every 10 minutes destroys labelled machines that the central host has no live record of. Monthly machine-hour and machine-count limits cap spending.

## Considered options

- **Whole sessions on a fresh machine** (agent, worktree and commands there, made at session start and destroyed at archive). It needs no routing, but the agent's transcript and the session live on a machine that is about to be destroyed, and it duplicates the remote-host model. The user chose routed commands.
- **Creating a machine for every command.** It is clean, but every command waits for boot, install, clone and setup. With an idle time of `0` the user can still get this behaviour, but only once the machine's first command is over.
- **User-written create and destroy scripts** in place of adapters. They work with any provider, but each user has to write the cleanup and labelling correctly, and a bug in them leaves machines billing. Adapters keep that logic in one tested place.
- **Fly.io Machines or AWS EC2 first.** Fly starts faster, but runs Tailscale in userspace and needs volumes for big builds. EC2 needs IAM, VPC and AMI setup. Hetzner's plain VMs with cloud-init fit X58's install script as it is.
- **A long-lived Tailscale auth key in `user_data`.** Anyone with the provider token could read it and add machines to the tailnet. A one-off key, minted per machine and expiring within an hour, limits that.

## Consequences

- **ADR 0011 changes for cloud machines:** moonlet installs Tailscale on machines it creates. The user still sets up Tailscale on their own machines.
- **New secrets on the central host:** the provider token and the Tailscale OAuth client. The central host may be a headless Linux machine with no keychain, so they live in `$MOONLET_HOME/cloud.json` with mode 0600, as `link.json` does. Settings recommend a dedicated provider project and a Tailscale ACL that lets the worker tag reach only the central host's listener.
- **Trust.** A cloud machine runs what the central host sends it, as any worker does. It holds the project's files and history, including untracked files that are not ignored, but not `.env` or the other files that never sync (X60).
- **Spending** is bounded by the limits, not by who asks. An agent can ask for a machine with `moonlet worker up`, but it cannot change the limits or the tokens.
- **Delivery:** X62 (routing) first, then X63 (cloud workers). Takeover stays in ADR 0009's last slice.
