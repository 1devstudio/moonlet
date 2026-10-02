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
