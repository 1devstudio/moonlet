# X40 — The moonlet phone app

- **Status:** implemented (macOS build checked against a scratch daemon; the iPhone build, push notifications and pairing links opened from elsewhere not yet)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2 (agent-first), A3 (attention), A5 (approval inbox), D1–D3 (changes, review, comments to the agent), X2 (PR and checks)
- **Related:** [X39](X39-phone-pairing-and-link.md) (pairing and the phone link), [X20](X20-plan-approval.md) / [X24](X24-plan-panel.md) (plans), [X31](X31-agent-reads-terminal.md) (terminal reads), [X32](X32-workspaces-and-sections.md) (workspaces), [T9](T9-real-command-blocks.md) (command blocks), [D3](D3-comment-to-agent.md) (comments to the agent)
- **Related ADRs:** [0008](../adr/0008-phone-link-over-tailscale.md)

## Summary

An iPhone app for following agents away from the desk. It pairs with the user's Mac (X39) and shows what needs the user across every session: tool permissions, plans, and terminal reads, each answerable in place. It lists the sessions of the current workspace, starts new ones, and opens any session with four tabs: Chat, Terminal, Changes (with a diff view and line comments to the agent) and PR (with checks). The app is a Tauri 2 app in `apps/mobile` that reuses the desktop's look and logic (ADR 0008). The design is the "Moonlet Mobile" board: Inbox, Sessions, New session, Hosts, Session · Chat, Plan approval sheet, Session · Terminal, Session · Changes, Diff review, Session · PR.

## User journey

1. The user pairs the phone with the Mac (X39). The app opens on the Inbox.
2. The Inbox says "3 need you · 2 working · 2 ready to review · 2 hosts online". The first card asks "Allow Bash?" for `pnpm test --filter search` in "Add search to the product list". The user taps **Allow**, confirms with Face ID, and the card leaves.
3. The next card says "Claude has a plan: Idempotent refund webhooks". The user taps **Review plan**, reads it in a sheet, and taps **Approve, auto mode**.
4. Under "Ready to review", the user taps "Fix checkout button on mobile". The Changes tab lists 4 files. The user opens a file, long-presses line 15, writes "SKU match should be prefix and case-insensitive", and taps **Send to Claude**. The session's chat shows the comment as the user's message.
5. In the Sessions tab the user taps **New**, types a task, picks the project, and taps **Start session**. The new session's chat opens.
6. The PR tab of a session shows `#147 open · Review required` and "1 failing". The user taps **Ask Claude to fix ci / test**.

## Behaviour and acceptance criteria

### Shell and navigation

- [x] Before any Mac is paired, the app shows a pairing screen: **Scan QR code** (camera, on the phone only), a box to paste the link with **Pair**, and the line "On the Mac: Settings › Phones › Pair a phone". A link that is not a version 1 pairing link says so; a failed pairing shows the Mac's message. (`lib/pairLink.test.ts`: name, several addresses, version, bad links; `src-tauri/tests/macs.rs`: pairing, a dead first address, a wrong code)
- [ ] A `moonlet://pair` link opened from elsewhere starts pairing too. (Not yet: needs the deep-link plugin and an iOS build.)
- [x] After pairing, a bottom tab bar has **Inbox**, **Sessions**, **New** and **Hosts**. The Inbox tab carries a badge with the number of items that need the user. (`lib/inbox.test.ts`)
- [x] The app keeps one connection per paired Mac and one per SSH host the Mac lists in `mobile.hosts`, routed through it (X39). It tries the Mac's addresses in order. A lost connection retries with the desktop's backoff (0.3 s doubling to 5 s), and at once when the app comes back to the foreground. Paired Macs are kept in the app's data folder (`macs.json`, mode 0600, names and addresses only) and their device tokens in the Keychain; **Forget** removes both. (`src-tauri/tests/macs.rs`: the file has no token, a restart connects with the stored one) (`src-tauri/tests/macs.rs`)
- [x] The workspace chip at the top of Inbox and Sessions lists workspace names across connected hosts, once each, with the first host's colour, plus "All workspaces". Each daemon has its own workspaces (X32) but every one starts with "Personal", so a name shows that workspace on every host. The choice is remembered. (`lib/workspaceChoices.test.ts`, `inbox.test.ts`)
- [x] The app's logo is the desktop's ringed moon (`src/assets/moon.svg`): on the pairing screen, in the Inbox's title and, on a full-bleed dark square, as the iOS app icon (`src-tauri/icons/source/icon-ios.svg`). The ringed moon and "moonlet" on the dark background show from launch until the app has loaded: as the iOS launch screen, then as static HTML in `index.html`, then as the app's own splash, all three laid out alike, so starting has no flash and no jump. (`lib/splash.test.ts` checks the launch screen's layout against the splash's)
- [x] Right after pairing, the app says "Paired with <Mac>" and goes on to the Inbox (after 1.5 seconds, or at once with **Continue**).
- [x] Colours, type and components follow the desktop's tokens (`moonlet.css`): dark background `#121212`, the state colours, and the desktop's `StateGlyph`, `DiffStat`, `AgentIcon`. (Not yet compared with the design by eye.)

