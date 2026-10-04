---
category: Agent chat
---

# ToolRow

One agent tool call as a compact row: icon, tool name, one-line summary, diff stat for edits, and a status mark. Click to expand the output or diff.

Paths under `cwd` are shown relative to it.

```tsx
<ToolRow cwd="/repo" tool={{ name: "Bash", summary: "pnpm test", input: {}, output: "42 passed", status: "ok" }} />
```
