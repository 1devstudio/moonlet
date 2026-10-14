// A screen's action in progress (X40): busy while it runs, and what went
// wrong if it failed, for every button that calls the daemon.

import { useState } from "react";

/** What a failure says: an Error's or an RPC error's message, else the value. */
export function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return String(e);
}

export function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Runs `f`, then `after` whether it worked or not; true when it worked. */
  const run = async (f: () => Promise<unknown>, after?: () => void): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await f();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
      after?.();
    }
  };
  return { busy, error, setError, run };
}
