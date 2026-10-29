# ADR 0015: A session follows the user between members on its own, and sign-ins open where the user is

- **Status:** proposed (2026-10-29); to be built in [X72](../specs/X72-session-copies-on-the-central-host.md), [X73](../specs/X73-sessions-follow-you.md), [X74](../specs/X74-files-copied-between-members.md) and [X75](../specs/X75-sign-ins-open-where-you-are.md)
- **Changes:** [ADR 0014](0014-one-account-across-hosts.md)'s "a session moves only when the user asks" and its considered option "moving sessions automatically", and its "ignored files stay on each host"; [ADR 0009](0009-central-host-workers-live-copies.md)'s "takeover is a button, not automatic"; [X60](../specs/X60-keep-in-sync.md)'s "ignored files never sync".
- **Builds on:** [ADR 0014](0014-one-account-across-hosts.md) (members, the central host, session copies and the ownership number), [X60](../specs/X60-keep-in-sync.md) (live copies), [X68](../specs/X68-account-state.md) (the account state).

## Context

The user's day, as they described it on 2026-10-28:

- Most of the day they work on the MacBook: they code features with agents, review changes, and now and then run a sign-in that opens a browser (`gh auth login`, `gcloud auth login`). It should feel like working locally, because it is.
- Sometimes they leave the MacBook at home or close its lid and go out. The sessions should go on, and the phone should reach them.
- The Mac mini at home is always on. It should hold a copy of every session, and when the MacBook closes it should continue from where the MacBook left off.

They want the members to behave as one swarm: moonlet knows where each session's agent runs, and the user should notice as little as possible of it.

ADR 0014 already puts a session's agent on the member that made it and keeps a copy on the central host. But it moves a session only when the user presses **Move to…** or **Continue on…**, so closing the lid stops the work until the user takes it over from the phone. A sign-in run by an agent on another member opens its browser on that member, where nobody sits. And the files that make a worktree run, such as `.env`, never leave the member they were made on.

## Decision

### Where a session's agent runs

- **The agent runs where the user works, and the central host keeps a hot copy.** While the MacBook is awake, its sessions run on it. The central host keeps a copy of each session's worktree, chat and transcript, up to date after every tool call, so continuing there needs no work at the moment the MacBook goes away (X72).
- **Sessions move on their own.** Decided by the user on 2026-10-28:
  - **When the owner goes to sleep,** the central host continues its sessions. The owner's daemon tells the central host it is going to sleep, and the central host raises the ownership number of each session and takes it over.
  - **A turn cut off by sleep continues on the central host,** from the last point its copy holds, with a note to the agent that the last command may not have finished. Decided by the user on 2026-10-29.
  - **When the user types into a session in the app on another member,** that member takes the session over at the end of the current turn. This holds for every session, including ones started on the central host or from the phone. Decided by the user on 2026-10-29.
- **The phone never moves a session.** A message sent from the phone goes to the session's owner through the central host. While the MacBook is awake, the session stays on it, even when the user is away with the phone and the lid is open. There is no move after idle time. Decided by the user on 2026-10-29.
- **An owner that is unreachable without a sleep notice keeps its sessions** until the user acts on one from somewhere else. Then the central host continues it, once the owner has been unreachable for about 30 s, as ADR 0009 set. "Unreachable" may mean only that the network between the two is down while the user works on the MacBook, so the central host never takes a session over on that alone.
- **Move to… stays, as the way to override the automatic moves.** It pins the session to the chosen member: automatic moves no longer apply to it until the user unpins it. **Move now** cuts off a running turn and continues it on the chosen member as a sleep does. The user asked for a manual move on 2026-10-29; pinning is how it outlasts the automatic rules.
- **The ownership number is ADR 0014's; the hold after a wake becomes a stop before sleep.** Changing `owner` and the number is the central host's alone, in one step, so two members never both win a session. The one exception is **Take over anyway**, below. On the sleep notice the owner stops (`SIGSTOP`) its agents before handing them over, and on wake it lets them go on only once the central host says it still owns them. That replaces ADR 0014's hold in the `PreToolUse` hook, which can hold a tool call for only about 2 s and sees only some tool calls. A member that learns it lost a session pauses its agent; its files from the gap go to `sync-leftovers`, and its conversation from the gap is kept as a fork.
- **Take over anyway, while the central host is offline.** After the central host has been unreachable for 30 s, the app says it is offline and offers **Take over anyway** for each session it runs that this member holds a copy of. The member then raises the number on its own, from the number it last saw (its base). When the central host is back, the forced change wins only if the central host's number is still that base, and the losing side's work goes to `sync-leftovers` and a fork. Decided by the user on 2026-10-29: a session stuck on an offline central host is worse than the rare double run behind a network split, which the user accepts after a warning.
- **The app shows where a session runs only when it is not this Mac:** a small host icon on the session's row, naming the member in its tooltip, with a pin for a pinned session. A session on this Mac shows nothing. Decided by the user on 2026-10-29.

