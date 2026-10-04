---
category: Actions
---

# Menu

Click-to-open menu anchored to its trigger; it renders in a portal, so scroll containers never clip it.

`trigger` receives an `open` callback. Items: plain items (`label`, optional `icon`, `hint`, `checked`, `danger`, `onSelect`), `{kind: "submenu", items}`, `{kind: "divider"}` and `{kind: "label"}` section headers.

```tsx
<Menu
  items={[
    { kind: "label", label: "Group by" },
    { label: "Project", checked: true, onSelect: () => {} },
    { label: "Status", onSelect: () => {} },
    { kind: "divider" },
    { label: "Archive session", danger: true, onSelect: () => {} },
  ]}
  trigger={(open) => <IconButton title="Options" onClick={open}><MoreHorizontal size={16} /></IconButton>}
/>
```
