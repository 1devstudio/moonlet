// Where a menu and its submenus open, kept inside the window (X112).

/** Where a menu `height` tall opens for a pointer at `y` in a window
 * `viewport` tall: at the pointer, moved up to fit with an 8px margin, never
 * above the top margin. */
export const menuTop = (y: number, height: number, viewport: number): number => Math.max(8, Math.min(y, viewport - height - 8));

/** Where a submenu `width` wide opens beside its item (`itemLeft` to
 * `itemRight`) in a window `viewport` wide: 4px right of it, or left of it
 * when the window has no room on the right, never past the left margin. */
export function submenuLeft(itemLeft: number, itemRight: number, width: number, viewport: number): number {
  const right = itemRight + 4;
  if (right + width + 8 <= viewport) return right;
  return Math.max(8, itemLeft - 4 - width);
}
