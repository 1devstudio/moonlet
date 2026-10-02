# S1b: Run the daemon under launchd

- **Status:** implemented (manual launchd check pending, see test plan)
- **Priority / phase:** P0 · phase 2 (reliability NFR)
- **PRD refs:** NFR reliability ("the daemon runs as a launchd LaunchAgent, independent of the app process")
- **Related ADRs:** [0004](../adr/0004-launchagent-plist.md)

## Summary

On macOS, `jauntd` can run as a per-user LaunchAgent. launchd starts it at login and restarts it if it crashes; after a crash, workspaces come back through [S4](S4-restore-after-restart.md). Without the agent, the app still starts the daemon on demand, detached.

## Behaviour and acceptance criteria

- [x] `jauntd service install` writes `~/Library/LaunchAgents/dev.onedevstudio.jaunt.daemon.plist`:
  - `ProgramArguments` = this binary plus `daemon`;
  - `RunAtLoad`;
  - `KeepAlive {SuccessfulExit: false}`, so launchd restarts the daemon after a crash but not after a clean stop or upgrade;
  - `ProcessType Interactive`;
  - log paths under `~/.jaunt/logs`;
  - `JAUNT_HOME` when it is set.

  It then runs `launchctl bootstrap gui/<uid>`; reinstalling replaces the old registration.
- [x] `jauntd service uninstall` boots the agent out and removes the plist. Running sessions are not affected if a daemon is still serving.
- [x] `jauntd service status` prints whether the plist is installed and whether launchd has it loaded.
- [x] A second daemon that finds one already listening exits with code 0, so launchd does not loop on it.
- [x] Settings has a "Start the jaunt daemon at login" toggle that calls the bundled `jauntd service install|uninstall`.

## Security considerations

The plist is user-owned (`0644` in `~/Library/LaunchAgents`) and points at the app's own binary.

## Test plan

- Unit test: plist rendering (keys, escaping).
- Manual: install, `launchctl print gui/$UID/dev.onedevstudio.jaunt.daemon`, kill the daemon, confirm it restarts.
