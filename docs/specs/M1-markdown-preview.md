# M1/M2: Markdown preview

- **Status:** implemented
- **Priority / phase:** M1 P0 · phase 1; M2 P1 · phase 3
- **PRD refs:** M1, M2, NFR security (sandboxed preview)

## Summary

The Preview tab renders Markdown with tables, task lists, syntax-highlighted code and Mermaid diagrams, and reloads live. It is sandboxed: no scripts, no IPC, no remote content.

## Behaviour and acceptance criteria

- [x] Rendering uses `markdown-it` with `highlight.js`. Mermaid blocks render to SVG in the app and are inlined; a diagram error shows in place.
- [x] The output is sanitised with DOMPurify: no scripts, iframes, forms, event handlers or `javascript:` URLs. It is shown in `<iframe sandbox="">` with the CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:`.
- [x] Live reload: any `fs.changed` under the file's watched root re-renders it.
- [x] M2: `.md` files open in Preview automatically from the file tree and from terminal links.

## Test plan

`src/lib/markdown.test.ts`: tables and highlighting, script/handler stripping, CSP document.
