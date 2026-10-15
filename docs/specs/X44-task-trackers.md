# X44 — Task trackers

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X2 (pull requests), X32 (workspaces), X43 (settings page), X45 (Tasks mode), X46 (tasks in sessions)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)

## Summary

moonlet connects to the issue trackers a user already works in, so Tasks mode (X45) can show each issue beside the sessions, worktrees and pull requests working on it. The first four trackers are Linear, Jira Cloud, ClickUp and GitHub Issues. GitHub Issues uses `gh`'s login. Each Linear, Jira or ClickUp connection signs in as the user, picks the teams, projects or lists it shows (its **sources**), and can map the tracker's states onto moonlet's columns. Tokens stay in the macOS Keychain of the Mac running the app; `moonletd` only stores which issue each session is linked to (the connection id, key and URL).

## User journey

1. The user opens Settings › Task trackers (or clicks a tracker in the "Connect a task tracker" panel of Tasks mode, X45).
2. GitHub Issues is already listed: it uses the `gh` login on the shown workspace's host. Under **Add tracker** they click Connect Linear, Connect Jira Cloud or Connect ClickUp.
3. They sign in:
   - **Linear:** an API key. "Sign in with Linear" (OAuth with PKCE) shows only in a build with Linear's client ID.
   - **Jira Cloud:** site (`acme.atlassian.net`), email and API token, with a "Create one" link to Atlassian's token page.
   - **ClickUp:** a personal API token (`pk_…`), with a "Create one" link to ClickUp's Apps settings.
4. moonlet checks the sign-in ("Signed in as Sam · 4 sources visible") and lists what the account can see. The user ticks the sources to show and picks, for each, the workspace that shows it, what it shows and the project its sessions start in.
5. **Save and sync.** The connection's row reads `Connected as Sam · API key · 1 source`.
6. On the row, **Sources** and **States** change the sources and the state mapping. Below the connections, each connected tracker has its Keep in step rules (X46) and branch name; then come GitHub's rules and branch names, Linking, the workspaces' sources and Sync.

## Behaviour and acceptance criteria

### Connections

- [x] Settings has a **Task trackers** page under App, after Notifications. Its nav entry shows a dot when a connection needs attention (`1 connection needs attention`). (`settingsPage.test.ts`, `task-trackers.e2e.ts`)
- [x] The page lists GitHub Issues first, then one row per Linear, Jira or ClickUp connection: `<tracker> · <site>`, a status line `Connected as <name> · <auth> · <n> sources` (`pick what to show` before any source), and **Sources**, **States** and **Disconnect**. A connection whose token was rejected shows the tracker's message in red, with **Reconnect**. (`trackersPage.test.ts` connectionLine, `task-trackers.e2e.ts`)
- [x] **Add tracker** offers Connect Linear and Connect Jira Cloud. GitHub Issues needs no connecting. A connection is one tracker and site. (`task-trackers.e2e.ts`, `config.rs` connections_with_their_sources)
- [x] **Add tracker** also offers Connect ClickUp, and more than one connection of the same tracker is allowed (two Jira sites, two Linear organisations). (`task-trackers.e2e.ts`)
- [x] Disconnect asks first ("moonlet forgets the token for <site> and stops showing its issues. Sessions keep their links."), deletes the token from the Keychain and removes the connection, with its sources, from `trackers.toml`. A connection that needed attention takes its dot in the Settings nav with it. Session links (X46) stay, and reconnecting the same tracker and site gets the same connection id back, so the links resolve again. (`task-trackers.e2e.ts` disconnects after asking; the stable id, `config.rs` connections_with_their_sources)

### Signing in

