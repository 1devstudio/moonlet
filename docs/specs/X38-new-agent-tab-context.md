# X38 — A new tab is an agent, and it can pick up earlier chats and plans

- **Status:** in progress (2026-10-13). ⌘T and ⇧⌘T are implemented; the empty chat's chips come with the next change.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** agent-first sessions
- **Related:** [T2](T2-tabs-splits-workspaces.md) (tabs and shortcuts), [X6](X6-structured-agent-view.md) (agent view), [X19](X19-run-action.md) (Run action shortcuts), [X24](X24-plan-panel.md) (plans), [X29](X29-chat-plus-menu-and-mcp.md) (mentions in the chat input)

## Summary

moonlet is agent-first, but ⌘T and the tab strip's `+` opened a shell. They now open an agent tab with the session's agent, and a shell tab moves to ⇧⌘T. A new chat often continues work done in another chat of the same session, so its empty view offers that work as context, the way Conductor does: the session's other chats ("Add chat transcripts") and the plans their agents wrote ("Add plans"). Clicking one writes it to a file in the worktree and mentions that file in the chat input, so the agent reads it with the first message.

## User journey

1. In a session, the user presses ⌘T (or clicks `+`). A new tab opens with the session's agent; it shows "New chat in `<worktree>`."
2. Below, "Add chat transcripts:" lists the session's other agent chats by their first message, and "Add plans:" lists the plans from those chats by their title.
3. The user clicks "Fix the login redirect". The input now holds `@.moonlet/context/chat-fix-the-login-redirect.md `, and the user types the task after it.
4. The agent reads the transcript file and continues from it.
5. For a shell, the user presses ⇧⌘T or picks **Terminal** in the `+` menu.

## Behaviour and acceptance criteria

- [x] ⌘T runs "New agent tab": it opens an agent tab with the session's agent, or Claude when the session has none (`agent` unset or "none").
- [x] The tab strip's `+` button and the empty session's button open an agent tab too.
- [x] ⇧⌘T runs "New terminal tab", which opens a shell as ⌘T did before. The `+` menu's **Terminal** item shows ⇧⌘T.
- [x] A key the user set for an action wins over another action's default: a user who had bound ⇧⌘T to another action keeps it, and "New terminal tab" then has no key until they give it one.
- [ ] A new agent chat with no messages shows "New chat in `<path>`.", with the path shortened to `~` under the home folder.
- [ ] "Add chat transcripts" lists the other structured agent chats of the same session that have at least one user message, running or exited, newest tab first. Each chip is named after the chat's first user message (its first line). The chat itself is not listed.
- [ ] "Add plans" lists the plans that agents of the session proposed with `ExitPlanMode`, newest first, one chip per plan file (or per plan text when there is no file). Each chip is named after the plan's first heading, or its first line.
- [ ] Each list shows four chips, then "+N more", which shows the rest.
- [ ] A section with nothing in it is not shown.
- [ ] Clicking a chat chip writes `<worktree>/.moonlet/context/chat-<slug>.md` with a heading and the chat's plain-text transcript (the same text as "Copy transcript"), and mentions it in the input.
- [ ] Clicking a plan chip writes `<worktree>/.moonlet/context/plan-<slug>.md` with the plan's text, and mentions it in the input.
- [ ] `<worktree>/.moonlet/context/.gitignore` holds `*`, so the files never show in Changes and are never committed.
- [x] `fs.write` creates missing parent folders.
- [x] A context file is never written through a symlink: when `.moonlet/context` leads outside the worktree, or a file in it is a symlink, the write is refused and the error shows as a toast.

## UI

```
New chat in ~/code/app.
Add chat transcripts:
[✳ Fix the login redirect] [✳ Why does CI time out] [✳ …] [✳ …]  +3 more
Add plans:
[▤ Move auth to the middleware] [▤ Split the settings page]
```

The block sits at the top left of the empty chat, in place of "Claude is ready". Chips use the agent's icon for chats and a clipboard icon for plans; long names are cut with an ellipsis and the full name is the chip's tooltip. The block goes away with the first message.

The `+` button's tooltip is "New agent (⌘T)". Its menu lists the agents, then **Terminal ⇧⌘T**, **Split right ⌘D** and **Split down ⌥⌘D**.

## Protocol and RPCs

- `fs.write` creates the file's missing parent folders before writing.
- `fs.write` takes an optional `root`. With it, the daemon refuses a path whose folder resolves outside `root`, a file that is a symlink, and a leftover temporary file at the write's temporary name; it never follows a symlink. The chips pass the worktree.
- The chips use `chat.state` (to read other chats) and `fs.write`; nothing new.

## Data and config

- `<worktree>/.moonlet/context/` holds the written context files and a `.gitignore` with `*`. Clicking the same chip again rewrites the same file with the chat's current transcript.
- Run action shortcuts are stored by action id. The id `new-tab` keeps ⌘T and now opens an agent; a user who rebound it keeps their key. `new-terminal` is the new shell action; its default ⇧⌘T gives way to a user's own ⇧⌘T for another action.

## Security considerations

- File names come from chat and plan text: the slug keeps only `a-z`, `0-9` and `-`, so a name can't leave `.moonlet/context/`.
- The worktree is repository content: a repository could commit `.moonlet/context` or `.moonlet/context/.gitignore` as a symlink to a file of the user's, such as `~/.zshrc`. The writes pass the worktree as `fs.write`'s `root`, so the daemon refuses them instead of overwriting the target.
- The transcript holds what the chat showed, including tool summaries. It stays in the worktree and is git-ignored.

## Out of scope

- Chats whose tab was closed: closing a tab deletes moonlet's copy of the conversation. Reading Claude's own transcripts (`~/.claude/projects`) could list them later.
- Chats from other sessions or projects.
- TUI agents: their empty screen is the agent's own.

## Test plan

- `apps/desktop/src/lib/agents.test.ts`: the agent a new tab opens.
- `apps/desktop/src/lib/runActions.test.ts`: ⌘T and ⇧⌘T map to the two actions and their labels; a key the user set wins over a default.
- `apps/desktop/src/lib/chatContext.test.ts`: the chat and plan chips and their order, the file names, the files' text, the `.gitignore`.
- `crates/moonlet-core/src/fs.rs`: `write` creates missing folders; `write_inside` refuses a symlinked folder or file and a symlinked temporary file, and leaves their targets untouched.
- `apps/desktop/e2e/specs/run-action.e2e.ts`: the label ⌘T now shows.

## Open questions

- None.
