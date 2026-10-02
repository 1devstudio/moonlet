# Feature specifications

Each feature of jaunt has its own spec in this directory. Write the spec before implementing the feature, and update it whenever the implementation diverges, so it always describes shipped behaviour.

- File name: `<PRD-id>-<slug>.md` (for example `A4-new-workspace.md`). Features outside the PRD use an `X<n>-` prefix.
- Start each spec from [`_template.md`](_template.md).
- Status values: `draft`, `approved`, `implemented`.
- Spike results and stack decisions go to [`../adr/`](../adr/), not here.

## Index

| ID | Title | Priority | Phase | Status | Spec |
|----|-------|----------|-------|--------|------|
| S1 | Daemon-owned sessions | P0 | 1 | implemented | [S1-daemon-owned-sessions.md](S1-daemon-owned-sessions.md) |
| S2 | Reattach with screen and scrollback replay | P0 | 1 | implemented | [S2-reattach-replay.md](S2-reattach-replay.md) |
| A1 | Agent state per pane | P0 | 1 | implemented | [A1-agent-state.md](A1-agent-state.md) |
| A2 | One-click hook install | P0 | 1 | implemented | [A2-hook-install.md](A2-hook-install.md) |
| A6 | Local CLI and socket API | P1 | 3 | implemented (slice) | [A6-cli-and-socket-api.md](A6-cli-and-socket-api.md) |
| A4 | New workspace (agent task) | P0 | 1 | in progress (daemon done) | [A4-new-workspace.md](A4-new-workspace.md) |
| S4 | Workspace restore after daemon restart | P1 | 3 | implemented (daemon) | [S4-restore-after-restart.md](S4-restore-after-restart.md) |
| D1 | Changes panel | P0 | 1 | in progress (daemon done) | [D1-changes-panel.md](D1-changes-panel.md) |
| D2 | Stage, unstage, revert, commit | P1 | 3 | in progress (daemon done) | [D2-stage-revert-commit.md](D2-stage-revert-commit.md) |
| F1 | File tree | P0 | 1 | in progress (daemon done) | [F1-file-tree.md](F1-file-tree.md) |
| X1 | Repo scripts and Run button | P1 | 3 | in progress (daemon done) | [X1-repo-scripts.md](X1-repo-scripts.md) |
| X2 | Create PR and Checks tab | P1 | 3 | in progress (daemon done) | [X2-pull-requests-and-checks.md](X2-pull-requests-and-checks.md) |
