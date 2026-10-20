// Archiving a session from the phone (X40, X55): what the host's Git
// settings do with its folder and branch, and the work only on the host it
// would take. The text is the desktop's archive prompt.

import { archivePrompt, confirmView, unpushedPrompt } from "@desktop/lib/confirmOptions";
import { archiveFlags, archivePlan, DEFAULT_GIT_SETTINGS, type UnpushedView, unpushedView } from "@desktop/lib/gitSettings";
import type { GitSettings, Session, UnpushedWork } from "@desktop/lib/protocol";

export interface ArchiveSheet {
  message: (checked: boolean) => string;
  /** "Also delete the branch" under Ask each time, else null. */
  checkbox: string | null;
  action: string;
  /** The action deletes the branch, or loses work. */
  danger: (checked: boolean) => boolean;
  /** "Push, then archive", with why it can't be used, when work would be lost. */
  push: { label: string; disabled?: string } | null;
  unpushed: UnpushedView | null;
  /** `session.archive`'s flags. */
  flags: (checked: boolean) => { remove_worktree: boolean; delete_branch: boolean; delete_remote: boolean };
}

/** The sheet for archiving `session`. `git` null: the defaults (a daemon
 * too old for Git settings); `work` null: not known, so no warning. */
export function archiveSheet(o: {
  session: Session;
  base: string;
  git: GitSettings | null;
  prState: string | null | undefined;
  work: UnpushedWork | null;
  hostLabel: string;
}): ArchiveSheet {
  const git = { ...DEFAULT_GIT_SETTINGS, ...o.git };
  const plan = archivePlan(git, o.prState, o.session.branch, o.base);
  const view = git.warn_unpushed && o.work ? unpushedView(o.work, plan, o.session.branch, o.hostLabel) : null;
  const prompt = view ? unpushedPrompt(o.session.name, plan, view) : archivePrompt(o.session.name, plan);
  return {
    message: (checked) => confirmView(prompt, checked).message,
    checkbox: prompt.checkbox?.label ?? null,
    action: prompt.action,
    danger: (checked) => confirmView(prompt, checked).variant === "danger",
    push: prompt.alt ?? null,
    unpushed: view,
    flags: (checked) => archiveFlags(plan, checked),
  };
}
