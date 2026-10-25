// What the design canvas does on a change (X65): which page the agent is
// writing, and when the shown page loads again. Pure: the store is
// designStore.ts.

import type { DesignChanged } from "./protocol";
import { pageOfPath, pagePath } from "./designPage";

/** The pages (`index` for `pages/index.html`) a change to design `slug` wrote. */
export function changedPages(change: DesignChanged, slug: string): string[] {
  if (change.design !== slug) return [];
  return change.paths.flatMap((p) => {
    const page = pageOfPath(p);
    return page === null ? [] : [page];
  });
}

/** The page tab with the writing dot: one the latest change to the design
 *  wrote, while its agent works. */
export function writingPage(latest: string[], working: boolean): string | null {
  return working ? (latest[0] ?? null) : null;
}

/** Whether a change loads the shown page again: the shown page, or a file
 *  it links. Those are the design's `assets/`, and of its design system any
 *  `.css` file (`styles.css` and what it imports) and what is in `tokens/`
 *  and `fonts/`; not its cards, `README.md`, `.prompt.md` files or the
 *  sync's own files (`_ds_sync.json`, `_ds_manifest.json`). */
export function reloadsPage(change: DesignChanged, shown: { design: string; system: string; page: string }): boolean {
  if (change.design === shown.design) return change.paths.some((p) => p === pagePath(shown.page) || p.startsWith("assets/"));
  if (change.system === shown.system) return change.paths.some(linkedBySystem);
  return false;
}

/** A design system's file a page may link: a stylesheet, a token or a font. */
function linkedBySystem(path: string): boolean {
  return path.endsWith(".css") || path.startsWith("tokens/") || path.startsWith("fonts/");
}
