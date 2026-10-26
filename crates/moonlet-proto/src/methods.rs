//! RPC method names and their parameter shapes. Results are the types in
//! [`crate::types`] unless noted.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::TerminalId;
use crate::types::{AgentState, ProjectConfig, StateSource, TerminalKind};

// Daemon
pub const DAEMON_INFO: &str = "daemon.info";
pub const DAEMON_SHUTDOWN: &str = "daemon.shutdown";
/// Hands every PTY to a freshly started daemon binary, then exits (S3).
pub const DAEMON_UPGRADE: &str = "daemon.upgrade";

// Sessions
pub const TERMINAL_CREATE: &str = "terminal.create";
pub const TERMINAL_LIST: &str = "terminal.list";
pub const TERMINAL_ATTACH: &str = "terminal.attach";
pub const TERMINAL_DETACH: &str = "terminal.detach";
pub const TERMINAL_RESIZE: &str = "terminal.resize";
pub const TERMINAL_KILL: &str = "terminal.kill";
pub const TERMINAL_WRITE: &str = "terminal.write";
pub const TERMINAL_SEARCH: &str = "terminal.search";
pub const TERMINAL_SET_CLASSIC: &str = "terminal.set_classic";
/// An agent reads a terminal of its own session, once the user allows (X31).
pub const TERMINAL_READ: &str = "terminal.read";
/// The terminals `terminal.read` may read for a caller: `TerminalRef`
/// of the caller, returns `[TerminalInfo]`.
pub const TERMINAL_READ_LIST: &str = "terminal.read_list";
pub const TERMINAL_READ_ANSWER: &str = "terminal.read_answer";
pub const TERMINAL_READ_REQUESTS: &str = "terminal.read_requests";
pub const TERMINAL_READ_GRANTS: &str = "terminal.read_grants";
pub const TERMINAL_READ_GRANT_CLEAR: &str = "terminal.read_grant_clear";

// Agents
pub const AGENT_REPORT: &str = "agent.report";

pub const HOOKS_STATUS: &str = "hooks.status";
pub const HOOKS_INSTALL: &str = "hooks.install";
pub const HOOKS_UNINSTALL: &str = "hooks.uninstall";

// Repos and workspaces
pub const PROJECT_ADD: &str = "project.add";
pub const PROJECT_LIST: &str = "project.list";
/// `{path}` → `ProjectIdentity` of any folder inside a repository (X41).
pub const PROJECT_IDENTITY: &str = "project.identity";
pub const PROJECT_REMOVE: &str = "project.remove";
pub const PROJECT_CONFIG: &str = "project.config";
pub const PROJECT_CONFIG_FILE: &str = "project.config_file";
pub const PROJECT_SET_CONFIG: &str = "project.set_config";
/// `{id}` → the project's linked work trees (X45).
pub const PROJECT_WORKTREES: &str = "project.worktrees";
/// `{id, path}`: removes a linked worktree no session uses (X45 Clean up).
pub const PROJECT_WORKTREE_REMOVE: &str = "project.worktree_remove";
pub const WORKSPACE_CREATE: &str = "workspace.create";
pub const WORKSPACE_LIST: &str = "workspace.list";
pub const WORKSPACE_UPDATE: &str = "workspace.update";
pub const WORKSPACE_DELETE: &str = "workspace.delete";
pub const PROFILE_LIST: &str = "profile.list";
pub const PROFILE_CREATE: &str = "profile.create";
pub const PROFILE_UPDATE: &str = "profile.update";
pub const PROFILE_DELETE: &str = "profile.delete";
pub const PROFILE_STATUS: &str = "profile.status";
/// The installed Claude Code version, and `claude update` (X36).
pub const CLAUDE_VERSION: &str = "claude.version";
pub const CLAUDE_UPDATE: &str = "claude.update";
pub const SECTION_CREATE: &str = "section.create";
pub const SECTION_LIST: &str = "section.list";
pub const SECTION_UPDATE: &str = "section.update";
pub const SECTION_DELETE: &str = "section.delete";
pub const SECTION_ADD_PROJECT: &str = "section.add_project";
pub const SECTION_REMOVE_PROJECT: &str = "section.remove_project";
pub const SECTION_MOVE: &str = "section.move";
/// Adding a project from GitHub (X59): gh on the host, a repository's
/// details, the user's repositories, the folder a clone would go to, and
/// the clone itself, which answers at once and reports through events.
pub const REPO_GH_STATUS: &str = "repo.gh_status";
pub const REPO_LOOKUP: &str = "repo.lookup";
pub const REPO_LIST: &str = "repo.list";
pub const REPO_CLONE_TARGET: &str = "repo.clone_target";
pub const REPO_CLONE: &str = "repo.clone";
pub const REPO_CLONE_CANCEL: &str = "repo.clone_cancel";
pub const SESSION_CREATE: &str = "session.create";
pub const SESSION_LIST: &str = "session.list";
pub const SESSION_ARCHIVE: &str = "session.archive";
pub const SESSION_UNARCHIVE: &str = "session.unarchive";
pub const SESSION_UPDATE: &str = "session.update";
pub const SESSION_RUN: &str = "session.run";

// Git
pub const GIT_STATUS: &str = "git.status";
pub const GIT_FILE_VERSIONS: &str = "git.file_versions";
pub const GIT_DIFF: &str = "git.diff";
pub const GIT_STAGE: &str = "git.stage";
pub const GIT_UNSTAGE: &str = "git.unstage";
pub const GIT_REVERT: &str = "git.revert";
pub const GIT_APPLY_PATCH: &str = "git.apply_patch";
pub const GIT_COMMIT: &str = "git.commit";
pub const GIT_LOG: &str = "git.log";
pub const GIT_BRANCHES: &str = "git.branches";
pub const GIT_BASE_STATUS: &str = "git.base_status";
pub const GIT_PULL_BASE: &str = "git.pull_base";
pub const GIT_ORIGIN_URL: &str = "git.origin_url";
/// The host's Git settings (X55): `{}` → `GitSettings`.
pub const GIT_SETTINGS: &str = "git.settings";
/// Changes some of the host's Git settings: a partial `GitSettings` → the
/// whole, as saved (X55).
pub const GIT_SET_SETTINGS: &str = "git.set_settings";
/// `GitUnpushed` → `UnpushedWork`: what in a session is only on its host (X55).
pub const GIT_UNPUSHED: &str = "git.unpushed";
/// `GitUnpushed`: `git push -u origin <branch>`, else HEAD (X55 "Push, then archive").
pub const GIT_PUSH: &str = "git.push";
pub const GH_PR_CREATE: &str = "gh.pr_create";
pub const GH_ISSUES: &str = "gh.issues";
pub const SHELL_HISTORY: &str = "shell.history";
pub const SHELL_COMMANDS: &str = "shell.commands";
pub const CHAT_STATE: &str = "chat.state";
pub const CHAT_SEND: &str = "chat.send";
/// Every chat's state without its items: `[{ id, state }]` (X40).
pub const CHAT_SUMMARIES: &str = "chat.summaries";
pub const CHAT_PERMISSION: &str = "chat.permission";
pub const CHAT_INTERRUPT: &str = "chat.interrupt";
/// Stops one running subagent: `{ id, agent }` (X42).
pub const CHAT_STOP_AGENT: &str = "chat.stop_agent";
/// Asks the agent to read a queued message now: `{ id, message? }` (X49).
pub const CHAT_SEND_NOW: &str = "chat.send_now";
/// Takes a message out of the agent's queue: `{ id, message }` (X49).
pub const CHAT_UNQUEUE: &str = "chat.unqueue";
/// Answers a side question from the conversation without touching it:
/// `{ id, text }` → `AsideAnswer` (X49).
pub const CHAT_ASIDE: &str = "chat.aside";
pub const CHAT_SETTINGS: &str = "chat.settings";
pub const CHAT_ADD_DIR: &str = "chat.add_dir";
pub const CHAT_MCP: &str = "chat.mcp";
pub const EV_CHAT_ITEM: &str = "chat.item";
pub const EV_CHAT_STATE: &str = "chat.state";
pub const GH_PRS: &str = "gh.prs";
/// `{path, number}` → what a picked PR's attachment sends in the new-session
/// composer (X54): its description, reviews and comments, as text.
pub const GH_PR_CONTEXT: &str = "gh.pr_context";
/// `{path, mine}` → the repository's 100 most recently updated issues, open
/// and closed, as `GhTask`s; `mine` keeps only those assigned to the user (X44).
pub const GH_TASKS: &str = "gh.tasks";
/// `{owners}`: the open GitHub Projects of the signed-in user and of
/// `owners` (X50 Add a board). Needs gh's `read:project` scope.
pub const GH_PROJECTS: &str = "gh.projects";
/// `{owner, number, mine?}`: a Project's items that are issues, with their
/// Status (X50 Sync); the user's own when `mine`.
pub const GH_PROJECT_ITEMS: &str = "gh.project_items";
/// `{project, item, field, option}`: sets a Project item's Status (X50), or
/// clears it with no `option` (No Status). Needs gh's `project` scope.
pub const GH_PROJECT_MOVE: &str = "gh.project_move";
/// `{ repo }` → the new-issue form's lists for a repository (X52): gh's
/// login, assignable people, labels, and whether they can be set.
pub const GH_CREATE_OPTIONS: &str = "gh.create_options";
/// `{ repo, title, body, assignee, labels }` → the issue created (X52), with
/// its node id; `assignee` is `me`, `none` or a login.
pub const GH_ISSUE_CREATE: &str = "gh.issue_create";
/// `{ project, content }` → the new item's id: the issue (`content`, its
/// node id) added to a Project (X52). Needs gh's `project` scope.
pub const GH_PROJECT_ADD: &str = "gh.project_add";
/// gh's token scopes for github.com, such as `read:project` (X50).
pub const GH_SCOPES: &str = "gh.scopes";
/// One issue of any repository by its number (X46: a pasted key or URL).
pub const GH_TASK: &str = "gh.task";
/// `{path, number, assign_me?, close?, reopen?}`: assigns a GitHub issue to
/// the user, closes it as completed or reopens it (X46 Keep in step).
pub const GH_TASK_UPDATE: &str = "gh.task_update";
/// A GitHub issue's comments (X66).
pub const GH_ISSUE_COMMENTS: &str = "gh.issue_comments";
/// Posts the user's comment on a GitHub issue (X66).
pub const GH_ISSUE_COMMENT: &str = "gh.issue_comment";
/// `{}` → the GitHub login `gh` is signed in as on this host (X44 GitHub connection).
pub const GH_WHOAMI: &str = "gh.whoami";
pub const GH_PR_STATUS: &str = "gh.pr_status";
pub const GH_PR_STACK: &str = "gh.pr_stack";

