// Tabs and split panes of a workspace (T2). Pure functions; the layout is
// stored on the workspace in the daemon so it survives app restarts (S4).

export type PaneNode =
  | { type: "leaf"; session: number }
  /** A file open in the editor (X26); `line` is where it opened last,
   *  `endLine` the last line of the range selected there (X96). */
  | { type: "file"; path: string; line?: number; endLine?: number }
  /** A routed command's output (X62), by job id. */
  | { type: "job"; job: string }
  /** A changed file's diff (X77), against the base or the uncommitted changes; `path` is relative to the worktree. */
  | { type: "diff"; path: string; mode: DiffMode }
  | { type: "split"; dir: "row" | "col"; children: PaneNode[]; sizes: number[] };

/** What a diff tab compares: the work since branching from the base, or the uncommitted changes only. */
export type DiffMode = "base" | "head";

export interface Tab {
  id: string;
  root: PaneNode;
}

export interface Layout {
  tabs: Tab[];
  active: string | null;
  focused: number | null;
}

export const emptyLayout = (): Layout => ({ tabs: [], active: null, focused: null });

let counter = 0;
export const newTabId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

/** A pane that is not a terminal and holds none: a file, a job or a diff. */
const isViewer = (node: PaneNode) => node.type === "file" || node.type === "job" || node.type === "diff";

/** The terminals shown in a pane tree; file, job and diff panes hold none. */
export function leaves(node: PaneNode): number[] {
  if (isViewer(node)) return [];
  return node.type === "leaf" ? [node.session] : node.children.flatMap(leaves);
}

export function allSessions(layout: Layout): number[] {
  return layout.tabs.flatMap((t) => leaves(t.root));
}

export function tabOf(layout: Layout, session: number): Tab | undefined {
  return layout.tabs.find((t) => leaves(t.root).includes(session));
}

/** Splits the pane showing `target`, putting `session` after it. */
export function splitLeaf(node: PaneNode, target: number, session: number, dir: "row" | "col"): PaneNode {
  if (isViewer(node)) return node;
  if (node.type === "leaf") {
    if (node.session !== target) return node;
    return { type: "split", dir, children: [node, { type: "leaf", session }], sizes: [50, 50] };
  }
  const idx = node.children.findIndex((c) => c.type === "leaf" && c.session === target);
  if (idx >= 0 && node.dir === dir) {
    const children = [...node.children];
    children.splice(idx + 1, 0, { type: "leaf", session });
    const even = 100 / children.length;
    return { ...node, children, sizes: children.map(() => even) };
  }
  return { ...node, children: node.children.map((c) => splitLeaf(c, target, session, dir)) };
}

