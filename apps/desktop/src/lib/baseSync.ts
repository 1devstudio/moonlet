// The project's base branch against origin, as the sidebar's pull chip and
// popover show it (X13). Pure, so it is unit-tested.

import type { BaseStatus } from "./protocol";

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

export interface BaseChip {
  kind: "behind" | "pulling" | "diverged";
  text: string;
  title: string;
}

/** The chip next to the project name, or `null` when there is nothing to pull. */
export function baseChip(st: BaseStatus | null | undefined, pulling: boolean): BaseChip | null {
  if (!st) return null;
  if (pulling) return { kind: "pulling", text: "pulling", title: `Pulling ${st.branch}` };
  if (st.behind === 0) return null;
  if (st.ahead > 0) return { kind: "diverged", text: "diverged", title: `${st.branch} can't be fast-forwarded` };
  return { kind: "behind", text: String(st.behind), title: `${st.branch} is ${commits(st.behind)} behind ${st.upstream}` };
}

/** What clicking the chip does. Hovering shows the details; a click pulls,
 *  unless the branch diverged and there is nothing to fast-forward. */
export function chipClick(chip: BaseChip | null): "pull" | "details" | null {
  if (chip?.kind === "behind") return "pull";
  if (chip?.kind === "diverged") return "details";
  return null;
}

/** "main is 3 commits behind origin" */
export function behindHeadline(st: BaseStatus): string {
  return `${st.branch} is ${commits(st.behind)} behind origin`;
}

/** The local-only commits of a diverged branch: "1 commit that isn't". */
export function aheadText(st: BaseStatus): string {
  return `${commits(st.ahead)} that ${st.ahead === 1 ? "isn't" : "aren't"}`;
}

export interface FetchInfo {
  /** Last successful fetch (ms). */
  fetchedAt: number | null;
  /** Why it fetched, such as "after PR #128 merged". */
  reason: string | null;
  /** The last fetch failed. */
  fetchError: string | null;
}

function ago(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  return `${Math.floor(ms / 3_600_000)} h ago`;
}

/** The popover footer: "fetched just now · after PR #128 merged". */
export function fetchedLabel(f: FetchInfo, now: number): string {
  if (f.fetchError) return f.fetchedAt === null ? "couldn't fetch" : `couldn't fetch · fetched ${ago(now - f.fetchedAt)}`;
  if (f.fetchedAt === null) return "not fetched yet";
  return `fetched ${ago(now - f.fetchedAt)}${f.reason ? ` · ${f.reason}` : ""}`;
}

export function pullToast(branch: string, r: { pulled: number; head: string }): string {
  if (r.pulled === 0) return `${branch} is already up to date.`;
  return `Pulled ${commits(r.pulled)} into ${branch}. New sessions start from ${r.head.slice(0, 7)}.`;
}

const shellQuote = (s: string) => (/^[\w./~@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/** The command the diverged popover offers to copy. moonlet only
 *  fast-forwards, so rebasing local commits is left to the user. */
export function rebaseCommand(st: BaseStatus, projectPath: string): string {
  if (st.checkout) return `git -C ${shellQuote(st.checkout)} pull --rebase`;
  const dir = shellQuote(projectPath);
  return `git -C ${dir} switch ${shellQuote(st.branch)} && git -C ${dir} pull --rebase`;
}

/** A session's PR went from not merged to merged between two polls, so its
 *  base branch on origin just moved. `prev` is `undefined` before the first
 *  poll; the host load fetches then anyway. */
export function justMerged(prev: { state: string } | null | undefined, next: { state: string } | null): boolean {
  return prev !== undefined && prev?.state !== "merged" && next?.state === "merged";
}
