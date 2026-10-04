---
category: Agent chat
---

# PermissionCard

Inline approval card for a tool the agent wants to run: the tool and its summary, the edit diff when there is one, the reason, and Allow / Always allow / Deny.

```tsx
<PermissionCard cwd="/repo" onAnswer={() => {}} ask={{ id: "r1", tool: "Bash", summary: "rm -rf build", input: { command: "rm -rf build" }, can_always: true }} />
```
