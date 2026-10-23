# X65 — Design mode: prototype with an agent, comment and edit by hand

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X64 (design systems), X45 (Tasks mode, the mode switch), X6 (structured agent view), X49 (queued messages), D1 (Changes panel), X2 (pull requests), D3 (comments to the agent), X54 (new session composer), X22 (agent opens a session)
- **Related ADRs:** none yet
- **Design:** "PR 338 · Design mode screens" (Claude Design bundle, 2026-10-23). It has 27 boards:
  - screens 1–5, the design screen
  - the design system view, one card, a sync running and the sync's result
  - comment mode, edit mode, the overview, history and the canvas bars
  - Build it, and `/moonlet-design new` started from a session
  - the session flow A–F
  - the parts: both sidebars, the prototype page, the right rail and the cards

## Summary

Design mode is a third sidebar mode, next to Sessions and Tasks. It is for working out what a UI should look like before writing code, without running the project.

A **design** is a prototype made of plain HTML pages that use one design system (X64). The design screen puts an agent chat beside a **canvas** that shows the pages live at a chosen viewport. The user iterates in three ways:
- chatting with the agent
- pinning **comments** on elements and sending them to the chat
- changing elements directly in a **visual editor**: move, resize, restyle, insert components, edit text

Every agent turn and every burst of edits by hand is a **snapshot** that the user can go back to.

A design lives in one of three places:

- **Workspace design.** It has its own agent and no branch, and is stored under `~/.moonlet/design/`. It is for exploring before there is any work to do. **Build it** later starts a session with the design attached.
- **Session design.** It is made inside a session with `/moonlet-design`, and the session's own agent writes it. Its pages live in the session's worktree under `docs/design/<slug>/`, are committed on the session's branch, and ship in the same PR as the spec and the code they led to. The session gets a **Design** tab beside Changes, Files and Plan.
- **Project design.** This is a session design after its PR merged: it is found under `docs/design/` on the project's base branch. Design mode lists it read only, and it can be the start of a new design.

## User journey

### A workspace design

1. The user presses ⌃⌘D, or clicks the pen icon in the sidebar's mode switch. The sidebar lists the workspace's design systems and designs.
2. **New design** (⇧⌘N) asks for:
   - a name
   - a design system, with a line saying what it holds, such as "11 cards, 2 layouts, synced 3 days ago from moonlet"
   - a brief

   **Create design** (⌘↵) starts the design's agent with the brief, and the design screen opens.
3. The agent reads the design system and writes `pages/index.html`. A bar says "Claude is changing the design". The canvas shows "Claude is writing index.html" until the file exists, then reloads on every change.
4. The user switches the viewport to Phone. In Comment mode (C) they click the nav, type "Collapse into a menu on phone" and press ⌘↵. The comment goes into the chat and stays on the canvas as pin 1.
5. In Edit mode (V) the user:
   - drags the Git section above General
   - sets the heading's size to `--text-lg`
   - rewords a label

   A chip says "3 edits by hand · go with your next message". The next message tells the agent what changed.
6. The user asks for two more variants of the Git section. The agent adds `git-a.html` and `git-b.html`. **Overview** shows the three pages side by side, each labelled ("rows", "cards", "compact").
7. History lists the snapshots. The user previews the one from before variant B, then goes back to the current state.
8. **Build it** opens the New session composer in the design system's first source project. The design is its source, the pages and `tokens.css` are attached, and the prompt reads "Implement the Settings page design". The design's header then says "Building in moonlet · implement-settings-page".

### B session design: requirements, design, spec, code in one session

