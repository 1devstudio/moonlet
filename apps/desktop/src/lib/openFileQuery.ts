// Open file… (X96): what the user typed, `name:line` or `name:start-end`,
// and the session's files that match it. Pure: the dialog lives elsewhere.

import { fuzzyScore } from "./chat";

export interface FileQuery {
  /** A file name or a project-relative path, without `./`. */
  name: string;
  line?: number;
  /** The last line of a range; only set when it differs from `line`. */
  endLine?: number;
}

/** `tenant-acme.yaml:49-53` as its name and lines. A column is ignored, a
 *  backwards range turned around, and line 0 means no line. */
export function parseFileQuery(text: string): FileQuery {
  const t = text.trim();
  const m = /^(.*?):(?:(\d+)(?:-(\d+)|:\d+)?)?$/.exec(t);
  const name = (m ? m[1] : t).replace(/^\.\//, "");
  const a = Number(m?.[2] ?? 0);
  const b = Number(m?.[3] ?? a);
  if (!a) return { name };
  const [line, endLine] = a <= b ? [a, b] : [b, a];
  return line === endLine ? { name, line } : { name, line, endLine };
}

/** At most this many files are listed. */
const LIMIT = 50;

/** The files of `files` (project-relative paths) that `name` names, best
 *  first: the exact name or path end, shortest path first; then names that
 *  start with it; then the `@` list's fuzzy match. Case is ignored. */
export function findFiles(files: readonly string[], name: string): string[] {
  const q = name.toLowerCase();
  if (!q) return [];
  const exact: string[] = [];
  const prefix: string[] = [];
  const fuzzy: [string, number][] = [];
  for (const f of files) {
    const p = f.toLowerCase();
    if (p === q || p.endsWith("/" + q)) exact.push(f);
    else if (p.slice(p.lastIndexOf("/") + 1).startsWith(q)) prefix.push(f);
    else {
      const score = fuzzyScore(f, q);
      if (score !== null) fuzzy.push([f, score]);
    }
  }
  const byLength = (a: string, b: string) => a.length - b.length;
  return [...exact.sort(byLength), ...prefix.sort(byLength), ...fuzzy.sort((a, b) => a[1] - b[1]).map(([f]) => f)].slice(0, LIMIT);
}
