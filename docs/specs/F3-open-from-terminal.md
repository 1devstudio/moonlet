# F3: Open a file from terminal output

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** F3

## Behaviour and acceptance criteria

- [x] Paths with an extension in terminal output (relative, `./`, `../`, `~/` or absolute, optionally `:line[:col]`) are underlined links. Version numbers and URLs are excluded.
- [x] Cmd-click opens the file in an editor tab of the main window at the line ([X26](X26-file-tabs.md)); before X26, `.md` files opened in Preview and everything else in the right panel's code viewer.
- [x] Relative paths resolve against the pane's OSC 7 directory, then the session's reported cwd, then its start cwd.
