# X8: Project settings

- **Status:** implemented (2026-10-04): daemon RPCs and the dialog. The RPCs were checked live against a dev daemon (scratch `JAUNT_HOME`). The dialog itself has not been checked in the app (manual check M10). Design: "Project settings dialog design" (Claude Design export, 2026-10-04).
- **Priority / phase:** P1 · phase 3
- **Related:** [X1](X1-repo-scripts.md) (repo scripts and Run button), [X5](X5-workspaces-projects-sessions.md) (projects in the sidebar), [glossary](../../CONTEXT.md)

## Summary

Every project setting lives in `<repo>/.jaunt/config.toml`, and the only way to change one is to edit that file by hand. The app reads it (`project.config`) but cannot write it, so a user who sees a greyed-out Run button has to find the README to learn why. X8 adds a **Project settings** dialog that edits the same file: the `setup`, `run` and `archive` scripts, the default agent, the base branch and the custom `[agents]`. The file stays the single source of truth. The dialog writes it in place, keeping comments, key order and keys it does not know.

## User journey

1. The user opens Project settings in one of these ways:
   - the gear on a project header in the sidebar (shown on hover, next to `+`);
   - choose **Project settings…** in the right panel's `⋯` menu (next to "Re-run setup script");
   - run "Project settings…" from the command palette (current session's project);
   - click the Run button when no `run` script is set. The dialog opens with the Run field focused.
2. The dialog shows the project's name, host and the file path, and a form filled from the file. If the file does not exist, the form is empty and a note says it will be created on save.
3. The user edits fields. Save is enabled once something changed.
4. On **Save** (⌘↵), the daemon writes the file. The dialog closes and a toast says "Saved .jaunt/config.toml". The Run button picks up the new values without reselecting the session. The composer and the `+` agent menu read the config each time they open.
5. If the file changed on disk after the dialog opened, Save fails with "The file changed on disk. Reload to see the new version." and a **Reload** button. Nothing is written.
6. If the file exists but is not valid TOML, the dialog shows the parse error and the path instead of the form, with **Reveal in Finder** (local projects only) and **Close**. It never offers to overwrite the file.
7. Escape, Cancel, the × or a click outside close the dialog. With unsaved changes, the footer asks "Discard unsaved changes?" with **Keep editing** and **Discard** instead.

## Behaviour and acceptance criteria

- [x] `project.config_file {id}` returns the path, whether the file exists, a version token, the parsed config, the parse error when there is one, and the repo's default branch.
- [x] `project.set_config {id, version, config}` writes `<project path>/.jaunt/config.toml` and creates `.jaunt/` if needed (`creates_the_file_in_an_empty_repo`).
- [x] The write keeps comments, blank lines, key order and unknown keys and tables. A changed value keeps its trailing comment; an unchanged one is left exactly as written, quotes included (`keeps_comments_order_and_unknown_keys`).
- [x] An empty or whitespace-only field removes its key. Comment lines right above a removed key go with it. A comment block set apart from it by a blank line (a file header) moves to the next item. The file is never deleted (`blank_fields_remove_keys_and_an_emptied_agents_table_goes`).
- [x] `[agents]` entries are added, changed and removed one by one. Untouched entries keep their comments. When the last entry goes, the `[agents]` table goes too, unless a comment sits above its header (`an_emptied_agents_table_with_a_comment_stays`).
- [x] The write is atomic: a uniquely named temp file in `.jaunt/`, created with `create_new` and renamed over the config. A symlink planted in `.jaunt/` is never followed (`a_symlink_planted_in_jaunt_is_never_written_through`). Not tested for crashes.
- [x] A stale `version` is rejected with `config changed on disk`, and nothing is written. A file created after a "missing" read counts as stale (`a_stale_version_writes_nothing`).
- [x] A file that does not parse, or parses with a wrong type (`run = 5`), is reported by `project.config_file` and rejected by `project.set_config` (`an_invalid_file_is_reported_and_never_overwritten`).
- [x] A symlinked `.jaunt` or `config.toml` is refused (`a_symlinked_config_is_refused`).
- [x] Validation, checked by the daemon and in the dialog (`validation_rules`, `projectSettings.test.ts`):
  - agent names are non-empty and use only `A-Za-z0-9._-`; the dialog also flags duplicate names (the request is a map, so the daemon cannot see them);
  - agent commands are non-empty;
  - an agent name cannot be `claude` or `codex` (they are built in);
  - `default_agent`, when set, is `claude`, `codex` or one of the `[agents]` names in the same request.
- [x] Saving a `base_branch` updates the stored `Project.base_branch` too. Clearing it sets `Project.base_branch` back to the repo's default branch (`saving_base_branch_updates_the_project`). Before X8 that value was only read when the project was added.
- [x] After a save, the daemon emits `projects.changed`. That replaces the project objects in the store, so the right panel refetches the config and the Run button updates. Checked live: the event fires; the button update in the app is not checked yet.
- [ ] The Run button no longer goes grey. With no `run` script, it is dimmed, its tooltip says "Set a run command…", and clicking it opens Project settings with the Run field focused. ⌘R and the palette's "Run script" do the same (`runScript` reads the config first). The decision is `hasRunCommand` (`projectSettings.test.ts`); the button and the dialog opening are not checked in the app.
- [ ] Remote projects work the same way: the RPCs go to the host's daemon, which reads and writes the file on that host. Reveal in Finder is hidden for them. Not checked on a remote host.

## UI

A dialog, `min(560px, 90vw)` wide, titled **Project settings**, with the project name and host (when not local) as the subtitle.

- **Scripts**
  - Setup: one-line monospace input. Hint: "Runs in a new session's worktree after it is created."
  - Run: same. Hint: "The Run button (⌘R). Running again restarts it."
  - Archive: same. Hint: "Runs before a session is archived."
- **Agents**
  - Default agent: a select with Claude, Codex, then the custom agents. A first option "None (ask each time)" leaves the key unset.
  - Custom agents: a list of rows (name, command, remove ×) and an **Add agent** button. New rows start empty with the name field focused.
- **Git**
  - Base branch: input, placeholder "Default: <git default branch>".
- **Git**: the Base branch hint reads "New sessions branch from here, and Changes compare against it."
- **Footer:** the file path in faint mono text (click to copy) over "This file is part of the repository.", then Cancel and Save (with a ⌘↵ hint). A failed save shows a red bar above the footer, with Reload when the file changed on disk.

States:

- Loading: the form is disabled with the fields empty.
- File missing: a one-line note above the form, "No .jaunt/config.toml yet. Saving creates it."
- Parse error: the form is replaced by the error, line and column, and Reveal in Finder.
- Validation error: shown under the field; Save is disabled.
- Save failed (stale or I/O): an error line above the footer, with Reload for the stale case.

Keyboard: Escape cancels (asks first if there are unsaved changes), ⌘↵ saves.

## Protocol and RPCs

- `project.config_file {id}` → `ProjectConfigFile`:
  ```ts
  { path: string; exists: boolean; version: string; config: ProjectConfig; error?: string }
  ```
  `version` is a hash of the file's bytes, or `""` when the file does not exist. When `error` is set, `config` is the default and the dialog must not offer to save.
- `project.set_config {id, version, config: ProjectConfig}` → `ProjectConfigFile` (the new state). Fails with:
  - `config changed on disk` when `version` does not match the file;
  - `.jaunt/config.toml is not valid TOML: …` when the current file does not parse;
  - a validation message (see above).
- `project.config {id}` stays as it is for the current callers.
- `projects.changed` is also emitted after a successful `project.set_config`.

## Data and config

- File: `<project path>/.jaunt/config.toml`, the main checkout's copy. That is the copy the daemon already reads for every session. A session's worktree has its own checked-out copy, which jaunt does not read. The dialog footer says which file it edits.
- Keys: `setup`, `run`, `archive`, `default_agent`, `base_branch`, `[agents]`. They are unchanged from X1 and X5, so nothing needs migrating.
- Writing uses `toml_edit` (already a dependency of `jaunt-core`, used by the hook installer).
- Reveal in Finder uses the `opener:allow-reveal-item-in-dir` permission, added to `capabilities/default.json` for X8.
- `Project.base_branch` in the daemon state follows the saved `base_branch` (see above).
- The file is often committed. Saving shows up as an uncommitted change in the main checkout, as a hand edit would. The dialog says so once, under the footer path: "This file is part of the repository."

## Security considerations

- The scripts are shell commands that jaunt runs: setup runs on its own when a session is created. In the app, only an explicit Save in the dialog changes them. The socket is limited to the local user (mode `0600` plus a peer-credential check, A6). Any process running as that user, an agent included, can call `project.set_config`, but it could already edit the file directly, so the RPC grants nothing new.
- The daemon writes only the fixed path `<project path>/.jaunt/config.toml`. The project id resolves to a known project; the request carries no path.
- If `.jaunt` or `config.toml` is a symlink, the save is refused with an error. Following it could write outside the repo. `.jaunt/` comes from the repo, so the temp file gets a fresh name and is opened with `create_new` (`O_EXCL`), so it never writes through a link committed there. A link swapped in between the check and the write is not covered.
- Agent names are restricted to `A-Za-z0-9._-`, because they appear in menus and terminal titles. Commands are stored as typed. They already run through `$SHELL -lic`, so jaunt adds no quoting of its own.

## Out of scope

- A local, uncommitted override file (for example `.jaunt/config.local.toml`). See open questions.
- Watching the file for edits made outside the app. A hand edit is still picked up on the next session switch, as today.
- Per-host or global defaults for these keys.
- Editing the file's raw TOML in the dialog. Reveal in Finder (and F2's code viewer) cover that.
- Moving the app-wide Settings (hooks, daemon, terminal, permission mode) into projects.

