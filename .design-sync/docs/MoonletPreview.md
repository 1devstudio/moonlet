---
category: Screens
---

# MoonletPreview

Seeds moonlet's app state with demo data (a workspace with two projects, five sessions and a Claude conversation), so `Sidebar`, `AgentView` and `Composer` render without the moonlet daemon. Plain components don't need it.

`selected` picks the highlighted session (`s-checkout`, `s-search`, `s-dark`, `s-refund`, `s-rate`). `chats` overrides the conversation per chat terminal id.

```tsx
<MoonletPreview selected="s-search">
  <Sidebar />
</MoonletPreview>
```
