# X65 — Design mode: prototype with an agent, comment and edit by hand

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X64 (design systems), X45 (Tasks mode, the mode switch), X6 (structured agent view), X49 (queued messages), D1 (Changes panel), X2 (pull requests), D3 (comments to the agent), X54 (new session composer), X22 (agent opens a session)
- **Related ADRs:** [0013](../adr/0013-design-systems-and-designs.md)
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

   The design system is the one the sidebar shows, else the first, also when the workspace's design systems are listed only after New design opened (`lib/design.test.ts` picks the shown design system, else the first, also when the list comes after it opened).

   **Create design** (⌘↵) starts the design's agent with the brief, and the design screen opens. New design closed while its design is being made still makes it, but leaves the view and any dialog opened since as they are; a toast says "<name> was made", with **Open** (`lib/designStore.test.ts` shows the design and closes the dialog while it is still open, leaves the view and another dialog opened meanwhile as they are, and offers the design in a toast).
3. The agent reads the design system and writes `pages/index.html`. A bar says "Claude is changing the design". The canvas shows "Claude is writing index.html" until the file exists, then reloads on every change.
4. The user switches the viewport to Phone. In Comment mode (C) they click the nav, type "Collapse into a menu on phone" and press ⌘↵. The comment goes into the chat and stays on the canvas as pin 1.
5. In Edit mode (V) the user:
   - drags the Git section above General
   - sets the heading's size to `--text-lg`
   - rewords a label

   A chip says "3 edits by hand · go with your next message". The next message tells the agent what changed.
6. The user asks for two more variants of the Git section. The agent adds `git-a.html` and `git-b.html`. **Overview** shows the three pages side by side, each labelled ("rows", "cards", "compact").
7. History lists the snapshots. The user previews the one from before variant B, then goes back to the current state.
8. **Build it** opens the New session composer in the design system's first source project. The design is its source, its pages and styles are listed as attachments, and the prompt reads "Implement the Settings page design". Create copies the design into the new session as a session design, so the session has a Design tab and can go on to the spec and the PR as in journey B. The design's header then says "Building in moonlet · implement-settings-page".

### B session design: requirements, design, spec, code in one session

1. In a session, the user and the agent agree on requirements in the chat.
2. The user types `/moonlet-design Prototype the page from the agreed requirements`. The chat input's slash menu explains the three forms: `/moonlet-design` (here, in this session), `new` (a separate workspace design) and `sync`. It also names the design system it will use.
3. The agent runs `"$MOONLET_BIN" design new --here …`. moonlet creates `docs/design/settings-page/` in the worktree with a pinned copy of the design system's styles, copies the whole design system into the session's `.moonlet/` for the agent to read, and opens the session's **Design** tab. The agent writes the pages there.
4. Comments and edits by hand on the Design tab go into the same session chat, as in journey A.
5. "Write the spec from the design" makes the agent write `docs/specs/X66-settings-page.md`. The spec has a `Design:` line, and its criteria name the elements they describe (`index.html` m24). Rejected variants are listed with the reason. The chat offers **Implement it** and **Back to the design**.
6. The Changes panel groups the files as Design, Spec and Code. Comments and snapshots stay in `.moonlet/` and are not committed.
7. **Implement it.** The agent writes the code, runs the checks and opens the PR. The PR's Design tab shows each page of the design beside a screenshot of the built screen. The PR description names the spec and the design.
8. After the merge, Design mode lists the design under **In projects**.

## Behaviour and acceptance criteria

### Mode switch and sidebar

- [ ] The sidebar mode switch has three icon buttons: Sessions, Tasks and Design (a pen). ⌃⌘D opens Design and is a Run action (X19) that can be rebound. The mode is remembered per workspace (as X45). (`lib/mode.test.ts`; `lib/runActions.test.ts` resolves defaults, custom keys and removed keys; `lib/tasksView.test.ts` modeSwitch; `e2e/specs/design-mode.e2e.ts`)
- [ ] In Design mode the sidebar shows, from the top:
  - **New design** ⇧⌘N
  - **Run action** ⌘K
  - **Design systems**, with a `+` to add one
  - **Designs**
  - a footer with settings and the folder path `~/.moonlet/design`

  ⇧⌘N opens New design in Design mode and the New session composer elsewhere. **New design…** is a Run action of its own, whose ⇧⌘N works in Design mode only and there wins over **New session…**'s; from the Run action modal, New session… opens the New session composer in every mode, and New design… switches to Design mode and opens New design (`lib/keys.test.ts` opens the New session composer in Sessions mode, opens New design in Design mode, for the shown workspace, New session… in the Run action modal opens the New session composer, also in Design mode, New design… in the Run action modal opens New design for the shown workspace, in Design mode; `lib/runActions.test.ts` gives ⇧⌘N to New design… in Design mode and to New session… elsewhere (X65)). Before the workspace has a design system, New design is off and **Designs** says "A design starts from a design system"; then "No designs yet" until there is one (`lib/design.test.ts` says a design starts from a design system, or that there are no designs yet, once listed).
- [ ] A design system row shows its age, or `<n> changed`, `syncing` or `<n> to settle` (X64). (`lib/design.test.ts` a design system's sidebar row; `lib/designStore.test.ts` a workspace's design systems)
- [ ] A design row shows:
  - its agent's state dot
  - its open comments count, or its age
  - `session` for a session design

  Its dot is its agent's live state, else the one `design.list` gave. It says `needs you` while the agent asks or waits for an approval, and `unreadable` when its `design.toml` cannot be read; clicking it opens the design screen. `design.list` is asked for again after it failed, when the host comes back, and once more after a change during one, as `design.systems` is (`lib/design.test.ts` is its chat's live state, else the one design.list gave, and none without an agent, shows its agent's state and its age, counts its open comments in place of its age, says needs you while its agent asks a question or waits for an approval, has no dot without an agent, and says unreadable when its design.toml could not be read; `lib/designStore.test.ts` are asked for again after a listing failed, when the host comes back, are listed once more when something changes while a listing is on its way, so the last answer is the latest; `e2e/specs/design-screen.e2e.ts` makes a design with the New design dialog, and opens its screen with its agent's chat, shows every page in Overview with its label, and opens one from there). `session` comes with entry 12.
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

  Its slug comes from its name as a design system's does, and a name already used in the workspace gets a ` 2`; it is made only on a design system the workspace has. Every field of `design.toml` but the name and the design system has a default, so a file written before a field existed still loads (the viewport defaults to Desktop, `1440x900`). What moonlet trusts, its agent's chat, is kept in `<workspace id>/.records/designs/<slug>.toml`, outside the agent's folders, so the agent cannot change it without the user approving the edit. The workspace lists its designs by name; one whose `design.toml` cannot be read still lists, with its error, beside the others, and so does one whose record cannot be read: with that error, not as a design with no agent. A workspace with no designs folder has no designs, but a designs folder that is there and cannot be read fails the listing with the reason, rather than listing none. Removing a design deletes its folder and its record. (`design/designs.rs` a_new_design_gets_its_folder_and_design_toml_and_a_used_name_gets_a_number, a_design_needs_a_design_system_the_workspace_has, a_workspace_lists_its_designs_with_their_pages_labels_and_last_change, a_design_whose_design_toml_cannot_be_read_lists_with_its_error_beside_the_others, a_design_whose_record_cannot_be_read_lists_with_its_error_beside_the_others, a_designs_folder_that_cannot_be_read_fails_the_listing_with_its_reason, a_design_toml_written_before_its_newer_fields_still_loads, removing_a_design_deletes_its_folder_and_record_and_leaves_the_others)
