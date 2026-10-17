// Settings › Task trackers (X44): status lines and the rules' wording.

import type { BoardConfig } from "./boards";
import type { RuleSetting, Rules } from "./keepInStep";
import { type Task, type TrackerKind, trackerOf } from "./tasks";
import type { Connection } from "./tasksStore";
import type { StatusLine } from "./settingsPage";

/** The GitHub row's line: who `gh` is signed in as on `host`, or why not. */
export function githubConnection(host: string, login: string | null | undefined, error: string | null): StatusLine {
  if (login === undefined) return { tone: "muted", text: `Checking gh on ${host}…` };
  if (login) return { tone: "done", text: `Connected as ${login} · uses gh on ${host}` };
  if (error?.includes("gh auth login")) return { tone: "error", text: `gh is not signed in on ${host} · run gh auth login there` };
  if (error?.startsWith("cannot run gh")) return { tone: "error", text: `gh is not installed on ${host}` };
  return { tone: "error", text: `gh failed on ${host}: ${error ?? "no answer"}` };
}

export const RULE_SETTINGS: { id: RuleSetting; label: string }[] = [
  { id: "auto", label: "Automatically" },
  { id: "suggest", label: "Suggest" },
  { id: "off", label: "Off" },
];

export const SYNC_INTERVALS = [
  { value: 30, label: "Every 30 seconds" },
  { value: 60, label: "Every minute" },
  { value: 300, label: "Every 5 minutes" },
  { value: 0, label: "Only when I refresh" },
];

/** Keep GitHub in step (X46): the rules that do something for a GitHub repository source. */
export const GITHUB_RULES: { id: keyof Rules; when: string; then: string; hint: string; auto?: false }[] = [
  { id: "session_starts", when: "A session starts from an issue", then: "assign it to me", hint: "The new-session composer shows the checkbox; Suggest leaves it unticked." },
  { id: "pr_comment", when: "A pull request opens", then: "add Closes #<number> to it", hint: "The Create PR dialog adds the line, so merging the PR closes the issue." },
  { id: "all_merged", when: "Every session's PR is merged", then: "close the issue", hint: "Suggest shows it as out of sync with a one-click fix." },
  { id: "issue_done", when: "The issue is closed", then: "archive its sessions and remove their worktrees", hint: "Always asks first.", auto: false },
];

const AUTH_LABEL: Record<string, string> = { api_key: "API key", token: "API token", oauth: "OAuth" };

/** A Linear, Jira or ClickUp row's line: who it is signed in as, or what to do. */
export function connectionLine(c: Connection, boards: BoardConfig[] | undefined, attention: string | undefined): StatusLine {
  if (attention) return { tone: "error", text: attention };
  // Counted by its boards (X50).
  const n = (boards ?? []).filter((b) => b.connection === c.id).length;
  const sources = n ? `${n} board${n === 1 ? "" : "s"}` : "pick what to show";
  return { tone: n ? "done" : "blocked", text: `Connected as ${c.account} · ${AUTH_LABEL[c.auth] ?? c.auth} · ${sources}` };
}

/** Keep <tracker> in step (X46): the five rules, worded for Linear, Jira or ClickUp. */
export function trackerRules(kind: Connection["kind"]): { id: keyof Rules; when: string; then: string; hint: string; auto?: false }[] {
  const issue = kind === "clickup" ? "task" : "issue";
  return [
    { id: "session_starts", when: `A session starts from ${kind === "clickup" ? "a task" : "an issue"}`, then: "move it to In Progress and assign it to me", hint: `Only from Todo or a state not shown; an ${issue} further along is left alone.` },
    { id: "pr_opens", when: "A pull request opens", then: `move the ${issue} to In Review`, hint: "When a session's pull request is open; Suggest shows a one-click fix instead." },
    { id: "all_merged", when: "Every session's PR is merged", then: `move the ${issue} to Done`, hint: "Set it to Off in teams where QA closes issues." },
    { id: "pr_comment", when: "A pull request opens", then: `comment on the ${issue} with its link`, hint: "Once per pull request." },
    { id: "issue_done", when: `The ${issue} moves to Done`, then: "archive its sessions and remove their worktrees", hint: "Always asks first.", auto: false },
  ];
}

/** The issue the branch name preview fills the template with: a real one of that tracker, else an example (X44). */
export function previewTask(
  tasks: Task[],
  kind: TrackerKind,
  connections: { id: string; kind: string }[] = [],
): { key: string; title: string; number?: number; issueType?: string; connection: string } {
  const real = tasks.find((t) => trackerOf(t.connection) === kind);
  if (real) return { key: real.key, title: real.title, number: real.github?.number, issueType: real.issueType ?? real.labels[0], connection: real.connection };
  // An example, with the tracker's first connection for `{user}`.
  const connection = kind === "github" ? "github:github.com" : (connections.find((c) => c.kind === kind)?.id ?? `${kind}:`);
  return kind === "github" ? { key: "acme/web#42", title: "Fix checkout on Safari", number: 42, connection } : { key: "MOON-151", title: "Drag sessions between sections", connection };
}
