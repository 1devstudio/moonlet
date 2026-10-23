<!-- Installed by moonlet (`moonlet hooks install`); reinstalling overwrites this file. -->

# Cards, snippets and `.prompt.md`

The formats of the moonlet-design skill's Cards and Layouts steps.

## The card

`components/<group>/<name>/<name>.html`, one card per folder. The group and name folders are lowercase, words joined by `-`.

```html
<!-- @dsCard group="Buttons" name="Button" source="src/components/ui.tsx" -->
<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../styles.css">
<style>body{margin:0;padding:24px}.ds-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;align-items:start}.ds-cell{border:1px solid rgb(127 127 127 / .3);border-radius:8px;padding:12px;overflow:hidden;transform:translateZ(0)}.ds-cell h4{margin:0 0 8px;font:600 12px system-ui;text-transform:uppercase;opacity:.7}</style></head>
<body><div class="ds-grid">
<section class="ds-cell" data-snippet="buttons/button/primary"><h4>primary</h4><div class="ds-mount"><button class="btn btn--primary">Create PR</button></div></section>
<section class="ds-cell" data-snippet="buttons/button/disabled"><h4>disabled</h4><div class="ds-mount"><button class="btn" disabled>Commit</button></div></section>
</div></body></html>
```

- **The marker** is the whole first line: `group` first, then `name`, `source` (the files it was made from, relative to the source folder, comma-separated) and, when the card needs another size than 900x700, `viewport="WxH"`.
- **Links**: only `styles.css` (`../../../styles.css` from a card, `../../styles.css` from `ui_kits/<kit>/`). No script, no `on*` attribute, no URL outside the design system.
- **Cells**: one `<section class="ds-cell">` per variant and state the source defines, labelled in its `<h4>`. Realistic content, as the app shows it.
- **Modes**: a wide component (a table, a full-width bar) puts one cell per row; an overlay (a dialog, a menu) gets one full-bleed cell with `viewport="900x700"`.
- **Leave out** states that need interaction (hover, drag); note each in `NOTES.md`.

## Snippets

The markup inside a cell's `.ds-mount` is a **snippet**: what a design inserts. Its id is `data-snippet="<group>/<name>/<variant>"`, unique in the system. A snippet carries only the component's own classes, so it works wherever it is pasted.

## Floor card

A component in scope that cannot be shown honestly yet gets a floor card: its marker, then one cell with `data-ds-fallback` saying `<name>: preview not yet written`. Never a guessed render.

## `<name>.prompt.md`

How the design agent uses the component. In this order:

1. The first line: one sentence of what it is for. The README's index shows it.
2. The project's own doc for it, when it has one (up to 8,000 characters).
3. `## Markup`: the element and its required structure.
4. `## Classes and modifiers`: each class and when to use it.
5. `## States`: each state and how it is written (`disabled`, `.btn--loading`).
6. `## Examples`: the card's snippets.
7. `## Instead of`: the raw element it replaces (`<button>` becomes `<button class="btn">`).
8. `## Related`: components used with it.

## Layouts

`ui_kits/<kit>/<screen>.html`: the same head as a card, marker `group="Layouts"` with the screen's `viewport`, and a whole screen built from snippets plus layout glue that uses tokens.
