# X44 — Task trackers

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X2 (pull requests), X32 (workspaces), X43 (settings page), X45 (Tasks mode), X46 (tasks in sessions)
- **Related ADRs:** [0010](../adr/0010-task-trackers-in-the-app.md)

## Summary

moonlet connects to the issue trackers a user already works in, so Tasks mode (X45) can show each issue beside the sessions, worktrees and pull requests working on it. The first four trackers are Linear, Jira Cloud, ClickUp and GitHub Issues. Each connection signs in as the user, picks the teams, projects, lists or repositories it shows (its **sources**), and maps the tracker's states onto moonlet's four columns. Tokens stay in the macOS Keychain of the Mac running the app; `moonletd` only stores which issue each session is linked to (the connection id, key and URL).

## User journey

1. The user opens Settings › Task trackers (or clicks a tracker in the "Connect a task tracker" popover, X45).
2. They pick **Add tracker** › Linear, Jira Cloud, ClickUp or GitHub Issues.
3. They sign in:
   - **Linear:** "Sign in with Linear" opens the browser (OAuth with PKCE). "Use an API key" is the alternative.
   - **Jira Cloud:** site (`acme.atlassian.net`), email and API token, with a "Create one" link to Atlassian's token page.
   - **ClickUp:** a personal API token (`pk_…`), with a link to ClickUp's Apps settings.
   - **GitHub Issues:** one click. It uses the `gh` login on the host that owns each project.
4. moonlet tests the sign-in ("Signed in as Sam · 4 projects visible") and lists what the account can see. The user ticks the sources to show.
5. Save and sync. The connection appears under Connections with its status, and its sources can be assigned to workspaces.
6. On the connection's page the user adjusts sources (repository, workspace, which issues show), the state mapping, the Keep in step rules (X46) and the branch name template.

## Behaviour and acceptance criteria

### Connections

- [x] Settings has a **Task trackers** page under App, after Notifications. Its nav entry shows a dot when a connection needs attention. (The dot comes with connections that can fail; `settingsPage.test.ts`, `task-trackers.e2e.ts`.)
- [x] The page lists one row per connection: tracker mark, name, site, status dot and line, and actions. Connected rows show `Connected as <name> · <auth> · <n> teams · synced <age>` with **Sync now** and **Configure**. A failed row shows the error in red (for example `API token rejected · Acme issues are stale`) with **Reconnect**. Trackers not connected show **Connect**. (Sync now is the Tasks mode refresh; `trackersPage.test.ts` connectionLine, `task-trackers.e2e.ts`)
- [x] **Add tracker** offers the four trackers. More than one connection of the same tracker is allowed (two Jira sites, two Linear organisations). (GitHub is always there through `gh`; the page offers Connect Linear, Jira Cloud and ClickUp.)
- [x] Disconnect asks first, deletes the token from the Keychain and removes the connection's sources from every workspace. Session links (X46) stay, and reconnecting the same tracker and site gets the same connection id back, so the links resolve again. (`task-trackers.e2e.ts` covers connecting; disconnect asks through the confirm modal.)

### Signing in

