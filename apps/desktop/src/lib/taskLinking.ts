// Linking a session to a task, and the Task tab's acceptance criteria (X46).

import { mentionsKey, type Task, type TrackerKind } from "./tasks";

export interface Criterion {
  text: string;
  done: boolean;
}

/**
 * Acceptance criteria in a task's description: its checklist items
 * (`- [ ]`, `- [x]`), else the bullets of a section titled "Acceptance criteria".
 */
export function acceptanceCriteria(markdown: string): Criterion[] {
  const lines = markdown.split("\n");
  const checks = lines.flatMap((l) => {
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.*\S)/.exec(l);
    return m ? [{ text: m[2], done: m[1] !== " " }] : [];
  });
  if (checks.length) return checks;
  const start = lines.findIndex((l) => /^\s*#{1,6}\s*acceptance criteria\s*$/i.test(l) || /^\s*acceptance criteria:?\s*$/i.test(l));
  if (start < 0) return [];
  const out: Criterion[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(l)) break;
    const m = /^\s*[-*]\s+(.*\S)/.exec(l);
    if (m) out.push({ text: m[1], done: false });
  }
  return out;
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The link dialog's lists: suggested tasks (title is the session's name, or
 * key in its branch) with the reason, then the rest by most recently updated.
 * `query` filters both by key or title.
 */
export function linkChoices(
  session: { name: string; branch: string },
  tasks: Task[],
  query: string,
): { suggested: { task: Task; reason: string }[]; recent: Task[] } {
  const q = query.trim().toLowerCase();
  const matches = (t: Task) => !q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
  const suggested = tasks.flatMap((task) => {
    if (!matches(task)) return [];
    if (words(task.title) === words(session.name)) return [{ task, reason: "Title matches the session name" }];
    if (!task.github && mentionsKey(session.branch, task.key)) return [{ task, reason: "Branch carries the key" }];
    return [];
  });
  const recent = tasks.filter((t) => matches(t) && !suggested.some((s) => s.task === t)).sort((a, b) => b.updatedMs - a.updatedMs);
  return { suggested, recent };
}

/** A pasted key or URL as `moonlet-trackers` reads it. */
export interface Pasted {
  kind: TrackerKind | null;
  key: string;
  site: string | null;
}

/** The loaded task a pasted key or URL names; `#42` is that number in the project's repository. */
export function findPasted(p: Pasted, tasks: Task[], originRepo: string | null): Task | null {
  const key = p.key.startsWith("#") ? (originRepo ? `${originRepo}${p.key}` : null) : p.key;
  if (!key) return null;
  return tasks.find((t) => t.key.toLowerCase() === key.toLowerCase() && (!p.kind || t.connection.startsWith(`${p.kind}:`))) ?? null;
}
