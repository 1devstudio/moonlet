# moonlet glossary

These terms are used the same way in the UI, the code, the protocol and the docs.

| Term | Meaning | Code |
|---|---|---|
| **Workspace** | A named, coloured scope such as "Personal" or "Acme", with its own sections, sessions and Claude profile. The sidebar shows one workspace at a time; the switcher moves between them. | `Workspace` |
| **Section** | A named set of projects inside a workspace, shown as one collapsible block in the sidebar (e.g. "1devstudio", "Side projects"). A project can be in more than one section, and in more than one workspace. | `Section` |
| **Claude profile** | A Claude Code config folder with its own login, settings, MCP servers and history. Each workspace uses one; the default is `~/.claude`. | `ClaudeProfile` |
| **Project** | A git repository folder on disk (local or on a remote host). | `Project` |
| **Session** | One piece of work inside a project, in one workspace: a git worktree on its own branch, plus the agents and shells working in it. Created from the composer ("What do you want to work on?"). | `Session` |
| **Terminal** | One PTY owned by `moonletd` (an agent TUI, a shell, a run script). A session has one or more terminals. | `Terminal` |
| **Block** | One command run in a shell terminal: the command line, its output, its exit status and timing. A shell terminal in Blocks mode is a list of blocks followed by the input editor. The block of a command still running is the *active block*; a full-screen program started by a command belongs to that command's block. Output from before shell integration started is not a block. | `Block` |
| **Blocks mode** | How a shell terminal works by default: the shell draws no prompt, the input editor is the only input, and each command shows as a block. Its opposite is **Classic**, where the shell keeps its own prompt and you type into the terminal. | `blockMode` |
| **Agent** | The program running in an agent terminal: Claude Code, Codex, or a custom command. | `agent` |
| **Subagent** | An agent that a chat's agent launches with its `Agent` tool to work on part of the task in the background. Listed in the Agents tab. Not the same as the subagent definitions offered in the `+` menu. | `Subagent` |
| **Queued message** | A message sent while the agent works, which the agent has not read yet. Claude reads it when the running step ends; **Send now** asks Claude to read it at once. | `QueuedMessage` |
| **Aside** | A side question answered from a chat's conversation by a separate, tool-less Claude, without touching the running turn or being added to the session. Claude Code's `/btw` in the terminal. | `chat.aside` |
| **Host** | A machine running `moonletd`: this Mac, or a remote host reached over the tailnet (paired once) or over SSH. Not "node" or "server". | `Host` |
| **Central host** | The always-on host that owns your sessions and runs their agents. Other devices are windows onto it. | `CentralHost` |
| **Worker** | A host that lends its CPU to a central host for heavy commands. The central host itself counts as one. | `Worker` |
| **Live copy** | A worker's copy of a session's files, kept in step with the central host both ways. | `LiveCopy` |
| **Routed command** | A heavy command, such as a test run, that an agent on the central host runs and that is carried out on a worker's live copy, with its output and exit status coming back. | `RoutedCommand` |
| **Project identity** | What makes two folders on different hosts the same project: the repository's origin and its first commit, never its path. | `ProjectIdentity` |
| **Task** | An issue in a task tracker (a Linear or Jira issue, a ClickUp task, a GitHub issue), shown in Tasks mode with the sessions working on it. A session works on at most one task; a task can have several sessions. | `Task` |
| **Tracker** | An issue tracker product moonlet connects to: Linear, Jira Cloud, ClickUp or GitHub Issues. | `TrackerKind` |
| **Connection** | One signed-in account of Linear, Jira Cloud or ClickUp on one site (a Linear organisation, a Jira site such as `acme.atlassian.net`, a ClickUp workspace). Its id is its tracker and site, such as `jira:acme.atlassian.net`. A tracker can have several connections. GitHub Issues has none of its own: it uses `gh`'s login, with the id `github:github.com`. | `Connection` |
| **Board** | One view of one tracker in a workspace, shown in Tasks mode: a Jira board or JQL query, a Linear team, a GitHub Project or repository, or a ClickUp list. It has the tracker's columns in its own order, each with a category (To do, In progress, In review, Done) and shown, folded or hidden; its filter; its sprint or cycle; and which projects its sessions start in. Saved in `~/.moonlet/trackers.toml` under `[[boards]]`, with the state mapping (X44) that gives its columns their categories. Replaced the old per-workspace sources and per-connection state mapping (X50). | `Board` |
| **Tracker project** | One Linear team, Jira project, ClickUp list or GitHub repository. A moonlet project links the tracker projects whose sessions start in it, in `.moonlet/config.toml` as a `trackers` entry, `<connection>/<key>`. | `ProjectConfig.trackers` |
| **Out of sync** | A task whose tracker state disagrees with its work, such as an issue still in a To do column while a session works on it, or still In Review when every session's PR is merged (on a board with one In review column, X50). Shown as an Out of sync chip with a one-click fix. | `Drift` |
