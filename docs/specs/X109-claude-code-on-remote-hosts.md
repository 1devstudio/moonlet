# X109 — Update Claude Code on a remote host from the app

- **Status:** implemented (2026-11-20). Unit and daemon tests pass. Not yet tried between two real machines.
- **Priority / phase:** P2 · phase 4
- **PRD refs:** agent integration, NFR distribution
- **Related ADRs:** [0011](../adr/0011-machines-connect-over-the-tailnet.md) (machines over the tailnet), [0014](../adr/0014-one-account-across-hosts.md) (headless hosts managed from the app)
- **Related specs:** [X36](X36-claude-code-update.md) (Claude Code on this Mac), [X69](X69-update-hosts-from-the-app.md) (update moonlet on a tailnet host)

## Summary

X36 shows which Claude Code this Mac runs and updates it with `claude update`. Remote hosts were left out of X36: to update Claude Code on the Mac mini, the user had to sit at it, screen-share or SSH in. Every host's daemon already answers `claude.version` and `claude.update`, and a paired Mac may call them. This spec gives each connected remote host its own Claude Code row in Settings › General › Updates, with the version installed there, the newest release, and an **Update to <version>** button that runs `claude update` on that host and shows how far it got.

## User journey

1. The MacBook is connected to `studio-mini` over the tailnet. Claude Code 2.1.296 is out; the mini runs 2.1.292.
2. The user opens Settings › General › Updates. Under "Claude Code 2.1.296" for this Mac there is a row "Claude Code on studio-mini 2.1.292", "2.1.296 is available" and **Update to 2.1.296**.
3. The user clicks it. The line reads "Updating to 2.1.296…", then "Installing 2.1.296…" once `claude update` says it is downloading, and the button is gone.
4. On success the line reads "Updated to 2.1.296. New agents on studio-mini start on it." and the version beside the name is 2.1.296.
5. On failure, such as a Homebrew install, the line shows what `claude update` said ("To update, run: brew upgrade claude-code"), in red, and the button offers the update again.

## Behaviour and acceptance criteria

