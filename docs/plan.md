# Moonlet (Agent-First Terminal): tech confirmation and high-level plan

## Implementation status (2026-10-02)

Every P0 and P1 requirement has a spec in [`docs/specs/`](specs/README.md) and an implementation, except these open items:

- **X3 distribution:** release builds are Developer ID signed and notarized ([release.md](release.md)). The updater (X35) is in, untried until two releases are published.
- **R2 helpers:** Linux helpers need `cargo-zigbuild` to build (`scripts/build-remote.sh`). The code type-checks for both musl targets. Helper signing is pending.
- **T1 ligatures:** depend on the font; there is no ligature addon in the WebGL renderer.
- **T4 collapsing blocks:** blocks are decorations for now (answers the PRD's open question).

Deviations from this plan:
- Phase 0 spikes were folded into tests and ADRs ([ADR 0001](adr/0001-spikes-folded-into-build.md)).
- vt100 won for terminal state ([ADR 0003](adr/0003-vt100-terminal-state.md)).
- The launchd plist replaced SMAppService until builds were signed ([ADR 0004](adr/0004-launchagent-plist.md)); bundled builds now register a login item ([X56](specs/X56-login-item.md)).

Manual GUI checks and measured numbers are in [manual-checks.md](manual-checks.md).

## Context

The PRD (Notion, "PRD — Agent-First Terminal", 2026-10-01) describes **Paddock** (working name; project name is now **moonlet**), a macOS-first desktop terminal for running and supervising AI coding agents. Its core promise is that sessions survive app quit, crash, sleep and network loss, locally and on remote Linux hosts. It also asks for agent-state awareness, built-in diff, file and Markdown review, and the same features on remote hosts as on local ones.

The repo `moonlet` is empty (no commits), so this is a greenfield build.

Decisions made with the user:
- Build our own Rust daemon from week 1. Herdr is not used as an interim backend.
- Phase 0 changes from "living in Herdr/Wave" to two weeks of throwaway tech spikes.
- On approval, the first action is to write this plan into the repo as `docs/plan.md`.

## 1. Technology: confirmed, adjusted, or open

| Layer | PRD choice | Verdict | Notes |
|---|---|---|---|
| App shell | Tauri 2 | **Confirm** | Small footprint, capability allowlist. Native work goes in a thin Rust core. |
| UI | React + TS (Vite) | **Confirm** | |
| Terminal | xterm.js + WebGL addon, pinned | **Confirm, then spike** | WKWebView supports WebGL2. Measure throughput and latency in spike S1. Fallback is the DOM renderer. |
| PTY to UI path | "binary channel" | **Specify** | Use `tauri::ipc::Channel` with raw byte payloads, batched every 8–16 ms. Never use Tauri events or JSON for PTY data. |
| App to daemon protocol | JSON-RPC + PTY frames over a 0600 Unix socket | **Specify** | One stream with length-prefixed frames: `[u32 len][u8 kind][payload]`. Control frames carry JSON-RPC; data frames carry raw PTY bytes tagged with a pane id. The same framing runs over SSH stdio. |
| Daemon language | Rust (open question) | **Rust**, decided | One binary serves local and remote (static musl). Logic is written once. |
| PTY | `portable-pty` | **Confirm** | Daemon upgrade (S3, P1) needs raw fds for SCM_RIGHTS handoff, so check that fds are reachable. Fallback is `nix::pty::openpty`. |
| Terminal state for replay | `alacritty_terminal` or `vt100` | **Pick in spike S3** | Leaning `alacritty_terminal` for fidelity (alt screen, modes, scrollback). It needs our own grid-to-ANSI serializer. `vt100` has `contents_formatted()` built in but is a weaker emulator. Pick by replaying recorded Claude Code and Codex TUI sessions and diffing the restored screen. |
| Daemon lifecycle | launchd LaunchAgent | **Adjust** | Register it via `SMAppService.agent(plistName:)` with the plist inside the app bundle (macOS 13+), not a hand-written plist in `~/Library/LaunchAgents`. Native call through `objc2`. |
| Notifications | (unspecified) | **Spike S5** | `tauri-plugin-notification` click-to-deep-link support on macOS is uncertain. Fallback is native `UNUserNotificationCenter` through `objc2` in the Tauri core. |
| Diff / viewer | Monaco | **Confirm** | Load lazily so the cold start stays light. Feed it `git show <base>:<path>` and the working file contents. |
| Markdown | renderer + Mermaid in sandboxed iframe | **Confirm** | `markdown-it` + `shiki` + `mermaid` inside `<iframe sandbox="allow-scripts">` (no `allow-same-origin`) using `srcdoc` and a strict CSP that blocks remote content. |
| Files | (unspecified) | **Add** | Daemon side uses the `ignore` crate (gitignore-aware walk) and `notify` (fs watch, live refresh). |
| Git | git CLI on the owning host | **Confirm** | `git worktree`, `status --porcelain=v2`, `diff`, `apply --cached` for hunk staging. |
| Remote | system OpenSSH + static musl helper | **Confirm** | `ssh host moonletd proxy` is a short-lived stdio bridge to the long-lived remote daemon's Unix socket, so the daemon outlives the connection. Use ControlMaster for fast reconnects. Cross-compile with `cargo zigbuild` for x86_64 and aarch64 musl. |
| Agent state | hooks > OSC > heuristics | **Confirm** | Inject `MOONLET_PANE_ID` and `MOONLET_SOCK` into each PTY's env. Hooks call `moonlet notify --state …`. Claude Code: Notification, Stop, PreToolUse, UserPromptSubmit and SessionStart hooks. Codex: `notify` config, plus hooks if the installed version has them (verify in spike S4). |
| Distribution | signed + notarized, signed auto-update | **Confirm** | Use `tauri-plugin-updater`. The daemon binary is a nested signed binary in `Contents/MacOS`. |

Swap option (Swift + libghostty client later): keep it possible by keeping all session logic in the daemon behind the protocol. The UI should own no session state.

## 2. UI direction: Superset / Conductor style

The user wants the UI to be close to superset.sh and conductor.build. Both apps are **workspace-centric**: one workspace is one git worktree, one branch, one agent, its terminals and its diff. That model replaces a generic "tabs of shells" terminal as the primary navigation. Agents still run in their own TUI inside xterm.js, as in Superset. Conductor's chat UI is not copied, because a chat UI is a PRD non-goal.

Three-column layout:
```
┌──────────────┬───────────────────────────────────┬──────────────────────┐
│ Sidebar      │ Workspace header: branch · base · │ Right panel (tabs)   │
│ ▾ repo-a     │  [Open in ▾] [Run ▶] [Create PR]  │  Changes │ Files │   │
│   ● fix-auth │───────────────────────────────────│  Checks  │ Preview   │
│     +46 −1   │ Terminal tabs: claude │ shell │ run│                      │
│   ⚠ refactor │  xterm.js panes (splits)          │  file list + diffstat│
│   ✓ docs     │                                   │  Monaco diff         │
│ ▾ devbox ⇄   │                                   │  (Against base/HEAD) │
│   ● api-perf │───────────────────────────────────│                      │
│ [+ New ws]   │ Task box: "Type a task for claude…"│                      │
│ In progress 3 · Review 2 · Blocked 1             │                      │
└──────────────┴───────────────────────────────────┴──────────────────────┘
```
- **Sidebar** (Superset): repos and hosts as groups. Each workspace row shows the agent state glyph (working spinner, blocked ⚠, done ✓, error ✗), branch, diffstat `+N −M` and unread marker. Status counts sit in the footer, and archived workspaces live in a History view (Conductor). This covers A3, R4 and A5. The approval inbox is the "Blocked" filter.
- **New workspace** (Cmd+Shift+N): start from a new branch, an existing branch, a PR or an issue. Pick an agent (Claude Code, Codex, plus custom commands). This creates the worktree, runs the setup script and launches the agent (A4).
- **Main area**: terminal tabs and splits for the agent, shells and the run script. A task box at the bottom sends text into the agent's PTY (Superset's "Type a task for Claude…"); it stays a TTY-native input, not a chat.
- **Right panel**:
  - **Changes** (Cmd+Shift+D): file list, unified or split Monaco diff, against base or HEAD, per-commit filter. A line comment is sent to the agent as a prompt (D1–D3).
  - **Files**: tree (F1).
  - **Preview**: Markdown (M1).
  - **Checks** (Conductor, later): git status, `gh` PR and CI state.