- [ ] A session design keeps `design.toml`, `pages/`, `assets/` and `system/` in the worktree under the project's design folder, `docs/design/<slug>/` unless `.moonlet/config.toml` sets `[design] dir`. All of it is committed.
- [ ] A session design's `system/` is a pinned copy of the design system's styles: `styles.css`, `tokens/`, `fonts/` and `components.css`. `design.toml` records the design system's slug and the sync anchor the copy came from. The design therefore renders without `~/.moonlet`: in the PR, after the merge as a project design, and on another machine.
- [ ] A session design's `comments.json`, `history/` and built screenshots live in `<worktree>/.moonlet/design/<slug>/`, with the full design system copied to `system/` there for the agent to read (README, cards, `.prompt.md` files, layouts). moonlet writes a `.gitignore` of `*` into that folder, so none of it is committed.
- [ ] When the design system is synced after a session design pinned it, the Design tab shows "Design system updated" with **Update**. Update replaces both copies, records the new anchor, and lists the changed cards in the chat for the agent.
- [ ] A page links only its design system's `styles.css` (X64). For a workspace design the link is the relative `../../../systems/<slug>/styles.css` from `pages/<page>.html`, the live design system. It is relative, not `moonlet-design://<workspace>/…`, so a page framed on a host of its own (as cards are since entry 6b) loads it from that same host, which serves any file of the workspace's design folder under a CSP that allows only that host. For a session or project design it is the relative `../system/styles.css`. A page may have its own `<style>` and inline scripts, such as menus that open or tabs that switch. `moonlet design check <design>` reports every other stylesheet a page links, or imports with `@import` in its `<style>`, on the line the `@import` starts even when its URL is on a later one, and also when its quote or `url(` follows `@import` with no space, as minifiers write it (`@import"kit.css";`). An `@import` anywhere else in the page, as text in a paragraph or `<pre>` or in a script's string, is not CSS and is not reported (`design/designs.rs` checking_a_design_reports_ids_and_stylesheets_and_fix_gives_the_missing_ids, a_page_that_imports_another_stylesheet_in_its_style_is_reported_like_a_link, an_import_whose_url_is_on_the_next_line_is_reported_on_the_line_of_its_import, an_import_with_no_space_before_its_url_is_reported, an_import_written_as_text_outside_a_style_is_not_reported).
- [ ] Every element of a page's body, the `<body>` included, has a `data-mid` attribute unique in the page (`m1`, `m2`, …). The exceptions draw nothing of their own: `<script>`, `<style>`, `<template>`, `<noscript>`, and the inside of an `<svg>` (the `<svg>` itself has one). An id an exception already holds is never given to another element. `moonlet design check <design>` reports missing or duplicate ids. With `--fix` it adds the missing ones and renumbers the duplicates. (`design/mid.rs` elements_in_the_body_without_an_id_or_with_a_repeated_one_are_reported, fix_gives_missing_and_repeated_ids_the_next_free_numbers_and_leaves_the_rest, the_body_needs_an_id_too_and_fix_never_reuses_an_id_an_svg_part_holds; `design/designs.rs` checking_a_design_reports_ids_and_stylesheets_and_fix_gives_the_missing_ids; `moonlet-cli/tests/design_e2e.rs` a_designs_agent_checks_and_fixes_its_pages_from_its_folder.) In a design's folder `moonlet design check` needs no argument.

### The agent

- [ ] A workspace design has its own agent terminal:
  - Claude Code, in the structured agent view (X6)
  - owned by moonletd and restored after a restart (S4)
  - started in the design's folder with the design system's folder given with `--add-dir`
  - in Accept edits mode, with `--settings` deny rules `Edit(//<design system folder>/**)`, so it can read the design system but never edit it (Accept edits would otherwise accept edits in an `--add-dir` folder too)

  The design system's folder is its real path, and one with `*?[]{}` is refused, as for the sync agent's sources. (`design/agent.rs` a_designs_agent_reads_its_design_system_and_may_only_check_its_pages, a_design_system_folder_with_glob_characters_is_refused_for_a_design; `moonletd/tests/daemon.rs` a_new_design_starts_its_agent_in_its_folder_on_its_design_system, a_designs_agent_comes_back_after_a_restart)
