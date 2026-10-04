---
category: Actions
---

# Button

Text button for dialog and toolbar actions.

Variants: `primary` (light fill, the one main action), `subtle` (default, bordered), `ghost` (text only, for secondary actions such as Cancel or Skip), `danger` (destructive). Sizes: `md` (28px) and `sm` (24px, inline in cards and status lines).

```tsx
<div className="flex gap-1.5">
  <Button variant="primary">Create PR</Button>
  <Button variant="ghost">Cancel</Button>
</div>
```
