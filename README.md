# jaunt

An agent-first terminal for macOS. Run Claude Code, Codex and other coding agents side by side, each in its own git worktree. They keep running when you quit the app, close the lid or lose the network, on your Mac and on remote Linux hosts over SSH.

- **Workspaces → projects → sessions** (as in Conductor). A workspace groups projects (repo folders). Every session is a worktree on its own branch with its agent, terminals and diff. See [CONTEXT.md](CONTEXT.md).
- **Knows what agents are doing.** Hooks report working / needs input / done / failed. You get a notification, a badge, and one place listing every blocked agent (⌘K).
- **Review in place.** Changes against the base branch with hunk staging, comment-to-agent, file tree, code viewer and Markdown preview (with Mermaid). Then Create PR via `gh`.
- **Sessions you cannot lose.** `jauntd` owns every PTY. Reattach restores the screen and scrollback. Daemon upgrades hand live PTYs to the new binary.

## Layout

| Path | What |
|---|---|
| `crates/jaunt-proto` | Wire protocol (framed JSON + raw PTY bytes) |
| `crates/jaunt-core` | PTYs, terminal state, sessions, agent state, git, files, workspaces, shell integration |
| `crates/jauntd` | The daemon: socket server, `proxy` for SSH, live upgrade, launchd |
| `crates/jaunt-cli` | `jaunt` CLI: agent hooks, `notify`, `ls`, `pane run`, `rpc` |
| `apps/desktop` | Tauri 2 app: React + xterm.js + Monaco |
| `docs/` | [Plan](docs/plan.md), [protocol](docs/protocol.md), [feature specs](docs/specs/README.md), [ADRs](docs/adr), [manual checks](docs/manual-checks.md), [release](docs/release.md) |

## Develop

Requirements: Rust (stable), Node 22+ with pnpm, Xcode Command Line Tools.

```sh
pnpm install
pnpm dev            # builds jauntd + jaunt, starts Vite and the app
pnpm test           # cargo test --workspace && vitest
```

Use `JAUNT_HOME=/some/dir pnpm dev` to keep development state away from `~/.jaunt`.

Useful commands:

```sh
target/debug/jauntd status          # daemon info
target/debug/jauntd upgrade         # hand live sessions to a freshly built daemon
target/debug/jaunt ls               # sessions
target/debug/jaunt rpc repo.list    # any daemon method
target/debug/jaunt hooks install    # Claude Code + Codex hooks (also in Settings)
```

## Per-repo config

`.jaunt/config.toml` in a repository:

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

Settings › Remote hosts lists the aliases in your `~/.ssh/config`. jaunt installs a checksum-verified `jauntd` built for the host's platform into `~/.jaunt/bin`, only after you confirm. The app checks the helper's version when it connects and offers to reinstall on a mismatch. Linux helpers are built with `scripts/build-remote.sh` (needs `cargo-zigbuild`).