- [ ] A session design uses the session's agent. It reads the design system from the copy in `.moonlet/design/<slug>/system/` inside the worktree, so it needs no extra directory access. The chat shows a note: "Design view opened. The design system is copied into the session for Claude to read".
- [ ] The first prompt is the brief. The chat shows a note that the brief went with the design system's `README.md` and the design rules. (The design export's boards say `GUIDE.md`; X64 follows design-sync and names it `README.md`.) The rules:
  - link only the design system's `styles.css`
  - start from its layouts (`ui_kits/`), the snippets in its cards, and its tokens
  - read a component's `.prompt.md` before using it, and use its classes instead of raw elements
  - keep `data-mid` on every element
  - write one page per variant and label it in `design.toml`
  - run the check after each change

  The rules are one text, `designs.md` of the `moonlet-design` skill, which the skill installs and the first message carries (`design/agent.rs` a_designs_agent_reads_its_design_system_and_may_only_check_its_pages; `hooks.rs` install_writes_the_moonlet_design_skill_beside_the_moonlet_skill; `moonletd/tests/daemon.rs` a_new_design_starts_its_agent_in_its_folder_on_its_design_system). The chat shows the note above the conversation, and the first message as the brief alone, only when it is as the daemon sends it (the brief, then `---` and the design); a later message that starts with the brief shows whole. `design.list` gives the brief; from an older daemon, which gives none, the first message shows whole (`lib/design.test.ts` shows the first message as the brief alone, since the README and the design rules went with it, keeps a later message that starts with the brief, or a first one not as the daemon sends it, whole, shows the first message whole when an older daemon's design.list gives no brief; `lib/chat.test.ts` is the user's text as the chat's own reading gives it, else as sent, leaves the agent's own messages as they are, tells the chat's own reading whether the message is the user's first; `e2e/specs/design-screen.e2e.ts` makes a design with the New design dialog, and opens its screen with its agent's chat).
- [ ] Messages sent while the agent is busy queue as in X49 ("Queue a message for Claude").
- [ ] A workspace design's agent notifies like a session's (X47): one "done" per turn, and when it needs you. The notification is labelled `Design · <name>`, and clicking it opens the design. Its approvals go to the approval inbox (A5) with the same label. Design agents show only in the Design sidebar, never in the Sessions list. The daemon tags a Design mode agent's terminal and `agent.attention` with `design: {kind: "sync" | "design", workspace, slug, name}`, which tells a design's agent from a sync agent and gives the label and what to open; `design: true`, saved before the tag, reads as a sync agent (`types.rs` a_terminal_saved_as_design_true_reads_as_a_sync_agent, a_design_agents_tag_names_its_kind_workspace_slug_and_name; `moonletd/tests/daemon.rs` a_new_design_starts_its_agent_in_its_folder_on_its_design_system, a_sync_agent_saved_as_design_true_comes_back_as_a_sync_agent; `lib/alerts.test.ts` alerts like a session, while a sync agent does not). The app labels the notification and the inbox's approval `Design · <name>`, and their click (the notification's **Go to**) opens the design; the agent counts as seen while its design screen is shown (`lib/alerts.test.ts` is Design · <name> for a design's agent, and opens the design, is the session for a session's agent, else the terminal's title; `lib/designStore.test.ts` opens its design on Go to, is on screen while its design screen is shown, which marks it seen). The Sessions list never shows it (`e2e/specs/design-screen.e2e.ts` shows its agent only in Design mode, never in the Sessions list).
- [ ] The sync agent (X64) does not notify per turn. It notifies when it asks a question, when it needs an approval, and when it finishes (`<name> synced · <n> to settle`). Its questions and approvals show in the design system view as X64's "The user in the loop" says (`lib/alerts.test.ts` never alerts like a session: Design mode notifies for it; `lib/designSync.test.ts` say when it asks, when it needs an approval, and when the sync is done).
- [ ] A design agent's questions and approvals show the same way in its design: the canvas's orange bar says "Claude asks…" or "Claude needs your approval", the chat panel opens on it (also when folded in Edit mode), and the design's sidebar row says `needs you`. The chat panel opens when the agent starts to ask, not again while it still waits, so a panel the user folded stays folded; the designs are listed again when its chat's asks change (`lib/designBars.test.ts` is orange when the agent asks or needs an approval, opens when the agent starts to need the user, and not again while it still does; `lib/design.test.ts` says needs you while its agent asks a question or waits for an approval; `lib/designStore.test.ts` are listed again when a design's agent asks something, so its row and bar say so; `e2e/specs/design-screen.e2e.ts` opens the folded chat when its agent asks for an approval, with the orange bar, and leaves it folded while it still waits).
- [ ] Design and sync agents start with their own `design` commands allowed, so they never ask: a design's agent `<moonlet> design check` and `<moonlet> design check --fix`, the sync agent those X64 lists. The rules name the real path of the `moonlet` binary, which the first message gives, since Claude Code's permission check refuses a command through a variable such as `$MOONLET_BIN` (X64). Edits inside their folder are covered by Accept edits. (`design/agent.rs` a_designs_agent_reads_its_design_system_and_may_only_check_its_pages, the_first_sync_agent_reads_the_sources_and_may_only_run_design_commands)
- [ ] A comment sent from the canvas shows in the chat as a **Comment from the canvas** card (**Comment from the Design view** in a session), numbered like its pin. A message of the user's shows as cards, one per line, only when every line of it is a comment's line; a card whose pin has another comment since, or is gone, has no number (`lib/designComments.test.ts` reads a line back as its page, element and comment, shows as Comment from the canvas cards, numbered like their pins, when every line is a comment's, leaves any other message as it is; `e2e/specs/design-comments.e2e.ts` opens a pin's comment box over the page, and Send puts it in the chat as a Comment from the canvas card). A message still queued (X49) shows as queued, its line as it is.
- [ ] Edits by hand show as an **Edits by hand since your last turn** block at the top of the user's next message.

### Design screen (workspace design)

- [ ] The chat panel on the left has:
  - a header with the design's name, `<design system> · <n> pages`, **Build it**, `⋯` and a collapse button (⌘\)
  - the chat
  - the input, with the model and the permission mode

  It is the structured agent view (X6) of the design's agent. Until entry 12, **Build it** is off, with a tooltip saying it comes later; `⋯` has **Remove design…**, which asks first and calls `design.remove`. ⌘\ folds the chat to a rail while the design screen is shown. Under the name: `<design system> · <n> pages`, or `no pages yet`. A design whose agent is not running says so (`lib/design.test.ts` names the design system and counts the pages, or says there are none yet; `lib/designViewport.test.ts` takes ⌘0 to fit, ⌘= and ⌘- to zoom, and ⌘\ to fold the chat; `lib/keys.test.ts` go to the design screen while it claims them, and back to the app once it lets go; `e2e/specs/design-screen.e2e.ts` makes a design with the New design dialog, and opens its screen with its agent's chat).
- [ ] The canvas toolbar has:
  - page tabs, with a dot on the page the agent is writing, and **Overview**
  - the viewport menu: Desktop 1440×900, Laptop 1280×800, Tablet 834×1112, Phone 390×844, or a custom size
  - zoom, from 25% to 200% with − and +. ⌘0 fits, ⌘= and ⌘- zoom.
  - the mode switch: View, Comment (C) and Edit (V)
  - the History button and the right rail toggle

  The page the agent is writing is a page of the latest `design.changed` of the design while its agent works. The viewport last used is saved in `design.toml` with `design.viewport`, and `design.list` gives it; a design from an older daemon, which gives none, shows at Desktop. The save keeps a page label the agent writes meanwhile, and goes through the design's folder found once from the workspace's designs folder, never through a folder swapped for a link. The app shows the latest pick at once and saves a design's picks one at a time, so a later pick is never undone by an earlier save coming back, and a failed save leaves it shown. The user's custom sizes, newest first and at most five, are kept in the app's settings and listed after the presets in every design's menu. The mode switch has View and Comment (C) since entry 8; Edit (V) comes with the editor (entry 9), and History with entry 11. C switches Comment on and off, also pressed in the page, but not while typing in a field, an editable element or a terminal, or with a modifier; Esc closes the comment box, else goes back to View; leaving Comment by C or the View button closes the box (`lib/designCanvas.test.ts` takes C to switch Comment on and off, and Esc to close the box or leave Comment, never while typing or with a modifier, is in a field, an editable element or a terminal, where C is text, closes the box whenever it leaves Comment, by C or the View button, closes the box on Esc, and on the next Esc goes back to View; `lib/designBridge.test.ts` reports C and Esc pressed in the page, but not C typed in a field; `e2e/specs/design-comments.e2e.ts` switches to Comment mode with C, which the hint line explains). (`lib/designCanvas.test.ts` is a page of the latest change to the design, while its agent works, is none of another design's or a design system's change; `lib/designViewport.test.ts` is Desktop, Laptop, Tablet or Phone, at their sizes, is saved and read as WxH, and anything else reads as none, reads as none when an older daemon's design.list gives none, is named by its preset, or Custom, is read from the width and height the user types, in whole px, steps from 25% to 200% with − and +, are listed after the presets, newest first, from what the settings keep, keep a new size first, once, never a preset's, and at most five; `design/designs.rs` a_designs_viewport_is_saved_in_its_design_toml_and_listed_with_its_brief, a_label_the_agent_writes_while_the_viewport_is_saved_is_kept, a_viewport_save_never_writes_through_a_design_folder_swapped_for_a_link; `lib/designStore.test.ts` shows and keeps the latest pick, whatever order the saves come back in, stays the latest pick when its save fails; `moonletd/tests/daemon.rs` the_viewport_a_design_was_last_shown_at_is_saved_and_listed; `e2e/specs/design-screen.e2e.ts` switches the viewport, which design.toml keeps, and zooms, keeps a custom size in the app's settings, listed after the presets)
- [ ] A hint line above the page names the file and what the mode does, such as "Hover outlines elements · click pins a comment · ⌥-click picks the parent". In View: "View: the page runs as in a browser, so its links, menus and scripts work"; in Overview: "Every page at the same viewport. Click a page to open it". (`lib/designCanvas.test.ts` says what View and Comment do in the hint line; `e2e/specs/design-comments.e2e.ts` switches to Comment mode with C, which the hint line explains)
- [ ] The right rail has five tabs: Layers, Inspector, Palette, Comments (with a count) and History. Since entry 8 it has the Comments tab, its count the design's open pins (the sidebar row's count); Layers and Inspector come with entries 9 and 10, Palette with 10 and History with 11. The toolbar's rail button shows and hides it, and Comment mode shows it (`lib/designCanvas.test.ts` shows the rail on entering Comment, by C or its button, and leaves it shown in View; `e2e/specs/design-comments.e2e.ts` shows and hides the right rail with its button, and Comment mode shows it).
- [ ] In Edit mode the chat panel folds to a narrow rail with the agent's icon, so the canvas gets the room.

### Session Design tab

- [ ] A session with a design has a **Design** tab in its right panel, after Changes, Files and Plan, with a count of open comments.
- [ ] The tab has the same canvas toolbar, modes, bars and right rail as the design screen. Its chat is the session's chat, and the file path above the page is the worktree path.

### Canvas

- [ ] The canvas shows the current page in an iframe at the chosen viewport, scaled to fit unless zoomed. The frame is `sandbox="allow-scripts"` on a host of its own, `moonlet-design://<key>.<workspace>/designs/<slug>/pages/<page>.html`, keyed by the page's path as a card is (X64), so a page that never stops running leaves the window answering When the picked page is gone it shows the first page, and before any page index, being written (`lib/designViewport.test.ts` fits the viewport into the canvas until zoomed, at most at 200%, fits into the canvas less a margin of 48 px around the frame, a card's as a page's; `lib/designCanvas.test.ts` is the one picked, or Overview, and the first page once the picked one is gone, or index before any; `lib/designPage.test.ts` is <page>.html in the design's pages/, and only such a path names a page; `lib/designView.test.ts` is served from its design's pages, on a host of its own that another page never shares; `e2e/specs/design-screen.e2e.ts` shows the page once it is written, and loads it again when it is written again, leaves the window answering while a page never stops running).
- [ ] When `design.changed` lists the shown page, or a file it links, the canvas reloads. (The daemon names the design in `design.changed`: `design/watch.rs` changed_files_of_a_design_are_grouped_by_design_with_its_record; `moonletd/tests/daemon.rs` a_page_written_in_a_design_is_announced.) It keeps the scroll position and the selected element (by `data-mid`). The files a page links are the design's `assets/`, and of its design system every `.css` file (`styles.css` and what it imports) and the files in `tokens/` and `fonts/`; a sync's `README.md`, `.prompt.md` files, cards, `_ds_sync.json` and `_ds_manifest.json` reload nothing (`lib/designCanvas.test.ts` comes when the shown page changes, or an asset it may use, comes when its design system's styles change, which the page links; `lib/designStore.test.ts` load again when they, the design's assets or its design system's styles change, and the latest written page is known, include a page not listed yet, which loads once it is; `e2e/specs/design-screen.e2e.ts` shows the page once it is written, and loads it again when it is written again). Keeping the scroll position and the selection needs the editor bridge, as the page is sandboxed on another host: it comes with entry 9.
- [ ] Overview shows every page at the same viewport, with each page's file name, label and open comment count. Clicking one opens it. A page is framed only on screen or near it, as cards are (`e2e/specs/design-screen.e2e.ts` shows every page in Overview with its label and open comments, and opens one from there). A page's count is its open pins, orphaned ones included, as the design's row counts them (`lib/designComments.test.ts` counts each page's open pins, orphaned ones included, as the design's row does, says how many comments are open; `e2e/specs/design-comments.e2e.ts` counts each page's open comments in Overview).
- [ ] One bar at a time shows under the toolbar. Its colour says who has to act:
  - **orange**, while the agent works: "Claude is changing the design. Edit mode opens when it stops; comments still work", with **Stop**. In a session: "Claude is working in this session…".
  - **red**, when the page fails the check: "<page> has check problems: <summary>", with **Details** and **Ask the agent to fix**.
  - **red**, when the page does not load: "<page> did not load. <parse error> at line <n>", with **Ask the agent to fix**.
  - **yellow**, when a save raced a change on disk: "The page changed; your last edit was not saved. <the edit>", with **Dismiss**.
  - **blue**, while previewing a snapshot (see History).
  - **grey**, when the design system was removed: "Design system removed. Pages show without <name>'s styles."

  The order is the agent at work, what it asks, the check, the design system; the check is `design.check` for the design, run when the screen opens and after a burst of changes, and **Ask the agent to fix** sends the page's problems by line. A check that fails clears the problems of the one before, so the red bar never shows them as the page's. In Overview the red bar names the first page with a problem. Until the editor bridge (entry 9) tells the app a page did not load, there is no red bar for it; the yellow and blue bars come with entries 9 and 11. The grey bar names the design system by the name it had, kept from its last listing (its slug only if it was never listed). (`lib/designStore.test.ts` is kept from before it was removed, for the designs on it, keeps no earlier problems once a check fails, so the bar never shows them as the page's; `lib/designBars.test.ts` shows none while nothing needs saying, is orange with Stop while the agent works, is orange when the agent asks or needs an approval, is red with Details and Ask the agent to fix when the shown page fails the check, is grey when the design system was removed, shows one bar at a time: the agent at work, then what it asks, then the check, then the design system, sends the page's check problems by line, and asks for the check again; `e2e/specs/design-screen.e2e.ts` shows the orange bar while its agent works, and Stop stops it, shows the grey bar once its design system is removed)

### Comments

- [ ] In Comment mode, hovering outlines elements. A click opens a comment box pinned to the element under the pointer, and ⌥-click picks its parent. The box names the element (`nav · m12 · "General Appe…"`) and has **Keep** (save, not sent) and **Send** (⌘↵, "sends to the chat").

  The page is on another host than the app, so a script inside it, the **comment bridge**, does this for the app: the canvas asks for the page with `?moonlet-bridge=1`, and the scheme puts `src-tauri/src/design_bridge.js` first in its `<head>` (`src-tauri/src/design_scheme.rs` the_bridge_is_served_only_when_the_canvas_asks; `lib/designView.test.ts` asks for the comment bridge when the canvas frames it, on the same host). Overview's pages are framed without it. Each time the page loads, the bridge reports its `data-mid`s; the app then tells it the mode and the pinned elements, whose boxes it reports, and again on load, scroll and resize, so the pins follow a reload. In Comment mode it draws the outline inside the page, outside its `<body>`, and a click is reported, not given to the page (`lib/designBridge.test.ts` reports the page's data-mids once it has loaded, in Comment mode, outlines the element under the pointer inside the page, and nothing in View, in Comment mode, reports a click's element instead of giving the page the click, and ⌥-click its parent, reports the boxes of the pinned elements when asked, and again on scroll and resize). The numbered pins are drawn over the frame at their elements' boxes, scaled with the zoom; clicking a pin, or its entry in the Comments tab, opens its box. The box goes under its element, else above it, else inside the page for an element as tall as it; it names the element with its text cut to 12 characters inside the quotes; Keep makes a new pin, or changes a kept pin's comment when its text changed (`lib/designComments.test.ts` goes under its element, else above it, else inside the page for an element as tall as it, keeps a new pin, changes a kept pin's comment, and leaves one whose text did not change, names the element in the comment box, and its page too in the Comments tab; `e2e/specs/design-comments.e2e.ts` opens a pin's comment box over the page, and Send puts it in the chat as a Comment from the canvas card; WebDriver cannot click inside the page, which is a sandboxed frame on another host in its own web process: it cannot switch into it, and its pointer actions at the frame's place are not delivered (tried at once after the page loads and every 150 ms), so the e2e makes its pins with `design.comment.put` as the bridge's pick would, and the pick itself is tested on the bridge script in jsdom).
- [ ] A pin is saved in `comments.json` with:
  - its number
  - its page and `data-mid`
  - the element's tag and up to 60 characters of its text
  - the comment
  - when it was sent, if it was
  - its state: open or resolved

  As `[{n, page, mid, tag, text, comment, sent_at, state}]`, through `design.comments`, `design.comment.put` (`new`, `edit` or `sent`) and `design.comment.resolve`. A sent pin whose comment is edited to say something else is not sent any more, so the tab offers **Send** again; one kept as it was stays sent. `sent` names each pin with the comment the chat got, and a pin is marked sent only while its comment is still that one, so a pin edited while it was being sent stays not sent. A new pin's number follows the highest so far and is never given again; its page, `data-mid` (`m` and digits) and tag are checked, its text squashed to one line and cut to 60 characters. The file is read and replaced through the designs folder as a handle, read again when the agent changed it meanwhile; one that cannot be read is reported and never written over, and one written before a field existed, empty or missing still loads. A missing file is an empty list, made by the change's own write, and the daemon makes one change of a design's comments at a time, so changes that overlap keep every pin. `design.list`'s `open_comments` reads it the same way (`design/comments.rs` a_kept_comment_is_numbered_saved_in_comments_json_and_listed, a_sent_comment_records_when_and_a_resolved_one_no_longer_counts_as_open, a_comments_json_from_before_its_fields_or_empty_or_missing_still_loads, an_unreadable_comments_json_is_reported_and_never_written_over, a_pin_names_a_page_and_an_element_and_keeps_60_characters_of_its_text, an_edited_comment_is_not_sent_any_more_and_an_unchanged_one_stays_sent, a_pin_edited_while_it_was_being_sent_stays_not_sent; `moonletd/tests/daemon.rs` a_designs_comments_are_put_sent_resolved_and_counted_in_its_listing, overlapping_comment_changes_keep_every_pin). The app lists a design's comments again when `design.changed` names its `comments.json`, so the pins, the tab and the row follow the agent's changes too The pins a change gives back show at once, before its `design.changed` lists them again; a listing on its way when a change comes back may have read before it, so it is dropped and asked again, never landing over the change (`lib/designStore.test.ts` are listed from the daemon, and again when the design's comments.json changes, are resolved one at a time, keep a pin kept while an older listing was on its way, whatever order the answers come back in; `lib/designComments.test.ts` take their old selves' places, and new ones are added by number).
- [ ] **Send** adds the comment to the chat as `Comment on <page> [data-mid=<id>] (<tag> "<text>"): <comment>`. **Send all** sends every unsent pin as one message, one line per pin. A comment's line breaks become spaces, so each pin is one line. The message, built in one place for Send and Send all, goes to the design's agent first, and only then are its pins marked sent, in one change that names each pin with the comment sent, so one edited meanwhile stays not sent; one that cannot be sent leaves them not sent. Send all leaves out the orphaned pins (`lib/designComments.test.ts` names the page, the element's data-mid, tag and text, then the comment, sends every open pin not sent yet whose element is there as one message, one line each; `lib/designStore.test.ts` go to the design's agent as their lines in one message, and are then marked sent, stay not sent when the message cannot be sent; `e2e/specs/design-comments.e2e.ts` lists kept pins as Not sent, and Send all sends them in one message, one line each).
- [ ] The Comments tab:
  - has Open and Resolved tabs and a page filter ("All pages")
  - shows each sent pin as "Sent <time>" with **Show in chat** (which scrolls the chat to it) and **Resolve**
  - shows each unsent pin as "Not sent" with **Send** and **Resolve**
  - has a footer "<n> not sent yet, one line each" with **Send all**

  The page filter narrows the lists; the tabs' counts and the footer stay the design's. Each pin names its page, element and text (`index.html · m12 · nav "General Appe…"`) (`lib/designComments.test.ts` lists the open pins with the orphaned ones apart, counts both tabs and the pins not sent yet, filters by page, and lists the resolved pins in Resolved, names the element in the comment box, and its page too in the Comments tab, says when it was sent, or that it was not, and how many Send all sends; `e2e/specs/design-comments.e2e.ts` shows a sent pin's card in the chat, resolves a pin, which moves to Resolved and off the design's count).
- [ ] A pin whose element no longer exists after a reload moves to **Orphaned**, with "The element is gone after the last change" and **Resolve**. The heading says Orphaned, shown in capitals by its style, as the sidebar's group headings are. Gone means the page's last load on the canvas, reported by the bridge, had no element with its `data-mid`; a page not shown since the app started is not known to have lost it. A pin that names no element (kept from before pins had one) is orphaned too (`lib/designComments.test.ts` is one whose element is gone from its page after the last load, or that names no element; `e2e/specs/design-comments.e2e.ts` moves a pin whose element is gone after the page is written again to Orphaned).
- [ ] Comments work the same on a design system's cards (X64). Deferred from entry 8: X64 says a card's comments "wait for the next sync, or are sent now with **Send now**" to the sync agent, but not where they are kept (a design system has no `comments.json`), how the next sync takes the waiting ones, or how a card's comment line names its card. That needs its own storage and a change to the sync's first message, so it comes after X64 defines it, with the card page's View, Comment and Edit.

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
- [ ] Style changes are written as the element's inline `style`, and text changes as its text. Each change is saved to the page file within 500 ms. The save strips only the editor's own transient markup (outlines, selection and hover attributes, the bridge script). It keeps every `data-mid` as it is: an element keeps its id through saves, reloads and edits by hand, and only an inserted or duplicated element gets a new one. Reading the saved file gives back exactly the edited page, ids included.
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
  - the prompt: `Implement the <design name> design`
  - a note: "The project is the design system's first source. The design keeps a link to the session it starts."
- [ ] The design arrives as X54 attachments that follow its text contract: each sends the text it shows, in the order shown, before the prompt. There is one attachment per page, in `design.toml` order with `index.html` first, then one for the styles. Each sends one line:
  - a page: `<design dir>/<slug>/pages/<page>.html · <design name>, <label>`
  - the styles: `<design dir>/<slug>/system/styles.css · <design system> styles`

  Unfolding a page's attachment shows its line and a thumbnail of the page. × leaves that page out of the copy and the message, but the styles cannot be left out. No HTML is pasted into the message, so the first message stays small whatever the design's size.
- [ ] Create starts the session with `session.create {…, design: {workspace, slug, pages}}`. Before the agent starts, the daemon copies the design into the new worktree as a session design: the pages kept, `assets/`, `system/` and `design.toml`, as X65's session-design storage says. So the paths the attachments name exist when the agent reads them.
- [ ] The design records the session. Its header shows "Building in <project> · <session>", and the Designs index shows "built in <session>". From there on the session design is the one that changes; the workspace design stays as it was.

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

- [ ] `"$MOONLET_BIN" design new --system <slug> [--name <name>] "<brief>"` creates a workspace design, starts its agent and prints it as JSON. Without `--name`, the brief's first words name it. The daemon sends `design.open` with the agent's terminal and session (`spawned_by`), for the app to show a toast "<session> started the design <name>" with **Open** ("An agent started the design <name>" when the agent has no session), and focus does not move (as X22). (`moonlet-cli/tests/design_e2e.rs` designs_are_made_listed_opened_and_removed_from_the_cli; `moonlet-cli/src/design.rs` a_design_without_a_name_is_named_after_its_briefs_first_words; `moonletd/tests/daemon.rs` design_open_and_a_design_an_agent_starts_reach_the_app; `lib/design.test.ts` offers it in a toast, and leaves the focus where it is, when an agent started it; `e2e/specs/design-screen.e2e.ts` offers a design an agent started in a toast, and leaves the focus where it is; `/moonlet-design new` comes with entry 12.)
- [ ] `/moonlet-design new "<brief>"` in a session makes the agent run that command, picking the design system as `--here` does.
- [ ] CLI: `moonlet design ls|new|open|check|rm`. `open` switches the app to the design: the daemon sends `design.open` (entry 7a), and the app switches to its workspace, Design mode and the design screen (`lib/design.test.ts` shows the design when the user asked for it; `e2e/specs/design-screen.e2e.ts` switches to a design on design.open). The workspace is `--workspace` when given, else the one whose design folder the command runs in, else that of the session of the agent running it. (`moonlet-cli/tests/design_e2e.rs` designs_are_made_listed_opened_and_removed_from_the_cli, a_designs_agent_checks_and_fixes_its_pages_from_its_folder; `moonlet-cli/src/design.rs` a_folder_of_a_design_system_names_its_workspace_and_system)

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

- `design.list {workspace}` → `[{slug, name, kind: "workspace" | "session" | "project", system, project?, session?, path, brief, viewport, pages, updated_at, open_comments, agent, agent_state, needs_you, error, built_in?}]`. `pages` is `[{name, label}]`, `index` first, then by name; `updated_at` the newest change of a page, else the creation; `open_comments` the pins of `comments.json` whose `state` is `open`; `agent` its agent's chat while it is still that design's, with its `agent_state` and `needs_you` as `design.systems` gives a sync agent's. Entry 7a lists workspace designs only. (`moonletd/tests/daemon.rs` a_new_design_starts_its_agent_in_its_folder_on_its_design_system)
- `design.create {workspace, name, system, brief, session?, spawned_by?}` → the design, with `agent_error`. With `session` it is a session design in that worktree; until entry 12 that fails with `not_yet`. Otherwise it is a workspace design, and its agent starts. A system the workspace does not have fails with `invalid_params`. (`moonletd/tests/daemon.rs` a_design_on_an_unknown_system_or_in_a_session_is_refused) When the agent's record cannot be saved or its first message cannot be sent, the design is still made, `agent` is `null` with `agent_error`, and the agent's chat is stopped and removed, as is a sync agent's on `design.system.create` (`moonletd/tests/daemon.rs` a_designs_agent_whose_record_cannot_be_saved_leaves_no_chat_behind, a_design_mode_agent_that_cannot_take_its_first_message_leaves_no_chat_behind).
- `session.create` (X54) gains `design?: {workspace, slug, pages}`. Before the agent starts, the daemon copies that workspace design into the new worktree as a session design and records the session on the workspace design. Without `design`, `session.create` is unchanged.
- `design.copy {workspace, from: {project, path}, name}` copies a project design into a new workspace design.
- `design.remove {workspace, slug}` stops the design's agent and deletes it. (`moonletd/tests/daemon.rs` a_new_design_starts_its_agent_in_its_folder_on_its_design_system)
- `design.write_page {design, page, html, base_version}` → `{version}`, or the error `stale`
- `design.comments {workspace, slug}` → the pins of `comments.json` by number, `[{n, page, mid, tag, text, comment, sent_at, state}]`; `design.comment.put {workspace, slug, new | edit | sent}` → the pins it changed: `new: {page, mid, tag, text, comment}` a new pin, `edit: {n, comment}` that pin's comment (not sent any more when it changed), `sent: {pins: [{n, comment}]}` those pins' `sent_at` set to now, each only while its comment is still the one given (the one the chat got), or none of them when one is not there; a bad page, `data-mid` or tag, an empty comment or an unknown pin is `invalid_params`. `design.comment.resolve {workspace, slug, n}` → the pin, resolved (`moonletd/tests/daemon.rs` a_designs_comments_are_put_sent_resolved_and_counted_in_its_listing).
- `design.history {design}`, `design.snapshot.restore {design, n}`
- `design.viewport {workspace, slug, viewport}` saves the viewport the design was last shown at (`WxH` in px) in its `design.toml`, leaving the rest of the file as it was; anything else is `invalid_params` (`moonletd/tests/daemon.rs` the_viewport_a_design_was_last_shown_at_is_saved_and_listed).
- `design.open {design}` asks the app to show a design: Design mode for a workspace design, the session's Design tab for a session design. It is sent as the event `design.open {workspace, slug, name, spawned_by?, session?}`. Until entry 12 it takes `{workspace, slug}`. (`moonletd/tests/daemon.rs` design_open_and_a_design_an_agent_starts_reach_the_app) Like `design.changed`, it goes to the Mac's clients only: a paired phone never hears it. (`moonletd/tests/mobile.rs` phones_do_not_hear_a_design_opened)
- `design.check {workspace, design, fix?}` checks a workspace design's pages: each element's `data-mid`, and each stylesheet that is not its design system's. With `fix`, the missing and repeated ids are numbered first.
- `design.changed {workspace, system, design, paths}` names the workspace design whose files changed, its paths relative to the design's folder, and fires for its record too.
- A design is addressed as `{workspace, slug}` or `{session, slug}`.
- The app registers the `moonlet-design://` URI scheme: `moonlet-design://<workspace>/<path>` is a file of that workspace's design folder on this Mac. A card framed in the app's window is asked on a host of its own, `moonlet-design://<card key>.<workspace>/<path>`, where the key, a DNS label of lowercase letters and digits, only gives the card its own web process (X64); the file is the path's, whichever key asks (`src-tauri/src/design_scheme.rs` a_cards_own_host_names_its_key_and_its_workspace, a_card_host_with_a_bad_key_or_workspace_or_extra_labels_is_refused). It serves files through `design.file` (X64) with the canvas CSP for the host the file was asked on (`default-src moonlet-design://<host> …`, so a page loads no other workspace's files: `src-tauri/src/design_scheme.rs` a_card_on_its_own_host_may_load_only_that_hosts_files), and adds the comment bridge (`design_bridge.js`) first in the `<head>` of an HTML page the canvas asks for with `?moonlet-bridge=1` (entry 8; the editor, entry 9, extends it into the editor bridge). A card the hidden render page asks for with `?moonlet-render=<job>` gets X64's measuring script first in its `<head>` (`src-tauri/src/design_scheme.rs` the_measuring_script_is_served_only_when_the_render_page_asks). A URL whose workspace is not an id, or whose path has an empty, `.` or `..` part, names nothing. The file is checked after it is opened: when the opened file is not inside the workspace's design folder, measured from the design root's real path (a link swapped in after `design.file` resolved it, or a workspace folder that is itself a link), nothing is served (`src-tauri/src/design_scheme.rs` a_url_names_a_workspace_and_a_file_of_its_design_folder, a_url_that_leaves_the_folder_or_names_nothing_is_refused, only_a_file_that_is_inside_the_workspaces_folder_when_opened_is_read, every_file_is_served_with_the_no_network_policy_of_its_workspace).

