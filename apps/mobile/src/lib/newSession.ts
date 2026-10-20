// New session (X40): what the daemon will name the session and its branch,
// the projects to start in, and the modes to start in.

import { workspaceSections } from "@desktop/lib/sidebar";
import { DEFAULT_GIT_SETTINGS } from "@desktop/lib/gitSettings";
import { type Attachment, attachments, firstMessage, placeholder, sessionName } from "@desktop/lib/composer";
import type { GitSettings, IssueRef, Project, ProjectConfig } from "@desktop/lib/protocol";
import type { HostData } from "./app";
import type { InboxHost } from "./inbox";

/** The session's name: the prompt's first line, at most 48 characters, cut
 * at a word (the daemon's `derive_name`). */
export function nameFromPrompt(prompt: string): string {
  const line = prompt.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (!line) return "Untitled";
  const chars = [...line];
  if (chars.length <= 48) return line;
  let out = chars.slice(0, 48).join("");
  const space = out.lastIndexOf(" ");
  if (space > 24) out = out.slice(0, space);
  return `${out}…`;
}

/** The daemon's `git::slug`. */
function slug(name: string): string {
  let out = "";
  for (const c of name.toLowerCase()) {
    if (/^[a-z0-9]$/.test(c)) out += c;
    else if (out && !out.endsWith("-")) out += "-";
  }
  out = [...out.replace(/-+$/, "")].slice(0, 48).join("");
  return out || "task";
}

/** What new branches start with: the project's prefix, else the host's
 * (X55), as the daemon decides; an empty prefix is kept. */
export const branchPrefix = (config: Pick<ProjectConfig, "branch_prefix"> | null, git: Pick<GitSettings, "branch_prefix"> | null) =>
  config?.branch_prefix ?? git?.branch_prefix ?? DEFAULT_GIT_SETTINGS.branch_prefix;

/** The branch the daemon creates for `prompt` (before making it unique). */
export const branchPreview = (prompt: string, prefix: string) => `${prefix}${slug(nameFromPrompt(prompt))}`;

/** Where the worktree starts: the picked base, or the project's base on
 * origin when the host starts from origin (X55) and no other base was picked. */
export function startPoint(picked: string | null, projectBase: string, from: GitSettings["start_from"]): string {
  const base = picked ?? projectBase;
  return base === projectBase && from === "origin" ? `origin/${base}` : base;
}

/** The footer above Start session. */
export function setupLine(start: string, host: string, setup: string | null | undefined): string {
  return `Creates a worktree from ${start} on ${host}${setup ? ` and runs setup: ${setup}` : ""}`;
}

/** What New session shows and sends with a picked GitHub issue or PR (X54).
 * A PR's attachment is sent while `prSend`; its branch is used either way. */
export function composer(o: { typed: string; prefix: string; issue: IssueRef | null; pr: IssueRef | null; prContext: string | null; prSend: boolean }): {
  attachments: Attachment[];
  placeholder: string;
  /** The branch the session works on: a new one, or the PR's. */
  branch: { name: string; existing: boolean };
  /** `session.create`'s prompt, name and PR; null with nothing to send. */
  create: { prompt: string; name: string | null; pr: number | null } | null;
} {
  const sent = attachments({ task: null, issue: o.issue, pr: o.prSend ? o.pr : null, prContext: o.prContext });
  const prompt = firstMessage(sent, o.typed);
  return {
    attachments: sent,
    placeholder: placeholder(sent.map((a) => a.id)),
    branch: o.pr ? { name: o.pr.head_branch ?? "", existing: true } : { name: branchPreview(o.typed, o.prefix), existing: false },
    create: prompt === null ? null : { prompt, name: sessionName({ task: null, issue: o.issue, pr: o.pr }), pr: o.pr?.number ?? null },
  };
}

/** Claude's permission modes (X7), as the design names them. */
export const MODES = [
  { id: "auto", label: "Auto", help: "Claude decides which tools are safe to run without asking." },
  { id: "manual", label: "Manual", help: "Claude asks before every edit and command. Approve from the Inbox." },
  { id: "acceptEdits", label: "Edits", help: "File edits go through; commands still ask first." },
  { id: "plan", label: "Plan", help: "Claude explores and proposes a plan before touching anything." },
] as const;

export const modeHelp = (id: string) => MODES.find((m) => m.id === id)?.help ?? "";

export interface ProjectChoice {
  host: string;
  hostLabel: string;
  remote: boolean;
  project: Project;
  /** The workspace a new session goes into. */
  workspaceId: string;
}

/** The projects a new session can start in: those of the shown workspace
 * (by name, X40) on connected hosts, each once. */
export function projectChoices(hosts: Record<string, InboxHost>, data: Record<string, HostData>, workspace: string | null): ProjectChoice[] {
  const out: ProjectChoice[] = [];
  for (const h of Object.values(hosts)) {
    const d = data[h.id];
    if (h.status !== "connected" || !d) continue;
    for (const ws of d.workspaces) {
      if (workspace !== null && ws.name !== workspace) continue;
      for (const sec of workspaceSections(ws, d.sections)) {
        for (const pid of sec.project_ids) {
          const project = d.projects.find((p) => p.id === pid);
          if (project && !out.some((c) => c.host === h.id && c.project.id === pid)) {
            out.push({ host: h.id, hostLabel: h.label, remote: !!h.via, project, workspaceId: ws.id });
          }
        }
      }
    }
  }
  return out;
}
