# X87: Copy a code block in agent messages

- **Status:** implemented (2026-11-07): unit tests pass, and click, Enter and Space copied the block in the e2e app. The e2e driver sets no `:hover`, so the hover reveal was checked by forcing it visible, not with a real pointer.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2
- **Related:** [X6](X6-structured-agent-view.md) (structured agent view), [X9](X9-chat-links.md) (open and copy links), [X46](X46-tasks-in-sessions.md) (task descriptions)

## Summary

Agents answer with commands, snippets and config in fenced code blocks, and the user's next step is often to paste one somewhere. Selecting a block by hand catches too much or too little, and a long block scrolls. X87 adds a copy icon to the top-right corner of every fenced code block that chat Markdown renders. A click copies exactly the block's code.

## User journey

1. The agent answers with a fenced code block, for example a shell command.
2. The user moves the pointer over the block. A copy icon appears in its top-right corner.
3. The user clicks it. The block's code is on the clipboard and a "Copied code" toast says so.

## Behaviour and acceptance criteria

- [x] Every fenced or indented code block in chat Markdown has a copy control labelled "Copy code": agent replies, plans, subagent reports, side-question answers and task descriptions (X46). Inline code has none.
- [x] The control copies the block's code as the agent wrote it: highlighting removed, inner blank lines and indentation kept, and without the newline that ends the fence.
- [x] A click on the code itself copies nothing, so selecting text still works.
- [x] The icon shows while the pointer is over the block, or while the control has keyboard focus. On a touch screen (the phone app) it is always shown.
- [x] Copying shows a "Copied code" toast on the desktop; a failure shows an error toast.
- [x] Enter or Space on the focused control copies too.

## UI

A 22 px square icon button (the app's Copy icon) in the top-right corner of the block, over the code, on the block's background so code underneath stays legible. It fades in on hover and turns brighter under the pointer, as the link toolbar's buttons do.

## Protocol and RPCs

None.

## Data and config

None.

## Security considerations

Agent output is untrusted. The control is plain markup the renderer adds around each block (`<span role="button">`, because the sanitiser keeps forbidding `<button>`); its icon comes from the app's stylesheet, not from the message. The copied text is the block's `textContent`, so nothing in the message decides what lands on the clipboard other than the code that is shown.

## Out of scope

- Copy controls on tool output, diffs and file contents in tool calls; those are not chat Markdown.
- Copying a code block from the Markdown file preview (it renders in a sandboxed iframe with no scripts).

## Test plan

- Unit (`src/lib/markdown.test.ts`): each fenced block gets one "Copy code" control and inline code none; `codeToCopy` returns the block's code without highlighting or the final newline, and nothing for a click on the code.
- Manual: hover a code block in an agent reply, click the icon, paste; Tab to the control and press Enter. Screenshot with `e2e/snap.ts`.

## Open questions

- None.
