# X75 — Sign-ins open where you are

- **Status:** implemented (untried with real sign-ins across Macs; see Implementation notes)
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
- [ ] While the central host is unreachable, a URL opens on the member that asked only when the user is active in that member's own app, by the same rule as above (focus, typing or a click within the last 15 minutes). An app that is merely open does not count. Otherwise the URL waits in that session with **Open**.
- [ ] A URL for a Mac whose app is not connected (the app quit, or the daemon runs without it) is kept by that Mac's daemon, in memory, and shown with **Open** when the app connects. At most the latest 5 wait, each for 10 minutes, and the same URL from the same session once.
- [ ] A member that keeps a URL from the central host this way tells it so. The central host then counts that Mac as the client the user used last but not as an active one: the next URL goes there waiting with **Open**, until the user is active in that app again. The app's next activity reaches the central host at once, not after the 30 s limit.
- [ ] A URL for a phone that is not connected is kept by the central host, in memory, by the same rule, and shown when that phone connects. Another phone never gets it.

### Sign-ins that come back to localhost

- [ ] When `moonlet-open` is called, its member's daemon registers a **callback**, but only when two things hold:
  - the URL's `redirect_uri` (or `redirect_url`) is `http://localhost:<port>`, `http://127.0.0.1:<port>` or `http://[::1]:<port>`;
  - a process on that member listens on that loopback port, and that process is the one that called `moonlet-open` or one of its ancestors up to the terminal or agent moonlet started. For `gcloud auth login`, that is gcloud's own redirect server.

  A URL naming a port that nothing of the calling command's listens on (an agent naming a database's port, say) gets no callback, and is opened with no forward. moonlet's own ports never get one.
- [ ] A URL with a callback, opened on a Mac other than the member that asked, gets that port forwarded:
  - the Mac's daemon listens on `127.0.0.1:<port>`;
  - it passes each connection to the asking member's `127.0.0.1:<port>`, over the link;
  - the forward ends when the callback's process stops listening on the port, when the asking command exits, or after 10 minutes, whichever comes first.
- [ ] A port already taken on the Mac shows "Port 8085 is in use on this Mac, so the sign-in for studio-mini can't come back here. Close what uses it and press Retry." The URL is not opened until **Retry** succeeds.
- [ ] The asking member accepts `tunnel.open` only for a registered, still-waiting callback. Its member and port must both match, and the forward reaches only that member's loopback address.
- [ ] Only the Mac a callback is shown on can reach it. The asking member makes a random key for each callback (32 bytes) and sends it with the URL, and the central host passes it on only to the Mac it shows the URL on. That Mac's forward sends the key with each `tunnel.open`, and the asking member compares it in constant time. A `tunnel.open` without the key, or with another, gets the same `forbidden` as one for a port nothing waits on, so another member cannot reach a waiting callback. Neither the app nor the phone ever gets the key.
- [ ] On the phone, such a URL shows "This sign-in has to finish on a Mac", and opens on the next Mac app the user touches while the command still waits.

### Sign in on every member

- [ ] Settings › Machines has a **Sign-ins** list. Each entry has a name, a sign-in command and a check command. The defaults are `gh` (`gh auth login --web`, check `gh auth status`) and `gcloud` (`gcloud auth login`, check `gcloud auth print-access-token`). The user can add, edit and remove entries. The list is in the account state (see Data and config).
- [ ] For each entry, the list shows each member as signed in or not. A member is signed in when its check command exits 0 within 10 s. The list is refreshed when it is opened and on **Check again**.
- [ ] **Sign in on every member** opens a terminal tab on each member that is not signed in, running the sign-in command. Their browsers open on this Mac, one at a time: the next opens once the previous sign-in ends.
- [ ] Only the Mac's own app may change the list. `signins.set` from a paired Mac, a phone, the `moonlet` CLI or an agent answers `forbidden`.
- [ ] Only the Mac's own app may run an entry's commands. `signins.check` and `signins.run` from any other client answer `forbidden`.
- [ ] Each member shows an entry's commands in full before running them the first time, as setup commands are (X60). It runs them again without asking only while they stay exactly the same. The approval is that member's own and is never synced. So an entry changed on another member, which reaches this one through the account state, asks again here before it runs.

