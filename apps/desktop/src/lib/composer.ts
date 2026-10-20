// The new-session composer's decisions (X54): what its branch row says, and
// the attachments it sends before the user's text.

import { withoutComments } from "./markdown";
import type { IssueRef } from "./protocol";
import { linkChoices } from "./taskLinking";
import { githubRepo, prPointsAt, type Task } from "./tasks";

/** What the composer knows about where the session's branch comes from. */
export interface BranchFacts {
  /** The project's base branch. */
  base: string;
  task: { key: string } | null;
  /** The task's branch, once worked out (X44 template). */
  taskBranch: string | null;
  /** "Start from branch or commit…" (`existing: false`) or "Use an existing branch…". */
  from: { ref: string; existing: boolean } | null;
  /** An adopted worktree without a session (X46). */
  worktree: { branch: string } | null;
  pr: { number: number; head_branch?: string | null } | null;
  /** The "session starts" checkbox shows in the row. */
  checkbox: boolean;
}

/**
 * The branch row. `name` null is a branch named after the prompt ("New
 * branch"); `clear` is the tooltip of the × that goes back to the base.
 */
export type BranchRow =
  | { kind: "branch"; name: string | null; detail: string; clear: string | null }
  | { kind: "pr"; number: number; name: string; detail: string | null; title: string | null; undo: { label: string; title: string } };

export function branchRow(f: BranchFacts): BranchRow {
  if (f.worktree) return { kind: "branch", name: f.worktree.branch, detail: "existing worktree", clear: null };
  if (f.pr) {
    const name = f.pr.head_branch ?? "";
    const detail = "existing branch · checks out in a new worktree";
    const undo = f.task
      ? { label: "Use task branch", title: `Back to ${f.taskBranch ?? "the task's branch"} from ${f.base}` }
      : { label: "New branch instead", title: `Create a new branch from ${f.base} instead` };
    // The checkbox takes the hint's room, so the branch keeps its own.
    return f.checkbox ? { kind: "pr", number: f.pr.number, name, detail: null, title: `${name} · ${detail}`, undo } : { kind: "pr", number: f.pr.number, name, detail, title: null, undo };
  }
  if (f.from?.existing) return { kind: "branch", name: f.from.ref, detail: "existing branch", clear: `Create a new branch from ${f.base} instead` };
  const name = f.task ? (f.taskBranch ?? "…") : null;
  if (f.from) return { kind: "branch", name, detail: `from ${f.from.ref}`, clear: `Start from ${f.base} instead` };
  return { kind: "branch", name, detail: `from ${f.base}`, clear: null };
}

/** What the composer started from or picked: the task, a pull request. */
export interface Picks {
  task: { key: string; title: string; description: string } | null;
  pr: IssueRef | null;
}

/** What the composer has to send besides the user's text; `pr` only while its attachment is kept. */
export interface AttachFacts extends Picks {
  /** The PR's description, reviews and comments (`gh.pr_context`), once read. */
  prContext: string | null;
}

/**
 * A folded attachment above the prompt. Its line reads `lead` (what it is)
 * and `summary` (its first line or title); `body` shows unfolded; `remove` is
 * the ×'s title, null when it has none; `message` is what Create sends.
 */
export interface Attachment {
  id: "task" | "pr";
  icon: "file" | "pr";
  lead: string;
  summary: string;
  body: string;
  remove: string | null;
  message: string;
}

