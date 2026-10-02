# Release and distribution

## What exists

- `pnpm --filter @jaunt/desktop bundle` builds `jaunt.app` with `jauntd` and `jaunt` as nested binaries (`externalBin`) and any Linux helpers from `src-tauri/remote/` as resources.
- `scripts/build-remote.sh` builds the static musl helpers.

## What needs credentials (not done here)

These steps need an Apple Developer ID and an updater signing key, which this repo does not have.

1. **Code signing.** Set `APPLE_SIGNING_IDENTITY="Developer ID Application: …"`. Tauri signs the app and the nested `jauntd`/`jaunt` binaries with the hardened runtime.
2. **Notarization.** Set `APPLE_ID`, `APPLE_PASSWORD` (app-specific password) and `APPLE_TEAM_ID`. `tauri build` notarizes and staples.
3. **Auto-update.**
   - Generate a key with `pnpm tauri signer generate -w ~/.tauri/jaunt.key`.
   - Add `tauri-plugin-updater` and set `plugins.updater.pubkey` and `endpoints` in `tauri.conf.json`.
   - Build with `TAURI_SIGNING_PRIVATE_KEY`.
   - The daemon is not restarted by an app update. On the next connect the app sees a version change and runs the bundled `jauntd upgrade`, which hands every live session to the new daemon ([S3](specs/S3-live-upgrade.md)).
4. **Helper signing.** Sign the Linux helpers (for example with minisign) and verify the signature in `remote::install` next to the SHA-256 check ([R2](specs/R2-remote-helper-install.md)).
5. **Launch at login.** Once builds are signed, switch from the plist written by `jauntd service install` to `SMAppService` ([ADR 0004](adr/0004-launchagent-plist.md)).
