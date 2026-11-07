# X92: The user's own messages show as Markdown

- **Status:** implemented (2026-11-07): unit tests pass; the desktop bubble's markup and styles were checked in the e2e app (`e2e/snap.ts`, staged markup), and the phone bubble at 390 px in a scratch page of the phone app's own component.
- **Priority / phase:** P2 · phase 3
- **PRD refs:** goal 2
- **Related:** [X6](X6-structured-agent-view.md) (structured agent view), [X9](X9-chat-links.md) (chat links), [X87](X87-copy-code-blocks.md) (copy a code block), [X40](X40-mobile-app.md) (phone app)

## Summary

Agent replies in the structured agent view render as Markdown, but a message the user sent showed as plain text: a fenced code block pasted into the composer appeared with its backticks, in the body font. X92 renders the user's bubble with the same Markdown renderer as agent replies, on the desktop and on the phone, so code blocks, inline code, lists and links look the same on both sides of the conversation.

## User journey

1. The user types a question and pastes a code block in a fence (three backticks, optionally a language).
2. They send it. Their bubble shows the question as text and the code block as code: monospace, on a code background, highlighted when the fence names a language.
3. Lines the user broke with a single Enter stay on separate lines, as they typed them.

## Behaviour and acceptance criteria

- [x] A fenced code block in a user message renders as a code block (`renderUserMarkdown`).
- [x] A code block in a user message has the same copy control as in agent replies (X87).
- [x] A single newline in a user message renders as a line break; agent replies keep Markdown's usual soft breaks.
- [x] HTML the user typed shows as text, never as markup (markdown-it with HTML disabled, then the chat sanitiser, as for agent replies).
- [ ] Links in the bubble behave as in agent replies (X9): a plain click never navigates the app window (component behaviour, manual check).
- [x] The phone app's bubble uses the same renderer; a long code line scrolls inside its block instead of widening the bubble (scratch page, 390 px).
- [x] Inline code in the bubble stands out from the bubble's background (visual check, `e2e/snap.ts`).

## UI

The bubble keeps its shape, colour and width (right-aligned, at most 85% of the column on the desktop). Its content uses the `.chat-md` styles of agent replies, plus `.user-md`, which gives inline code the app background, since the bubble already has the raised colour inline code uses elsewhere.

## Protocol and RPCs

None. The message text is unchanged; only how the app shows it.

## Data and config

None.

## Security considerations

The message text goes through the same path as agent text: markdown-it with `html: false`, then DOMPurify with the chat profile. Nothing the user types becomes markup or script.

## Out of scope

- File links (X30) in user messages: paths the user types stay text.
- The queued-message and side-question cards: they still show their text as typed.
- A preview of the formatting in the composer while typing.

## Test plan

- Vitest, `apps/desktop/src/lib/markdown.test.ts` › "the user's own messages (X92)": a fenced code block and its copy control, line breaks, typed HTML.
- Manual: `e2e/snap.ts` screenshot of a user bubble with a code block and inline code.

## Open questions

- None.
