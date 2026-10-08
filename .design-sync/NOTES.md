# design-sync notes (moonlet)

- **Source shape: package, built from the app.** moonlet has no published DS package. `apps/desktop/src/ds/index.ts` is the DS entry: it re-exports the presentational components plus the app screens (`Sidebar`, `AgentView`, `Composer`), the `MoonletPreview` demo-state wrapper, an `icons` object (lucide-react) and `inputCls`. `pnpm --filter @moonlet/desktop build:ds` builds it with Vite library mode plus `tsc` declarations into `apps/desktop/ds/dist` (gitignored). `apps/desktop/ds/package.json` (`@moonlet/ds`) is what the converter resolves from `--entry`.
- **Converter command:** `node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules apps/desktop/node_modules --entry apps/desktop/ds/dist/index.js --out ./ds-bundle`. Run `build:ds` first.
- **Daemon stub:** `src/ds/tauri-stub.ts` installs a fake `window.__TAURI_INTERNALS__` only when absent, answering `rpc` with demo data from `src/ds/preview.tsx`. Screens must be wrapped in `MoonletPreview` (it seeds the zustand stores before children render).
- **Excluded on purpose:** Monaco-based panels (RightPanel, ChangesPanel, CodeViewer, SessionView). `lib/monaco.ts` uses Vite's `?worker` import, which the converter's esbuild cannot bundle. TerminalPane needs live PTY output. `MenuItems` is internal to `Menu` (`componentSrcMap: null`).
- **Mermaid** is aliased to a stub in `vite.ds.config.ts`; diagrams are app-only.
- **Styles:** `src/styles/moonlet.css` holds the theme tokens and component classes, shared by the app's `index.css` and `src/ds/ds.css`. App-shell rules (`overflow: hidden`, `user-select: none`) stay in `index.css`. Tailwind v4 compiles only classes used in `src/`, so **preview layout sizes use inline `style`**: arbitrary classes like `w-[280px]` don't exist unless the app uses them.
- **Fonts:** Inter and JetBrains Mono (OFL, `@fontsource` 5.3.0 latin 400–700 / 400–600) live in `.design-sync/fonts/` and are wired via `extraFonts`. The user chose to ship them (2026-10-04). The app itself relies on system fonts.
- **Props:** types that reference app-internal types (ToolCall, ChatItem, PermissionAsk, MenuItem) are inlined via `dtsPropsFor`. Button/IconButton props are hand-written there too, because the extractor dropped the inherited DOM props.
- **Store sharing:** cells in one card share the app store. AgentView's two cells use different chat terminals (1 and 3) so their seeds don't collide.
- **Playwright** must match the cached Chromium. Playwright 1.63.0 pins chromium-1243 (installed under `.ds-sync`).

## Known render warns

- None outstanding; GRID_OVERFLOW was resolved with `cardMode: column/single` overrides.

## Re-sync risks

- `src/ds/preview.tsx` demo data mirrors the store and protocol shapes. A change to `State`, `Session`, `TerminalInfo` or `ChatState` can break the screen previews silently, so re-check Sidebar/AgentView/Composer sheets after store refactors.
- `dtsPropsFor` bodies are hand-copied from component props. If ToolCall, ChatItem, PermissionAsk or MenuItem change, update them.
- Exporting more AgentView internals changes what the DS can show. Components added to `src/ds/index.ts` need a preview and a doc in `.design-sync/docs/`.
- Fonts were fetched from npm (`@fontsource`), not built from the repo.
