// Playing a design full screen (X99): the page over the whole window, at the
// window's size (Fill) or at the canvas's viewport fitted (Fit), ←/→ through
// the pages, and the page's file for Download.

import { designFolder, isSession, taggedSlug, type DesignPlace } from "./designPlace";
import { pagePath } from "./designPage";

export type Size = [number, number];
export type PlayFit = "fill" | "fit";

/** The page's frame in an `area`: Fill lays it out at the area's size, at
 *  100%; Fit at `viewport`, scaled to fit the area, never above 100%. */
export function playFrame(area: Size, viewport: Size, fit: PlayFit): { size: Size; scale: number } {
  if (fit === "fill") return { size: area, scale: 1 };
  return { size: viewport, scale: Math.min(1, area[0] / viewport[0], area[1] / viewport[1]) };
}

/** The page `dir` from `page` among `pages`, stopping at the first and the
 *  last; the first for a page no longer among them. */
export function playStep(pages: string[], page: string, dir: -1 | 1): string {
  const at = pages.indexOf(page);
  if (at < 0) return pages[0] ?? page;
  return pages[Math.min(pages.length - 1, Math.max(0, at + dir))];
}

/** "2 / 3": the page's place among the design's pages. */
export function playCounter(pages: string[], page: string): string {
  return `${pages.indexOf(page) + 1} / ${pages.length}`;
}

/** The page as `design.file` and `design.standalone` name it: in the
 *  design's folder, or in its snapshot `snapshot`'s. */
export function playFile(place: DesignPlace, slug: string, page: string, snapshot: number | null): { workspace: string; path: string } | { session: string; path: string } {
  const path = `${designFolder(place, snapshot === null ? slug : taggedSlug(slug, snapshot))}/${pagePath(page)}`;
  return isSession(place) ? { session: place.session, path } : { workspace: place, path };
}

/** What a key (as `keyId` names it) does in the play view: Esc goes back,
 *  ← and → go through the pages; nothing while typing. */
export function playKey(id: string, typing: boolean): "back" | "prev" | "next" | null {
  if (typing) return null;
  return id === "escape" ? "back" : id === "arrowleft" ? "prev" : id === "arrowright" ? "next" : null;
}

/** What `design_download` answers: where it saved, none when cancelled,
 *  and the addresses the page loads that it could not read. */
export interface Downloaded {
  path: string | null;
  missing: string[];
}

/** The toast after Download: where it saved, and what it left out; none
 *  when the user cancelled. */
export function downloadNote(d: Downloaded): { text: string; tone: "info" | "error" } | null {
  if (d.path === null) return null;
  const name = d.path.split("/").pop() ?? d.path;
  if (!d.missing.length) return { text: `Saved ${name}`, tone: "info" };
  const files = d.missing.length === 1 ? "1 file" : `${d.missing.length} files`;
  return { text: `Saved ${name}, without ${files} it could not read: ${d.missing.join(", ")}`, tone: "error" };
}
