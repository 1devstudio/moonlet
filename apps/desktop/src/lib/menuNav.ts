// Moving through a menu with ↑ and ↓ (X50 board switcher): only items can
// be active, labels, dividers and submenus are stepped over.

type Kind = "item" | "label" | "divider" | "submenu" | undefined;

const selectable = (k: Kind) => k === undefined || k === "item";

/** The item ↑ (`by` -1) or ↓ (1) makes active after `current`, wrapping at either end; null when the menu has none. */
export function moveActive(kinds: readonly Kind[], current: number | null, by: 1 | -1): number | null {
  const n = kinds.length;
  let i = current ?? (by === 1 ? -1 : n);
  for (let step = 0; step < n; step++) {
    i = (i + by + n) % n;
    if (selectable(kinds[i])) return i;
  }
  return null;
}

/** The item active when a searchable menu opens or its query changes: the checked one, else the first. */
export function firstActive(kinds: readonly Kind[], checked: readonly boolean[]): number | null {
  const at = kinds.findIndex((k, i) => selectable(k) && checked[i]);
  return at >= 0 ? at : moveActive(kinds, null, 1);
}
