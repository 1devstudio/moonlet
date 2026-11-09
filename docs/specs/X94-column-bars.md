# X94 — Column bars and panes: one header row and one tab row in every column, content in panes with no lines, and session tabs that scroll

- **Status:** implemented
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X46 (the task bar), X32 (the title bar), X26/X62/X77 (file, job and diff tabs)
- **Related ADRs:** none

## Summary

Every column of the window has the same two bars: a 44 px header row, and under it a 36 px tab row, both on the window's background. The window draws no lines: what a column shows sits in a pane, a rounded block of a lighter tone with 6 px between panes and at the window's edge, and the tab shown fills with the pane's tone so it joins it. The sidebar's top row, the session's header and the right panel's header line up; the session's tabs and the right panel's views line up under them. A session's header shows its task when it has one, and its name otherwise. Session tabs never show a scrollbar: they shrink, then scroll, with fades and chevrons on the side with hidden tabs and a list of every tab. The right panel's views go into a **More** menu when the panel is narrow.

## User journey

1. **A session on a task.** The header shows the task's glyph, its key (the tracker link), its title and its state as a pill. With several sessions on the task, `Session 1 of 2` with arrows follows. Under it, the session's tabs.
2. **A session without a task.** The header shows the session's name and its branch, then the tabs.
3. **Many tabs.** The tabs shrink to 112 px, then scroll. A fade and a chevron show on each side that has hidden tabs; the wheel scrolls them sideways. The **All tabs** button counts the tabs out of view and opens a list of every tab, filterable, with its status. Picking one scrolls it into view.
4. **A narrow right panel.** The views that do not fit go into **More**, with a count. The view shown always stays in the row.

## Behaviour and acceptance criteria

### Panes, no lines

- [x] The window's background is #161616, the sidebar's tone before X94: the sidebar, every header row and tab row sit on it. What a column shows sits in a pane: #121212, darker than the window (recessed), corners rounded 10 px, starting right under the column's tab row (or header row where it has no tabs). There are 6 px between panes, and between a pane and the window's right and bottom edges, and the left edge when the sidebar is closed. No border line separates columns, bars or panes; the columns still resize by dragging the gap between them. This holds in the session screen, Tasks mode, Design mode, Settings, an archived session and the start page. (`column-bars.e2e.ts` "draws no lines: the bars sit on the window's tone, what a column shows in a rounded pane 6 px from the next" for the session screen, and "fades a scrolling view's edges with more to show, only those edges, and keeps its overscroll in" for Settings' pane; Tasks, Design, the archived session and the start page by screenshot)
- [x] A terminal's background is the pane's tone, so a terminal fills its pane with no box around it. (`terminalTheme.test.ts`; `column-bars.e2e.ts` "fills the tab shown and the terminal with the pane's tone, so they join the pane")
- [x] Controls in a header (Run, Commit, the state pill) are filled #1F1F1F, #222222 on hover, not outlined. The state pill is 26 px and fully rounded. Menus are #1A1A1A. (`column-bars.e2e.ts` "fills the header's controls instead of outlining them, and the session shown in the sidebar" for Run; the pill and the menus by screenshot)

### Header row

- [x] The top row of the sidebar, of the session column, of the right panel, of Tasks mode, Design mode and Settings is 44 px high (Tasks mode's at least 44, growing when its board header wraps) on the window's background, with no line under it, and the window drags by it. The traffic lights sit in it, centred. (`column-bars.e2e.ts` "lines up a 44 px header row in the sidebar, the session and the right panel, with the 36 px tab rows under it")
- [x] A session on a task shows, in its header: the task's glyph, its key, its title on one line, cut with an ellipsis, and its state as a pill: a dot in the state's colour, the state's name and a chevron, which opens the state menu (X46). The key is the link to the issue in its tracker: muted, accent and underlined on hover. There is no separate tracker link. `Session <i> of <n>` with previous and next follows when the task has more than one session. (`tasks-mode.e2e.ts` shows the task bar on a session of a task with two sessions)
- [x] Under 560 px the state pill shows only its dot; the state menu still opens from it. A state the header can't move (gh's project scope missing) says why in the pill's tooltip, and the pill shows no chevron; so does a GitHub Project's item before its board's columns are known, which has no menu. (`tasks-mode.e2e.ts` "shows the task bar on a session of a task with two sessions")
- [x] A session without a task shows its name and its branch in its header. (`column-bars.e2e.ts` "heads a session without a task with its name and branch")
- [x] With the sidebar closed, the session's header starts clear of the traffic lights. (`column-bars.e2e.ts` "starts the header clear of the traffic lights while the sidebar is closed")

