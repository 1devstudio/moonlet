// The PR's Design and build (X65): each page of a session design beside a
// screenshot of its built screen, which the agent saves after implementing
// to `<worktree>/.moonlet/design/<slug>/built/<page>.png`. Pure: the tab is
// components/design/SessionDesign.tsx.

import type { Design } from "./protocol";
import { worktreeFile } from "./sessionDesign";
import { viewportOf } from "./designViewport";
import { sideFolder, taggedSlug } from "./designPlace";

/** A page's built screenshot as `design.file {session, path}` names it, in
 *  the worktree's design folder's terms: `<slug>@built/<page>.png`. */
export function builtFile(slug: string, page: string): string {
  return `${taggedSlug(slug, BUILT)}/${builtName(page)}`;
}

/** Where the agent saves a page's built screenshot in the worktree:
 *  `.moonlet/design/<slug>/built/<page>.png`. */
export function builtPath(slug: string, page: string): string {
  return `${sideFolder(slug)}/${BUILT}/${builtName(page)}`;
}

/** The built screenshots' folder (`BUILT_DIR` in design/session.rs). */
const BUILT = "built";

/** Whether a session design's change names its built screenshots, a path
 *  under its side folder's `built/`: Design and build looks for them again. */
export function changesBuilt(paths: string[]): boolean {
  return paths.some((p) => p.startsWith(`${BUILT}/`));
}

const builtName = (page: string) => `${page}.png`;

/** One page of Design and build: the page's file in the worktree, and its
 *  screenshot's address (`built`, as design.file names it), which an image
 *  tries before it is known to be there, so the screenshot's bytes travel
 *  once; `there` once that image loaded or failed. Under it, where the
 *  screenshot is, or "Not built yet" once it failed (null until then). */
export interface BuildRow {
  page: string;
  label: string | null;
  design: string;
  built: string;
  there: boolean | undefined;
  builtLabel: string | null;
}

/** Design and build for design `d` of a session whose worktree is
 *  `worktree`; `found` says which pages' screenshots loaded (true) or
 *  failed to (false), by page, once their images tried them. */
export function designBuild(d: Design, worktree: string, found: Record<string, boolean>): { title: string; line: string; viewport: [number, number]; rows: BuildRow[] } {
  const viewport = viewportOf(d);
  return {
    title: "Design and build",
    line: `each page beside the built screen, at ${viewport[0]}×${viewport[1]}`,
    viewport,
    rows: d.pages.map((p) => {
      const there = found[p.name];
      return {
        page: p.name,
        label: p.label,
        design: worktreeFile(worktree, d, p.name),
        built: builtFile(d.slug, p.name),
        there,
        builtLabel: there === undefined ? null : there ? builtPath(d.slug, p.name) : "Not built yet",
      };
    }),
  };
}

/** What a row of Design and build mounts: its page's frame only while the
 *  row is `near` the screen (`useNear`), as each frame is a web process of
 *  its own (X64), as the Designs index's cards are; its built screenshot,
 *  an image, cheap, near or not, which tries the screenshot and is
 *  `shown` once it loaded. */
export function buildRowShows(row: BuildRow, near: boolean): { frame: boolean; image: boolean; shown: boolean } {
  return { frame: near, image: true, shown: row.there === true };
}
