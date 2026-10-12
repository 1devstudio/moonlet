# Release and distribution

## What exists

- `pnpm --filter @moonlet/desktop bundle` builds `moonlet.app` with `moonletd` and `moonlet` as nested binaries (`externalBin`) and any Linux helpers from `src-tauri/remote/` as resources.
- `scripts/build-remote.sh` builds the static musl helpers.
- In-app updates ([X35](specs/X35-in-app-update.md)). The public key is in `tauri.conf.json` under `plugins.updater`, and the private key is in `~/.tauri/moonlet.key`. Back it up: without it no installed app accepts another update.

## Publishing a release

1. Bump the version (`Cargo.toml`, `apps/desktop/package.json`, `tauri.conf.json`, `Cargo.lock`) in a `chore: bump the version to X.Y.Z` PR and merge it.
2. Tag the merge and push the tag: `git tag vX.Y.Z origin/main && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` builds on an Apple Silicon runner, signs `moonlet.app.tar.gz` with the updater key and publishes the release with `latest.json`. Installed apps find it within six hours, or at once with **Check now** in Settings › Updates.

The workflow needs two repository secrets, set once:

- `TAURI_SIGNING_PRIVATE_KEY`: `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/moonlet.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the key's password. Leave it unset if the key has none.

The release stays a draft until every asset is uploaded, so `releases/latest` never points at one without `latest.json`. A local `pnpm bundle` builds without the key: only the workflow adds `src-tauri/tauri.release.json`, which turns on the updater artifacts.

## What needs credentials (not done here)

These steps need an Apple Developer ID, which this repo does not have.

1. **Code signing.** Set `APPLE_SIGNING_IDENTITY="Developer ID Application: …"`. Tauri signs the app and the nested `moonletd`/`moonlet` binaries with the hardened runtime.
2. **Notarization.** Set `APPLE_ID`, `APPLE_PASSWORD` (app-specific password) and `APPLE_TEAM_ID`. `tauri build` notarizes and staples.
3. **Helper signing.** Sign the Linux helpers (for example with minisign) and verify the signature in `remote::install` next to the SHA-256 check ([R2](specs/R2-remote-helper-install.md)).
4. **Launch at login.** Once builds are signed, switch from the plist written by `moonletd service install` to `SMAppService` ([ADR 0004](adr/0004-launchagent-plist.md)).