1. In a session, the user and the agent agree on requirements in the chat.
2. The user types `/moonlet-design Prototype the page from the agreed requirements`. The chat input's slash menu explains the three forms: `/moonlet-design` (here, in this session), `new` (a separate workspace design) and `sync`. It also names the design system it will use.
3. The agent runs `"$MOONLET_BIN" design new --here …`. moonlet creates `docs/design/settings-page/` in the worktree, gives the agent read access to the design system, and opens the session's **Design** tab. The agent writes the pages there.
4. Comments and edits by hand on the Design tab go into the same session chat, as in journey A.
5. "Write the spec from the design" makes the agent write `docs/specs/X66-settings-page.md`. The spec has a `Design:` line, and its criteria name the elements they describe (`index.html` m24). Rejected variants are listed with the reason. The chat offers **Implement it** and **Back to the design**.
6. The Changes panel groups the files as Design, Spec and Code. Comments and snapshots stay in `.moonlet/` and are not committed.
7. **Implement it.** The agent writes the code, runs the checks and opens the PR. The PR's Design tab shows each page of the design beside a screenshot of the built screen. The PR description names the spec and the design.
8. After the merge, Design mode lists the design under **In projects**.

## Behaviour and acceptance criteria

### Mode switch and sidebar

- [ ] The sidebar mode switch has three icon buttons: Sessions, Tasks and Design (a pen). ⌃⌘D opens Design and is a Run action (X19) that can be rebound. The mode is remembered per workspace (as X45).
- [ ] In Design mode the sidebar shows, from the top:
  - **New design** ⇧⌘N
  - **Run action** ⌘K
  - **Design systems**, with a `+` to add one
  - **Designs**
  - a footer with settings and the folder path `~/.moonlet/design`
- [ ] A design system row shows its age, or `<n> changed`, `syncing` or `<n> to settle` (X64).
- [ ] A design row shows:
  - its agent's state dot
  - its open comments count, or its age
  - `session` for a session design
- [ ] The Design button shows an accent dot while a design started from a session (`/moonlet-design new`) is unseen.
- [ ] In Sessions mode, a session that has a design shows the pen icon on its row.

### Designs index

- [ ] Clicking **Designs** opens the index of the workspace's designs as cards with a thumbnail of the first page, in three groups:
  - **In sessions**: "Their pages live in the session's branch; open the session to change them". The card shows the project, the session and the folder, and has **Open session**.
  - **Workspace designs**: "Their own agent, no branch". The card shows the design system and either the page count or `built in <session>`, and has **Open**.
  - **In projects**: "Merged to main: found under docs/design/. Read only; reuse them as a start". The card has **Use as a start**, which copies the design into a new workspace design.
- [ ] Project designs are found on each project's base branch at the design folder (`docs/design/*/design.toml` by default), without checking anything out.

### Storage

- [ ] A workspace design lives in `~/.moonlet/design/<workspace id>/designs/<slug>/`, with:
  - `design.toml`: the name, the design system's slug, the brief, the viewport last used, the created time, the session it was built in, and `[pages.<name>] label = "…"`
  - `pages/*.html`
  - `assets/`
  - `comments.json`
  - `history/`
- [ ] A session design keeps `design.toml`, `pages/` and `assets/` in the worktree under the project's design folder, `docs/design/<slug>/` unless `.moonlet/config.toml` sets `[design] dir`. Its `comments.json` and `history/` live in `<worktree>/.moonlet/design/<slug>/`. moonlet writes a `.gitignore` of `*` into that folder, so they are never committed.
- [ ] A page links its design system's `styles.css` (X64), and nothing else from it, through `moonlet-design://<workspace>/systems/<slug>/…`. It may have its own `<style>` and inline scripts, such as menus that open or tabs that switch.
- [ ] Every element of a page has a `data-mid` attribute unique in the page (`m1`, `m2`, …). `moonlet design check <design>` reports missing or duplicate ids. With `--fix` it adds the missing ones and renumbers the duplicates.

### The agent

- [ ] A workspace design has its own agent terminal:
  - Claude Code, in the structured agent view (X6)
  - owned by moonletd and restored after a restart (S4)
  - started in the design's folder with the design system's folder given with `--add-dir`
  - in Accept edits mode