## UI

- Toast on the Mac: "studio-mini · deploy-fix opened a sign-in", with **Show session**.
- The phone's sign-in card, in the chat: the URL's host, the one-time code when the page shows one (`gh` prints it to the terminal; the card reads it from the command's output), **Open** and **Copy code**.
- Settings › Machines › Sign-ins: one row per entry, a ✓ or ✕ per member, **Sign in on every member**, **Check again**, **Edit**.

## Protocol and RPCs

- `browser.open {url, session?, terminal?}`, from `moonlet-open` to its own daemon → `true`.
- `browser.route {url, from: <member>, session?}`, member → central host. The central host picks the client and sends `browser.show` to that member's app, or to the phone.
- `browser.show`, central host → member, as a request → `true` when the app got it, `{kept: true}` when the app is not connected and the URL waits for it.
- Event `browser.show {url, from, session?, forward?: {port}}` to an app or a phone.
- `browser.pending` → `[browser.show]`: the URLs that came for this Mac's app while it was not connected, each handed over once. The app asks each time it connects to its own daemon; any other client gets `forbidden`.
- `presence.active {client}`, member → central host, at most every 30 s while the user is active.
- `tunnel.open {port, to: <member>, key}` on the link: a stream from the Mac's daemon to the member's loopback port. It is accepted only for a port named by a `browser.route` from that member that is still waiting, with the key that member made for it. The key goes member → central host in `browser.route` and central host → the chosen Mac in its `browser.show` request, never in the event to an app or a phone.
- `signins.list` → the entries. `signins.set {entries}` → `true`. `signins.check {entry}` → `{<member>: bool}`. `signins.run {entry, members}` → `true`. Only the Mac's own app may call `signins.set`, `.check` and `.run`; other clients get `forbidden`.
- `browser.open` registers a callback as described above. `tunnel.open` is refused with `forbidden` without a matching callback or its key.

## Data and config

- `$MOONLET_HOME/bin/moonlet-open`, `$MOONLET_HOME/bin/shims/open` (macOS) and `$MOONLET_HOME/bin/shims/xdg-open` (Linux), written by the daemon on start.
- The sign-in entries are in the account state as records of kind `signin`, each keyed by a random id. Their fields are `name`, `login` (the sign-in command), `check` (the check command) and `order` (a sort key, X68). Each field follows X68's rules: the change with the latest stamp wins, also between members changed while unlinked. A deleted entry stays deleted. Older members keep these records and pass them on unread.
- Approvals of an entry's exact commands are kept per member in `$MOONLET_HOME/signins.json`, mode 0600, and never synced.
- Where the user was last active is kept in memory on the central host only, and so are the URLs waiting for a phone that is not connected.

## Security considerations

- A URL opened on the user's Mac comes from an agent or a script on another member. The app opens only `http` and `https` URLs, in the default browser, and always says which member and session asked. An agent could open a phishing page this way, but it could already show one in its reply. The toast makes the origin visible.
- Forwarding a port opens a member's loopback port to the user's browser. A URL alone never causes it: an agent could name any port in `redirect_uri`, such as a local database's admin page. The member forwards only to a port that the command calling `moonlet-open` (or one of its ancestors) is itself listening on, registered as a callback when it called, and never to moonlet's own ports. The forward lasts only while that listener does, nothing else on the tailnet can reach it, and it listens only on the Mac's `127.0.0.1`. Another member of the account cannot ask for the port either: the callback's key goes only to the Mac the URL is shown on. The central host, which routes the URL, sees the key.
- The redirect carries the OAuth code. It travels inside the tailnet link, which is encrypted end to end (ADR 0011).
- Sign-in and check commands run with the user's rights on every member. Only the app may run them, and the user has seen them.

## Out of scope

- Copying a tool's credentials between members (ADR 0014: each member signs in).
- Sign-ins that need a browser extension or a hardware key on the member itself.
- Opening `file://` or app URLs from another member.
- Claude Code's own sign-in. Whether to list it under Sign-ins is an open question.

## Test plan

Test names are planned. Each criterion cites its test once it is built, with the name exactly as implemented.

- **Rust unit:**
  - `a_redirect_uri_to_loopback_names_its_port`: checked against real captured sign-in URLs from `gcloud auth login` and a GitHub OAuth app, in the `localhost`, `127.0.0.1`, `[::1]`, percent-encoded and nested forms.
  - `moonlet_open_takes_only_http_and_https_up_to_8_kib`: `file://`, `javascript:` and a 9 KiB URL are refused.
  - `the_open_shim_hands_on_urls_and_passes_everything_else_to_usr_bin_open`.
  - `the_xdg_open_shim_hands_on_urls_and_passes_everything_else_on`.
  - `the_url_opens_where_the_user_was_last_active`: a table of activity times against the client that opens.
  - `with_the_central_host_offline_the_url_opens_only_where_the_user_is_active`.
  - `at_most_five_urls_wait_for_the_app_each_for_ten_minutes_and_once`.
- **Daemon integration** (`crates/moonletd/tests/browser.rs`), with two members and a fake app connection:
  - `browser_and_gh_browser_are_set_for_terminals_and_agents`.
  - `a_terminals_browser_url_reaches_the_app_of_the_active_member`.
  - `a_url_from_the_member_where_the_user_is_opens_there_without_the_central_host`.
  - `a_url_for_this_mac_while_its_app_is_not_connected_waits_for_the_app` and `a_url_for_a_member_whose_app_quit_waits_there_until_the_app_connects`.
  - `a_url_kept_for_a_macs_app_that_quit_leaves_the_next_waiting_until_the_user_is_back`.
  - `a_url_for_a_phone_that_is_not_connected_waits_for_that_phone`.
  - `a_callback_is_registered_only_for_a_port_the_calling_command_listens_on`: a test server started by the calling command gets a callback, and a port held by an unrelated process gets none.
  - `a_forward_carries_the_callback_and_ends_when_its_listener_closes`.
  - `a_tunnel_without_a_matching_callback_is_forbidden`.
  - `a_tunnel_without_the_key_shown_to_the_mac_never_reaches_the_callback`: another member's `tunnel.open` with no key or a made-up one is refused, the app's `browser.show` carries no key, and the Mac's forward still reaches the command.
  - `a_port_taken_on_the_mac_waits_for_retry`: the URL is not shown until the port is free and **Retry** is pressed.
  - `a_phone_gets_the_url_without_a_forward_and_a_mac_gets_it_next`: the phone marked active gets `browser.show` with no `forward`, and the URL reaches the next Mac app marked active while the command waits.
  - `only_the_macs_app_changes_or_runs_sign_ins`: `signins.set`, `.check` and `.run` from the CLI, a paired Mac, a phone and an agent's terminal answer `forbidden`.
  - `a_sign_in_changed_on_another_member_asks_again_before_it_runs_here`.
  - `sign_in_entries_changed_on_two_unlinked_members_meet_at_the_later_change`.
  - `sign_in_on_every_member_opens_one_browser_at_a_time`: the second member's URL is shown only after the first sign-in's command exits.
- **Desktop Vitest** (`lib/browserRoute.test.ts`): `the_toast_names_the_member_and_session`, `the_sign_ins_list_shows_each_member_signed_in_or_not`.
- **e2e** (`sign-in-opens-here.e2e.ts`): a terminal running `$BROWSER https://example.test/` shows the toast in the app.
- **Manual:** `gcloud auth login` and `gh auth login --web` on `studio-mini`, signed in from the MacBook and from the phone.

## Implementation notes

Built as the gh stack branches `x75/opener`, `x75/callback` and `x75/signins`. The daemon tests are in `crates/moonletd/tests/browser.rs`, the unit tests in `crates/moonlet-core/src/browser.rs`, `crates/moonletd/src/signin.rs` and `crates/moonlet-core/src/session/account.rs`.

What works as specified:
- **The opener.** Terminals and agents get `BROWSER` and `GH_BROWSER` set to `$MOONLET_HOME/opener/moonlet-open`, with the `open` or `xdg-open` shim first on `PATH`. `moonlet-open` takes only `http` and `https` URLs of up to 8 KiB. (`browser_and_gh_browser_are_set_for_terminals_and_agents`, `a_terminals_browser_url_reaches_this_macs_app`, `an_agents_cli_never_hears_a_url_to_open`; core `moonlet_open_takes_only_http_and_https_up_to_8_kib`, `the_open_shim_hands_on_urls_and_passes_everything_else_to_usr_bin_open`, `the_xdg_open_shim_hands_on_urls_and_passes_everything_else_on`)
- **Where it opens.** On the client the user used last, through the central host. A URL from the member where the user is opens there at once. With the central host away and the user elsewhere, the URL waits with **Open**. (`a_url_on_the_central_host_reaches_the_app_of_the_member_where_the_user_is`, `a_url_from_the_member_where_the_user_is_opens_there_without_the_central_host`, `with_the_central_host_away_and_the_user_elsewhere_the_url_waits_here`, `a_phone_where_the_user_is_gets_the_url_and_the_macs_app_leaves_it`; core `the_url_opens_where_the_user_was_last_active`, `with_the_central_host_offline_the_url_opens_only_where_the_user_is_active`)
- **Callbacks.** A callback is registered only when the command that called `moonlet-open`, or one of its ancestors, listens on the URL's loopback port. That process must have been started by the daemon, and the port must be 1024 or above. The callback lasts while the same process still listens. (core `a_redirect_uri_to_loopback_names_its_port`, against gcloud's captured URL; `signin.rs` `a_callback_is_registered_only_for_a_port_the_calling_command_listens_on`)
- **The forward.** It carries the browser's request back to the command, and ends when its listener closes. A port taken on the Mac waits for **Retry**. A tunnel with no matching callback is `forbidden`. (`a_forward_carries_the_callback_and_ends_when_its_listener_closes`, `a_port_taken_on_the_mac_waits_for_retry`, `a_tunnel_without_a_matching_callback_is_forbidden`)
- **Sign-ins.** The list is in the account state, with `gh` and `gcloud` by default, and only the Mac's app changes or runs it. Each member approves an entry's exact commands, and asks again once they change. **Sign in on every member** opens one browser at a time. (`only_the_macs_app_changes_or_runs_sign_ins`, `a_sign_in_changed_on_another_member_asks_again_before_it_runs_here`, `sign_in_on_every_member_opens_one_browser_at_a_time`; core `sign_in_entries_changed_on_two_unlinked_members_meet_at_the_later_change`)
- **The app and the phone.** The toast names the member and session. The phone shows a sign-in card. The Sign-ins page shows each member's state. (`apps/desktop/src/lib/browserRoute.test.ts`, `apps/desktop/src/lib/signIns.test.ts`, `apps/mobile/src/lib/signIns.test.ts`)