// Files
pub const FS_LIST: &str = "fs.list";
pub const FS_FILES: &str = "fs.files";
pub const FS_READ: &str = "fs.read";
pub const FS_WRITE: &str = "fs.write";
/// Like `fs.write`, but the file stays inside a folder, never through a symlink (X38).
pub const FS_WRITE_INSIDE: &str = "fs.write_inside";
pub const FS_WATCH: &str = "fs.watch";
pub const FS_UNWATCH: &str = "fs.unwatch";

// Design systems (X64)
/// `{workspace}` → the workspace's design systems.
pub const DESIGN_SYSTEMS: &str = "design.systems";
/// [`DesignSystemCreate`] → `{slug, agent, agent_error}`: the new system,
/// and the chat of the sync agent it starts (or why it could not start).
pub const DESIGN_SYSTEM_CREATE: &str = "design.system.create";
/// [`DesignSystemRef`] → `{agent}`: asks the system's sync agent to sync it
/// again, starting one when it has none.
pub const DESIGN_SYSTEM_SYNC: &str = "design.system.sync";
/// [`DesignSystemRef`]: deletes a design system.
pub const DESIGN_SYSTEM_REMOVE: &str = "design.system.remove";
/// [`DesignProgress`]: what the sync agent reports as it goes.
pub const DESIGN_SYSTEM_PROGRESS: &str = "design.system.progress";
/// [`DesignSystemRef`]: the sync is done; records each source's `HEAD` and writes the anchor.
pub const DESIGN_SYSTEM_SYNCED: &str = "design.system.synced";
/// [`DesignCheck`] → every problem, after rewriting the generated files.
/// With `render`, `{problems, render: {total, bad, thin, variants_identical}}`
/// once the app has rendered every card (X64). With `design`, a workspace
/// design's pages: their `data-mid`s and stylesheets (X65).
pub const DESIGN_CHECK: &str = "design.check";
/// [`DesignSnap`] → `{path, blank}`: a card's screenshot, taken by the app,
/// saved in the system's `.cache/screenshots/` (X64).
pub const DESIGN_SNAP: &str = "design.snap";
/// `{}`: the Mac's moonlet app renders cards for this daemon (X64): the
/// render check and snapshots go to this connection. Only the app may say so.
pub const DESIGN_RENDER_READY: &str = "design.render.ready";
/// [`DesignRenderDone`]: the app's answer to an [`EV_DESIGN_RENDER`] (X64).
pub const DESIGN_RENDER_DONE: &str = "design.render.done";
/// How long the app has for one card, from when the daemon sends it (X64).
pub const RENDER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// [`DesignFile`] → `{path, content_type}` of a file under the workspace's design folder.
pub const DESIGN_FILE: &str = "design.file";
/// [`DesignDetect`] → what a folder's UI is built with, such as `["React", "Tailwind"]`.
pub const DESIGN_DETECT: &str = "design.detect";
/// [`DesignSettle`]: the user's choice for a card after a sync.
pub const DESIGN_SETTLE: &str = "design.settle";
/// [`DesignSystemRef`] → a design system's cards, each with its marker, check
/// problems and the sources changed since the last sync.
pub const DESIGN_CARDS: &str = "design.cards";

// Designs (X65)
/// `{workspace}` → the workspace's designs, each with its pages and its agent.
pub const DESIGN_LIST: &str = "design.list";
/// [`DesignCreate`] → the new workspace design, with `agent_error` (why its
/// agent did not start, or null): its folder made and its agent started.
pub const DESIGN_CREATE: &str = "design.create";
/// [`DesignRef`]: stops a design's agent and deletes its folder.
pub const DESIGN_REMOVE: &str = "design.remove";
/// [`DesignRef`]: asks the app to show a design, as [`EV_DESIGN_OPEN`].
pub const DESIGN_OPEN: &str = "design.open";
/// [`DesignViewport`]: saves the viewport a design was last shown at in its
/// `design.toml` (X65 entry 7).
pub const DESIGN_VIEWPORT: &str = "design.viewport";
/// [`DesignRef`] → the design's comments, by number (X65 entry 8).
pub const DESIGN_COMMENTS: &str = "design.comments";
/// [`DesignCommentPut`] → the pins it changed: a new one numbered after the
/// highest, pin `n`'s comment (not sent any more when it changed), or the
/// pins sent now.
pub const DESIGN_COMMENT_PUT: &str = "design.comment.put";
/// [`DesignCommentRef`] → the pin, resolved.
pub const DESIGN_COMMENT_RESOLVE: &str = "design.comment.resolve";
/// [`DesignPageRef`] → [`DesignPageText`]: a design's page and its version,
/// for the visual editor (X65 entry 9), and its first parse error, for the
/// canvas's "did not load" bar (entry 13).
pub const DESIGN_PAGE: &str = "design.page";
/// [`DesignWritePage`] → [`DesignPageWritten`]: the page replaced with the
/// editor's text, only over `base_version`; else the error `stale`.
pub const DESIGN_WRITE_PAGE: &str = "design.write_page";
/// [`DesignRef`] → [`DesignKit`]: what the visual editor builds a design with
/// from its own design system, its tokens and the cards that hold snippets
/// (X65 entry 10).
pub const DESIGN_KIT: &str = "design.kit";
/// [`DesignRef`] → the design's snapshots, newest first:
/// [`crate::types::DesignSnapshot`]s (X65 entry 11).
pub const DESIGN_HISTORY: &str = "design.history";
/// [`DesignRef`] of a session design → [`DesignSystemUpdated`]: both
/// copies of its design system replaced by the system as it is now, its
/// anchor recorded, and the cards that changed (X65 entry 12).
pub const DESIGN_SYSTEM_UPDATE: &str = "design.system.update";
/// [`DesignCopy`] → [`crate::types::DesignCreated`]: a project design
/// copied into a new workspace design, whose agent starts (X65 entry 12).
pub const DESIGN_COPY: &str = "design.copy";
/// [`DesignSnapshotRef`] → the **Restored snapshot** entry: snapshot `n`
/// made the design's `pages/` and `assets/`. Refused with `busy` while the
/// design's agent works.
pub const DESIGN_SNAPSHOT_RESTORE: &str = "design.snapshot.restore";

// Phones (X39)
/// Phone access, the Tailscale addresses and the paired phones: [`MobileStatus`].
pub const MOBILE_STATUS: &str = "mobile.status";
pub const MOBILE_SET_ENABLED: &str = "mobile.set_enabled";
/// A one-time pairing code and its link: [`MobilePairing`].
pub const MOBILE_PAIR_START: &str = "mobile.pair_start";
pub const MOBILE_PAIR_CANCEL: &str = "mobile.pair_cancel";
pub const MOBILE_REVOKE: &str = "mobile.revoke";
/// The SSH hosts a phone can reach through this daemon: [`MobileHost`]s.
pub const MOBILE_HOSTS: &str = "mobile.hosts";
/// A paired device removes itself (X57); only on its own tailnet connection.
pub const MOBILE_UNPAIR: &str = "mobile.unpair";
pub const EV_MOBILE_CHANGED: &str = "mobile.changed";
/// A phone paired with the current code: `{ device }`.
pub const EV_MOBILE_PAIRED: &str = "mobile.paired";
/// The current code stopped working without a pairing: `{ reason }`.
pub const EV_MOBILE_PAIR_ENDED: &str = "mobile.pair_ended";

// Workers and their central host (X41)
/// This Mac's link to its central host, without the token: [`LinkInfo`].
pub const LINK_GET: &str = "link.get";
/// [`LinkSet`] → [`LinkInfo`].
pub const LINK_SET: &str = "link.set";
/// Retries a link that waits for the user (`needs_update`, `error`).
pub const LINK_RETRY: &str = "link.retry";
/// Pairs this machine with a central host using its pairing code, and
/// makes it the central host (X61): [`LinkPair`] → [`LinkInfo`].
pub const LINK_PAIR: &str = "link.pair";
/// A worker introduces itself to its central host: [`WorkerRegister`].
pub const WORKER_REGISTER: &str = "worker.register";
/// The central host's linked workers: [`WorkerInfo`]s.
pub const WORKER_LIST: &str = "worker.list";
/// Sent by the central host to a worker, every 10 s.
pub const WORKER_PING: &str = "worker.ping";
/// [`LinkInfo`], on every change of the link's settings or state.
pub const EV_LINK_CHANGED: &str = "link.changed";
/// [`WorkerInfo`]s, when a worker registers or goes away.
pub const EV_WORKERS_CHANGED: &str = "workers.changed";

