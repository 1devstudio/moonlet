# X12: End-to-end tests of the desktop app

- **Status:** implemented (2026-10-04): 8 tests in 3 spec files, green three runs in a row (about 6 s after the build). macOS only so far.
- **Priority / phase:** P1 · phase 3
- **Related:** [X8](X8-project-settings.md) (first flow covered), [manual checks](../manual-checks.md) (M10 becomes automated), [AGENTS.md](../../AGENTS.md)

## Summary

Unit tests cover the daemon and the app's `lib/` logic, but nothing exercises the real window: a React component wired to the wrong RPC, or a dialog that never opens, only shows up when someone clicks through the app. X12 adds end-to-end tests that launch the real jaunt app against a real `jauntd`, drive the WKWebView with WebdriverIO, and check what a user would see.

## Approach

- **Runner:** WebdriverIO with `@wdio/tauri-service`, using its **embedded** driver. The `tauri-plugin-wdio-webdriver` crate runs a W3C WebDriver server inside the app, which is the only driver that works on macOS (Apple ships no WKWebView driver, so `tauri-driver` is Windows and Linux only).
- **Build:** the plugin is behind a cargo feature, `e2e`. Release and dev builds never contain it, because it exposes the window over HTTP. The e2e build uses its own target directory (`target/e2e`) and embeds the built frontend, so it needs no Vite server and doesn't disturb a running `pnpm dev`.
- **Plugins:** `tauri-plugin-wdio-webdriver` (the driver) and `tauri-plugin-wdio` (window states, which the service asks for), both behind `e2e`, and `withGlobalTauri` in the e2e config only.
- **Capability:** the plugins' `wdio-webdriver:default` and `wdio:default` permissions live in an inline capability in `src-tauri/tauri.e2e.conf.json`, which only the e2e build merges. `capabilities/default.json` stays unchanged, so normal builds don't reference a plugin they don't compile.
- **Isolation:** each run creates a scratch `JAUNT_HOME` and a scratch git repo under the system temp dir. `JAUNT_BIN_DIR` points the app at the e2e build's `jauntd`. Before the app starts, the harness starts that daemon and seeds a project and a session through `jaunt rpc`. Sessions use `agent: "none"` and the repo's only agent is a fake shell command, so no test ever starts a real Claude or Codex. The daemon is shut down and the scratch dirs deleted at the end.

## Behaviour and acceptance criteria

- [x] `pnpm e2e:build` builds the app with the `e2e` feature, plus `jauntd` and `jaunt`, into `target/e2e/debug`.
- [x] `pnpm e2e` runs every spec in `apps/desktop/e2e/specs` against that build and exits non-zero on a failure. A failing test leaves a window screenshot in `apps/desktop/e2e/artifacts/`.
- [x] Release and dev builds do not contain the WebDriver plugins (`cargo tree -p jaunt-app` lists them only with `--features e2e`).
- [x] A run never touches `~/.jaunt` or a real repository, and leaves no daemon or temp dir behind. The daemon runs with a scratch `HOME`, `SHELL=/bin/zsh` (so shells get the integration, T3), and a `PATH` whose `claude` and `codex` are stubs that fail; every zsh startup file and `.profile` put the stubs first.
- [x] **Smoke** (`smoke.e2e.ts`): the app starts, connects to the scratch daemon, and the sidebar shows the seeded project and session.
- [x] **Project settings** (`project-settings.e2e.ts`, X8 and M10):
  - with no `run` command, clicking Run opens the dialog with the Run field focused;
  - saving a run command closes the dialog, keeps the file's comments, and turns the Run button on without switching sessions;
  - a built-in agent name and an unknown default agent show inline errors and disable Save, and a custom agent row lays out as a 150px name plus the command;
  - Escape with unsaved changes asks "Discard unsaved changes?";
  - a save after the file changed on disk shows "The file changed on disk" with Reload;
  - a file that does not parse shows the parse error instead of the form.
- [x] **New session and Run** (`new-session.e2e.ts`): creating a session from the composer with the fake agent adds it to the sidebar with a `fake` tab; clicking Run opens a `run` tab.

## Bugs the tests found

- The Run field was never focused when Project settings opened from Run: the dialog called `focus()` before React had re-enabled the form's `<fieldset>`. It now focuses from an effect after the first load renders.
- In a custom agent row, the name input took the full width and pushed the command input out of the dialog, because it had both `w-full` and `w-[150px]`. The error border had the same conflict with the normal border colour. Each field now gets one width and one border colour.

## Driver notes

These are quirks of the embedded driver (`tauri-plugin-wdio-webdriver` 1.4), worked around in `e2e/fixtures.ts`:

- `isEnabled` and `setValue` ignore a disabled `<fieldset>`, so a test can type into a form that is still loading and lose the text when it loads. `fill()` waits for `:disabled` to be false and types with the native value setter plus an `input` event.
- `browser.execute` runs in an isolated JavaScript world: it sees the DOM and `localStorage`, but not the app's globals.
- Before every command the service probes window focus through Tauri, 5 s each when that fails. Switching to the main window once in `before` turns the probe off.
- The specs never reload the window. They reset the config on disk, then make a no-op `project.set_config` call so the app gets `projects.changed`.

## Layout

- `apps/desktop/e2e/wdio.conf.ts`: the WebdriverIO config, plus scratch setup and teardown.
- `apps/desktop/e2e/fixtures.ts`: the scratch repo, `jaunt rpc` helpers, `fill()` and selectors.
- `apps/desktop/scripts/e2e-build.mjs` and `src-tauri/tauri.e2e.conf.json`: the e2e build.
- `apps/desktop/e2e/specs/*.e2e.ts`: one file per flow. The `.e2e.ts` suffix keeps Vitest from picking them up.

## Out of scope

- CI. The repo has no CI yet; the tests run locally with `pnpm e2e`.
- Remote hosts (SSH), notifications and other native dialogs, which WebDriver can't reach.
- Windows and Linux, which should work with the same plugin but are not tried.

## Test plan

The e2e specs are the tests. `pnpm test` (unit tests) stays separate and fast; `pnpm e2e` is run before merging UI changes.

## Open questions

- Whether the e2e tests should become part of `pnpm test`. For now they are not, because they need a several-minute debug build.
