# ADR 0009: A central host owns sessions; workers hold live copies and run heavy commands

- **Status:** proposed (2026-10-13)
- **Transport changed by:** [ADR 0011](0011-machines-connect-over-the-tailnet.md) (2026-10-20). Workers and the apps reach the central host over its tailnet listener with a device token, not over `ssh <alias> moonletd proxy`. The "Workers dial out" bullet below describes the original plan.
- **Builds on:** [ADR 0008](0008-phone-link-over-tailscale.md) (the phone app and `moonlet-link`), [R1](../specs/R1-ssh-hosts.md)–[R3](../specs/R3-remote-sessions-reconnect.md) (remote hosts over SSH), [S3](../specs/S3-live-upgrade.md) (live upgrade).

Sessions should survive a closed laptop and be followed from a phone. So they live on one always-on **central host**, for example a Mac mini or a Linux server. Heavy commands (test suites, builds) should still use the laptop's CPU while the laptop is open, overflow to other machines when it is busy, and never stall when it closes. Today a host owns everything for its sessions (worktree, agents, git, files), and daemons never talk to each other. [ADR 0008](0008-phone-link-over-tailscale.md) already lets a phone reach a Mac's daemon over Tailscale. This ADR decides which Mac that is, and how other Macs share the work.

**Decision.**

- **The central host owns every session.** The worktree, the agents and the session state stay there, whichever device created the session. Every other device is a window onto it. Phones pair with the central host through ADR 0008's listener, so they reach every session without knowing which laptop is open.
- **Workers dial out.** A **worker** (the laptop, the central host itself, later a cloud machine) connects to the central host over the existing transport, `ssh <alias> moonletd proxy`. No machine opens a port, the trust model stays OpenSSH, and a sleeping laptop drops its link without anyone noticing.
- **Workers hold live copies.** A **live copy** is a worker's copy of a session's files, at the same path when possible, kept in sync with the central host both ways.
  - Git's own rules decide what syncs: tracked and untracked files, not ignored ones, without global excludes. So `node_modules`, `target/` and `.env` stay on each machine.
  - History moves as git objects.
- **Heavy commands are routed.** The `PreToolUse` hook moonlet already installs rewrites a command to `moonlet exec` when it matches the project's list and contains no shell chaining.
  - A scheduler picks a worker: online, has the project and the tools, has a free slot, low load.
  - **Fences** make a routed command exact. Before it runs, both copies must have the same git tree id. After it, every change is synced back before the exit status returns.
  - If the worker goes away mid-run, the command reruns on the central host.
- **Projects have an identity:** the normalized origin URL plus the root commit. This lets every machine recognise the same repository whatever its path. The central host keeps the registry. Workers clone a project the first time they need it, from origin first and from the central host otherwise.
- **When the central host is unreachable**, the laptop keeps working on new local sessions. An existing session can be taken over with **Continue on this Mac**, using its live copy and a copied conversation, and handed back later.
  - Takeover is a button, not automatic. "Unreachable" is not "down", and an automatic takeover could leave two agents editing one session. The button appears only after the host has been unreachable for about 30 s, so a brief network drop does not invite it. Decided by the user on 2026-10-13.
  - Every session has an **ownership number** that each takeover and hand-back increases. Only the daemon holding the highest number may run the session's agent. A central host that comes back and sees a higher number elsewhere pauses its own agent before doing anything else. So even a mistaken takeover cannot leave two agents running one session.

**Rejected.**

- **Roaming sessions** (the agent process moves to the machine with free CPU): every move restarts the agent and copies a private transcript, and a lid closed mid-turn loses that turn.
- **A network filesystem:** too slow for `node_modules` and cargo, and it breaks file watchers.
- **Generic two-way sync (Mutagen) as the product:** it worked in the trial, but it needs its ignore rules translated from git's, adds a third-party daemon, and knows nothing of fences or session ownership.
- **Isolated jobs on snapshots** (run a command against a frozen commit of the worktree): kept as a possible later addition for "run the suite on this exact state while the agent keeps editing". It needs explicit agent instructions and a write-back step, which live copies make unnecessary.

**Evidence.** A trial on 2026-10-13 used Tailscale, Mutagen, ssh and a Claude Code hook, with a MacBook Pro M5 as worker and a Mac mini M4 as central host. It measured:

- edits propagating in 0.26 s (central to worker) and 0.34 s (the other way);
- matching synced file sets on both machines;
- a routed `pnpm vitest run` (457 tests) returning the right output and exit status, with about 1 s of overhead;
- a file written by a routed command present on the central host before the command returned;
- a busy worker (load 7.2 on 10 cores) refusing work, which then ran on the central host in 4.3 s.

The idle Mac mini outran the loaded MacBook, so load-aware placement is required, not optional.

**Consequences.**

- The worker's link reuses `moonlet-link` from ADR 0008: a `Host` with an ssh `Connector`, so it gets the same reconnects, backoff and install check as the apps. `moonlet-link` learns to answer requests, because a worker connection carries requests both ways. `PROTOCOL_VERSION` goes up.
- **Trust:** any daemon linked to a central host runs what that central host sends it, within the routing rules. That is acceptable while both are one user's machines over that user's SSH, and must be revisited before any shared or multi-user setup.
- **Security:** a prompt-injected agent on the central host can cause commands to run on the laptop, which usually holds more secrets. Routing stays limited to listed commands with no shell chaining, and the worker re-checks every request.
- **Reboots** (decided 2026-10-13): a Linux central host needs a systemd service. A Mac central host keeps FileVault on. After an unplanned restart it waits at the unlock screen until someone logs in, and takeover covers that gap. Planned restarts (macOS updates) go through `fdesetup authrestart`, which unlocks FileVault for that one restart, so the host comes back unattended.
  - The central host switch sets "never sleep" and "restart after a power failure" itself, rather than relying on whatever else is keeping the Mac awake.
  - Auto-login is possible but needs FileVault off, so setup warns about it.
  - A small UPS removes most unplanned restarts.
  - Takeover ships in the last slice. Until then, a Mac central host that restarts unexpectedly leaves its sessions waiting until someone logs in.
- Delivery is sliced:
  - worker link and project identity ([X41](../specs/X41-worker-link-and-project-identity.md));
  - central host setup;
  - live copies (one way, then both ways);
  - routing;
  - takeover and cloud workers.

  Phone access is ADR 0008's ([X39](../specs/X39-phone-pairing-and-link.md), [X40](../specs/X40-mobile-app.md)).

  Each later slice gets its spec, and its number, when it is written. This ADR becomes accepted once the trial's lid-close and phone checks are in.
