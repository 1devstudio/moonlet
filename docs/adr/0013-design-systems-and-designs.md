# ADR 0013: Design systems and designs are files, laid out like design-sync's, rendered in the app's WebKit

- **Status:** proposed (2026-10-23); to be built in [X64](../specs/X64-design-systems.md) and [X65](../specs/X65-design-mode.md)
- **Builds on:** [ADR 0005](0005-workspace-project-session-terminal.md) (workspaces, projects, sessions) and [X22](../specs/X22-agent-opens-session.md) (the `moonlet` skill)

## Context

moonlet should let a user prototype UI before writing code, without running the project. That needs two things:
- a design system an agent builds from the project's code
- designs (prototypes) that a design agent builds with that design system, and that the user comments on and edits by hand

Claude Code's `/design-sync` already turns a React design-system repository into a design system for Claude Design. It writes a fixed layout:
- `README.md` for the design agent, starting with a conventions header
- `styles.css` made only of `@import` lines, plus `tokens/`, `fonts/` and `guidelines/`
- `components/<group>/<Name>/`, with a card whose first line is an `@dsCard` marker, and a `.prompt.md`
- a compiled `_ds_bundle.js`

It checks every card with a mechanical render check and a grading loop, and re-syncs from content hashes in `_ds_sync.json`. Its fidelity comes from the compiled bundle, which needs a React project with a build.

Three questions had to be settled:
- what a design system is on disk
- where design systems and designs live
- what renders and screenshots them

## Decision

**A design system is static HTML and CSS in design-sync's layout.**
- Same files and card marker, the same render rubric and grading, and the same hash-anchored re-sync.
- It has no compiled bundle, so it works for any stack. The `.prompt.md` documents markup and classes instead of props.
- moonlet adds what design-sync lacks:
  - foundation cards (colours, type, spacing), generated from the tokens
  - layouts in `ui_kits/`
- Because static cards are look-alikes, the sync is to grade them against the project's real render when the project has a Storybook or a dev server. X64's entry 6 ships design-sync's absolute rubric (Styled, Complete, Plausible) from moonlet's own screenshots; grading against the real render (`design snap --url`) is a follow-up.

**Design systems and workspace designs are daemon-owned files per workspace**, under `~/.moonlet/design/<workspace id>/`:
- `systems/<slug>/` for design systems
- `designs/<slug>/` for workspace designs

The source projects stay read only. The sync agent works in the design system's folder and reads the sources through `--add-dir`. Accept edits lets it write anything in that folder, so nothing moonlet trusts lives there: the sources, the commits of the last sync and the agent's chat are kept in `<workspace>/.records/<slug>.toml` beside the folders, and `config.toml` holds only what the agent may change (name, scope, card settings).

**A session design is committed in the project.**
- It is made inside a session and lives in the worktree under `docs/design/<slug>/`, so the design, the spec it led to and the code ship in one PR.
- It carries a pinned copy of the design system's styles (`system/`: `styles.css`, tokens, fonts, `components.css`), recorded with the design system's sync anchor. It therefore renders without the user's `~/.moonlet`: in the PR, after the merge as a read-only project design, and on another machine.
- The session's agent reads the full design system from a copy in `<worktree>/.moonlet/design/<slug>/system/`, which is not committed. No extra directory access is needed.
- Comments and snapshots stay in that uncommitted folder too.

**Rendering is the app's own WebKit.**
- Pages and cards render in a sandboxed iframe (`allow-scripts`, never `allow-same-origin`) on a `moonlet-design://` scheme whose CSP blocks the network.
- The render check measures the page in that frame.
- Screenshots for grading and for the PR's design-and-build view come from the app's WKWebView `takeSnapshot`, in a hidden window that is never shown, reached through Tauri's `with_webview`.
- Rendering therefore needs the moonlet app open. The CLI says so when it is not.

**What a design agent may do (checked with `claude -p` 2.1.309, 2026-10-23).**
- A deny rule `Edit(//<real path>/**)` in `--settings` blocks Edit and Write in a folder added with `--add-dir`, where Accept edits otherwise allows both; Read still works. The path must be the real one (`/private/tmp`, not `/tmp`).
- Claude Code refuses a Bash command that names its program through a variable (`"$MOONLET_BIN" design …`), even with a matching allow rule. Design agents get the real path of `moonlet` in their first message, and allow rules on that path: `<path> design system progress:*` and `<path> design snap:*`, and exactly `<path> design check`, `<path> design check --render` and `<path> design system synced`. A rule without `:*` matches only the command without arguments.

**Claude Code only, for now.** The sync relies on Claude Code's skills, subagents, `--add-dir` and its reading of screenshots.

## Considered options

- **Compile the real components, as design-sync does.** The highest fidelity, but it needs a React project with a build and a JS runtime in every page. The user chose static HTML so that any stack works.
- **Design systems in the source repository** (design-sync keeps `.design-sync/` there). Reuse across projects needs them outside any one repo, and the sync must not write into the sources.
- **Session designs linking the live design system.** This is simpler, but the committed pages would not render in a PR, after a merge or on another machine, and a re-sync would quietly change a design already reviewed.
- **Giving the session's agent access with `/add-dir`**, or restarting it with `--add-dir`. The first is untried through the structured chat. The second interrupts the session. Neither helps the committed design render elsewhere.
- **Headless Chrome or Playwright for screenshots** (Playwright is design-sync's choice). They are outside moonlet's runtime, and Playwright is a large download. Prototypes are viewed in WebKit inside moonlet, so WebKit screenshots are the faithful ones.

## Consequences

- The render check and snapshots need the app running. Syncs start from the app, or from a session that runs in it, so this is acceptable.
- The spike (2026-10-23, branch `spike/design-snapshot`, `apps/desktop/src-tauri/examples/design_snapshot_spike.rs`) confirmed this approach. Four 900×700 windows each loaded a page with a sandboxed iframe under the no-network CSP, served on a `moonlet-design://` scheme: on screen, placed off screen, hidden (`visible: false`, never shown), and on screen at zero opacity.
  - Every window took a correct snapshot about 0.8 s after the page finished loading: the iframe was painted and its script had run, `fetch` was blocked, and `parent` was unreachable (origin `null`).
  - Every window took a correct snapshot again after navigating to another page, and again after 15 s idle.
  - So a hidden window is enough: no off-screen placement, and nothing shows on the screen.
  - The snapshot is at 1× (900×700 px for a 900×700 window), which matches design-sync's captures. A `WKSnapshotConfiguration` can ask for a larger width if grading needs it.
  - Built in X64's entry 6: on a Retina Mac the hidden window snapshots at 2×, so the app asks for a `snapshotWidth` of the page's width divided by the window's backing scale, which gives one pixel per point again. The window's page load can finish before the render page's script runs, so the page says when it is ready for cards. The daemon sends renders only to the app that said `design.render.ready` on its local connection.
  - The app's own CSP will need `moonlet-design:` in `frame-src` for the canvas.
- A session design's pinned styles can fall behind the design system. The Design tab offers "Design system updated · Update", and the update is a commit like any other.
- The layout stays close enough to Claude Design's that an upload could be added later.
