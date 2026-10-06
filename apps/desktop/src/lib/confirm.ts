// In-app confirmation modal (X23): every "are you sure?" goes through
// askConfirm, which ConfirmHost renders in the app's own style.

import { useStore } from "./store";

export type ConfirmVariant = "primary" | "danger";

export interface ConfirmOptions {
  title: string;
  /** Body text; a function when it changes with the checkbox. */
  message: string | ((checked: boolean) => string);
  /** Label of the confirming button, such as "Archive". */
  action: string;
  cancel?: string;
  variant?: ConfirmVariant | ((checked: boolean) => ConfirmVariant);
  /** An option shown at the footer's left, such as "Also delete the branch". */
  checkbox?: { label: string; checked?: boolean };
}

export interface ConfirmResult {
  checked: boolean;
}

export interface PendingConfirm {
  id: number;
  options: ConfirmOptions;
  resolve: (result: ConfirmResult | null) => void;
}

/** The text and button style for the checkbox's current state. */
export function confirmView(o: ConfirmOptions, checked: boolean): { message: string; variant: ConfirmVariant } {
  return {
    message: typeof o.message === "function" ? o.message(checked) : o.message,
    variant: typeof o.variant === "function" ? o.variant(checked) : (o.variant ?? "primary"),
  };
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
export function answerConfirm(ok: boolean, checked: boolean) {
  const pending = useStore.getState().confirm;
  if (!pending) return;
  useStore.setState({ confirm: null });
  pending.resolve(ok ? { checked } : null);
}

export function archivePrompt(name: string): ConfirmOptions {
  return {
    title: "Archive session",
    message: (deleteBranch) =>
      `Archive "${name}"? Its terminals stop and the worktree folder is removed.${deleteBranch ? " The branch is deleted too." : " The branch is kept."}`,
    action: "Archive",
    variant: (deleteBranch) => (deleteBranch ? "danger" : "primary"),
    checkbox: { label: "Also delete the branch" },
  };
}
