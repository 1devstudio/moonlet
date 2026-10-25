# X64 — Design systems from a project's code

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X65 (Design mode), X22 (the `moonlet` skill), X32 (workspaces), X54 (new session composer)
- **Related ADRs:** [0013](../adr/0013-design-systems-and-designs.md)
- **Design:** "PR 338 · Design mode screens" (Claude Design bundle, 2026-10-23). The relevant boards:
  - 1 and 2: Design mode with no design system, and the New design system dialog
  - the design system view and one card
  - a sync running, and the result after it
  - the design system cards part
- **Reference:** Claude Code's bundled `/design-sync` skill (2.1.304). X64 keeps that skill's output structure and its verification and re-sync approach. It replaces the compiled React bundle with static HTML and CSS (see "How this follows design-sync").

## Summary

A **design system** is a folder that shows a project's UI as the code has it, in plain HTML and CSS, so a design agent (X65) can build prototypes with it and people can browse it. It holds:
- the project's tokens, copied as they are
- one **card** per component, with each variant as a labelled example that is also a **snippet** a design can insert
- the project's own custom elements
- **foundations**: colours, type and spacing
- **layouts**: whole screens built from the snippets
- `README.md`, the design agent's main doc

An agent builds it from the source in four steps: **Inventory**, **Tokens**, **Cards** and **Layouts**. It checks each card with a mechanical render check and grades it before moving on.

A design system belongs to a moonlet workspace, so every project and design in that workspace can use it. A later sync works from content hashes: it rewrites only the cards whose source changed. A card someone edited by hand gets a proposed change instead of being overwritten.

## How this follows design-sync

