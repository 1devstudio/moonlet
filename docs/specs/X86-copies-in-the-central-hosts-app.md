# X86 — The central host's own app lists the sessions other members run

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0014](../adr/0014-one-account-across-hosts.md) (one account across hosts), [0015](../adr/0015-sessions-follow-the-user.md) (sessions follow the user)
- **Depends on:** [X72](X72-session-copies-on-the-central-host.md) (copies on the central host, `session.forward`, the phone's copy hosts), [X73](X73-sessions-follow-you.md) (ownership, Continue on…, the host mark)

## Summary

X72 gives the central host a copy of every session another member runs, and the phone lists them through it. The desktop app does not: X72 assumed every app already lists every member's sessions (X68). That holds on a member, which lists the central host's sessions through its host entry. It does not hold on the central host itself. Its app talks to its own daemon only, so a session started on the MacBook never shows in the app on `studio-mini`, although `studio-mini` holds its files, chat and transcript.

With this spec, the app on the central host lists those sessions and opens them as the phone does. The chat is live, a message typed there goes to the agent on the member that runs it, and nothing moves. While that member is unreachable, the session is read only, and **Continue on studio-mini** takes it over (X73).

## User journey

1. On the MacBook, the user starts `fix-cart` in `shop`. The MacBook runs its agent.
2. At the desk with `studio-mini`, the user opens moonlet there. `fix-cart` is in the sidebar under `shop`, with the host icon at the end of its row. The tooltip reads "Running on MacBook".
3. Opening it shows the chat so far, live. The user types "also run the linter". The message goes to the MacBook's agent, which answers. The session stays on the MacBook.
4. The user closes the MacBook's lid without a sleep notice getting through. Thirty seconds later, the icon on `fix-cart` is dimmed and reads "Running on MacBook · offline since 14:02". The session shows "MacBook is asleep. This is the copy on studio-mini, read only." with **Continue on studio-mini**.
5. The user presses it. `studio-mini` takes the session over, the icon goes, and the chat goes on here.

## Behaviour and acceptance criteria

### Which app lists them

- [x] The app lists other members' sessions only from its own daemon, and only while that daemon is a central host: its account names no central host (`account.get` → `central: null`). An app on a member lists none this way. It already shows the central host's sessions through its host entry, and it cannot follow a third member's. (`apps/desktop/src/lib/centralCopies.test.ts`)
- [x] The app asks its daemon for `session.list {copies: true}` when it loads its account, and again on every `sessions.changed` and `workers.changed` from it, so a copy listed once does not go when the daemon's own sessions change, and says when its member comes or goes.
- [x] A copy whose owner is this Mac's own worker is dropped. So is a copy whose session another host the app is connected to lists as its own, as on the phone. Each session shows once. (`centralCopies.test.ts`; `sidebar.test.ts` › lists the sessions other members run with the central host's own)

### The row

- [x] A copy is listed in the sidebar where a session of the same project and workspace would be: its project is the central host's project of the same identity, and its workspace the one in its record. A copy of a project the central host has not got is not listed, as on the phone (X72). (`sidebar.test.ts` › lists the sessions other members run with the central host's own)
- [x] Its row ends with X73's host icon. The tooltip names the owner from the copy itself: "Running on MacBook". While the owner is unreachable, the icon is dimmed and the tooltip adds "· offline since 14:02". (`follow.test.ts` › names the member that runs it)
- [x] Its row offers no Keep in sync, no Run only on…, no Link to task… and no Rename: the central host cannot ask the owner for those. It offers Open, and Archive while the owner is reachable. (`sidebar.test.ts` › offers only Open for a session another member runs)

### Opening one

- [x] A copy opens under its copy host, `local#copy:<session>`, so every call goes through `session.forward` and `session.attach` to the owner (X72). (`apps/desktop/src/lib/centralCopiesStore.test.ts` › opens one with the terminals its member lists; `copyHost.test.ts`)
- [x] The session shows its chats and terminals as the owner lists them (`terminal.list` and `chat.summaries` through the copy host), with a stand-in for each chat while the owner lists none. Its chat follows `session.event` live, and the open copy is read again whenever the copies are. (`centralCopies.test.ts` › what a copy shows when opened; `centralCopiesStore.test.ts`; `copyHost.test.ts` for `session.event`)
- [x] A message typed in its chat goes to the owner's agent (`chat.send` through the copy host). Answering a permission, a plan or a question does too. Nothing moves. (`copyHost.test.ts` routes every chat call as `session.forward`)
- [ ] What the owner refuses through the central host is not offered: the Files panel, opening a new terminal or agent tab, the project's config, Processes, and renaming.
- [x] Git status and diffs come from the owner (`git.*` through the copy host), never from the copy's folder on this Mac. (`copyHost.test.ts`)

### While the owner is unreachable

- [ ] The session shows "MacBook is asleep. This is the copy on studio-mini, read only." above the composer. Its chat and git status come from the copy. Typing is refused with that line instead of being lost.
- [ ] Once the owner has been unreachable for 30 s, the line offers **Continue on studio-mini**, counting down before then: "Continue on studio-mini in 12 s". A copy pinned to its owner offers nothing (X73).
- [ ] **Continue on studio-mini** asks the daemon for `session.continue_here {session}`. Once it answers, the session is this Mac's own: it is listed and opened under `local`, without the icon. Its errors read as on the phone: "MacBook is back: fix-cart goes on there.", "fix-cart is kept on MacBook.", "studio-mini has no copy of fix-cart yet."

## UI

- Sidebar: the copy's row is an ordinary session row with X73's host icon. No other mark.
- The session: the read-only line sits above the composer, in the muted style of X73's offline line, with **Continue on studio-mini** as its button.
- Hidden for a copy: the Files tab, the new-terminal and new-agent buttons, Processes, the project settings entry, and the row menu items listed above.

## Protocol and RPCs

None new. The app uses X72's `session.list {copies: true}`, `session.forward`, `session.attach`, `session.event` and X73's `session.continue_here`, all on its own daemon.

## Data and config

None. The app keeps the copies it lists in memory, apart from its daemon's own sessions.

## Security considerations

Nothing crosses a new boundary: the app talks to its own daemon over its socket. The owner keeps deciding what it answers through the central host (X72's allowlist), so hiding a feature for a copy is for clarity, not protection.

## Out of scope

- Typing on the central host moving the session there while its owner is reachable. X73 moves a session between a member and the central host only on sleep, when the owner is unreachable, or when a member takes it. Asked on 2026-11-07: like the phone, nothing moves.
- A member's app listing a third member's sessions.
- Copies of projects the central host has not got (X70).
- A copy's state (working, needs you) on its row before it is opened. `session.list` does not carry it yet (X72).

## Test plan

- Unit (`apps/desktop/src/lib/`): which copies the app lists (this Mac central or not, its own worker's dropped, one another host lists dropped); the row's mark and menu for a copy; what a copy session offers; the read-only line and **Continue on** countdown and errors.
- e2e (`apps/desktop/e2e/specs/central-copies.e2e.ts`): a scratch daemon links to the app's daemon as a member and makes a session there. The app shows it with the host icon, opens it, sends a message that reaches the member's chat, and, with the member's daemon stopped, shows the read-only line.

## Open questions

- None.
