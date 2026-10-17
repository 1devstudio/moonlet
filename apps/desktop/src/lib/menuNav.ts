// Moving through a menu with ↑ and ↓ and picking with ↵ (X50 board
// switcher): only items can be active; labels, dividers and submenus are
// stepped over.

/** What a menu row needs to be navigated: a `MenuItem`'s kind, label and check. */
export interface NavItem {
  kind?: "item" | "label" | "divider" | "submenu";
  label?: string;
  checked?: boolean;
}

const selectable = (it: NavItem | undefined) => !!it && (it.kind === undefined || it.kind === "item");

/** The item ↑ (`by` -1) or ↓ (1) makes active after `current`, wrapping at either end; null when the menu has none. */
export function moveActive(items: readonly NavItem[], current: number | null, by: 1 | -1): number | null {
  const n = items.length;
  let i = current ?? (by === 1 ? -1 : n);
  for (let step = 0; step < n; step++) {
    i = (i + by + n) % n;
    if (selectable(items[i])) return i;
  }
  return null;
}

/** The item active when a searchable menu opens (its checked one, else the first), or once its search changes (the first match). */
export function firstActive(items: readonly NavItem[], why: "open" | "search"): number | null {
  const checked = why === "open" ? items.findIndex((it) => selectable(it) && it.checked) : -1;
  return checked >= 0 ? checked : moveActive(items, null, 1);
}

/** Where the active item (`label`, last at `index`) is after the menu's items changed; a gone item starts over as the menu opens. */
export function sameItem(items: readonly NavItem[], index: number | null, label: string | null): number | null {
  if (index === null || label === null) return null;
  if (selectable(items[index]) && items[index].label === label) return index;
  const moved = items.findIndex((it) => selectable(it) && it.label === label);
  return moved >= 0 ? moved : firstActive(items, "open");
}

/** What a key does in an open menu: ↑ and ↓ move, ↵ picks the active item. Keys an input method is composing with are its own. */
export function menuKey(e: { key: string; isComposing: boolean }, items: readonly NavItem[], active: number | null): { move: number | null } | { pick: number } | null {
  if (e.isComposing) return null;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") return { move: moveActive(items, active, e.key === "ArrowDown" ? 1 : -1) };
  if (e.key === "Enter" && active !== null && selectable(items[active])) return { pick: active };
  return null;
}
