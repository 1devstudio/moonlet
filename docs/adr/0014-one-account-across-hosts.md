# ADR 0014: Hosts share one account; a session's agent runs on the host that made it, and the central host keeps a copy

- **Status:** proposed (2026-10-26); its first slice is [X68](../specs/X68-account-state.md)
- **Changes:** [ADR 0009](0009-central-host-workers-live-copies.md)'s "the central host owns every session" and the direction of its live copies; [ADR 0008](0008-phone-link-over-tailscale.md) and [X39](../specs/X39-phone-pairing-and-link.md)'s pairing, which the central host now does for every app; [ADR 0011](0011-machines-connect-over-the-tailnet.md) and [X57](../specs/X57-tailnet-hosts.md)'s "a paired desktop cannot manage the remote's devices"; [ADR 0013](0013-design-systems-and-designs.md)'s "rendering needs the moonlet app open".
- **Builds on:** [ADR 0011](0011-machines-connect-over-the-tailnet.md) (the tailnet transport and pairing), [X41](../specs/X41-worker-link-and-project-identity.md) (the worker link and project identity), [X60](../specs/X60-keep-in-sync.md) (live copies), [X62](../specs/X62-routed-commands.md) and [ADR 0012](0012-cloud-workers.md) (routing and cloud workers).

## Context

The user works mostly on a MacBook, follows agents from a phone or tablet while away, and keeps an always-on machine for the sessions: a Mac mini at home, or a Linux VPS. They want one moonlet across these machines:

- the same workspaces, projects, sessions, settings and design systems on every machine;
- every session visible from the phone at any time;
- the MacBook keeps working when the always-on machine is offline, and the two catch up when it is back;
- the always-on machine, which nobody sits at, is set up and configured from the MacBook's app.

ADR 0009 put every session on the central host, with other machines as windows onto it and live copies flowing from it to workers. What exists today falls short of the goal in several places:

- **Each host has its own workspaces** (X32), its own `state.json` and its own Claude profiles (X33). Settings are spread over per-host files (`git.toml`, `heavy.json`, `app.toml`), the app's localStorage, and `trackers.toml` with its tokens in the Keychain of the Mac running the app (X44).
- **Live copies go one way:** from the central host to workers (X60). A session made on the MacBook has no copy anywhere else.
- **Takeover and the ownership number** are in ADR 0009 but are not built.
- **Design systems and workspace designs** live in `~/.moonlet/design/` on one host and are not copied. Their render check and screenshots need the moonlet app on that host (ADR 0013), so a Linux host cannot build one.
- **Phones pair with each Mac** and act on that Mac's daemon (X39). A paired desktop cannot manage a remote host's devices or link (X57, X41).

## Decision

### Hosts, the account and the central host

- **Every host the user sets up is a full member of one account.** The MacBook, the Mac mini and a VPS each keep the whole account state (below), and each can run sessions, design agents and routed commands. Decided by the user on 2026-10-26.
- **One member is the central host.** It is the one that is always on, and it:
  - is what phones pair with and connect to;
  - keeps a copy of every session in the account;
  - relays account changes between members that are rarely online together;
  - is the only member that refreshes OAuth tokens (see Secrets).

  The user picks it and can move it to another member later. Members that cannot reach it keep working and catch up when it is back.
