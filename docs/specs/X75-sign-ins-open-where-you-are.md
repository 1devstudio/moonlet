# X75 — Sign-ins open where you are

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0015](../adr/0015-sessions-follow-the-user.md) (sessions follow the user), [0014](../adr/0014-one-account-across-hosts.md) (one account across hosts), [0011](../adr/0011-machines-connect-over-the-tailnet.md) (the tailnet transport)
- **Depends on:** [X68](X68-account-state.md) (members and the link to the central host), [X57](X57-tailnet-hosts.md) (tailnet hosts in the app), [X39](X39-phone-pairing-and-link.md) (the phone)

## Summary

Some commands open a browser to sign in: `gh auth login`, `gcloud auth login`, `npm login`, a project's own OAuth helper. When the command runs on the Mac mini, because a session moved there (X73) or the user opened a terminal there, the browser opens on the Mac mini, where nobody sits, or nowhere on a Linux host. The sign-in hangs.

With this spec, a browser opened by any terminal or agent that moonlet starts, on any member, opens on the **client the user used last**: the app on their Mac, or the phone. When the sign-in sends the browser back to `localhost`, that port is forwarded from the user's Mac to the member that ran the command, so the redirect lands where the command waits. **Sign in on every member** runs a tool's sign-in on each member at once, every browser opening on the user's Mac.

## User journey

1. The session `deploy-fix` runs on `studio-mini`: the MacBook went to sleep on the train and the session moved there (X73). The user is back at the MacBook and reads the chat there, without typing yet.
2. The agent on `studio-mini` runs `gcloud auth login`. A browser tab opens on the MacBook, on Google's sign-in page. moonlet's toast says "studio-mini · deploy-fix opened a sign-in".
3. The user signs in. Google sends the browser to `http://localhost:8085/?code=…`. The MacBook passes that request on to `studio-mini`'s port 8085, gcloud gets its code, and the tab shows gcloud's "You are now authenticated".
4. Later, on the bus, the user sends a message from the phone to a session on `studio-mini`. The agent runs `gh auth login --web`. The phone shows a sign-in card with the one-time code and **Open**, which opens GitHub's device page in Safari. The user enters the code, and `gh` finishes.
5. Before a trip, the user opens Settings › Machines › Sign-ins on the MacBook and presses **Sign in on every member** next to `gcloud`. A terminal opens for each member that is not signed in. Each sign-in opens on the MacBook, one after the other.

## Behaviour and acceptance criteria

### The opener

- [ ] Every terminal and agent moonlet starts, on every member, gets `BROWSER` and `GH_BROWSER` set to `$MOONLET_HOME/bin/moonlet-open`, a link to the `moonlet` CLI that opens its single argument. A value the project or the user's shell sets later wins, so a user can opt out.
- [ ] On Linux, a `xdg-open` that hands an `http` or `https` URL to `moonlet-open` comes first on those processes' `PATH`. Any other argument goes to the system's `xdg-open`, when there is one.
- [ ] On macOS, an `open` that does the same comes first on `PATH`: an `http` or `https` URL alone goes to `moonlet-open`, and every other use (`open .`, `open -a Cursor`) goes to `/usr/bin/open` unchanged.
- [ ] `moonlet-open <url>` takes only `http` and `https` URLs of up to 8 KiB, and exits 0 once the URL has been handed on. It never runs or opens anything on its own member unless the user is at that member (below).

### Where it opens

- [ ] The central host keeps where the user was last active: the member whose app the user last touched (focus, typing, a click in a session), or the phone. Each member's daemon reports its app's activity to the central host at most every 30 s while the user is active.
- [ ] A URL opens on that client:
  - the app of a member: the app opens it in the default browser, and shows a toast naming the member and session that asked;
  - the phone: a sign-in card in the session that asked, with **Open**, and a push notification when the app is in the background.
- [ ] A URL from the member where the user is opens there at once, with no round trip through the central host. Working on the MacBook alone behaves as it does today.
- [ ] With no client active in the last 15 minutes, the URL opens on the last one, and the session that asked shows "Waiting for a sign-in" with **Open** on every client.
- [ ] While the central host is unreachable, a URL opens on the member that asked when its app is open, and otherwise waits in that session with **Open**.

### Sign-ins that come back to localhost

- [ ] A URL whose `redirect_uri` (or `redirect_url`) is `http://localhost:<port>`, `http://127.0.0.1:<port>` or `http://[::1]:<port>`, opened on a Mac other than the member that asked, gets that port forwarded:
  - the Mac's daemon listens on `127.0.0.1:<port>`;
  - it passes each connection to the asking member's `127.0.0.1:<port>`, over the link;
  - the forward ends after its first connection closes, when the asking command exits, or after 10 minutes, whichever comes first.