## Data and config

- Workspace designs: `~/.moonlet/design/<workspace id>/designs/<slug>/`, and the chat of each one's agent in `~/.moonlet/design/<workspace id>/.records/designs/<slug>.toml`.
- Session designs: `<worktree>/<design dir>/<slug>/` with `design.toml`, `pages/`, `assets/` and the pinned `system/` styles, all committed. Their comments, history, built screenshots and the agent's full copy of the design system are in `<worktree>/.moonlet/design/<slug>/`, which is not committed.
- `.moonlet/config.toml`: `[design] dir = "docs/design"` (default).
- `~/.moonlet/settings.toml`: `[design] snapshot_keep = 50`.
- The app's settings (`moonlet.settings`): `designViewports`, the user's custom canvas sizes as `WxH`, newest first; a file without it lists none (entry 7). moonlet has no `~/.moonlet/settings.toml` yet, so the sizes live with the app's other settings.

## Security considerations

- Pages are untrusted HTML and JavaScript written by an agent. The canvas iframe has `sandbox="allow-scripts"` and never `allow-same-origin`, so a page cannot reach the app, Tauri's IPC or another design.
- Every page is served with `Content-Security-Policy: default-src moonlet-design: data: blob: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'`. A prototype cannot fetch or post anywhere.
- The editor bridge (the comment bridge since entry 8) talks to the app only through `postMessage`. The app accepts only messages from the canvas frame's window, with a known message type, and checks every `data-mid` and page name it gets before it writes anything: a `data-mid` is `m` and digits, a tag a tag's name, a box four numbers, and text is cut to 60 characters; anything else is dropped (`lib/designBridge.test.ts` takes a pick with its element's data-mid, tag, text and box, cuts the text to 60 characters on one line, and drops a pick whose data-mid, tag or box is not one, takes the page's ids, the boxes of the pinned elements, and C and Esc, tells the page its mode, and the pinned elements once each, drops a message of an unknown type, or that is not an object). The daemon checks a pin's page, `data-mid` and tag again before it writes `comments.json`. The bridge takes messages only from its parent, the app's window, so the page's own scripts cannot change its mode or ask for boxes (`lib/designBridge.test.ts` takes messages only from the app's window, never from the page's own scripts).
- The page's own scripts run in the same frame as the bridge and can post the same messages to the app: they could open a comment box on an element of their choosing, report other ids or boxes, or press C. That affects only the comments the user makes on that page, which the user still writes and sends; nothing is sent or saved without the user's Keep or Send, and the message the agent gets is built by the app from checked fields. They can also report the page's `data-mid`s without some that are there, which marks real pins orphaned: those pins leave the list and the canvas for **Orphaned**, and **Send all** leaves them out, until the page loads again or the user resolves them.
- A workspace design's agent and the sync agent (X64) get `--add-dir` folders they may only read. Their `--settings` deny `Edit(//<folder>/**)`, which covers every Claude Code file-editing tool. Bash is not covered by those rules, but in Accept edits mode every Bash command other than `"$MOONLET_BIN" design …` asks first, so the user sees any command that could write there.
- `design.write_page` writes only `pages/*.html` of the named design. For a session design it resolves inside the worktree's design folder and rejects any path that leaves it.
- A project design is read from git objects (`git show <base>:<path>`), never checked out, and is rendered in the same sandbox.