- **A member may run the desktop app or not.** A member without it (a Mac mini nobody logs in to, a VPS) is configured entirely from the apps on other machines (see Managing a host).
- **Every member is a worker by default** (X61's switch). **Cloud workers** (ADR 0012) are not members: they hold no account state and own nothing, and get a copy for the job they run. Decided by the user on 2026-10-26.
- Phones and the desktop app are clients, not members.

### Account state

- **What it holds:** workspaces, sections, projects (by project identity, X41), each session's record (name, branch, task link, owner, ownership number), boards and tracker settings, the git branch prefix, the app's preferences now kept in localStorage, approved setup commands, and the list of paired devices (token hashes only).
- **What stays on each host:** paths, `link.json`, the worker id, terminals and their processes, ignored files such as `node_modules` and `.env`, and a host's own settings (tailnet access, worker slots, the folder of each Claude profile, rendering on or off). An admin edits these from any app, but they never sync.
- **How it syncs:** every member keeps the whole state and a log of changes. Each change is stamped with a hybrid logical clock and the member's id. A field takes the change with the latest stamp. A deletion leaves a tombstone. Order inside a list comes from sort keys, so two members reordering never conflict. Members exchange the changes the other has not seen through the central host, which takes each member's own changes and passes them on to the others. A member that was offline merges on reconnect, with no step from the user.
- **Workspaces become account-wide.** A workspace's projects are project identities. Each member maps an identity to its own clone, or clones the project when it needs to. A workspace's Claude profile is a name, which each member maps to a folder of its own.

### Sessions

- **A session's agent runs on the member that made it.** A session started on the MacBook runs on the MacBook, with a live copy on the central host. Decided by the user on 2026-10-26.
- **The central host keeps a copy of every session.** Other members keep one when the user turns **Keep in sync** on (X60). A copy carries the worktree as X60 does, and also the session's chat events and the agent's transcript, read only.
- **The phone always sees every session through the central host.** While the owner is reachable, the central host forwards the phone's requests to it, so the phone can chat, approve plans and answer permission asks. While it is not, the central host shows its copy read only: the chat so far, the changes and the PR. If the central host itself is offline, the phone shows that, and nothing else: the user accepts this. Decided by the user on 2026-10-26.
- **A session moves only when the user asks.** Decided by the user on 2026-10-26.
  - **Move to <member>**, with both members online: at the end of the agent's turn, both copies sync to the same git tree id, the transcript is copied, the ownership number goes up, and the new owner resumes the conversation (`claude --resume`). Claude Code keys transcripts by the worktree's path, so X60's same-path rule matters here.
  - **Continue on <member>**, with the owner unreachable for about 30 s (ADR 0009): the member takes its copy's files and the last synced transcript, raises the ownership number and starts the agent. From the phone this means continuing on the central host. A turn the owner had in flight when it went to sleep is not in the copy and is not resumed there.
- **Only the member with the highest ownership number runs the agent.** This is ADR 0009's rule, now built:
  - The `PreToolUse` hook that moonlet installs already sees every tool call. After the machine wakes, the daemon holds the agent's tool calls until it has asked the central host whether it still owns the session, for up to about 5 s. A Mac that was asleep would otherwise carry on its frozen turn for a few seconds after someone took over.
  - When the central host cannot be reached at all, the owner keeps working: offline work is the point. So while the network is split, the owner and a member that continued the session can both run its agent, since neither can tell the other. This is accepted rather than fenced: stopping the owner would need the central host it cannot reach. The member that lost the session finds out when it reaches the central host again, and pauses as below.
  - A member that learns it lost the session pauses its agent. Its files from the gap go to `sync-leftovers` (X60), and its conversation from the gap is kept as a fork, not dropped.

### Managing a host

- **The first desktop paired with a member is its admin.** An admin can change the member's settings, pair and remove devices, set its link to the central host, update moonlet on it, give it secrets, and start the sign-ins of Claude Code and `gh` in a terminal on it. More admins can be added from an admin. Phones and the `moonlet` CLI are never admins. This replaces X57's "a paired desktop cannot manage the remote's devices" and X41's refusal of `link.set` from paired devices.
- **Pairing a phone from any app pairs it with the central host.** The app asks the central host for the code, so the QR code carries the central host's tailnet addresses. Decided by the user on 2026-10-26. The paired device is recorded in the account state, so every member accepts its token, and moving the central host does not need the phone paired again. How a paired phone learns the new central host's addresses is left to the slice that builds pairing from any app.

### Secrets

- **Every member holds every secret moonlet owns:** the tracker tokens (X44), the cloud provider and Tailscale credentials (ADR 0012). Secrets reach a member over its paired tailnet link. At rest they are kept in the Keychain on a Mac and in a file of mode 0600 under `$MOONLET_HOME` on Linux, as `cloud.json` is.
- **Only the central host refreshes OAuth tokens** and passes the new ones on. Where a provider replaces the refresh token on each refresh, two members refreshing on their own would sign each other out.
- **Secrets other tools own are not copied as files.** `gh`'s token and Claude Code's credentials are stored by those tools in their own formats, with refresh behaviour of their own. The admin runs each tool's own sign-in on the member instead (`gh auth login --with-token`, Claude Code's login in a terminal, or a long-lived token where the tool offers one).

