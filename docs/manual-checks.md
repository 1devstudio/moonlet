# Manual checks

These checks need a person at the app. Run them before each phase gate and record the results in an ADR if they fail.

| # | Check | Target | How |
|---|---|---|---|
| M1 | Keystroke-to-render latency | < 16 ms | Type in a local shell pane. Use Safari Web Inspector (Develop > jaunt > Timelines) and look at frame times. |
| M2 | Throughput | No UI stall | Run `cat` on a 50 MB log in one pane while typing in another. |
| M3 | 10 busy panes | < 600 MB total | Run 10 panes with `yes \| head -c 1G`. Check Activity Monitor for jaunt and the WebKit processes. |
| M4 | Notification click | Jumps to the pane | Block an agent, switch apps, click the notification. |
| M5 | Quit and reopen | Every pane restored | Run agents, quit with Cmd+Q, reopen. |
| M6 | Sleep | Sessions alive | Close the lid for 10 minutes and reopen. |
