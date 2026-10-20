// The PR tab (X40, X2, X11): a PR's checks, review and stack.

import { DEFAULT_GIT_SETTINGS } from "@desktop/lib/gitSettings";
import type { CheckRun, GitSettings, PrStack } from "@desktop/lib/protocol";

export type CheckMark = "ok" | "error" | "running";

const PASSING = ["success", "neutral", "skipped"];

export function checkMark(c: CheckRun): CheckMark {
  if (c.status !== "completed" && !c.conclusion) return "running";
  return c.conclusion && PASSING.includes(c.conclusion) ? "ok" : "error";
}

export function checkNote(c: CheckRun): string {
  const m = checkMark(c);
  if (m === "running") return "running";
  if (c.conclusion === "success") return "passed";
  if (c.conclusion === "failure") return "failed";
  return (c.conclusion ?? "").toLowerCase().replace(/_/g, " ");
}

export function checksSummary(checks: CheckRun[]): string {
  if (!checks.length) return "no checks";
  const failing = checks.filter((c) => checkMark(c) === "error").length;
  if (failing) return `${failing} failing`;
  const running = checks.filter((c) => checkMark(c) === "running").length;
  return running ? `${running} running` : "all passing";
}

/** The PR tab's dot: the worst check's state (a failure, then one running). */
export function checksDot(checks: CheckRun[]): CheckMark | null {
  if (!checks.length) return null;
  const marks = checks.map(checkMark);
  return marks.includes("error") ? "error" : marks.includes("running") ? "running" : "ok";
}

export function reviewText(decision: string | null): string | null {
  if (!decision) return null;
  const t = decision.toLowerCase().replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** `#141 Search API endpoint · merged`: the PR this one is stacked on. */
export function stackedOn(stack: PrStack | null, current: number): string | null {
  const i = stack?.prs.findIndex((p) => p.number === current) ?? -1;
  if (!stack || i <= 0) return null;
  const below = stack.prs[i - 1];
  return `#${below.number} ${below.title} · ${below.state.toLowerCase()}`;
}

/** What "Ask Claude to fix <check>" sends to the session's agent. */
export function fixPrompt(c: CheckRun, pr: number): string {
  return `The ${c.name} check fails on PR #${pr}${c.url ? ` (${c.url})` : ""}. Find out why with gh and fix it.`;
}

export function updatedAgo(at: number, now: number): string {
  const s = Math.floor((now - at) / 1000);
  if (s < 5) return "updated just now";
  if (s < 60) return `updated ${s}s ago`;
  return `updated ${Math.floor(s / 60)} min ago`;
}

/** Whether the Create PR form starts as a draft: the host's setting (X55). */
export const startsDraft = (git: Pick<GitSettings, "draft_prs"> | null) => git?.draft_prs ?? DEFAULT_GIT_SETTINGS.draft_prs;
