// When the app re-reads sessions' PRs (X2). Pure, so it is unit-tested.

/** A merged PR cannot change, and `gh.pr_status` keeps returning it, so its
 *  session is not polled again. `undefined` means not polled yet. The
 *  minute poll (`openOnly`) covers just open PRs, which an agent or a
 *  terminal may merge while the window keeps focus. */
export function needsPrPoll(pr: { state: string } | null | undefined, { openOnly = false } = {}): boolean {
  return openOnly ? pr?.state === "open" : pr?.state !== "merged";
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