// Live copies of sessions on the central host (X60)
/// [`SyncStart`] → [`Copy`]: keep a session on the central host in sync
/// with this Mac. Asked of this Mac's own daemon.
pub const SYNC_START: &str = "sync.start";
/// This Mac's [`Copy`]s.
pub const SYNC_LIST: &str = "sync.list";
/// [`CopyRef`]: a paused copy tries again.
pub const SYNC_RETRY: &str = "sync.retry";
/// Worker to central host: [`SyncOpen`] → [`SyncOpened`].
pub const SYNC_OPEN: &str = "sync.open";
/// Worker to central host: [`SyncFetch`] → [`SyncFetched`], the session's
/// files and commits as they are now.
pub const SYNC_FETCH: &str = "sync.fetch";
/// Central host to worker: [`SyncUpdate`] → [`SyncUpdated`].
pub const SYNC_UPDATE: &str = "sync.update";
/// Worker to central host: [`SyncOffer`] → [`SyncOffered`], the copy's
/// changes, which the central host reconciles with its own.
pub const SYNC_OFFER: &str = "sync.offer";
/// [`SyncResolve`] → [`Copy`]: one side's version of a differing path goes
/// to both. Asked of this Mac's own daemon.
pub const SYNC_RESOLVE: &str = "sync.resolve";
/// [`CopyRef`]: a diverged copy's branch moves to the central host's
/// commit, and this Mac's commits stay on `<branch>-this-mac`. Returns the
/// [`Copy`].
pub const SYNC_USE_CENTRAL_BRANCH: &str = "sync.use_central_branch";
/// [`CopyRef`]: stops keeping a copy in sync and removes it from this Mac,
/// saving what would be lost first. Returns [`SyncStopped`].
pub const SYNC_STOP: &str = "sync.stop";
/// [`CopyRef`], worker to central host: the worker no longer keeps the copy.
pub const SYNC_CLOSE: &str = "sync.close";
/// [`SyncClosing`], central host to worker: the session is going away.
pub const SYNC_CLOSING: &str = "sync.closing";
/// [`SyncRunSetup`] → [`Copy`]: approves the copy's setup command and runs
/// it. Refused with `setup_changed`, whose message is the current command,
/// when the copy's setup is no longer `command`. Only the Mac's app asks.
pub const SYNC_RUN_SETUP: &str = "sync.run_setup";
/// [`CopyRef`] → [`Copy`]: the copy's setup is not run.
pub const SYNC_SKIP_SETUP: &str = "sync.skip_setup";
/// [`SyncProject`] → [`ProjectSync`]: this Mac's choices for a project on
/// the central host.
pub const SYNC_PROJECT_GET: &str = "sync.project_get";
/// [`SyncProjectSet`] → [`ProjectSync`]: keep the project's new sessions on
/// the central host in sync with this Mac, or stop doing so.
pub const SYNC_PROJECT_SET: &str = "sync.project_set";
/// [`SyncStart`] → `true`: the session gets no copy, even when its project
/// keeps new sessions in sync; the composer's unticked checkbox.
pub const SYNC_DECLINE: &str = "sync.decline";
/// [`HeavyGet`] → [`HeavyInfo`]: a project's heavy commands and what the
/// user approved of them (X62).
pub const HEAVY_GET: &str = "heavy.get";
/// [`HeavySet`] → [`HeavyInfo`]: writes `[heavy]` in the project's
/// `.moonlet/config.toml`. Never approves.
pub const HEAVY_SET: &str = "heavy.set";
/// [`HeavyApprove`] → [`HeavyInfo`]: approves exactly these commands and
/// `env` names, as the config has them now. The Mac's app or a paired Mac.
pub const HEAVY_APPROVE: &str = "heavy.approve";
/// [`ExecRoute`] → [`ExecRouted`]: whether an agent's Bash call may run on
/// another machine (X62).
pub const EXEC_ROUTE: &str = "exec.route";
/// [`ExecRun`] → [`ExecRunStarted`]: runs a heavy command for `moonlet
/// exec` (X62). Its output follows as [`crate::Frame::RunOutput`] frames,
/// then [`EV_EXEC_EXITED`], on the same connection.
pub const EXEC_RUN: &str = "exec.run";
/// [`ExecCancel`] → `true`: stops a run this connection started.
pub const EXEC_CANCEL: &str = "exec.cancel";
/// [`ExecExited`]: a run of this connection ended.
pub const EV_EXEC_EXITED: &str = "exec.exited";
/// Central host to worker, [`ExecPrepare`] → [`ExecPrepared`]: the
/// worker's routing copy of a session, made if it has none (X62).
pub const EXEC_PREPARE: &str = "exec.prepare";
/// Central host to worker, [`ExecStart`] → `true`: runs a command in a
/// routing copy that is at the fence's tree and commit. Its output comes
/// back as `RunOutput` frames, then [`EXEC_DONE`].
pub const EXEC_START: &str = "exec.start";
/// Worker to central host, [`ExecDone`] → [`ExecBrought`]: a run ended;
/// its changes travel in a pack.
pub const EXEC_DONE: &str = "exec.done";
/// `{}` → [`ExecStatus`]: this machine as a worker, the routed commands
/// going on and why workers were skipped, for the Workers page (X62).
pub const EXEC_STATUS: &str = "exec.status";
/// `{}` → [`CloudInfo`]: the central host's cloud workers settings, with
/// no secret in them (X63).
pub const CLOUD_GET: &str = "cloud.get";
/// [`CloudSet`] → [`CloudInfo`]: changes the settings; the app or a paired
/// desktop only.
pub const CLOUD_SET: &str = "cloud.set";
/// [`CloudTypes`] → `[MachineType]`: a provider's machine types at a location.
pub const CLOUD_TYPES: &str = "cloud.types";
/// `{}` → [`CloudMachines`]: the central host's cloud machines, those
/// removed in the last hour and the month's usage.
pub const CLOUD_MACHINES: &str = "cloud.machines";
/// [`CloudUp`] → [`CloudMachine`]: starts a machine for a project.
pub const CLOUD_UP: &str = "cloud.up";
/// [`CloudDown`] → `true`: removes a machine once its commands end.
pub const CLOUD_DOWN: &str = "cloud.down";
/// `{}` → `true` once the OAuth client made a test key and revoked it; the
/// error says why it could not. App or paired desktop only.
pub const CLOUD_CHECK: &str = "cloud.check";
/// [`CloudMachines`]: a machine changed.
pub const EV_CLOUD_CHANGED: &str = "cloud.changed";
/// [`LinkJoin`] → [`LinkInfo`]: a cloud machine pairs with its central host
/// with a join code and takes heavy commands (`moonletd join`).
pub const LINK_JOIN: &str = "link.join";
/// Worker → central host, [`WorkerStep`]: a startup step of a cloud machine.
pub const WORKER_STEP: &str = "worker.step";
/// Central host → worker, `{}`: the machine is being removed; it leaves the
/// tailnet.
pub const WORKER_RETIRE: &str = "worker.retire";
/// `{}` → `[ExecSetup]`: this Mac's routing copies whose setup waits for
/// the user's approval, for an app that starts after it was asked (X62).
pub const EXEC_SETUPS: &str = "exec.setups";
/// [`ExecSetup`]: a routing copy's setup waits for the user's approval.
pub const EV_EXEC_SETUP: &str = "exec.setup";
/// [`JobList`] → `[Job]`: a session's jobs, newest first (X62).
pub const JOB_LIST: &str = "job.list";
/// [`JobOutputGet`] → [`JobOutput`]: a job's stored output from a byte.
pub const JOB_OUTPUT: &str = "job.output";
/// [`JobRef`] → `true`: stops a running job; the agent gets exit 143.
pub const JOB_STOP: &str = "job.stop";
/// [`JobList`] → the number stopped: every running job of a session.
pub const JOB_STOP_ALL: &str = "job.stop_all";
/// [`JobRef`] → `true`: a job waiting for a cloud machine runs on the
/// central host now (X63); `not_waiting` otherwise.
pub const JOB_RUN_HERE: &str = "job.run_here";
/// [`Job`]: a job changed.
pub const EV_JOB_CHANGED: &str = "job.changed";
/// [`JobOutputEvent`]: a running job's new output.
pub const EV_JOB_OUTPUT: &str = "job.output";
/// A [`CopyChanged`], on every change of a copy's state.
pub const EV_SYNC_CHANGED: &str = "sync.changed";
/// `{workspace, system, design, paths}`: files changed in a design system,
/// in a workspace design (`design`, X65), or in a workspace's other design
/// files (both `null`) (X64).
pub const EV_DESIGN_CHANGED: &str = "design.changed";
/// [`DesignRender`]: render a card, sent only to the connection of the app
/// that said [`DESIGN_RENDER_READY`] (X64).
pub const EV_DESIGN_RENDER: &str = "design.render";
/// [`DesignOpened`]: show this design (X65); from an agent's `design new`, a
/// toast that leaves the focus where it is.
pub const EV_DESIGN_OPEN: &str = "design.open";

// Events
pub const EV_TERMINAL_CREATED: &str = "terminal.created";
pub const EV_TERMINAL_UPDATED: &str = "terminal.updated";
pub const EV_TERMINAL_EXITED: &str = "terminal.exited";
pub const EV_TERMINAL_REMOVED: &str = "terminal.removed";
/// A [`ReadRequest`] waits for the user (X31).
pub const EV_TERMINAL_READ_REQUEST: &str = "terminal.read_request";
/// A read request was answered, withdrawn or timed out: [`ReadDone`].
pub const EV_TERMINAL_READ_DONE: &str = "terminal.read_done";
/// A session's standing permission to read changed: [`ReadGrant`].
pub const EV_TERMINAL_READ_GRANT: &str = "terminal.read_grant";
/// Sent to one client whose output queue overflowed: it was detached from
/// the terminal and must attach again for a fresh snapshot.
pub const EV_TERMINAL_RESYNC: &str = "terminal.resync";
pub const EV_AGENT_ATTENTION: &str = "agent.attention";
pub const EV_PROJECTS_CHANGED: &str = "projects.changed";
pub const EV_SESSIONS_CHANGED: &str = "sessions.changed";
pub const EV_WORKSPACES_CHANGED: &str = "workspaces.changed";
pub const EV_SECTIONS_CHANGED: &str = "sections.changed";
pub const EV_PROFILES_CHANGED: &str = "profiles.changed";
/// A host's Git settings after a change: the whole `GitSettings` (X55).
pub const EV_GIT_SETTINGS_CHANGED: &str = "git.settings_changed";
/// A line `claude update` printed (X36).
pub const EV_CLAUDE_UPDATE_OUTPUT: &str = "claude.update_output";
/// How a `claude update` ended, for every window (X36).
pub const EV_CLAUDE_UPDATE_DONE: &str = "claude.update_done";
/// How far a clone is: a `CloneProgress` (X59).
pub const EV_REPO_CLONE_PROGRESS: &str = "repo.clone_progress";
/// How a clone ended: a `CloneDone` (X59).
pub const EV_REPO_CLONE_DONE: &str = "repo.clone_done";
pub const EV_FS_CHANGED: &str = "fs.changed";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalCreate {
    pub cwd: String,
    /// argv; empty means the user's login shell.
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub kind: TerminalKind,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, alias = "workspace_id")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    /// Run `agent` headless with the structured view (X6) instead of its TUI.
    #[serde(default)]
    pub chat: bool,
    /// Start a shell with its own prompt instead of Blocks mode (T7).
    #[serde(default)]
    pub classic: bool,
    /// Model and effort for a structured agent.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Claude permission mode (X7).
    #[serde(default)]
    pub mode: Option<String>,
    /// Extra directories a structured agent may work in (X29).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_dirs: Vec<String>,
}

