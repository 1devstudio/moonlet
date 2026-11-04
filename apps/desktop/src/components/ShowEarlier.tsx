// "Show earlier" above the first row a long list renders (X81), in a chat,
// a job's view and the phone's job detail.

import { showEarlierLabel } from "../lib/showEarlier";
import { cx } from "../lib/cx";

/** Shown while `earlier` rows are not rendered; with a `unit`, it says how many. */
export function ShowEarlier({ earlier, unit, onClick, className }: { earlier: number; unit?: string; onClick: () => void; className?: string }) {
  if (!earlier) return null;
  return (
    <button type="button" className={cx("select-none rounded text-muted hover:bg-hover hover:text-fg", className)} onClick={onClick}>
      {showEarlierLabel(earlier, unit)}
    </button>
  );
}
