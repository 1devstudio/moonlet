// The bar over the design canvas (X65): one at a time, its colour saying who
// has to act. Pure: the screen is components/design/DesignScreen.tsx.

import { pageFile, pageOfPath, pagePath } from "./designPage";

/** One problem of `design.check` for a design. */
export interface PageProblem {
  path: string;
  line: number;
  kind: string;
  message: string;
}

export interface BarState {
  /** The design's agent is at work. */
  working: boolean;
  /** What its agent waits for from the user. */
  needsYou: { kind: "question" | "approval"; text: string } | null;
  /** The page shown (`index`), or null in Overview. */
  page: string | null;
  /** The design's check problems, every page's. */
  problems: PageProblem[];
  /** The design system's slug. */
  system: string;
  /** The workspace no longer has it. */
  systemRemoved: boolean;
  /** The edit by hand a save lost to a change on disk, as its line says it;
   *  null once dismissed. */
  unsaved: string | null;
  /** The snapshot the canvas previews, as History says its time and type
   *  ("10:33", "edits by hand"); null while it shows the current pages. */
  preview: { time: string; type: string } | null;
}

export type BarAction = "stop" | "details" | "fix" | "dismiss" | "back" | "restore";

export interface Bar {
  tone: "orange" | "red" | "yellow" | "grey" | "blue";
  text: string;
  /** Said after the text, in a quieter type. */
  detail: string | null;
  actions: BarAction[];
}

/** The problems the bar is about: the shown page's, or in Overview the first
 *  page's that has any. */
export function barProblems(page: string | null, problems: PageProblem[]): { page: string; problems: PageProblem[] } | null {
  const named = page ?? problems.map((p) => pageOfPath(p.path)).find((p) => p !== null) ?? null;
  if (named === null) return null;
  const own = problems.filter((p) => p.path === pagePath(named));
  return own.length ? { page: named, problems: own } : null;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 elements without data-mid, 1 repeated data-mid, 1 other stylesheet". */
function summary(problems: PageProblem[]): string {
  const of = (kind: string) => problems.filter((p) => p.kind === kind).length;
  const parts = [
    [of("missing_mid"), "element without data-mid", "elements without data-mid"],
    [of("duplicate_mid"), "repeated data-mid", "repeated data-mids"],
    [of("stylesheet"), "other stylesheet", "other stylesheets"],
  ] as const;
  const known = parts.filter(([n]) => n > 0).map(([n, one, many]) => count(n, one, many));
  const rest = problems.length - parts.reduce((sum, [n]) => sum + n, 0);
  return [...known, ...(rest > 0 ? [count(rest, "other problem", "other problems")] : [])].join(", ");
}

/** The bar to show, or null: a snapshot previewed, as the canvas then shows
 *  it and not the current pages the others are about; then the agent at
 *  work, then what it asks, then an edit by hand a save lost to a change on
 *  disk, then the page's check problems, then a removed design system. */
export function designBar(s: BarState): Bar | null {
  if (s.preview) {
    const text = `Previewing the snapshot from ${s.preview.time}, ${s.preview.type}. Nothing changes until you restore it.`;
    // A restore waits for the agent, as edits by hand do.
    return s.working ? { tone: "blue", text, detail: "Restore opens when Claude stops.", actions: ["back"] } : { tone: "blue", text, detail: null, actions: ["back", "restore"] };
  }
  if (s.working) return { tone: "orange", text: "Claude is changing the design. Edit mode opens when it stops; comments still work", detail: null, actions: ["stop"] };
  if (s.needsYou) return { tone: "orange", text: s.needsYou.kind === "question" ? "Claude asks…" : "Claude needs your approval", detail: s.needsYou.text, actions: [] };
  if (s.unsaved) return { tone: "yellow", text: "The page changed; your last edit was not saved.", detail: s.unsaved, actions: ["dismiss"] };
  const check = barProblems(s.page, s.problems);
  if (check) return { tone: "red", text: `${pageFile(check.page)} has check problems:`, detail: summary(check.problems), actions: ["details", "fix"] };
  if (s.systemRemoved) return { tone: "grey", text: "Design system removed.", detail: `Pages show without ${s.system}'s styles.`, actions: [] };
  return null;
}

/** What **Ask the agent to fix** sends the design's agent. */
export function pageFixMessage(page: string, problems: PageProblem[]): string {
  const lines = problems.map((p) => `- line ${p.line}: ${p.message}`).join("\n");
  return `Fix the check problems of ${pagePath(page)}, then run the check again:\n${lines}`;
}

/** Whether the chat panel opens on what the agent asks: when the design goes
 *  from not needing the user to needing them, never again while it still
 *  does, so a panel the user folded stays folded. */
export function chatOpensOn(before: BarState["needsYou"], now: BarState["needsYou"]): boolean {
  return before === null && now !== null;
}
