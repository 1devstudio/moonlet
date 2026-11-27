// Archiving a session when its PR merged (X116): what the sidebar says
// about it. The session's host decides and records it in `auto_archive`.

import type { AutoArchive, Session } from "./protocol";

/** What the merged icon of a live session says, when its host did not
 * archive it (yet); `warn` tints the icon. `host` is the host's label. */
export function autoArchiveNote(a: AutoArchive | null | undefined, host: string): { text: string; warn: boolean } | null {
  if (!a) return null;
  const pr = a.merged ? "PR merged" : "PR closed";
  switch (a.state) {
    case "waiting":
      return { text: `${pr} · ${a.reason ?? ""}`, warn: false };
    case "refused":
      return { text: `${pr} · not archived: work only on ${host} (${a.reason ?? ""})`, warn: true };
    case "failed":
      return { text: `${pr} · could not archive: ${a.reason ?? ""}`, warn: true };
    default:
      return null;
  }
}

/** The Archived list's line under a session its host archived. */
export function archivedReason(a: AutoArchive | null | undefined): string | null {
  if (a?.state !== "archived") return null;
  return a.merged ? `Archived when #${a.pr} merged` : `Archived when #${a.pr} was closed`;
}

/** The sessions of `after` that `before` had live and the host has now
 * archived when their PR merged or closed. */
export function autoArchivedNow(before: readonly Session[], after: readonly Session[]): Session[] {
  const live = new Set(before.filter((s) => !s.archived).map((s) => s.id));
  return after.filter((s) => s.archived && live.has(s.id) && s.auto_archive?.state === "archived");
}
