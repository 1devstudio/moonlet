# X35 — Check for updates and install them in the app

- **Status:** implemented (2026-10-12). Unit tests pass. The signature refusal and the workflow (the two open criteria) and a real update wait for two releases published by the workflow.
- **Priority / phase:** P1 · phase 3
- **PRD refs:** NFR distribution
- **Related:** [X3](X3-distribution.md) (distribution), [S3](S3-live-upgrade.md) (daemon upgrade without killing sessions)

## Summary

moonlet checks GitHub for a newer release, downloads it, verifies its signature and replaces itself, then relaunches when the user says so. Until now a new version meant downloading a DMG from a draft release by hand. The daemon is not part of the app process, so sessions survive the relaunch: on reconnect the app sees the daemon's older version and hands every session to the new `moonletd` (S3).

## User journey

1. A new version is published (a `v*` tag builds and publishes a GitHub release with `latest.json`).
2. Within ten seconds of launch, and every hour after, moonlet checks for it. When one is found, a toast says "moonlet 0.1.15 is available" with an **Install** button, and an "Update to 0.1.15" button appears in the sidebar footer.
3. The user clicks **Install**. The footer button shows the download progress, then "Restart to update".
4. The user clicks it. moonlet relaunches as 0.1.15, upgrades the daemon, and every terminal and agent is still there.
5. **Settings › General › Updates** (X43) shows the running version, a **Check now** button and a "Check for updates automatically" checkbox. **Check for updates…** in the Run action modal (⌘K) does the same as **Check now**.

## Behaviour and acceptance criteria

- [x] The app asks the updater endpoint ten seconds after launch and every hour, while "Check for updates automatically" is on (the default). With it off, the app only checks when asked.
- [x] A found update shows the "Update to X.Y.Z" footer button and announces itself once per version with a toast and an **Install** action. A periodic check that finds the same version again does not toast again.
- [x] A check that runs while an update is downloading, installing or waiting for a restart leaves that state alone.
- [x] While downloading, the footer button shows the percentage when the size is known, and the downloaded megabytes when it isn't.
- [x] After the install, the footer button reads "Restart to update" and relaunches the app.
- [x] A check the user asked for always reports: "moonlet X.Y.Z is up to date", the found version, where an update in progress is ("moonlet 0.1.15: Downloading 42%"), or the error, which Settings › Updates also shows. Asked for while another check runs, that check reports instead. An automatic check fails quietly (only logged), so being offline is not an error.
- [ ] An update whose signature does not match the public key in `tauri.conf.json` is refused by the updater and reported as an error. Nothing is installed.
- [ ] The release workflow publishes a non-draft, non-prerelease GitHub release for `v*` tags. It contains the DMG, the updater archive (`.app.tar.gz`), its `.sig` and `latest.json`, and fails when the tag does not match the app version.

## UI

Sidebar footer, next to the Settings gear and the profile:

    [⚙] [profile]          [↓ Update to 0.1.15]
                           [◌ Downloading 42%]      (megabytes when the size is unknown)
                           [◌ Installing…]
                           [↻ Restart to update]

Settings › Updates. The status is the last error when a check the user asked for, or an install, failed. The action button is the footer's button while it has an action:

    Updates
    moonlet 0.1.14  <Checking… | Up to date | 0.1.15 is available | Downloading 42% | 0.1.15 is installed | error>  [Update to 0.1.15 | Restart to update] [Check now]
    [x] Check for updates automatically

## Protocol and RPCs

None in the daemon. The app adds `tauri-plugin-updater` (check, download, install) and `tauri-plugin-process` (relaunch). The webview calls them through `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process`; the network request runs in Rust, so the CSP is unchanged.

## Data and config

- `tauri.conf.json` `plugins.updater`: the minisign public key and one endpoint, `https://github.com/1devstudio/moonlet/releases/latest/download/latest.json`. `releases/latest` skips drafts and prereleases.
- `moonlet.settings` in localStorage gains `autoUpdateCheck` (default `true`).
- Only release builds register the updater plugin. `pnpm dev` and e2e builds have no bundle to replace and must not pick up a published release, so a check there fails (quietly when automatic).
- The release workflow builds with `bundle.createUpdaterArtifacts: true` and signs with the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. A local `pnpm bundle` does not need the key.

## Security considerations

- The update archive is verified against the public key compiled into the app before anything is replaced. The private key lives only in the user's `~/.tauri/moonlet.key` and the repository secrets.
- The endpoint is HTTPS; the updater enforces TLS in release builds.
- The app is Developer ID signed and notarized (X3), and so is the app inside the update archive. An update is downloaded by the app, not a browser, so macOS does not quarantine it.

## Out of scope

- Skipping a version, release channels (beta), release notes in the app.
- Updating the remote Linux helpers on hosts (R2).
- Intel or universal builds: releases are Apple Silicon only, like today's bundles.

## Test plan

- Unit (`lib/updater.test.ts`): `afterCheck` (found, not found, same version again, during a download or install, and what an automatic and a manual check tell the user, errors included), `afterDownloadEvent` progress, `updateButton` (label, action and tooltip per state, so Restart relaunches), `updateStatus` (the Settings status and the last error) and `scheduleUpdateChecks` (10 s, every hour, skipped while the setting is off, with fake timers).
- Unit (`lib/runActions.test.ts`): "Check for updates…" is in the Run action catalogue.
- Not covered by unit tests: the plugin calls themselves (`check`, `downloadAndInstall`, `relaunch`), the signature check (the updater plugin's own) and the workflow. They wait for the manual run below. The signed archive was checked once by hand: a local build with the workflow's configs produced `moonlet.app.tar.gz.sig`, which `minisign-verify` accepts with the public key in `tauri.conf.json` and rejects for a tampered archive.
- No e2e spec: e2e builds are debug builds, which have no updater, and a real update needs a published signed release. The automatic-check checkbox is a plain localStorage setting like X10's sounds.
- Manual, once the workflow has published two releases: install the older one, launch it, see the toast, install, restart, and check that the sessions survived and `moonlet rpc daemon.info` reports the new version.

## Open questions

- None.