impl Default for TerminalCreate {
    fn default() -> Self {
        Self {
            cwd: String::new(),
            command: Vec::new(),
            env: BTreeMap::new(),
            cols: default_cols(),
            rows: default_rows(),
            kind: TerminalKind::default(),
            title: None,
            session_id: None,
            agent: None,
            chat: false,
            classic: false,
            model: None,
            effort: None,
            mode: None,
            add_dirs: Vec::new(),
        }
    }
}

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalRef {
    pub id: TerminalId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalAttach {
    pub id: TerminalId,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

/// Reply to `session.attach`. `snapshot` is an escape-sequence stream that
/// redraws scrollback, screen, cursor and modes on a freshly reset terminal.
/// Live output frames for the session follow the response on the same
/// connection, with nothing lost or duplicated in between.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachResult {
    pub info: crate::types::TerminalInfo,
    pub snapshot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalResize {
    pub id: TerminalId,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalKill {
    pub id: TerminalId,
    /// When true the session record is removed after the process exits.
    #[serde(default)]
    pub remove: bool,
}

/// Text input over JSON, for scripts and the CLI (`moonlet pane run`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalWrite {
    pub id: TerminalId,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSearch {
    pub id: TerminalId,
    pub query: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    /// Line index counted from the oldest scrollback line.
    pub line: usize,
    pub text: String,
}

/// `terminal.read` (X31). `caller` is the reading terminal; the daemon
/// takes its session from it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalRead {
    pub caller: TerminalId,
    pub id: TerminalId,
    #[serde(default)]
    pub lines: Option<usize>,
}

/// What `terminal.read` returns: the text the user allowed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadResult {
    pub terminal: TerminalId,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<i32>,
    pub running: bool,
    /// Earlier output was left out.
    pub truncated: bool,
    /// Lines of output in `text`, without the `$ <command>` line or a note
    /// about omitted lines.
    #[serde(default)]
    pub lines: usize,
    pub text: String,
}

/// A read waiting for the user's answer; the `text` is exactly what the
/// agent gets on Allow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadRequest {
    pub request_id: u64,
    pub session_id: String,
    pub caller: TerminalId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub terminal_id: TerminalId,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<i32>,
    pub lines: usize,
    pub text: String,
    /// When the agent asked (ms), for "waiting 2m" (X40).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asked_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadAnswer {
    pub request_id: u64,
    pub allow: bool,
    /// Allow every later read in the session without asking.
    #[serde(default)]
    pub remember: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadDone {
    pub request_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadGrantClear {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadGrant {
    pub session_id: String,
    pub granted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentReport {
    pub terminal: TerminalId,
    pub state: AgentState,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default = "default_source")]
    pub source: StateSource,
    #[serde(default)]
    pub agent: Option<String>,
}

fn default_source() -> StateSource {
    StateSource::Hook
}

/// Emitted when a session needs the user (blocked, done or error).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attention {
    pub terminal: TerminalId,
    #[serde(alias = "workspace_id")]
    pub session_id: Option<String>,
    pub state: AgentState,
    pub title: String,
    pub message: Option<String>,
    /// From a design system's sync agent (X64), which the app notifies for
    /// in Design mode, never as a session's agent, or a design's agent, which
    /// notifies like a session's (X65).
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "crate::types::design_tag")]
    pub design: Option<crate::types::DesignAgent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectAdd {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdRef {
    pub id: String,
}

/// Writes a project's `.moonlet/config.toml` (X8).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSetConfig {
    pub id: String,
    /// The `version` from `project.config_file`; a mismatch means the file
    /// changed on disk since, and nothing is written.
    pub version: String,
    pub config: ProjectConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCreate {
    pub project_id: String,
    /// Display name; derived from the prompt's first line when absent.
    #[serde(default)]
    pub name: Option<String>,
    /// New branch name; derived from `name` when absent.
    #[serde(default)]
    pub branch: Option<String>,
    /// Start point: a branch, tag or commit. Defaults to the repo base branch.
    #[serde(default)]
    pub from: Option<String>,
    /// Use an existing branch instead of creating one.
    #[serde(default)]
    pub existing_branch: bool,
    #[serde(default)]
    pub agent: Option<String>,
    /// First prompt passed to the agent.
    #[serde(default)]
    pub prompt: Option<String>,
    /// Model alias for the agent (e.g. `sonnet`, `opus`).
    #[serde(default)]
    pub model: Option<String>,
    /// Effort level (`low` … `max`).
    #[serde(default)]
    pub effort: Option<String>,
    /// Claude permission mode (X7).
    #[serde(default)]
    pub mode: Option<String>,
    /// Start from this pull request's branch.
    #[serde(default)]
    pub pr: Option<u64>,
    /// Run the agent in its own terminal UI instead of the structured view
    /// (Claude Code and Codex default to the structured view, X6).
    #[serde(default)]
    pub tui: bool,
    /// Send its heavy commands to the project's cloud machine first (X63).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cloud: bool,
    /// The terminal of the agent asking for this session (X22). The new
    /// session records that terminal's session as its parent and starts in a
    /// permission mode no more permissive than the parent's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawned_by: Option<TerminalId>,
    /// Extra directories the agent may work in from the start (X29).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_dirs: Vec<String>,
    /// The workspace to create the session in (X32). Absent: the spawning
    /// agent's workspace, else the first workspace holding the project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// The tracker issue the session starts from (X46).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<crate::types::TaskRef>,
    /// Adopt this existing work tree of the project, and its branch,
    /// instead of making a new one (X46).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// A workspace design to build (X65 Build it): copied into the new
    /// worktree as a session design before the agent starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design: Option<SessionDesignPick>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

/// The workspace design a new session builds, and its pages kept (X65).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionDesignPick {
    pub workspace: String,
    pub slug: String,
    /// Its pages to copy (`index` for `pages/index.html`).
    pub pages: Vec<String>,
}

impl SessionCreate {
    /// A request for `project_id` with every option at its default.
    pub fn new(project_id: impl Into<String>) -> Self {
        Self {
            project_id: project_id.into(),
            name: None,
            branch: None,
            from: None,
            existing_branch: false,
            agent: None,
            prompt: None,
            model: None,
            effort: None,
            mode: None,
            pr: None,
            tui: false,
            cloud: false,
            spawned_by: None,
            add_dirs: Vec::new(),
            workspace_id: None,
            task: None,
            worktree: None,
            design: None,
            cols: default_cols(),
            rows: default_rows(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionArchive {
    pub id: String,
    /// Remove the worktree directory (branch is kept).
    #[serde(default = "yes")]
    pub remove_worktree: bool,
    #[serde(default)]
    pub delete_branch: bool,
    /// With `delete_branch`, delete it on origin too (X55). A failure there
    /// is reported, not fatal.
    #[serde(default)]
    pub delete_remote: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionUpdate {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub layout: Option<serde_json::Value>,
    /// Absent: leave the task link alone. A task: link to it. `null`: unlink,
    /// and stop linking from the branch name or PR too (X46).
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub task: Option<Option<crate::types::TaskRef>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceCreate {
    pub name: String,
    pub color: crate::types::WorkspaceColor,
    /// Sections to move into the new workspace from the ones they are in.
    #[serde(default)]
    pub move_sections: Vec<String>,
    /// The Claude profile its sessions use (X33); absent for the default.
    #[serde(default)]
    pub claude_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceUpdate {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<crate::types::WorkspaceColor>,
    /// The workspace's sections in their new order. It must keep the
    /// workspace's own; sections of other workspaces listed here move in.
    #[serde(default)]
    pub section_ids: Option<Vec<String>>,
    /// Absent: unchanged; `null`: the default profile; else a profile id (X33).
    #[serde(default, deserialize_with = "present")]
    pub claude_profile: Option<Option<String>>,
}

/// Tells a field sent as `null` (`Some(None)`) from one left out (`None`).
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileCreate {
    pub name: String,
    /// An existing or new folder; `~/.claude-<name>` when absent.
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileUpdate {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// `id` absent: the default profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileStatus {
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionCreate {
    pub workspace_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionUpdate {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub project_ids: Option<Vec<String>>,
    #[serde(default)]
    pub view: Option<crate::types::SectionView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionAddProject {
    pub id: String,
    pub path: String,
}

/// A GitHub repository as `owner/name`, and the SSH address the user
/// typed for it, if any (X59).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoRef {
    pub repo: String,
    #[serde(default)]
    pub ssh: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoCloneTarget {
    pub repo: String,
    pub parent: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoClone {
    /// Chosen by the app, so it can tell the clone's events from the start.
    pub id: String,
    pub repo: String,
    #[serde(default)]
    pub ssh: Option<String>,
    pub parent: String,
    pub name: String,
    /// The section the new project joins; none: the default section.
    #[serde(default)]
    pub section_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionRemoveProject {
    pub id: String,
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionMove {
    pub id: String,
    pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRun {
    pub id: String,
    /// `run`, `setup` or `archive`.
    pub script: String,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhProjects {
    /// Users and organisations whose Projects to list besides the user's.
    #[serde(default)]
    pub owners: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhProjectItems {
    pub owner: String,
    pub number: u64,
    #[serde(default)]
    pub mine: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhCreateOptions {
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhIssueCreate {
    pub repo: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub assignee: String,
    #[serde(default)]
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhProjectAdd {
    pub project: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhProjectMove {
    pub project: String,
    pub item: String,
    pub field: String,
    /// The Status option; none clears the Status.
    #[serde(default)]
    pub option: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhTasks {
    /// Any directory inside the repository.
    pub path: String,
    #[serde(default)]
    pub mine: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhTaskGet {
    /// Any directory inside a repository, for `gh`'s host and sign-in.
    pub path: String,
    /// `owner/name`.
    pub repo: String,
    pub number: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectWorktree {
    /// The project.
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhPrContext {
    /// Any directory inside the repository.
    pub path: String,
    pub number: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhIssueComments {
    /// Any directory inside the repository.
    pub path: String,
    pub number: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhIssueComment {
    /// Any directory inside the repository.
    pub path: String,
    pub number: u64,
    /// Markdown; it reaches gh on stdin.
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhTaskUpdate {
    /// Any directory inside the repository.
    pub path: String,
    pub number: u64,
    #[serde(default)]
    pub assign_me: bool,
    #[serde(default)]
    pub close: bool,
    #[serde(default)]
    pub reopen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitPath {
    /// Any directory inside the work tree.
    pub path: String,
    /// Diff base: a ref, or absent for HEAD.
    #[serde(default)]
    pub base: Option<String>,
}

/// `git.unpushed` and `git.push` (X55).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitUnpushed {
    /// The session's worktree.
    pub path: String,
    /// The session's branch, which archiving deletes; absent for the
    /// checked-out one.
    #[serde(default)]
    pub branch: Option<String>,
    /// The head commit of the branch's merged PR, which GitHub keeps.
    #[serde(default)]
    pub merged_head: Option<String>,
}

/// `git.base_status` and `git.pull_base` (spec X13).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBase {
    pub path: String,
    pub branch: String,
    /// `git.base_status` only: fetch `origin/<branch>` first.
    #[serde(default)]
    pub fetch: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFile {
    pub path: String,
    pub file: String,
    #[serde(default)]
    pub base: Option<String>,
    /// For `git.diff`: index vs HEAD instead of working tree vs base.
    #[serde(default)]
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFiles {
    pub path: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitApplyPatch {
    pub path: String,
    pub patch: String,
    /// Apply to the index (stage) instead of the work tree.
    #[serde(default)]
    pub cached: bool,
    #[serde(default)]
    pub reverse: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommit {
    pub path: String,
    pub message: String,
    /// Stage every change first (`git add -A`).
    #[serde(default)]
    pub all: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrCreate {
    pub path: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub draft: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrStackParams {
    pub path: String,
    pub number: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsList {
    pub path: String,
    #[serde(default)]
    pub show_ignored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsFiles {
    pub root: String,
    #[serde(default = "default_file_limit")]
    pub limit: usize,
}

fn default_file_limit() -> usize {
    20_000
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsRead {
    pub path: String,
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignWorkspace {
    pub workspace: String,
}

/// One project a design system is built from, and the folder of it it covers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignSourcePick {
    pub project: String,
    #[serde(default)]
    pub subdir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignSystemCreate {
    pub workspace: String,
    pub name: String,
    pub sources: Vec<DesignSourcePick>,
    /// What to cover: `core` (the default), `all` or `none`.
    #[serde(default)]
    pub cover: Option<String>,
    /// Start the sync agent (the default).
    #[serde(default = "start_agent")]
    pub agent: bool,
}

fn start_agent() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignSystemRef {
    pub workspace: String,
    pub slug: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignProgress {
    pub workspace: String,
    pub slug: String,
    pub step: String,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignCheck {
    /// The design system's workspace; none when `design` names a design.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// The design system; empty when `design` names a design.
    #[serde(default)]
    pub slug: String,
    /// Also render each card in the app and judge it (`--render`).
    #[serde(default)]
    pub render: bool,
    /// A design to check instead of a design system (X65), a workspace's
    /// or a session's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design: Option<DesignRef>,
    /// With `design`: first give the missing and repeated `data-mid`s the
    /// next free numbers (`--fix`).
    #[serde(default)]
    pub fix: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignSnap {
    pub workspace: String,
    pub slug: String,
    /// The card's path in the system, such as `components/buttons/button/button.html`.
    pub path: String,
    /// Width and height; the card's own viewport when absent.
    #[serde(default)]
    pub viewport: Option<(u32, u32)>,
    /// Show only this variant: a snippet's id, or its last part.
    #[serde(default)]
    pub variant: Option<String>,
}

/// What the app is asked for a card (X64).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenderWant {
    /// The rubric's flags, from what the card measured of itself.
    Metrics,
    /// A screenshot.
    Png,
}

/// What the app is asked to render (event [`EV_DESIGN_RENDER`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesignRender {
    pub id: u64,
    pub workspace: String,
    /// The design system.
    pub slug: String,
    /// The card's path in the system, such as `components/buttons/button/button.html`.
    pub path: String,
    pub viewport: (u32, u32),
    /// The snippet shown alone, by its full id.
    pub variant: Option<String>,
    pub want: RenderWant,
}

/// The rubric's verdict on a rendered card.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RenderMetrics {
    /// The flags it raised, such as `rootEmpty` and `bad`.
    pub flags: Vec<String>,
    /// Its page errors.
    #[serde(default)]
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignRenderDone {
    pub id: u64,
    #[serde(default)]
    pub metrics: Option<RenderMetrics>,
    /// The screenshot, a PNG.
    #[serde(default)]
    pub png_base64: Option<String>,
    /// Why the card could not be rendered.
    #[serde(default)]
    pub error: Option<String>,
}

impl DesignRenderDone {
    /// The rubric's verdict, or why the app has none.
    pub fn metrics(self) -> Result<RenderMetrics, String> {
        match (self.error, self.metrics) {
            (Some(e), _) => Err(e),
            (None, Some(m)) => Ok(m),
            (None, None) => Err("the app measured nothing".into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignFile {
    /// A file of this workspace's design folder; or, with `session`, of
    /// that session's worktree's design folder (X65).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// Alone: a file of that project's designs on its base branch, read
    /// from git's objects, given as its bytes (X65 entry 12c).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Relative to the workspace's design folder, such as
    /// `systems/<slug>/styles.css`; or to the worktree's or the project's,
    /// such as `settings-page/pages/index.html`.
    pub path: String,
}

/// A new workspace design (X65).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignCreate {
    pub workspace: String,
    pub name: String,
    /// The design system's slug.
    pub system: String,
    #[serde(default)]
    pub brief: String,
    /// A session design in that session's worktree, which the session's
    /// agent writes: no agent of its own starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// The terminal of the agent that asked for it (X22): the app shows a
    /// toast instead of switching to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawned_by: Option<TerminalId>,
}

/// A design (X65): a workspace design by its workspace and slug, a session
/// design by its session and slug. Written as the fields beside the others
/// of a call, so `{workspace, slug}` reads as it always did. Read once, by
/// [`DesignRef::try_from`]: a call naming both a workspace and a session, or
/// neither, is refused, so it can never pass as one and act on the other.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged, try_from = "DesignFields")]
pub enum DesignRef {
    Session { session: String, slug: String },
    Workspace { workspace: String, slug: String },
}

/// The fields a design is named by, as a call gives them.
#[derive(Debug, Clone, Deserialize)]
pub struct DesignFields {
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub session: Option<String>,
    pub slug: String,
}

impl TryFrom<DesignFields> for DesignRef {
    type Error = String;

    fn try_from(f: DesignFields) -> Result<Self, String> {
        match (f.workspace, f.session) {
            (Some(workspace), None) => Ok(DesignRef::Workspace { workspace, slug: f.slug }),
            (None, Some(session)) => Ok(DesignRef::Session { session, slug: f.slug }),
            (Some(_), Some(_)) => Err("name a design by its workspace or by its session, not both".into()),
            (None, None) => Err("name a design by its workspace or by its session".into()),
        }
    }
}

impl DesignRef {
    pub fn slug(&self) -> &str {
        match self {
            DesignRef::Session { slug, .. } | DesignRef::Workspace { slug, .. } => slug,
        }
    }
}

/// [`DESIGN_VIEWPORT`]'s params: the design and its viewport, `WxH` in px.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignViewport {
    #[serde(flatten)]
    pub design: DesignRef,
    pub viewport: String,
}

/// [`DESIGN_COMMENT_PUT`]'s params: the design, and what to change, as
/// `new`, `edit` or `sent` beside them (X65).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignCommentPut {
    #[serde(flatten)]
    pub design: DesignRef,
    #[serde(flatten)]
    pub change: crate::types::CommentChange,
}

/// A design's page (X65): `index` for `pages/index.html`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignPageRef {
    #[serde(flatten)]
    pub design: DesignRef,
    pub page: String,
}

/// A design's page as the editor reads it: its text and version, the
/// SHA-256 of the text in hex.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesignPageText {
    pub html: String,
    pub version: String,
    /// Where the page first goes wrong as HTML, if it does: what the canvas
    /// says of a page that did not load (X65). A browser recovers from it
    /// and reports nothing, so the app shows it only for a page that did
    /// not load, never for one that did.
    #[serde(default)]
    pub parse_error: Option<DesignParseError>,
}

/// A page's first parse error: its line, 1-based, and what is wrong.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesignParseError {
    pub line: u32,
    pub message: String,
}

/// [`DESIGN_WRITE_PAGE`]'s params: the page's new text, and the version it
/// was edited from.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignWritePage {
    #[serde(flatten)]
    pub design: DesignRef,
    pub page: String,
    pub html: String,
    pub base_version: String,
    /// What each edit by hand this save carries did, such as `moved
    /// section m24`, for the summary of the snapshot taken once edits by
    /// hand stop (X65 entry 11); none from an older app.
    #[serde(default)]
    pub edits: Vec<String>,
}

/// [`DESIGN_SNAPSHOT_RESTORE`]'s params: a design's snapshot `n`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignSnapshotRef {
    #[serde(flatten)]
    pub design: DesignRef,
    pub n: u32,
}

/// A page saved: its new version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesignPageWritten {
    pub version: String,
}

/// What a design's visual editor builds with from its design system (X65):
/// the Inspector's tokens and the Palette's snippets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesignKit {
    /// The design system's slug.
    pub system: String,
    /// Its tokens, as the X64 check reads them: in import order, each name
    /// once with its last value.
    pub tokens: Vec<DesignToken>,
    /// Its cards that hold snippets (`data-snippet`), by group then name.
    pub cards: Vec<DesignKitCard>,
}

/// A design system's token (X64): `--space-4: 16px`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesignToken {
    pub name: String,
    pub value: String,
    pub family: TokenFamily,
}

/// A design system token's family (X64), as design-sync's README groups
/// them: by its name first, then by what its value looks like.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenFamily {
    Color,
    Spacing,
    Typography,
    Radius,
    Shadow,
    Other,
}

/// A card of a design system with its HTML, whose snippets the palette inserts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesignKitCard {
    /// Relative to the design system's folder.
    pub path: String,
    pub group: String,
    pub name: String,
    pub html: String,
}

/// A session design's copies of its design system replaced by the system
/// as it is now (X65): the anchor recorded, and the cards that changed since
/// the copy, for the chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesignSystemUpdated {
    /// The design system's sync anchor now; none before its first sync.
    pub anchor: Option<String>,
    /// By path.
    pub cards: Vec<DesignCardChange>,
}

/// A card of a design system that changed since a session design copied
/// it (X65).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesignCardChange {
    /// Relative to the design system's folder.
    pub path: String,
    pub change: CardChange,
}

/// How a card changed since a session design copied its design system (X65).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardChange {
    New,
    Changed,
    Removed,
}

/// [`DESIGN_COPY`]'s params: the project design to start from, and the
/// new workspace design's name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignCopy {
    pub workspace: String,
    pub from: ProjectDesignRef,
    pub name: String,
}

/// A project design: its project, and its folder in the repository, such as
/// `docs/design/settings-page`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDesignRef {
    pub project: String,
    pub path: String,
}

/// One pin of a design (X65).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignCommentRef {
    #[serde(flatten)]
    pub design: DesignRef,
    pub n: u32,
}

/// The event [`EV_DESIGN_OPEN`] (X65).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesignOpened {
    pub workspace: String,
    pub slug: String,
    pub name: String,
    /// The agent's terminal that started the design, and its session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawned_by: Option<TerminalId>,
    /// With `spawned_by`, the agent's session; for a session design, its
    /// session, whose Design tab shows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// `session` for a session design; none for a workspace design.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<crate::types::DesignKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignDetect {
    pub workspace: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignSettle {
    pub workspace: String,
    pub slug: String,
    /// The card's path in the system.
    pub card: String,
    /// `mine`, `synced`, `remove` or `keep`.
    pub choice: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsWrite {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsWriteInside {
    /// The folder the file must stay in, such as a session's worktree.
    pub root: String,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsPath {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsChanged {
    pub root: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HooksInstall {
    #[serde(default = "yes")]
    pub claude: bool,
    #[serde(default = "yes")]
    pub codex: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShellHistory {
    /// `zsh`, `bash` or `fish`; the login shell when absent.
    #[serde(default)]
    pub shell: Option<String>,
}

/// `shell.commands`: names the input editor colours as known commands (T8).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShellCommands {
    /// `zsh`, `bash` or `fish`; the login shell when absent.
    #[serde(default)]
    pub shell: Option<String>,
    /// A shell terminal whose own PATH (as its prompt hook reported it) to
    /// use instead of the login shell's.
    #[serde(default)]
    pub terminal: Option<TerminalId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSetClassic {
    pub id: TerminalId,
    pub classic: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSend {
    pub id: TerminalId,
    pub text: String,
    /// Images sent with the message (X29).
    #[serde(default)]
    pub images: Vec<crate::types::ChatImage>,
}

/// Acts on a chat's MCP servers (X29): `refresh`, `reconnect`, `auth` or
/// `cancel`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMcp {
    pub id: TerminalId,
    pub action: String,
    #[serde(default)]
    pub server: Option<String>,
}

/// A directory the agent may work in from the next message on (X29).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatAddDir {
    pub id: TerminalId,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatPermission {
    pub id: TerminalId,
    pub ask: String,
    /// `allow`, `always` or `deny`.
    pub decision: String,
    #[serde(default)]
    pub message: Option<String>,
    /// Answers to Claude's `AskUserQuestion` (question text → answer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<BTreeMap<String, String>>,
    /// Permission mode an approved plan switches to: `auto` or `acceptEdits` (X20, X24).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatStopAgent {
    pub id: TerminalId,
    /// The subagent's task id.
    pub agent: String,
}

/// `chat.send_now` (X49).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSendNow {
    pub id: TerminalId,
    /// The queued message's id; without it every queued message is sent.
    #[serde(default)]
    pub message: Option<String>,
}

/// `chat.unqueue` (X49).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatUnqueue {
    pub id: TerminalId,
    /// The queued message's id.
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatAside {
    pub id: TerminalId,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSettings {
    pub id: TerminalId,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Claude permission mode, see `ChatState::mode`.
    #[serde(default)]
    pub mode: Option<String>,
}

/// `chat.item` event payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatItemEvent {
    pub id: TerminalId,
    pub item: crate::types::ChatItem,
}

/// `chat.state` event payload: everything except the items.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatStateEvent {
    pub id: TerminalId,
    pub state: crate::types::ChatState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileSetEnabled {
    pub enabled: bool,
}

/// What paired: a phone (X39) or another Mac's app (X57).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    #[default]
    Phone,
    Desktop,
    /// A cloud machine the central host made (X63): worker methods only.
    Cloud,
}

/// A paired device (X39, X57).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MobileDevice {
    pub id: String,
    pub name: String,
    /// Devices paired before X57 are phones.
    #[serde(default)]
    pub kind: DeviceKind,
    pub created_at: u64,
    pub last_seen: Option<u64>,
    pub connected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MobileStatus {
    pub enabled: bool,
    pub port: u16,
    /// The Mac has a Tailscale address.
    pub tailscale: bool,
    /// Its Tailscale addresses.
    pub addresses: Vec<String>,
    /// Where the listener is bound, `ip:port`; empty while off or without Tailscale.
    pub listening: Vec<String>,
    pub host: String,
    pub devices: Vec<MobileDevice>,
}

/// `mobile.pair_start` params: what the code pairs (a phone by default).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MobilePairStart {
    #[serde(default)]
    pub kind: DeviceKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MobilePairing {
    pub code: String,
    /// `moonlet://pair?v=1&host=…&addr=…&code=…`, what the QR code holds.
    pub url: String,
    pub expires_at: u64,
    pub addresses: Vec<String>,
    pub host: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MobileHost {
    pub id: String,
    pub label: String,
}

/// Where a worker's link goes (X41): the central host's label, its tailnet
/// listener's `ip:port` addresses, and the device token this Mac got when it
/// paired with it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkCentral {
    pub name: String,
    pub addrs: Vec<String>,
    pub token: String,
}

/// [`LinkCentral`] as `link.get` shows it: never the token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkCentralInfo {
    pub name: String,
    pub addrs: Vec<String>,
}

/// `link.pair` params: the central host to pair with, and a pairing code
/// from it. The token the pairing gives stays on this machine.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LinkPair {
    pub central: LinkCentralInfo,
    pub code: String,
}

/// This machine as a worker. `id` never changes once made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkWorker {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// How many routed commands this machine runs at once (X62).
    #[serde(default = "default_slots")]
    pub slots: u32,
    /// A cloud machine that joined with `moonletd join` (X63).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cloud: bool,
}

/// A worker's slots unless set (X62).
pub fn default_slots() -> u32 {
    2
}

/// `link.set` params. An absent field stays as it is; `central: null`
/// clears the central host.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct LinkSet {
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub central: Option<Option<LinkCentral>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<LinkWorkerSet>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct LinkWorkerSet {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// From 1 to 64 (X62).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slots: Option<u32>,
}

/// The link's state: `off`, or one of the host statuses of `moonlet-link`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LinkState {
    Off,
    Connecting,
    Connected { since: u64 },
    Reconnecting,
    NeedsUpdate { daemon_version: String },
    /// The central host no longer accepts this Mac: pair it again.
    Refused,
    Error { message: String },
}

/// `link.get`: the settings without the token, and the state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkInfo {
    pub central: Option<LinkCentralInfo>,
    pub worker: LinkWorker,
    pub state: LinkState,
}

/// One of a worker's projects, as its central host sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkerProject {
    pub identity: crate::types::ProjectIdentity,
    pub path: String,
}

/// `worker.register` params, sent again on every link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkerRegister {
    pub id: String,
    pub name: String,
    /// `macos` or `linux`.
    pub os: String,
    /// `arm64` or `x86_64`.
    pub arch: String,
    pub cores: u32,
    pub version: String,
    pub projects: Vec<WorkerProject>,
    /// How many routed commands it runs at once (X62).
    #[serde(default = "default_slots")]
    pub slots: u32,
    /// It takes heavy commands: **Use this Mac for heavy commands** is on.
    /// A worker linked only for live copies does not (X62).
    #[serde(default)]
    pub heavy: bool,
}

/// A linked worker in `worker.list`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkerInfo {
    #[serde(flatten)]
    pub worker: WorkerRegister,
    pub connected_since: u64,
    /// The last `worker.ping` round trip; none before the first.
    pub rtt_ms: Option<u64>,
    /// The 1-minute load average from the last `worker.ping` answer (X62).
    #[serde(default)]
    pub load: Option<f64>,
}

/// `sync.start` params: the session's id on the central host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncStart {
    pub session: String,
}

/// Names one of this Mac's copies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CopyRef {
    pub copy: String,
}

/// Where a copy is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CopyState {
    Copying,
    InSync,
    Syncing { files: u32 },
    /// The link is down; changes made here sync when it is back.
    Waiting,
    /// Waits for `sync.retry`: `reason` is shown after "Paused: ".
    Paused { reason: String },
}

/// The setup script in a copy (X60, "Setup in the copy").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CopySetup {
    pub state: SetupState,
    /// The command, exactly as the copy's `.moonlet/config.toml` has it
    /// now; the one running while it runs.
    pub command: String,
    /// Whether `command` was approved for this project on this central
    /// host, so **Run setup again** asks first when it was not.
    #[serde(default)]
    pub approved: bool,
}

/// Where a copy's setup is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SetupState {
    /// Waits for the user to approve this exact command.
    NeedsApproval,
    Running,
    Done,
    /// It exited with `exit`; -1 when a signal or a restart ended it.
    Failed { exit: i32 },
    Skipped,
}

/// Names a project on the central host by its identity (X41).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncProject {
    pub identity: crate::types::ProjectIdentity,
}

/// `sync.project_set` params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncProjectSet {
    pub identity: crate::types::ProjectIdentity,
    pub keep_new: bool,
}

/// This Mac's choices for a project on the central host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectSync {
    /// New sessions in the project are kept in sync with this Mac.
    pub keep_new: bool,
}

/// `sync.run_setup` params: the command the user approved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncRunSetup {
    pub copy: String,
    pub command: String,
}

/// Commits each side has that the other lacks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Diverged {
    pub ahead: u32,
    pub behind: u32,
}

/// A live copy on this Mac of a session on its central host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Copy {
    pub id: String,
    /// The central host's name, such as `studio-mini`.
    pub host: String,
    /// The session's id on the central host.
    pub session: String,
    /// Where the copy is on this Mac; empty until it is made.
    pub path: String,
    pub state: CopyState,
    pub setup: Option<CopySetup>,
    /// Paths that differ between the two sides, sorted.
    pub differs: Vec<String>,
    /// Files too big to sync, which stay on each machine.
    pub too_big: Vec<String>,
    pub diverged: Option<Diverged>,
}

/// `sync.open`: a worker starts a copy of `session`, under the id it chose.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncOpen {
    pub copy: String,
    pub session: String,
    /// A routing copy (X62) syncs only at a run's fences.
    #[serde(default)]
    pub kind: CopyKind,
}

/// A live copy the user keeps (X60), or a routing copy a worker runs heavy
/// commands in (X62).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CopyKind {
    #[default]
    Live,
    Run,
}

/// What a worker needs to make a copy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncOpened {
    /// The session's worktree on the central host.
    pub path: String,
    pub branch: String,
    pub head: String,
    /// The session's name and its project's.
    pub name: String,
    pub project: String,
    pub identity: crate::types::ProjectIdentity,
    /// The project's origin URL without a password or token.
    pub origin_url: Option<String>,
}

/// `sync.fetch`: the objects the worker has, so they are left out. With
/// `again`, a made copy asks the central host to send its state as an
/// update instead, as after `sync.retry`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncFetch {
    pub copy: String,
    pub have: Vec<String>,
    #[serde(default)]
    pub again: bool,
}

/// The session's files (`tree`) and commit (`head`) now; their objects
/// come in `pack`, a transfer id, or none when nothing is missing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncFetched {
    pub tree: String,
    pub head: String,
    pub too_big: Vec<String>,
    pub pack: Option<u32>,
    /// The pack holds `head` without its parents: a cloud machine gets no
    /// older history (X63).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub shallow: bool,
}

/// `sync.update`: the central host's files and commit, against the base
/// it last agreed on with the worker. The worker reconciles against its
/// own base, which wins when a lost reply left the two apart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncUpdate {
    pub copy: String,
    pub base: String,
    pub tree: String,
    pub head: String,
    pub too_big: Vec<String>,
    pub pack: Option<u32>,
    /// Set when the session is not on its branch: the branch it is on, or
    /// empty for a detached `HEAD`. The copy then pauses until an update
    /// without it, and `tree` and `head` are not applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub off_branch: Option<String>,
}

/// Whether the worker took an update. It takes one only when its files are
/// still the base; otherwise it keeps `tree`, its own files, and offers
/// them ([`SyncOffer`]) for the central host to reconcile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncUpdated {
    pub applied: bool,
    /// The worker's files, when it could look: not while it was busy.
    pub tree: Option<String>,
}

/// Which side's version a differing path keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Keep {
    Central,
    Worker,
}

/// `sync.resolve`: `path` of `copy` takes `keep`'s version on both sides.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncResolve {
    pub copy: String,
    pub path: String,
    pub keep: Keep,
}

