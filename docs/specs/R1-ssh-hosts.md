# R1: Remote hosts from `~/.ssh/config` via system OpenSSH

- **Status:** implemented
- **Priority / phase:** P0 · phase 2
- **PRD refs:** R1, journey J5, NFR security ("SSH auth stays with OpenSSH")

## Summary

Remote hosts are SSH aliases. moonlet runs the system `ssh`, so ProxyJump, agents, hardware keys, certificates and `Match` blocks all work exactly as in a terminal. moonlet stores no secrets.

## Behaviour and acceptance criteria

- [x] Settings → Remote hosts suggests concrete `Host` aliases from `~/.ssh/config`, following `Include` (with `*` globs, up to 4 levels deep) and skipping wildcard patterns.
- [x] Added hosts persist in `~/.jaunt/app-hosts.json`. Invalid aliases (empty, leading `-`, whitespace) are rejected, so an alias can never become an ssh option.
- [x] ssh runs with `BatchMode=yes` (never prompts inside the app), `ServerAliveInterval=10`, `ServerAliveCountMax=3`, `ConnectTimeout=10`, and connection sharing (`ControlMaster=auto`, `ControlPath=~/.jaunt/run/ssh-%C`, `ControlPersist=10m`) for fast reconnects.
- [x] Connection errors show ssh's message on the host row, with Retry.

## Security considerations

Keys and passwords never pass through moonlet. A key that needs a passphrase must be in the ssh agent, because BatchMode never prompts.

## Test plan

`src-tauri/src/remote.rs`: `parses_ssh_config_with_includes`.