### Scrolling

- [x] A view that scrolls (a chat, a right panel view, a Settings page, the sidebar's list, a Tasks or Design view) keeps its overscroll in, so the window never bounces, and scrolls a focused item 24 px clear of its top edge. A 24 px fade from the view's tone (the pane's, or the window's in a sidebar) covers each edge with more to show, and only that edge; the fades stop 12 px short of the view's right edge, clear of its 10 px scrollbar. A long word wraps rather than scrolling the view sideways, except in a chat, a plan and a Settings page, which scroll sideways for wide tables and code. (`scrollEdges.test.ts`; `column-bars.e2e.ts` "fades a scrolling view's edges with more to show, only those edges, and keeps its overscroll in"; `chat-scroll.e2e.ts` "fades only the top at the end, keeps the overscroll in, and offers no Latest")
- [x] The scrollbar is 10 px wide: a rounded #2C2C2C thumb, #3A3A3A hovered, inset 3 px from its view's edge, its track stopping 10 px short of a pane's rounded corners. Dialogs and menus draw the same scrollbar. (screenshot)
- [x] A chat's transcript has 24 px above and below it, 28 px at its sides, and is at most 880 px wide; its composer has 4 px above, 14 px below and 16 px at its sides (12 px in a compact column). More than 240 px from its end, a chat or a job's output offers **Latest**, a pill at the bottom of the view that scrolls to the end. (`scrollEdges.test.ts`; `chatInput.test.ts` inputLayout; `chat-scroll.e2e.ts` "pads the transcript 24 px above and below and 28 at the sides, at most 880 wide, and the composer 4 above, 14 below and 16 at the sides" and "offers Latest once scrolled far from the end, which goes back to it")

### Font size

- [x] Bars and rows keep the heights above at the default font size and grow with a bigger one (Appearance › Font size), never shrinking with a smaller one: at 24 px a 44 px header is 81 px high, a 36 px tab row 66 px. Session tabs' 184 and 112 px grow the same way. The terminal's command line shows its whole line after a font size change. No sidebar label wraps onto a second line. (`column-bars.e2e.ts` "grows its bars and rows with the largest font size, so no text outgrows its row"; the tabs' widths by screenshot)

### Session tabs

- [x] The session's tab row is 36 px high, under the header. Tabs are 32 px high and sit on the row's bottom edge, 2 px apart, with no divider; a tab is 184 px wide at most and shrinks to 112 px before the row scrolls. The tab shown is filled with the pane's tone, its top corners rounded 8 px, so it joins the pane below; its label is brighter, weight 500, and its close button shows. The others have no fill, a muted label, #1A1A1A on hover, and their close button on hover. (`column-bars.e2e.ts` "lines up a 44 px header row in the sidebar, the session and the right panel, with the 36 px tab rows under it" and "shrinks crowded tabs to 112 px, then scrolls them with a fade and chevron on the side with hidden tabs")
- [x] The row never shows a scrollbar. A vertical wheel scrolls it sideways. (`tabOverflow.test.ts` wheelScroll)
- [x] A 56 px fade from the window's tone and a 24 px chevron show on each side with tabs out of view, and only there; the chevron scrolls the row by 60 % of its width, at least 160 px, smoothly unless Reduce motion is on. (`tabOverflow.test.ts` tabEdges, scrollStep; `column-bars.e2e.ts` "shrinks crowded tabs to 112 px, then scrolls them with a fade and chevron on the side with hidden tabs" and "scrolls the row with its chevrons")
- [x] The tab shown is scrolled into view at once, 40 px clear of the edge, when it changes: picked, opened or picked from the list. (`tabOverflow.test.ts` revealScroll; `column-bars.e2e.ts` "lists every tab in All tabs, filters them, and shows the one picked")
- [x] **All tabs** (the chevron after **+**) shows the number of tabs out of view, and opens a list of every tab: its status dot and name, and its status (Running, Needs input, Exited, Unsaved, Done, Failed, or nothing). A filter narrows it by name; "No tabs match" when nothing does. Picking one shows it. The list also holds what the chevron's menu held: a new agent of each kind, a terminal, and the two splits. (`tabOverflow.test.ts` hiddenTabs, filterTabs, tabStatus, tabRows; `column-bars.e2e.ts` "shrinks crowded tabs to 112 px, then scrolls them with a fade and chevron on the side with hidden tabs" and "lists every tab in All tabs, filters them, and shows the one picked")

### Right panel

- [x] The right panel's header is 44 px: Run filled, the stack, the PR at the right end before ⋯. Its controls keep the sizes they had before X94 (Run, the stack and the PR in 14 px text, 16 px of padding at each end); under 400 px the PR button drops its "PR" word, and under 340 px Run shows only its icon and the PR its number. (`column-bars.e2e.ts` "shows Run as its icon only in a right panel header under 340 px"; the PR's word and state by screenshot, as the e2e repository has no PR)
- [x] The views row is 36 px; its views are tabs like the session's: 32 px, the one shown filled with the pane's tone and rounded on top, weight 500, in 13 px text with 12 px of padding, as before X94. (`column-bars.e2e.ts` "lines up a 44 px header row in the sidebar, the session and the right panel, with the 36 px tab rows under it" for the height; text and padding by screenshot)
- [x] When the views do not fit, the last ones go into **More** with their count; the view shown always stays in the row, in its place, and another goes into More instead. More opens a menu of those views; picking one shows it. (`viewOverflow.test.ts` fitViews; `column-bars.e2e.ts` "puts the right panel's views that don't fit into More, keeping the one shown in the row")

### Sidebar

- [x] The sidebar sits on the window's background with no line beside it, the session shown filled with the pane's tone, and keeps the sizes it had before X94: New session, Run action and History as 34 px rows in 14 px text, a section's heading and a project's row 38 px, a session's row 38 px (34 px under a task line) in 14 px text. A label too long for its row is cut short on one line. (`column-bars.e2e.ts` "fills the header's controls instead of outlining them, and the session shown in the sidebar" and "grows its bars and rows with the largest font size, so no text outgrows its row")

## UI

From the design "column header & tab bar redesign", alternative B, "panes, no lines": header 44 px, padding 12 px left and 6 px right in the session column, 4 px left in the right panel; controls 28 px, radius 6; pills 26 px, fully rounded. Tab row 36 px, tabs 32 px; labels 13 px, muted, the shown one in the foreground colour.

Colours: moonlet.css's own, as before X94, on the desktop and the phone alike: window and sidebar #161616, pane, tab shown and terminals #121212, tab hover and menus #1A1A1A, control #1F1F1F, control hover #222222, borders #242424 and #2E2E2E, text #E6E6E6, muted #8C8C8C, faint #7D7D7D, accent #D97757.

## Protocol and RPCs

None.

## Data and config

None.

## Security considerations

None: layout only.

## Out of scope

- Reordering tabs by drag.
- Keyboard shortcuts for the right panel's views.
- The phone app's colours and the design system's cards (`ds/`).

## Test plan

- Vitest: `tabOverflow.test.ts` (edges, hidden count, reveal, wheel, scroll step, filter, status, the All tabs rows), `viewOverflow.test.ts` (fitViews, with the gaps between views), `scrollEdges.test.ts` (fades and Latest), `terminalTheme.test.ts` (the desktop terminal on the pane tone), `chatInput.test.ts` (the composer's sides).
- e2e: `column-bars.e2e.ts` (bars, panes, tabs and their overflow, All tabs, More, Settings' fades, the largest font size); `chat-scroll.e2e.ts` (a chat's padding, fades and Latest); `tasks-mode.e2e.ts` (the task header and its pill).
- Screenshots with `e2e/snap.ts` at full width and at a narrow window.

## Open questions

- None.