- [ ] **Linear OAuth:** moonlet opens Linear's authorize URL with a PKCE `S256` challenge and a loopback redirect `http://127.0.0.1:<port>/callback` on a port chosen at run time. The callback's `state` must match; the code is exchanged with the verifier and no client secret. The access and refresh tokens go to the Keychain; refresh happens before expiry. (Not yet: the PKCE parts are in `moonlet-trackers::oauth`, tested against RFC 7636; the flow needs a registered client ID and a fixed loopback port, which Linear's docs require to match exactly.)
- [x] **Linear API key** is accepted instead of OAuth. (`task-trackers.e2e.ts` against a mock of Linear's API)
- [x] **Jira Cloud:** site, email and API token; requests use basic auth. Jira API tokens expire, and Jira's API does not say when, so moonlet does not warn ahead. When Jira answers 401 to a token that worked before, the connection shows `API token rejected · <workspace> issues are stale` and Reconnect explains: "Jira no longer accepts the API token for <site>. It may have expired or been revoked. Create a new token and paste it here." The Reconnect dialog keeps the site and email and only asks for the new token. Only a `*.atlassian.net` or `*.jira.com` host gets the token. (`jira.rs`, `only_a_jira_cloud_host_gets_the_token`)
- [x] **ClickUp:** the personal token is sent as the raw `Authorization` header value. (`clickup.rs`)
- [ ] **GitHub Issues:** connecting checks `gh auth status` on each project's host. (Shipped: the page shows `Connected as <login> · uses gh on <host>` from `gh.whoami` on the shown workspace's host, or `gh is not signed in on <host> · run gh auth login there`; `the_github_login_comes_from_gh`, `a_gh_without_a_login_says_so`, `trackersPage.test.ts`, `task-trackers.e2e.ts`.) A host without a login shows `gh is not signed in on <host>` with the `gh auth login` command to copy. Reading a project board needs the `read:project` scope and moving its items the `project` scope; without them the page shows `gh auth refresh -s project` to copy, and project sources are unavailable.
- [ ] **Test again** re-runs the check and shows the account name and the number of visible sources, or the tracker's error message.
- [x] A request answered with 401 marks the connection as needing attention and stops polling it until the user reconnects. The message names the tracker and what to do: Linear OAuth "Sign in to Linear again", an API key or token "<tracker> no longer accepts this token. Create a new one and paste it here." (`tasksStore.test.ts`; Linear, Jira and ClickUp errors in `moonlet-trackers`)
- [x] The Jira and ClickUp connect dialogs say "The token is saved in the macOS Keychain." and, for Jira, "Tokens expire. moonlet tells you when Jira stops accepting it."


### Sources

- [ ] A source is one Linear team, Jira project, ClickUp list (or folder, or space) or GitHub repository or project board.
- [x] Each source has a **repository** (the moonlet project its sessions start in), a **workspace** (X32) and a **Shows** filter: `Assigned to me` (default) or `All open issues`. (Shows is Assigned to me for now. `trackerSources.test.ts`, `task-trackers.e2e.ts`)
- [ ] "Where each workspace gets its tasks" lists each workspace with its sources and the view Tasks mode opens on (`Current cycle`, `Active sprint`, `My issues`, or `Sessions mode` for a workspace with no sources). A source whose connection failed is outlined red with its reason.
- [ ] A GitHub repository source defaults to the project's own `origin` repository.

### States

- [x] moonlet groups tasks into **Todo**, **In Progress**, **In Review** and **Done**, plus **Not shown**. (`states.rs`, `tasksBoard.test.ts`)
- [ ] The page lists each column with the tracker states mapped onto it, removable chips and an add button. Defaults:

| Column | Linear (state type) | Jira (status category) | ClickUp (status type) | GitHub |
|---|---|---|---|---|
| Todo | `unstarted` | `new` | `open` | open, no session |
| In Progress | `started` | `indeterminate` | `custom` | open, has a session |
| In Review | `started` named like "review" or "QA" | `indeterminate` named like "review" or "QA" | `custom` named like "review" or "QA" | open, has an open PR |
| Done | `completed` | `done` | `closed`, `done` | closed as completed |
| Not shown | `backlog`, `triage`, `canceled` | — | — | closed as not planned |

- [ ] A GitHub project board source maps its Status field options instead, like Linear states (defaults by name: "Todo" or "To do", "In Progress", a name with the word "review" or "QA", and "Done"; other options are not shown).
- [x] Priority is shown as 0–3 bars: Linear Urgent and High are 3, Medium 2, Low 1, none 0; Jira Highest, High, Blocker and Critical 3, Medium and Major 2, Low, Lowest, Minor and Trivial 1 (Jira's default scheme and its older one); ClickUp urgent and high 3, normal 2, low 1; GitHub has none. (`priority.rs`)
- [x] "Named like review or QA" means the state name has the word "review" or "QA" in it ("In Review", "Code review", "Ready for QA"), not just those letters ("Preview" is not review). (`states.rs`)

### Branch names and linking

- [ ] "Branch name for new sessions" is a template with `{key}`, `{title}`, `{number}`, `{user}` and `{type}`, cut to "Max length" (default 48). The preview shows the result for a real issue. Defaults: `{key}-{title}` for Linear, Jira and ClickUp, `{number}-{title}` for GitHub (the same as `gh issue develop`). Left empty, Linear uses the issue's own branch name.
- [ ] "Link a session to an issue when": its branch name contains the issue key (on; for GitHub, its branch starts with `<number>-` and its project's `origin` is the issue's repository), its pull request mentions the key or closes the issue (on), its name looks like an issue title (off, and only ever a suggestion).
- [x] Keys: Linear and Jira `ABC-123`; ClickUp the custom task ID when the workspace has them, otherwise `CU-<task id>`; GitHub `<owner>/<repo>#<number>` (a pasted `#42` means that number in the current project's repository). Matching is case-insensitive and needs no letter or digit right before or after the key, so `moon-142-x` and `feat_moon-142` match `MOON-142` and `moon-1420` does not. (`refs.rs`, `tasks.test.ts`)

### Sync

- [x] Issues refresh every minute by default (options: 30 s, 1 min, 5 min, manual), and when the window comes to the front at most every 15 s. (`task-trackers.e2e.ts` saves it; the interval is read by Tasks mode.)
- [x] Sync failures keep the last good list and show its age; they never empty the board. (`tasksStore.test.ts`)
- [x] "Notify when a task changes state outside moonlet" (on by default) sends a notification when a task with a session moves to another column and moonlet did not move it. (`keepInStep.test.ts` outsideMoves, `tasksStore.test.ts`, `settingsSearch.test.ts`)
- [ ] A line at the bottom of the page reads: "Tokens are kept in the macOS Keychain on this Mac and never sent to remote hosts. moonletd only stores which issue each session is linked to."

## UI

The designs are the "Settings · Task trackers", "Settings · Linear connection", "Connect Jira" and "Tasks with no tracker connected" boards of the Tasks mode design. The connection page has four sections: Teams (or Projects, Lists, Repositories), Workflow states, Keep <tracker> in step (X46), Branch names and linking. It uses the X43 save bar: Cancel and Save (⌘↵).

States: loading (skeleton rows), a connection failure with the tracker's message, a source the token can no longer see (`Not visible to this account`, with Remove).

## Protocol and RPCs

No daemon RPCs for Linear, Jira or ClickUp: the desktop app's Rust side makes those requests (ADR 0010). Desktop-only Tauri commands:

- `tracker_connect {kind, site?, email?, token?}` → `{connection, account, sources}`; `tracker_oauth_start {kind}` → opens the browser and resolves when the callback arrives.
- `tracker_disconnect {id}`, `tracker_test {id}`, `tracker_sources {id}`.
- `trackers_config` → `trackers.toml` or its defaults; `trackers_save {config}` writes it (shipped).
- `tracker_tasks {id, source_ids}` → normalised tasks; `tracker_transition {id, key, column}`; `tracker_assign_me {id, key}`; `tracker_comment {id, key, body}`.

GitHub goes through the daemon, because `gh` runs on the project's host:

- `gh.tasks {path, mine}` → the repository's 100 most recently updated issues, open and closed (so recently closed ones fill Done), only those assigned to the user when `mine`: `{repo, number, title, body, url, closed, state_reason, assignees, labels, updated_ms, closing_prs}`. `closing_prs` are the same repository's PRs that close the issue. Project board status needs the `read:project` scope (`gh` fails with "requires one of the following scopes: ['read:project']" without it) and comes with project board sources.
- `gh.task_update {path, number, assign_me?, close?}` (project status later).
- `gh.whoami {}` → the login `gh` is signed in as on the host, or gh's error.

## Data and config

- A connection's id is its tracker and site: `linear:<organisation>`, `jira:<host>`, `clickup:<workspace id>`, `github:<host>`. It is what session links store, so a link survives reconnecting and resolves on another Mac that connects the same account.
- `~/.moonlet/trackers.toml` on the Mac running the app: connections (id, kind, site, account name, auth kind, never the token), sources, state mapping, rules, branch template, sync interval. The app owns the file and rewrites it whole (a header comment says so), so comments added by hand do not survive. Today it holds `[sync] interval` and `notify`, and `[github]` `branch_template`, `max_length` and `rules`; connections, sources and state mapping join with the other trackers.
- Tokens: Keychain generic passwords, service `dev.onedevstudio.moonlet.trackers`, account `<connection id>`.
- A cache of the last good task list per connection in `~/.moonlet/cache/tasks-<id>.json`, so Tasks mode opens instantly.
- Optional per project in `.moonlet/config.toml`: `[tasks] sources = ["linear:MOON"]`, which pre-fills the repository of a matching source.

## Security considerations

- Atlassian's basic-auth page (updated 2026-10-14) says apps that collect users' API tokens don't comply with its security requirements and recommends one distributable OAuth (3LO) app. Jira's API-token sign-in should move to OAuth through a small token-exchange server before a public release.
- An e2e build can point trackers at a mock server with `MOONLET_TRACKER_BASE`; other builds ignore it, so no environment variable can send a token elsewhere.

- Tokens never leave the Mac running the app: not in `trackers.toml`, not in the daemon, not over SSH to remote hosts, not in logs. Errors are logged without request headers.
- The OAuth callback listens only on 127.0.0.1, for one request, for at most 5 minutes, and checks `state`.
- Tracker content (titles, descriptions, comments) is untrusted. It renders through the same sanitised Markdown as agent messages, and when it becomes an agent's first message (X46) it is shown in the composer for the user to send, never sent unseen.
- The webview's CSP stays closed to the network; all tracker requests go through Tauri commands.

## Out of scope

- OAuth for Jira and ClickUp. Both need a client secret, which a desktop app built from a public repository cannot keep. A small token-exchange server may add it later.
- Jira Server and Data Center, GitHub Enterprise Server.
- Creating issues and editing fields other than state and assignee.
- Tasks on the phone app.

## Test plan

- Rust unit tests in `crates/moonlet-trackers` against captured, sanitised responses from each tracker: task parsing, state mapping, priority, keys in branch names, URL parsing, branch templates, Jira's document format to Markdown.
- Daemon tests for `gh.tasks` parsing with captured `gh` output.
- Vitest for the settings model (nav entry, dot, search entries).
- e2e: connect GitHub Issues against a stub `gh`, and Linear with an API key against a mock server.

## Open questions

- The Linear OAuth app's client ID (registered by the maintainer). Until it exists, Linear connects with an API key.
- Whether Linear accepts a loopback redirect on any port; if not, a fixed port range.
