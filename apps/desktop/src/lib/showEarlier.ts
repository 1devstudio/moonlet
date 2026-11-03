// The end of a long list a view renders, with Show earlier for more (X81):
// a chat's blocks, a job's lines.

import { type RefObject, useLayoutEffect, useMemo, useRef, useState } from "react";

/** The rows a view renders: the last `limit`, and how many come before them. */
export function lastOf<T>(rows: readonly T[], limit: number): { rendered: readonly T[]; earlier: number } {
  const earlier = Math.max(0, rows.length - limit);
  return { rendered: earlier ? rows.slice(earlier) : rows, earlier };
}

/**
 * How many of `rows` to render after they changed, from the `limit` before,
 * the key of the `last` row before and whether the reader was `atEnd`: at
 * the end, the same, so the view follows the end; scrolled up, more by the
 * rows that came after `last`, so the first row rendered stays put. As it
 * was when `last` is gone, as after a filter.
 */
export function limitAfter<T, K>(rows: readonly T[], key: (row: T) => K, before: { limit: number; last: K | undefined; atEnd: boolean }): number {
  if (before.atEnd || before.last === undefined) return before.limit;
  const at = rows.findLastIndex((r) => key(r) === before.last);
  return at < 0 ? before.limit : before.limit + rows.length - 1 - at;
}

/** Whether `el` is scrolled to its bottom, or near it, as a reader at the
 *  end is; true without one. */
export const nearBottom = (el: HTMLElement | null) => !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;

/** What Show earlier says: with a `unit`, how many more it shows. */
export const showEarlierLabel = (earlier: number, unit?: string) =>
  unit ? `Show earlier (${earlier.toLocaleString("en-US")} more ${earlier === 1 ? unit : `${unit}s`})` : "Show earlier";

/**
 * The last `step` of `rows` to render in `scroller`, and `step` more for each
 * `showEarlier`, which keeps the view where the reader was: as far from the
 * bottom as before. While the reader is not `atEnd`, rows that arrive add
 * to what renders (`limitAfter`), so nothing slides away above them. From
 * the end again when `reset` changes.
 */
export function useShowEarlier<T, K>(
  rows: readonly T[],
  { step, reset, scroller, key, atEnd }: { step: number; reset: unknown; scroller: RefObject<HTMLElement | null>; key: (row: T) => K; atEnd: () => boolean },
) {
  const [limit, setLimit] = useState(step);
  const [resetSeen, setResetSeen] = useState(reset);
  const last = rows.length ? key(rows[rows.length - 1]) : undefined;
  const [lastSeen, setLastSeen] = useState(last);
  // Adjusted while rendering, before the rows that came are drawn.
  if (reset !== resetSeen) {
    setResetSeen(reset);
    setLastSeen(last);
    setLimit(step);
  } else if (last !== lastSeen) {
    setLastSeen(last);
    setLimit(limitAfter(rows, key, { limit, last: lastSeen, atEnd: atEnd() }));
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
