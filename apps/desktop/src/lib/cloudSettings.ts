// Settings › Cloud workers (X63): the provider forms built from each adapter's
// description, the shared limits, and the lines the page and a project's
// Cloud workers section show. Pure: the pages render it.

import { joinNames } from "./heavyCommands";
import type { CloudInfo, CloudKind, CloudMachine, CloudSet, MachineType } from "./protocol";

export interface ProviderRow {
  name: string;
  label: string;
  help: string;
  secret: boolean;
  /** A secret already saved on the central host: the field shows it as set and stays empty. */
  saved: boolean;
  value: string;
}

/** A provider's form, one row per field its adapter describes. `saved` is the provider's part of `cloud.get`. */
export function providerForm(kind: CloudKind, saved: Record<string, string | boolean> | undefined): { id: string; label: string; rows: ProviderRow[] } {
  return {
    id: kind.id,
    label: kind.label,
    rows: kind.fields.map((f) => ({
      name: f.name,
      label: f.label,
      help: f.help,
      secret: f.secret,
      saved: f.secret ? saved?.[`has_${f.name}`] === true : saved?.[f.name] !== undefined,
      value: f.secret ? "" : String(saved?.[f.name] ?? ""),
    })),
  };
}

/** The page's form. Secrets start empty: typing one replaces the saved value. */
export interface CloudDraft {
  providers: Record<string, Record<string, string>>;
  tailscale: { client_id: string; client_secret: string; tag: string };
  idle_minutes: string;
  max_machines: string;
  max_hours_month: string;
}

export function cloudDraft(info: CloudInfo): CloudDraft {
  const providers: CloudDraft["providers"] = {};
  for (const kind of info.kinds) {
    if (!info.providers[kind.id]) continue;
    providers[kind.id] = Object.fromEntries(providerForm(kind, info.providers[kind.id]).rows.map((r) => [r.name, r.value]));
  }
  return {
    providers,
    tailscale: { client_id: info.tailscale.client_id, client_secret: "", tag: info.tailscale.tag },
    idle_minutes: String(info.idle_minutes),
    max_machines: String(info.max_machines),
    max_hours_month: String(info.max_hours_month),
  };
}

/** The `cloud.set` for what the draft changed, or null when nothing did. */
export function cloudChanges(info: CloudInfo, d: CloudDraft): CloudSet | null {
  const out: CloudSet = {};
  const base = cloudDraft(info);
  const providers: NonNullable<CloudSet["providers"]> = {};
  for (const [id, fields] of Object.entries(d.providers)) {
    const changed = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== (base.providers[id]?.[k] ?? "")));
    if (!base.providers[id] || Object.keys(changed).length) providers[id] = changed;
  }
  if (Object.keys(providers).length) out.providers = providers;
  const ts: NonNullable<CloudSet["tailscale"]> = {};
  if (d.tailscale.client_id !== base.tailscale.client_id) ts.client_id = d.tailscale.client_id.trim();
  if (d.tailscale.client_secret) ts.client_secret = d.tailscale.client_secret.trim();
  if (d.tailscale.tag !== base.tailscale.tag) ts.tag = d.tailscale.tag.trim();
  if (Object.keys(ts).length) out.tailscale = ts;
  for (const k of ["idle_minutes", "max_machines", "max_hours_month"] as const) {
    if (d[k] !== base[k]) out[k] = Number(d[k]);
  }
  return Object.keys(out).length ? out : null;
}

const whole = (s: string) => /^\d+$/.test(s.trim());

/** What is wrong with the draft, by field; empty when it can be saved. */
export function cloudErrors(d: CloudDraft): Partial<Record<"idle_minutes" | "max_machines" | "max_hours_month" | "tag", string>> {
  const e: ReturnType<typeof cloudErrors> = {};
  if (!whole(d.idle_minutes) || Number(d.idle_minutes) > 1440) e.idle_minutes = "From 0 to 1440 minutes.";
  if (!whole(d.max_machines) || Number(d.max_machines) < 1) e.max_machines = "At least 1 machine.";
  if (!whole(d.max_hours_month)) e.max_hours_month = "A whole number of hours.";
  if (!d.tailscale.tag.trim().startsWith("tag:")) e.tag = "A tag starts with tag:, such as tag:moonlet-worker.";
  return e;
}

/** The tailnet policy lines that let machines with `tag` reach the central host at `addr` and nothing else. */
export const policySnippet = (tag: string, addr: string): string =>
  `"tagOwners": { "${tag}": ["autogroup:admin"] },
"acls": [
  { "action": "accept", "src": ["${tag}"], "dst": ["${addr}"] }
]`;

/** The usage bar's line and how full it is, from 0 to 1. Hours show to one decimal. */
export function usageLine(hours: number, max: number): { text: string; fraction: number } {
  const shown = Math.round(hours * 10) / 10;
  return {
    text: `${shown} of ${max} machine-hours this month`,
    fraction: max > 0 ? Math.min(1, hours / max) : 1,
  };
}

const machines = (n: number) => `${n} machine${n === 1 ? "" : "s"}`;

/** "3 machines · used by shop and payments-api" under a provider's card. */
export function providerStatus(provider: string, all: CloudMachine[]): string {
  const mine = all.filter((m) => m.provider === provider);
  if (!mine.length) return "No machines";
  const projects = [...new Set(mine.map((m) => m.project))];
  return `${machines(mine.length)} · used by ${joinNames(projects)}`;
}

const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The banner of a machine the provider would not remove, or null. `provider` is its label, such as "Hetzner". */
export function removalError(m: CloudMachine, provider: string): { text: string; detail: string } | null {
  if (!m.error || m.state !== "removing") return null;
  const at = m.error_at ? `Last error at ${clock(m.error_at)}` : "";
  const since = m.error_since ? `retrying since ${clock(m.error_since)}` : "";
  const when = [at, since].filter(Boolean).join(" · ");
  return {
    text: `Could not remove ${m.name}: ${provider} answered ${m.error}.`,
    detail: `${when ? `${when}. ` : ""}It is billed until removed.`,
  };
}

/** The toast and notification when a removal starts failing. */
export const removalToast = (m: CloudMachine, provider: string): string =>
  `Could not remove ${m.name} at ${provider}: ${m.error}. It is billed until removed.`;

/** "cpx41 · 8 cores · 16 GB · x86" in the Machine type menu. */
export const machineTypeLabel = (t: MachineType): string => `${t.name} · ${t.cores} cores · ${t.memory_gb} GB · ${t.arch}`;

/** The line under a project's Cloud workers section. */
export function projectCloudFooter(all: CloudMachine[], project: string): string {
  const mine = all.filter((m) => m.project === project);
  if (!mine.length) return `No machines for ${project}`;
  const running = mine.reduce((n, m) => n + m.running, 0);
  return `${machines(mine.length)} for ${project} · ${running} running command${running === 1 ? "" : "s"}`;
}
