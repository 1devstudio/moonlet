// Archiving a session from the phone (X40, X55): what the host's Git
// settings do with its folder and branch, and the work only on the host it
// would take. The text is the desktop's archive prompt.

import { archivePrompt, confirmView, unpushedPrompt } from "@desktop/lib/confirmOptions";
import { archiveFlags, archivePlan, DEFAULT_GIT_SETTINGS, type UnpushedView, unpushedView } from "@desktop/lib/gitSettings";
import type { GitSettings, Session, SessionArchived, UnpushedWork } from "@desktop/lib/protocol";

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
  /** Why work may be lost unseen: the host could not list it. */
  checkFailed: string | null;
  /** `session.archive`'s flags, after Push, then archive when `pushed`. */
  flags: (checked: boolean, pushed?: boolean) => { remove_worktree: boolean; delete_branch: boolean; delete_remote: boolean };
}

/** The sheet for archiving `session`. `git` null: the defaults (a daemon
 * too old for Git settings); `work` null: not asked, "failed": the host
 * could not say. */
export function archiveSheet(o: {
  session: Session;
  base: string;
  git: GitSettings | null;
  prState: string | null | undefined;
  work: UnpushedWork | null | "failed";
  hostLabel: string;
}): ArchiveSheet {
  const git = { ...DEFAULT_GIT_SETTINGS, ...o.git };
  const plan = archivePlan(git, o.prState, o.session.branch, o.base);
  const failed = git.warn_unpushed && o.work === "failed";
  const view = git.warn_unpushed && o.work && o.work !== "failed" ? unpushedView(o.work, plan, o.session.branch, o.hostLabel) : null;
  const prompt = view ? unpushedPrompt(o.session.name, plan, view) : archivePrompt(o.session.name, plan);
  return {
    message: (checked) => confirmView(prompt, checked).message,
    checkbox: prompt.checkbox?.label ?? null,
    action: failed ? "Archive anyway" : prompt.action,
    danger: (checked) => failed || confirmView(prompt, checked).variant === "danger",
    push: prompt.alt ?? null,
    unpushed: view,
    checkFailed: failed ? `Couldn't check for work only on ${o.hostLabel}. Archiving may remove uncommitted files or unpushed commits.` : null,
    flags: (checked, pushed) => archiveFlags(plan, checked, pushed),
  };
}

/** What `session.archive` leaves to say: origin's refusal to delete the
 * branch, if any; an older daemon answers `true`. */
export function archivedNote(done: SessionArchived | boolean, branch: string): string | null {
  return typeof done === "object" && done.remote_error ? `Archived. Couldn't delete ${branch} on origin: ${done.remote_error}` : null;
}