## Out of scope

- Designs on remote hosts, and sharing designs between workspaces or people.
- Exporting to Figma or to Claude Design.
- Free drawing (vectors, pen tool) and image editing.
- Multi-select editing and alignment tools (a follow-up). Single selection plus copy and paste covers the first version.
- Agents other than Claude Code (ADR 0013).
- Using real components or real data: pages are static HTML with the design system's styles.
- Turning the off-system inline styles into classes. The user asks the agent for that.
- Comparing design and build pixel by pixel. The PR panel shows them side by side only.

## Test plan

While the spec is a draft, the plan names test files and areas. Each criterion gets the exact test names that cover it, as in X50, when its stack entry is implemented.

- Desktop `lib/` (Vitest, jsdom):
  - `designComments`: the comment line, Send all's message, orphaning against a reloaded page, and the Comments tab's grouping and footer count
  - `designEdits`: each editor operation applied to a captured page, compared with a literal expected HTML; serialization that strips editor attributes and round-trips exactly; the "Edits by hand" block and the chip's count
  - `designTokens`: matching a value to a token, the popover's order, and the off-system flag
  - `designViewport`: fit-to-canvas scale and the zoom steps
  - `buildIt`: the composer's attachments for a design, with their literal lines, order and the page left out with ×
  - `designEdits`: a page saved and reloaded keeps every `data-mid`, compared with the literal captured page
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
  - a session design's pinned `system/` copy and its anchor in `design.toml`, and Update replacing both copies
  - finding project designs on a base branch from a captured `git ls-tree` output