/// One path resolved in a [`SyncOffer`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Resolution {
    pub path: String,
    pub keep: Keep,
}

/// `sync.offer`: the worker's files (`tree`) and commit (`head`) against
/// its base. Objects the base lacks come in `pack`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncOffer {
    pub copy: String,
    pub base: String,
    pub tree: String,
    pub head: String,
    pub too_big: Vec<String>,
    pub pack: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolve: Option<Resolution>,
}

/// The central host's reconcile of an offer: the worker goes from `from`,
/// the tree it offered, to `tree`, and both keep `base`. `differs` lists
/// the paths each side keeps its own version of; `pack` brings the
/// objects the worker lacks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncOffered {
    pub from: String,
    pub tree: String,
    pub base: String,
    pub head: String,
    pub differs: Vec<String>,
    pub too_big: Vec<String>,
    pub pack: Option<u32>,
}

/// `sync.changed`: a copy, and the paths that started to differ with this
/// change, so the app notifies each once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CopyChanged {
    #[serde(flatten)]
    pub copy: Copy,
    #[serde(default)]
    pub newly_differing: Vec<String>,
    /// Set when the copy is gone from this Mac.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<CopyRemoved>,
}

/// Why a copy went, and what of it was saved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CopyRemoved {
    pub reason: CloseReason,
    #[serde(flatten)]
    pub saved: SyncStopped,
}

