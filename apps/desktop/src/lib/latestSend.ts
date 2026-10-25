// Saves of the latest state, one at a time per key (X65): a design's
// viewport picks and a page's edits by hand. A send reads the state as it
// is when it runs; a call made while one is on its way makes one more run
// after it, however many calls came meanwhile, so the last state is what is
// sent and an earlier save never lands after a later one. A send that fails
// still makes that run when a call came meanwhile: the later state is sent,
// and its outcome is the one told.

export function latestSends() {
  const going: Record<string, { busy: Promise<void>; again: boolean }> = {};
  return {
    /** Runs `send` for `key` now, or once more after the one on its way;
     *  resolves when the run that took this call's state is done, and
     *  rejects with the last run's error. A run that fails is followed by
     *  the one a call meanwhile asked for. `send` returning "stop" ends the
     *  runs. */
    send(key: string, send: () => Promise<void | "stop">): Promise<void> {
      const on = going[key];
      if (on) {
        on.again = true;
        return on.busy;
      }
      const run = { busy: Promise.resolve(), again: false };
      going[key] = run;
      run.busy = (async () => {
        do {
          run.again = false;
          try {
            if ((await send()) === "stop") return;
          } catch (e) {
            // A later state is sent next, and it decides.
            if (!run.again) throw e;
          }
        } while (run.again);
      })().finally(() => {
        delete going[key];
      });
      return run.busy;
    },
    /** Whether a send of `key` is on its way. */
    busy(key: string): boolean {
      return key in going;
    },
    /** Waits for every send on its way. */
    async settle(): Promise<void> {
      while (Object.keys(going).length) await Promise.all(Object.values(going).map((g) => g.busy.catch(() => {})));
    },
  };
}