- `crates/moonletd/tests/`:
  - `design.create` with `spawned_by` sends the `design.open` toast event (design_open_and_a_design_an_agent_starts_reach_the_app)
  - `design.create` with `session` writes into the worktree
  - `session.create` with `design` copies the kept pages, `system/` and `design.toml` into the worktree before the agent starts
  - a design agent's settings deny edits in the design system's folder (a_new_design_starts_its_agent_in_its_folder_on_its_design_system)
  - `design.write_page` with a stale version
- e2e `design-mode.e2e.ts` and `design-screen.e2e.ts` (a crucial feature, X12), with a fixture design and a fake agent binary:
  - ⌃⌘D opens Design mode, and the canvas shows the page
  - New design opens the design screen with its chat; the page reloads, the viewport and zoom change, Overview opens a page, the orange and grey bars show, and `design.open` switches to the design (entry 7)
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
| 2a | `core: cards and the check` (`x64/core-check`) | `moonlet-core::design`: `@dsCard` parsing, the static check (tokens through the `styles.css` closure, markers, links, URLs, scripts, fonts, duplicate cards and snippets), the `data-mid` check and `--fix`, `_ds_manifest.json` | — |
| 2b | `core: generated files and re-sync` (`x64/core-generated`) | Foundation cards, the README index with `conventions.md` and its name check, `source_key` / `render_hash` / `_ds_sync.json` and the up to date, out of date, edited by hand and orphaned states | — |
| 3 | `daemon: design store` | `~/.moonlet/design/` per workspace, the `design.*` RPCs, `design.changed`, `design.file`, stale-write refusal, snapshots, sync and design agent terminals with `--add-dir`, their notifications and approvals, restore after restart; the CLI, including `moonlet design check [--fix] [--render]` over the daemon's socket like every other `moonlet` command | — |
| 4 | `skill: moonlet-design` | The skill (four sync steps, grading, conventions header, design rules, session flow), installed and refreshed beside `moonlet` | — |
| 5a | `daemon: design events` (`x64/daemon-design-events`) | `needs_you` in `design.systems`, `design.changed`, `last_sync`, `design.detect` | — |
| 5b | `app: Design mode` (`x64/app-design-mode`) | Mode switch (⌃⌘D), Design sidebar, New design system dialog, the docked sync agent; e2e | 1, 2, both sidebars |
| 5c | `app: design system view` (`x64/app-design-view`) | The `moonlet-design://` scheme with CSP (and `moonlet-design:` in the app's `frame-src`), `design.cards`, design system view, card page; e2e | DS view, one card, DS cards |
| 5d | `app: sync UI` | Sync step bar, Needs you and settle, Changed by this sync, the sync agent's notifications (X64 "The user in the loop"); e2e | sync running, after the sync |
| 6 | `app: render check and snap` (`x64/app-design-render`) | A hidden render window, the render rubric measured in the page, and `design snap` through WKWebView `takeSnapshot` (proven by the spike in ADR 0013); the sync agent's grading. `design snap --url` (grading against a dev server's real component) is a follow-up; e2e | one card |
| 6b | `app: card isolation` (`x64/app-card-isolation`) | Each card framed in the main window on a host of its own (`moonlet-design://<card key>.<workspace>/…`), and the main window made in `setup` with WebKit's site isolation on, so a card that never stops running blocks neither the window nor the other cards; the fallback on a WebKit without the feature; `e2e/snap.ts` shoots the window through macOS; e2e | DS view |
| 7a | `daemon: workspace designs` (`x65/daemon-designs`) | The workspace design's folder and `design.toml`, `design.list`, `design.create`, `design.remove`, `design.open`, `design.changed` for designs, the design agent (its launch, first prompt and design rules, restore after restart), the design tag that tells a design agent from a sync agent, `moonlet design ls|new|open|rm` and `check <design>`; the daemon side only: the app acts on none of it yet | — |
| 7 | `app: design screen and canvas` | New design dialog, the design's agent chat, canvas, viewports, zoom, page tabs, Overview, bars, live reload; the switch to a design on `design.open`, the toast for a design an agent started, and a design agent's `Design · <name>` notifications and approvals that open the design on a click; e2e | 3, 4, 5, Overview, canvas bars, prototype page |
| 8 | `app: comments` (`x65/app-design-comments`) | Comment mode, the comment bridge (its first half: outline, pick, ids and boxes), pins, Keep and Send, Comments tab, Send all, orphaned, chat cards, per-page counts in Overview; `design.comments`, `design.comment.put`, `design.comment.resolve`; e2e. Comments on a design system's cards wait for X64 to say where they are kept | comment mode on Phone, right rail |
| 9 | `app: visual editor, structure` | Select, Layers, breadcrumb, text editing, delete, duplicate, wrap, copy and paste, undo, save and the bridge, "Edits by hand" | edit mode |
| 10 | `app: visual editor, styling` | Drag to move, resize, Inspector, token popover, off-system, Palette; e2e | edit mode, right rail |
| 11 | `app: history` | Snapshots, History tab and preview, restore; e2e | History |
| 12 | `app: session designs and Build it` | `design new --here`, Build it (its attachments, and `session.create` copying the design into the session, "Building in"), the session Design tab, the pinned `system/` copy and Update, the slash menu, `/moonlet-design new`, Changes grouping, spec-from-design replies, the PR's Design and build, the Designs index with project designs; e2e | Build it, `/moonlet-design new`, A–F |

Entries 2–4 come first because everything in the app needs the folder format and the RPCs. 5 and 6 make the design system usable on its own, and moonlet's own desktop app is the first design system to build with it. 7a gives workspace designs their folder, RPCs, agent and CLI, since entry 3 built only design systems and the sync agent; 7–11 make workspace designs complete in the app. 12 brings designs into sessions, and Build it comes with it, because it turns a workspace design into a session design.

## Open questions

- None. The answers are in ADR 0013 and above: the session agent reads a copy of the design system, design agents notify and ask for approval like sessions, and multi-select is a follow-up.