- [ ] **Linear OAuth:** moonlet opens Linear's authorize URL with a PKCE `S256` challenge and the loopback redirect `http://127.0.0.1:53682/callback` (a fixed port, since Linear's redirect must match exactly). The callback's `state` must match; the code is exchanged with the verifier and no client secret. The tokens go to the Keychain. The access token is refreshed a minute before it expires, one refresh at a time; a token without an expiry is never refreshed. A sign-in that lapsed says "Sign in to Linear again". The button shows only in a build made with `MOONLET_LINEAR_CLIENT_ID`. (Partly: it waits for the maintainer's registered OAuth app, so no real sign-in against Linear has run. `the_loopback_listener_waits_for_the_callback_with_its_state`, `two_commands_at_once_spend_the_refresh_token_once`, `a_rejected_linear_token_reads_as_its_kind_of_sign_in`, `a_silent_connection_does_not_hold_up_the_callback`, `oauth.rs` the_callback_gives_the_code_only_with_the_right_state and a_token_is_refreshed_a_minute_before_it_expires.)
- [x] **Linear API key** is accepted instead of OAuth. (`task-trackers.e2e.ts` against a mock of Linear's API)
- [x] **Jira Cloud:** site, email and API token; requests use basic auth. Only a `*.atlassian.net` or `*.jira.com` host gets the token. Jira API tokens expire, and Jira's API does not say when, so moonlet does not warn ahead. When Jira answers 401, the row shows "Jira no longer accepts the API token for <site>. It may have expired or been revoked. Create a new token and paste it here." Reconnect keeps the site and email, saved with the connection, and asks only for a new token. (`jira.rs` a_rejected_token_needs_reconnecting, `only_a_jira_cloud_host_gets_the_token`, `config.rs` a_jira_connection_keeps_its_email_for_reconnecting)
- [x] A rejected token can make Jira's search come back empty rather than refused, so each sync asks Jira who the user is first. (`task-trackers.e2e.ts`)
- [x] **ClickUp:** the personal token is sent as the raw `Authorization` header value. The connection is the account's first ClickUp workspace. (`task-trackers.e2e.ts`)
- [x] **GitHub Issues:** the row shows `Connected as <login> · uses gh on <host>` from `gh.whoami` on the shown workspace's host, or `gh is not signed in on <host> · run gh auth login there`, or `gh is not installed on <host>`. **Check again** asks again. (`the_github_login_comes_from_gh`, `a_gh_without_a_login_says_so`, `trackersPage.test.ts`, `task-trackers.e2e.ts`)
- [x] Connect and Reconnect check the sign-in, then show `Signed in as <name> · <n> sources visible`. (`task-trackers.e2e.ts`)
- [x] A sign-in that fails shows the tracker's error in the dialog. (`task-trackers.e2e.ts`)
- [x] A request the tracker refuses as unauthenticated (HTTP 401, or Linear's authentication error) marks the connection as needing attention and stops polling it until the user connects again (Reconnect, or signing in with Linear again). Its sources keep their last good tasks, and the workspace's other sources keep syncing: the workspace shows no sync error for it. The message names the tracker and what to do: a Linear API key "Linear no longer accepts this token. Create a new one and paste it here."; ClickUp the same words with ClickUp's error code in brackets; Jira the message above. A lapsed Linear OAuth sign-in's wording is under Linear OAuth above. (`tasksStore.test.ts` marks a connection whose token stopped working, a rejected connection does not stop the workspace's sync; `jira.rs` a_rejected_token_needs_reconnecting, `clickup.rs` a_rejected_token_needs_a_new_one, `linear.rs` an_unauthenticated_answer_asks_to_sign_in_again)
- [x] The Jira connect dialog says "The token is saved in the macOS Keychain." and "Tokens expire. moonlet tells you when Jira stops accepting it." (`task-trackers.e2e.ts`)
- [x] The ClickUp connect dialog says "The token is saved in the macOS Keychain." too. (`task-trackers.e2e.ts`)

### Sources

- [x] A source is one Linear team, Jira project or ClickUp list (the lists of each space), or a GitHub repository. It is known by its connection and its key: the team key, the project key or the list id. (`linear.rs` the_viewer_teams_and_states, `jira.rs` myself_and_projects, `clickup.rs` user_workspaces_spaces_lists_and_statuses)
- [x] The lists inside each ClickUp space's folders are sources too. (`clickup.rs` the_lists_inside_a_spaces_folders_are_sources)
- [x] Each Linear, Jira or ClickUp source has a **project** (the moonlet project its sessions start in), a **workspace** (X32) and a **Shows** filter: `Assigned to me` (default) or `All open issues`. Assigned to me uses the tracker's own idea of who the user is (Jira `currentUser()`, ClickUp the account's user id); All open issues also takes everyone else's. (`trackerSources.test.ts`, `tasksStore.test.ts` Shows, `task-trackers.e2e.ts`, `jira.rs` the_search_and_write_bodies, `clickup.rs` requests and user_workspaces_spaces_lists_and_statuses)
- [x] For Linear, Assigned to me uses Linear's own `isMe`. (`linear.rs` assigned_to_me_is_linears_own_is_me)
- [x] "Where each workspace gets its tasks" lists each workspace with its sources (`GitHub acme/web · Linear Engineering`). A source whose connection needs attention is outlined red with its reason. (`trackerSources.test.ts` sourceList)
- [x] A workspace's GitHub sources are its projects whose `origin` is on github.com. They show the issues assigned to the user. (`tasksStore.test.ts` refreshTasks)

### States

- [x] moonlet groups tasks into **Todo**, **In Progress**, **In Review** and **Done**, plus **Not shown**. (`states.rs`, `tasksBoard.test.ts`)
- [x] Each connection's **States** dialog lists the states of one of its sources (a picker when it has several), each with a column menu: Todo, In Progress, In Review, Done or Not shown. It starts from the defaults below. A state moved to another column is saved under the connection's `states` in `trackers.toml`, and the board uses a saved mapping at once. Moves follow the mapping too (X46). (`stateMapping.test.ts`, `tasksStore.test.ts` the state mapping, `task-trackers.e2e.ts`)
- [x] Only states moved off their default column are saved. (`trackerSources.test.ts` changedStates)

| Column | Linear (state type) | Jira (status category) | ClickUp (status type) | GitHub |
|---|---|---|---|---|
| Todo | `unstarted` | `new` | `open` | open, no session |
| In Progress | `started` | `indeterminate` | `custom` | open, has a session |
| In Review | `started` named like "review" or "QA" | `indeterminate` named like "review" or "QA" | `custom` named like "review" or "QA" | open, has an open PR that is not a draft |
| Done | `completed` | `done` | `closed`, `done` | closed as completed |
| Not shown | `backlog`, `triage`, `canceled` | — | — | closed as not planned |

- [ ] A GitHub project board source maps its Status field options instead, like Linear states (defaults by name: "Todo" or "To do", "In Progress", a name with the word "review" or "QA", and "Done"; other options are not shown). (Deferred, see Out of scope; the name defaults are in `states.rs`.)
- [x] Priority is shown as 0–3 bars: Linear Urgent and High are 3, Medium 2, Low 1, none 0; Jira Highest, High, Blocker and Critical 3, Medium and Major 2, Low, Lowest, Minor and Trivial 1 (Jira's default scheme and its older one); ClickUp urgent and high 3, normal 2, low 1; GitHub has none. (`priority.rs`)
- [x] "Named like review or QA" means the state name has the word "review" or "QA" in it ("In Review", "Code review", "Ready for QA"), not just those letters ("Preview" is not review). (`states.rs`)

### Branch names and linking

- [x] Each tracker has a "Branch name for new sessions" template with `{key}` and `{title}`, and for GitHub `{number}`. Left empty, it is the tracker's default: `{key}-{title}` for Linear, Jira and ClickUp, `{number}-{title}` for GitHub (the same as `gh issue develop`). The name is lower case; accented letters become plain ones (é → e, ł → l, ß → ss), also when the accent comes as a separate combining mark; `/` stays and any other run of characters between words becomes one `-`. It is cut between words to the max length: 48 by default, and Settings sets GitHub's, from 8 to 200. (`branch.rs` accented_letters_lose_their_accents, decomposed_accents_are_dropped_too, `a_task_branch_follows_the_trackers_default_template`)
- [x] The template also takes `{user}` (the tracker account's first name, lower case, or the `gh` login for GitHub) and `{type}` (Jira's issue type, else the first label), and Settings previews the template on a real issue of that tracker, or an example. (`lib.rs` a_task_branch_fills_user_and_type, `jira.rs` an_issue_carries_its_type, `tasks.test.ts` taskStart's {type}, `tasksStore.test.ts` branchUser, `trackersPage.test.ts` previewTask)
- [x] "Link a session to an issue when": its branch name contains the issue key (on; for GitHub, its branch starts with `<number>-` and its project's `origin` is the issue's repository); its pull request's title has the key, or for GitHub the PR closes the issue (on); its name looks like an issue title (on, and only ever a suggestion). (`tasks.test.ts`, `tasksBoard.test.ts`, `settingsSearch.test.ts`)
- [x] Keys: Linear and Jira `ABC-123` (a Jira project key may hold `_`: `MY_PROJ-12`); ClickUp the task's custom ID when it has one, otherwise `CU-<task id>`; GitHub `<owner>/<repo>#<number>`. The app matches keys in branch names and PR titles (`mentionsKey` in `apps/desktop/src/lib/tasks.ts`): case does not matter, and no letter or digit may touch the key. `_`, `/` or `-` around it are fine. So `moon-142-x` and `feat_moon-142` carry `MOON-142`; `moon-1420` does not. Pasted keys and URLs are read by `moonlet-trackers` (X46). (`tasks.test.ts` mentionsKey, `refs.rs` a_jira_project_key_may_hold_an_underscore)
- [x] The key's own `-` must be there: `moon_142` does not carry `MOON-142`. (`tasks.test.ts` needs the key's own hyphen)

### Sync

- [x] Settings › Task trackers › Sync › "Refresh issues": every 30 seconds, every minute (default), every 5 minutes, or only when I refresh. While Tasks mode is open, tasks refresh when the window comes to the front, at most every 15 s. "Only when I refresh" means no refresh by itself: no refresh on focus. Opening Tasks mode still loads once, and the refresh button in the Tasks sidebar syncs. (`tasksStore.test.ts` syncTasks, `prPoll.test.ts` focusThrottle, `task-trackers.e2e.ts`)
- [x] While Tasks mode is open, tasks also refresh on the chosen interval, and "Only when I refresh" sets no timer. (`tasksStore.test.ts` syncTasks timer)
- [x] A linked session opened outside Tasks mode asks for its workspace's tasks at most once a minute, whether the last try worked or not, and only once while a sync runs. Under "Only when I refresh" it asks only while there is no list yet. (`tasksStore.test.ts` ensureTasks)
- [x] What a sync reads: Linear open issues plus completed and canceled ones updated in the last 14 days, in pages; Jira open issues plus done ones updated in the last 14 days, newest first; ClickUp open tasks of any age, minus those in Done by the state mapping (whatever their age; tasks in a status not shown are kept), plus closed and done ones updated in the last 14 days; GitHub the 100 most recently updated issues, open and closed. Only `https` links are kept as a task's link. (`linear.rs` issues_are_read_page_by_page, `jira.rs` the_search_and_write_bodies, `clickup.rs` requests and the_two_passes_make_open_tasks_and_recent_closed_ones, the_open_pass_follows_the_users_state_mapping, `task.rs` only_https_links_are_kept, `git.rs` github_issues_as_tasks)
- [x] Linear reads pages of 100 and Jira pages as Jira sends them; each reads at most 5 pages (500 issues). (`linear.rs` assigned_to_me_is_linears_own_is_me, `task-trackers.e2e.ts`)
- [x] Sync failures keep the last good tasks of the source that failed and take the others fresh. They never empty the board. (`tasksStore.test.ts` keeps the last good list when a sync fails, keeps the last tasks only of a source that failed)
- [x] A failed sync shows `Sync failed · <error>` in the Tasks sidebar's footer. (`tasks-mode.e2e.ts`)
- [x] "Notify when a task changes state outside moonlet" (on by default) sends a notification when a task with a session moves to another column and moonlet did not move it. moonlet's own moves are never announced, even when a sync that started before the move lands after it, or the move lands on a state the user mapped to that column. A closed GitHub issue whose close reason changes is not announced again. (`keepInStep.test.ts` outsideMoves, `tasksStore.test.ts` a linked task changed outside moonlet, outside changes with a state mapping, `settingsSearch.test.ts`)
- [x] Each notice also goes into the task's Activity as `Outside moonlet: …`. (`tasksStore.test.ts` a linked task changed outside moonlet)

### Saving

- [x] Every change saves to `trackers.toml` at once, and quick changes in a row all land. A change made while the file is still loading is not written ("Task tracker settings are still loading"), and a write that fails shows the file as it was and drops the changes queued behind it. A `trackers.toml` that could not be read is never written over: saving shows an error instead. (`tasksStore.test.ts` saveTrackersConfig: keeps both of two quick changes, waits for the file before changing it, and shows the file again when a write fails, drops a change queued behind a write that failed, a change made while a failed write reloads the file is dropped too, does not write over a file it could not read; `task-trackers.e2e.ts`)
- [x] Settings search finds GitHub's rules and branch name, the sync interval and each connected tracker's own branch name. (`settingsSearch.test.ts`)
- [x] A line at the bottom of the page reads: "Tokens are kept in the macOS Keychain on this Mac and never sent to remote hosts. moonletd only stores which issue each session is linked to. Settings are saved to ~/.moonlet/trackers.toml." (`task-trackers.e2e.ts`)

## UI

The designs are the "Settings · Task trackers", "Connect Jira" and "Tasks with no tracker connected" boards of the Tasks mode design. Settings › Task trackers is one page, saved as soon as a setting changes:

- **Connections:** GitHub Issues, one row per connection, Add tracker.
- **Keep <tracker> in step**, one per connected tracker: its five rules (X46) and its branch name.
- **Keep GitHub in step:** GitHub's four rules.
- **Branch names:** GitHub's template and Max length.
- **Linking:** the three link rules.
- **Where each workspace gets its tasks.**
- **Sync:** Refresh issues and the notification switch.

Dialogs: Connect or Reconnect (sign-in, then sources), Sources (each source's tick, workspace, Shows and project, then **Save and sync**) and States (each state's column, then **Save**). A failure shows the tracker's message in the dialog or on the row.

## Protocol and RPCs

No daemon RPCs for Linear, Jira or ClickUp: the desktop app's Rust side makes those requests (ADR 0010). Desktop-only Tauri commands:

- `tracker_connect {kind, site?, email?, token}` → `{connection, sources}`; `tracker_oauth_available` → whether this build can sign in with Linear; `tracker_oauth_linear` → opens the browser and resolves with `{connection, sources}` when the callback arrives.
- `tracker_disconnect {id}`; `tracker_sources {id}` → `[{key, name}]`; `tracker_states {id, source}` → `[{name, column}]`, each state with its default column.
- `tracker_tasks {id, mine}` → normalised tasks of the connection's sources.
- `tracker_task {id, key}` → one task by its key, or none (X46: a pasted key or URL).
- `tracker_update {id, task, source, column?, assign_me?, comment?}` moves an issue (the Rust side picks the state, X46), assigns it to the user and/or comments on it.
- `trackers_config` → `trackers.toml` or its defaults; `trackers_save {config}` writes it.
- `task_branch_name {kind, template?, key, title, number?, max_len?}` and `task_parse_pasted {input}` (X46).

GitHub goes through the daemon, because `gh` runs on the project's host:

- `gh.tasks {path, mine}` → the repository's 100 most recently updated issues, open and closed (so recently closed ones fill Done), only those assigned to the user when `mine` (the app always asks for `mine`): `{repo, number, title, body, url, closed, state_reason, assignees, labels, updated_ms, closing_prs}`. `closing_prs` are the same repository's PRs that close the issue. Bodies are cut to 4000 characters.
- `gh.task_update {path, number, assign_me?, close?, reopen?}`.
- `gh.task {path, repo, number}` → one issue of any `owner/name` repository (X46: a pasted key or URL).
- `gh.whoami {}` → the login `gh` is signed in as on the host, or gh's error.

## Data and config

- A connection's id is its tracker and site: `linear:<organisation url key>`, `jira:<site>` (`jira:acme.atlassian.net`), `clickup:<ClickUp workspace id>`. GitHub Issues is always `github:github.com`. The id has no account part, so there is one connection per tracker and site. It is what session links store, so a link survives reconnecting and resolves on another Mac that connects the same site.
- `~/.moonlet/trackers.toml` on the Mac running the app. The app owns the file and rewrites it whole, through a temp file (a header comment says so), so comments added by hand do not survive. A section at its defaults is left out.
  - `[sync]`: `interval` (seconds, `0` for only when I refresh) and `notify`.
  - `[github]`, `[linear]`, `[jira]`, `[clickup]`: `branch_template` (empty for the default) and `max_length`, and the Keep in step rules under `[<tracker>.rules]`. Rules and branch names are per tracker, not per connection.
  - `[link]`: `branch`, `pr`, `title`.
  - `[[connections]]`: `id`, `kind`, `site`, `account`, `auth` (`api_key`, `token` or `oauth`), never the token; `[[connections.sources]]` with `key`, `name`, `project`, `workspace` and `all`; `[connections.states]` mapping a state name to a column.
- Tokens: Keychain generic passwords, service `dev.onedevstudio.moonlet.trackers`, account `<connection id>`. A Linear OAuth sign-in is kept as its access token, refresh token and expiry. e2e builds, and builds for other systems, keep tokens in `~/.moonlet/secrets.json`, readable only by the user.

## Security considerations

- Atlassian's basic-auth page (updated 2026-10-14) says apps that collect users' API tokens don't comply with its security requirements and recommends one distributable OAuth (3LO) app. Jira's API-token sign-in should move to OAuth through a small token-exchange server before a public release.
- An e2e build can point trackers at a mock server with `MOONLET_TRACKER_BASE`; other builds ignore it, so no environment variable can send a token elsewhere.
- Tokens never leave the Mac running the app: not in `trackers.toml`, not in the daemon, not over SSH to remote hosts, not in logs. Errors are logged without request headers.
- Ids from a tracker that go into a request path must be letters, digits, `-` and `_`. The Jira site is checked again on every request, since `trackers.toml` can be edited.
- The OAuth callback listens only on 127.0.0.1, for at most 5 minutes, and checks `state`; a connection that says nothing is dropped after 2 s.
- Tracker content (titles, descriptions, comments) is untrusted. It is shown as plain text, only `https` links are kept, and when it becomes an agent's first message (X46) it is shown in the composer for the user to send, never sent unseen.
- The webview's CSP stays closed to the network; all tracker requests go through Tauri commands.

## Out of scope

- GitHub project boards as sources: reading one needs the `read:project` scope and the Projects v2 GraphQL API; for now a GitHub source is a repository.
- Linear sign-in in a build without `MOONLET_LINEAR_CLIENT_ID`: the flow is in place and waits for the maintainer's registered OAuth app.
- OAuth for Jira and ClickUp. Both need a client secret, which a desktop app built from a public repository cannot keep. A small token-exchange server may add it later.
- Rules or branch names per connection or per source; a Shows filter for GitHub sources.
- The view each workspace opens Tasks mode on (X45 has no Current cycle view yet).
- A cache of the last good tasks on disk, and pre-filling a source's project from `.moonlet/config.toml`.
- Jira Server and Data Center, GitHub Enterprise Server.
- Creating issues and editing fields other than state and assignee.
- Tasks on the phone app.

## Test plan

- Rust unit tests in `crates/moonlet-trackers` against captured, sanitised responses from each tracker: task parsing, sources, states and the state a move picks, priority, pasted keys and URLs (`refs.rs`), branch names, Jira's document format to Markdown, OAuth helpers, `trackers.toml`, error messages and request bodies.
- Rust tests in the app's Tauri side (`apps/desktop/src-tauri`): the Jira host check, ids in request paths, the OAuth loopback listener, pasted keys and branch names as the app gets them, reading `trackers.toml`.
- Core and daemon tests for `gh.tasks` parsing with captured `gh` output (`git.rs`), `gh.whoami` and `gh.task_update` with a stub `gh` (`daemon.rs`).
- Vitest in `apps/desktop/src/lib/`: key matching (`tasks.test.ts`), the status lines and rule wording (`trackersPage.test.ts`), sources per workspace (`trackerSources.test.ts`), the state mapping (`stateMapping.test.ts`), sync, Shows, rejected tokens, outside changes and saving (`tasksStore.test.ts`, `keepInStep.test.ts`), settings search and nav (`settingsSearch.test.ts`, `settingsPage.test.ts`).
- e2e (`task-trackers.e2e.ts`): GitHub's login through a stub `gh`, a rule saved to `trackers.toml`, Linear connected with an API key against a mock server, a state mapped to another column, its issues in Tasks mode, and a session started from one moving it.

## Open questions

- The Linear OAuth app's client ID (registered by the maintainer). Until it exists, Linear connects with an API key.
