// Design mode's labels and names (X64, X65). Pure: the store is designStore.ts.

import type { DesignSystem } from "./protocol";

export interface RowLabel {
  text: string;
  /** `attention` for needs you, `changed` (orange) for out of date, `error`, else `muted`. */
  tone: "attention" | "changed" | "error" | "muted";
}

/** The right side of a design system's sidebar row: what most needs the user first. */
export function systemLabel(sys: DesignSystem, now: number): RowLabel {
  if (sys.error) return { text: "unreadable", tone: "error" };
  if (sys.needs_you) return { text: "needs you", tone: "attention" };
  if (sys.step || (sys.synced_at === null && sys.agent !== null)) return { text: "syncing", tone: "muted" };
  if (sys.synced_at === null) return { text: "not built", tone: "muted" };
  if (sys.to_settle) return { text: `${sys.to_settle} to settle`, tone: "changed" };
  if (sys.changed_sources.length) return { text: `${sys.changed_sources.length} changed`, tone: "changed" };
  return { text: shortAge(now - sys.synced_at), tone: "muted" };
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
 * folder makes it `<name> 2`, `<name> 3`, as the daemon does. */
export function systemFolder(workspace: string, name: string, taken: string[]): string {
  let n = 1;
  let slug = designSlug(name);
  while (taken.includes(slug)) slug = designSlug(`${name} ${++n}`);
  return `~/.moonlet/design/${workspace}/systems/${slug}`;
}
