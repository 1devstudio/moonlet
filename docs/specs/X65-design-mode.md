# X65 — Design mode: prototype with an agent, comment and edit by hand

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X64 (design systems), X45 (Tasks mode, the mode switch), X6 (structured agent view), X49 (queued messages), D3 (comments to the agent), X54 (new session composer), X22 (agent opens a session)
- **Related ADRs:** none yet

## Summary

Design mode is a third sidebar mode, next to Sessions and Tasks. It is for working out what a UI should look like before writing code, without running the project. A **design** is a prototype made of plain HTML pages that use one design system (X64). It belongs to the workspace, not to a project, and needs no worktree. The design screen puts the design's agent chat beside a **canvas** that shows the pages live at a chosen viewport. The user iterates in three ways: chatting with the agent, pinning **comments** on elements and sending them to the chat, and changing elements directly in a **visual editor** (move, resize, restyle, insert components, edit text). Every agent turn and every burst of manual edits is a **snapshot** that the user can go back to. When the design is settled, **Build it** starts a normal session in a project, with the design attached.

## User journey

1. The user presses ⌃⌘D, or clicks **Design** in the sidebar's mode switch. The sidebar lists the workspace's design systems and designs.
2. **New design** asks for a name, a design system and a brief ("Settings page with a left nav and a Git section"). moonlet creates the design and starts its agent with the brief. The design screen opens.
3. The agent writes `pages/index.html` from the design system's snippets and layouts. The canvas reloads each time a page file changes. The user watches the page take shape.
4. The user switches the viewport to Phone. The nav overflows. They press C, click the nav, type "Collapse into a menu on phone", and send. The comment goes into the chat as a message the agent understands, and stays on the canvas as a pin until it is resolved.
5. The user presses V for the visual editor, drags the Git section above General, changes the heading to the design system's `--text-lg` token, and double-clicks a label to reword it. The edits are saved as they are made. The agent's next turn starts with a list of them.
6. The user asks for "two more variants of the Git section". The agent adds `pages/git-a.html` and `pages/git-b.html`. The page tabs above the canvas show all three, and **Overview** shows them side by side.
7. History lists the snapshots. The user restores the one from before variant B.
8. **Build it** opens the New session composer in the design system's source project. The prompt is "Implement the Settings page design", and the design's pages are attached.
9. Any session's agent can open Design mode too: with `/moonlet-design new "<brief>"`, the agent runs `"$MOONLET_BIN" design new --system <slug> "<brief>"`, and moonlet shows a toast with **Open**.

## Behaviour and acceptance criteria

### Mode and storage

- [ ] The sidebar mode switch has three buttons: Sessions, Tasks and Design. ⌃⌘D opens Design and is a Run action (X19) that can be rebound. The mode is remembered per workspace (as X45).
- [ ] A design lives in `~/.moonlet/design/<workspace id>/designs/<slug>/`, with `design.toml` (name, design system slug, brief, the viewport last used, created time), `pages/*.html`, `assets/`, `comments.json` and `history/`.
- [ ] A page links its design system's `tokens.css` and `base.css` through `moonlet-design://<workspace>/systems/<slug>/…`, and may have its own `<style>` and inline scripts (menus that open, tabs that switch).
- [ ] Every element of a page has a `data-mid` attribute unique in the page. `moonlet design check <design>` reports missing or duplicate ids, and with `--fix` it adds the missing ones and renumbers the duplicates.

### The design's agent

- [ ] Each design has one agent terminal: Claude Code in the structured agent view (X6), owned by moonletd, in the design's folder, with the design system's folder given with `--add-dir`. It is restored after a restart (S4).
- [ ] The agent's first prompt is the brief, plus the design system's `GUIDE.md` path and the `moonlet-design` skill's design rules. The rules: use snippets and tokens, keep `data-mid` on every element, write one page per variant, and run the check after each change.
- [ ] Messages sent while the agent is busy queue as in X49.

### Canvas

- [ ] The canvas shows the current page in an iframe at the chosen viewport: Desktop 1440×900, Laptop 1280×800, Tablet 834×1112, Phone 390×844, or a custom size. It scales to fit, and the zoom can be set from 25% to 200%. ⌘0 fits, ⌘= and ⌘- zoom.
- [ ] Page tabs list `pages/*.html`, with `index.html` first. **Overview** shows every page side by side at the chosen viewport.
- [ ] When `design.changed` lists the shown page, or a file it links, the canvas reloads and keeps the scroll position and the selected element (by `data-mid`).
- [ ] A page that fails to load, or has a check problem, shows the problem in a bar above the canvas with **Ask the agent to fix**.

