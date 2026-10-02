# R2: Version-pinned, checksummed remote helper

- **Status:** implemented (Linux helpers need `scripts/build-remote.sh`; see limits)
- **Priority / phase:** P0 · phase 2
- **PRD refs:** R2, NFR security ("remote helper is signed and checksummed, version-pinned, installed only with consent")

## Summary

A remote host needs the same `jauntd` (plus the `jaunt` CLI for hooks) in `~/.jaunt/bin`. The app checks the version on every connect and installs only after the user confirms a dialog that says exactly what will be copied where.

## Behaviour and acceptance criteria

- [x] Before bridging, the app runs `~/.jaunt/bin/jauntd --version` over ssh. If it is missing or a different version, the host goes to `needs_install` and nothing runs on the host.
- [x] Install (after confirmation):
  - `uname -sm` picks the target: `x86_64`/`aarch64` Linux (musl), or macOS, which reuses the app's own binaries;
  - each binary is uploaded over stdin to `~/.jaunt/bin/<name>.new` with `umask 077`;
  - the remote SHA-256 (`sha256sum` or `shasum -a 256`) is compared with the local one; on a mismatch the file is deleted and the install fails;
  - otherwise the file is moved into place atomically.
- [x] After an install, `jauntd proxy` (new binary) takes over from an older running daemon with the live upgrade ([S3](S3-live-upgrade.md)), so sessions survive helper updates.
- [x] Helper lookup order: `$JAUNT_REMOTE_DIR`, the bundle's `Resources/remote/<name>-<triple>`, then `target/<triple>/{release,debug}/` in development.

## Limits

- Code signing of the Linux helper is not in place (there is no Developer ID here). The checksum check protects transfer integrity, not provenance; signing is planned with release automation.
- Building Linux helpers needs `cargo-zigbuild`: `scripts/build-remote.sh`. The code is type-checked for both musl targets.

## Test plan

- `remote.rs`: `triples`, `checksum`.
- Manual: add a host, accept the install, verify `~/.jaunt/bin/jauntd --version` on the host.
