# A2: One-click hook install for Claude Code and Codex

- **Status:** implemented
- **Priority / phase:** P0 · phase 1
- **PRD refs:** A2

## Summary

moonlet adds its hooks to the user's agent settings so agents report their state. The install is idempotent, keeps everything that is not moonlet's, and writes a backup first. It also writes the `moonlet` skill ([X22](X22-agent-opens-session.md)) to `~/.claude/skills/moonlet/` and `~/.codex/skills/moonlet/`; "installed" includes the current skill.

## Behaviour and acceptance criteria

- [x] **Claude Code:** for each event in `CLAUDE_EVENTS`, add `{type: command, command: "<moonlet> hook claude", timeout: 5}` to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`). Tool events get `matcher: "*"`.
- [x] **Codex:** set the top-level `notify = ["<moonlet>", "hook", "codex"]` in `~/.codex/config.toml` (or `$CODEX_HOME`), preserving formatting with `toml_edit`.
- [x] If Codex already has a different `notify` program, refuse and explain; never overwrite it.
- [x] Reinstalling is a no-op. Installing from a moved binary replaces the old moonlet entries instead of duplicating them.
- [x] Before any change the file is copied to `<file>.moonlet-backup-<ms>`, and writes are atomic (temp file plus rename).
- [x] Uninstall removes only moonlet entries.
- [x] `moonlet hook` exits 0 silently when it is not inside a moonlet pane or the daemon is unreachable, with a 2 s cap.

## Protocol and RPCs

- CLI: `moonlet hooks install|status|uninstall`.
- RPC: `hooks.status`, `hooks.install {claude, codex}`, `hooks.uninstall`. The daemon looks for the `moonlet` binary next to `moonletd`.

## Security considerations

These commands edit user config files. Every change is preceded by a backup, and only exact moonlet entries are touched; moonlet entries are matched by the `moonlet` + ` hook ` command pattern.

## Test plan

- `hooks.rs`: `install_preserves_user_settings_and_is_idempotent`, `refuses_to_replace_foreign_codex_notify`.
- `hook_e2e.rs`: `hook_is_silent_outside_moonlet`.
