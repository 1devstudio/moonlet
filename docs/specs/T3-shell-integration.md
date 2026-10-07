# T3: Shell integration (OSC 133 / OSC 7)

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** T3

## Summary

Shell sessions started by moonlet load a small integration script for zsh, bash or fish. The script emits OSC 133 prompt marks (A prompt, B command, C output, D exit code) and OSC 7 working-directory updates. The user's own startup files still run first, unchanged.

## Behaviour and acceptance criteria

- [x] **zsh:** `ZDOTDIR` points to `~/.moonlet/shell/zsh`, whose startup files source the user's real files (from `$MOONLET_USER_ZDOTDIR` or `$HOME`), restore `ZDOTDIR`, then add `precmd`/`preexec` hooks.
- [x] **bash:** started as `bash --rcfile ~/.moonlet/shell/bash/rc` for interactive shells; the rc sources the user's profile and rc, then installs `PROMPT_COMMAND` and a DEBUG trap.
- [x] **fish:** `~/.moonlet/shell/fish` is prepended to `XDG_DATA_DIRS`, so its `vendor_conf.d` script registers `fish_prompt`/`fish_preexec`/`fish_postexec` handlers.
- [x] The scripts are written by the daemon at start (idempotent) and apply only to default shell sessions (no explicit command); agents run their own TUI and are left alone.
- [x] Set `MOONLET_SHELL_INTEGRATION=0` to opt out.
- [x] The daemon tracks OSC 7 as `reported_cwd`. The client uses it for new splits and relative file links.

## Security considerations

The scripts only print escape sequences; they never eval output.

## Test plan

`crates/moonlet-core/src/shell.rs` tests run zsh and bash through the integration in a PTY and assert that OSC 133 A/C/D and OSC 7 appear.
