// The new-session composer's decisions (X54): what its branch row says, and
// the attachments it sends before the user's text.

import { withoutComments } from "./markdown";
import type { IssueRef } from "./protocol";

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

/** What the composer started from or picked: the task, a GitHub issue, a pull request. */
export interface Picks {
  task: { key: string; title: string; description: string } | null;
  issue: IssueRef | null;
  pr: IssueRef | null;
}

/** What the composer has to send besides the user's text; `pr` only while its attachment is kept. */
export interface AttachFacts extends Picks {
  /** The PR's description, reviews and comments (`gh.pr_context`), once read. */
  prContext: string | null;
}

/**
 * A folded attachment above the prompt. Its line reads `ref` (the issue's
 * number), `lead` (what it is), `summary` (its first line or title) and
 * `note`; `body` shows unfolded; `remove` is the ×'s title, null when it has
 * none; `message` is what Create sends.
 */
export interface Attachment {
  id: "task" | "issue" | "pr";
  icon: "file" | "pr";
  ref: string | null;
  lead: string | null;
  summary: string;
  note: string | null;
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
      ref: null,
      lead: description ? `${t.key} description sent with your message · ` : `${t.key} sent with your message · `,
      summary: firstLine(description) || t.title,
      note: null,
      body: description,
      remove: null,
      // `<key> · <title>` and the description, as X46 sends it.
      message: `${t.key} · ${t.title}${description ? `\n${description}` : ""}`,
    });
  }
  if (f.issue) {
    const i = f.issue;
    out.push({
      id: "issue",
      icon: "file",
      ref: `#${i.number}`,
      lead: null,
      summary: i.title,
      note: f.task ? " · GitHub issue, sent too" : " · GitHub issue",
      body: shown(i.body),
      remove: `Remove #${i.number}`,
      message: paragraphs(`#${i.number} · ${i.title}`, shown(i.body), i.url),
    });
  }
  if (f.pr) {
    const p = f.pr;
    const body = shown(f.prContext ?? p.body);
    out.push({
      id: "pr",
      icon: "pr",
      ref: null,
      lead: `PR #${p.number} description and review comments · `,
      summary: p.title,
      note: null,
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

/** The prompt's placeholder, by what is attached. */
export function placeholder(has: { task: boolean; issue: boolean; pr: boolean }): string {
  if (has.task && has.pr) return "Anything to add? e.g. “Address the review comments”";
  if (has.task && has.issue) return "Anything to add?";
  if (has.task || has.issue) return "Anything to add? Leave empty to start from the issue.";
  if (has.pr) return "What should the agent do on this PR? e.g. “Address the review comments”";
  return "What do you want to work on?";
}

/** The session's name: the task's title, else the PR's, else the issue's; null names it after the prompt (X5). */
export function sessionName(f: Picks): string | null {
  return f.task?.title ?? f.pr?.title ?? f.issue?.title ?? null;
}