### Inbox

- [x] The Inbox lists, newest first within each group (`lib/inbox.test.ts`):
  - **Needs you**: every pending tool permission (`chat.state.pending` of every chat terminal), every plan (`ExitPlanMode` ask, X20), every waiting question (`AskUserQuestion`), and every terminal read request (X31), across all connected hosts in the current workspace.
  - **Ready to review**: sessions whose agent is `done`, not archived, most recently active first, with their diff stat and file count once `git.status` answers.
- [x] The summary line counts these: `<n> need you · <n> working · <n> ready to review · <n> hosts online`, leaving out zero counts except hosts. (`lib/inbox.test.ts`)
- [x] A permission card shows the session name, the agent, the project, the host, the age (`now`, `2m`, `3h`, `2d`, from the ask's `asked_at`), the tool's question ("Allow Bash?"; an MCP tool reads "Allow linear · create_issue?") and its summary, plus **Allow**, **Always** (disabled unless `can_always`) and **Deny**. These call `chat.permission` with `allow`, `always` or `deny`. (`lib/cards.test.ts`)
- [x] A plan card shows the plan's title (the ask's summary) and the first sentence after its heading, without Markdown and at most 140 characters, the project and the host, plus **Review plan** (opens the plan sheet) and **Approve, auto** (`chat.permission` with `allow` and mode `auto`). (`cards.test.ts`)
- [x] A terminal read card shows the X31 message (`<agent> in <session> wants the output of <command> (exit <code>, <n> lines) from terminal <title>.`) with **Preview output** (a sheet with the exact text, **Allow** and **Deny**) and **Deny**.
- [x] A question card opens the session's chat, where the question is answered.
- [x] A card leaves the Inbox as soon as the daemon reports the ask answered, from the phone or from the Mac (`chat.state`, `terminal.read_done`).
- [x] With nothing waiting, the Inbox says "Nothing needs you." and still shows Ready to review.

### Face ID

- [x] Allow, Always, plan approvals, answers to questions and allowing a terminal read ask for Face ID (or the device passcode) first, when the setting "Require Face ID to allow" in Hosts is on (on by default). Deny never asks. A failed or cancelled check sends nothing. (`needsFaceId` in `lib/cards.test.ts` for which answers need the check)

### Plan approval sheet

- [x] The sheet shows "Claude has a plan", the project, host and waiting time, the plan as Markdown, and the plan file's path.
- [x] **Approve, auto mode** answers `allow` with mode `auto`; **Ask before edits** answers `allow` with no mode; **Keep planning** shows a text box "What should change in the plan?" with **Back** and **Send feedback**, which answers `deny` with the text. (`planAnswer` in `lib/chat.ts`, already tested)

### Sessions

- [x] Sessions lists the current workspace's sessions on every connected host, grouped by section and project in the workspace's order (X32): a section label, then per project its avatar letter, name and host, then its sessions, most recently active first. Projects without sessions are left out. (`lib/sessionList.test.ts`)
- [x] Each row shows the state glyph, the title, a state word (`needs you`, the time since its turn started while working, `done`, `failed`, `plan` for a waiting plan), the branch, the diff stat against the base, and the PR number with its state colour when there is a PR. Diff stats and PRs load as rows show and are kept for a minute. (`sessionList.test.ts`)
- [x] Filter chips: **All**, **Needs you**, **Working**, **Review**, each with its count. Search filters by title, branch and project. (`lib/sessionList.test.ts`)
- [x] A project whose base branch is behind `origin` (as last fetched) shows "main 3 behind · Pull", which pulls (X13).
- [x] Tapping a row opens the session on the tab that matters: the plan sheet for a waiting plan, Changes for a done session, Chat otherwise. (`rowTarget` in `sessionList.test.ts`)

