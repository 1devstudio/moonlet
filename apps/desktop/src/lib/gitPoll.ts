/** How often the background poll checks the git status of a session
 *  nobody works in (X102). */
export const IDLE_CHECK_MS = 5 * 60_000;
/** How long a session counts as worked in after its last terminal output
 *  or change in its status (X102). */
export const ACTIVE_FOR_MS = 5 * 60_000;

/** When a session's git status was last checked, and last seen to change. */
export interface GitCheck {
  checkedAt: number;
  changedAt?: number;
}

export interface GitCheckInput {
  now: number;
  /** Absent until the session's first check. */
  last?: GitCheck;
  /** The session the user has open. */
  open: boolean;
  /** One of its agents is working. */
  working: boolean;
  /** Its terminals' latest output, in ms since the epoch; 0 for none. */
  lastOutputAt: number;
}

/** Whether a background poll checks this session's git status now (X102):
 *  sessions someone works in on every poll, the rest every 5 minutes. */
export function gitCheckDue(s: GitCheckInput): boolean {
  if (!s.last || s.open || s.working) return true;
  const activeAt = Math.max(s.lastOutputAt, s.last.changedAt ?? 0);
  if (s.now - activeAt < ACTIVE_FOR_MS) return true;
  return s.now - s.last.checkedAt >= IDLE_CHECK_MS;
}
