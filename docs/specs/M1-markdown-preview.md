# M1/M2: Markdown preview

- **Status:** implemented
- **Priority / phase:** M1 P0 · phase 1; M2 P1 · phase 3
- **PRD refs:** M1, M2, NFR security (sandboxed preview)

## Summary

The Preview tab renders Markdown with tables, task lists, syntax-highlighted code and Mermaid diagrams, and reloads live. It is sandboxed: no scripts, no IPC, no remote content.

## Behaviour and acceptance criteria

- [x] Rendering uses `markdown-it` with `highlight.js`. Mermaid blocks render to SVG in the app and are embedded as `<img src="data:image/svg+xml…">`; an SVG image is inert (no scripts, no external loads). HTML labels are turned off (`htmlLabels: false`), because `<foreignObject>` labels do not render inside an image. A diagram error shows in place.
- [x] The output is sanitised with DOMPurify: no scripts, iframes, forms, event handlers or `javascript:` URLs. It is shown in `<iframe sandbox="">` with the CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:`.
- [x] Live reload: any `fs.changed` under the file's watched root re-renders it.
- [x] M2: `.md` files open in Preview automatically from the file tree and from terminal links. Since [X26](X26-file-tabs.md) they open in an editor tab whose Source / Preview switch shows the rendered page in the tab.
- [x] (Removed by [X26](X26-file-tabs.md): the source is in the same tab.) A copy button in the Preview header put the whole raw Markdown source of the open file on the clipboard and confirms with a "Copied Markdown" toast. It is disabled until the current file has loaded and while the preview shows an error, so it never copies a previously opened file.

## Test plan

`src/lib/markdown.test.ts`: tables and highlighting, script/handler stripping, CSP document. Manual: open a `.md` file, click the copy button and paste; switch files and check that the button stays disabled until the new file has loaded.