/** Removes a pane; collapses splits left with one child. */
export function removeLeaf(node: PaneNode, session: number): PaneNode | null {
  if (isViewer(node)) return node;
  if (node.type === "leaf") return node.session === session ? null : node;
  const kept: { child: PaneNode; size: number }[] = [];
  node.children.forEach((c, i) => {
    const r = removeLeaf(c, session);
    if (r) kept.push({ child: r, size: node.sizes[i] ?? 0 });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].child;
  const total = kept.reduce((s, k) => s + k.size, 0) || 1;
  return { ...node, children: kept.map((k) => k.child), sizes: kept.map((k) => (k.size / total) * 100) };
}

export function setSizes(node: PaneNode, path: number[], sizes: number[]): PaneNode {
  if (node.type !== "split") return node;
  if (path.length === 0) return { ...node, sizes };
  const [head, ...rest] = path;
  return { ...node, children: node.children.map((c, i) => (i === head ? setSizes(c, rest, sizes) : c)) };
}

export function addTab(layout: Layout, session: number): Layout {
  const tab = { id: newTabId(), root: { type: "leaf" as const, session } };
  return { ...layout, tabs: [...layout.tabs, tab], active: tab.id, focused: session };
}

export function removeSession(layout: Layout, session: number): Layout {
  const tabs = layout.tabs
    .map((t) => ({ ...t, root: removeLeaf(t.root, session) }))
    .filter((t): t is Tab => t.root !== null);
  return withTabs(layout, tabs, session);
}

/** The layout with `tabs` left, keeping the active tab and focus where they still exist. */
function withTabs(layout: Layout, tabs: Tab[], removed: number | null): Layout {
  let active = layout.active;
  if (!tabs.some((t) => t.id === active)) {
    const oldIdx = layout.tabs.findIndex((t) => t.id === layout.active);
    active = tabs[Math.min(Math.max(oldIdx, 0), tabs.length - 1)]?.id ?? null;
  }
  const activeTab = tabs.find((t) => t.id === active);
  const focused =
    layout.focused !== removed && layout.focused !== null && activeTab && leaves(activeTab.root).includes(layout.focused)
      ? layout.focused
      : activeTab
        ? (leaves(activeTab.root)[0] ?? null)
        : null;
  return { tabs, active, focused };
}

const isFile = (t: Tab, path: string) => t.root.type === "file" && t.root.path === path;

/** Opens a file's tab (X26), or switches to it when it is open, at `line`
 *  if given, with lines `line` to `endLine` selected (X96). */
export function openFile(layout: Layout, path: string, line?: number, endLine?: number): Layout {
  const root: PaneNode = line ? { type: "file", path, line, ...(endLine ? { endLine } : {}) } : { type: "file", path };
  const open = layout.tabs.find((t) => isFile(t, path));
  if (!open) {
    const tab = { id: newTabId(), root };
    return { tabs: [...layout.tabs, tab], active: tab.id, focused: null };
  }
  const tabs = line ? layout.tabs.map((t) => (t === open ? { ...t, root } : t)) : layout.tabs;
  return { tabs, active: open.id, focused: null };
}

/** Closes a file's tab (X26). */
export function closeFile(layout: Layout, path: string): Layout {
  return withTabs(layout, layout.tabs.filter((t) => !isFile(t, path)), null);
}

/** Whether `path` is `folder` or inside it (X98). */
export const isUnder = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** Where `path` is after `from` moved to `to`: itself or inside it; null when neither (X98). */
export function movedPath(path: string, from: string, to: string): string | null {
  return isUnder(path, from) ? to + path.slice(from.length) : null;
}

/** File tabs follow a renamed or moved file or folder (X98). */
export function moveFiles(layout: Layout, from: string, to: string): Layout {
  const tabs = layout.tabs.map((t) => {
    const path = t.root.type === "file" ? movedPath(t.root.path, from, to) : null;
    return path !== null && t.root.type === "file" ? { ...t, root: { ...t.root, path } } : t;
  });
  return { ...layout, tabs };
}

/** Closes the tabs of a deleted file, or of the files in a deleted folder (X98). */
export function closeFilesUnder(layout: Layout, path: string): Layout {
  const gone = (t: Tab) => t.root.type === "file" && isUnder(t.root.path, path);
  return withTabs(layout, layout.tabs.filter((t) => !gone(t)), null);
}

const isDiff = (t: Tab, path: string, mode: DiffMode) => t.root.type === "diff" && t.root.path === path && t.root.mode === mode;

/** Opens a changed file's diff tab (X77), or switches to it when that file and mode are open. */
export function openDiff(layout: Layout, path: string, mode: DiffMode): Layout {
  const open = layout.tabs.find((t) => isDiff(t, path, mode));
  if (open) return { ...layout, active: open.id, focused: null };
  const tab = { id: newTabId(), root: { type: "diff", path, mode } as PaneNode };
  return { tabs: [...layout.tabs, tab], active: tab.id, focused: null };
}

/** Closes a diff tab (X77). */
export function closeDiff(layout: Layout, path: string, mode: DiffMode): Layout {
  return withTabs(layout, layout.tabs.filter((t) => !isDiff(t, path, mode)), null);
}

const isJob = (t: Tab, job: string) => t.root.type === "job" && t.root.job === job;

/** Opens a job's tab (X62), or switches to it when it is open. */
export function openJob(layout: Layout, job: string): Layout {
  const open = layout.tabs.find((t) => isJob(t, job));
  if (open) return { ...layout, active: open.id, focused: null };
  const tab = { id: newTabId(), root: { type: "job", job } as PaneNode };
  return { tabs: [...layout.tabs, tab], active: tab.id, focused: null };
}

/** Closes a job's tab (X62). */
export function closeJob(layout: Layout, job: string): Layout {
  return withTabs(layout, layout.tabs.filter((t) => !isJob(t, job)), null);
}

/**
 * Makes the layout match the workspace's live sessions: drops panes whose
 * session is gone and opens a tab for every session not shown anywhere.
 */
export function reconcile(layout: Layout, sessions: number[]): Layout {
  let out = layout;
  for (const s of allSessions(layout)) {
    if (!sessions.includes(s)) out = removeSession(out, s);
  }
  const shown = new Set(allSessions(out));
  // Background sessions open as tabs without stealing focus; on an empty
  // layout the first one becomes active.
  const keep = out.active;
  const keepFocus = out.focused;
  for (const s of sessions) {
    if (!shown.has(s)) out = addTab(out, s);
  }
  out = { ...out, active: keep ?? out.tabs[0]?.id ?? null, focused: keep ? keepFocus : null };
  if (!out.active && out.tabs.length) out = { ...out, active: out.tabs[0].id };
  const activeTab = out.tabs.find((t) => t.id === out.active);
  if (activeTab && (out.focused === null || !leaves(activeTab.root).includes(out.focused))) {
    out = { ...out, focused: leaves(activeTab.root)[0] ?? null };
  }
  return out;
}

function isNode(v: unknown): v is PaneNode {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  if (n.type === "leaf") return typeof n.session === "number";
  if (n.type === "file") return typeof n.path === "string" && (n.line === undefined || typeof n.line === "number") && (n.endLine === undefined || typeof n.endLine === "number");
  if (n.type === "job") return typeof n.job === "string";
  if (n.type === "diff") return typeof n.path === "string" && (n.mode === "base" || n.mode === "head");
  return (
    n.type === "split" &&
    (n.dir === "row" || n.dir === "col") &&
    Array.isArray(n.children) &&
    n.children.every(isNode) &&
    Array.isArray(n.sizes)
  );
}

/** Validates a layout coming back from the daemon (opaque JSON there). */
export function parseLayout(v: unknown): Layout {
  if (!v || typeof v !== "object") return emptyLayout();
  const l = v as Record<string, unknown>;
  const tabs = Array.isArray(l.tabs)
    ? l.tabs.filter((t): t is Tab => !!t && typeof t === "object" && typeof (t as Tab).id === "string" && isNode((t as Tab).root))
    : [];
  return {
    tabs,
    active: typeof l.active === "string" ? l.active : (tabs[0]?.id ?? null),
    focused: typeof l.focused === "number" ? l.focused : null,
  };
}

/** Next/previous pane in reading order within the active tab. */
export function cycleFocus(layout: Layout, delta: number): number | null {
  const tab = layout.tabs.find((t) => t.id === layout.active);
  if (!tab) return null;
  const ls = leaves(tab.root);
  const i = layout.focused === null ? -1 : ls.indexOf(layout.focused);
  return ls[(i + delta + ls.length) % ls.length] ?? null;
}
