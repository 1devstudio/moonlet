# X3: Signed, notarized app with auto-update

- **Status:** implemented (CI signing untried until the next tag)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** NFR distribution

## Behaviour and acceptance criteria

- [x] The `bundle` script produces `moonlet.app` with `moonletd` and `moonlet` in `Contents/MacOS` and remote helpers in `Resources/remote`.
- [x] An app update never kills sessions: a version change triggers `moonletd upgrade` ([S3](S3-live-upgrade.md)).
- [x] Developer ID signing of the app and nested binaries (hardened runtime). Checked by the release workflow step "App is signed with the Developer ID and notarized": every binary in `Contents/MacOS` carries team `LE9Q47C92D` and the hardened runtime.
- [x] Notarization and stapling. Checked by the same step: the app, the DMG and the app inside the update archive are notarized, and the app's and the DMG's tickets are stapled.
- [x] `tauri-plugin-updater` with a signed update feed ([X35](X35-in-app-update.md); untried until two releases are published). An app update does not restart the daemon: on the next connect the app sees the version change and runs the bundled `moonletd upgrade`.

Signing and notarization are set up as described in [release.md](../release.md), which also lists the distribution work still open.