/** A description's first line of text, without its Markdown markers. */
function firstLine(markdown: string): string {
  const line = markdown.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^\s*(?:#+|>|[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "").trim();
}

export function attachments(f: AttachFacts): Attachment[] {
  const out: Attachment[] = [];
  // Unfolded, an attachment hides HTML comments as the Task tab does; the
  // agent gets the same text, so nothing it reads went unseen.
  const shown = (text: string) => withoutComments(text).trim();
  if (f.task) {
    const t = f.task;
    const description = shown(t.description);
    out.push({
      id: "task",
      icon: "file",
      lead: description ? `${t.key} description sent with your message · ` : `${t.key} sent with your message · `,
      summary: firstLine(description) || t.title,
      body: description,
      remove: null,
      // `<key> · <title>` and the description, as X46 sends it.
      message: `${t.key} · ${t.title}${description ? `\n${description}` : ""}`,
    });
  }
  if (f.pr) {
    const p = f.pr;
    const body = shown(f.prContext ?? p.body);
    out.push({
      id: "pr",
      icon: "pr",
      lead: `PR #${p.number} description and review comments · `,
      summary: p.title,
      body,
      remove: "Don’t send the PR description",
      message: paragraphs(`PR #${p.number} · ${p.title}`, body, p.url),
    });
  }
  return out;
}

/** Non-empty parts, trimmed, a blank line apart. */
const paragraphs = (...parts: string[]) =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");

/** What Create sends first: the attachments, then the user's text; null for neither. */
export function firstMessage(sent: Attachment[], typed: string): string | null {
  return paragraphs(...sent.map((a) => a.message), typed) || null;
}

/** The prompt's placeholder, by what is attached (not by what is picked: a removed PR attachment says nothing). */
export function placeholder(attached: Attachment["id"][]): string {
  const has = { task: attached.includes("task"), pr: attached.includes("pr") };
  if (has.task && has.pr) return "Anything to add? e.g. “Address the review comments”";
  if (has.task) return "Anything to add? Leave empty to start from the issue.";
  if (has.pr) return "What should the agent do on this PR? e.g. “Address the review comments”";
  return "What do you want to work on?";
}

/** The session's name: the task's title, else the PR's; null names it after the prompt (X5). */
export function sessionName(f: Picks): string | null {
  return f.task?.title ?? f.pr?.title ?? null;
}

/** A branch by its first two parts: `web-279-remove-…` is `web-279-…`. */
function shortBranch(branch: string): string {
  const parts = branch.split("-");
  return parts.length > 2 ? `${parts.slice(0, 2).join("-")}-…` : branch;
}

/**
 * The source picker's Branches tab, from `git.branches`: each branch once, in
 * its order, an origin branch by its name alone (the session checks it out
 * as a local branch) and without the bare `origin` its HEAD lists as.
 */
export function pickerBranches(branches: string[]): string[] {
  const names = branches.filter((b) => b !== "origin").map((b) => b.replace(/^origin\//, ""));
  return [...new Set(names)];
}

/** The source picker's footer: what picking from its tab does. */
export function pickerHint(tab: "branch" | "pr", task: { key: string; branch: string | null } | null, base: string): string {
  const starts = tab === "pr" ? "Picking a PR starts the session on its branch" : "Picking a branch starts the session on it";
  if (!task) return `${starts}, instead of a new branch from ${base}.`;
  return `${starts}, instead of creating ${task.branch ? shortBranch(task.branch) : "the task's branch"} from ${base}. The task link stays.`;
}

/**
 * The task a picked PR points at, for the Link a task slot's one-click Link:
 * `<from> <verb> <task's key>`, as in `PR #214 mentions WEB-279`. A PR points
 * at a task its title, body or head branch carries the key of, or at the
 * GitHub issue it closes.
 */
export function suggestedTask(picked: Pick<Picks, "pr">, tasks: Task[]): { task: Task; from: string; verb: "mentions" | "closes" } | null {
  const { pr } = picked;
  if (!pr) return null;
  const at = { number: pr.number, texts: [pr.title, pr.body, pr.head_branch ?? ""] };
  const t = tasks.find((x) => prPointsAt(x, at, githubRepo(pr.url)));
  return t ? { task: t, from: `PR #${pr.number}`, verb: t.github ? "closes" : "mentions" } : null;
}

/** Whether the header holds the Link a task slot: no task yet, a new worktree, and a workspace with a task source (X46's rule for "Link to task…"). */
export function showsLinkSlot(f: { task: boolean; worktree: boolean; sources: boolean }): boolean {
  return !f.task && !f.worktree && f.sources;
}

/**
 * The Link a task menu's sections: the link dialog's Suggested and Recent
 * lists (X46) for the session the picks and the prompt would make, named as
 * Create would name it and on the PR's head branch, filtered by `query`.
 */
export function linkMenu(picks: Pick<Picks, "pr">, prompt: string, tasks: Task[], query: string): { label: string; tasks: { task: Task; hint: string | null }[] }[] {
  const session = { name: sessionName({ task: null, ...picks }) ?? prompt.split("\n")[0], branch: picks.pr?.head_branch ?? "" };
  const { suggested, recent } = linkChoices(session, tasks, query);
  const sections = [
    { label: "Suggested", tasks: suggested.map((s) => ({ task: s.task, hint: s.reason })) },
    { label: "Recent", tasks: recent.map((task) => ({ task, hint: null })) },
  ].filter((s) => s.tasks.length);
  return sections.length ? sections : [{ label: "No tasks match", tasks: [] }];
}