- **Header actions**:
  - "Open in" Cursor, VS Code, Finder or Terminal.
  - Run button for a per-repo run script.
  - Create PR (Cmd+Shift+P) via the `gh` CLI. This is new scope, not in the PRD, and is placed at P1.
- **Per-repo config** in `.moonlet/config.toml` (Conductor-style): `setup`, `run` and `archive` scripts, default agent, base branch.
- **Visual**: dark-first and dense. Use Tailwind + shadcn/ui (Radix) for fast, consistent components; that pairing is what Superset-style apps typically use. Fonts are Geist/Inter for UI and a monospace font for terminals.

## 3. Repo layout (monorepo)

```
moonlet/
  Cargo.toml                 # workspace
  crates/
    moonlet-proto/           # frame codec, JSON-RPC types, version handshake
    moonlet-core/            # sessions, terminal state + serializer, agent state machine, git, files
    moonletd/                # daemon binary: local socket server, `proxy` stdio mode, launchd entry
    moonlet-cli/             # `moonlet` CLI: notify, pane run, agent start, hooks install
  apps/desktop/
    src-tauri/               # thin core: daemon client, Channel bridge, notifications, SMAppService, updater
    src/                     # React UI: panes, sidebar, changes panel, file tree, md preview
  docs/plan.md, docs/protocol.md, docs/adr/, docs/specs/ (one spec per feature)
```
Tooling: pnpm, cargo, `cargo-nextest`, Vitest, Playwright (or WebDriver for Tauri) for later smoke tests.

