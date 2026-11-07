// An archived session, read only (X86): its page's summary, and the folded
// line that lists a task's archived sessions.

import { ago } from "./mobile";
import type { SessionHistory } from "./protocol";

/** The page's lines; a line it does not know is null. */
export interface ArchivedSummary {
  task: string | null;
  where: string;
  pr: string | null;
  when: string;
}

export function archivedSummary(
  s: { branch: string; created_at: number; archived_at?: number | null },
  o: { project: string | undefined; task: { key: string; title: string } | null; pr: { number: number; state: string } | null; now: number },
): ArchivedSummary {
  const created = `Created ${ago(o.now - s.created_at)}`;
  return {
    task: o.task ? `${o.task.key} ${o.task.title}` : null,
    where: o.project ? `${o.project}/${s.branch}` : s.branch,
    pr: o.pr ? `#${o.pr.number} ${o.pr.state}` : null,
    when: s.archived_at ? `${created} · archived ${ago(o.now - s.archived_at)}` : created,
  };
}

/** What the page says instead of transcripts, or null when it has some. */
export function historyNote(h: SessionHistory | Error): string | null {
  if (h instanceof Error) return "This host's moonlet cannot show this session's transcripts. Update it, or Restore the session.";
  return h.chats.length ? null : "No chat transcripts were kept for this session.";
}

/** The folded line under a task's live sessions, or null with none. */
export function archivedCount(n: number): string | null {
  return n ? `${n} archived` : null;
}
