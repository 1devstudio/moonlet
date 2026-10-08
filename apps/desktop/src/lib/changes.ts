import type { FileChange } from "./protocol";

/** A changed file's `+a −d` counts, or `bin`. */
export function changeCount(f: FileChange): string {
  if (f.binary) return "bin";
  if (f.additions && f.deletions) return `+${f.additions} −${f.deletions}`;
  return f.deletions ? `−${f.deletions}` : `+${f.additions}`;
}

/** A folder or a changed file in the Changes tab's tree (X28). */
export type ChangeNode =
  | { kind: "dir"; name: string; path: string; children: ChangeNode[] }
  | { kind: "file"; name: string; file: FileChange };

/**
 * Changed files as a folder tree, folders before files, each by name. A folder
 * whose only child is a folder shares its row: `core/services/console`.
 */
export function changeTree(files: FileChange[]): ChangeNode[] {
  type Dir = { dirs: Map<string, Dir>; files: FileChange[] };
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let d = root;
    for (const p of parts.slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { dirs: new Map(), files: [] });
      d = d.dirs.get(p)!;
    }
    d.files.push(f);
  }
  const build = (d: Dir, prefix: string): ChangeNode[] => [
    ...[...d.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sub]): ChangeNode => {
        while (sub.dirs.size === 1 && sub.files.length === 0) {
          const [next, inner] = [...sub.dirs.entries()][0];
          name = `${name}/${next}`;
          sub = inner;
        }
        const path = prefix + name;
        return { kind: "dir", name, path, children: build(sub, `${path}/`) };
      }),
    ...d.files
      .map((file): ChangeNode => ({ kind: "file", name: file.path.slice(file.path.lastIndexOf("/") + 1), file }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];
  return build(root, "");
}

/** Changed files in path order, each split into its folder (`a/b/`, or empty) and name (X28). */
export function changeList(files: FileChange[]): (FileChange & { dir: string; name: string })[] {
  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => {
      const i = f.path.lastIndexOf("/") + 1;
      return { ...f, dir: f.path.slice(0, i), name: f.path.slice(i) };
    });
}
