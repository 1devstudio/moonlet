import type { FileChange } from "./protocol";

export interface ChangeGroup {
  /** The folder, `/` for the workspace root. */
  dir: string;
  files: (FileChange & { name: string })[];
}

/** Changed files grouped by folder, as the Changes tab lists them (X25). */
export function groupByDir(files: FileChange[]): ChangeGroup[] {
  const m = new Map<string, ChangeGroup["files"]>();
  for (const f of files) {
    const i = f.path.lastIndexOf("/");
    const dir = i < 0 ? "" : f.path.slice(0, i);
    m.set(dir, [...(m.get(dir) ?? []), { ...f, name: f.path.slice(i + 1) }]);
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dir, files]) => ({ dir: dir || "/", files }));
}

/** A changed file's `+a −d` counts, or `bin`. */
export function changeCount(f: FileChange): string {
  if (f.binary) return "bin";
  if (f.additions && f.deletions) return `+${f.additions} −${f.deletions}`;
  return f.deletions ? `−${f.deletions}` : `+${f.additions}`;
}
