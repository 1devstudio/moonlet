// The one confirm for archiving several sessions (X106): what happens to
// their folders and branches, and a note per session on what would be lost
// or stopped. Pure, as the single archive prompt in confirmOptions.ts is.

import type { BulkSession, ConfirmOptions } from "./confirmOptions";
import { archiveFlags, unpushedView, type ArchivePlan } from "./gitSettings";
import type { AgentState, SessionProcesses, UnpushedWork } from "./protocol";
import { stoppedByStopAll } from "./sessionProcesses";

/** One picked session as the host told about it: `work` and `running` are
 * null when the host could not say, or was not asked. */
export interface BulkArchiveItem {
  name: string;
  state: AgentState | null;
  plan: ArchivePlan;
  work: UnpushedWork | null;
  running: SessionProcesses | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Work only on this machine the archive would take, as X55 counts it. */
function onlyHere(i: BulkArchiveItem): { files: number; commits: number; canPush: boolean } | null {
  const view = i.work && unpushedView(i.work, i.plan, "", "");
  if (!view) return null;
  const files = view.files.length + view.more;
  const commits = i.plan.removeWorktree || i.plan.branch !== "keep" ? i.work!.commits : 0;
  return { files, commits, canPush: view.canPush };
}

function note(i: BulkArchiveItem): { note: string; warn: boolean } {
  const lost = onlyHere(i);
  if (lost) {
    const parts = [...(lost.files ? [plural(lost.files, "uncommitted file", "uncommitted files")] : []), ...(lost.commits ? [`${plural(lost.commits, "commit", "commits")} not pushed`] : [])];
    return { note: parts.join(", "), warn: true };
  }
  if (i.state === "working") return { note: "agent working, stops", warn: true };
  if (i.state === "blocked") return { note: "needs input, stops", warn: true };
  const running = i.running ? [...stoppedByStopAll(i.running), ...i.running.leftovers] : [];
  if (running.length) {
    const names = [...new Set(running.map((p) => p.name))];
    return { note: `${names.join(", ")} still ${running.length === 1 ? "runs" : "run"}, stops`, warn: false };
  }
  if (i.state === "done") return { note: "done", warn: false };
  if (i.state === "error") return { note: "failed", warn: false };
  return { note: "", warn: false };
}

function folderLine(items: BulkArchiveItem[]): string {
  const removed = items.filter((i) => i.plan.removeWorktree).length;
  if (removed === items.length) return "Their terminals stop and their worktree folders are removed.";
  if (removed === 0) return "Their terminals stop; their worktree folders stay on disk.";
  return "Their terminals stop; worktree folders are removed or kept by each host's Git settings.";
}

function branchLine(items: BulkArchiveItem[], checked: boolean): string {
  const deleted = items.filter((i) => archiveFlags(i.plan, checked).delete_branch).length;
  if (deleted === 0) return " Branches are kept.";
  if (deleted === items.length) return " Their branches are deleted too.";
  return ` ${deleted} of their branches ${deleted === 1 ? "is" : "are"} deleted, the others kept.`;
}

/** The confirm for archiving `items` at once (X106). */
export function bulkArchivePrompt(items: BulkArchiveItem[]): ConfirmOptions & { sessions: BulkSession[] } {
  const lost = items.map(onlyHere).filter((x) => x !== null);
  const deletes = (checked: boolean) => items.some((i) => archiveFlags(i.plan, checked).delete_branch);
  return {
    title: `Archive ${items.length} sessions`,
    message: (checked) => `${folderLine(items)}${branchLine(items, checked)}`,
    action: lost.length ? "Archive anyway" : `Archive ${items.length}`,
    variant: (checked) => (lost.length || deletes(checked) ? "danger" : "primary"),
    ...(items.some((i) => i.plan.branch === "ask") && { checkbox: { label: "Also delete the branches" } }),
    ...(lost.length > 0 && {
      alt: lost.every((l) => l.canPush) ? { label: `Push ${lost.length}, then archive all` } : { label: `Push ${lost.length}, then archive all`, disabled: "Commit the changes first" },
    }),
    sessions: items.map((i) => ({ name: i.name, state: i.state, ...note(i) })),
  };
}
