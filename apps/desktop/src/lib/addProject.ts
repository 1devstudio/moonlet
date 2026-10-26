// Adding a project from GitHub (X59): what the Add project dialog decides
// before and while the host's daemon clones a repository.

import type { CloneDone, CloneJob, CloneProgress, CloneStep, CloneTarget, GhStatus, Project } from "./protocol";
import { MONTHS } from "./dates";
import { readStored, writeStored } from "./storage";

/** A GitHub repository typed into Repository, and the SSH address when one was typed. */
export interface RepoRef {
  repo: string;
  ssh?: string;
}

/** The owner and name of an `owner/repo`. */
export function repoParts(repo: string): { owner: string; name: string } {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name };
}

/** The folder Clone into names, as typed: `~/code/storefront`. */
export function clonePath(parent: string, name: string): string {
  return `${parent.trim().replace(/\/+$/, "")}/${name.trim()}`;
}

/** The line under Clone into. */
export function cloneIntoHint(local: boolean, host: string): string {
  return local ? "The parent folder is remembered for the next clone." : `A path on ${host}. No Browse… for remote hosts.`;
}

/** The repository a URL, `owner/repo` or SSH address names; null for anything else. */
export function repoRef(input: string): RepoRef | null {
  const text = input.trim();
  const part = "[A-Za-z0-9._][A-Za-z0-9._-]*";
  const ssh = new RegExp(`^(?:git@github\\.com:|ssh://git@github\\.com/)(${part})/(${part}?)(?:\\.git)?/?$`).exec(text);
  if (ssh) {
    const repo = `${ssh[1]}/${ssh[2]}`;
    return { repo, ssh: `git@github.com:${repo}.git` };
  }
  const url = new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${part})/(${part}?)(?:\\.git)?(?:[/?#].*)?$`).exec(text);
  const plain = new RegExp(`^(${part})/(${part})$`).exec(text);
  const m = url ?? plain;
  if (!m || m[1].startsWith(".")) return null;
  return { repo: `${m[1]}/${m[2]}` };
}

/** How long ago `iso` was, as the repository card and list show it. */
export function pushedAgo(iso: string, now: Date): string {
  const then = new Date(iso);
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 1) return "just now";
  if (hours < 1) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "yesterday";
  if (days < 14) return `${days}d ago`;
  if (days < 56) return `${Math.floor(days / 7)}w ago`;
  const month = MONTHS[then.getUTCMonth()];
  return `${then.getUTCDate()} ${month} ${then.getUTCFullYear()}`;
}

