# X8: Open and copy links in agent messages

- **Status:** implemented (2026-10-04): unit tests pass. The hover toolbar and ⌘-click have not been checked in the app yet.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2
- **Related:** [X6](X6-structured-agent-view.md) (structured agent view), [F3](F3-open-from-terminal.md) (links in terminal output)

## Summary

Links in the structured agent view were rendered but dead: the click handler cancelled every click so the app window never navigated, and nothing opened the URL anywhere else. X8 makes them usable. ⌘-click opens a link in the default browser, and hovering a link shows a small toolbar with **Open** and **Copy** buttons.

## User journey

1. The user asks the agent for a URL. The answer shows it as a link (a bare URL, a Markdown link, or a URL in backticks).
2. ⌘-click on the link opens it in the default browser. A plain click does nothing, so text selection still works.
3. Hovering the link shows a toolbar just above it: Open (opens in the browser) and Copy (copies the URL and shows a "Copied link" toast).
4. Moving the pointer from the link onto the toolbar keeps it open. Leaving both, or scrolling, hides it.

## Behaviour and acceptance criteria

- [x] Bare URLs and Markdown links render as links (markdown-it `linkify`, unchanged).
- [x] An inline code span that is exactly one `http(s)` URL renders as a link around the code. Other inline code and fenced blocks are not linked.
- [x] Only `http:`, `https:` and `mailto:` links can be opened or copied from the toolbar; other links (relative paths, `file:`) stay inert.
- [ ] ⌘-click opens the link via the opener plugin; a plain click never navigates the app window.
- [ ] Hover shows the Open/Copy toolbar; it hides 150 ms after the pointer leaves the link and toolbar, and immediately on scroll or resize.
- [ ] Copy writes the URL to the clipboard and shows "Copied link".

## UI

A 2-button floating toolbar (ExternalLink, Copy icons), styled like the app's menus, placed above the link, or below it when the link is near the top of the window. Links underline on hover.

## Protocol and RPCs

None.

## Data and config

None.

## Security considerations

Agent output is untrusted. Rendering stays markdown-it with HTML disabled plus DOMPurify; the inline-code link escapes the URL before it goes into `href`. Opening goes through `openableUrl`, which only accepts `http:`, `https:` and `mailto:`, and the opener capability scope (`opener:allow-default-urls`) allows the same set.

## Out of scope

- Opening file paths from agent messages in the code viewer.
- Links inside tool output and diffs.

## Test plan

- Unit (`src/lib/markdown.test.ts`): inline-code linking, escaping, `openableUrl` protocol filter.
- Manual: ask the agent for a URL; ⌘-click opens it; hover → Open and Copy work; scrolling hides the toolbar.

## Open questions

- None.
