# X1: Repo scripts (setup, run, archive) and Run button

- **Status:** implemented
- **Priority / phase:** P1 · phase 3 (new scope from the Superset/Conductor UI direction)

## Summary

Each repo can declare `setup`, `run` and `archive` commands in `.moonlet/config.toml`. Setup runs when a workspace is created, Run runs from the header's Run button, and archive runs before a workspace is archived.

## Behaviour and acceptance criteria

- [x] `workspace.run {id, script}` starts `run` or `setup` in a tab titled after the script. Running it again replaces the previous tab, so run panes don't pile up.
- [x] Scripts run through `$SHELL -lic` with the workspace env vars from [A4](A4-new-workspace.md).
- [x] A missing script is a clear error: "no `run` script in .moonlet/config.toml".
- [x] A new session opens on its agent's tab (or its shell, with no agent). Setup runs in a second tab beside it, in the background. The daemon starts the agent before setup, and the app opens a new session on its first terminal (`a_new_sessions_first_terminal_is_the_agent_not_setup`, `new-session.e2e.ts`).
- [x] Closing, stopping or restarting a running `run` or `setup` tab stops every process the script started. This includes jobs that the job-control shell moved to their own process group and that ignore SIGHUP. The signals escalate (SIGHUP, then SIGTERM after 1.5 s, then SIGKILL after 3 s more) until no process is left in the terminal's session, even after the shell itself has exited (`closing_a_run_tab_stops_jobs_that_outlive_the_shell`).
- [x] UI: a Run ▶ button and a Stop control. With no `run` script the button opens Project settings with the Run field focused ([X8](X8-project-settings.md)); before X8 it was disabled with a tooltip.