### Comments

- [ ] In comment mode (C), hovering outlines elements, and a click pins a comment box to the element under the pointer. ⌥-click selects its parent instead.
- [ ] A pin is saved in `comments.json` with its page, `data-mid`, the element's tag and up to 60 characters of its text, the comment, and its state (open or resolved).
- [ ] **Send** adds the comment to the chat as `Comment on <page> [data-mid=<id>] (<tag> "<text>"): <comment>`. **Send all** sends every unsent pin as one message, one line per pin.
- [ ] A pin whose element no longer exists after a reload moves to an **Orphaned** list in the comments panel. Resolving a pin hides it from the canvas. The comments panel lists every pin, with a filter for open and resolved.
- [ ] Comments work the same way on a design system's cards and layouts (X64), sent to the sync agent.

### Visual editor

- [ ] In edit mode (V), a click selects an element. Esc selects the parent, Tab and ⇧Tab select the next and previous sibling, and the breadcrumb above the canvas shows the ancestors. A **Layers** panel shows the page's element tree, and selecting there selects on the canvas.
- [ ] Double-clicking an element whose children are only text edits its text in place. Enter or a click outside commits, and Esc cancels.
- [ ] Dragging a selected element inside a flex, grid or normal-flow parent reorders it, with an insertion line where it will land. Dropping it on another container moves it there. An absolutely positioned element moves by its `left` and `top` instead.
- [ ] The handles of a selected element resize it, writing `width` and `height` in px. ⇧ keeps the aspect ratio. The inspector switches either value to `%`, `auto` or `fill`.
- [ ] The inspector edits the selected element's layout (display, direction, gap, alignment, grid columns), spacing (padding and margin per side), size, typography, fill, border, radius, shadow and opacity. Each field offers the design system's tokens first and also takes any value. A value that matches no token marks the element with an **off-system** dot.
- [ ] The component palette lists the design system's snippets by group, with a search field. Dragging a snippet onto the canvas, or picking it with an element selected, inserts it after the selection. Inserted markup gets fresh `data-mid` ids.
- [ ] Delete, ⌘D duplicate, ⌥⌘G wrap in a box, ⇧⌥⌘G unwrap, and ⌘C / ⌘V copy and paste elements between pages of the same design.
- [ ] ⌘Z and ⇧⌘Z undo and redo the editor's changes since the design was opened.
- [ ] Style changes are written as the element's inline `style`, and text changes as its text. Each change is saved to the page file within 500 ms, without editor outlines or attributes. Reading the saved file gives back exactly the edited page.
- [ ] While the agent is working, edit mode is read-only, with a bar that says "Claude is changing the design" and offers **Stop**. Comments still work.
- [ ] The next message to the agent after manual edits starts with `Edits by hand since your last turn:` and one line per element changed: page, `data-mid`, and what changed (moved, resized, restyled with the properties, text, inserted, deleted).
- [ ] A save whose file changed on disk since the canvas loaded it is refused. The canvas reloads and says "The page changed; your last edit was not saved".

### Snapshots and history

- [ ] A snapshot of `pages/` and `assets/` is taken when an agent turn ends and when manual edits stop for 10 seconds, if anything changed since the last one. Snapshots go to `history/<n>/` with the time and what made them (agent turn or edits by hand). The last 50 are kept.
- [ ] History lists the snapshots. Picking one previews it in the canvas, and **Restore** makes it the current design and records the restore as a new snapshot.

### Build it

- [ ] **Build it** opens the New session composer (X54) with the project set to the design system's first source project, the prompt `Implement the <design name> design`, and the design's pages and the design system's `tokens.css` as attachments.
- [ ] The design records the session started from it and shows it as a link in the design's header.

### Agent-started designs and CLI

- [ ] `"$MOONLET_BIN" design new --system <slug> [--name <name>] "<brief>"` creates a design, starts its agent, and prints it as JSON. The app shows a toast "`<session>` started the design `<name>`" with **Open**, and focus does not move (as X22).
- [ ] `/moonlet-design new "<brief>"` in a session makes the agent run that command, with the workspace's design system whose sources include the session's project, or asks which one when there are several.
- [ ] CLI: `moonlet design ls|new|open|check|rm`. `open` switches the app to the design.

## UI

