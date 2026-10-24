// Settings › Cloud workers (X63): the provider forms built from each adapter's
// description, the shared limits, and the lines the page and a project's
// Cloud workers section show. Pure: the pages render it.

import type { ConfirmOptions } from "./confirmOptions";
import { joinNames } from "./heavyCommands";
import type { CloudInfo, CloudKind, CloudMachine, CloudSet, MachineType, ProjectIdentity } from "./protocol";

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

/** The form after provider `id` was removed (`next` is the answer): the
 * other unsaved edits stay; the provider stays only while its machines go. */
export function afterRemoving(d: CloudDraft, next: CloudInfo, id: string): CloudDraft {
  const { [id]: _, ...providers } = d.providers;
  const kept = cloudDraft(next).providers[id];
  return { ...d, providers: kept ? { ...providers, [id]: kept } : providers };
}

/** "API token" stays as it is; "Token" becomes "token". */
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/** A Tailscale tag: `tag:` then letters, digits and dashes. */
const TAG = /^tag:[A-Za-z0-9-]+$/;

/** What is wrong with the draft, by field (a provider's as `<provider>.<field>`); empty when it can be saved. `info` is what is saved. */
export function cloudErrors(d: CloudDraft, info?: CloudInfo): Partial<Record<"idle_minutes" | "max_machines" | "max_hours_month" | "tag" | `${string}.${string}`, string>> {
  const e: ReturnType<typeof cloudErrors> = {};
  if (!whole(d.idle_minutes) || Number(d.idle_minutes) > 1440) e.idle_minutes = "From 0 to 1440 minutes.";
  if (!whole(d.max_machines) || Number(d.max_machines) < 1) e.max_machines = "At least 1 machine.";
  if (!whole(d.max_hours_month)) e.max_hours_month = "A whole number of hours.";
  if (!TAG.test(d.tailscale.tag.trim())) e.tag = "A tag is tag: then letters, digits and dashes, such as tag:moonlet-worker.";
  // A secret not saved yet must be typed: a provider without it makes no machine.
  for (const kind of info?.kinds ?? []) {
    const fields = d.providers[kind.id];
    if (!fields) continue;
    for (const f of kind.fields) {
      if (!f.secret || fields[f.name]?.trim() || info?.providers[kind.id]?.[`has_${f.name}`] === true) continue;
      e[`${kind.id}.${f.name}`] = `Paste the ${lowerFirst(f.label)}.`;
    }
  }
  return e;
}

/** The tailnet policy lines that let machines with `tag` reach the central host at `addr` and nothing else. */
export const policySnippet = (tag: string, addr: string): string =>
  `"tagOwners": { "${tag}": ["autogroup:admin"] },
"acls": [
  { "action": "accept", "src": ["${tag}"], "dst": ["${addr}"] }
]`;

/** Tailscale's addresses are 100.64.0.0/10. */
const tailnet = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b < 128;
};

/** Where cloud machines reach the central host `host`: its Tailscale `ip:port` from `mobile.status`, else its name. */
export function policyAddress(status: { port: number; listening: string[] }, host: string): string {
  return status.listening.find((l) => tailnet(l.split(":")[0])) ?? `${host}:${status.port || DEFAULT_PORT}`;
}

/** The port moonletd listens on for phones, desktops and cloud machines. */
const DEFAULT_PORT = 47428;

/** Why no machine can pair yet, or null when the central host listens on the tailnet. */
export function reachWarning(status: { listening: string[] }, host: string): string | null {
  return status.listening.length
    ? null
    : `${host} does not accept connections from your tailnet, so a cloud machine cannot pair with it. Turn on Allow connections from my tailnet in Hosts.`;
}

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

/** Machines whose removal started failing between `prev` and `next`. The
 * first read (`prev` null) toasts nothing: the nav's dot shows older errors. */
export function newRemovalErrors(prev: CloudMachine[] | null, next: CloudMachine[]): CloudMachine[] {
  if (!prev) return [];
  return next.filter((m) => m.state === "removing" && m.error && !prev.find((p) => p.id === m.id)?.error);
}

/** A provider as its errors name it: "Hetzner" for `hetzner`. */
export const providerName = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

/** The toast and notification when a removal starts failing. */
export const removalToast = (m: CloudMachine, provider: string): string =>
  `Could not remove ${m.name} at ${provider}: ${m.error}. It is billed until removed.`;

/** "cpx41 · 8 cores · 16 GB · x86" in the Machine type menu. */
export const machineTypeLabel = (t: MachineType): string => `${t.name} · ${t.cores} cores · ${t.memory_gb} GB · ${t.arch}`;

/** The line under a project's Cloud workers section: the machines of the
 * project with cloud key `key`, named `project`. */
export function projectCloudFooter(all: CloudMachine[], key: string, project: string): string {
  const mine = all.filter((m) => m.project_key === key);
  if (!mine.length) return `No machines for ${project}`;
  const running = mine.reduce((n, m) => n + m.running, 0);
  return `${machines(mine.length)} for ${project} · ${running} running command${running === 1 ? "" : "s"}`;
}

/** The question before **Remove** on a provider's card. */
export function removeProviderPrompt(label: string, count: number, host: string): ConfirmOptions {
  return {
    title: `Remove ${label}?`,
    message: count
      ? `Its ${machines(count)} ${count === 1 ? "is" : "are"} removed first, once their commands end. ${host} forgets the token after the last one is gone.`
      : `${host} forgets the token.`,
    action: "Remove",
    variant: "danger",
  };
}

/** A project's key in `cloud.json`, as the central host makes it: its
 * origin and root commit. A project with no root commit has none. */
export function projectCloudKey(id: ProjectIdentity): string | null {
  if (!id.root || !/^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(id.root)) return null;
  const origin = id.origin ?? "";
  if (/[\s\p{Cc}]/u.test(origin)) return null;
  return `${origin} ${id.root}`;
}

/** A project's Cloud workers section; `provider` "" is None. */
export interface ProjectCloudDraft {
  overflow: boolean;
  provider: string;
  type: string;
  location: string;
  image: string;
}

export function projectCloudDraft(info: CloudInfo, key: string): ProjectCloudDraft {
  return info.projects[key] ?? { overflow: false, provider: "", type: "", location: "", image: "ubuntu-24.04" };
}

/** The `cloud.set` for what the section changed, or null when nothing did. */
export function projectCloudChange(info: CloudInfo, key: string, d: ProjectCloudDraft): CloudSet | null {
  const was = info.projects[key];
  if (!d.provider) return was ? { projects: { [key]: null } } : null;
  const next = { overflow: d.overflow, provider: d.provider, type: d.type, location: d.location.trim(), image: d.image.trim() };
  const same = was && (Object.keys(next) as (keyof typeof next)[]).every((k) => was[k] === next[k]);
  return same ? null : { projects: { [key]: next } };
}

export function projectCloudErrors(d: ProjectCloudDraft): Partial<Record<"type" | "location" | "image", string>> {
  if (!d.provider) return {};
  const e: ReturnType<typeof projectCloudErrors> = {};
  if (!d.type) e.type = "Pick a machine type.";
  if (!d.location.trim()) e.location = "Name a location, such as fsn1.";
  if (!d.image.trim()) e.image = "Name an image, such as ubuntu-24.04.";
  return e;
}
