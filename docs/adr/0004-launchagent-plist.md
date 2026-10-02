# ADR 0004: LaunchAgent plist and launchctl instead of SMAppService (for now)

- **Status:** accepted (2026-10-02); revisit at the release-signing milestone

## Context

The plan called for `SMAppService.agent(plistName:)`, which registers a LaunchAgent bundled inside the app. SMAppService only works for a signed app bundle launched from its installed location, and approval goes through System Settings › Login Items. Neither can be exercised in development builds, which are unsigned and run from `target/`.

## Decision

`jauntd service install` writes a standard per-user plist into `~/Library/LaunchAgents` and loads it with `launchctl bootstrap gui/<uid>`. This works for dev and release builds and is easy to inspect and remove.

## Consequences

- The plist holds an absolute path to the binary. If the app moves, reinstalling (from Settings) updates it; the app reinstalls when the stored path no longer exists.
- When signed builds ship, switch to SMAppService so the agent shows in Login Items with the app's name; the daemon side is unchanged.