### New session

- [x] New session has the prompt box "What do you want to work on?" (dictation comes from the keyboard's microphone), the branch the daemon will create (`<prefix><slug of the name>`, the daemon's own rule, updated as the prompt changes; the prefix is the host's, see Git settings), and rows for **Project** (the workspace's projects on connected hosts), **Host** (the project's host: tapping it opens the same project picker, since a project lives on one host), **Agent** (Claude Code, Codex), **Model** with effort (Claude only) and **Base** (the project's branches), each opening a picker. (`lib/newSession.test.ts`, with names captured from a real daemon)
- [x] **Mode** has Auto, Manual, Edits and Plan, with one help line each (from the design). Manual is the default. It shows for Claude Code only: Codex has no such modes.
- [x] The footer says "Creates a worktree from <base> on <host> and runs setup: <setup command>" (no setup part without a setup command). **Start session** calls `session.create` in the chosen workspace and opens the new session's chat. (`lib/newSession.test.ts` for the branch name and the footer)

### Session screen

- [x] The header shows the back button, the state glyph and title, `<project> · <branch> · <host>`, and a ⋯ menu with Archive session. (`lib/chatView.test.ts`)
- [x] Tabs: **Chat**, **Terminal** (with the number of shell, run and setup terminals), **Changes** (with the number of changed files), **PR** (with a dot in the checks' colour: red with a failure, yellow while one runs, green). (`checksDot` in `lib/checks.test.ts`)

### Chat

- [x] The chat shows the session's first conversation as the desktop does: user messages, thinking (folded, tap to read), runs of tool calls folded into one row (X14) that open to each call's command and output, diff or plan, and Markdown replies. It follows the end as it grows.
- [x] A pending ask is docked at the bottom in place of the composer: the question, the command or summary, "Waiting 2m", and **Deny**, **Always**, **Allow**; under them "Deny and tell Claude what to do…", which opens a text box and answers `deny` with that message. A plan docks as "Claude has a plan" with **Review plan** (the sheet, which returns to the chat); a question docks its options, an "Other…" box and **Answer**.
- [x] Without a pending ask, the composer sends a message (`chat.send`); while the agent works, a stop button interrupts it (`chat.interrupt`).
- [x] The footer shows the context meter (X34), the cost, the model and effort, and the permission mode; model, effort and mode open pickers that call `chat.settings`. (`chatFooter` in `chatView.test.ts`)

### Terminal

- [x] A strip lists the session's shell, run and setup terminals by title, plus **+** for a new shell. (`shellTerminals` in `chatView.test.ts`)
- [x] The terminal shows command blocks: the phone feeds the shell's output to a headless terminal of the PTY's size (it never resizes the PTY, which the Mac's window shares) and splits it by the OSC 133 marks, as the desktop's Blocks mode does (T8). Each block shows its directory, duration, exit status, the command and its last 300 lines of output. A failed block offers **Send to Claude** (the block, fenced, into the session's chat composer), **Re-run** and **Copy**. (`lib/blocks.test.ts` with a real zsh snapshot)
- [x] The command line at the bottom shows the directory and branch and sends a command with ↵. A key bar has esc, tab, ctrl, ↑, ↓, ←, →, `|`, `~`; ctrl turns the next letter typed into its control character. (`lib/keyBar.test.ts` for the bytes each key sends, ctrl+c as `\x03`)
- [x] **Blocks ▾** switches to the raw terminal (xterm, read-only, scaled to fit the PTY's columns) for full-screen programs.

### Changes and diff review

- [x] Changes shows **vs main** / **vs HEAD**, the file count and diff stat, and the files grouped by folder, each with its status letter, name and diff stat, and a staging checkbox when it has uncommitted changes (against the base, a file can be changed only by the branch's commits). "Commits on this branch" opens the log. (`lib/diffView.test.ts`)
- [x] The bottom has the commit message box and **Commit <n> staged** ("Nothing staged", disabled, with nothing staged) and **Create PR**, which opens the PR tab (X2). (`commitLabel` in `diffView.test.ts`)
- [x] Tapping a file opens the diff: file name, folder, diff stat, `1 / 6` with previous and next file, and the hunks with old and new line numbers. In the diff against HEAD, each hunk has **Stage hunk** and a discard button (asks first), and the bottom has **Discard file** (asks first) and **Stage file** (or **Staged**). The diff against the base includes committed lines, so it offers **Stage or discard vs HEAD** instead, as the desktop does. (`canStage`, `editsDiff` in `diffView.test.ts`) (`diffRows` in `diffView.test.ts`)
- [x] Long-pressing a line opens "Comment to Claude on line <n>" (the new line number, or the old one for a removed line) with **Cancel** and **Send to Claude**, which sends the comment to the session's agent in D3's format (`commentPrompt`) and opens Chat. (`diffRows` in `diffView.test.ts` for the line numbers of added, removed and context lines)

### PR and checks

- [x] The PR tab shows the PR title and number, `<base> ← <branch>`, its state and review decision, the diff stat, and "Stacked on #141 Search API endpoint · merged" for a stacked PR (X11). (`reviewText`, `stackedOn` in `checks.test.ts`)
- [x] "Checks" shows "<n> failing", "<n> running" or "all passing", "updated <n>s ago", and each check with its status mark, name and note (passed, failed, running, skipped); a tap opens its run. It refreshes every 30 seconds while shown. GitHub's check list carries no durations, so none are shown. (`lib/checks.test.ts`)
- [x] With a failing check, **Ask Claude to fix <check>** sends a message naming the check and its link to the session's agent and opens Chat. **Open on GitHub** opens the PR in the browser. (`fixPrompt` in `checks.test.ts`)
- [x] Without a PR, the tab shows a form (title, description, draft) and **Create PR**, which pushes the branch and opens the PR against the session's base (`gh.pr_create`).

### Hosts

- [x] Hosts lists the paired Macs and the SSH hosts reached through them, each with its status (connected, connecting, offline), its route (`Paired · direct over Tailscale · 14 ms` with the last `daemon.info` round trip, `Reached through <Mac> over SSH`, `Last seen 2 h ago · sessions keep running`, `Not reachable over Tailscale`), and `moonletd <version> · <n> sessions · <n> terminals`. An offline host has **Reconnect**; a Mac has **Forget**, which asks once more. (`lib/hosts.test.ts` for the lines)
- [x] **Pair a Mac** opens the pairing screen for another Mac.
- [x] "Notify me when" has switches for an agent needs input, finishes, fails, and PR checks fail (off by default); and "Require Face ID to allow" (on by default). The switches are kept on the phone; they take effect once push notifications exist (out of scope here).

### Subagents (X42)

Added 2026-10-20 to keep the phone in step with the desktop.

- [x] A run of Agent calls in the chat shows as one card, "Launched <n> agents", with a row per agent: its state glyph, description, state word and clock, live as the agents work. Before this, a chat that launched a subagent did not render on the phone. (`blockKey` in `lib/chatView.test.ts`; the rows are the desktop's `launchedRows`, tested in `subagents.test.ts`)
- [x] Tapping an agent opens a sheet with its state, kind and model, what it does now or why it failed, its prompt and its report, and **Stop agent** while it runs or waits (`chat.stop_agent`).
- [x] A session row shows "<n> agents" while its chats run subagents. (`lib/sessionList.test.ts`)
- [x] A permission a subagent asks for says which one, "Agent <description>", on its Inbox card and on the ask docked in the chat. (`lib/inbox.test.ts`)

### Git settings (X55)

Added 2026-10-20. Each host's daemon keeps its Git settings; the phone loads them with the host (`git.settings`) and follows `git.settings_changed`. A daemon too old for them gets the defaults. (`lib/events.test.ts`)

- [x] New session's branch preview starts with the project's branch prefix, else the host's (`moonlet/` by default; empty for none), as the daemon names it. (`branchPrefix`, `branchPreview` in `lib/newSession.test.ts`)
- [x] With the host set to start from origin, the footer says "Creates a worktree from origin/<base>" while the project's base is kept; another base is used as picked. (`startPoint` in `lib/newSession.test.ts`)
- [x] **Archive session** opens a sheet with the desktop's archive prompt: whether the worktree folder is removed or stays, and whether the branch is kept or deleted (here, and on origin), from the host's settings and whether the session's PR merged; "Also delete the branch" under Ask each time. Archiving sends `session.archive` with those flags; a branch origin refused to delete is reported. (`lib/archive.test.ts`)
- [x] With "Warn about unpushed work" on, the sheet first asks the host for work only there (`git.unpushed`): uncommitted files (the first 8) and commits not on origin, with **Archive anyway** and **Push, then archive** (`git.push` first), which needs the files committed first. (`lib/archive.test.ts`)
- [x] The Create PR form's **Draft** starts as the host's "Draft pull requests" says. (`startsDraft` in `lib/checks.test.ts`)
- The phone stages files one by one with their checkboxes, so "Stage all changes first" has no place there; fetching and fast-forwarding base branches is the desktop's.

### Queued messages (X49)

Added 2026-10-20; the phone showed the queue read-only before.

- [x] Under the queued messages, **Send now** (`Send <n> now` for several, `chat.send_now`) and **Ask aside** on the last one; both go once Send now was asked, while the line reads `Stopping <command>…`. (`queuedActions` in `lib/chatView.test.ts`)
- [x] Ask aside asks Claude to give the message back (`chat.unqueue`) and, once it is out of the queue, opens the Aside sheet: the question, `Answering from the conversation`, then the answer with its time and cost, **Queue for Claude** and **Close** (`chat.aside`). If Claude read the message first, the chat says "Claude read the message before it could be asked aside". (The outcome is the desktop's `unqueued`, tested in `queued.test.ts`)

## UI

The design board "Moonlet Mobile" is the reference: 390 × 844 points, safe areas respected, dark theme only.

## Protocol and RPCs

The app uses the existing methods and events (`docs/protocol.md`) through the X39 link, plus X39's `mobile.hosts`. A new method `chat.summaries` returns every chat terminal's state without its items (`[{ id, state }]`), so the Inbox does not load every conversation. Pending asks and read requests carry `asked_at` (ms), for their age. (`summaries_carry_every_chats_asks_without_its_items` in `moonlet-core`)

## Data and config

On the phone: the paired Macs (id, name, addresses) in `macs.json` in the app's data folder, mode 0600; each Mac's device token in the Keychain (service = the app's identifier, account = the Mac's device id), on iOS readable only while the phone is unlocked and never restored to another device; the app settings in the webview's storage.

## Security considerations

- The device token gives full access to the Mac (X39). It lives in the Keychain, this device only, never in a file or a backup; Face ID gates approvals.
- Text from the daemon (chat, terminal output, file names) is rendered as text or through the desktop's sanitising Markdown renderer, never as raw HTML.

## Out of scope

- Push notifications and approving from a notification (needs APNs and a paid Apple Developer account).
- iPad layouts, landscape, light theme.
- Editing files, the file tree, the MCP panel, the command palette. The desktop's Agents panel and strip (X42): the chat's Launched card and its agent sheet stand in for them.

## Test plan

- Vitest in `apps/mobile/src/lib/*.test.ts` for each `lib` function named above, with literals from this spec, the design, and output captured from a real daemon (the branch name, a zsh session's blocks).
- Rust, phone core: `apps/mobile/src-tauri/tests/macs.rs` against a fake Mac on loopback (pairing, a dead address, a wrong code, the token on reconnect, routed SSH hosts, Forget); a Keychain round trip runs by hand with `--ignored`.
- Rust, daemon: `chat.summaries` and `asked_at` in `moonlet-core`'s `summaries_carry_every_chats_asks_without_its_items`.
- The phone app has no automated UI tests. Each part was checked in the app's macOS build and in the iOS simulator against a scratch daemon, with screenshots of the launch and pairing screens; not yet on a real iPhone.

## Open questions

- None.