- [ ] A session design uses the session's agent. When the design is created, moonlet gives that agent read access to the design system's folder, as `/add-dir` does. The chat shows a note saying so.
- [ ] The first prompt is the brief. The chat shows a note that the brief went with the design system's `README.md` and the design rules. (The design export's boards say `GUIDE.md`; X64 follows design-sync and names it `README.md`.) The rules:
  - link only the design system's `styles.css`
  - start from its layouts (`ui_kits/`), the snippets in its cards, and its tokens
  - read a component's `.prompt.md` before using it, and use its classes instead of raw elements
  - keep `data-mid` on every element
  - write one page per variant and label it in `design.toml`
  - run the check after each change
- [ ] Messages sent while the agent is busy queue as in X49 ("Queue a message for Claude").
- [ ] A comment sent from the canvas shows in the chat as a **Comment from the canvas** card (**Comment from the Design view** in a session), numbered like its pin.
- [ ] Edits by hand show as an **Edits by hand since your last turn** block at the top of the user's next message.

### Design screen (workspace design)

- [ ] The chat panel on the left has:
  - a header with the design's name, `<design system> · <n> pages`, **Build it**, `⋯` and a collapse button (⌘\)
  - the chat
  - the input, with the model and the permission mode
- [ ] The canvas toolbar has:
  - page tabs, with a dot on the page the agent is writing, and **Overview**
  - the viewport menu: Desktop 1440×900, Laptop 1280×800, Tablet 834×1112, Phone 390×844, or a custom size
  - zoom, from 25% to 200% with − and +. ⌘0 fits, ⌘= and ⌘- zoom.
  - the mode switch: View, Comment (C) and Edit (V)
  - the History button and the right rail toggle
- [ ] A hint line above the page names the file and what the mode does, such as "Hover outlines elements · click pins a comment · ⌥-click picks the parent".
- [ ] The right rail has five tabs: Layers, Inspector, Palette, Comments (with a count) and History.
- [ ] In Edit mode the chat panel folds to a narrow rail with the agent's icon, so the canvas gets the room.

### Session Design tab

- [ ] A session with a design has a **Design** tab in its right panel, after Changes, Files and Plan, with a count of open comments.
- [ ] The tab has the same canvas toolbar, modes, bars and right rail as the design screen. Its chat is the session's chat, and the file path above the page is the worktree path.

### Canvas

- [ ] The canvas shows the current page in an iframe at the chosen viewport, scaled to fit unless zoomed.
- [ ] When `design.changed` lists the shown page, or a file it links, the canvas reloads. It keeps the scroll position and the selected element (by `data-mid`).
- [ ] Overview shows every page at the same viewport, with each page's file name, label and open comment count. Clicking one opens it.
- [ ] One bar at a time shows under the toolbar. Its colour says who has to act:
  - **orange**, while the agent works: "Claude is changing the design. Edit mode opens when it stops; comments still work", with **Stop**. In a session: "Claude is working in this session…".
  - **red**, when the page fails the check: "<page> has check problems: <summary>", with **Details** and **Ask the agent to fix**.
  - **red**, when the page does not load: "<page> did not load. <parse error> at line <n>", with **Ask the agent to fix**.
  - **yellow**, when a save raced a change on disk: "The page changed; your last edit was not saved. <the edit>", with **Dismiss**.
  - **blue**, while previewing a snapshot (see History).
  - **grey**, when the design system was removed: "Design system removed. Pages show without <name>'s styles."

### Comments

- [ ] In Comment mode, hovering outlines elements. A click opens a comment box pinned to the element under the pointer, and ⌥-click picks its parent. The box names the element (`nav · m12 · "General Appe…"`) and has **Keep** (save, not sent) and **Send** (⌘↵, "sends to the chat").
- [ ] A pin is saved in `comments.json` with:
  - its number
  - its page and `data-mid`
  - the element's tag and up to 60 characters of its text
  - the comment
  - when it was sent, if it was
  - its state: open or resolved
