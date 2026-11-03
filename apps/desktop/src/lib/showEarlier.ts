// The end of a long list a view renders, with Show earlier for more (X81):
// a chat's blocks, a job's lines.

import { type RefObject, useLayoutEffect, useMemo, useRef, useState } from "react";

/** The rows a view renders: the last `limit`, and how many come before them. */
export function lastOf<T>(rows: readonly T[], limit: number): { rendered: readonly T[]; earlier: number } {
  const earlier = Math.max(0, rows.length - limit);
  return { rendered: earlier ? rows.slice(earlier) : rows, earlier };
}

/** What Show earlier says: with a `unit`, how many more it shows. */
export const showEarlierLabel = (earlier: number, unit?: string) =>
  unit ? `Show earlier (${earlier.toLocaleString("en-US")} more ${earlier === 1 ? unit : `${unit}s`})` : "Show earlier";

/**
 * The last `step` of `rows` to render in `scroller`, and `step` more for each
 * `showEarlier`, which keeps the view where the reader was: as far from the
 * bottom as before. From the end again when `reset` changes.
 */
export function useShowEarlier<T>(rows: readonly T[], step: number, reset: unknown, scroller: RefObject<HTMLElement | null>) {
  const [limit, setLimit] = useState(step);
  const [resetSeen, setResetSeen] = useState(reset);
  if (reset !== resetSeen) {
    setResetSeen(reset);
    setLimit(step);
  }
  // The distance from the bottom to keep while earlier rows are added.
  const keepFromBottom = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && keepFromBottom.current !== null) el.scrollTop = el.scrollHeight - keepFromBottom.current;
    keepFromBottom.current = null;
  }, [limit, scroller]);
  const { rendered, earlier } = useMemo(() => lastOf(rows, limit), [rows, limit]);
  const showEarlier = () => {
    const el = scroller.current;
    keepFromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
    setLimit((n) => n + step);
  };
  return { rendered, earlier, showEarlier, setLimit };
}