| design-sync (Claude Code) | X64 |
|---|---|
| `README.md` inlined into the design agent's prompt (first 32,000 characters), with an agent-written **conventions header** prepended | Same. The header is written after the cards pass. moonlet generates the rest of the README from the cards and tokens. |
| `styles.css`, only `@import` lines: `tokens/*` → `fonts/fonts.css` → `_ds_bundle.css` | Same, with `components.css` (the project's component styles, rewritten as classes) in place of `_ds_bundle.css`. Cards and pages link only `styles.css`. |
| `tokens/*.css` copied verbatim from the source | Same. When the source defines tokens in code (a Tailwind theme, a TS object), they are written to `tokens/tokens.css` under the source's own names. |
| `fonts/`, `guidelines/` (the project's own docs and `index.md`) | Same |
| `components/<group>/<Name>/` with `.html` (card), `.prompt.md`, `.d.ts` and `.jsx` | `.html` (card) and `.prompt.md`. Static HTML has no props, so `.d.ts` and `.jsx` are dropped. The `.prompt.md` documents the markup and classes instead. |
| `@dsCard` marker on the card's first line, compiled into `_ds_manifest.json` | Same marker, plus `name`, `source` and `viewport`. moonlet compiles the manifest. |
| Card: a labelled grid of variants, plus `column` and `single` modes, captured at 900×700 | Same layout. Each variant's markup is its snippet. |
| Floor card "Preview not yet authored" instead of a fake render | Same |
| `@replaces` map (raw element → design-system component) | Same, in `.prompt.md`, as markup to use instead (`<button>` → `.btn`). |
| Render check: `bad`, `thin`, `variantsIdentical`, grid overflow; at most 3 iterations | Same rubric, run by moonlet. |
| Grading: Styled / Complete / Plausible, or match / close / mismatch against Storybook | Same. Graded against the project's real render where one exists. |
| Solo first, then fan out to subagents | Same |
| `_ds_sync.json`: source keys, render hashes, style hash; written last | Same idea. It also tells the sync which cards were edited by hand. |
| `.design-sync/config.json`, `NOTES.md` and `conventions.md` in the source repo | `config.toml`, `NOTES.md` and `conventions.md` in the design system's folder. The source projects stay read only. |
| No foundation cards, no layouts | moonlet adds both: foundations are generated from the tokens, and layouts go in `ui_kits/`. |

## User journey

1. In Design mode (X65), the user clicks `+` beside **Design systems**. The **New design system** dialog has:
   - **Name**, with the folder it will create shown under it (`~/.moonlet/design/1devstudio/systems/moonlet-desktop`)
   - **Built from the code of**: the workspace's projects, each with its path, branch and the stack moonlet detected (React · Tailwind, React Native, Next.js). A project can be a folder of a repository, such as `apps/mobile`.
   - a note: "Read only. The agent writes nothing in these projects."
   - **What to cover**: the components that matter most (the default), all of them, or none yet (honest floor cards). Asked here, so the agent does not stop to ask it.
   - the four steps, with what each produces: Inventory (components), Tokens (`tokens.css`), Cards (one per component), Layouts (whole screens)
2. **Build design system** starts the **sync agent**. The design system view shows a step bar with each step's result, such as "Inventory 3 changed, 1 new, 1 gone", "Tokens no change" and "Cards 1 of 3". The card being written is marked **Rewriting**. The agent's chat is docked on the right ("writes only in systems/moonlet-desktop"), with **Hide agent** and **Stop sync**.
3. The agent may still need the user: a question it cannot settle from the code (two button sets, which is current?), or an approval for a command outside its allowed ones. The step bar then reads **Needs you**, the sidebar row says `needs you`, a notification says "Design · moonlet desktop asks: …", and the question or approval waits in the docked chat, where the user answers it. The sync goes on from there.
4. When it finishes, the view shows the cards by group:
   - Foundations: Colours, with each token's swatch, and Type, with each size's sample
   - Buttons, Forms and the other component groups
   - Custom ("only moonlet has these")
   - Layouts
5. The user opens a card that looks wrong. The card page shows:
   - where the card was made from
   - its `@dsCard` line
   - its check problems, with **Ask the sync agent to fix**
   - its snippets, with copy
   - its comments
6. Weeks later, the header says "3 sources changed since sync · Sidebar.tsx, ui.tsx, AgentView.tsx. A sync rewrites only the 3 cards made from them". **Sync** runs the agent on those cards only.
7. After the sync, a green bar sums up what happened: "2 cards rewritten, 1 new, 1 change to settle, 1 orphaned. 0 check problems". **Needs you** lists:
   - a card the user had edited, with theirs and the synced version side by side, and **Keep mine** or **Use synced**
   - an orphaned card, whose source was deleted, with **Keep for now** or **Remove card**

   **Changed by this sync** lists each card rewritten, new or removed, with its source and **View**.
8. An agent in any session can start a sync: `/moonlet-design sync` runs `"$MOONLET_BIN" design system sync`, or `design system new --from <project>` when there is no design system yet.

## Behaviour and acceptance criteria

### Folder

- [ ] A design system lives in `~/.moonlet/design/<workspace id>/systems/<slug>/`, for a workspace that exists. Its slug comes from its name, and a name already in use gets a ` 2` suffix. (`design/store.rs` a_new_design_system_gets_a_folder_and_a_config_and_a_used_name_gets_a_number; `moonletd/tests/daemon.rs` design_systems_over_rpc) The folder holds:

  ```
  README.md                          the design agent's doc: conventions header + generated index
  styles.css                         @import only: tokens/*.css, fonts/fonts.css, components.css (last)
  components.css                     @import of each component's .css
  tokens/*.css                       custom properties, under the source's names
  fonts/fonts.css, fonts/*           @font-face rules and the font files
  guidelines/index.md, guidelines/** the project's own design docs, copied
  foundations/<Name>/<Name>.html     Colours, Type, Spacing, Radius and shadow (generated)
  components/<group>/<Name>/<Name>.css        its classes
  components/<group>/<Name>/<Name>.html       the card
  components/<group>/<Name>/<Name>.prompt.md  how to use it
  ui_kits/<kit>/<Screen>.html        layouts: whole screens
  assets/                            icons and images copied from the source
  config.toml                        name, scope, per-card settings (the agent may edit it)
  NOTES.md                           gotchas, known render warnings, re-sync risks
  conventions.md                     the header prepended to README.md
  _ds_manifest.json                  the card index (generated)
  _ds_sync.json                      the re-sync anchor (written last)
  .cache/                            render-check results, grades, screenshots (not part of the system)
  ```

- [ ] `config.toml` holds what the sync agent may edit:
  - the name
  - the scope: the components covered
  - per-card exceptions: `skip`, `mode` and `viewport`
- [ ] What moonlet trusts is kept outside the system's folder, where the agent cannot write: `~/.moonlet/design/<workspace id>/.records/<slug>.toml` holds the sources (each project by its id and project identity (X41), its path on this Mac, an optional sub-folder, and the commit last synced), the time of the last sync, the chat of the sync agent, the cards as they were when a sync not yet recorded started, the cards the last sync changed, and the orphaned cards the user keeps for now (`kept`). The agent's `--add-dir` folders and deny rules come only from there. Sync sends its prompt only to that chat, while it is still a sessionless chat in the system's folder and would start with the same folders and rules; otherwise it is stopped and a new one starts. The chat is the one the record names, never one found by its title: the agent may rename the system in `config.toml`, and it still has one agent, which removing the system stops (`moonletd/tests/daemon.rs` a_renamed_design_system_keeps_its_one_agent_and_removing_it_stops_that_agent). One start of its agent, recorded sync, progress report, settle or removal runs at a time per system: two starts never make two agents, a recorded sync and a start never lose each other's change to the record, and a removal waits for a running start and stops the agent it made (`moonletd/tests/daemon.rs` a_sync_recorded_while_its_agent_starts_keeps_both). A record that cannot be read lists the system with its error. (`design/store.rs` a_recorded_agent_is_reused_only_with_the_launch_it_was_started_with, a_record_that_cannot_be_read_lists_the_system_with_its_error) (`design/store.rs` what_the_agent_can_edit_never_changes_the_sources_or_its_chat; `moonletd/tests/daemon.rs` a_new_design_system_starts_its_sync_agent)

  A setting at its default is not written. Config describes conventions and exceptions, never lists of everything. A card's settings join its `source_key`, so changing them makes it out of date (`design/anchor.rs` a_changed_card_exception_makes_the_card_out_of_date).
- [ ] A workspace lists its design systems in Design mode (`design/store.rs` a_workspace_lists_its_design_systems_with_their_cards_and_what_needs_the_user). Deleting one asks first and leaves the designs that use it (`design/store.rs` removing_a_system_deletes_its_folder_and_files_resolve_only_inside_the_workspace). Those designs show the grey "Design system removed" bar (X65).

### Styles and tokens

- [ ] `styles.css` holds only `@import` lines, in this order: each `tokens/*.css`, `fonts/fonts.css`, then `components.css` last. Cards, layouts and design pages link only `styles.css`, so a card shows exactly what a prototype gets.
- [ ] Token files the source already has as CSS custom properties are copied as they are, keeping their names and sub-folders. Reading them ignores comments, takes a last declaration without a `;`, and lets a later declaration of a name win, as the cascade does (`design/tokens.rs` a_last_declaration_without_a_semicolon_counts_a_commented_one_does_not_and_a_later_one_wins). Tokens defined in code are written to `tokens/tokens.css` under the source's own names, and `NOTES.md` records where each came from.
- [ ] Each component's classes are in its own `components/<group>/<name>/<name>.css`, and `components.css` imports them, so subagents writing components in parallel never edit one file. The classes are named after the project's own components and variants (`.btn`, `.btn--primary`, `.session-row`), and use only tokens for colour, space, type, radius and shadow.
- [ ] Fonts the source uses are copied with an `@font-face` in `fonts/fonts.css`. The check reports a font family that is used but has no face.

### Cards

- [ ] A card's first line is `<!-- @dsCard group="<Group>" name="<Name>" source="<path>[,<path>…]" viewport="<w>x<h>" -->`.
  - `group` is required, as in design-sync.
  - `source` lists the source files the card was made from, relative to its source's folder: the repository, or the sub-folder the source names, such as `apps/mobile` (`design/store.rs` a_source_with_a_subfolder_reads_card_sources_inside_it). A path that is absolute or climbs out with `..` makes the marker malformed, so nothing outside a project is ever read (`design/card.rs` a_source_outside_the_project_is_malformed).
  - `viewport` defaults to 900x700.
  - The folder name is the group's slug.

  Parsing is in `design/card.rs` (a_moonlet_card_marker_names_its_group_name_sources_and_viewport, a_design_sync_marker_with_only_a_group_takes_the_default_viewport, a_marker_not_on_the_first_line_or_without_a_leading_group_is_rejected).
- [ ] A card links only `../../../styles.css`. It has no script and no URL outside the design system.
- [ ] A card shows its variants as a labelled grid (`repeat(auto-fit, minmax(320px, 1fr))`, bordered cells clipping overflow). Each variant is a cell `<section class="ds-cell" data-snippet="<group>/<name>/<variant>"><h4>variant</h4><div class="ds-mount">…</div></section>`.
  - A wide component uses `mode: column` (one cell per row).
  - An overlay uses `mode: single` (one full-bleed cell).
  - `#<variant>` in the URL shows that variant alone.
- [ ] The markup inside a cell's `.ds-mount` is the snippet the X65 palette inserts. Every state the source defines is a cell, such as a button's primary, subtle, ghost, danger, small, disabled and loading. The content is realistic, never "foo" or "test", and states that need interaction (hover, drag) are left out with a line in `NOTES.md`.
- [ ] A component in scope without an authored card gets a **floor card**: its group, its name and "Preview not yet authored", marked `data-ds-fallback`. It never shows a fake render.
- [ ] Group **Custom** holds the elements only this project has (in moonlet: the session row, the state glyph, the turn footer).
- [ ] `<Name>.prompt.md` has, in this order:
  - first line: one sentence the README index uses
  - the project's own doc for the component, if it has one (up to 8,000 characters)
  - `## Markup`, `## Classes and modifiers`, `## States`
  - `## Examples`: the card's snippets
  - `## Instead of`: the raw elements this replaces (`<button>` → `.btn`)
  - `## Related`

### Foundations and layouts

- [ ] moonlet writes the foundation cards from the tokens, with no agent involved, each time the tokens change:
  - **Colours**: a swatch per colour token. A token that is just `var(--other)` takes the family of the token it names, along the chain, so `--accent: var(--color-accent)` gets a swatch too; if that token is not one, says nothing, or the chain loops, its own name and value count. (`design/tokens.rs` a_token_that_is_just_another_tokens_var_takes_that_tokens_family; `design/foundations.rs` a_colour_alias_gets_a_swatch_on_the_written_colours_card; `design/readme.rs` a_colour_alias_is_listed_with_the_colours)
  - **Type**: a sample per size, weight, line height and letter spacing, and the font families (`design/foundations.rs` a_font_weight_token_shows_as_a_weight)
  - **Spacing**
  - **Radius and shadow**

  They are in group **Foundations**. A family with no tokens gets no card, and its old card is removed; folders under `foundations/` that are not moonlet's are left alone. (`design/tokens.rs` tokens_come_from_the_imported_token_files_by_family; `design/foundations.rs` the_colours_card_shows_a_swatch_per_colour_token, type_spacing_and_radius_and_shadow_cards_show_each_token_in_use, writing_the_cards_replaces_those_of_families_that_are_gone_and_passes_the_check)
- [ ] The **Layouts** step writes whole screens to `ui_kits/<kit>/<Screen>.html` (group **Layouts**), at the viewport their marker names, with realistic data. A layout is composed only of the cards' snippets, plus layout glue that uses tokens.

### README

- [ ] `README.md` starts with `conventions.md`, then moonlet's generated index:
  - **Where things are**
  - **Loading**: one `<link rel="stylesheet" href="styles.css">`
  - **Tokens**, by family (colour, spacing, typography, radius, shadow, other), with the count and three names each
  - **Components**: by group, each with its `.prompt.md` first line
  - **Layouts**
  - **Guidelines**: "read these before composing larger layouts"

  The check warns when the README passes 32,000 characters. (`design/readme.rs` the_readme_puts_the_conventions_first_then_the_index, writing_the_readme_reports_conventions_that_name_nothing_and_a_readme_over_budget)
- [ ] The sync agent writes `conventions.md` after the cards pass. In 2,000–4,000 characters it covers:
  - the styling idiom, with its real class and token names
  - where the truth lives
  - one idiomatic snippet
  - what to use instead of raw elements

  Every class and token it names must exist in `components.css` or `tokens/`, and the check reports any that do not. A class counts only when a selector defines it, not when a comment, a string or a file name mentions it (`design/readme.rs` a_class_only_named_in_a_comment_string_or_import_does_not_count). Later syncs check it again but never rewrite it. (The name check: `design/readme.rs` writing_the_readme_reports_conventions_that_name_nothing_and_a_readme_over_budget.)

### Check (`moonlet design check`)

- [ ] `"$MOONLET_BIN" design check <system>` reports, per file:
  - a missing `styles.css`
  - a missing or malformed `@dsCard` line: it must be the whole first line, `group="…"` first, then only `name="value"` pairs
  - a `var(--x)` that no file in the `styles.css` closure defines
  - an `@import`, `<link>`, `src` or CSS `url()` (fonts included) that names no file; every `@import` and `url()` of a line is checked
  - an `@import` of a proposal (`<name>.proposed.css`): it is not live until settled, and the styles closure does not follow it (`design/check.rs` a_proposal_waiting_to_be_settled_is_not_live_and_importing_it_is_reported)
  - a font family used first in a stack with no `@font-face`, also when the declaration spans lines
  - a URL outside the design system: any scheme but `data:`, `mailto:` and `tel:`, an absolute path, a relative path whose `..` climbs out of the folder (even when the file exists), or a symlink that points out of it. Folders that are symlinks are never entered.
  - a `<script>`, an `on*` attribute or a `javascript:` URL
  - two cards in one folder, or two snippets with the same id
  - a name in `conventions.md` that does not exist
  - a README over budget

  It exits non-zero on any error. The check itself is in `design/check.rs`: a_token_no_file_in_the_styles_closure_defines_is_reported_at_its_line, a_card_without_a_marker_or_with_a_bad_one_is_reported_on_its_first_line, links_that_do_not_resolve_urls_outside_the_system_and_scripts_are_reported, a_font_used_first_in_a_stack_without_a_font_face_is_reported, two_cards_in_one_folder_and_a_snippet_id_used_twice_are_reported, a_relative_link_or_import_that_climbs_out_of_the_system_leaves_it_even_when_the_file_exists, a_local_url_that_names_no_file_and_every_import_on_a_line_are_checked, any_scheme_but_data_mailto_and_tel_leaves_the_system_and_javascript_urls_are_scripts, a_font_family_declared_over_two_lines_is_checked, a_system_without_styles_css_is_reported; `design/card.rs` a_marker_with_stray_text_is_malformed. The `conventions.md` and README checks come with entry 2b, and the command with entry 3.
- [ ] moonlet writes, renames and removes its files in the system's folder through directory handles opened from that folder (`cap-std`), never by resolving a path twice, so no link and no folder swapped for a link while it runs can take a write outside it: a link the agent left (a `README.md` pointing at the record, a linked `foundations/` or `.cache/`) is replaced or refused, never written through (`design/store.rs` writing_generated_files_never_follows_a_link_the_agent_left).
- [ ] The check rewrites the generated files: `_ds_manifest.json` (from the markers, sorted by group and name), the foundation cards, and the README index. (`design/manifest.rs` the_manifest_lists_every_card_by_group_then_name_with_its_snippets; the foundation cards and README come with entry 2b.)
- [ ] With `--render`, the check asks the moonlet app to load each card in its sandboxed canvas (the app's own WebKit, in a hidden window that is never shown), measures it in the page, and writes `.cache/render-check.json` with design-sync's rubric:
  - `rootEmpty`: a mount is empty
  - `errs`: page errors (a script error, or a file the page links that does not load)
  - `nameOnly`: the only text is the card's name repeated
  - `allHollow`: no text and nothing painted
  - `collapsed`: text under 8 px tall, or text that does not show
  - `variantsIdentical`: every cell has the same markup
  - grid overflow: `wide` at a 680 px grid, or `escape` for fixed or portal content
  - `thin`: `nameOnly`, `allHollow` or `collapsed`, never on a floor card
  - `bad`: `rootEmpty`, or `errs` on a non-floor card

  (`lib/renderRubric.test.ts` passes a card whose cells are styled, have text and differ; is bad when a mount is empty; is bad with page errors, but a floor card's errors are not bad; is thin when the only text is the card's name, nothing shows, or its text is under 8 px tall; never finds a floor card thin; says when every cell has the same markup; says when a cell is too wide for a 680 px grid, or its content escapes it; judges measurements captured from real cards)

  Every card is loaded at its marker's viewport, a proposal left out (`design/render.rs` the_render_check_loads_every_card_at_its_viewport_but_proposals). The scheme serves the card with moonlet's measuring script first in its `<head>`, only when the render page asks for it with `?moonlet-render=<job>` (`src-tauri/src/design_scheme.rs` the_measuring_script_is_served_only_when_the_render_page_asks, the_measuring_script_goes_first_in_the_head_and_never_before_the_doctype); the script posts what it measured from the card's frame, and the render page takes only its own frame's post about the card it asked for (`lib/renderPage.test.ts` frames the card on the moonlet-design scheme with its job, and the variant to show alone; judges the measurements its job's card posts; ignores a message about another job, or of another kind; says why when the card could not be measured). `.cache/render-check.json` holds the counts, then each card's path and flags, with its page errors, or why it could not be rendered: such a card is `bad` (`design/render.rs` the_render_check_writes_each_cards_flags_and_the_counts). It is written through handles inside the system (`design/render.rs` render_results_and_screenshots_never_follow_a_link_the_agent_left).

  `design.check` with `render` returns the problems and the counts of total, bad, thin and variants_identical, and `moonlet design check --render` prints them and exits 1 on a bad card as on a problem (`moonletd/tests/daemon.rs` the_app_renders_each_card_for_the_render_check_and_its_flags_are_kept; `moonlet-cli/tests/design_e2e.rs` the_sync_agent_renders_its_cards_and_snaps_one_from_its_folder; `e2e/specs/design-render.e2e.ts` renders every card in the app and writes each card's flags to render-check.json). The `blank` flag comes from the snapshot: `design snap` says `blank` for a screenshot under 5 KB (`moonletd/tests/daemon.rs` a_screenshot_under_5_kb_is_blank).
- [ ] `"$MOONLET_BIN" design snap <card> [--variant <v>] [--viewport <w>x<h>]` saves a PNG of the card, taken by the app with WKWebView's `takeSnapshot`, to `.cache/screenshots/<card>[--<variant>]-<w>x<h>.png` and prints its path and `blank` as JSON. The card is named from the folder the command runs in and must be a card of that folder's design system; the viewport is the card's own unless `--viewport` names one, and `--variant` (a snippet's id, or its last part) shows that cell alone (`moonlet-cli/src/design.rs` a_card_is_named_from_the_folder_the_command_runs_in, a_viewport_is_a_width_and_a_height; `design/render.rs` a_snapshot_is_saved_under_the_cards_name_its_variant_and_viewport, a_snapshot_names_a_card_of_the_system_and_one_of_its_variants; `moonletd/tests/daemon.rs` the_app_snaps_a_card_and_the_screenshot_is_saved_in_the_system; `e2e/specs/design-render.e2e.ts` snaps a card, and one of its variants, to a PNG at the card's viewport). The hidden window is never shown (`e2e/specs/design-render.e2e.ts` renders in a window that is never shown).
- [ ] Without the app running, `--render` and `snap` fail with "Open moonlet to render cards". The rest of the check still runs. (`moonletd/tests/daemon.rs` without_the_app_the_render_check_and_snap_say_to_open_moonlet; `moonlet-cli/tests/design_e2e.rs` without_the_app_render_and_snap_say_to_open_moonlet)

### Sync

- [ ] **Build design system** and **Sync** start the sync agent: a Claude Code chat owned by moonletd, titled `Design · <name>`, with no session but in the workspace's Claude profile (X33), in the design system's folder, with each source given with `--add-dir`, in Accept edits mode. Sync asks the same chat again while it exists. (`moonletd/tests/daemon.rs` a_new_design_system_starts_its_sync_agent; `session.rs` a_chat_of_a_workspace_without_a_session_starts_in_the_workspaces_profile) Its `--settings` deny `Edit(//<source path>/**)` for each source, with the source's real path (no symlinks), so Claude Code's file-editing tools can read the sources but never change them. They allow exactly `<moonlet> design system progress:*`, `<moonlet> design check`, `<moonlet> design check --render`, `<moonlet> design snap:*` and `<moonlet> design system synced`, with the real path of the `moonlet` binary, which the first message names: a command through a variable such as `$MOONLET_BIN` is refused by Claude Code's permission check. A source path with `*?[]{}` is refused, as Claude reads it as a pattern. (`design/agent.rs` the_first_sync_agent_reads_the_sources_and_may_only_run_design_commands, a_source_path_with_glob_characters_is_refused, a_resync_names_the_cards_that_changed_and_how) `--add-dir` alone would not stop that, and Accept edits would accept such edits. The `moonlet-design` skill gives it the four steps.
- [ ] **Inventory.** The agent finds the components and their groups. Groups come from the source's folders, else by kind, and elements only this project has go in Custom. It covers what `cover` in `config.toml` says (`core`: the 20 to 40 that matter most, `all`, or `none`: floor cards only), asks the user only when `cover` is missing, and writes the components it chose to `config.toml` as `scope = [...]`.
- [ ] `design.system.create` takes `cover` (`core`, the default, `all` or `none`) and writes it to `config.toml`; `moonlet design system new --cover`; the New design system dialog asks it, and shows the folder the daemon will make. (`design/store.rs` a_new_design_system_gets_a_folder_and_a_config_and_a_used_name_gets_a_number, a_slug_is_lowercase_letters_and_digits_joined_by_dashes; `lib/design.test.ts` the New design system dialog's folder; `lib/designStore.test.ts` the New design system dialog; `e2e/specs/design-mode.e2e.ts`)

### The user in the loop

A sync runs for a long time and may need the user: a question the code cannot settle, or an approval for a command it may not run on its own (trial run, 2026-10-23: one question, what to cover, and 44 approvals for Bash commands that wrote or searched files).

- [ ] The skill keeps approvals rare: files are read, searched and written with Claude Code's own tools (Read, Grep, Glob, Write, Edit), which run without asking in Accept edits, and Bash is kept for the `moonlet` design commands it may run.
- [ ] The skill asks only what the code and `config.toml` cannot settle, one question at a time, with the agent's recommendation first.
- [ ] While the sync agent waits for an answer or an approval:
  - the step bar's current step reads **Needs you**, with the question's first line (`lib/designSync.test.ts` reads Needs you with the question's first line while the agent waits)
  - the design system's sidebar row says `needs you`, in the attention colour (`lib/design.test.ts` says needs you over everything while its agent waits for an answer or an approval)
  - the docked chat opens on the question or approval, also when the user hid it, as the structured chat shows them (X6: the question card with its options, the approval card with Allow and Deny) (`lib/designSync.test.ts` opens by itself while the agent asks something, even when hidden)
  - a notification (X47) says `Design · <name>` with `asks: <question>` or `needs your approval: <command>`, by the same banner and focus settings as a session's; the sync agent never sends a session's per-turn alert (`lib/designSync.test.ts` say when it asks, when it needs an approval, and when the sync is done; `lib/designStore.test.ts` follow the banner settings for a question and for a finished sync; `lib/alerts.test.ts` never alerts like a session: Design mode notifies for it). Clicking it to open the design system, and the approval inbox (A5) label `Design · <name>`, come later: notifications carry no click target yet
- [ ] A sync started from a session (`/moonlet-design sync`) raises its questions the same way: in Design mode and as a notification, never in the session that started it. The app lists every connected workspace's design systems, so this holds before Design mode was ever opened (`lib/designStore.test.ts` are listed once a host is connected, so a sync started from a session notifies too).
- [ ] Answering resumes the sync where it stopped; the step bar goes back to the step's progress.
- [ ] While the agent works, the step bar shows each reported step's result, the step at work and the steps to come; **Stop sync** (beside **Hide agent**, as the boards show) ends its turn, and a sync stopped before it was recorded shows where it stopped. The card the agent is writing reads **Rewriting** (`lib/designSync.test.ts` shows each step's result, the one at work, and the steps to come; says a sync stopped before it was recorded, and shows nothing when no sync is under way; is the card its running Write or Edit is on; `e2e/specs/design-sync.e2e.ts` shows each step's result while its agent works).
- [ ] After a sync recorded while the app runs, or while one left changes or something to settle, a green bar says "Sync finished" with what it did and what is left (rewritten, new, removed, changes to settle, orphaned, check problems; "Nothing changed" when that is all), with **Open agent** and Dismiss. **Needs you** shows a card edited by hand with yours beside the sync's version (**Keep mine**, **Use synced**) and an orphan (**Keep for now**, **Remove card**; an orphan with proposals is listed both ways). **Changed by this sync** lists each card rewritten, new or removed, with its sources and **View** (`lib/designSync.test.ts` sums up what it did and what is left to the user; sums up a sync that finished while the app runs, even one that changed nothing, and one that left something; lists a card edited by hand beside its proposal, and an orphan not kept; lists what it changed, each with its name and sources; `e2e/specs/design-sync.e2e.ts` stops the sync, then shows what it left: a card edited by hand beside the sync's version; takes the sync's version with Use synced, and nothing is left to settle; keeps an orphan for now, and it no longer waits to be settled).
- [ ] `design.systems` gives each system `needs_you`: `null`, or `{kind: "question" | "approval", text}` from its agent chat's pending asks, so the sidebar and the step bar can show it without opening the chat (`design/agent.rs` the_first_pending_ask_says_what_the_agent_needs; `moonletd/tests/daemon.rs` a_waiting_sync_agent_shows_in_the_design_system_list).
- [ ] **Tokens.** The agent writes `tokens/`, `fonts/`, `guidelines/` and `styles.css`, then runs the check.
- [ ] **Cards.** The agent writes `components.css`, the cards and the `.prompt.md` files. It does 2–3 diverse components itself first (one compound, one with many states, one text-heavy), then hands the rest to subagents in disjoint batches. A subagent edits only its own cards and notes, and never runs the whole check. A cause shared by two or more cards stops the batch and goes to `NOTES.md` as `[GENERAL]`. The agent runs `design check --render` and fixes until nothing is `bad`, at most 3 rounds, and records accepted warnings in `NOTES.md`.
- [ ] **Grading.** The agent grades each card from `"$MOONLET_BIN" design snap <card>` screenshots (`.cache/screenshots/`):
  - **Against the real component** (a follow-up, not in entry 6): in Inventory, when the agent finds a Storybook or a dev server in a source project, it offers to use it as the reference. It does not require one. moonlet starts it with the project's run script (X1), and `design snap --url <url>` screenshots the real component the same way. The two are graded side by side as `match`, `close` or `mismatch`, and `close` is still something to fix. For moonlet itself the reference is the real components rendered with demo data in `apps/desktop/src/ds`.
  - **Otherwise:** each cell as Styled, Complete and Plausible, giving `good` or `needs-work`; a `blank` screenshot is `needs-work`.

  Grades go to `.cache/grades/<Name>.json` (`{card, grade, cells: {<variant>: {grade, why?}}}`). The step is done when nothing is `bad` and every card in scope is `good` or `match`. The `moonlet-design` skill teaches this in its Cards step.
- [ ] **Layouts.** The agent writes `ui_kits/`, then `conventions.md`, and runs the check, which rebuilds the README.
- [ ] The agent reports each step with `"$MOONLET_BIN" design system progress <step> [<summary>]`. When it is done, `"$MOONLET_BIN" design system synced` records each source's short `HEAD` in the system's record and writes `_ds_sync.json`, both or neither. Both act only on the design system of the folder they run in and take no `--system` or `--workspace`, so the agent, allowed `progress` with any summary, can never report a step or record a sync of another system; outside a system's folder they fail. Each step reported stays, with its summary, until the sync is recorded: reporting a step again replaces its summary and drops the steps after it, so a sync that starts over shows only what it has done since. (`design/store.rs` sync_progress_shows_in_the_list_until_the_sync_is_recorded, a_sync_keeps_every_step_it_reported_and_a_step_reported_again_starts_over_from_it; `moonlet-cli/tests/design_e2e.rs` the_sync_agent_reports_checks_and_records_from_its_folder, the_sync_agents_commands_act_only_on_the_system_of_their_folder; `moonlet-cli/src/design.rs` a_folder_of_a_design_system_names_its_workspace_and_system, an_agents_terminal_names_its_sessions_workspace)
- [ ] `_ds_sync.json` holds, per card (components and layouts; the foundation cards are moonlet's and are rewritten from the tokens):
  - `sources`: each source file and its hash. A path that more than one source project has counts each project's file, so a change in either makes the card out of date (`design/anchor.rs` a_path_in_two_source_projects_is_out_of_date_when_either_changes)
  - `source_key`: a hash of `sources`. The card's exceptions in `config.toml` join it with entry 3, which reads `config.toml`.
  - `render_hash`: a hash of the card's HTML without its first line
  - `companion_hash`: for a component, a hash of its `<Name>.css` and `<Name>.prompt.md`; left out for a layout, which has neither
  - `proposed_sources`: while a `<Name>.proposed.html` waits beside the card, each source its marker names and its hash at the sync; left out otherwise

  It also holds `style_sha` (`styles.css`, `components.css`, `tokens/`, `fonts/`), `aux_sha` (README, guidelines) and a hash per file, `.cache/` and the anchor itself left out. Hashes are the first 16 hex digits of SHA-256, as design-sync's. (`design/anchor.rs` the_anchor_records_each_cards_sources_and_body_hashes, the_anchor_hashes_styles_docs_and_files_and_a_style_change_keeps_the_cards)
- [ ] **Sources changed.** A card with a source file whose hash now differs from the anchor's, or that is gone, is out of date, and that file is one of its changed sources. A card the anchor does not know is new, and with no anchor every card is; an anchor that cannot be read or parsed is an error, not a fresh start. (`design/anchor.rs` a_later_look_tells_out_of_date_edited_orphaned_and_new_cards_apart, a_missing_anchor_makes_every_card_new_and_an_unreadable_or_malformed_one_is_an_error) A source the card no longer names counts as changed, and a card whose marker broke keeps its place with the sources it had (`design/anchor.rs` a_dropped_source_or_a_broken_marker_still_shows_and_symlinked_folders_are_not_followed). The header says `<n> sources changed since sync` and names the files, and **Show cards** filters the view to those cards. moonlet checks when Design mode opens and when the design system is opened.
- [ ] A later sync covers only the out-of-date cards, components that are new in the source, and orphaned cards. A change to styles or docs alone keeps every grade: no card is out of date for it (`design/anchor.rs` the_anchor_hashes_styles_docs_and_files_and_a_style_change_keeps_the_cards).
- [ ] **Edited by hand.** A card whose `render_hash` or `companion_hash` on disk differs from the anchor was changed since the sync by something other than the sync agent: its HTML, its `.css` or its `.prompt.md`. A change to its marker line alone (a regroup) is not an edit (`design/anchor.rs` a_later_look_tells_out_of_date_edited_orphaned_and_new_cards_apart, a_cards_css_or_prompt_edited_by_hand_makes_it_edited_by_hand). The sync leaves the card's files as they are and writes its version of each one it changes beside it, as `<Name>.proposed.html`, `<Name>.proposed.css` or `<Name>.proposed.prompt.md`; `components.css` keeps importing `<Name>.css`. The card is listed once under **Needs you**, and counts once in `to_settle`, however many of its files are proposed:
  - **Keep mine**: deletes every proposal and anchors the user's version, so the card keeps its own styling and `.prompt.md` too. The sync recorded the user's files, so the card is up to date with its sources.
  - **Use synced**: replaces each file with its proposal and anchors it: its HTML, `.css` and `.prompt.md` (`design/store.rs` taking_a_proposed_css_and_prompt_leaves_the_card_up_to_date, a_source_the_proposal_names_that_changed_before_it_was_taken_shows_after), and the sources its marker names with the hashes the sync recorded for the proposal (`proposed_sources`; a source it recorded none for counts as changed). The next look finds the card neither edited by hand nor out of date, unless a source changed since the sync.

  (`design/store.rs` settling_a_card_takes_or_drops_its_proposed_html_css_and_prompt_together, a_settled_card_is_up_to_date_on_the_next_look_and_a_removed_one_comes_back_new)
- [ ] **Orphaned.** A card whose source files are all gone is listed as orphaned, and so is a card whose marker broke when all the sources it had at the sync are gone (`design/anchor.rs` a_later_look_tells_out_of_date_edited_orphaned_and_new_cards_apart, a_card_whose_marker_broke_and_whose_sources_are_gone_is_orphaned): "Designs that inserted it keep their copy". **Remove card** deletes its folder and drops it from the anchor, so a card written at its path later is new (`design/store.rs` a_settled_card_is_up_to_date_on_the_next_look_and_a_removed_one_comes_back_new). **Keep for now** leaves the card as it is and records it in the system's record, so it no longer counts in `to_settle` while it stays orphaned. A sync that finds one of its sources back, or the card gone, drops it from there, and so does **Remove card**: orphaned again later, it is asked about again. Only an orphaned card can be kept for now; any other fails (`design/store.rs` an_orphan_kept_for_now_waits_no_more_until_it_is_orphaned_again).

### Design system view

- [ ] The header shows:
  - the name
  - "From <project> · synced <age> at <commit> · <n> cards"
  - a "<n> check problems" chip, which filters to those cards
  - **New design** (X65), **Sync** and `⋯`, whose **Remove design system…** asks first
  (`lib/designView.test.ts` the design system view's header (X64); the "<n> check problems" chip counts every problem of the system, as the sidebar does, and filters to the cards that have one, letting go once none has: the cards the view shows (X64))
  - under it, why the system cannot be read (then no cards show), what its agent waits for, or the step a sync is at (`lib/designView.test.ts` the design system view's status (X64))
  - a banner while sources changed since the sync, with **Show cards**, which filters to the cards made from them (`lib/designView.test.ts` the sources-changed banner (X64); `e2e/specs/design-systems.e2e.ts` says which source changed since the sync and how many cards a sync rewrites)
  - cards render on the Mac the design system is on (ADR 0013); another host's workspace says so instead
- [ ] A column lists the groups with counts (All, Foundations, Buttons, Forms, Custom, Layouts). A group holding a card with a check problem has a dot. (`lib/designView.test.ts` the design system view's groups (X64); `e2e/specs/design-systems.e2e.ts` shows the cards by group, each rendered in its sandboxed frame)
- [ ] Each card shows its name, its variant count and its cells at card scale. A card with a check problem has a yellow outline and a count badge; its problems include its own `.css` and `.prompt.md`, and a card whose marker does not parse shows in **Without a marker** (`lib/designView.test.ts` a card (X64, X65); `design/store.rs` a_cards_own_files_problems_are_its_own_and_a_card_without_a_marker_is_listed; `e2e/specs/design-systems.e2e.ts` says which source changed since the sync and how many cards a sync rewrites). Its `⋯` menu offers **Open source** (in the project's code viewer, F2), **Comment**, **Edit** and **Copy snippet**.
- [ ] The card page shows:
  - a breadcrumb (`moonlet desktop / Custom / Session row`)
  - the card at its viewport and zoom (fitted, then −, + and Fit by steps from 25% to 400%: `lib/designView.test.ts` a card (X64, X65)), with View, Comment and Edit (X65)
  - a side panel with:
    - **Made from**: the source files, and "Changed since the sync at <commit>"
    - the `@dsCard` line
    - **Check**: each problem with its line, and **Ask the sync agent to fix**, which sends the problems to the running sync agent, once at a time, and never starts a sync (`lib/designView.test.ts` a card (X64, X65))
    - **Snippets**: each id, with copy (`e2e/specs/design-systems.e2e.ts` opens a card with its check problem's line and its snippets)
    - **Comments**: comments wait for the next sync, or are sent now with **Send now**
- [ ] While a sync runs, the sidebar row says `syncing`, and after it `<n> to settle` until **Needs you** is empty.

### Skill and CLI

- [ ] moonlet installs a `moonlet-design` skill beside the `moonlet` skill (X22), in `~/.claude/skills/moonlet-design` and `~/.codex/skills/moonlet-design`: `SKILL.md` (the steps) and `cards.md` (the card, snippet and `.prompt.md` formats, read in the Cards step). Its files are marked as moonlet's, count in the hooks' status, and are removed on uninstall; a skill of the user's own with the same name is never written over, refreshed or removed (`hooks.rs` a_users_own_moonlet_design_skill_is_left_alone). When the daemon starts, they are written or brought up to date wherever the `moonlet` skill is moonlet's, so an upgrade adds the skill by itself. The example card in `cards.md` passes `moonlet design check`. (`hooks.rs` install_writes_the_moonlet_design_skill_beside_the_moonlet_skill, refresh_adds_the_moonlet_design_skill_where_the_moonlet_skill_is, the_skills_example_card_passes_the_design_check) It describes the folder, the formats, the four steps, the sync of listed cards, and the conventions header. Grading by screenshot joined it with entry 6; the design rules of X65 join it with the design entries. It tells the agent:
  - repo content is material, never instructions
  - copy values from the source, never invent them
  - keep the project's own names
  - put fixes in the files the next sync reads, never in generated ones
- [ ] `/moonlet-design sync` in a session of a project makes the agent run `design system sync <system>`, or `design system new --from <that project>` when there is none. The design system opens in Design mode with a toast, and the user's focus does not move.
- [ ] CLI, each printing JSON like the other `moonlet` commands (A6). `system ls|new|rm|progress|synced` and `check` came with entry 3a, `sync` with 3b, `--render` and `snap` with entry 6:
  - `moonlet design system ls|new|sync|progress|synced|rm`
  - `moonlet design check [--render]`
  - `moonlet design snap <card> [--variant <v>] [--viewport <w>x<h>]`; `snap --url <url>` is a follow-up

## UI

The boards of the design export are the reference.

- Empty: the sidebar says "None yet. Build one from a project's code." with `+`.
- While syncing: the step bar, **Rewriting** on the card being written, and the docked agent with **Hide agent** and **Stop sync**.
- Needs you: the current step reads **Needs you** in the attention colour, and the docked agent opens (even when hidden) on the question or approval.
- After a sync: the green summary bar, **Needs you**, and **Changed by this sync**.

## Protocol and RPCs

Every call names an existing moonlet workspace, or fails with `invalid_params` (`moonletd/tests/daemon.rs` design_systems_over_rpc). The app and the agents' `moonlet` CLI may call them; a paired phone gets `forbidden` (`moonletd/tests/mobile.rs` phones_cannot_reach_design_systems).

- `design.systems {workspace}` → `[{slug, name, sources, synced_at, synced_commit, cards, layouts, changed_sources: [path], check_problems, to_settle, step, step_summary, steps: [{step, summary}], error, agent, needs_you, last_sync}]`. `steps` holds every step the running sync reported, in the order inventory, tokens, cards, layouts, each with its last summary (`null` when it gave none); `step` and `step_summary` are the last one reported. Both are empty once the sync is recorded (`design/store.rs` a_sync_keeps_every_step_it_reported_and_a_step_reported_again_starts_over_from_it; `moonletd/tests/daemon.rs` design_systems_over_rpc). `to_settle` counts each card with proposals once, and each orphaned card not kept for now. `last_sync` lists the cards the last recorded sync made `new`, `rewritten` or `removed`, with their sources, for "Changed by this sync". It is told against the cards as they were when the sync started: each start of the sync agent (a build or a sync) keeps their render hashes and sources in the record, unless an earlier start is not yet recorded, whose cards stay. So a card the user edited, made or deleted by hand before the sync, and that the sync left alone (its proposals are not cards), is not listed. A sync recorded with no start kept is told against the last anchor. A card counts as rewritten when its HTML, its `.css` or its `.prompt.md` changed. The start is kept until the record and the anchor are both written, so a sync retried after it stopped midway still knows its list (`design/store.rs` a_recorded_sync_keeps_what_it_changed, cards_the_user_changed_before_a_sync_started_are_not_among_its_changes, a_card_whose_css_or_prompt_alone_the_sync_rewrote_is_among_its_changes, a_sync_retried_after_it_stopped_midway_keeps_its_change_list; `moonletd/tests/daemon.rs` a_card_edited_by_hand_before_sync_is_not_changed_by_that_sync). A system that cannot be read still lists, with its `error`, beside the others (`design/store.rs` one_broken_system_still_lists_with_its_error_beside_the_others).
- `design.system.create {workspace, name, sources: [{project, subdir?}], cover?}` → the slug. With entry 3b it also starts the sync agent. A `subdir` must be a folder inside its project: one that is absolute, has `..`, is missing or links out of the project fails with `invalid_params`, and the sync agent is never given a source folder outside its project, whatever the record says (`design/store.rs` a_sources_folder_is_a_real_folder_inside_its_project; `moonletd/tests/daemon.rs` a_design_source_never_reaches_outside_its_project).
- `design.system.sync {workspace, slug}` starts the sync agent on an existing system (entry 3b).
- `design.system.progress {workspace, slug, step, summary?}` keeps the steps before `step`, replaces `step`'s summary and drops the steps after it.
- `design.system.synced {workspace, slug}` works out the anchor, records each source's short `HEAD` (none when it cannot be read) and the time, then writes the anchor, each file replaced whole. Either both say the sync is done or neither does: when the anchor cannot be worked out nothing is written, when the record cannot be written the anchor is not either, and when the anchor cannot be written the old record is put back; the progress stays until both are written (`design/store.rs` a_sync_whose_anchor_cannot_be_written_stays_unfinished_and_a_lost_head_is_cleared, a_sync_that_cannot_be_recorded_leaves_the_anchor_and_the_record_as_they_were).
- `design.system.remove {workspace, slug}`
- `design.check {workspace, slug, render?}` → `[{path, line, kind, message}]`, after rewriting the generated files. With `render: true` → `{problems, render: {total, bad, thin, variants_identical}}`, once the app has rendered every card, one at a time, and `.cache/render-check.json` is written; `no_app` "Open moonlet to render cards" without the app.
- `design.snap {workspace, slug, path, viewport?: [w, h], variant?}` → `{path, blank}`: `path` is the card's in the system, and the result the PNG's path on disk. The app renders it; `no_app` without the app.
- `design.render.ready {}`: the Mac's app says it renders cards; renders go to that connection alone, until it closes. A phone or an agent's CLI gets `forbidden`.
- `design.file {workspace, path}` → `{path, content_type}`. The app's `moonlet-design://` scheme (X65) reads the file itself: designs are local only (ADR 0013), so no bytes cross the socket.
- `design.settle {workspace, slug, card, choice: "mine" | "synced" | "remove" | "keep"}`. `card` is `components/<group>/<name>/<name>.html` or `ui_kits/<kit>/<screen>.html`, with no `.` or `..` and reached through no symlink (`design/store.rs` settling_a_card_keeps_mine_uses_the_synced_one_or_removes_it, settling_never_touches_files_outside_the_system_through_a_link_or_dots). `mine` removes each of its proposals; `synced` moves each over the file it proposes and anchors the card, and fails when there is none; `remove` drops the card from the anchor and from the kept cards (`design/store.rs` settling_a_card_takes_or_drops_its_proposed_html_css_and_prompt_together); `keep` records an orphaned card as kept for now, and fails for a card that is not orphaned (`design/store.rs` an_orphan_kept_for_now_waits_no_more_until_it_is_orphaned_again; `moonletd/tests/daemon.rs` design_systems_over_rpc).
- Event `design.changed {workspace, system, paths}` when files under a workspace's design folder change: one event per design system (`system: null` for the workspace's other design files), paths relative to the system's folder, gathered over 150 ms; a change to a system's record, or to its folder itself, counts for that system with no path; only moonlet's own temporary files are left out, and a path reported with its symlinks resolved counts too. A paired device never receives it. (`design/watch.rs` changed_files_are_grouped_by_workspace_and_design_system, a_system_folder_made_or_removed_counts_for_that_system_and_only_moonlets_temp_files_are_dropped, events_under_the_real_or_the_given_root_both_count; `moonletd/tests/daemon.rs` a_file_written_in_a_design_system_is_announced; `moonletd/tests/mobile.rs` phones_do_not_hear_design_changes)
- `design.cards {workspace, slug}` → `[{group, name, path, viewport, source, snippets, marker, problems: [{path, line, kind, message}], changed_sources, proposals: [path], edited_by_hand, orphaned, kept}]`: each card as its marker says (sorted by group and name; a card whose marker does not parse is listed in **Without a marker**), its check problems, and its sources changed since the last sync (`design/store.rs` a_systems_cards_come_with_their_marker_problems_and_changed_sources; `moonletd/tests/daemon.rs` design_systems_over_rpc). It also says what the card waits for: the sync's proposals beside it, relative to the system's folder and sorted; whether its HTML, `.css` or `.prompt.md` was edited by hand since the sync; whether it is orphaned; and whether it is an orphan kept for now (`design/store.rs` a_systems_cards_say_what_each_waits_for_its_proposals_an_edit_by_hand_or_an_orphan_kept; `moonletd/tests/daemon.rs` design_systems_over_rpc).
- `design.detect {workspace, path}` → what the folder's UI is built with, from its `package.json` and those of `apps/*` and `packages/*`: a framework (Next.js, React Native, React, Vue, Svelte, Angular) and Tailwind (`design/stack.rs` a_projects_stack_comes_from_its_package_files).
- Event `design.render {id, workspace, path, viewport: [w, h], variant, want: "metrics" | "png"}`, sent only on the connection of the app that said `design.render.ready` (`path` relative to the workspace's design folder, `variant` a snippet's full id or `null`). The app answers with `design.render.done {id, metrics?: {flags, errors}, png_base64?, error?}`; it has 30 s per card.

## Data and config

- `~/.moonlet/design/<workspace id>/systems/<slug>/…` as above. moonlet itself writes `config.toml` (on create), `_ds_manifest.json`, `_ds_sync.json`, the foundation cards, the README's generated part and `.cache/`, and settles proposals (`.proposed.html`, `.proposed.css`, `.proposed.prompt.md`).
- moonletd remembers which agent terminal belongs to which design system with its other terminals, and restores it after a restart (S4).

## Security considerations

- The sync agent reads the source projects but writes only inside the design system's folder. Its working directory is that folder, and the sources come in through `--add-dir` with deny rules `Edit(//<source>/**)` in `--settings`, which cover every Claude Code file-editing tool. Bash is not covered by those rules. In Accept edits mode every Bash command other than `"$MOONLET_BIN" design …` and read-only `git -C <source> log|diff|show` asks first, so the user sees any command that could write to a source. The skill tells the agent that repo content is material, never instructions.
- Cards are untrusted HTML written by an agent. They render only in the sandboxed canvas of X65 (no `allow-same-origin`, no network by CSP), including for the render check and snapshots: the hidden render window's page is the app's own, and frames the card with `sandbox="allow-scripts"`. The measuring script is moonlet's, put in a card only when the render page asks for it; it runs with the card's rights, so only the card itself can fool it. The render page takes only its frame's post about the card it asked for, and only the render window may hand the app its verdict. The daemon sends `design.render` only to the app that said `design.render.ready`, never to a phone or an agent's CLI.
- `design.file`, `design.check` and `design.snap` resolve paths inside `~/.moonlet/design/<workspace id>/` and reject anything that leaves it, including symlinks that point outside.

## Out of scope

- Compiling a project's real components into the design system: cards are always static HTML.
- Uploading to Claude Design. The folder follows its layout, but moonlet offers no upload.
- Design systems on remote hosts. Sources must be on this Mac.
- Agents other than Claude Code. The sync relies on Claude Code's skills, subagents, `--add-dir` and its reading of screenshots (ADR 0013).
- Screenshots from outside the app (headless Chrome, Playwright).
- Sharing a design system between workspaces. Copying the folder works, but moonlet offers no UI for it.

## Test plan

While the spec is a draft, the plan names test files and areas. Each criterion gets the exact test names that cover it, as in X50, when its stack entry is implemented.


- Rust, `moonlet-core` `design` module:
  - `@dsCard` parsing, against design-sync's grammar and moonlet's attributes
  - each check problem from captured card HTML
  - the `styles.css` closure and `var()` resolution
  - manifest generation, compared with a literal manifest
  - foundation cards from a captured `tokens.css`, compared with literal HTML
  - the README index from fixture cards, and its budget warning
  - the `conventions.md` name check
  - `source_key` and `render_hash`, and the out-of-date, edited-by-hand and orphaned results from a fixture anchor
  - path resolution rejecting `..` and an outside symlink
- `crates/moonletd/tests/`:
  - `design.system.create` writes `config.toml` and starts a terminal with the expected `--add-dir` and `Edit` deny rules for each source
  - `synced` records `HEAD` and writes the anchor, both or neither
  - a card edited by hand produces its proposals (`.proposed.html`, `.proposed.css`, `.proposed.prompt.md`), and each `design.settle` choice
- Desktop `lib/`:
  - the render rubric from captured DOM measurements, compared with literal flags
  - group counts and the problem dot
  - the "sources changed" banner text
  - the after-sync summary and the Needs you list
- e2e `design-systems.e2e.ts`, with a fixture design system in a scratch home:
  - Design mode lists it and shows its cards
  - a check problem shows the badge, and the card page shows the line
- e2e `design-sync.e2e.ts`, with a fake agent that stays at work until it is stopped:
  - a sync goes through the step bar, stops, and ends with a change to settle, taken with **Use synced**
  - an orphan kept for now waits no more
- Manual: build a design system of moonlet's own desktop app and compare its cards with the running app and with `apps/desktop/src/ds`.

## Delivery

X64 ships in entries 2a–6 of the stack in [X65's delivery plan](X65-design-mode.md#delivery-plan).

## Open questions

- None. The snapshot spike settled how cards are rendered and snapped (ADR 0013, Consequences).
