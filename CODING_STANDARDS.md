# Coding standards

Read during review. Each rule is one this repo has broken before; tooling does not catch it. Test rules (what to test, how, when work is done) are in [AGENTS.md](AGENTS.md); terms are in [CONTEXT.md](CONTEXT.md). Flag a breach with its rule's heading.

## Class names

- **One utility per property, combined through `cx`.** `cx` (`apps/desktop/src/lib/cx.ts`) lets the later class win (`cx(inputCls, "w-[140px]")`). A template string such as `` `${inputCls} w-[140px]` `` leaves both widths on the element and Tailwind's CSS order picks one; that hid the names in two dialogs.
- **Native controls are sized by the app's CSS.** macOS draws a `<select>` about 21px tall and ignores its height and padding. A sized menu uses `.menu-select`, and a menu and the buttons beside it share `.field-height` (`apps/desktop/src/styles/moonlet.css`).
- A change to how something looks has been seen in the real app (`apps/desktop/e2e/snap.ts`); the report says what the shot showed.

## Specs and the domain model

- **A spec's test citation names a real test, word for word**, so the line can be traced to the test that proves it. A changed behaviour updates its spec line in the same change.
- **A moved concept moves its docs in the same change.** When a field or a decision moves (a setting from one file to another, a link from per-Mac to the repository), update its [CONTEXT.md](CONTEXT.md) entry and amend the ADR that recorded the old place.

## Persisted data

- **Old files keep loading.** A key removed from a config or state file (`trackers.toml`, `.moonlet/config.toml`, `moonlet.settings`) is still read without error and is not written back; a test parses a file that has it.
- **A string format has one build and one parse.** An id such as `<connection>/<key>` is written and read by one pair of functions (`trackerLink`/`parseTrackerLink`), never by inline `indexOf` or template strings at each site.
- **Ids are compared with their host.** A project, session or workspace id is unique per host only (`projects[host]`); a lookup that crosses hosts compares `host` and `id`.

## Settings

- A new app setting has an entry in settings search (`apps/desktop/src/lib/settingsSearch.ts`) with a test, and a default for a missing value.