- [ ] A port already taken on the Mac shows "Port 8085 is in use on this Mac, so the sign-in for studio-mini can't come back here. Close what uses it and press Retry." The URL is not opened until **Retry** succeeds.
- [ ] Only the port named in the URL is forwarded, only to the member that asked, and only to its loopback address.
- [ ] On the phone, such a URL shows "This sign-in has to finish on a Mac", and opens on the next Mac app the user touches while the command still waits.

### Sign in on every member

- [ ] Settings › Machines has a **Sign-ins** list. Each entry has a name, a sign-in command and a check command. The defaults are `gh` (`gh auth login --web`, check `gh auth status`) and `gcloud` (`gcloud auth login`, check `gcloud auth print-access-token`). The user can add, edit and remove entries. The list is in the account state.
- [ ] For each entry, the list shows each member as signed in or not. A member is signed in when its check command exits 0 within 10 s. The list is refreshed when it is opened and on **Check again**.
- [ ] **Sign in on every member** opens a terminal tab on each member that is not signed in, running the sign-in command. Their browsers open on this Mac, one at a time: the next opens once the previous sign-in ends.
- [ ] Only an app may run an entry's commands on a member. Its commands are shown in full before the first run, as setup commands are (X60), and run again without asking only while they stay the same.

## UI

- Toast on the Mac: "studio-mini · deploy-fix opened a sign-in", with **Show session**.
- The phone's sign-in card, in the chat: the URL's host, the one-time code when the page shows one (`gh` prints it to the terminal; the card reads it from the command's output), **Open** and **Copy code**.
- Settings › Machines › Sign-ins: one row per entry, a ✓ or ✕ per member, **Sign in on every member**, **Check again**, **Edit**.

## Protocol and RPCs

- `browser.open {url, session?, terminal?}`, from `moonlet-open` to its own daemon → `true`.
- `browser.route {url, from: <member>, session?}`, member → central host. The central host picks the client and sends `browser.show` to that member's app, or to the phone.
- Event `browser.show {url, from, session?, forward?: {port}}` to an app or a phone.
- `presence.active {client}`, member → central host, at most every 30 s while the user is active.
- `tunnel.open {port, to: <member>}` on the link: a stream from the Mac's daemon to the member's loopback port. It is accepted only for a port named by a `browser.route` from that member that is still waiting.
- `signins.list`, `signins.set`, `signins.check {entry}` → `{<member>: bool}`, `signins.run {entry, members}`.

## Data and config

- `$MOONLET_HOME/bin/moonlet-open`, `$MOONLET_HOME/bin/shims/open` (macOS) and `$MOONLET_HOME/bin/shims/xdg-open` (Linux), written by the daemon on start.
- The sign-in entries are in the account state, record kind `signin`.
- Where the user was last active is kept in memory on the central host only.

## Security considerations

- A URL opened on the user's Mac comes from an agent or a script on another member. The app opens only `http` and `https` URLs, in the default browser, and always says which member and session asked. An agent could open a phishing page this way, but it could already show one in its reply. The toast makes the origin visible.
- Forwarding a port opens the member's loopback port to one HTTP connection from the user's Mac, only for a port the member itself named while a sign-in waits. Nothing else on the tailnet can reach it, and the forward listens only on the Mac's `127.0.0.1`.
- The redirect carries the OAuth code. It travels inside the tailnet link, which is encrypted end to end (ADR 0011).
- Sign-in and check commands run with the user's rights on every member. Only the app may run them, and the user has seen them.

## Out of scope

- Copying a tool's credentials between members (ADR 0014: each member signs in).
- Sign-ins that need a browser extension or a hardware key on the member itself.
- Opening `file://` or app URLs from another member.
- Claude Code's own sign-in. Whether to list it under Sign-ins is an open question.

## Test plan

- Rust unit: `redirect_uri` parsing against real captured sign-in URLs from `gcloud auth login` and a GitHub OAuth app (`localhost`, `127.0.0.1`, `[::1]`, encoded and nested forms); the `open` and `xdg-open` shims send URLs to `moonlet-open` and pass everything else through.
- Daemon integration (`crates/moonletd/tests/browser.rs`), with two members and a fake app connection:
  - a terminal's `$BROWSER <url>` on one member reaches the app of the member marked active;
  - a forwarded port carries one HTTP request to a test server on the asking member, and closes after it;
  - a port no `browser.route` named is refused;
  - a phone marked active gets `browser.show` with no `forward`.
- Desktop Vitest (`lib/browserRoute.test.ts`): which client opens a URL given activity times, and the toast's text.
- e2e (`sign-in-opens-here.e2e.ts`): a terminal running `$BROWSER https://example.test/` shows the toast in the app.
- Manual: `gcloud auth login` and `gh auth login --web` on `studio-mini`, signed in from the MacBook and from the phone.

## Open questions

- Should Claude Code's own sign-in be an entry in Sign-ins, and is `claude auth status` (or another command) a reliable check? To check against the installed Claude Code's real output.
- Should the phone's card read the one-time code from the terminal's output for tools other than `gh`?
