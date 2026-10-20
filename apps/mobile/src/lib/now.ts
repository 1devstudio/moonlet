// The time, re-read on an interval, for ages and clocks on screen (X40).

import { useEffect, useState } from "react";

/** Re-renders every 30 s, for the ages; every second for a running clock. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