/// What `sync.stop` saved: files that differed or had not synced yet,
/// relative to `folder`, sorted. Empty when nothing would have been lost.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct SyncStopped {
    pub folder: String,
    pub leftovers: Vec<String>,
}

/// Why a copy went: `stopped` (`sync.stop`) or `archived` (its session
/// went away).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseReason {
    Stopped,
    Archived,
}

/// The central host's session is going away.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncClosing {
    pub copy: String,
    pub reason: CloseReason,
}

/// `heavy.get` params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeavyGet {
    pub project: String,
}

/// `heavy.set` params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeavySet {
    pub project: String,
    pub heavy: crate::types::HeavyConfig,
}

/// `heavy.approve` params: `project` on the central host, the lists as the
/// user saw them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeavyApprove {
    /// A project on this machine, the central host.
    #[serde(default)]
    pub project: Option<String>,
    /// A project of this machine's central host, approved for this worker.
    #[serde(default)]
    pub identity: Option<crate::types::ProjectIdentity>,
    pub commands: Vec<String>,
    pub env: Vec<String>,
}

/// What the user approved of a project's heavy commands: the exact
/// commands and `env` names, together.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HeavyApproval {
    pub commands: Vec<String>,
    pub env: Vec<String>,
}

/// A project's heavy commands as its config has them, and the approval.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeavyInfo {
    pub config: crate::types::HeavyConfig,
    pub approved: Option<HeavyApproval>,
    /// Why `[heavy]` cannot be used as written; nothing is routed then.
    pub error: Option<String>,
}

