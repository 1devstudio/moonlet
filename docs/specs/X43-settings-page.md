# X43 — Settings page

- **Status:** implemented (2026-10-14; checked with e2e, look unchecked in the installed app)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X4 (visual design), X7, X8, X10, X14, X19, X26, X32, X33, X35, X36, X37, X39, A2, R1, S1b, T1
- **Related ADRs:** [0004](../adr/0004-launchagent-plist.md)

## Summary

Settings move out of the 600 px modal into a full-window page with a left nav. App settings, Claude Code profiles and hooks, hosts, phones, every workspace and every project each get a page of their own. The page also gains a keyboard shortcuts reference with editing and a search across all settings. The Workspace settings and Project settings dialogs are replaced by pages in the same window, so all configuration lives in one place.

## User journey

1. The user presses ⌘, (or the sidebar's gear). The settings page covers the window, open at General. Sessions keep running underneath.
2. The nav lists App (General, Appearance, Terminal, Agents, Notifications, Task trackers, Keyboard shortcuts), Claude Code (Profiles, Hooks), Machines (Hosts, Phones), Workspaces (one entry per workspace) and Projects (one entry per project).
3. App settings save as soon as they change. Workspace and project pages collect edits and show a bar at the bottom: Discard, or Save (⌘↵).
4. The user types in "Search settings" (⌘F). The page lists matching settings; ↑↓ and ↵ open one, which shows its page and briefly highlights the row.
5. Esc, "Back to sessions" or the close button returns to the sessions.

## Behaviour and acceptance criteria

### Page and navigation

- [x] ⌘, and the sidebar gear (`Settings (⌘,)`) open the page at General. The palette's "Settings…" does the same.
- [x] The page covers the window above the sessions view; terminals and agents underneath stay mounted.
- [x] The nav has the groups and entries listed in the journey, in that order. The active entry is highlighted.
- [x] Workspaces show their colour mark and initial. Projects show a folder icon and, for a remote host, the host's name on the right.
- [x] Hosts shows the number of remote hosts. Phones shows the number of paired phones. Profiles shows a dot when a profile a workspace uses is not signed in.
- [x] The header shows a breadcrumb (`Settings › General`, `Settings › Workspaces › Acme`, `Settings › Projects › storefront`) and a close button titled "Close settings (Esc)".
- [x] The nav footer shows `moonlet <version> · <update status>`.
- [x] Esc closes the page, except while a dialog over it (sign-in, confirm, palette) or a shortcut being recorded has it. In a text field Esc first leaves the field (after the field's own Esc, such as cancelling a rename or clearing the search); the next Esc closes the page. Opening the page moves focus into it, and the sessions under it are inert.
- [x] App shortcuts other than ⌘K do nothing while the page is open; the page handles ⌘F (search) and ⌘↵ (Save) itself.

### App pages

- [x] **General › Updates:** `moonlet <version>` with its update status and "Check now"; `Claude Code <version>` with its status and "Update to X" when one is available; a switch "Check for updates automatically". Existing behaviour from X35/X36 is unchanged.
- [x] **General › Background daemon:** a switch "Start the moonlet daemon at login" (S1b, with its confirm when turning off a loaded daemon) and a status line: "Running under launchd · <plist path>", "Installed but not loaded · <plist path>" or "Not installed: moonletd runs while moonlet is open".
- [x] **Appearance › Text:** "Font size" with − and + buttons and a number field, clamped to 9–24 (X37), and a live sample of sans and mono text at that size.
- [x] **Appearance › Editor and diffs:** "Colour theme of files and diffs" (X26) with a code sample.
- [x] **Terminal:** "Font family"; "New shells" as two radio cards, Blocks (default) and Classic; switches "Use Option as Meta" and "Let programs write to the clipboard"; "Rendering › GPU rendering".
- [x] **Agents:** "Default permission mode" as a radio list of Auto, Manual, Accept edits, Plan (X7; Bypass never listed); "When a plan is approved, switch to" (Auto / Accept edits) and "Tool calls in the conversation" (Collapsed / Expanded) as segmented controls.
- [x] **Notifications:** a switch "Notify even while moonlet is focused"; one sound per event (Needs you, Done, Failed) with all macOS system sounds and Off, and a Play button disabled for Off (X10).

### Claude Code and Machines

- [x] **Profiles:** one row per profile (Default first) with its initial, name, folder, account line and the workspaces that use it. Signed-out rows used by a workspace say "Not signed in · <workspace>'s sessions can't start Claude". Sign in / Sign out, Rename and Remove (not for Default) work as in X33.
- [x] **Profiles › New profile:** a form with Name and Folder creates a profile (`profile.create`), as the workspace "New profile…" does.
- [x] **Hooks:** Claude Code and Codex rows with Installed / Not installed / skipped (with the other notify command), the settings file path, and chips for the state hooks and the moonlet skill (Codex: its notify hook and skill, once installed). "Install hooks" keeps its confirm (A2) and is disabled when nothing is left to install; when the status can't be read, the page says so and Install stays available.
- [x] **Hosts › This Mac:** the local daemon's state and its session count, with a link to General's Background daemon.
- [x] **Hosts › Remote hosts:** one row per host with its status line (`Connected · moonletd <version> · <n> sessions`, `Needs install · no moonletd on the host`, the error, or the connection state), Install helper / Reinstall helper (with confirm, R2) and Remove. An input with `~/.ssh/config` suggestions and "Add host" add one (R1).
- [x] **Phones:** everything X39's Mobile section does: "Allow phones on my tailnet", the status line, Pair a phone with QR, link, copy and countdown, and paired phones with Remove.

### Workspace pages

- [x] Each workspace's page shows its mark, name and `Workspace on <host> · <n> sections · <n> sessions`.
- [x] Name and Colour (the five X32 colours), and the Claude profile field with its account line (X33), are edited here.
- [x] Sections lists the workspace's sections with their project counts.
- [x] "Delete workspace" is disabled with the X32 reason when blocked, otherwise asks first and deletes.
- [x] Edits show a bar "Unsaved changes to <name>" with Discard and Save (⌘↵). Save is disabled while the name is empty.
- [x] Leaving the page (nav, close, Esc) with unsaved edits asks "Discard unsaved changes to <name>?" first.
- [x] "Workspace settings…" in the workspace switcher and the profile footer open this page.

### Project pages

- [x] Each project's page edits `.moonlet/config.toml` with the X8 fields and validation: Scripts (Setup, Run, Archive), Agents (Default agent, Custom agents, Add agent) and Git (Base branch).
- [x] The bar at the bottom shows the file's path (click copies it) and the state: "This file is part of the repository.", "Unsaved changes", or "Fix <n> error(s) to save". Save (⌘↵) is disabled while there are errors.
- [x] A missing file says "No .moonlet/config.toml yet. Saving creates it."
- [x] A file that changed on disk shows the X8 Reload bar.
- [x] Invalid TOML shows the parse error and path with "Check again" (reloads) and "Reveal in Finder" (local) or "Copy path" (remote).
- [x] Leaving with unsaved edits asks first (X8's discard confirm).
- [x] Every Project settings entry point (sidebar gear, project menu, right panel menu, Run with no run script, the palette action) opens this page; Run with no run script focuses the Run field.

### Keyboard shortcuts page

- [x] Lists every Run action (X19) by group with its current key, or "Not set".
- [x] A filter matches action names and keys.
- [x] Clicking a key records a new one; Esc cancels. A reserved key shows why it can't be used; a key another action has asks before moving it ("Shortcut in use", **Move**). While recording, every key goes to the recorder, ⌘K included.
- [x] A row whose key differs from its default shows "custom" and a "Reset to default" button. "Reset all" (with confirm) restores every default.

### Search

- [x] Typing in "Search settings" replaces the page with `<n> settings match "<query>"` and a list of matches with the match highlighted, the page path and the current value. A setting is also found by another word for it (such as "WebGL" for GPU rendering), without a highlight.
- [x] Workspace and project settings appear once per workspace and project.
- [x] ↑↓ move, ↵ or a click opens the setting's page and briefly highlights its row. Esc clears the search.
- [x] No match shows `No settings match "<query>"`.

## UI

Layout from the design file (`Moonlet Settings Page.html`): 248 px nav (52 px drag area for the window buttons, Back to sessions with Esc, search with ⌘F, groups, version footer); main column with a 52 px header and a 680 px content column. Section headings are small caps; settings sit in bordered cards of rows (label and hint on the left, control on the right). Switches are 32×18 px, accent when on.

## Protocol and RPCs

No new RPCs. The page uses the existing ones: `hooks.status`, `hooks.install`, `profile.create|update|delete`, `workspace.update|delete`, `project.config_file`, `project.set_config`, `mobile.*`, and the Tauri commands `daemon_service`, `host_list|add|remove`, `ssh_hosts`, `remote_install`, `play_sound`.

## Data and config

No new keys. App settings stay in `moonlet.settings` (localStorage). Custom shortcuts stay in `settings.shortcuts`; resetting one deletes its key.

## Security considerations

Nothing new crosses a trust boundary. Project config validation stays on the daemon side too (X8).

## Out of scope

- Light theme and an app colour theme picker.
- Editing sections (they are renamed and reordered in the sidebar, X32).
- The X41 central host settings.

## Test plan

- Vitest in `apps/desktop/src/lib/`: the nav model (groups, badges, dot), breadcrumbs, host and profile status lines, daemon status line, keys while the page is open, shortcut rows and reset, search index and matching, and the workspace form's dirty state.
- E2E `settings-page.e2e.ts`: open with the gear, move between pages, a switch persists, Esc closes; search opens a setting; a workspace rename via the bar. Existing specs move to the page (font size, tool calls, plan approval, editor theme, phones, workspaces, project settings).

## Open questions

- None.
