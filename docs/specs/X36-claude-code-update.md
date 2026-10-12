# X36 — Tell the user about a new Claude Code and update it from the app

- **Status:** implemented (2026-10-12). Unit and daemon tests pass. A real update from an older Claude Code and the banner in the running app are not checked yet.
- **Priority / phase:** P2 · phase 3
- **PRD refs:** agent integration
- **Related:** [X35](X35-in-app-update.md) (moonlet's own updates), [X33](X33-workspace-claude-profiles.md) (Claude profiles)

## Summary

moonlet runs the `claude` found on the user's PATH. Claude Code updates itself in the background unless that is turned off, but the user cannot see which version their agents run or that a newer one exists. moonlet now compares the installed version with the newest release, shows a banner in the sidebar when a newer one is out, and runs `claude update` from the banner, showing its steps as it goes. The update replaces nothing that is running: a native install keeps every version in its own folder, so running agents keep their binary and new ones start on the new version.

## User journey

1. Ten seconds after launch, and every six hours after, moonlet asks the daemon for `claude --version` and npm for the newest release.
2. A newer release shows a banner above the sidebar footer: "Claude Code 2.1.296 is available", "You have 2.1.292", **Later** and **Update**.
3. The user clicks **Update**. The banner reads "Updating Claude Code", "2.1.292 → 2.1.296", lists the steps (Check for updates, Download and install, Done) with the current one spinning, and an animated bar runs underneath.
4. When `claude update` reports success, the banner reads "Claude Code updated to 2.1.296" and "New agents start on 2.1.296." with a close button.
5. When it fails, or Claude is managed by Homebrew or another package manager, the banner shows what `claude update` said (for example "To update, run: brew upgrade claude-code") with **Retry** and a close button.
6. A result stays until the user closes it. Closing does not hide the release: a failed one comes back at the next check.
7. **Settings › Updates** shows the installed Claude Code version under moonlet's with a status (Checking…, Updating…, "2.1.296 is available", Up to date, or "Not found on the PATH"), an **Update to 2.1.296** button even for a release the user said Later to, and **Check now** checks both.

## Behaviour and acceptance criteria

- [x] `claude.version` returns the version printed by `claude --version` (`2.1.296 (Claude Code)` → `2.1.296`), or null when `claude` is not on the PATH or prints something else.
- [x] The newest release is the `latest` dist-tag of `@anthropic-ai/claude-code` on the npm registry.
- [x] The banner shows when the newest release is newer than the installed one (compared number by number, so 2.1.10 is newer than 2.1.9), and not when it is the same, older, or either is unknown.
- [x] **Later** hides the banner for that version. A newer release shows it again. The close button on a result hides only the banner.
- [x] Automatic checks run while "Check for updates automatically" (X35) is on, and fail quietly. A check leaves a running update, and a result the user has not closed, alone.
- [x] `claude.update` runs `claude update`, sends each output line as a `claude.update_output` event while it runs, and returns the whole output and whether it exited with 0, also sent to every client as `claude.update_done`. A second call while one runs fails with "Claude Code is already updating", and `claude.version` reports `updating: true` meanwhile.
- [x] A window that opens or reloads during an update shows its steps, and every window shows how it ended.
- [x] The app waits for `claude.update` longer than the daemon's ten minutes.
- [x] The step list follows the output: "Checking for updates…" is the first step, "Updating to Y...", "New version available" or "Installing update..." the second, "Successfully updated from A to version B" (or "Successfully downgraded", under a server-side version policy) finishes on B.
- [x] "Claude Code is up to date (X)" finishes with "Claude Code X is up to date" and hides the banner for the release that was announced (the user's channel may be behind `latest`).
- [x] Anything else is a failure. The banner shows the output after the "Checking for updates" line, without blank lines, or "claude update failed" when there is none.
- [ ] Once finished, the installed version shown in Settings is the new one.

## UI

Sidebar, above the footer:

    ╭──────────────────────────────╮
    │ ✳ Claude Code 2.1.296 is available │
    │   You have 2.1.292            │
    │             [Later] [Update]  │
    ╰──────────────────────────────╯

    ╭──────────────────────────────╮
    │ ✳ Updating Claude Code        │
    │   2.1.292 → 2.1.296           │
    │   ✓ Check for updates         │
    │   ◌ Download and install      │
    │   ○ Done                      │
    │   ▰▰▰▱▱▱▱▱▱▱▱ (animated)      │
    ╰──────────────────────────────╯

    ╭──────────────────────────────╮
    │ ✓ Claude Code updated to 2.1.296  [×] │
    │   New agents start on 2.1.296.│
    ╰──────────────────────────────╯

    ╭──────────────────────────────╮
    │ ! Claude Code update failed   [×] │
    │   Claude is managed by Homebrew. │
    │   To update, run:             │
    │     brew upgrade claude-code  │
    │                     [Retry]   │
    ╰──────────────────────────────╯

`claude update` reports stages, not bytes, so the bar is indeterminate.

Settings › Updates gains a row under moonlet's:

    Claude Code 2.1.292  2.1.296 is available      [Update to 2.1.296]

## Protocol and RPCs

- `claude.version` → `{ version: string | null, updating: bool }`.
- `claude.update` → `{ ok: bool, output: string }` once `claude update` exits (ten-minute limit; the app waits eleven). While it runs, each line of its stdout and stderr is sent to every client as the event `claude.update_output` `{ line: string }`; when it ends, the result goes to every client as `claude.update_done`. A run that could not start ends with `ok: false` and the error as its output.
- Both run the `claude` that agents run: found on the daemon's login-shell PATH, with the daemon's environment.
- The app gains the Tauri command `claude_latest_version`, which fetches `https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags` in Rust, so the CSP is unchanged.

## Data and config

- `moonlet.settings` in localStorage gains `claudeUpdateDismissed`: the release the user said **Later** to (default null).
- Nothing in the daemon's state.

## Security considerations

- The app runs one fixed command, `claude update`, with no arguments from the user. Claude's own updater downloads and verifies the release.
- The npm request is a read-only HTTPS GET; its answer only decides whether to show the banner.

## Out of scope

- Codex and other agents.
- Release channels: the banner compares with `latest`. A user on the `stable` channel can see a release `claude update` does not install; the "up to date" answer then hides it.
- Claude Code on remote hosts: only the local daemon is checked.
- Restarting running agents on the new version.

## Test plan

- Unit (`lib/claudeUpdate.test.ts`): version comparison, when the banner shows (newer, same, older, unknown, dismissed, an update already running, a result not yet closed), the steps for `claude update` output (up to date captured from a real run; updated, Homebrew and another process running written from the lines in Claude Code 2.1.296's update command, since they need an older or Homebrew install to capture), the failure text, the banner's text and buttons per state, Later versus close, and the Settings status and offer.
- Unit (Rust, app crate): the app waits 660 s for `claude.update`.
- Unit (Rust, `moonlet-core`): `claude --version` parsing, and the dist-tags parsing in the app crate, both with captured output.
- Integration (`crates/moonletd/tests/daemon.rs`): with a fake `claude` on the login PATH, `claude.version` returns its version and whether an update runs, and `claude.update` streams its lines as events, refuses a second update while one runs, returns its output and sends it as `claude.update_done`.
- No e2e spec: the feature needs the network and a real `claude`, and is not crucial in the X12 sense.
- Manual: with an older Claude Code installed (`claude install 2.1.290`), launch moonlet, see the banner, update, and check that `claude --version` and Settings show the new version.

## Open questions

- None.