- [x] A paired Mac over the tailnet may call `claude.version` and `claude.update` on a host; the update's lines reach it as `claude.update_output` events and its end as `claude.update_done`. A paired phone gets `forbidden` for both. (`a_paired_mac_updates_claude_code_on_its_host_but_a_phone_may_not`; it passes on main too: the daemon already allowed this, and the test keeps it so)
- [x] Every remote host that is connected (tailnet or SSH) gets a row, by its label in order. This Mac and a host that is not connected get none. (`lists every connected remote host, tailnet or SSH, by label`)
- [x] The app asks every connected remote host for `claude.version` when Settings › Updates opens, on **Check now** and at the hourly automatic check (X35's switch), not at the one ten seconds after launch. When two checks of a host overlap, the newer one's answer stands. (`asks each host its version`, `runs the hourly-only checks every hour, not at launch (X109)`, `keeps the newest check's answer when an older one fails after it`; which component calls it on opening and Check now has no test, as for X36's checks)
- [x] A host already asked is asked again when it connects again, since its daemon may have restarted with another PATH. One never asked is not, so starting the app runs no `claude --version` on every host. (`asks a remote host Settings asked before once it is connected again`, `leaves a host never asked, one still connected, one not back and this Mac alone`)
- [x] The version beside the host's name is "…" until it answers, and none when it has no `claude`. (`shows the version it runs, … until it answers, and none without claude`)
- [x] The line reads, by state: "Checking…" before the first answer; "Could not ask <host>" when the host did not answer, with no button, since what it runs now is unknown; "Not found on the PATH" when it has no `claude`, whether or not npm answered; "<latest> is available" with **Update to <latest>** when the host's is older; "Up to date" otherwise. With no npm answer, only the installed version shows. The newest release is the one X36's check fetches from npm. (`says what the host runs against npm's newest`, `says a host has no claude even when npm did not answer`, `says the host could not be asked when it does not answer`, `offers the newest release to an older host that is not updating, a failed one again`)
- [x] **Update to <latest>** runs `claude.update` on that host only. While it runs, the line follows its output with X36's steps: "Updating to <latest>…", then "Installing <latest>…" on "Updating to X...", "New version available" or "Installing update...". A second click is ignored. A reply that comes after the host's `claude.update_done` already ended the run leaves a retry started since alone. (`follows an update's lines on that host to its result, and reads the new version`, `ignores a second click while the host updates`, `leaves a retry running when the first run's reply comes after its end`)
- [x] It ends on the reply or on the host's `claude.update_done`, whichever comes first, read as X36 reads it: "Successfully updated from A to version B" gives "Updated to B. New agents on <host> start on it."; "Claude Code is up to date (X)" gives "X is up to date"; anything else is a failure whose line is what `claude update` said after "Checking for updates", or the error, with **Update to <latest>** again. The host is then asked its version again. (`follows an update's lines on that host to its result, and reads the new version`, `follows an update to its end`, `shows what claude update said when it failed, and offers the update again`)
- [x] A result stays until the next check, which replaces it with the version line, or with "Could not ask <host>" when that check gets no answer. A check begun before the update ended changes nothing; a check during an update leaves it running. (`shows what claude update said when it failed, and offers the update again`, `replaces a result with Could not ask when the next check gets no answer`, `keeps the result when a check begun before the update ended answers after it`, `leaves a running update where it is when Check now answers meanwhile`)
- [x] An update started elsewhere (the mini's own window, another Mac) shows as running when a check finds `updating: true`, "Updating to <latest>…" once npm has answered and "Updating…" before, and ends when that host's `claude.update_done` arrives, or at the next check that finds none running (its end came while this Mac was away). (`shows an update started elsewhere until that host says it ended`, `names the release an update elsewhere goes to once npm answers`, `drops an update seen elsewhere once the host says none runs, as after a missed end`)
- [x] Lines and results from one host never move another host's row or this Mac's banner, and a host never asked has no row for them to move. (`leaves another host's row alone`, `gives a host Settings never asked no row from its events`; the app's event handler passing only remote hosts' events on has no test of its own)

## UI

Settings › General › Updates:

    moonlet 0.2.0                      Up to date                 [Check now]
    Claude Code 2.1.296                Up to date
    Claude Code on studio-mini 2.1.292 2.1.296 is available       [Update to 2.1.296]
    Claude Code on build-box 2.1.296   Up to date
    Check for updates automatically                               [on]

While it runs, and after:

    Claude Code on studio-mini 2.1.292 ◌ Installing 2.1.296…
    Claude Code on studio-mini 2.1.296 ● Updated to 2.1.296. New agents on studio-mini start on it.
    Claude Code on studio-mini 2.1.292 ● To update, run: brew upgrade claude-code   [Update to 2.1.296]

## Protocol and RPCs

- None new. The app calls X36's `claude.version` and `claude.update` on the remote host, through the same link as every other request to it. `moonlet-link` already waits 660 s for `claude.update` on any host.

## Data and config

- Nothing persisted. Each host's version and run live in the window's memory.

## Security considerations

- `claude.update` runs one fixed command with no arguments. A paired Mac can already start agents and terminals on the host, so it gains nothing new. Phones stay refused (`PHONE_METHODS` leaves both methods out).
- A cloud machine (X63) and a worker link (X41) are refused by their own method lists.

## Out of scope

- A sidebar banner or toast for a remote host's Claude Code: only Settings shows it.
- **Update all** for Claude Code across hosts.
- Copies of other members' sessions (X72): they are not this Mac's hosts.
- Restarting agents running on the host on the new version.

## Test plan

- Rust integration (`crates/moonletd/tests/mobile.rs`): with a fake `claude` on the host's login PATH, a paired Mac over the tailnet gets the version, runs the update, sees its lines and its `claude.update_done`; a paired phone gets `forbidden` for both methods.
- Unit (`lib/hostClaude.test.ts`): which hosts get a row, and each line and offer, from literal versions and captured `claude update` lines.
- Unit (`lib/hostClaudeStore.test.ts`): a check per host, an update following its lines to its result, one host's events leaving another's row alone, an update started elsewhere, a failure offering the update again.
- No e2e spec: it needs a second host and a real `claude`; not crucial in the X12 sense.
- Manual: from the MacBook, update Claude Code on the Mac mini over Tailscale, then `claude --version` on the mini prints the new version.

## Open questions

- None.
