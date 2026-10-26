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

/** A session design's side folder in its worktree, which git ignores: its
 *  comments, history, built screenshots and the agent's copy of its design
 *  system (`SIDE_DIR` in design/session.rs). */
export function sideFolder(slug: string): string {
  return `.moonlet/design/${slug}`;
}

/** The folder the `moonlet-design://` scheme and `design.file` name beside
 *  a design's own: a snapshot's, `<slug>@<n>`, or its built screenshots',
 *  `<slug>@built` (X65). */
export function taggedSlug(slug: string, tag: number | "built"): string {
  return `${slug}@${tag}`;
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
 *  or `s-<session>`, which `target` in design_scheme.rs parses. A workspace
 *  id is twelve hex digits (`new_id` in moonlet-core's session.rs), so it
 *  never starts with `s-`; one that did would be read as a session's, and
 *  is refused. */
export function placeHost(place: DesignPlace): string {
  if (isSession(place)) return `s-${encodeURIComponent(place.session)}`;
  if (place.startsWith("s-")) throw new Error("a workspace id never starts with s-, which names a session's design folder");
  return encodeURIComponent(place);
}
