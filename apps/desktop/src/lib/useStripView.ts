import { useEffect, useState } from "react";
import type { ChatState } from "./protocol";
import { type StripView, stripClockRuns, stripView } from "./subagents";
import { useNow } from "./useNow";

/** The agents strip of a chat (X42), kept moving: its clock ticks while
 *  agents run and the strip is `shown`, and it steps at each dot pop, count
 *  flash and fold between ticks. Shared by the desktop and the phone (X40). */
export function useStripView(st: ChatState, shown: boolean, dismissedAt: number): StripView | null {
  const [steppedAt, setSteppedAt] = useState(0);
  const now = Math.max(useNow(stripClockRuns(st, shown)), steppedAt);
  const view = stripView(st, now, dismissedAt);
  const wake = view?.wake ?? null;
  useEffect(() => {
    if (wake === null) return;
    // At least `wake`: a timer can fire a little before the wall clock gets there.
    const t = setTimeout(() => setSteppedAt(Math.max(Date.now(), wake)), Math.max(0, wake - Date.now()));
    return () => clearTimeout(t);
  }, [wake]);
  return view;
}