```
┌ Design ──────────┬───────────────────────────────┬─────────────────────────────────────┐
│ Workspace ▾      │ Settings page · moonlet desk… │ index  git-a  git-b  Overview       │
│ Sessions Tasks D │                               │ [Desktop▾] 75%  ◎Comment ✥Edit  ⟲ ▾ │
│                  │  (structured agent chat, X6)  │ ┌─────────────────────────────────┐ │
│ DESIGN SYSTEMS   │                               │ │                                 │ │
│  moonlet desktop │  You: Settings page with …    │ │      canvas (sandboxed iframe)  │ │
│ DESIGNS          │  Claude: … wrote index.html   │ │                 ②               │ │
│ ● Settings page  │                               │ │                                 │ │
│ ○ Onboarding     │                               │ └─────────────────────────────────┘ │
│ + New design     │ [ message … ]   [Build it]    │ Layers │ Inspector │ Palette │ 💬 3  │
└──────────────────┴───────────────────────────────┴─────────────────────────────────────┘
```

- The chat panel and the canvas are resizable, and the chat panel can be collapsed (⌘\).
- The right rail switches between Layers, Inspector, Palette and Comments.
- Empty states: no design system yet, which points to X64's **New design system**; and no designs yet, with **New design**.

## Protocol and RPCs

- `design.list {workspace}` → `[{slug, name, system, updated_at, open_comments, agent_state}]`
- `design.create {workspace, name, system, brief, spawned_by?}` → the design. Starts its agent.
- `design.remove {workspace, slug}`
- `design.write_page {workspace, design, page, html, base_version}` → `{version}`, or the error `stale` when the file changed since `base_version`.
- `design.comments {workspace, design}`, `design.comment.put {…}`, `design.comment.resolve {…}`
- `design.history {workspace, design}`, `design.snapshot.restore {workspace, design, n}`
- `design.open {workspace, design}` asks the app to show a design (used by the CLI). It is sent to the app as the event `design.open`.
- The app registers the `moonlet-design://` URI scheme. It serves files through `design.file` (X64), and adds the editor bridge script and the canvas CSP to every HTML page it serves.

## Data and config

- `~/.moonlet/design/<workspace id>/designs/<slug>/` as above.
- `[design]` in `~/.moonlet/settings.toml`: `snapshot_keep = 50`, `viewports` (the user's custom sizes).

## Security considerations

- Pages are untrusted HTML and JavaScript written by an agent. The canvas iframe has `sandbox="allow-scripts"` and never `allow-same-origin`, so a page cannot reach the app, Tauri's IPC or another design.
- Every page is served with `Content-Security-Policy: default-src moonlet-design: data: blob: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'`. A prototype cannot fetch or post anywhere.
- The editor bridge talks to the app only through `postMessage`. The app accepts only messages from the canvas frame's window, with a known message type, and checks every `data-mid` and page name it gets before it writes anything.
- `design.write_page` writes only `pages/*.html` of the named design. The HTML it receives is written as is, and it is never rendered in the app's own webview.

## Out of scope

- Designs on remote hosts, and sharing designs between workspaces or people.
- Exporting to Figma or to Claude Design.
- Free drawing (vectors, pen tool), image editing, and multi-select editing (except copy and paste).
- Using real components or real data: pages are static HTML with the design system's styles.
- Turning the off-system inline styles into classes. The user asks the agent for that.

## Test plan

- Desktop `lib/` (Vitest, jsdom):
  - `designComments`: the comment line format, Send all's message, and orphaning against a reloaded page
  - `designEdits`: each editor operation applied to a captured page, compared with a literal expected HTML; serialization that strips editor attributes and round-trips exactly; the "Edits by hand" summary
  - `designTokens`: matching a value to a token and the off-system flag
  - `designViewport`: fit-to-canvas scale
  - the bridge's message validation
- Rust: the `data-mid` check and `--fix` on captured pages; the stale-write refusal; snapshot rotation keeping 50; path rejection.
- `crates/moonletd/tests/`: `design.create` with `spawned_by` sends the `design.open` toast event; `design.write_page` with a stale version.
- e2e `design-mode.e2e.ts` (a crucial feature, X12), with a fixture design and a fake agent binary:
  - ⌃⌘D opens Design mode
  - the canvas shows the page
  - a comment sent from the canvas appears in the chat
  - dragging an element and changing its padding token saves the page file
  - History restores a snapshot
- Screenshots with `e2e/snap.ts` of the design screen, the inspector and the comments panel.

## Open questions

- Should a design's agent and the sync agent count as sessions anywhere, for example in notifications (X47) and the approval inbox (A5)? The proposal: yes, labelled with the design's name.
- Should **Build it** attach screenshots of each page (needs X64's snapshot question answered) or only the HTML?
- Multi-select editing and alignment tools are left for a follow-up. Is that acceptable for the first version?
