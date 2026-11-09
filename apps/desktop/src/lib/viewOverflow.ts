// The right panel's views when they don't fit (X94): priority+, the last
// ones go into More, and the view shown always stays in the row.

const sum = (widths: number[], ids: number[]) => ids.reduce((n, i) => n + widths[i], 0);

/**
 * Which views stay in a row `available` px wide and which go into More,
 * `more` px wide when shown. The views keep their order; the `active` one
 * stays, and the views before it give way to it from the last.
 */
export function fitViews(widths: number[], active: number, available: number, more: number): { shown: number[]; more: number[] } {
  const all = widths.map((_, i) => i);
  if (sum(widths, all) <= available) return { shown: all, more: [] };
  const budget = available - more;
  const shown: number[] = [];
  for (const i of all) {
    if (sum(widths, shown) + widths[i] > budget) break;
    shown.push(i);
  }
  if (active >= 0 && active < widths.length && !shown.includes(active)) {
    while (shown.length && sum(widths, shown) + widths[active] > budget) shown.pop();
    shown.push(active);
    shown.sort((a, b) => a - b);
  }
  return { shown, more: all.filter((i) => !shown.includes(i)) };
}
