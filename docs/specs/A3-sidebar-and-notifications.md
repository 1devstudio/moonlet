# A3: Sidebar state and notifications

- **Status:** implemented
- **Priority / phase:** P0 · phase 1
- **PRD refs:** A3, journeys J2 and J3, metric "blocked to notified < 2 s"

## Summary

The sidebar lists repos (grouped by host when there is more than one) and their workspaces. Each row shows the most urgent agent state, the branch, the diffstat against the base, and an unread dot. macOS notifications fire when an agent needs the user and moonlet is not focused.

## Behaviour and acceptance criteria

- [x] **Row glyph:** working (spinner), blocked (pulsing ⚠), done (✓), error (✗), idle; the most urgent agent wins.
- [x] **Diffstat:** refreshed on `fs.changed` (debounced 400 ms) and every 20 s for background workspaces.
- [x] **Unread:** `agent.attention` for a session that is not on screen marks it. Viewing it clears it. The dock badge shows the number of unread blocked or failed sessions.
- [x] **Notifications:** sent when the window is not focused (optionally also when focused). The text is sanitised (escape sequences and control characters stripped, 200-character cap), titled "<workspace> needs you / is done / failed", with the host for remote ones. Each event can be switched off, and a repeat "done" stays quiet ([X47](X47-quieter-notifications.md)).
- [x] **Deep link:** clicking the notification activates moonlet. Tauri's notification plugin has no click callback on macOS, so the app cannot tell that click from any other activation. When moonlet is focused within 2 minutes of the last notification, it shows a toast with a "Go to" button and never moves panes on its own (manual check M4).
- [x] **Dismiss:** every toast has an × (Dismiss) at its right edge that closes it at once, leaving the user where they are. Toasts with an action still close on their own after 10 s. (`toasts.test.ts`: dismisses one toast and leaves the others, closes a toast with an action on its own after 10 s; `agent-opens-session.e2e.ts`: dismisses the toast without leaving the current session)
- [x] **Footer:** counts of working, blocked, done and failed agents. History lists archived workspaces with restore.
- [x] **Hooks:** one-click install lives in Settings ([A2](A2-hook-install.md)) and asks for confirmation, listing the files it edits.
