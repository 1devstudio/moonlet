---
category: Screens
---

# AgentView

The full agent conversation screen: messages, tool rows, approval cards, a status line with cost, model/effort and mode menus, and the message editor. Wrap it in `MoonletPreview`, which supplies the demo chat for terminal `id` 1.

```tsx
<MoonletPreview>
  <div style={{ height: 640 }}>
    <AgentView host="local" id={1} wsId="s-checkout" focused={false} visible />
  </div>
</MoonletPreview>
```
