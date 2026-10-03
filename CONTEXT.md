# jaunt glossary

These terms are used the same way in the UI, the code, the protocol and the docs.

| Term | Meaning | Code |
|---|---|---|
| **Workspace** | A named set of projects shown as one collapsible block in the sidebar (e.g. "Work", "Personal"). A project can be in more than one workspace. | `Workspace` |
| **Project** | A git repository folder on disk (local or on a remote host). | `Project` |
| **Session** | One task inside a project: a git worktree on its own branch, plus the agents and shells working in it. Created from the composer ("What do you want to work on?"). | `Session` |
| **Section** | A user-named group inside a workspace that sessions can be moved into. | `Section` |
| **Terminal** | One PTY owned by `jauntd` (an agent TUI, a shell, a run script). A session has one or more terminals. | `Terminal` |
| **Agent** | The program running in an agent terminal: Claude Code, Codex, or a custom command. | `agent` |
| **Host** | A machine running `jauntd`: this Mac, or a remote host reached over SSH. | `Host` |
