# X3: Signed, notarized app with auto-update

- **Status:** partial: bundling and the updater done; signing and notarization need an Apple Developer ID
- **Priority / phase:** P1 · phase 3
- **PRD refs:** NFR distribution

## Behaviour and acceptance criteria

- [x] The `bundle` script produces `moonlet.app` with `moonletd` and `moonlet` in `Contents/MacOS` and remote helpers in `Resources/remote`.
- [x] An app update never kills sessions: a version change triggers `moonletd upgrade` ([S3](S3-live-upgrade.md)).
- [ ] Developer ID signing of the app and nested binaries (hardened runtime).
- [ ] Notarization and stapling.
- [x] `tauri-plugin-updater` with a signed update feed ([X35](X35-in-app-update.md)). An app update does not restart the daemon: on the next connect the app sees the version change and runs the bundled `moonletd upgrade`.

The steps for the open items are in [release.md](../release.md).
