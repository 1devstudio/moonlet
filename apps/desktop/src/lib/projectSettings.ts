// Form state for the Project settings dialog (X8): `.moonlet/config.toml` as
// editable fields, the same validation the daemon applies, and the way back.

import type { ProjectConfig } from "./protocol";
import { prefixError } from "./gitSettings";
import type { StatusLine } from "./settingsPage";

export const BUILTIN_AGENTS = ["claude", "codex"];
const NAME_RE = /^[A-Za-z0-9._-]+$/;

export interface AgentRow {
  id: number;
  name: string;
  cmd: string;
  /** Added in this dialog and still untouched: not flagged yet. */
  fresh?: boolean;
}

export interface Form {
  setup: string;
  run: string;
  archive: string;
  default_agent: string;
  base_branch: string;
  /** Put before new session branches, over the host's Git settings (X55). */
  branch_prefix: string;
  agents: AgentRow[];
  /** Tracker projects, teams or lists it handles, `<connection>/<key>` (X44). */
  trackers: string[];
}

export interface Errors {
  agents: Record<number, { name?: string; cmd?: string }>;
  defaultAgent: string;
  branchPrefix: string;
  any: boolean;
  /** How many messages there are to fix. */
  count: number;
}

/** Run runs the script when there is one; otherwise it opens Project
 *  settings so the user can set it (X8). */
export function hasRunCommand(c: ProjectConfig | null | undefined): boolean {
  return !!c?.run?.trim();
}

export interface SaveError {
  message: string;
  /** Offer Reload: the file on disk is not what the form was loaded from. */
  stale: boolean;
}

/** A failed read: the first load closes the dialog (there is nothing to
 *  edit), a failed Reload keeps the user's edits and shows the error with
 *  Reload to try again. */
export function loadFailure(reload: boolean, message: string, path?: string): { close: true } | { close: false; saveErr: SaveError } {
  return reload ? { close: false, saveErr: { message: `Could not reload ${configName(path)}: ${message}`, stale: true } } : { close: true };
}

/** What Close, Cancel or Esc does: close, ask before discarding edits (X23),
 *  or nothing while a save runs, since a successful save closes the dialog. */
export function closeRequest(s: { saving: boolean; parseError: boolean; dirty: boolean }): "close" | "ask" | "wait" {
  if (s.saving) return "wait";
  return s.parseError || !s.dirty ? "close" : "ask";
}

let uid = 1;
export const newRowId = () => uid++;

export function toForm(c: ProjectConfig): Form {
  return {
    setup: c.setup ?? "",
    run: c.run ?? "",
    archive: c.archive ?? "",
    default_agent: c.default_agent ?? "",
    base_branch: c.base_branch ?? "",
    branch_prefix: c.branch_prefix ?? "",
    agents: Object.entries(c.agents ?? {}).map(([name, cmd]) => ({ id: newRowId(), name, cmd })),
    trackers: c.trackers ?? [],
  };
}

/** Blank fields become missing keys; the daemon trims the rest too. */
export function fromForm(f: Form): ProjectConfig {
  const s = (v: string) => v.trim() || null;
  return {
    setup: s(f.setup),
    run: s(f.run),
    archive: s(f.archive),
    default_agent: s(f.default_agent),
    base_branch: s(f.base_branch),
    branch_prefix: s(f.branch_prefix),
    agents: Object.fromEntries(f.agents.map((a) => [a.name.trim(), a.cmd.trim()])),
    trackers: f.trackers,
  };
}

export function isDirty(f: Form, orig: Form): boolean {
  return JSON.stringify(fromForm(f)) !== JSON.stringify(fromForm(orig)) || f.agents.length !== orig.agents.length;
}

export function validate(f: Form): Errors {
  const agents: Errors["agents"] = {};
  const seen = new Set<string>();
  for (const a of f.agents) {
    if (a.fresh && !a.name && !a.cmd) {
      // An empty new row is not an error yet, but it can't be saved either.
      agents[a.id] = {};
      continue;
    }
    const n = a.name.trim();
    const e: { name?: string; cmd?: string } = {};
    if (!n) e.name = "Enter a name.";
    else if (BUILTIN_AGENTS.includes(n)) e.name = `${n} is built in. Pick another name.`;
    else if (!NAME_RE.test(n)) e.name = "Use only letters, digits, dots, dashes and underscores.";
    else if (seen.has(n)) e.name = `Another agent is already called ${n}.`;
    seen.add(n);
    if (!a.cmd.trim()) e.cmd = "Enter a command.";
    if (e.name || e.cmd) agents[a.id] = e;
  }
  const d = f.default_agent.trim();
  const defaultAgent = d && !BUILTIN_AGENTS.includes(d) && !f.agents.some((a) => a.name.trim() === d) ? `${d} is not an agent in this project.` : "";
  const branchPrefix = prefixError(f.branch_prefix.trim());
  const count = Object.values(agents).reduce((n, e) => n + (e.name ? 1 : 0) + (e.cmd ? 1 : 0), 0) + (defaultAgent ? 1 : 0) + (branchPrefix ? 1 : 0);
  return { agents, defaultAgent, branchPrefix, any: Object.keys(agents).length > 0 || !!defaultAgent || !!branchPrefix, count };
}

/** Default agent choices: none, the built-ins, the valid custom names, and
 *  the current value even if it is invalid, so the select can show it. */
export function agentOptions(f: Form): { value: string; label: string }[] {
  const custom = [...new Set(f.agents.map((a) => a.name.trim()).filter((n) => NAME_RE.test(n) && !BUILTIN_AGENTS.includes(n)))];
  const opts = [
    { value: "", label: "None (ask each time)" },
    { value: "claude", label: "Claude" },
    { value: "codex", label: "Codex" },
    ...custom.map((n) => ({ value: n, label: n })),
  ];
  if (f.default_agent && !opts.some((o) => o.value === f.default_agent)) opts.push({ value: f.default_agent, label: f.default_agent });
  return opts;
}

/** The config file the dialog edits, relative to the project: jaunt's
 *  `.jaunt/config.toml` while only that one exists; saving moves it (X27). */
export function configName(path: string | undefined): string {
  return path?.endsWith("/.jaunt/config.toml") ? ".jaunt/config.toml" : ".moonlet/config.toml";
}

/** The state in the project page's save bar (X43), under the file's path. */
export function saveBarStatus(s: { dirty: boolean; errors: number }): StatusLine {
  if (s.errors) return { tone: "error", text: `Fix ${s.errors} error${s.errors === 1 ? "" : "s"} to save` };
  return s.dirty ? { tone: "accent", text: "Unsaved changes" } : { tone: "muted", text: "This file is part of the repository." };
}
