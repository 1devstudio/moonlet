// The PR's GitHub stack as the right panel's stack chip shows it (X11).
// Pure, so it is unit-tested.

import type { PrStack, StackPr } from "./protocol";

export interface StackView {
  /** 1-based position of the current PR; 1 is closest to the base. */
  position: number;
  size: number;
  /** Top of the stack first, as the dropdown lists them. */
  rows: StackPr[];
}

/** The chip's content, or `null` when `current` is not in `stack`. The
 *  stack may still be the one loaded for the session's previous PR, so the
 *  position comes from `current`, not from `stack.position`. */
export function stackView(stack: PrStack | null, current: number | null | undefined): StackView | null {
  const i = stack?.prs.findIndex((p) => p.number === current) ?? -1;
  if (!stack || i < 0) return null;
  return { position: i + 1, size: stack.prs.length, rows: [...stack.prs].reverse() };
}

/** Overlapping polls: `start()` returns a check that stays true only until
 *  the next `start()`, so a slow, older poll cannot overwrite newer state. */
export function latestOnly() {
  let seq = 0;
  return {
    start() {
      const n = ++seq;
      return () => n === seq;
    },
  };
}
