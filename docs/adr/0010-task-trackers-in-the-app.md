# ADR 0010: Task trackers run in the desktop app; the daemon stores links and board snapshots, never tokens

- **Status:** proposed (2026-10-14)
- **Builds on:** [X2](../specs/X2-pull-requests-and-checks.md) (PRs through `gh`), [ADR 0009](0009-central-host-workers-live-copies.md) (a central host owns sessions), [X44](../specs/X44-task-trackers.md)–[X46](../specs/X46-tasks-in-sessions.md).

Tasks mode shows issues from Linear, Jira Cloud, ClickUp and GitHub Issues beside the sessions working on them. Something has to hold the user's tracker credentials, call the trackers, and remember which session belongs to which issue. The daemon may run on another machine (a remote host, or the central host of ADR 0009), and the phone talks to it too.

**Decision.**

- **Linear, Jira and ClickUp are called from the desktop app's Rust side**, through Tauri commands, the same way `claude_latest_version` reaches the npm registry. The webview's CSP stays closed to the network.
- **Their tokens live in the macOS Keychain of the Mac running the app**, using the `Tokens` pattern of the phone app (`apps/mobile/src-tauri/src/macs.rs`). They are never sent to a daemon and never cross SSH. Only e2e builds, and builds for other systems, which have no Keychain, keep them in `~/.moonlet/secrets.json`, readable only by the user.
- **GitHub Issues goes through the daemon**, because it uses `gh`, and `gh` is signed in on the host that owns the project and opens its PRs (X2). moonlet holds no GitHub token.
- **The daemon stores only links** (amended by X76: and each workspace's board snapshot, never a token): `Session.task = {connection, key, url}`, and `Session.task_unlinked` when the user unlinked a session, so derived links stop applying to it until it is linked again. Links that can be derived (the key in the branch name, a PR that closes the issue) are computed in the app and never stored.
- **Parsing and decisions are pure code** in a new crate, `crates/moonlet-trackers` (response parsing, default columns and the state a move lands on, pasted keys and URLs, branch names, OAuth helpers, `trackers.toml`), and in `apps/desktop/src/lib/` (matching keys in branches and PR titles, the board, out of sync, Keep in step). Network and Keychain code stays thin.
- **Sign-in:** OAuth only where it needs no client secret: Linear (PKCE with a loopback redirect) and GitHub (through `gh`'s own login). Jira Cloud and ClickUp use personal API tokens. Decided by the user on 2026-10-14.

**Rejected.**

- **Tracker calls in the daemon:** the tokens would have to reach every host, including remote ones, and live on disk there. The phone would see tasks for free, but that is not worth spreading credentials.
- **OAuth for every tracker now:** Jira's 3LO and ClickUp's OAuth need a client secret for the code exchange, and Jira also for every hourly refresh. A secret in an app built from a public repository is public. It would take a token-exchange server that moonlet runs, sees tokens in transit, and that Jira would depend on every hour. It can be added later for ClickUp first, where it is only needed at connect time.
- **Calling trackers from the webview with `fetch`:** it would open the CSP to every tracker's domain and put tokens in JavaScript.

**Consequences.**

- The phone app does not show tasks. A later change could have the desktop push a task summary to the daemon.
- Two Macs running the app each connect their own trackers; `trackers.toml` and the Keychain are per Mac. Session links are shared, because they live in the daemon, and resolve on both Macs because a connection's id is its tracker and site (`jira:acme.atlassian.net`), not a per-Mac random id.
- **Amended 2026-10-15 (X44):** which projects a source's sessions start in moved from `trackers.toml` (one project per source, per Mac) to each repository's committed `.moonlet/config.toml` (`trackers = ["<connection>/<key>"]`), which the daemon reads and writes like the rest of Project settings. One tracker project often serves several repositories, and the link describes the repository, so teammates share it; it holds no token, only the connection id and key. The daemon still stores no tracker data of its own.
- **Amended 2026-10-17 (X50):** sources are replaced by boards in `trackers.toml` (per Mac): a board's origin, columns, filter and card fields are the user's view of a tracker. The committed `.moonlet/config.toml` links stay the default for where a board's sessions start, so teammates still share them; a board's own start-in rules, also per Mac, override them for that user only. The state mapping moves from each connection to its boards, and sources become boards when the app reads the file.
- Two Macs connected to the same tracker each run Keep in step on their own. Rules, and what was already done, are kept per Mac, so both may move the same issue or comment the same PR's link.
- Keep in step actions (X46) run in the app, so they only happen while the app is open; an action missed while it was closed shows as out of sync on the next sync instead.
- **Amended 2026-10-29 (X76):** the phone shows tasks. The app saves a snapshot of each workspace's boards (settings, tasks as last read, worktrees, activity) in that workspace's daemon (`tasks.set_snapshot`), and the phone reads it. Tracker data, not tokens, is now kept on daemon hosts, remote ones included. The phone asks an open app to move or create issues through a relay in the daemon (`tasks.request` / `tasks.answer`), and reads and posts comments the same way; with the app closed the phone shows the last snapshot, and the moves it asks for wait on the phone until the app is open again. The earlier consequence "The phone app does not show tasks" no longer holds, and the decision "The daemon stores only links" now reads "links and board snapshots, never tokens".
