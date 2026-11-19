// When the app re-reads sessions' PRs (X2). Pure, so it is unit-tested.

import type { KnownPr, PullRequest } from "./protocol";
import { latestOnly } from "./prStack";
import { sesKey } from "./sesKey";

/** How long a session with no PR, or a closed one, goes before the
 *  background polls ask about it again (X107). */
export const NO_PR_GAP_MS = 5 * 60_000;

/** A merged PR cannot change, and `gh.pr_status` keeps returning it, so its
 *  session is not polled again. `undefined` means not polled yet. The
 *  minute poll (`openOnly`) covers just open PRs, which an agent or a
 *  terminal may merge while the window keeps focus. A session with no PR,
 *  or a closed one, checked at `checkedAt` waits `NO_PR_GAP_MS` (X107). */
export function needsPrPoll(
  pr: { state: string } | null | undefined,
  { openOnly = false, checkedAt, now = Date.now() }: { openOnly?: boolean; checkedAt?: number; now?: number } = {},
): boolean {
  if (openOnly || pr?.state === "open") return pr?.state === "open";
  if (pr?.state === "merged") return false;
  return pr === undefined || checkedAt === undefined || now - checkedAt >= NO_PR_GAP_MS;
}

/** Coming back to the window re-reads PRs, since the user may have just
 *  merged one in the browser. At most once per `gapMs`, so switching apps
 *  back and forth does not run `gh` each time. */
export function focusThrottle(gapMs: number) {
  let last = -Infinity;
  return (now: number) => {
    if (now - last < gapMs) return false;
    last = now;
    return true;
  };
}

/** `latestOnly` per session: the sidebar, the PR button and the Checks
 *  tab all poll the same PR, so a slow answer to an older poll from any of
 *  them must not overwrite a newer one. */
export function latestPerKey() {
  const polls = new Map<string, ReturnType<typeof latestOnly>>();
  return {
    start(key: string) {
      let p = polls.get(key);
      if (!p) polls.set(key, (p = latestOnly()));
      return p.start();
    },
  };
}

/** The daemon's saved PRs of `host`'s sessions (`gh.pr_known`, X107), to
 *  show before any `gh` runs: by session key, with when each was checked.
 *  A session the app already holds a PR for (`held`) keeps it, as that
 *  one is newer. */
export function knownPrs(
  host: string,
  held: Record<string, PullRequest | null>,
  known: Record<string, KnownPr>,
): { prs: Record<string, PullRequest | null>; checkedAt: Record<string, number> } {
  const prs: Record<string, PullRequest | null> = {};
  const checkedAt: Record<string, number> = {};
  for (const [id, k] of Object.entries(known)) {
    const key = sesKey(host, id);
    if (key in held) continue;
    prs[key] = k.pr;
    checkedAt[key] = k.checked_at;
  }
  return { prs, checkedAt };
}
