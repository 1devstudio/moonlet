# moonlet glossary

These terms are used the same way in the UI, the code, the protocol and the docs.

| Term | Meaning | Code |
|---|---|---|
| **Workspace** | A named, coloured scope such as "Personal" or "Acme", with its own sections, sessions and Claude profile. The sidebar shows one workspace at a time; the switcher moves between them. | `Workspace` |
| **Section** | A named set of projects inside a workspace, shown as one collapsible block in the sidebar (e.g. "1devstudio", "Side projects"). A project can be in more than one section, and in more than one workspace. | `Section` |
| **Claude profile** | A Claude Code config folder with its own login, settings, MCP servers and history. Each workspace uses one; the default is `~/.claude`. | `ClaudeProfile` |
| **Project** | A git repository folder on disk (local or on a remote host). | `Project` |
| **Session** | One task inside a project, in one workspace: a git worktree on its own branch, plus the agents and shells working in it. Created from the composer ("What do you want to work on?"). | `Session` |
| **Terminal** | One PTY owned by `moonletd` (an agent TUI, a shell, a run script). A session has one or more terminals. | `Terminal` |
| **Block** | One command run in a shell terminal: the command line, its output, its exit status and timing. A shell terminal in Blocks mode is a list of blocks followed by the input editor. The block of a command still running is the *active block*; a full-screen program started by a command belongs to that command's block. Output from before shell integration started is not a block. | `Block` |
| **Blocks mode** | How a shell terminal works by default: the shell draws no prompt, the input editor is the only input, and each command shows as a block. Its opposite is **Classic**, where the shell keeps its own prompt and you type into the terminal. | `blockMode` |
| **Agent** | The program running in an agent terminal: Claude Code, Codex, or a custom command. | `agent` |
| **Host** | A machine running `moonletd`: this Mac, or a remote host reached over SSH. | `Host` |
