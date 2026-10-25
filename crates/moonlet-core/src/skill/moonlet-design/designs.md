<!-- Installed by moonlet (`moonlet hooks install`); reinstalling overwrites this file. -->

# Design rules

How a design's pages are written (X65). A design is a prototype in plain HTML pages built on one design system. Its folder holds `design.toml`, `pages/` and `assets/`; the design system's folder is yours to read, never to edit. The user comments on your pages and edits them by hand between your turns, by each element's `data-mid`.

- **Link only the design system's `styles.css`**, from a page in `pages/` as `<link rel="stylesheet" href="../../../systems/<system>/styles.css">`, `<system>` being `system` in `design.toml`. No other stylesheet, and no font or URL from outside the design and its design system. A page may have its own `<style>` and inline scripts, such as a menu that opens or tabs that switch.
- **Start from the design system**: its layouts in `ui_kits/`, the snippets in its cards (`components/<group>/<name>/<name>.html`, each `.ds-mount`), and its tokens. Copy a layout or a snippet and change its content; take every colour, space, type size, radius and shadow from a `var(--…)` token.
- **Read a component's `.prompt.md` before you use it**, and use its classes instead of raw elements: `<button class="btn">`, never a bare `<button>`. The design system's `conventions.md` names them.
- **Keep `data-mid` on every element** of the body, the `<body>` included: `m1`, `m2`, … unique in the page. Never change or reuse an element's id, even after the user moved or restyled it; a new element gets the next free number. `<script>`, `<style>`, `<template>`, `<noscript>` and the inside of an `<svg>` take none (the `<svg>` itself does).
- **Write one page per variant**: `pages/index.html` first, then a page for each variant asked for, such as `pages/git-a.html`, and label each in `design.toml`: `[pages.git-a]` with `label = "cards"`.
- **Run the check after each change**: `moonlet design check` lists every element without a `data-mid` or with a repeated one, and every stylesheet that is not the design system's; `moonlet design check --fix` gives the missing and repeated ids the next free numbers. Fix every problem before you end your turn.
