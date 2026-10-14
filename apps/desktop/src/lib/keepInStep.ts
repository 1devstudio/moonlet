// Keep <tracker> in step (X46): what moonlet does in the tracker when the
// work moves, and the fixes behind the out-of-sync chips (X45).

import { type Column, DEFAULT_LINK, type LinkRules, type SessionLinkFacts, type Task, taskForSession } from "./tasks";
import type { Board, Card } from "./tasksBoard";

/** A rule's setting (X44 connection page; spec defaults until then). */
export type RuleSetting = "auto" | "suggest" | "off";

export type FixPlan =
  /** A GitHub repository issue: no column to move, so closing is "Done". */
  | { kind: "github"; repo: string; number: number; close: true }
  | { kind: "move"; column: Exclude<Column, "hidden"> }
  | { kind: "clean_up"; sessions: string[]; worktrees: string[] };

/** What the chip's button does. */
export function driftFix(card: Card): FixPlan | null {
  const d = card.drift;
  if (!d) return null;
  if (d.kind === "done_open") return { kind: "clean_up", sessions: card.rows.map((r) => r.session.id), worktrees: card.orphans.map((w) => w.path) };
  const column = d.kind === "merged" ? "done" : d.kind === "pr_open" ? "in_review" : "in_progress";
  const gh = card.task.github;
  if (gh) return column === "done" ? { kind: "github", repo: gh.repo, number: gh.number, close: true } : null;
  return { kind: "move", column };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Clean up's confirm: what goes, and which worktrees would lose uncommitted changes. */
export function cleanUpMessage(sessions: number, worktrees: number, dirty: string[]): string {
  const what = [sessions ? `Archive ${plural(sessions, "session")}` : "", worktrees ? `${sessions ? "remove" : "Remove"} ${plural(worktrees, "worktree")}` : ""]
    .filter(Boolean)
    .join(" and ");
  if (!dirty.length) return `${what}?`;
  const names = dirty.length === 1 ? dirty[0] : `${dirty.slice(0, -1).join(", ")} and ${dirty[dirty.length - 1]}`;
  return `${what}? ${names} ${dirty.length === 1 ? "has" : "have"} uncommitted changes, which will be lost.`;
}

/** The confirm before removing a worktree that no session uses (X45). */
export function removeWorktreeAsk(path: string, branch: string, dirty: boolean) {
  return {
    title: `Remove ${branch}?`,
    message: dirty ? `${path} has uncommitted changes, which will be lost. Its branch is kept.` : `The worktree at ${path} goes; its branch is kept.`,
    action: "Remove",
    variant: dirty ? ("danger" as const) : ("primary" as const),
  };
}

/** Names a chip's situation; "Not now" hides the chip until this changes. */
export function driftKey(card: Card): string {
  const work = card.rows.map((r) => `${r.session.id}:${r.session.pr?.number ?? ""}:${r.session.pr?.state ?? ""}`).join(",");
  return `${card.task.connection} ${card.task.key}|${card.drift?.kind}|${card.task.column}|${work}|${card.orphans.length}`;
}

/** The composer's checkbox for the "session starts" rule, or null when it does nothing here. */
export function startAction(task: Task, rule: RuleSetting): { label: string; checked: boolean } | null {
  if (rule === "off") return null;
  if (task.github) return { label: `Assign ${task.key} to me`, checked: rule === "auto" };
  // Only from Todo or a state not shown; an issue further along is left alone.
  if (task.column !== "todo" && task.column !== "hidden") return null;
  return { label: `Move ${task.key} to In Progress and assign it to me`, checked: rule === "auto" };
}

/** The board without the chips put off with "Not now". */
export function withoutPutOff(board: Board, notNow: Record<string, true>): Board {
  const strip = (cards: Card[]) => cards.map((c) => (c.drift && notNow[driftKey(c)] ? { ...c, drift: null } : c));
  return { todo: strip(board.todo), in_progress: strip(board.in_progress), in_review: strip(board.in_review), done: strip(board.done) };
}

/**
 * The GitHub issue in the project's repository that a session works on, for
 * the `Closes #N` line of its PR: from the board's tasks when loaded, else
 * from the session's stored link.
 */
export function closesIssue(
  s: SessionLinkFacts,
  originRepo: string | null,
  tasks: Task[],
  link: LinkRules = DEFAULT_LINK,
  commentRule: (task: Pick<Task, "connection" | "key">) => RuleSetting = () => "auto",
): number | null {
  if (!originRepo) return null;
  const t = taskForSession(s, null, originRepo, tasks, link);
  if (t?.github) {
    const same = t.github.repo.toLowerCase() === originRepo.toLowerCase();
    return same && commentRule(t) !== "off" ? t.github.number : null;
  }
  const m = s.task?.connection.startsWith("github:") ? /^(.+)#(\d+)$/.exec(s.task.key) : null;
  if (!m || m[1].toLowerCase() !== originRepo.toLowerCase() || commentRule(s.task!) === "off") return null;
  return Number(m[2]);
}

/** A PR body with `Closes #N`, so merging the PR closes the issue; added once. */
export function withCloses(body: string, issue: number | null): string {
  if (issue === null || new RegExp(`\\bCloses #${issue}\\b`, "i").test(body)) return body;
  return body.trim() ? `${body.trimEnd()}\n\nCloses #${issue}` : `Closes #${issue}`;
}

/** The five rules of a connection (`trackers.toml` `[github.rules]`, X44). */
export interface Rules {
  session_starts: RuleSetting;
  pr_opens: RuleSetting;
  all_merged: RuleSetting;
  pr_comment: RuleSetting;
  issue_done: RuleSetting;
}

/** The spec's defaults, as `moonlet-trackers` writes them for an empty file. */
export const DEFAULT_RULES: Rules = { session_starts: "auto", pr_opens: "auto", all_merged: "suggest", pr_comment: "auto", issue_done: "suggest" };

/** The rule each kind of chip follows. */
const RULE_OF: Record<NonNullable<Card["drift"]>["kind"], keyof Rules> = {
  merged: "all_merged",
  started: "session_starts",
  pr_open: "pr_opens",
  done_open: "issue_done",
};

/** The board with the chips of rules turned Off removed; `rulesOf` gives a card's tracker's rules. */
export function applyRules(board: Board, rulesOf: (c: Card) => Rules): Board {
  const off = (c: Card) => !!c.drift && rulesOf(c)[RULE_OF[c.drift.kind]] === "off";
  const strip = (cards: Card[]) => cards.map((c) => (off(c) ? { ...c, drift: null } : c));
  return { todo: strip(board.todo), in_progress: strip(board.in_progress), in_review: strip(board.in_review), done: strip(board.done) };
}

/**
 * The fixes moonlet makes by itself: a merged GitHub issue closes when
 * "every session's PR is merged" is Automatically, once per situation
 * (`done` holds the `driftKey`s already acted on).
 */
export function autoFixes(board: Board, rulesOf: (c: Card) => Rules, done: Record<string, true>): Card[] {
  return Object.values(board)
    .flat()
    .filter((c) => {
      if (!c.drift || done[driftKey(c)]) return false;
      if (c.drift.kind === "merged") return rulesOf(c).all_merged === "auto";
      if (c.drift.kind === "pr_open") return !c.task.github && rulesOf(c).pr_opens === "auto";
      return false;
    });
}

const COLUMN_TEXT: Record<Exclude<Column, "hidden">, string> = { todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done" };

/**
 * Linked tasks whose tracker state changed since the last sync without
 * moonlet moving them, for a notification (X44). `linked` and `byMoonlet`
 * hold `connection key`s; nothing on the first sync (`before` null).
 */
export function outsideMoves(before: Task[] | null, after: Task[], linked: Set<string>, byMoonlet: Map<string, Task["column"]>): { id: string; title: string; text: string }[] {
  if (!before) return [];
  const was = new Map(before.map((t) => [`${t.connection} ${t.key}`, t.column]));
  const closed = (c: Task["column"]) => c === "done" || c === "hidden";
  return after.flatMap((t) => {
    const id = `${t.connection} ${t.key}`;
    const from = was.get(id);
    // moonlet's own move is not news; a task that ended up elsewhere is.
    if (!from || from === t.column || !linked.has(id) || byMoonlet.get(id) === t.column) return [];
    const say = (text: string) => [{ id, title: t.title, text }];
    if (t.github) {
      if (closed(t.column) === closed(from)) return [];
      if (closed(t.column)) return byMoonlet.get(id) === "done" ? [] : say(`${t.key} was closed`);
      return say(`${t.key} was reopened`);
    }
    return t.column === "open" || t.column === "hidden" ? [] : say(`${t.key} moved to ${COLUMN_TEXT[t.column]}`);
  });
}

/**
 * Tracker issues to comment on because a session's PR just opened ("a pull
 * request opens → comment on the issue with its link" at Automatically), once
 * per PR. GitHub issues get `Closes #<n>` in the PR instead.
 */
export function prComments(board: Board, rulesOf: (c: Card) => Rules, done: Record<string, true>): { card: Card; key: string; text: string }[] {
  return Object.values(board)
    .flat()
    .flatMap((card) => {
      if (card.task.github || !card.task.tracker || rulesOf(card).pr_comment !== "auto") return [];
      return card.rows.flatMap(({ session }) => {
        const pr = session.pr;
        // Keyed by the PR's URL: two repositories can both have a #12.
        const key = `comment ${card.task.connection} ${card.task.key} ${pr?.url}`;
        if (pr?.state !== "open" || pr.draft || done[key]) return [];
        return [{ card, key, text: `Opened a pull request: ${pr.title} ${pr.url}` }];
      });
    });
}