- [ ] **Send** adds the comment to the chat as `Comment on <page> [data-mid=<id>] (<tag> "<text>"): <comment>`. **Send all** sends every unsent pin as one message, one line per pin.
- [ ] The Comments tab:
  - has Open and Resolved tabs and a page filter ("All pages")
  - shows each sent pin as "Sent <time>" with **Show in chat** (which scrolls the chat to it) and **Resolve**
  - shows each unsent pin as "Not sent" with **Send** and **Resolve**
  - has a footer "<n> not sent yet, one line each" with **Send all**
- [ ] A pin whose element no longer exists after a reload moves to **Orphaned**, with "The element is gone after the last change" and **Resolve**.
- [ ] Comments work the same on a design system's cards (X64).

### Visual editor

- [ ] In Edit mode, a click selects an element. Esc selects the parent, and Tab and ⇧Tab select the next and previous sibling. A breadcrumb above the page shows the ancestors (`body › main m20 › section m24`). The Layers tab shows the page's element tree, and selecting there selects on the canvas.
- [ ] Double-clicking an element whose children are only text edits its text in place. Enter or a click outside commits, and Esc cancels.
- [ ] Dragging a selected element inside a flex, grid or normal-flow parent reorders it. An insertion line shows where it will land, and the hint line says where ("Drop to move above General"). Dropping it on another container moves it there. An absolutely positioned element moves by its `left` and `top` instead.
- [ ] The handles of a selected element resize it, writing `width` and `height` in px. ⇧ keeps the aspect ratio.
- [ ] The Inspector shows the selected element's tag and `data-mid`. It edits:
  - **Layout:** display, direction, gap, alignment, grid columns
  - **Spacing:** padding and margin
  - **Size:** width and height, as px, `%`, `auto` or `fill`
  - **Fill and border:** fill, border, radius
  - **Effects:** shadow, opacity
- [ ] Each Inspector field shows its token and value (`--space-1  4px`). Clicking it opens a popover with the matching tokens first, with their values, and a free-value field. Below the field it says "Any value works. One that matches no token marks the element off-system", and such an element gets an **off-system** dot.
- [ ] The Palette lists the design system's snippets by group, with search. Dragging a snippet onto the canvas, or picking it with an element selected, inserts it after the selection with fresh `data-mid` ids.
- [ ] Delete removes an element, ⌘D duplicates it, ⌥⌘G wraps it in a box and ⇧⌥⌘G unwraps it. ⌘C and ⌘V copy and paste elements between pages of the same design.
- [ ] ⌘Z and ⇧⌘Z undo and redo the editor's changes since the design was opened. The toolbar has an undo button too.
- [ ] Style changes are written as the element's inline `style`, and text changes as its text. Each change is saved to the page file within 500 ms, without editor outlines or attributes. Reading the saved file gives back exactly the edited page.
- [ ] While the agent is working, Edit is locked (shown with a lock) and comments still work.
- [ ] The chip "<n> edits by hand · go with your next message" counts the edits not yet told to the agent. The next message starts with `Edits by hand since your last turn:` and one line per element: page, `data-mid`, and what changed (moved above `m22`, restyled with the properties, the new text, inserted, deleted).
- [ ] A save whose file changed on disk since the canvas loaded it is refused. The canvas reloads and shows the yellow bar.

### History

- [ ] A snapshot of `pages/` and `assets/` is taken when an agent turn ends and when edits by hand stop for 10 seconds, if anything changed. The last 50 are kept.
- [ ] Each snapshot has a type and a summary:
  - **Agent turn**, such as "Wrote git-a.html and git-b.html · 3 pages"
  - **Edits by hand**, such as "Moved section m24, restyled h2 m25, text of m30"
  - **Restored snapshot <n>**, such as "From 09:58"
- [ ] Picking a snapshot previews it read only, with the blue bar "Previewing the snapshot from <time>, <type>. Nothing changes until you restore it", **Back to current** and **Restore**. Restoring makes it the current design and records a Restored snapshot entry.

### Build it (workspace designs)