/// `exec.route` params, from moonlet's `PreToolUse` hook.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecRoute {
    pub session: String,
    pub command: String,
    pub cwd: String,
    /// The tool call's id, so the app can match the call to its job.
    #[serde(default)]
    pub tool_use_id: Option<String>,
}

/// `exec.route`'s answer. `reason` says why a call stays where it is:
/// `no_session`, `outside_worktree`, `invalid_config`, `not_heavy`,
/// `not_approved`, `env_not_approved` or `claude_rule`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecRouted {
    pub route: bool,
    pub reason: Option<String>,
}

/// `exec.run` params, from `moonlet exec`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecRun {
    pub session: String,
    /// The words the shell gave `moonlet exec`.
    pub argv: Vec<String>,
    pub cwd: String,
    /// `moonlet exec`'s environment. Only the project's approved `env`
    /// names are taken from it.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
}

/// `exec.run`'s answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecRunStarted {
    pub run: u32,
    /// The machine the command runs on.
    pub host: String,
}

/// `exec.cancel` params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecCancel {
    pub run: u32,
}

/// `exec.exited` data. `status` is the command's exit status, 128 + N for
/// one ended by signal N.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecExited {
    pub run: u32,
    pub status: i32,
}

/// `exec.prepare` params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecPrepare {
    pub session: String,
}

/// A routing copy's setup the user is asked to approve, as for a live
/// copy (X60): `sync.run_setup` or `sync.skip_setup` answers it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecSetup {
    pub copy: String,
    /// The central host's name.
    pub host: String,
    pub project: String,
    pub command: String,
}

/// The worker's routing copy of a session, and whether it can run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecPrepared {
    pub copy: String,
    /// `ready`, `making`, `setup_pending` or `failed`.
    pub state: String,
    #[serde(default)]
    pub reason: Option<String>,
    /// The routing copy's folder.
    #[serde(default)]
    pub path: Option<String>,
}

/// `exec.start` params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecStart {
    pub run: u32,
    pub copy: String,
    pub argv: Vec<String>,
    /// The working directory, relative to the worktree.
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    /// The fence: the session's files and commit the copy must hold.
    pub tree: String,
    pub head: String,
    /// The session's worktree on the central host, which the copy's path
    /// is replaced with in output.
    pub session_path: String,
    /// Ignored paths brought back after the run.
    #[serde(default)]
    pub outputs: Vec<String>,
}

/// `exec.done` params: `tree` and `head` are the copy's after the run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecDone {
    pub run: u32,
    pub copy: String,
    pub status: i32,
    pub tree: String,
    pub head: String,
    pub pack: Option<u32>,
    /// A tree of the run's `outputs`, in the same pack.
    #[serde(default)]
    pub outputs: Option<String>,
}

/// What the central host took from a run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ExecBrought {
    /// Files that changed on the central host during the run as well; the
    /// run's versions are saved in `folder`.
    pub leftovers: Vec<String>,
    pub folder: Option<String>,
    /// Lines for the run's output, such as an `outputs` path not brought
    /// back.
    #[serde(default)]
    pub notes: Vec<String>,
    /// The files the run changed in the session.
    #[serde(default)]
    pub files: Vec<JobFile>,
    /// The `outputs` paths brought back.
    #[serde(default)]
    pub outputs: Vec<JobBytes>,
}

/// `job.list` and `job.stop_all` params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobList {
    pub session: String,
}

/// A job by id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobRef {
    pub job: String,
}

/// `job.output` params: the output from byte `from` of the stored file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobOutputGet {
    pub job: String,
    #[serde(default)]
    pub from: u64,
}

/// Part of a job's output: `stream` 1 is stdout, 2 stderr.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobChunk {
    pub stream: u8,
    pub text: String,
}

/// `job.output`'s answer: `next` is where to ask from next; `more` says
/// the stored output goes on past it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobOutput {
    pub chunks: Vec<JobChunk>,
    pub next: u64,
    pub more: bool,
}

/// `job.output` event data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobOutputEvent {
    pub job: String,
    pub session: String,
    pub chunks: Vec<JobChunk>,
}

