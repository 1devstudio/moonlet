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
  /** Jira's components, for a board's "start in" rules (X50). */
  components?: string[];
  /** Story points or estimate, when the board's cards show them (X50). */
  points?: number;
  /** The epic or parent issue. */
  parent?: { key: string; title: string };
  /** `YYYY-MM-DD`. */
  due?: string;
  /** Markdown. */
  description: string;
  updatedMs: number;
  /** Linear's cycle number, when the issue is in one. */
  cycle?: number;
  /** Assigned to the user, as the tracker (or `gh`) said; for Assignee: me (X45). */
  mine?: boolean;
  /** Jira's issue type ("Bug", "Story"). */
  issueType?: string;
  /** GitHub issues: what links a branch or PR to it. */
  github?: {
    repo: string;
    number: number;
    closingPrs: number[];
    /** On a GitHub Project's board (X50): the Project's id, the item, and its Status option's name (for showing) and id (which columns match by), none when it has none. */
    project?: { id: string; item: string; status: string | null; option?: string | null };
  };
  /** Linear, Jira and ClickUp issues: their id, state name and team/project/list in the tracker. */
  tracker?: { id: string; state: string; source: string; statusId?: string };
}

/** A task's id across trackers: `<connection> <key>`, as the store and boards key it. */
export const taskId = (t: Pick<Task, "connection" | "key">) => `${t.connection} ${t.key}`;

/** A GitHub Project's item (X50) as a task: the issue, with its item, Status and estimate (its number field's value). */
export function taskFromProjectItem(
  i: { item: string; status: string | null; option?: string | null; estimate?: number | null; task: GhTask },
  connection: string,
  projectId: string,
  /** The Project's Status options, for an older host that sends no option id: found by name. */
  options: { id: string; name: string }[] = [],
): Task {
  const t = taskFromGh(i.task, connection);
  const option = i.option ?? options.find((o) => o.name === i.status)?.id ?? null;
  return { ...t, ...(typeof i.estimate === "number" && { points: i.estimate }), github: { ...t.github!, project: { id: projectId, item: i.item, status: i.status, option } } };
}

/** A GitHub issue from `gh.tasks` as a task. */
export function taskFromGh(gh: GhTask, connection: string): Task {
  return {
    // The user's own unless the sync says otherwise (X45 Assignee: me).
    mine: true,
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
/** "Link a session to an issue when…" (X44); `title` only ever suggests. */
export interface LinkRules {
  branch: boolean;
  pr: boolean;
  title: boolean;
}

export const DEFAULT_LINK: LinkRules = { branch: true, pr: true, title: true };

export function taskForSession(
  s: SessionLinkFacts,
  pr: PullRequest | null | undefined,
  originRepo: string | null,
  tasks: Task[],
  rules: LinkRules = DEFAULT_LINK,
): Task | null {
  if (s.task) return tasks.find((t) => t.connection === s.task?.connection && t.key === s.task.key) ?? null;
  if (s.task_unlinked) return null;
  const sameRepo = (t: Task) => !!t.github && !!originRepo && t.github.repo.toLowerCase() === originRepo.toLowerCase();
  const number = githubBranchNumber(s.branch);
  const byBranch = rules.branch ? tasks.find((t) => (t.github ? sameRepo(t) && t.github.number === number : mentionsKey(s.branch, t.key))) : undefined;
  if (byBranch) return byBranch;
  if (!pr || !rules.pr) return null;
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

const TRACKER_NAMES: Record<TrackerKind, string> = { github: "GitHub", linear: "Linear", jira: "Jira", clickup: "ClickUp" };

/** The tracker of a connection id (`jira:acme.atlassian.net` → `jira`). */
export function trackerOf(connection: string): TrackerKind | null {
  const kind = connection.split(":")[0];
  return Object.hasOwn(TRACKER_NAMES, kind) ? (kind as TrackerKind) : null;
}

/** The tracker's name as the UI writes it, from a connection id or a kind. */
export function trackerName(connectionOrKind: string): string {
  const kind = trackerOf(connectionOrKind);
  return kind ? TRACKER_NAMES[kind] : "tracker";
}

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
  /**
   * The projects to start in: the one whose GitHub repository the issue is
   * in, or those whose Project settings link the issue's tracker project (X44).
   */
  projects: string[];
  /** A GitHub issue's repository and number, for assigning it (X46). */
  github?: { repo: string; number: number };
  /** A tracker issue's id and team/project/list, for moving it (X46). */
  tracker?: { id: string; source: string };
  /** The composer's "session starts" checkbox (Keep in step), when it does anything. */
  assign?: { label: string; title: string; checked: boolean } | null;
  /** The connection's branch template and max length (X44); the tracker's default when absent. */
  template?: string;
  maxLen?: number;
  /** `{type}` in the branch template: Jira's issue type, else the first label. */
  issueType?: string;
  /** `{user}` in the branch template (see `branchUser`). */
  user?: string;
}

/** How a tracker project is named in the links of the projects that start from it (X44): `connection key`. */
export const sourceKey = (connection: string, key: string) => `${connection} ${key}`;

/**
 * The composer's preset for starting a session from `task`. `repos` are the
 * projects' `owner/repo` by id; `sourceProjects` the projects that link a
 * tracker source, by `connection source`.
 */
export function taskStart(task: Task, repos: Record<string, string | null>, sourceProjects: Record<string, string[]> = {}): TaskStart {
  const description = task.description.trim();
  const repo = task.github?.repo.toLowerCase();
  return {
    ref: { connection: task.connection, key: task.key, url: task.url },
    kind: trackerOf(task.connection) ?? "github",
    key: task.key,
    title: task.title,
    number: task.github?.number,
    firstMessage: `${task.key} · ${task.title}${description ? `\n${description}` : ""}`,
    projects: repo ? Object.keys(repos).filter((id) => repos[id]?.toLowerCase() === repo).slice(0, 1) : task.tracker ? (sourceProjects[sourceKey(task.connection, task.tracker.source)] ?? []) : [],
    ...(task.github && { github: { repo: task.github.repo, number: task.github.number } }),
    ...(task.tracker && { tracker: { id: task.tracker.id, source: task.tracker.source } }),
    ...((task.issueType ?? task.labels[0]) && { issueType: task.issueType ?? task.labels[0] }),
  };
}
