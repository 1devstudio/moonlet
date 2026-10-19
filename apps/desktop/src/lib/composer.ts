// The new-session composer's decisions (X54): what its branch row says.

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
