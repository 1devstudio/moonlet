# X3: Signed, notarized app with auto-update

- **Status:** partial: bundling, the updater, signing and notarization done; launch at login through SMAppService and helper signing open
- **Priority / phase:** P1 · phase 3
- **PRD refs:** NFR distribution

## Behaviour and acceptance criteria

- [x] The `bundle` script produces `moonlet.app` with `moonletd` and `moonlet` in `Contents/MacOS` and remote helpers in `Resources/remote`.
- [x] An app update never kills sessions: a version change triggers `moonletd upgrade` ([S3](S3-live-upgrade.md)).
- [x] Developer ID signing of the app and nested binaries (hardened runtime). The release workflow fails unless every binary in `Contents/MacOS` carries team `LE9Q47C92D` and the hardened runtime.
- [x] Notarization and stapling. The release workflow fails unless Gatekeeper accepts the app and its stapled ticket, and accepts the app inside the update archive.
- [x] `tauri-plugin-updater` with a signed update feed ([X35](X35-in-app-update.md); untried until two releases are published). An app update does not restart the daemon: on the next connect the app sees the version change and runs the bundled `moonletd upgrade`.

The steps for the open items are in [release.md](../release.md).