- [ ] **Build it** opens the New session composer (X54) with:
  - the project: the design system's first source
  - the design as the composer's source chip ("Design · Settings page")
  - the branch: `<prefix>implement-<design slug>`
  - attached: each page with its label, and the design system's `styles.css` closure (tokens, fonts, `components.css`)
  - the prompt: `Implement the <design name> design`
  - a note: "The project is the design system's first source. The design keeps a link to the session it starts."
- [ ] The design records the session. Its header shows "Building in <project> · <session>", and the Designs index shows "built in <session>".

### Session designs, spec and PR

- [ ] `/moonlet-design <brief>` in a session makes the agent run `"$MOONLET_BIN" design new --here "<brief>"`. This creates the session design with the workspace's design system whose sources include the session's project, and asks which one when there are several. It opens the session's Design tab and starts writing the pages in that same chat.
- [ ] The chat input's slash menu lists `/moonlet-design`, `/moonlet-design new` and `/moonlet-design sync`, each with what it does, and a footer naming the design system it will use.
- [ ] Asked to write a spec from a session design, the skill has the agent:
  - add `- **Design:** <design folder>` to the spec
  - name the `data-mid` of the element each criterion describes
  - list the pages it did not choose, with the reason

  Once the spec is written, the chat offers **Implement it** and **Back to the design** as suggested replies.
- [ ] In a session with a design, the Changes panel (D1) groups the changed files as **Design** (the design folder), **Spec** (`docs/specs/`) and **Code** (everything else), with a note that comments and snapshots are not committed.
- [ ] After implementing, the skill has the agent save a screenshot of each built screen at the page's viewport to `<worktree>/.moonlet/design/<slug>/built/<page>.png`, with `e2e/snap.ts` in moonlet or the project's own tool. The PR panel's Design tab shows each page beside its built screenshot ("Design and build"). The skill also has the agent put `Spec: <id> · Design: <folder>` at the top of the PR description.

### Agent-started workspace designs and CLI

- [ ] `"$MOONLET_BIN" design new --system <slug> [--name <name>] "<brief>"` creates a workspace design, starts its agent and prints it as JSON. The app shows a toast "<session> started the design <name>" with **Open**, and focus does not move (as X22).
- [ ] `/moonlet-design new "<brief>"` in a session makes the agent run that command, picking the design system as `--here` does.
- [ ] CLI: `moonlet design ls|new|open|check|rm`. `open` switches the app to the design.

## UI

The boards of the design export are the reference. Layout of the design screen:

```
┌ sidebar ─────────┬ chat ─────────────────────────┬ canvas ─────────────────────────────┬ rail ──────────┐
│ 1devstudio ▾     │ Settings page   [Build it →] ⋯ │ index • git-a git-b │ ⊞ Overview      │ Layers Inspector│
│ [▣][☑][✎]        │ moonlet desktop · 3 pages      │ [Desktop 1440×900▾] − 34% +  View│Comment│Edit ⟲ ▣ │
│ + New design ⇧⌘N │ ┌ brief went with README ┐    │ index.html  hint line                │ Palette Comments│
│ ⌕ Run action ⌘K  │ You: Settings page with …      │ ┌────────────────────────────┐       │ History         │
│ DESIGN SYSTEMS + │ Read / Write / Bash rows       │ │   page in sandboxed iframe │ ①     │                 │
│ DESIGNS          │ ① Comment from the canvas      │ └────────────────────────────┘       │                 │
│ ~/.moonlet/design│ [ Message Claude about the… ]  │                                      │ [Send all]      │
└──────────────────┴────────────────────────────────┴──────────────────────────────────────┴─────────────────┘
```

- Empty states:
  - no design system yet: "None yet. Build one from a project's code"
  - no designs: "A design starts from a design system", or "No designs yet"
  - a page not written yet: "Claude is writing index.html. The canvas shows it as soon as the file is saved, and reloads on every change"

## Protocol and RPCs

