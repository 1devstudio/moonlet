// Key routing between stacked modals (X23).

/** True when a key event comes from inside a dialog other than `own`, such as
 * a confirm modal opened on top of it: that dialog handles the key. */
export function fromOtherDialog(e: KeyboardEvent, own: Element | null): boolean {
  const dialog = e.target instanceof Element ? e.target.closest('[role="dialog"]') : null;
  return !!dialog && dialog !== own;
}
