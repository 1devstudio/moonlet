# X38 — A new tab is an agent, and it can pick up earlier chats and plans

- **Status:** implemented (2026-10-13). Unit and e2e tests pass. The chips' look is not checked in the app yet.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** agent-first sessions
- **Related:** [T2](T2-tabs-splits-workspaces.md) (tabs and shortcuts), [X6](X6-structured-agent-view.md) (agent view), [X19](X19-run-action.md) (Run action shortcuts), [X24](X24-plan-panel.md) (plans), [X29](X29-chat-plus-menu-and-mcp.md) (mentions in the chat input)

## Summary

moonlet is agent-first, but ⌘T and the tab strip's `+` opened a shell. They now open an agent tab with the session's agent, and a shell tab moves to ⇧⌘T. A new chat often continues work done in another chat of the same session, so its empty view offers that work as context, the way Conductor does: the session's other chats ("Add chat transcripts") and the plans their agents wrote ("Add plans"). Clicking one writes it to a file in the worktree and mentions that file in the chat input, so the agent reads it with the first message.

## User journey

1. In a session, the user presses ⌘T (or clicks `+`). A new tab opens with the session's agent; it shows "New chat in `<worktree>`."
2. Below, "Add chat transcripts:" lists the session's other agent chats by their first message, and "Add plans:" lists the plans from those chats by their title.
3. The user clicks "Fix the login redirect". The input now holds `@.moonlet/context/chat-fix-the-login-redirect-3.md `, and the user types the task after it.
4. The agent reads the transcript file and continues from it.
5. For a shell, the user presses ⇧⌘T or picks **Terminal** in the `+` menu.

## Behaviour and acceptance criteria

- [x] ⌘T runs "New agent tab": it opens an agent tab with the session's agent, or Claude when the session has none (`agent` unset or "none").
- [x] The tab strip's `+` button and the empty session's button open an agent tab too.
- [x] ⇧⌘T runs "New terminal tab", which opens a shell as ⌘T did before. The `+` menu's **Terminal** item shows ⇧⌘T.
- [x] A key the user set for an action wins over another action's default: a user who had bound ⇧⌘T to another action keeps it, and "New terminal tab" then has no key until they give it one.
- [x] A new agent chat with no messages shows "New chat in `<path>`.", with the path shortened to `~` under the home folder. A chat without a working directory shows neither the line nor any chips.
- [x] "Add chat transcripts" lists the other structured agent chats of the same session that have at least one user message, running or exited, newest tab first. Each chip is named after the chat's first user message (its first line). The chat itself is not listed.
- [x] "Add plans" lists the plans that agents of the session proposed with `ExitPlanMode`, newest first, one chip per plan file (or per plan text when there is no file). Each chip is named as the Plan panel names the plan: its first heading, or its first line.
- [x] Each list shows four chips, then "+N more", which shows the rest.
- [x] A section with nothing in it is not shown.
- [x] Clicking a chat chip writes `<worktree>/.moonlet/context/chat-<slug>-<terminal id>.md` with a heading and the chat's plain-text transcript (the same text as "Copy transcript"), and mentions it in the input. Clicking it again doesn't add the mention twice.
- [x] Clicking a plan chip writes `<worktree>/.moonlet/context/plan-<slug>-<hash>.md` (an FNV-1a hash of the plan file's path, or of the text) with the plan's text, and mentions it in the input.
- [x] Two chats or two plans with the same title, or titles with no `a-z`/`0-9`, still get files of their own.
- [x] `<worktree>/.moonlet/context/.gitignore` holds `*`, so the files never show in Changes and are never committed.
- [x] `fs.write` creates missing parent folders.
- [x] A context file is never written through a symlink: when any folder between the worktree and the file is a symlink (even one that points inside the worktree), or the file is one, the write is refused and the error shows as a toast.
- [x] Writes of the same file at once, such as two quick chip clicks, all succeed.

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
- New `fs.write_inside {root, path, content}`: writes a file inside `root`, creating missing folders. It refuses a path outside `root` or with `..`, and any symlink between `root` and the file, the file included. Each write uses a temporary name of its own, created exclusively. A daemon older than this answers `unknown_method`, so the chip shows an error instead of writing without these checks.
- The chips use `chat.state` (to read other chats) and `fs.write_inside`.

## Data and config

- `<worktree>/.moonlet/context/` holds the written context files and a `.gitignore` with `*`. Clicking the same chip again rewrites the same file with the chat's current transcript; other chips never share it.
- Run action shortcuts are stored by action id. The id `new-tab` keeps ⌘T and now opens an agent; a user who rebound it keeps their key. `new-terminal` is the new shell action; its default ⇧⌘T gives way to a user's own ⇧⌘T for another action.

## Security considerations

- File names come from chat and plan text: the slug keeps only `a-z`, `0-9` and `-`, so a name can't leave `.moonlet/context/`.
- The worktree is repository content: a repository could commit `.moonlet/context` or `.moonlet/context/.gitignore` as a symlink to a file of the user's, such as `~/.zshrc`. A symlink to a tracked file inside the worktree (`.moonlet/context -> ../src`) would overwrite that file. The chips write with `fs.write_inside`, which refuses any symlink on the way instead of following it.
- The transcript holds what the chat showed, including tool summaries. It stays in the worktree and is git-ignored.

## Out of scope

- Chats whose tab was closed: closing a tab deletes moonlet's copy of the conversation. Reading Claude's own transcripts (`~/.claude/projects`) could list them later.
- Chats from other sessions or projects.
- TUI agents: their empty screen is the agent's own.

## Test plan

- `apps/desktop/src/lib/agents.test.ts`: the agent a new tab opens.
- `apps/desktop/src/lib/runActions.test.ts`: ⌘T and ⇧⌘T map to the two actions and their labels; a key the user set wins over a default.
- `apps/desktop/src/lib/chatContext.test.ts`: the chat and plan chips and their order, four chips then "+N more", an empty section hidden, no chips without a working directory, unique file names, the files' text, the `.gitignore`, the `root` on each write.
- `apps/desktop/src/lib/terminals.test.ts`: the path shortened to `~`.
- `crates/moonlet-core/src/fs.rs`: `write` creates missing folders. `write_inside` refuses a folder symlinked outside the root or inside it, and a symlinked file, leaving their targets untouched; a leftover temporary file never blocks or redirects a write; 8 threads writing one file at once all succeed.
- `apps/desktop/src/lib/plusMenu.test.ts`: a mention the input already has isn't added again.
- `apps/desktop/e2e/specs/run-action.e2e.ts`: the label ⌘T now shows.
- `apps/desktop/e2e/specs/new-agent-tab.e2e.ts`: with a fake `claude`, ⌘T and the `+` button open an agent, the new chat shows its folder and offers the first chat and its plan, each chip writes its file and mentions it, a symlinked context folder is refused with a toast, and ⇧⌘T and the `+` menu's **Terminal ⇧⌘T** open a shell. The empty session's button calls the same action as `+` and is not clicked.

## Open questions

- None.
