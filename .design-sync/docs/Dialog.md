---
category: Forms & layout
---

# Dialog

Modal dialog with a title bar, scrollable body and optional footer; it closes on Escape and on a backdrop click.

Put actions in `footer`, primary last.

```tsx
<Dialog title="Commit changes" onClose={close} footer={<><Button variant="ghost">Cancel</Button><Button variant="primary">Commit</Button></>}>
  <Field label="Message"><input className={inputCls} /></Field>
</Dialog>
```