- `design.list {workspace}` → `[{slug, name, kind: "workspace" | "session" | "project", system, project?, session?, path, pages, updated_at, open_comments, agent_state, built_in?}]`
- `design.create {workspace, name, system, brief, session?, spawned_by?}` → the design. With `session` it is a session design in that worktree. Otherwise it is a workspace design, and its agent starts.
- `design.copy {workspace, from: {project, path}, name}` copies a project design into a new workspace design.
- `design.remove {workspace, slug}`
- `design.write_page {design, page, html, base_version}` → `{version}`, or the error `stale`
- `design.comments {design}`, `design.comment.put {…}`, `design.comment.resolve {…}`
- `design.history {design}`, `design.snapshot.restore {design, n}`
- `design.open {design}` asks the app to show a design: Design mode for a workspace design, the session's Design tab for a session design. It is sent as the event `design.open`.
- A design is addressed as `{workspace, slug}` or `{session, slug}`.
- The app registers the `moonlet-design://` URI scheme. It serves files through `design.file` (X64), and adds the editor bridge script and the canvas CSP to every HTML page it serves.

## Data and config

- Workspace designs: `~/.moonlet/design/<workspace id>/designs/<slug>/`.
- Session designs: `<worktree>/<design dir>/<slug>/`, committed. Their comments, history and built screenshots are in `<worktree>/.moonlet/design/<slug>/`, which is not committed.
- `.moonlet/config.toml`: `[design] dir = "docs/design"` (default).
- `~/.moonlet/settings.toml`: `[design] snapshot_keep = 50`, and `viewports` for the user's custom sizes.

## Security considerations

- Pages are untrusted HTML and JavaScript written by an agent. The canvas iframe has `sandbox="allow-scripts"` and never `allow-same-origin`, so a page cannot reach the app, Tauri's IPC or another design.
- Every page is served with `Content-Security-Policy: default-src moonlet-design: data: blob: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'`. A prototype cannot fetch or post anywhere.
- The editor bridge talks to the app only through `postMessage`. The app accepts only messages from the canvas frame's window, with a known message type, and checks every `data-mid` and page name it gets before it writes anything.
- `design.write_page` writes only `pages/*.html` of the named design. For a session design it resolves inside the worktree's design folder and rejects any path that leaves it.
- A project design is read from git objects (`git show <base>:<path>`), never checked out, and is rendered in the same sandbox.

## Out of scope

- Designs on remote hosts, and sharing designs between workspaces or people.
- Exporting to Figma or to Claude Design.
- Free drawing (vectors, pen tool), image editing, and multi-select editing (except copy and paste).
- Using real components or real data: pages are static HTML with the design system's styles.
- Turning the off-system inline styles into classes. The user asks the agent for that.
- Comparing design and build pixel by pixel. The PR panel shows them side by side only.

## Test plan

- Desktop `lib/` (Vitest, jsdom):
  - `designComments`: the comment line, Send all's message, orphaning against a reloaded page, and the Comments tab's grouping and footer count
  - `designEdits`: each editor operation applied to a captured page, compared with a literal expected HTML; serialization that strips editor attributes and round-trips exactly; the "Edits by hand" block and the chip's count
  - `designTokens`: matching a value to a token, the popover's order, and the off-system flag
  - `designViewport`: fit-to-canvas scale and the zoom steps
  - `designBars`: which bar shows for a given state, one at a time, in priority order
  - `designsIndex`: grouping into In sessions, Workspace designs and In projects
  - `changesGroups`: Design, Spec and Code grouping
  - the bridge's message validation
- Rust:
  - the `data-mid` check and `--fix` on captured pages
  - the stale-write refusal
  - snapshot rotation keeping 50, and snapshot summaries
  - path rejection for workspace and session designs
  - the `.gitignore` written into `.moonlet/design/`
  - finding project designs on a base branch from a captured `git ls-tree` output
- `crates/moonletd/tests/`:
  - `design.create` with `spawned_by` sends the `design.open` toast event
  - `design.create` with `session` writes into the worktree
  - `design.write_page` with a stale version