## 4. Phased plan

**Phase 0 — Tech spikes (weeks 1–2).** Throwaway code in `spikes/`. Each spike answers one question with a number.
- S1: xterm.js WebGL in a Tauri window. Measure `cat` of a large file, the `htop` and Claude Code TUI, and keystroke latency below 16 ms.
- S2: PTY to Channel raw bytes with 8–16 ms batching. Measure throughput and CPU with 10 busy panes.
- S3: `alacritty_terminal` vs `vt100` replay fidelity on recorded agent sessions. Pick one and record the decision in an ADR.
- S4: Claude Code and Codex hooks fire `moonlet notify` reliably. Measure blocked-to-signal latency.
- S5: notification click deep-links to a pane. Also confirm that SMAppService registration works from an unsigned or dev-signed build.

Gate: every spike has a result recorded, the stack is frozen, and ADRs are written.

**Phase 1 — Personal MVP, local only (weeks 3–10).** P0 local scope:
1. `moonlet-proto` and a minimal `moonletd`: spawn, attach and detach, resize, input. Keep terminal state server-side and replay on attach (S1, S2). The daemon is launched by the app, and launchd registration is added here.
2. Tauri shell with the three-column layout from section 2. Includes the sidebar (repos > workspaces), terminal tabs and splits per workspace, and a prefix key that never reaches the PTY (T1, T2).
3. Agent state machine plus `moonlet-cli notify`, one-click hook install, sidebar state glyphs and diffstat, and notifications (A1–A3).
4. New workspace flow (Cmd+Shift+N): worktree, `.moonlet/config.toml` setup script, agent launch, task box, and archive with cleanup (A4).
5. Right panel: Changes with Monaco diff (D1), Files tree (F1), Markdown Preview (M1). Add "Open in" IDE.

Gate: used for all own agent work for 2 weeks, and a quit-and-reopen test reattaches every pane.