### Designs on every member

- **Rendering for the user happens in the client.** The Design mode canvas renders in the app's own WebKit, as now. Its `moonlet-design://` scheme fetches the design's files from the member that owns it, over the link.
- **Rendering for the agent happens on the member where the design agent runs**, so a VPS can build and check a design system on its own:
  - a Mac without the app runs a small render helper, with no Dock icon, that uses the same WKWebView snapshots as the app's hidden window;
  - Linux uses WPE WebKit, WebKit's port for machines with no display, so screenshots come from the same engine family as the app.
- **Design systems and workspace designs have an owner and copies**, like sessions: the agent runs on the owner, and the central host keeps a copy. Session designs live in the worktree and travel with it.

## Considered options

- **The central host owns every session (ADR 0009).** It keeps one place for everything, but a session started on a laptop would always run elsewhere, and nothing works on the laptop while the central host is down unless the user takes over. The user chose sessions that run where they are made.
- **One central host with thin clients and no account state on the others.** It is simpler to build, but the MacBook would lose its workspaces and settings whenever the central host is offline.
- **Automerge or another general CRDT library for the account state.** It handles any shape of data, but the account state is a small set of records keyed by id, which per-field last-writer-wins with sort keys covers. A library would add a format to migrate and a dependency for little gain.
- **Moving sessions automatically,** for example handing an idle session to the central host when the lid closes. The user chose a button; an automatic move can be added later.
- **Only the secrets the central host needs on each member.** It limits what a stolen VPS leaks, but a full member could not then run every feature on its own. The user wants full copies.
- **Headless Chromium or Playwright for rendering on Linux.** ADR 0013 rejected them: they are large, and they are not the engine the user sees designs in.

## Consequences

- **Trust is the weakest member's.** Every member holds every secret and can run what the account asks of it. A stolen VPS leaks every tracker token and can act on every session. Removing a member revokes its device token and offers to rotate each secret it held. This widens ADR 0009's "acceptable while both are one user's machines" to every member.
- **Migration.** Each host's existing workspaces have to merge into one set. Projects match by project identity. Workspaces match only by name, so the app asks the user before merging two.
- **Rendering without the app needs a spike first:**
  - WPE WebKit's snapshots and its sandboxing on the static Linux builds (X58);
  - the macOS helper in a login session with no app window;
  - each card's own process, which keeps a looping card from freezing others: macOS gets it from site isolation (ADR 0013), WPE would get it from a process per render killed on a timeout.
- **Glossary.** *Central host* keeps its name with its new meaning. *Member* (a host in the account), *owner* (the member running a session's agent), *admin* and *account state* are added to `CONTEXT.md` when this ADR is accepted.
- **Delivery,** each slice with its own spec:
  1. account state, synced through the central host, and the workspace migration;
  2. admin pairing, members' settings edited from any app, and phones paired with the central host;
  3. copies from any member to the central host, carrying the chat and the transcript, and the phone reaching every session through the central host;
  4. ownership: the number, the hold after a wake, **Move to…** and **Continue on…**;
  5. secrets passed to members, and OAuth refreshes on the central host only;
  6. the rendering spike, then rendering on members without the app;
  7. design systems and workspace designs with owners and copies ([X71](../specs/X71-designs-on-every-member.md), built before slice 6: copies are read on any member, and only the owner needs the app to render).

## Open questions

- Which trackers replace the refresh token on each refresh, and whether Claude Code's long-lived token fits a headless member. Both are checked in slice 5's spec.
- What a member does with a project it has never cloned and that has no origin. X60 pauses such a project; cloning from the owner over the link is the likely answer.