- e2e `design-mode.e2e.ts` (a crucial feature, X12), with a fixture design and a fake agent binary:
  - ⌃⌘D opens Design mode, and the canvas shows the page
  - a comment sent from the canvas appears in the chat
  - dragging an element and setting its padding token saves the page file
  - History restores a snapshot
  - a session's Design tab shows a session design
- Screenshots with `e2e/snap.ts`, compared against the boards of the design export:
  - the design screen
  - the inspector with the token popover
  - the Comments tab
  - the Designs index

## Delivery plan

X64 and X65 ship as one `gh stack` on `main`. Each entry carries its criteria's tests and leaves `pnpm check` green. Entries marked e2e also run `pnpm e2e`, and UI entries are checked with `e2e/snap.ts` against the matching boards of the design export.

| # | Entry | Scope | Boards |
|---|---|---|---|
| 1 | `docs` | X64, X65, `CONTEXT.md` (this PR) | all |
| 2 | `core: design folder` | `moonlet-core::design`: `@dsCard` parsing, the static check, the `styles.css` closure, the manifest, foundation cards, the README index, `conventions.md` validation, `sourceKey` / `renderHash` / `_ds_sync.json`, the `data-mid` check and `--fix`; `moonlet design check` | — |
| 3 | `daemon: design store` | `~/.moonlet/design/` per workspace, the `design.*` RPCs, `design.changed`, `design.file`, stale-write refusal, snapshots, sync and design agent terminals with `--add-dir`, restore after restart; the CLI | — |
| 4 | `skill: moonlet-design` | The skill (four sync steps, grading, conventions header, design rules, session flow), installed and refreshed beside `moonlet` | — |
| 5 | `app: Design mode and design systems` | Mode switch (⌃⌘D), Design sidebar, New design system dialog, design system view, card page, sync step bar and docked agent, after-sync Needs you; e2e | 1, 2, DS view, one card, sync running, after the sync, both sidebars, DS cards |
| 6 | `app: render check and snap` | The `moonlet-design://` scheme with CSP, offscreen render for `--render` and `design snap`, the render rubric | one card |
| 7 | `app: design screen and canvas` | New design dialog, the design's agent chat, canvas, viewports, zoom, page tabs, Overview, bars, live reload; e2e | 3, 4, 5, Overview, canvas bars, prototype page |
| 8 | `app: comments` | Comment mode, pins, Keep and Send, Comments tab, Send all, orphaned, chat cards; e2e | comment mode on Phone, right rail |
| 9 | `app: visual editor, structure` | Select, Layers, breadcrumb, text editing, delete, duplicate, wrap, copy and paste, undo, save and the bridge, "Edits by hand" | edit mode |
| 10 | `app: visual editor, styling` | Drag to move, resize, Inspector, token popover, off-system, Palette; e2e | edit mode, right rail |
| 11 | `app: history and Build it` | Snapshots, History tab and preview, restore; Build it into the composer, "Building in"; e2e | History, Build it |
| 12 | `app: session designs` | `design new --here`, the session Design tab, read access for the session's agent, the slash menu, `/moonlet-design new` toast, Changes grouping, spec-from-design replies, the PR's Design and build, the Designs index with project designs; e2e | `/moonlet-design new`, A–F |

Entries 2–4 come first because everything in the app needs the folder format and the RPCs. 5 and 6 make the design system usable on its own, and moonlet's own desktop app is the first design system to build with it. 7–11 make workspace designs complete, and 12 brings designs into sessions.

## Open questions

- How does a running session's agent get read access to the design system (journey B, step 3)? Sending `/add-dir <path>` through the structured chat's input needs trying with Claude Code. If that fails, moonlet can copy the design system's `tokens.css`, `styles.css` and snippets into `.moonlet/design/<slug>/system/` in the worktree.
- Should a design's agent and the sync agent count as sessions anywhere, for example in notifications (X47) and the approval inbox (A5)? The proposal: yes, labelled with the design's name.
- Multi-select editing and alignment tools are left for a follow-up. Is that acceptable for the first version?
