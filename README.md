# moonlet

An agent-first terminal for macOS. Run Claude Code, Codex and other coding agents side by side, each in its own git worktree. They keep running when you quit the app, close the lid or lose the network, on your Mac and on remote Linux hosts over SSH.

- **Workspaces → projects → sessions** (as in Conductor). A workspace groups projects (repo folders). Every session is a worktree on its own branch with its agent, terminals and diff. See [CONTEXT.md](CONTEXT.md).
- **Knows what agents are doing.** Hooks report working / needs input / done / failed. You get a notification, a badge, and one place listing every blocked agent (⌘K).
- **Review in place.** Changes against the base branch with hunk staging, comment-to-agent, file tree, code viewer and Markdown preview (with Mermaid). Then Create PR via `gh`.
- **Sessions you cannot lose.** `moonletd` owns every PTY. Reattach restores the screen and scrollback. Daemon upgrades hand live PTYs to the new binary.

## Layout

| Path | What |
|---|---|
| `crates/moonlet-proto` | Wire protocol (framed JSON + raw PTY bytes) |
| `crates/moonlet-core` | PTYs, terminal state, sessions, agent state, git, files, workspaces, shell integration |
| `crates/moonletd` | The daemon: socket server, `proxy` for SSH, live upgrade, launchd |
| `crates/moonlet-cli` | `moonlet` CLI: agent hooks, `notify`, `ls`, `pane run`, `rpc` |
| `apps/desktop` | Tauri 2 app: React + xterm.js + Monaco |
| `docs/` | [Plan](docs/plan.md), [protocol](docs/protocol.md), [feature specs](docs/specs/README.md), [ADRs](docs/adr), [manual checks](docs/manual-checks.md), [release](docs/release.md) |

## Develop

Requirements: Rust (stable), Node 22+ with pnpm, Xcode Command Line Tools.

```sh
pnpm install
pnpm dev            # builds moonletd + moonlet, starts Vite and the app
pnpm test           # cargo test --workspace && vitest
```

Use `MOONLET_HOME=/some/dir pnpm dev` to keep development state away from `~/.moonlet`.

Useful commands:

```sh
target/debug/moonletd status          # daemon info
target/debug/moonletd upgrade         # hand live sessions to a freshly built daemon
target/debug/moonlet ls               # sessions
target/debug/moonlet rpc repo.list    # any daemon method
target/debug/moonlet hooks install    # Claude Code + Codex hooks (also in Settings)
```

## End-to-end tests

```sh
pnpm e2e:build    # the app with an embedded WebDriver server, in target/e2e (a few minutes)
pnpm e2e          # drives the real app against a scratch daemon and repo
```

The tests never touch `~/.moonlet` or start a real agent. A failing test saves a screenshot in `apps/desktop/e2e/artifacts/`. See spec X12.

## Per-repo config

`.moonlet/config.toml` in a repository. Edit it by hand or in Project settings (the gear on a project in the sidebar, or `⋯` › Project settings…):

```toml
setup = "pnpm install"        # runs when a workspace is created
run = "pnpm dev"              # the Run button (⌘R)
archive = "docker compose down"
default_agent = "claude"
base_branch = "main"
[agents]
claude-yolo = "claude --dangerously-skip-permissions"
```

## Remote hosts

Settings › Remote hosts lists the aliases in your `~/.ssh/config`. moonlet installs a checksum-verified `moonletd` built for the host's platform into `~/.moonlet/bin`, only after you confirm. The app checks the helper's version when it connects and offers to reinstall on a mismatch. Linux helpers are built with `scripts/build-remote.sh` (needs `cargo-zigbuild`).
