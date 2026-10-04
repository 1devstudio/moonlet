---
category: Status
---

# StateGlyph

Agent state marker used in the sidebar and tabs: pulsing dots while working, colored dots for blocked/done/error, and a branch icon when idle.

`state`: `idle`, `working`, `blocked` (needs input, yellow), `done` (green), `error` (red).

```tsx
<span className="flex items-center gap-2"><StateGlyph state="blocked" /> Needs input</span>
```
