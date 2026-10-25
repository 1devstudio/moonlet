// Design mode's labels and names (X64, X65). Pure: the store is designStore.ts.

import { ago } from "./mobile";
import type { AgentState, Design, DesignOpen, DesignSystem } from "./protocol";

export interface RowLabel {
  text: string;
  /** `attention` for needs you, `changed` (orange) for out of date, `error`, else `muted`. */
  tone: "attention" | "changed" | "error" | "muted";
}

/** The right side of a design system's sidebar row: what most needs the user
 * first. `working`: its sync agent is at work now, so a sync it stopped
 * without recording is not shown as running. */
export function systemLabel(sys: DesignSystem, now: number, working: boolean): RowLabel {
  if (sys.error) return { text: "unreadable", tone: "error" };
  if (sys.needs_you) return { text: "needs you", tone: "attention" };
  if (working && sys.sync_running) return { text: "syncing", tone: "muted" };
  if (sys.synced_at === null) return { text: "not built", tone: "muted" };
  if (sys.to_settle) return { text: `${sys.to_settle} to settle`, tone: "changed" };
  if (sys.changed_sources.length) return { text: `${sys.changed_sources.length} changed`, tone: "changed" };
  return { text: shortAge(now - sys.synced_at), tone: "muted" };
}

export interface DesignRowLabel extends RowLabel {
  /** Its agent's state, for the dot; null without an agent. */
  state: AgentState | null;
  /** `text` counts open comments. */
  comments: boolean;
}

/** A design's sidebar row (X65): its agent's state (`state`, the agent's
 *  live state, which the caller knows), then needs you, else its open
 *  comments, else its age. */
export function designRow(d: Design, now: number, state: AgentState | null): DesignRowLabel {
  const dot = d.agent === null ? null : state;
  if (d.error) return { state: dot, text: "unreadable", tone: "error", comments: false };
  if (d.needs_you) return { state: dot, text: "needs you", tone: "attention", comments: false };
  if (d.open_comments > 0) return { state: dot, text: String(d.open_comments), tone: "muted", comments: true };
  return { state: dot, text: shortAge(now - d.updated_at), tone: "muted", comments: false };
}

/** "now", "12m", "5h", "3d", "2w". */
function shortAge(ms: number): string {
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  const days = Math.floor(ms / 86_400_000);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

/** A design system's folder name, as moonlet-core's `design::store::slug`. */
export function designSlug(name: string): string {
  let out = "";
  for (const c of name.trim().toLowerCase()) {
    if (/^[a-z0-9]$/.test(c)) out += c;
    else if (out && !out.endsWith("-")) out += "-";
  }
  out = out.replace(/-+$/, "");
  return out || "design-system";
}

/** Where `design.system.create` will put a system named `name`: a used
 * folder makes it `<name> 2`, `<name> 3`, as the daemon does. Unknown (null)
 * until the workspace's systems are listed. */
export function systemFolder(workspace: string, name: string, taken: string[] | undefined): string | null {
  if (!taken) return null;
  let n = 1;
  let slug = designSlug(name);
  while (taken.includes(slug)) slug = designSlug(`${name} ${++n}`);
  return `~/.moonlet/design/${workspace}/systems/${slug}`;
}

/** The picked projects still in the workspace, in the order they were picked. */
export function picksInWorkspace(picked: string[], projects: string[]): string[] {
  return picked.filter((id) => projects.includes(id));
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The New design dialog's line under the design system (X65): "moonlet
 *  desktop: 11 cards, 2 layouts, synced 3 days ago from moonlet". */
export function systemSummary(sys: DesignSystem, projects: { path: string; name: string }[], now: number): string {
  const from = sys.sources.map((p) => projects.find((x) => x.path === p)?.name ?? p.split("/").filter(Boolean).pop() ?? p).join(", ");
  const synced = sys.synced_at === null ? `not synced yet${from ? `, from ${from}` : ""}` : `synced ${ago(now - sys.synced_at)}${from ? ` from ${from}` : ""}`;
  return `${sys.name}: ${plural(sys.cards, "card")}, ${plural(sys.layouts, "layout")}, ${synced}`;
}

export interface NewDesign {
  name: string;
  /** The design system's slug. */
  system: string;
  brief: string;
}

/** Whether **Create design** may run, and why not (X65): a name, one of the
 *  workspace's design systems (`systems`, their slugs) and a brief. */
export function newDesignReady(d: NewDesign, systems: string[]): { ready: boolean; why: string | null } {
  if (!d.name.trim()) return { ready: false, why: "Name the design" };
  if (!systems.includes(d.system)) return { ready: false, why: "A design starts from a design system" };
  if (!d.brief.trim()) return { ready: false, why: "Say what to design: the brief is Claude's first message" };
  return { ready: true, why: null };
}

/** What the app does on `design.open` (X65): show the design the user asked
 *  for; one an agent started (`spawned_by`) is offered in a toast instead, and
 *  the focus stays where it is (as X22). */
export function designOpenAction(ev: DesignOpen, sessions: { id: string; name: string }[]): { kind: "show" } | { kind: "toast"; text: string } {
  if (ev.spawned_by === undefined || ev.spawned_by === null) return { kind: "show" };
  const by = sessions.find((s) => s.id === ev.session)?.name ?? "An agent";
  return { kind: "toast", text: `${by} started the design ${ev.name}` };
}

/** A design agent's first message is its brief with the design system's
 *  README and the design rules after it; the chat shows the brief alone,
 *  under a note that says what went with it. Null for any other message. */
export function briefShown(text: string, brief: string): string | null {
  const b = brief.trim();
  return b && text.length > b.length && text.startsWith(b) ? b : null;
}