/// A routed command of a session (X62).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub session: String,
    /// The command as the agent wrote it.
    pub command: String,
    /// The Bash tool call it came from, so the chat can find its row.
    #[serde(default)]
    pub tool_use_id: Option<String>,
    pub state: JobState,
    pub started_at: u64,
    #[serde(default)]
    pub ended_at: Option<u64>,
    #[serde(default)]
    pub phases: Vec<JobPhase>,
    #[serde(default)]
    pub timeline: Vec<JobEvent>,
    /// Where it runs or ran, as the machine was at the start.
    #[serde(default)]
    pub worker: Option<JobWorker>,
    /// Files the run changed in the session, with lines added and removed.
    #[serde(default)]
    pub brought: Vec<JobFile>,
    /// `outputs` paths brought back, with their sizes.
    #[serde(default)]
    pub outputs: Vec<JobBytes>,
    /// Files that changed on the central host during the run as well.
    #[serde(default)]
    pub leftovers: Vec<String>,
    #[serde(default)]
    pub leftovers_folder: Option<String>,
    /// Names of the variables passed to the worker; never their values.
    #[serde(default)]
    pub env: Vec<String>,
    /// Test results or the first compiler error of the last run.
    #[serde(default)]
    pub summary: Option<String>,
    /// Bytes of output kept.
    #[serde(default)]
    pub output_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JobState {
    /// For a cloud machine to start (X63).
    Waiting { r#for: String },
    Running { worker: String },
    BringingBack,
    Done { exit: i32 },
    /// Stopped from the Jobs panel or `moonlet exec`'s signal.
    Stopped { exit: i32 },
    /// The central host's daemon stopped during it.
    Lost,
}

/// One step of a job, with how long it took once it is over.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobPhase {
    pub name: String,
    #[serde(default)]
    pub took_ms: Option<u64>,
}

/// Something that happened to a job.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobEvent {
    pub at: u64,
    pub text: String,
    #[serde(default)]
    pub detail: Option<String>,
}

/// The machine a job runs on: `kind` is `mac`, `host`, `central` or
/// `cloud`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobWorker {
    pub name: String,
    pub kind: String,
    pub load: f64,
    pub cores: u32,
    /// The slot it took, from 1, of `slots`.
    pub slot: u32,
    pub slots: u32,
    #[serde(default)]
    pub rtt_ms: Option<u64>,
    /// The routing copy's folder on that machine.
    #[serde(default)]
    pub copy: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobFile {
    pub path: String,
    pub added: u64,
    pub removed: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobBytes {
    pub path: String,
    pub bytes: u64,
}

/// `exec.status`'s answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecStatus {
    /// This machine.
    pub host: ExecHost,
    /// Routed commands going on, wherever they run.
    pub running: Vec<ExecRunning>,
    /// Workers skipped for a project's commands in the last hour, and why.
    pub skips: Vec<ExecSkip>,
    /// Commands this machine runs for its central host.
    pub routed: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecHost {
    pub name: String,
    pub os: String,
    pub cores: u32,
    pub load: Option<f64>,
    pub slots: u32,
    /// Its own slots in use.
    pub used: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecRunning {
    pub job: String,
    pub session: String,
    pub command: String,
    /// The machine's name.
    pub worker: String,
    pub started_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecSkip {
    /// The worker's id.
    pub worker: String,
    /// The project's name.
    pub project: String,
    /// `not_approved`, `missing_tool`, `setup_pending`, `busy`, `not_fenced`
    /// or another refusal.
    pub reason: String,
    /// The worker's words, such as `missing pnpm`.
    #[serde(default)]
    pub detail: Option<String>,
}

/// A project's cloud setting (X63), by its identity in `cloud.json`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ProjectCloud {
    /// Start a machine when every worker is busy.
    #[serde(default)]
    pub overflow: bool,
    pub provider: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub location: String,
    pub image: String,
}

/// A settings field of a cloud provider, for the form the app builds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudField {
    pub name: String,
    pub label: String,
    pub secret: bool,
    pub help: String,
}

/// A cloud provider moonlet knows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudKind {
    pub id: String,
    pub label: String,
    pub fields: Vec<CloudField>,
    /// It bills every started this many seconds (3600: by the hour).
    #[serde(default)]
    pub billing_unit_secs: u64,
}

/// The Tailscale OAuth client, as `cloud.get` shows it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CloudTailscale {
    /// How machines get their key: from the OAuth client, or the pasted
    /// auth key.
    #[serde(default)]
    pub mode: TailscaleMode,
    pub client_id: String,
    pub has_client_secret: bool,
    #[serde(default)]
    pub has_auth_key: bool,
    pub tag: String,
}

/// How cloud machines get a Tailscale key (X63).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TailscaleMode {
    /// A one-off key for each machine, minted with the OAuth client.
    #[default]
    Oauth,
    /// One reusable key the user pasted.
    AuthKey,
}

/// `cloud.get`: the settings. A secret field `x` of a provider shows as
/// `has_x: true`, never its value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudInfo {
    pub host_id: String,
    pub providers: BTreeMap<String, BTreeMap<String, serde_json::Value>>,
    pub tailscale: CloudTailscale,
    pub idle_minutes: u32,
    pub max_machines: u32,
    pub max_hours_month: u32,
    pub projects: BTreeMap<String, ProjectCloud>,
    /// The providers on offer.
    pub kinds: Vec<CloudKind>,
}

/// The Tailscale part of `cloud.set`; a field left out keeps its value.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CloudTailscaleSet {
    #[serde(default)]
    pub mode: Option<TailscaleMode>,
    #[serde(default)]
    pub auth_key: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
}

/// `cloud.set`: what changes. A provider or project set to null is removed;
/// a provider's field set to null is removed.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CloudSet {
    #[serde(default)]
    pub providers: Option<BTreeMap<String, Option<BTreeMap<String, Option<String>>>>>,
    #[serde(default)]
    pub tailscale: Option<CloudTailscaleSet>,
    #[serde(default)]
    pub idle_minutes: Option<u32>,
    #[serde(default)]
    pub max_machines: Option<u32>,
    #[serde(default)]
    pub max_hours_month: Option<u32>,
    #[serde(default)]
    pub projects: Option<BTreeMap<String, Option<ProjectCloud>>>,
}

/// `link.join`: what `moonletd join` was given (X63).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkJoin {
    /// The central host's tailnet addresses.
    pub addrs: Vec<String>,
    pub code: String,
    /// The machine's name.
    pub name: String,
}

/// `worker.step`: a cloud machine's startup step, as the worker sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkerStep {
    /// `machine_setup` or `copy`.
    pub step: String,
    /// `running`, `done` or `failed`.
    pub state: String,
    #[serde(default)]
    pub took_ms: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
}

/// A startup step of a cloud machine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudStep {
    /// `created`, `tailnet`, `installed`, `paired`, `machine_setup` or `copy`.
    pub step: String,
    /// What the user reads: "Created at Hetzner".
    pub label: String,
    /// `pending`, `running`, `done` or `failed`.
    pub state: String,
    #[serde(default)]
    pub took_ms: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
}

/// A cloud machine (X63).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudMachine {
    pub id: String,
    pub name: String,
    /// The project's name, and its key in `cloud.json`.
    pub project: String,
    pub project_key: String,
    pub provider: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub location: String,
    /// `creating`, `starting`, `ready`, `removing`, `removed` or `failed`.
    pub state: String,
    /// When it entered its state, unix ms.
    pub since: u64,
    pub steps: Vec<CloudStep>,
    /// Removed if not ready by then.
    #[serde(default)]
    pub deadline: Option<u64>,
    /// When an idle machine is removed.
    #[serde(default)]
    pub idle_until: Option<u64>,
    /// The session it was made for.
    #[serde(default)]
    pub for_session: Option<String>,
    /// Its routed commands running now.
    #[serde(default)]
    pub running: u32,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_since: Option<u64>,
    /// The last failed attempt.
    #[serde(default)]
    pub error_at: Option<u64>,
    /// Why it was removed: "removed after 15 min idle".
    #[serde(default)]
    pub reason: Option<String>,
    /// Its worker's id in `worker.list`, once it has registered. Only in
    /// `cloud.machines` and `cloud.changed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<String>,
}

/// `cloud.machines` and `cloud.changed`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudMachines {
    pub machines: Vec<CloudMachine>,
    /// Removed in the last hour.
    pub removed: Vec<CloudMachine>,
    pub hours_this_month: f64,
    pub max_hours_month: u32,
    pub max_machines: u32,
}

/// `cloud.up`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudUp {
    /// The project's id on the central host.
    pub project: String,
    #[serde(default)]
    pub session: Option<String>,
}

/// `cloud.down`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudDown {
    /// The machine's id or name.
    pub machine: String,
}

/// `cloud.types`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudTypes {
    pub provider: String,
    pub location: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// X65 entry 12: a design call names a workspace design as it always
    /// did, `{workspace, slug}`, or a session design as `{session, slug}`,
    /// beside its other fields.
    #[test]
    fn a_design_is_addressed_by_its_workspace_or_its_session_and_its_slug() {
        let page: DesignPageRef = serde_json::from_str(r#"{"workspace":"w1","slug":"settings-page","page":"index"}"#).unwrap();
        assert_eq!(page.design, DesignRef::Workspace { workspace: "w1".into(), slug: "settings-page".into() });
        let page: DesignPageRef = serde_json::from_str(r#"{"session":"s1","slug":"settings-page","page":"index"}"#).unwrap();
        assert_eq!(page.design, DesignRef::Session { session: "s1".into(), slug: "settings-page".into() });
        let put: DesignCommentPut =
            serde_json::from_str(r#"{"session":"s1","slug":"settings-page","edit":{"n":2,"comment":"Smaller"}}"#).unwrap();
        assert_eq!(
            (put.design, put.change),
            (
                DesignRef::Session { session: "s1".into(), slug: "settings-page".into() },
                crate::types::CommentChange::Edit { n: 2, comment: "Smaller".into() }
            )
        );
        let restore: DesignSnapshotRef = serde_json::from_str(r#"{"workspace":"w1","slug":"settings-page","n":3}"#).unwrap();
        assert_eq!((restore.design.slug(), restore.n), ("settings-page", 3));
        assert_eq!(
            serde_json::to_value(DesignPageRef { design: DesignRef::Workspace { workspace: "w1".into(), slug: "a".into() }, page: "index".into() }).unwrap(),
            serde_json::json!({"workspace": "w1", "slug": "a", "page": "index"})
        );
        assert!(serde_json::from_str::<DesignPageRef>(r#"{"slug":"settings-page","page":"index"}"#).is_err());
    }
}
