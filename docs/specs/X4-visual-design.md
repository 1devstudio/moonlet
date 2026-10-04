# X4: Visual design (Superset look and feel)

- **Status:** implemented (final pass after the panel-width change still to be eyeballed; see test plan)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** plan section 2 (UI direction). Reference: the screenshot the user provided on 2026-10-02 (Superset desktop).

## Summary

jaunt's look matches the reference: a neutral near-black UI with Claude's orange as the single accent. The terminal is the hero, and the chrome is quiet, typographic and dense. Sans for UI text, mono for metadata.

## Tokens

| Token | Value | Use |
|---|---|---|
| `bg` | `#121212` | Terminal area, main background |
| `panel` | `#161616` | Sidebar, right panel, tab strip |
| `raised` | `#1e1e1e` | Active tab, hover |
| `border` | `#242424` | Hairlines |
| `fg` / `muted` / `faint` | `#e6e6e6` / `#8c8c8c` / `#7d7d7d` | Text levels (`faint` is at least 4.5:1 on `bg`, readable for small hints) |
| `accent` | `#d97757` | Claude orange: selection bar, working spinner, prompts |
| `done` | `#3ecf6e` | Finished / ready for review |
| `blocked` | `#f2c94c` | Needs the user |
| `error` | `#ef5f5f` | Failed |
| `add` / `del` | `#3ecf6e` / `#ef5f5f` | Only in summaries; per-row counts are muted |
| `merged` | `#a371f7` | A merged pull request (GitHub's purple). Open PRs use `done`, closed PRs use `error` |

## Layout and components

- **Window:** traffic lights over the sidebar; no title bar or header. The 52px top bars (sidebar, tab strip, right panel, home) carry `data-tauri-drag-region`: dragging their empty space moves the window and double-clicking it maximizes or restores the window, like a native title bar.
- **Sidebar:**
  - **Nav rows** with icons: Workspaces (home), History (archived), + New Workspace.
  - **Groups:** one per repo (remote ones suffixed with the host). Headers are uppercase, letter-spaced, 11.5px, with a chevron and a count on the right.
  - **Workspace row**, one line: status glyph, then the name, then on the right either a muted mono diffstat (`+46 −1`) or a state word (`creating`, `needs input`, `failed`).
  - **Selected row:** `raised` background tinted toward orange, with a 2px orange bar on the left edge.
  - **Status glyphs:**

    | Workspace state | Glyph |
    |---|---|
    | Working | Animated orange vertical dots |
    | Blocked | Yellow dot |
    | Done | Green dot |
    | Error | Red dot |
    | Idle | Small grey dot |
    | No agent | Git-branch icon |
- **Centre:**
  - **Tab strip** at the top (46px, draggable). Tabs are ~170px wide with an agent icon (Claude ✻ in orange, Codex, Cursor, OpenCode, otherwise a terminal icon) and the name. The active tab is `raised`. A `+ ⌄` control holds new terminal, new agent and splits.
  - **Terminal:** padded by 28px, same background as the UI, with no frame.
  - **Prompt line:** below the terminal, a hairline then `❯ ▌ Type a task for Claude…` in mono with no box.
  - **Completion card:** bottom-right, floating, when an agent in the open workspace finishes or needs input. It shows the agent icon, the agent name, `finished · worked for 7s` (or `needs input`), the agent's message, and a footer with changed files and diffstat plus a Preview button that opens Changes. It dismisses itself after 12 s or on click.
- **Right panel:**
  - **Top row:** `▶ Run`, then `PR #827` (opens the PR; the icon takes the PR state colour, and a merged or closed PR adds `· merged` / `· closed`) or `PR` (Create PR), then a `⋯` menu (Open in…, Commit…, Archive).
  - **Tabs:** Files, Changes, Review.
    - **Files** shows changed files grouped by directory: an uppercase mono directory header, then rows with a status box icon (⊞ added, ⊡ modified, ⊟ deleted) and a muted count. It has an "All files" toggle for the full tree, and Markdown opens in the preview.
    - **Changes** is the diff viewer.
    - **Review** shows PR state, checks and commits.
  - **Summary line:** `+393 −42 · 5 files · → main` in mono.

## Acceptance criteria

- [x] A side-by-side comparison with the reference screenshot (demo state mirroring it) shows the same structure, palette, density and typography. Default panel widths were then narrowed to the reference proportions (sidebar 280, right 380).
- [x] No functionality is lost:
  - Run and PR are in the right panel top row; Open in, Commit, setup, sidebar toggle and Archive are in `⋯`.
  - The branch shows in the row tooltip and the Review tab.
  - Splits and new agents are in the tab strip `+ ⌄`.
  - ⌘\ toggles the right panel.

## Test plan

- Demo: fake agent scripts report state through `jaunt notify` (see [manual-checks](../manual-checks.md) M9).
- Compare the window screenshot with the reference.