/** gh's `diskUsage` (KB) as the card shows it. */
export function diskSize(kb: number): string {
  if (kb < 1024) return "<1 MB";
  const mb = kb / 1024;
  return mb < 1024 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

/** Up to `limit` of the user's repositories whose `owner/repo` holds `query`, in gh's order (most recently pushed first). */
export function matchingRepos<T extends { repo: string }>(repos: T[], query: string, limit = 6): T[] {
  const q = query.trim().toLowerCase();
  return repos.filter((r) => r.repo.toLowerCase().includes(q)).slice(0, limit);
}

/** The owners the list shows, in order of first appearance: "acme, sam-rivera". */
export function repoOwners(repos: { repo: string }[]): string {
  return [...new Set(repos.map((r) => repoParts(r.repo).owner))].join(", ");
}

/** The highlighted row after ↑ or ↓ in a list of `count`, wrapping around. */
export function moveHighlight(current: number, key: "ArrowUp" | "ArrowDown", count: number): number {
  return (current + (key === "ArrowDown" ? 1 : -1) + count) % count;
}

/** gh on a host, or "too-old" when its daemon predates X59. */
export type GhOnHost = GhStatus | "too-old";

/** What the Clone from GitHub tab shows and allows. */
export function cloneTabState(s: { text: string; gh: GhOnHost | null; found: boolean; target: CloneTarget | null; cloning: boolean; busy: boolean }): { listing: boolean; canClone: boolean } {
  const signedIn = !!s.gh && s.gh !== "too-old" && !!s.gh.login;
  return {
    listing: !repoRef(s.text) && signedIn && !s.cloning,
    canClone: s.found && !!s.target && !s.target.exists && !s.busy && !s.cloning,
  };
}

/** The parent folder Clone into starts with on `host`: the last one used there, else `~/moonlet`. */
export function cloneParent(host: string): string {
  return storedParents()[host] ?? "~/moonlet";
}

/** Remembers `parent` for the next clone on `host`. */
export function rememberCloneParent(host: string, parent: string) {
  writeStored("cloneParents", JSON.stringify({ ...storedParents(), [host]: parent }));
}

function storedParents(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readStored("cloneParents") ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** How far each step of a clone got, from its `repo.clone_progress` events. */
export type CloneSteps = Partial<Record<CloneStep, Pick<CloneProgress, "current" | "total" | "size" | "speed">>>;

export interface StepRow {
  text: string;
  state: "done" | "running" | "waiting";
}

const STEPS: CloneStep[] = ["counting", "receiving", "resolving"];

/** The steps after another progress event. */
export function afterCloneProgress(steps: CloneSteps, p: CloneProgress): CloneSteps {
  return { ...steps, [p.step]: { current: p.current, total: p.total, size: p.size, speed: p.speed } };
}

/** How much of `step` is done, 0 to 1: all of it once a later step started. */
function stepDone(steps: CloneSteps, step: CloneStep): number {
  if (STEPS.slice(STEPS.indexOf(step) + 1).some((later) => steps[later])) return 1;
  const s = steps[step];
  return s && s.total > 0 ? Math.min(1, s.current / s.total) : 0;
}

const count = (n: number) => n.toLocaleString("en-US");

/** The progress card's three step lines. */
export function cloneStepRows(steps: CloneSteps): StepRow[] {
  const { counting, receiving, resolving } = steps;
  const texts: Record<CloneStep, string> = {
    counting: ["Counting objects", counting && count(counting.total)].filter(Boolean).join(" "),
    receiving: receiving
      ? [`Receiving objects ${count(receiving.current)}/${count(receiving.total)}`, receiving.size, receiving.speed].filter(Boolean).join(" · ")
      : "Receiving objects",
    resolving: resolving ? `Resolving deltas ${count(resolving.current)}/${count(resolving.total)}` : "Resolving deltas",
  };
  return STEPS.map((step) => ({
    text: texts[step],
    state: stepDone(steps, step) === 1 ? "done" : steps[step] ? "running" : "waiting",
  }));
}

/** The progress card's percentage: 10% counting, 80% receiving, 10% resolving, rounded down. */
export function clonePercent(steps: CloneSteps): number {
  const weights: Record<CloneStep, number> = { counting: 10, receiving: 80, resolving: 10 };
  return Math.floor(STEPS.reduce((sum, step) => sum + weights[step] * stepDone(steps, step), 0));
}

/** The red box when the host cannot find or read the repository. */
export function cantSee(host: string, repo: string, gh: GhStatus): { title: string; body: string; signIn: boolean } {
  const title = `${host} can't see ${repo}`;
  if (gh.login) return { title, body: `It doesn't exist, or ${gh.login} has no access to it.`, signIn: false };
  if (!gh.installed) return { title, body: `gh isn't installed on ${host}, so only public repositories can be cloned there. Install gh and sign in once on that host, then try again.`, signIn: true };
  return { title, body: `gh isn't signed in on ${host}, so only public repositories can be cloned there. Sign in once on that host, then try again.`, signIn: true };
}

/** The footer's gh line for the host. */
export function ghLine(host: string, gh: GhOnHost): { text: string; ok: boolean } {
  if (gh === "too-old") return { text: `${host}'s moonletd is too old to clone from GitHub. Update moonlet there.`, ok: false };
  if (!gh.installed) return { text: `gh is not installed on ${host}`, ok: false };
  return gh.login ? { text: `gh signed in on ${host}`, ok: true } : { text: `gh not signed in on ${host}`, ok: false };
}

/** The amber box when Clone into names a folder that exists; null when it is free. */
export function targetTaken(target: CloneTarget, repo: string, shownPath: string): { path: string; body: string; addExisting: boolean; useName: string } | null {
  if (!target.exists) return null;
  const path = shownPath;
  const useName = target.free_name;
  if (!target.same_repo) return { path, body: `It isn't a clone of ${repo}. Pick another name to clone fresh.`, addExisting: false, useName };
  const on = target.branch ? `, on ${target.branch}` : "";
  return { path, body: `It's already a clone of ${repo}${on}. Add that folder as the project, or pick another name to clone fresh.`, addExisting: true, useName };
}

/** A clone the app knows of, keyed `<host>/<id>` in `CloneRuns`. */
export interface CloneRun {
  host: string;
  job: CloneJob;
  steps: CloneSteps;
  /** Clone into's parent as typed, remembered when the clone succeeds; absent for clones another window started. */
  parent?: string;
  /** The workspace of the section the project joins, for the composer. */
  workspace?: string;
  /** Why it failed, kept while the dialog that started it shows it. */
  error?: string;
}

export type CloneRuns = Record<string, CloneRun>;

export const cloneKey = (host: string, id: string) => `${host}/${id}`;

/** The runs after a `repo.clone_progress` event from `host`. */
export function runsAfterProgress(runs: CloneRuns, host: string, p: CloneProgress): CloneRuns {
  const key = cloneKey(host, p.id);
  const run = runs[key] ?? { host, job: { id: p.id, repo: p.repo, path: p.path }, steps: {} };
  return { ...runs, [key]: { ...run, steps: afterCloneProgress(run.steps, p) } };
}

export interface CloneEnd {
  runs: CloneRuns;
  /** Open the new session composer for this project: the dialog watched the clone. */
  open?: { host: string; project: Project; workspace?: string };
  toast?: { text: string; kind: "info" | "error" };
  remember?: { host: string; parent: string };
}

/** What a `repo.clone_done` from `host` changes. `watching` is the run key the open Add project dialog shows, if any. */
export function afterCloneDone(runs: CloneRuns, host: string, done: CloneDone, watching: string | null): CloneEnd {
  const key = cloneKey(host, done.id);
  const run = runs[key];
  const { [key]: _, ...rest } = runs;
  const watched = watching === key;
  if (done.project) {
    return {
      runs: rest,
      ...(watched && { open: { host, project: done.project, workspace: run?.workspace } }),
      toast: { text: `Added ${done.project.name}`, kind: "info" },
      ...(run?.parent && { remember: { host, parent: run.parent } }),
    };
  }
  if (done.error) {
    if (watched && run) return { runs: { ...rest, [key]: { ...run, error: done.error } } };
    return { runs: rest, toast: { text: `Cloning ${done.repo} failed: ${done.error}`, kind: "error" } };
  }
  return { runs: rest };
}
