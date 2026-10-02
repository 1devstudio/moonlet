# X3: Signed, notarized app with auto-update

- **Status:** partial: bundling done; signing, notarization and the updater need credentials
- **Priority / phase:** P1 · phase 3
- **PRD refs:** NFR distribution

## Behaviour and acceptance criteria

- [x] The `bundle` script produces `jaunt.app` with `jauntd` and `jaunt` in `Contents/MacOS` and remote helpers in `Resources/remote`.
- [x] An app update never kills sessions: a version change triggers `jauntd upgrade` ([S3](S3-live-upgrade.md)).
- [ ] Developer ID signing of the app and nested binaries (hardened runtime).
- [ ] Notarization and stapling.
- [ ] `tauri-plugin-updater` with a signed update feed.

The steps for the open items are in [release.md](../release.md).
