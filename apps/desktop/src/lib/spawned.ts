// Sessions one agent opened for another (X22): the toast when one appears and
// the "from" line in its sidebar tooltip.
import type { Project, Session } from "./protocol";

export interface SpawnedNotice {
  session: string;
  text: string;
}

/** Sessions an agent started since `prev`. Nothing on the first load (`prev` undefined). */
export function spawnedNotices(prev: Session[] | undefined, next: Session[], projects: Project[]): SpawnedNotice[] {
  if (!prev) return [];
  const known = new Set(prev.map((s) => s.id));
  return next
    .filter((s) => s.spawned_by && !s.archived && !known.has(s.id))
    .map((s) => {
      const parent = next.find((p) => p.id === s.spawned_by)?.name ?? "An agent";
      const project = projects.find((p) => p.id === s.project_id)?.name;
      return { session: s.id, text: `${parent} started ${s.name} in ${project ?? "another project"}` };
    });
}

/** "from <parent>" for a session an agent started, or null. */
export function spawnedFrom(s: Session, sessions: Session[]): string | null {
  if (!s.spawned_by) return null;
  const parent = sessions.find((p) => p.id === s.spawned_by);
  return parent ? `from ${parent.name}` : "from a removed session";
}