Where it differs from the draft above:
- **The opener is in `$MOONLET_HOME/opener/`**, with its shims in `opener/shims/`, not in `bin/`. `bin/` holds moonlet's own binaries, which an update replaces. `moonlet-open` is a script that runs `moonlet open-url`, not a link to the CLI.
- **The forward carries one HTTP request at a time.** The Mac reads the browser's request, the member hands it to the command's port, and the answer goes back, until the command closes the connection. That is what an OAuth redirect needs. It is not a byte stream: a WebSocket would not pass.
- **The forward also listens on `[::1]:<port>`** where the Mac has IPv6, not only on `127.0.0.1:<port>`, for a browser that goes back to `[::1]`, or to a `localhost` it looks up as `[::1]`. Either address taken on the Mac waits for **Retry**. The member hands the request to its command on `127.0.0.1:<port>`, or on `[::1]:<port>` when the command listens there only. Both stay loopback addresses, reached from nothing else on the tailnet. (`signin.rs` `a_sign_in_that_comes_back_to_ipv6_loopback_is_forwarded_and_answered`)
- **`tunnel.open`** carries the request's bytes, and the central host relays it when the asking member is another one. It reaches any member of the account whose callback for that port still waits, not only the Mac the URL was shown on.
- **`signins.approve {entry, login, check}`** names the commands the user saw. It answers `changed` when they differ from the entry's.
- **`signins.check`** answers each member's state: `signed_in`, `signed_out`, `needs_approval` or `away`. The page's **Approve these commands on this Mac** approves only this member. Another member approves in its own app.
- **A sign-in's terminal** has no session. The member's own app shows it in a window, **Sign in: gh**, which closes when the sign-in succeeds. (`a_sign_in_running_here_shows_its_terminal_in_this_macs_app`)
- **Another member's sign-in is answered on the Mac that pressed Sign in on every member.** That Mac starts each member's sign-in through the central host with `signins.here start`, which answers the terminal at once, then `wait`, which answers how it ended. Its app gets `signins.running {terminal, name, member, member_name, relayed}`, and the same again with `exit` once it ended, since the terminal's own exit never reaches it. The window, **Sign in: gh on build-box**, follows the terminal with `signins.attach {member, terminal}` on the central host, relayed as `session.attach` relays a session's terminal (X72). The central host lets only the app of the Mac that started that sign-in follow it or wait for it: its own app, or the paired Mac whose daemon links as that member. A member relays only its own running sign-ins. A sign-in on the central host itself (`relayed: false`) is one of its terminals, which a paired Mac's app reaches directly, as any. (`another_member_s_sign_in_is_answered_in_the_app_of_the_mac_that_pressed_sign_in`, `another_member_s_sign_in_is_followed_only_by_the_mac_that_started_it`; `signin.rs` `a_started_sign_in_is_the_starters_until_it_ends_or_lapses`; `apps/desktop/src/lib/signIns.test.ts`, `copyHost.test.ts`)
- **One Sign in on every member at a time.** Another press while one runs answers `busy`. A member's sign-in still running after 10 minutes is stopped before the next member's starts. (`a_second_sign_in_on_every_member_waits_until_the_first_ends`, `a_sign_in_that_outlives_its_wait_is_stopped_before_the_next_starts`)
- **The one-time code** comes from the last 40 lines of the asking terminal. The phone's card shows it with **Copy code**. Codes printed in an agent's chat are not read. (`a_device_sign_ins_one_time_code_comes_with_its_url`; core `a_device_sign_ins_one_time_code_is_read_from_its_output`, against gh's real output)
- **A sign-in the phone cannot finish** is held by the central host. It opens on the next Mac app the user touches while its command waits. (`a_phone_gets_the_url_without_a_forward_and_a_mac_gets_it_next`)
- **The e2e spec** is `apps/desktop/e2e/specs/sign-in-opens-here.e2e.ts`. While a spec runs, the app opens URLs through a stand-in on `window` (`__moonletOpenUrl`), so a test never opens the real browser.
- **Blocked: no push notification.** The phone app has no push notifications at all yet; its settings say so. They need an APNs key from the Apple developer account. Until then, the phone taps (haptics) when a sign-in arrives while the app is open.

## Open questions

- Should Claude Code's own sign-in be an entry in Sign-ins, and is `claude auth status` (or another command) a reliable check? To check against the installed Claude Code's real output.
- Should the phone's card read the one-time code from the terminal's output for tools other than `gh`?
