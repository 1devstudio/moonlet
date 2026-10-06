// Key routing between stacked modals (X23).

/** True when a key event comes from inside a dialog other than `own`, such as
 * a confirm modal opened on top of it: that dialog handles the key. */
export function fromOtherDialog(e: KeyboardEvent, own: Element | null): boolean {
  const dialog = e.target instanceof Element ? e.target.closest('[role="dialog"]') : null;
  return !!dialog && dialog !== own;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Where Tab (or Shift+Tab) from `active` must go to stay inside `panel`, a
 *  modal that keeps focus in: the other end when it would leave, or null to
 *  let the browser move focus as usual. */
export function tabWrap(panel: Element, active: Element | null, back: boolean): HTMLElement | null {
  const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (!items.length) return null;
  const first = items[0];
  const last = items[items.length - 1];
  if (!active || !items.includes(active as HTMLElement)) return back ? last : first;
  if (back && active === first) return last;
  if (!back && active === last) return first;
  return null;
}
