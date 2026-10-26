// Where a design is (X65): a workspace design in its workspace's design
// folder, a session design in its session's worktree. Every design call,
// state key and frame address names a design by its place and its slug.

import type { DesignRef } from "./protocol";

/** A design's place: its workspace's id for a workspace design, or
 *  `{session}` for a session design (X65). */
export type DesignPlace = string | { session: string };

/** The design `slug` at `place` as every design call names it (12a's
 *  `DesignRef`): `{workspace, slug}` or `{session, slug}`. */
export function designRef(place: DesignPlace, slug: string): DesignRef {
  return typeof place === "string" ? { workspace: place, slug } : { session: place.session, slug };
}

/** A design's folder as the `moonlet-design://` scheme names it, under
 *  its place: `designs/<slug>` in a workspace's design folder, `<slug>` in
 *  a worktree's design folder (`design.file {session, path}`). */
export function designFolder(place: DesignPlace, slug: string): string {
  return typeof place === "string" ? `designs/${slug}` : slug;
}
