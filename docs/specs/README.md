# Feature specifications

Each feature of moonlet has its own spec in this directory. Write the spec before implementing the feature, and update it whenever the implementation diverges, so it always describes shipped behaviour.

- File name: `<PRD-id>-<slug>.md` (for example `A4-new-workspace.md`). UI-only or new-scope features use an `X<n>-` prefix.
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
| A4 | New workspace (agent task), superseded by X5 | P0 | 1 | superseded | [A4-new-workspace.md](A4-new-workspace.md) |
| S4 | Workspace restore after daemon restart | P1 | 3 | implemented (daemon) | [S4-restore-after-restart.md](S4-restore-after-restart.md) |
| D1 | Changes panel | P0 | 1 | implemented | [D1-changes-panel.md](D1-changes-panel.md) |
| D2 | Stage, unstage, revert, commit | P1 | 3 | implemented | [D2-stage-revert-commit.md](D2-stage-revert-commit.md) |
| F1 | File tree | P0 | 1 | implemented | [F1-file-tree.md](F1-file-tree.md) |
| X1 | Repo scripts and Run button | P1 | 3 | implemented | [X1-repo-scripts.md](X1-repo-scripts.md) |
| X2 | Create PR and Checks tab | P1 | 3 | implemented | [X2-pull-requests-and-checks.md](X2-pull-requests-and-checks.md) |
| T1 | Terminal emulation and rendering | P0 | 1 | implemented | [T1-terminal-emulation.md](T1-terminal-emulation.md) |
| T2 | Tabs, splits, keyboard-first workspaces | P0 | 1 | implemented | [T2-tabs-splits-workspaces.md](T2-tabs-splits-workspaces.md) |
| T3 | Shell integration (OSC 133 / OSC 7) | P1 | 3 | implemented | [T3-shell-integration.md](T3-shell-integration.md) |
| T4 | Command blocks | P1 | 3 | implemented | [T4-command-blocks.md](T4-command-blocks.md) |
| T5 | Command palette and scrollback search | P1 | 3 | implemented | [T5-palette-and-search.md](T5-palette-and-search.md) |
| A3 | Sidebar state and notifications | P0 | 1 | implemented | [A3-sidebar-and-notifications.md](A3-sidebar-and-notifications.md) |
| A5 | Approval inbox | P1 | 3 | implemented | [A5-approval-inbox.md](A5-approval-inbox.md) |
| D3 | Comment to agent | P1 | 3 | implemented | [D3-comment-to-agent.md](D3-comment-to-agent.md) |
| F2 | Code viewer with light editing, superseded by X26 | P1 | 3 | superseded | [F2-code-viewer.md](F2-code-viewer.md) |
| F3 | Open file from terminal output | P1 | 3 | implemented | [F3-open-from-terminal.md](F3-open-from-terminal.md) |
| M1 | Markdown preview (M1, M2) | P0 | 1 | implemented | [M1-markdown-preview.md](M1-markdown-preview.md) |
| S3 | Daemon upgrade without killing sessions | P1 | 3 | implemented | [S3-live-upgrade.md](S3-live-upgrade.md) |
| R1 | Remote hosts via system OpenSSH | P0 | 2 | implemented | [R1-ssh-hosts.md](R1-ssh-hosts.md) |
| R2 | Version-pinned, checksummed remote helper | P0 | 2 | implemented | [R2-remote-helper-install.md](R2-remote-helper-install.md) |
| R3 | Remote sessions survive disconnects | P0 | 2 | implemented | [R3-remote-sessions-reconnect.md](R3-remote-sessions-reconnect.md) |
| R4 | Local and remote hosts in one sidebar | P1 | 3 | implemented | [R4-unified-hosts-sidebar.md](R4-unified-hosts-sidebar.md) |
| S1b | Run the daemon under launchd | P0 | 2 | implemented | [S1b-launchd.md](S1b-launchd.md) |
| X3 | Signed, notarized app with auto-update | P1 | 3 | partial | [X3-distribution.md](X3-distribution.md) |
| X4 | Visual design (Superset look and feel) | P1 | 3 | implemented | [X4-visual-design.md](X4-visual-design.md) |
| X5 | Workspaces, projects and sessions (Conductor model) | P1 | 3 | implemented | [X5-workspaces-projects-sessions.md](X5-workspaces-projects-sessions.md) |
| T6 | Input editor with suggestions | P1 | 3 | implemented | [T6-input-editor.md](T6-input-editor.md) |
| T7 | Blocks shell model (one input, command blocks) | P1 | 3 | implemented | [T7-blocks-shell-model.md](T7-blocks-shell-model.md) |
| T8 | Block styling and input editor | P1 | 3 | implemented (fish bold command open) | [T8-block-styling.md](T8-block-styling.md) |
| T9 | Real command blocks (daemon-owned, on libghostty-vt) | P1 | 3 | draft | [T9-real-command-blocks.md](T9-real-command-blocks.md) |
| X6 | Structured agent view (Claude Code, Codex) | P1 | 3 | implemented (Codex untested live) | [X6-structured-agent-view.md](X6-structured-agent-view.md) |
| X7 | Permission mode picker (footer, new-session modal, Settings default) | P1 | 3 | implemented (UI unchecked in app) | [X7-agent-permission-mode.md](X7-agent-permission-mode.md) |
| X8 | Project settings (edit `.moonlet/config.toml` from the app) | P1 | 3 | implemented (dialog unchecked in app) | [X8-project-settings.md](X8-project-settings.md) |
| X9 | Open and copy links in agent messages | P1 | 3 | implemented (UI unchecked in app) | [X9-chat-links.md](X9-chat-links.md) |
| X10 | Sound when an agent finishes or needs you | P1 | 3 | implemented (sound not heard in app) | [X10-attention-sounds.md](X10-attention-sounds.md) |
| X11 | Stacked pull requests | P1 | 3 | implemented (UI unchecked in app) | [X11-pr-stacks.md](X11-pr-stacks.md) |
| X12 | End-to-end tests of the desktop app (WebdriverIO, embedded driver) | P1 | 3 | implemented (macOS) | [X12-e2e-tests.md](X12-e2e-tests.md) |
| X13 | Pull the base branch (sidebar chip when `main` is behind origin) | P1 | 3 | implemented | [X13-pull-base-branch.md](X13-pull-base-branch.md) |
| X14 | Collapsed tool calls and thinking rows in the agent view | P1 | 3 | implemented | [X14-collapsed-tool-calls.md](X14-collapsed-tool-calls.md) |
| X15 | GitHub owner avatar as the project icon | P1 | 3 | implemented (UI unchecked in app) | [X15-project-avatar.md](X15-project-avatar.md) |
| X16 | Response time and copy under the agent's final message | P1 | 3 | implemented | [X16-turn-footer.md](X16-turn-footer.md) |
| X19 | Run action modal with custom shortcuts | P1 | 3 | implemented | [X19-run-action.md](X19-run-action.md) |
| X20 | Plan approval card (Plan mode's `ExitPlanMode`) | P1 | 3 | implemented | [X20-plan-approval.md](X20-plan-approval.md) |
| X21 | Pixel loader in the sidebar row while a session archives | P1 | 3 | implemented (UI unchecked in app) | [X21-archive-loader.md](X21-archive-loader.md) |
| X22 | An agent opens a session in another project (`moonlet session new`) | P1 | 3 | implemented (skill untried with a live agent) | [X22-agent-opens-session.md](X22-agent-opens-session.md) |
| X23 | In-app confirm modal for every confirmation | P1 | 3 | implemented | [X23-confirm-modal.md](X23-confirm-modal.md) |
| X24 | Plan panel, and approving a plan into Auto | P1 | 3 | implemented (UI unchecked in app) | [X24-plan-panel.md](X24-plan-panel.md) |
| X25 | File explorer in the Files tab, changed files in the Changes tab | P1 | 3 | implemented (UI unchecked in app) | [X25-file-explorer.md](X25-file-explorer.md) |
| X26 | Files open as editor tabs, with VS Code syntax colours | P1 | 3 | implemented (UI unchecked in app) | [X26-file-tabs.md](X26-file-tabs.md) |
| X27 | Move from jaunt to moonlet without losing anything | P1 | 3 | implemented (untried against a real jaunt install) | [X27-moonlet-migration.md](X27-moonlet-migration.md) |
| X29 | Chat input `+` menu: attachments, commands, subagents and MCP servers | P1 | 3 | implemented (live sign-in unchecked in app) | [X29-chat-plus-menu-and-mcp.md](X29-chat-plus-menu-and-mcp.md) |
| X30 | Open project files from agent messages | P1 | 3 | implemented (click unchecked in app) | [X30-file-links-in-chat.md](X30-file-links-in-chat.md) |
| X31 | The agent reads a terminal tab, with the user's approval | P1 | 3 | implemented (remote hosts and a live agent untried) | [X31-agent-reads-terminal.md](X31-agent-reads-terminal.md) |
| X32 | Workspaces above sections (today's workspaces become sections) | P1 | 3 | implemented (switcher look unchecked in app) | [X32-workspaces-and-sections.md](X32-workspaces-and-sections.md) |
| X33 | A Claude Code profile per workspace (separate subscriptions) | P1 | 3 | implemented (real second sign-in unchecked) | [X33-workspace-claude-profiles.md](X33-workspace-claude-profiles.md) |
| X34 | Context window meter and cost line in the chat footer | P1 | 3 | implemented | [X34-context-window.md](X34-context-window.md) |
| X35 | Check for updates and install them in the app | P1 | 3 | in progress | [X35-in-app-update.md](X35-in-app-update.md) |