**Phase 2 — Own the sessions everywhere (months 3–6).** This is the riskiest phase.
- Hardening: launchd soak tests, crash recovery, and a version handshake with a clear upgrade path.
- Remote: hosts from `~/.ssh/config` (R1), consent-based install of the pinned, checksummed musl helper (R2), and a `proxy` stdio bridge with auto-reconnect and screen resync (R3).
- File tree, diff and Markdown served by the remote daemon through the same RPCs, which gives parity for free.

Gate: zero lost sessions in 2 weeks, local and remote. Reattach under 300 ms locally and under 1.5 s remotely.

**Phase 3 — Daily driver (months 6–9).**
- Terminal: OSC 133/7 shell integration and command blocks (T3, T4), command palette and scrollback search (T5).
- Sessions: daemon live upgrade through SCM_RIGHTS fd handoff (S3), and layout restore with agent resume (S4).
- Agents and remote: approval inbox (A5), socket API and CLI (A6), unified host sidebar (R4).
- Review and files: hunk staging and commit (D2), comment-to-agent (D3), code viewer with light edit (F2), clickable paths (F3), automatic Markdown preview (M2).
- Superset/Conductor extras: Run button, Create PR via `gh` (Cmd+Shift+P), Checks tab (PR/CI state), History of archived workspaces.
- Release: performance work for 10+ panes, signed and notarized build, auto-update.

Gate: replaces the current terminal for 4 weeks.

**Phase 4 — Optional.** Swift + libghostty client, ACP side channel (A7), encrypted scrollback persistence (S5), license decision.

## 5. Feature specifications (one file per feature, in repo)

Every feature gets its own spec file in `docs/specs/`, written **before** implementing it and committed in the same stack entry as the code, or as the first commit of that entry.
- Naming: `docs/specs/<PRD-id>-<slug>.md`. Examples: `S1-daemon-owned-ptys.md`, `A4-new-workspace.md`, `D1-changes-panel.md`. UI-only or new-scope features use an `X<n>-` prefix (e.g. `X1-create-pr.md`, `X2-run-button.md`).
- `docs/specs/README.md` is the index table: ID, title, priority, phase, status (draft / approved / implemented), link.
- Template (`docs/specs/_template.md`): Summary · PRD refs · User journey · Behaviour & acceptance criteria (testable) · UI (sketch, shortcuts) · Protocol / RPCs touched · Data & config · Security considerations · Out of scope · Test plan · Open questions.
- The spec is updated whenever implementation diverges from it, so the spec always describes shipped behaviour. Status moves to `implemented` when the feature lands.
- Spike results (phase 0) go to `docs/adr/` instead. Specs reference the ADRs.

## 6. Cross-cutting from day one
- Security: socket dir `0700`, socket `0600`, `getpeereid` check; sanitize escape sequences before they reach notifications; OSC 52 opt-in; Tauri capability allowlist.
- Protocol versioning in the handshake from the first commit.
- Commit convention: conventional commits, one logical change each. Dependent parts ship as stacked PRs via `gh stack` (trunk `main`).

## 7. Top risks to watch
1. Replay fidelity of the daemon-side emulator compared with xterm.js. Spike S3 handles it; xterm.js `addon-serialize` is not an option in a Rust daemon.
2. Notification deep-link through Tauri (S5).
3. Daemon live upgrade (fd handoff). This is deferred to phase 3, but the PTY abstraction must allow it from phase 1.
4. Memory target of under 600 MB with 10 panes, given Monaco and WebGL contexts. Mitigation: one WebGL context per visible pane only, and lazy-load Monaco.

## Verification of this plan
- Each phase gate in section 4 is measurable and maps to a PRD success metric.
- Spikes S1–S5 produce numbers that confirm or reject each "spike" row in section 1 before phase 1 code is written.

## Bootstrap step (done)
Write this plan to `moonlet/docs/plan.md`. Add `docs/specs/README.md` (empty index) and `docs/specs/_template.md`. Save a memory noting that every moonlet feature needs a spec in `docs/specs/` before it is implemented. Commit it on a branch as `docs: add high-level implementation plan` after the user confirms.
