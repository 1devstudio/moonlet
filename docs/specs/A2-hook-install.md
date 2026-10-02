# A2: One-click hook install for Claude Code and Codex

- **Status:** implemented
- **Priority / phase:** P0 · phase 1
- **PRD refs:** A2

## Summary

jaunt adds its hooks to the user's agent settings so agents report their state. The install is idempotent, keeps everything that is not jaunt's, and writes a backup first.

## Behaviour and acceptance criteria

- [x] **Claude Code:** for each event in `CLAUDE_EVENTS`, add `{type: command, command: "<jaunt> hook claude", timeout: 5}` to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`). Tool events get `matcher: "*"`.
- [x] **Codex:** set the top-level `notify = ["<jaunt>", "hook", "codex"]` in `~/.codex/config.toml` (or `$CODEX_HOME`), preserving formatting with `toml_edit`.
- [x] If Codex already has a different `notify` program, refuse and explain; never overwrite it.
- [x] Reinstalling is a no-op. Installing from a moved binary replaces the old jaunt entries instead of duplicating them.
- [x] Before any change the file is copied to `<file>.jaunt-backup-<ms>`, and writes are atomic (temp file plus rename).
- [x] Uninstall removes only jaunt entries.
- [x] `jaunt hook` exits 0 silently when it is not inside a jaunt pane or the daemon is unreachable, with a 2 s cap.

## Protocol and RPCs

- CLI: `jaunt hooks install|status|uninstall`.
- RPC: `hooks.status`, `hooks.install {claude, codex}`, `hooks.uninstall`. The daemon looks for the `jaunt` binary next to `jauntd`.

## Security considerations

These commands edit user config files. Every change is preceded by a backup, and only exact jaunt entries are touched; jaunt entries are matched by the `jaunt` + ` hook ` command pattern.

## Test plan

- `hooks.rs`: `install_preserves_user_settings_and_is_idempotent`, `refuses_to_replace_foreign_codex_notify`.
- `hook_e2e.rs`: `hook_is_silent_outside_jaunt`.
