// Whether the design canvas's page loaded (X65 entry 13), for the red "did
// not load" bar. Pure: the frame is components/design/DesignScreen.tsx's
// PageFrame.
//
// Two signals, the first one that comes:
// - The scheme's own page. A page the canvas asks for with the bridge that
//   cannot be served (its file missing or unreadable, refused by the
//   daemon) comes as a small page of moonlet's that tells the canvas it
//   failed (`bridge.failed`), at once and again on every hello. It runs as
//   its frame loads, before WebKit can suspend it, so it counts in a hidden
//   window too. A page's own scripts can post it as well: it is a signal
//   only, which shows the red bar and nothing more. It carries no text, and
//   why the page failed comes from the daemon, as its failed read of the
//   page says it.
// - The bridge's silence. A page that is served brings the bridge, which
//   reports by DOMContentLoaded, before the frame's load. A frame that has
//   loaded and whose bridge does not answer a hello within LOAD_WAIT_MS
//   did not load: its markup swallowed the bridge, or its scripts replaced
//   the page. Only while the window shows: WebKit suspends a frame's web
//   process about 2 s after it loads in a hidden window (the screen locked,
//   the window covered), and a suspended frame answers nothing, so a
//   hidden window waits until it shows again, then asks again.

import type { DesignParseError } from "./protocol";
import { pageFile } from "./designPage";

/** How long the canvas waits for the bridge's answer to a hello, in ms. */
export const LOAD_WAIT_MS = 3000;

/** The shown page's load: `loading` until its frame loads, `hidden` while
 *  a frame loaded without an answer waits for the window to show,
 *  `waiting` for an answer to the `asked`th hello, then `loaded` or
 *  `failed`, `refused` by the scheme or with its bridge silent. */
export type PageLoad = { phase: "loading" | "hidden" | "waiting" | "loaded"; asked: number } | { phase: "failed"; asked: number; refused: boolean };

export type LoadEvent =
  /** The frame's load, and whether the window shows then. */
  | { kind: "load"; visible: boolean }
  /** The bridge reported the page's ids. */
  | { kind: "answer" }
  /** The window shows again, or no longer does. */
  | { kind: "visible" }
  | { kind: "hidden" }
  /** The wait for the `asked`th hello's answer is over. */
  | { kind: "timeout"; asked: number }
  /** The scheme could not serve the page (or the page says so). */
  | { kind: "refused" }
  /** The page is framed again: written again, or another page. */
  | { kind: "reload" };

export const LOADING: PageLoad = { phase: "loading", asked: 0 };

const ask = (s: PageLoad): PageLoad => ({ phase: "waiting", asked: s.asked + 1 });

/** The load after `e`. A hello is asked each time it goes to `waiting`;
 *  the count tells a timer of an earlier ask, which does nothing. Only the
 *  first load of a frame counts: a link the page follows in View mode loads
 *  the frame again, with no bridge, and a page that loaded stays loaded. */
export function loadStep(s: PageLoad, e: LoadEvent): PageLoad {
  switch (e.kind) {
    case "reload":
      return { phase: "loading", asked: s.asked };
    case "answer":
      return { phase: "loaded", asked: s.asked };
    case "refused":
      return { phase: "failed", asked: s.asked, refused: true };
    case "load":
      if (s.phase !== "loading") return s;
      return e.visible ? ask(s) : { phase: "hidden", asked: s.asked };
    case "visible":
      return s.phase === "hidden" ? ask(s) : s;
    case "hidden":
      return s.phase === "waiting" ? { phase: "hidden", asked: s.asked } : s;
    case "timeout":
      return s.phase === "waiting" && e.asked === s.asked ? { phase: "failed", asked: s.asked, refused: false } : s;
  }
}

/** Why the shown page did not load: the scheme refused it, saying why, or
 *  its bridge was silent, with the page's first parse error if it has one. */
export type NotLoaded = { kind: "refused"; reason: string } | { kind: "silent"; parse?: DesignParseError };

/** What a refused page's bar says when the daemon read the page after all. */
const NOT_SERVED = "moonlet could not serve it";

/** What the bar says of the page: null unless it failed, so a page that
 *  loads never shows a parse error. A page the scheme refused says why the
 *  daemon could not read it (`readError`, `design.page`'s failure), never
 *  a text the page sent; one whose bridge was silent, its first parse
 *  error, `parse`, if it has one. */
export function notLoadedOf(load: PageLoad, readError: string | null, parse: DesignParseError | null): NotLoaded | null {
  if (load.phase !== "failed") return null;
  if (load.refused) return { kind: "refused", reason: readError ?? NOT_SERVED };
  return parse ? { kind: "silent", parse } : { kind: "silent" };
}

/** What is said of a page that loaded but whose source the daemon could
 *  not read (`readError`), which the editor needs: for a workspace design
 *  the scheme reads the file itself, so one can work and the other fail.
 *  Nothing until it loaded, as a page that did not load has the red bar. */
export function readFailureNote(load: PageLoad, page: string, readError: string | null): string | null {
  return load.phase === "loaded" && readError ? `${pageFile(page)} loaded, but it cannot be edited: ${readError}` : null;
}
