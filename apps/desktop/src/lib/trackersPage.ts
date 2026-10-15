// Settings › Task trackers (X44): status lines and the rules' wording.

import type { RuleSetting, Rules } from "./keepInStep";
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