## Implementation

- Daemon: `crates/jaunt-core/src/project_config.rs` (load, validate, save with `toml_edit`), `SessionManager::project_config_file` and `set_project_config`, and handlers in `crates/jauntd/src/daemon.rs`.
- App: `components/ProjectSettings.tsx` (the dialog) and `lib/projectSettings.ts` (turning the config into form fields and back, validation, default-agent options). Entry points are in `Sidebar.tsx`, `RightPanel.tsx`, `CommandPalette.tsx` and `actions.ts` (`openProjectSettings`, `runScript`).

## Test plan

- Unit (`jaunt-core`): writes into an empty repo, a file with comments and unknown keys, and a file with an `[agents]` table being emptied. Each one is compared to an expected file.
- Unit: an empty field removes its key; a stale version is rejected; a file that does not parse is rejected; a symlinked path is refused; validation errors for each rule.
- Unit: saving `base_branch` updates `Project.base_branch`, and clearing it restores the git default.
- Daemon: `project.set_config` emits `projects.changed`.
- Unit (frontend): turning form state into `ProjectConfig` (blank fields become missing keys; agent rows become a map) and the inline validation.
- Live RPC check (2026-10-04, scratch `JAUNT_HOME` and repo, `jaunt rpc`): a stale version, an unknown default agent and a valid save. The file kept its header and inline comments, `project.list` showed the new `base_branch`, and `session.run` started the saved command.
- Manual (`docs/manual-checks.md` M10, scratch `JAUNT_HOME`):
  - each entry point opens the dialog;
  - Run with no script opens it with the Run field focused;
  - after Save, the Run button turns on without switching sessions;
  - a remote project saves on the host;
  - the file-changed and parse-error states appear.

## Open questions

- Should the dialog write to a local, uncommitted file instead (for example `.jaunt/config.local.toml`, layered over the committed one), so that personal commands don't end up in a commit? X8 ships on the committed file, which is what jaunt reads today. The design keeps the "This file is part of the repository." line.
