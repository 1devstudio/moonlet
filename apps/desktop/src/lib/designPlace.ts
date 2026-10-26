// Where a design is (X65): a workspace design in its workspace's design
// folder, a session design in its session's worktree. Every design call,
// state key and frame address names a design by its place and its slug.

import type { Design, DesignChanged, DesignRef } from "./protocol";

/** A design's place: its workspace's id for a workspace design, or
 *  `{session}` for a session design (X65). */
export type DesignPlace = string | { session: string };

/** Whether a design's place is a session's (a session design). */
export function isSession(place: DesignPlace): place is { session: string } {
  return typeof place !== "string";
}

/** The design `slug` at `place` as every design call names it (12a's
 *  `DesignRef`): `{workspace, slug}` or `{session, slug}`. */
export function designRef(place: DesignPlace, slug: string): DesignRef {
  return isSession(place) ? { session: place.session, slug } : { workspace: place, slug };
}

/** A design's folder as the `moonlet-design://` scheme names it, under
 *  its place: `designs/<slug>` in a workspace's design folder, `<slug>` in
 *  a worktree's design folder (`design.file {session, path}`). */
export function designFolder(place: DesignPlace, slug: string): string {
  return isSession(place) ? slug : `designs/${slug}`;
}

/** The place a `design.change` names: its session's, else its workspace's. */
export function changePlace(change: DesignChanged): DesignPlace {
  return change.session ? { session: change.session } : change.workspace;
}

/** A listed design's place: its session's for a session design, else
 *  `workspace`, the workspace it was listed in. */
export function placeOfDesign(d: Design, workspace: string): DesignPlace {
  return d.kind === "session" && d.session ? { session: d.session } : workspace;
}

/** The place's label in a `moonlet-design://` host: the workspace's id,
 *  or `s-<session>`, which `target` in design_scheme.rs parses. */
export function placeHost(place: DesignPlace): string {
  return isSession(place) ? `s-${encodeURIComponent(place.session)}` : encodeURIComponent(place);
}
