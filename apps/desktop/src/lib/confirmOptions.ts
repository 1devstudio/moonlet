// The confirm modal's options (X23) and the archive prompts (X55): pure,
// so the phone app shares them without the desktop's store.

import { archiveFlags, type ArchivePlan, type UnpushedView } from "./gitSettings";

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
  /** A second way to confirm, before the action, such as "Push, then
   * archive"; `disabled` says why it can't be used. */
  alt?: { label: string; disabled?: string };
  /** Work only on this machine that the action would remove (X55). */
  unpushed?: UnpushedView;
}

export interface ConfirmResult {
  checked: boolean;
  /** Confirmed with `alt`. */
  alt?: true;
}

/** The text and button style for the checkbox's current state. */
export function confirmView(o: ConfirmOptions, checked: boolean): { message: string; variant: ConfirmVariant } {
  return {
    message: typeof o.message === "function" ? o.message(checked) : o.message,
    variant: typeof o.variant === "function" ? o.variant(checked) : (o.variant ?? "primary"),
  };
}

/** What happens to the branch, after what happens to the folder. */
function branchLine(plan: ArchivePlan, deleted: boolean): string {
  if (!deleted) return plan.why === "not-merged" ? " The branch is kept: its PR hasn't merged." : " The branch is kept.";
  if (plan.remote) return " The branch is deleted, on origin too.";
  return plan.why === "merged" ? " Its PR merged, so the branch is deleted." : " The branch is deleted too.";
}

/** The archive prompt (X23), saying what the host's Git settings will do
 * (X55); only "Ask each time" shows "Also delete the branch". */
export function archivePrompt(name: string, plan: ArchivePlan = ASK): ConfirmOptions {
  const folder = plan.removeWorktree ? "Its terminals stop and the worktree folder is removed." : "Its terminals stop; the worktree folder stays on disk.";
  const deleted = (checked: boolean) => archiveFlags(plan, checked).delete_branch;
  return {
    title: "Archive session",
    message: (checked) => `Archive "${name}"? ${folder}${branchLine(plan, deleted(checked))}`,
    action: "Archive",
    variant: (checked) => (deleted(checked) ? "danger" : "primary"),
    ...(plan.branch === "ask" && { checkbox: { label: "Also delete the branch" } }),
  };
}

/** The archive prompt with work that would be lost (X55): "Archive anyway",
 * and "Push, then archive" when pushing saves it all. */
export function unpushedPrompt(name: string, plan: ArchivePlan, view: UnpushedView): ConfirmOptions {
  return {
    ...archivePrompt(name, plan),
    action: "Archive anyway",
    variant: "danger",
    alt: view.canPush ? { label: "Push, then archive" } : { label: "Push, then archive", disabled: "Commit the changes first" },
    unpushed: view,
  };
}

const ASK: ArchivePlan = { removeWorktree: true, branch: "ask", why: "policy", remote: false };
