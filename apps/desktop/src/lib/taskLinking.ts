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
  sessionsOf?: (t: Task) => number,
): LinkChoices {
  const q = query.trim().toLowerCase();
  const matches = (t: Task) => !q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
  // `Title matches the session name · In Progress · no sessions`
  const why = (task: Task, first: string) => {
    if (!sessionsOf) return first;
    const n = sessionsOf(task);
    return [first, STATE[task.column], n ? `${n} session${n === 1 ? "" : "s"}` : "no sessions"].join(" · ");
  };
  const suggested = tasks.flatMap((task) => {
    if (!matches(task)) return [];
    if (words(task.title) === words(session.name)) return [{ task, reason: why(task, "Title matches the session name") }];
    if (!task.github && mentionsKey(session.branch, task.key)) return [{ task, reason: why(task, "Branch carries the key") }];
    return [];
  });
  // Recent shows at most 20.
  const recent = tasks
    .filter((t) => matches(t) && !suggested.some((s) => s.task === t))
    .sort((a, b) => b.updatedMs - a.updatedMs)
    .slice(0, 20);
  return { suggested, recent };
}

export interface LinkChoices {
  suggested: { task: Task; reason: string }[];
  recent: Task[];
}

const STATE: Record<Task["column"], string> = { todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done", open: "Open", hidden: "Not shown" };

/** What ↵ links in the dialog: the pasted task, else the first suggested, else the first of the rest. */
export function firstChoice(pasted: Task | null, choices: LinkChoices): Task | null {
  return pasted ?? choices.suggested[0]?.task ?? choices.recent[0] ?? null;
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

/**
 * The link dialog's lookups of what was typed or pasted (X46): one at a time,
 * after a short pause. A lookup that a newer one replaced, or that was
 * cancelled, ends as `undefined`, so ↵ never links from it.
 */
export function pasteLookup(delayMs = 200) {
  let current: Promise<Task | null | undefined> = Promise.resolve(null);
  // Ends the lookup under way as `undefined`; a result it finds later is ignored.
  let stop = () => {};
  let asked: string | null = null;
  let entering = false;
  return {
    start(run: () => Promise<Task | null>): Promise<Task | null | undefined> {
      stop();
      current = new Promise((resolve) => {
        const timer = setTimeout(async () => resolve(await run().catch(() => null)), delayMs);
        stop = () => {
          clearTimeout(timer);
          resolve(undefined);
        };
      });
      return current;
    },
    cancel() {
      stop();
      asked = null;
    },
    /**
     * Looks up `text` unless it is what the lookup under way is for, so the
     * dialog drawing again (after a background sync) keeps it; `force` starts
     * again anyway, as when the workspace's tasks first arrive.
     */
    query(text: string, run: () => Promise<Task | null>, force = false): Promise<Task | null | undefined> {
      if (!force && text === asked) return current;
      asked = text;
      return this.start(run);
    },
    /** ↵: links what {@link enterChoice} picks, once, however often it is pressed. */
    async enter(lists: () => LinkChoices, link: (t: Task) => void): Promise<void> {
      if (entering) return;
      entering = true;
      const first = await enterChoice(this, lists);
      if (first) link(first);
      else entering = false;
    },
    /**
     * What ↵ links: the task of the lookup under way, following any newer
     * lookup that replaces it; `undefined` once lookups were cancelled.
     */
    async settled(): Promise<Task | null | undefined> {
      for (;;) {
        const waiting = current;
        const found = await waiting;
        if (waiting === current) return found;
      }
    },
  };
}

/**
 * What ↵ links in the dialog once the lookup under way ends: the pasted task,
 * else the first of the lists as they are then (`lists`), not as they were
 * when ↵ was pressed. Nothing once the lookup was cancelled.
 */
export async function enterChoice(lookup: ReturnType<typeof pasteLookup>, lists: () => LinkChoices): Promise<Task | null> {
  const found = await lookup.settled();
  return found === undefined ? null : firstChoice(found, lists());
}
