# Manual checks

These checks need a person at the app. Run them before each phase gate and record the results in an ADR if they fail.

| # | Check | Target | How |
|---|---|---|---|
| M1 | Keystroke-to-render latency | < 16 ms | Type in a local shell pane. Use Safari Web Inspector (Develop > moonlet > Timelines) and look at frame times. |
| M2 | Throughput | No UI stall | Run `cat` on a 50 MB log in one pane while typing in another. |
| M3 | 10 busy panes | < 600 MB total | Run 10 panes with `yes \| head -c 1G`. Check Activity Monitor for moonlet and the WebKit processes. |
| M4 | Notification click | Jumps to the pane | Block an agent, switch apps, click the notification. |
| M5 | Quit and reopen | Every pane restored | Run agents, quit with Cmd+Q, reopen. |
| M6 | Sleep | Sessions alive | Close the lid for 10 minutes and reopen. |
| M7 | launchd agent | Daemon restarts after a crash | Settings › "Start the moonlet daemon at login", then `pkill -9 -f 'moonletd daemon'`; `launchctl print gui/$UID/dev.onedevstudio.moonlet.daemon` shows it running again and workspaces are restored. |
| M9 | Visual parity | Matches the Superset reference | Create workspaces in different states (working, done, blocked, idle, no agent) and compare the window with the reference screenshot in the X4 spec. |
| M10 | Project settings (X8) | Edits `.moonlet/config.toml` in place. Automated by `pnpm e2e` (X12) except Reveal in Finder and the sidebar gear | With a scratch `MOONLET_HOME` and a scratch repo: open the dialog from the sidebar gear, the right panel `⋯` and the palette. Click Run with no `run` set: the dialog opens with Run focused. Save a run command: the Run button turns on without switching sessions and the file keeps its comments. Edit the file by hand while the dialog is open, then Save: "The file changed on disk", Reload works. Break the TOML: the dialog shows the error and Reveal in Finder. |
| M8 | Remote host | Same as local | Add an SSH host, accept the helper install, create a workspace there, drop the network (Wi-Fi off) for 30 s, then reconnect. |

## Results

| Date | Build | Check | Result |
|---|---|---|---|
| 2026-10-02 | debug (Vite dev server) | M3: 10 panes streaming `ls -la /usr/bin` every 50 ms, all visible in one 2×5 split | App 106 MB + WebContent 458 MB + GPU 48 MB + network 9 MB ≈ 620 MB. Daemon 175 MB with full 10k-line scrollbacks. CPU: app 9%, WebContent 10%, GPU 3%, daemon 5%. The client scrollback was then reduced from 10k to 5k lines; re-measure on a release build. |
| 2026-10-02 | debug | M5: quit with the agent pane open, reopen | Workspace selection and terminal screen restored from the daemon snapshot. |
| 2026-10-02 | debug | S3 in the app: `moonletd upgrade` while connected | App reconnected; shell output from before the upgrade still on screen; input works. |
| 2026-10-02 | release bundle (15.65 MiB) | M3 idle: 10 visible panes in a 2×5 split plus the Monaco diff open | App 111 MB + WebContent 262 MB + GPU 63 MB + network 9 MB ≈ **445 MB** (target < 600 MB). Idle CPU ≈ 4.5% in total. |
