# D3: Comment on a diff line and send it to the agent

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** D3, journey J4

## Behaviour and acceptance criteria

- [x] In the Changes diff, hovering the gutter shows a "+" glyph. Clicking it, using the context menu "Comment to agent", or pressing ⇧⌘M opens a comment box for that line.
- [x] Sending pastes into the workspace's agent (the focused agent pane, else the first live one) as one bracketed paste followed by Enter, formatted as `Review comment on <file>:<line>:` + the code line + the comment.
- [x] With no running agent, it shows an error and nothing is sent.
- [x] The task box under the terminals uses the same path for free-form prompts.

## Test plan

`src/lib/patch.test.ts`: `commentPrompt` format.
