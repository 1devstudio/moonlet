// Tasks from trackers (X44) and the sessions working on them (X46).

import type { GhTask, PullRequest, TaskRef } from "./protocol";

/** moonlet's columns (X44 "States"); `hidden` is "Not shown". */
export type Column = "todo" | "in_progress" | "in_review" | "done" | "hidden";

/** One tracker issue, the same shape whichever tracker it came from. */
export interface Task {
  /** The connection id, its tracker and site (`linear:acme`, `github:github.com`). */
  connection: string;
  key: string;
  title: string;
  url: string;
  /** The column its tracker state maps to; `open` for a GitHub repository issue, placed by its work. */
  column: Column | "open";
  /** 0–3 bars. */
  priority: number;
  assignees: string[];
  labels: string[];
  /** Markdown. */
  description: string;
  updatedMs: number;
  /** GitHub issues: what links a branch or PR to it. */
  github?: { repo: string; number: number; closingPrs: number[] };
}

/** A GitHub issue from `gh.tasks` as a task. */
export function taskFromGh(gh: GhTask, connection: string): Task {
  return {
    connection,
    key: `${gh.repo}#${gh.number}`,
    title: gh.title,
    url: gh.url,
    column: !gh.closed ? "open" : gh.state_reason === "completed" ? "done" : "hidden",
    priority: 0,
    assignees: gh.assignees,
    labels: gh.labels,
    description: gh.body,
    updatedMs: gh.updated_ms,
    github: { repo: gh.repo, number: gh.number, closingPrs: gh.closing_prs },
  };
}

const alnum = (c: string | undefined) => !!c && /[a-z0-9]/i.test(c);

/**
 * Whether `text` (a branch name, a PR title) contains `key`, ignoring case,
 * with no letter or digit right before or after it: `moon-142-x` carries
 * `MOON-142`, `moon-1420` does not.
 */
export function mentionsKey(text: string, key: string): boolean {
  if (!key) return false;
  const hay = text.toLowerCase();
  const needle = key.toLowerCase();
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (!alnum(hay[at - 1]) && !alnum(hay[at + needle.length])) return true;
  }
  return false;
}

/** The issue number `gh issue develop` puts first in a branch: `42-fix-login` is 42. */
export function githubBranchNumber(branch: string): number | null {
  const m = /^(\d+)-./.exec(branch);
  return m ? Number(m[1]) : null;
}

/** What of a session links it to a task (X46). */
export interface SessionLinkFacts {
  branch: string;
  task?: TaskRef | null;
  task_unlinked?: boolean;
}

/**
 * The task a session works on (X46 "Links"), first match wins: its stored
 * link; its branch name (the key, or for GitHub a leading issue number in the
 * project's own repository); its PR (a title with the key, or a PR that
 * closes the GitHub issue). Nothing once the user unlinked it.
 * `originRepo` is the project's `owner/repo` on GitHub, if any.
 */
export function taskForSession(
  s: SessionLinkFacts,
  pr: PullRequest | null | undefined,
  originRepo: string | null,
  tasks: Task[],
): Task | null {
  if (s.task) return tasks.find((t) => t.connection === s.task?.connection && t.key === s.task.key) ?? null;
  if (s.task_unlinked) return null;
  const sameRepo = (t: Task) => !!t.github && !!originRepo && t.github.repo.toLowerCase() === originRepo.toLowerCase();
  const number = githubBranchNumber(s.branch);
  const byBranch = tasks.find((t) => (t.github ? sameRepo(t) && t.github.number === number : mentionsKey(s.branch, t.key)));
  if (byBranch) return byBranch;
  if (!pr) return null;
  return (
    tasks.find((t) => (t.github ? sameRepo(t) && t.github.closingPrs.includes(pr.number) : mentionsKey(pr.title, t.key))) ?? null
  );
}

/** The `owner/repo` of an `origin` URL (https, ssh or scp-like) on github.com. */
export function githubRepo(remote: string | null): string | null {
  const r = remote?.trim();
  if (!r) return null;
  const scp = /^[^/@:]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(r);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(r);
    if (url.hostname !== "github.com") return null;
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    return owner && repo ? `${owner}/${repo.replace(/\.git$/, "")}` : null;
  } catch {
    return null;
  }
}

export type TrackerKind = "linear" | "jira" | "clickup" | "github";

/** What the new-session composer starts with for a task (X46). */
export interface TaskStart {
  ref: TaskRef;
  kind: TrackerKind;
  key: string;
  title: string;
  /** GitHub's issue number, for the `{number}` branch template. */
  number?: number;
  /** `<key> · <title>` and the description, which the user can edit before sending. */
  firstMessage: string;
  /** The project to start in: the one whose GitHub repository the issue is in. */
  project: string | null;
  /** A GitHub issue's repository and number, for assigning it (X46). */
  github?: { repo: string; number: number };
  /** The composer's "session starts" checkbox (Keep in step), when it does anything. */
  assign?: { label: string; checked: boolean } | null;
}

/** The composer's preset for starting a session from `task`; `repos` are the projects' `owner/repo` by id. */
export function taskStart(task: Task, repos: Record<string, string | null>): TaskStart {
  const description = task.description.trim();
  const repo = task.github?.repo.toLowerCase();
  return {
    ref: { connection: task.connection, key: task.key, url: task.url },
    kind: task.connection.split(":")[0] as TrackerKind,
    key: task.key,
    title: task.title,
    number: task.github?.number,
    firstMessage: `${task.key} · ${task.title}${description ? `\n${description}` : ""}`,
    project: (repo && Object.keys(repos).find((id) => repos[id]?.toLowerCase() === repo)) || null,
    ...(task.github && { github: { repo: task.github.repo, number: task.github.number } }),
  };
}
