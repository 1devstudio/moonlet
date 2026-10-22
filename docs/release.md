# Release and distribution

## What exists

- `pnpm --filter @moonlet/desktop bundle` builds `moonlet.app` with `moonletd` and `moonlet` as nested binaries (`externalBin`) and any Linux helpers from `src-tauri/remote/` as resources.
- `scripts/build-remote.sh` builds the static musl helpers.
- `scripts/package-linux.sh` packs them for a release ([X58](specs/X58-linux-install-script.md)): `moonlet-linux-x86_64.tar.gz`, `moonlet-linux-aarch64.tar.gz`, `SHA256SUMS`, and `install.sh` with the version written in. The release workflow uploads them before it publishes, so `curl -fsSL https://github.com/1devstudio/moonlet/releases/latest/download/install.sh | sh` installs the latest release on a Linux host. `scripts/test-install.sh` tests the script; CI's `linux-install` job runs it on Ubuntu with systemd.
- In-app updates ([X35](specs/X35-in-app-update.md)). The public key is in `tauri.conf.json` under `plugins.updater`, and the private key is in `~/.tauri/moonlet.key`. Back it up: without it no installed app accepts another update.

## Publishing a release

1. Bump the version (`Cargo.toml`, `apps/desktop/package.json`, `tauri.conf.json`, `Cargo.lock`) in a `chore: bump the version to X.Y.Z` PR and merge it.
2. Tag the merge and push the tag: `git tag vX.Y.Z origin/main && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` builds on an Apple Silicon runner, signs the app with the Developer ID, has Apple notarize it, signs `moonlet.app.tar.gz` with the updater key and publishes the release with `latest.json`. Installed apps find it within an hour, or at once with **Check now** in Settings › Updates.

The workflow needs two repository secrets, set once:

- `TAURI_SIGNING_PRIVATE_KEY`: `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/moonlet.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the key's password. Leave it unset if the key has none.

The release stays a draft until every asset is uploaded, so `releases/latest` never points at one without `latest.json`. A local `pnpm bundle` builds without the key: only the workflow adds `src-tauri/tauri.release.json`, which turns on the updater artifacts.

## Code signing and notarization

Release builds are signed with the Developer ID Application certificate of team `LE9Q47C92D`. Tauri signs the app and the nested `moonletd`/`moonlet` binaries with the hardened runtime, then notarizes and staples the app. The workflow then notarizes and staples the DMG too, so its first open passes Gatekeeper even offline, and replaces the DMG tauri-action uploaded. The workflow fails before building if a secret is missing. After building, its "App is signed with the Developer ID and notarized" step fails unless every binary carries the team and the hardened runtime, and the app, the DMG and the app inside the update archive are notarized.

The secrets live in the `release` environment, which only `v*` tags may use. A workflow that names a missing environment creates it without that rule, so create it first:

```sh
gh api -X PUT repos/1devstudio/moonlet/environments/release \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/1devstudio/moonlet/environments/release/deployment-branch-policies \
  -f name='v*' -f type=tag
```


| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | the Developer ID certificate and its private key, exported from Keychain Access as `.p12`, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <name> (LE9Q47C92D)`, as printed by `security find-identity -v -p codesigning` |
| `APPLE_API_KEY` | the Key ID of an App Store Connect team key with the Developer role |
| `APPLE_API_ISSUER` | the Issuer ID shown above the team keys |
| `APPLE_API_KEY_P8` | the contents of the key's `AuthKey_<KEYID>.p8` |

```sh
base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE --env release
gh secret set APPLE_API_KEY_P8 --env release < AuthKey_<KEYID>.p8
```

The certificate expires a year or so after issue. Apps signed before then keep working; to release after it, issue a new one from a CSR made on a Mac, then replace `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` and `APPLE_SIGNING_IDENTITY`. If `security find-identity` lists the new certificate but finds no valid identity, import Apple's "Developer ID - G2" intermediate certificate.

To sign and notarize a local build, set the same variables with `APPLE_API_KEY_PATH` pointing at the `.p8` file, then check the result:

```sh
spctl -a -vvv -t exec target/release/bundle/macos/moonlet.app
# accepted  source=Notarized Developer ID
```

## Still open

1. **Helper signing.** Sign the Linux helpers (for example with minisign) and verify the signature in `remote::install` next to the SHA-256 check ([R2](specs/R2-remote-helper-install.md)).
