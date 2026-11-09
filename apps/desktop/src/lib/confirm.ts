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
 *
 * `ready` replaces the options in the same modal once it resolves, such as
 * the archive prompt once the host said what would be lost (X55); a modal
 * closed by then stays closed. One that fails just stops `checking`.
 */
export function askConfirm(options: ConfirmOptions, ready?: Promise<ConfirmOptions>): Promise<ConfirmResult | null> {
  const id = nextId++;
  const answer = new Promise<ConfirmResult | null>((resolve) => {
    useStore.getState().confirm?.resolve(null);
    useStore.setState({ confirm: { id, options, resolve } });
  });
  const replace = (next: ConfirmOptions) => {
    const open = useStore.getState().confirm;
    if (open?.id === id) useStore.setState({ confirm: { ...open, options: next } });
  };
  ready?.then(replace, () => replace({ ...options, checking: undefined }));
  return answer;
}

/**
 * As askConfirm, but tells a modal that another question replaced apart
 * from one the user cancelled: "covered" instead of null.
 */
export async function askConfirmOrCovered(options: ConfirmOptions): Promise<ConfirmResult | null | "covered"> {
  const asked = askConfirm(options);
  const id = useStore.getState().confirm?.id;
  const result = await asked;
  if (result) return result;
  const now = useStore.getState().confirm;
  return now && now.id !== id ? "covered" : null;
}

/** Resolves once no confirm modal is open. */
export function whenNoConfirm(): Promise<void> {
  if (!useStore.getState().confirm) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = useStore.subscribe((st) => {
      if (st.confirm) return;
      stop();
      resolve();
    });
  });
}

/** Answers the open confirm: `ok` confirms, otherwise it is cancelled.
 * While it is `checking`, it can only be cancelled. */
export function answerConfirm(ok: boolean, checked: boolean, alt = false) {
  const pending = useStore.getState().confirm;
  if (!pending || (ok && pending.options.checking)) return;
  useStore.setState({ confirm: null });
  pending.resolve(ok ? (alt ? { checked, alt: true } : { checked }) : null);
}
