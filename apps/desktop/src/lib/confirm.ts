// In-app confirmation modal (X23): every "are you sure?" goes through
// askConfirm, which ConfirmHost renders in the app's own style.

import type { ConfirmOptions, ConfirmResult } from "./confirmOptions";
import { useStore } from "./store";

export * from "./confirmOptions";

export interface PendingConfirm {
  id: number;
  options: ConfirmOptions;
  resolve: (result: ConfirmResult | null) => void;
}

let nextId = 1;

/**
 * Shows the confirm modal. Resolves with the checkbox state when confirmed,
 * or null when cancelled. A newer request cancels one still open.
 */
export function askConfirm(options: ConfirmOptions): Promise<ConfirmResult | null> {
  return new Promise((resolve) => {
    useStore.getState().confirm?.resolve(null);
    useStore.setState({ confirm: { id: nextId++, options, resolve } });
  });
}

/** Answers the open confirm: `ok` confirms, otherwise it is cancelled. */
export function answerConfirm(ok: boolean, checked: boolean, alt = false) {
  const pending = useStore.getState().confirm;
  if (!pending) return;
  useStore.setState({ confirm: null });
  pending.resolve(ok ? (alt ? { checked, alt: true } : { checked }) : null);
}