### Files that make a worktree run

- **Each project has a list of file patterns that are copied between members although git ignores them,** `.env` and `.env.*` by default. Decided by the user on 2026-10-29. The list is the user's, kept in the account state and changed only from an app, never from the repository, because an agent could otherwise widen it.
- **Build output is still never copied.** `node_modules` and `target/` come from the project's setup command on each member (X60).

### Sign-ins open where the user is

- **A browser that any session's command opens, on any member, opens on the client the user used last:** the app on the MacBook, or the phone. Every terminal and agent moonlet starts gets `BROWSER` and `GH_BROWSER` set to moonlet's own opener.
- **A sign-in that sends the browser back to `localhost`** (`gcloud auth login`) gets that port forwarded from the user's Mac to the member that ran the command, over the tailnet, until the sign-in ends. A phone cannot forward a port, so such a sign-in waits for a Mac; a sign-in that shows a code (`gh auth login`) finishes on the phone.
- **Sign in on every member:** the user can run a tool's sign-in on every member at once from the MacBook, each opening its browser on the MacBook, so the central host is ready before the user leaves. ADR 0014's rule stands: tools' own credentials are never copied as files.

### Readiness

- **The central host checks that it could continue each session**: Claude Code signed in, the project's setup run, the copied files present, and the tools the session used signed in. The session row says when it could not, so the user knows before leaving home.

## Considered options

- **The agent always runs on the central host, and only its commands run on the MacBook while it is awake** (X62's routing, turned around). Nothing would ever move. But Claude Code's own tools (Read, Edit, MCP servers) run where the agent runs, so every tool call would wait for the user's edits to reach the central host, both sides editing one file would conflict, and a browser an MCP server opens would open on the Mac mini. It never feels local.
- **Move on wake as well as on sleep.** The session would come back to the MacBook every time it wakes, including dark wakes (Power Nap) and a lid opened to check something. Typing is a clearer sign of where the user works.
- **Move after idle time while the lid is open.** The user rejected it: the MacBook is awake and can run the session, and the phone reaches it through the central host.
- **Take over on unreachability alone, as ADR 0009 planned for takeover.** A network split between two awake machines would run the agent on both, and the work the user is doing at the MacBook would end in `sync-leftovers`.
- **Copy every ignored file.** It would carry `node_modules` and build output across the tailnet on every change, and they are made for one machine's OS and architecture.
- **Copy tools' credential files** (`~/.config/gcloud`, `gh`'s `hosts.yml`). They have formats and refresh rules of their own, and some rotate refresh tokens, so two members holding one copy would sign each other out. A sign-in per member, opened on the MacBook, costs the user one click per tool.

## Consequences

- **A turn can be cut off in the middle of a command.** The central host continues from its last checkpoint, and the agent is told the last command may not have finished. A command that is not safe to run twice (a push, a migration, a deploy) relies on the agent checking first.
- **Sleep has to be noticed in time.** macOS tells a process in the user's session before every sleep, and waits up to 30 s for its answer, but whether the network still works in that window when the lid closes is not known. The design does not depend on it: the owner stops its agents before anything else, checkpoints are sent continuously, and a hand-over that could not be sent goes at the next wake, dark wakes included. Until then, the phone offers to continue the session on the central host. Manual check M12 measures the window on a real MacBook. Decided by the user on 2026-10-29: build without waiting for the measurement.
- **Paths can differ between members.** A member whose home folder differs (another user name, Linux) keeps its copy elsewhere (X60), and the transcript names the old paths. The agent is told the new path when it continues there.
- **Secrets travel more.** `.env` files reach every member, which widens ADR 0014's "trust is the weakest member's". Removing a member offers to rotate them, with the other secrets.
- **The swarm needs to know where the user is.** The central host keeps which client the user used last, for sign-ins, and which member's app the user typed in, for moves.
- **Delivery,** each with its own spec:
  1. [X72](../specs/X72-session-copies-on-the-central-host.md): copies of every session on the central host, checkpointed after each tool call, and the phone reaching every session through it (ADR 0014's slice 3);
  2. [X73](../specs/X73-sessions-follow-you.md): the ownership number, moves on sleep and on typing, Move to… with pinning, and readiness (ADR 0014's slice 4, changed by this ADR);
  3. [X74](../specs/X74-files-copied-between-members.md): files copied between members by pattern;
  4. [X75](../specs/X75-sign-ins-open-where-you-are.md): the browser opener, port forwarding for sign-ins, and sign-in on every member.

## Open questions

- Should an owner that went unreachable in the middle of a turn, with no sleep notice (a crash, a battery that ran out), have its turn continued after some minutes without the user acting? Not decided; X73 leaves it to the user acting from the phone.
