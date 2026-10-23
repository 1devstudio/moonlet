// The central host's cloud machines (X63) on the Workers page and in a
// job waiting for one: state lines, the removed machines, the startup
// checklist. Pure: the components render it.

import { projectCloudKey, providerName, usageLine } from "./cloudSettings";
import type { CloudInfo, CloudMachine, CloudMachines, CloudStep, ProjectIdentity } from "./protocol";

const AT_LIMIT = ": at the limit, so no new one starts";

/** "4 of 4 machines: at the limit, so no new one starts · 12.5 of 40 machine-hours this month". */
export function cloudSummary(c: CloudMachines): string {
  const n = c.machines.length;
  const hours = usageLine(c.hours_this_month, c.max_hours_month);
  const machines = `${n} of ${c.max_machines} machine${c.max_machines === 1 ? "" : "s"}${n >= c.max_machines ? AT_LIMIT : ""}`;
  return `${machines} · ${hours.text}${c.hours_this_month >= c.max_hours_month ? AT_LIMIT : ""}`;
}

/** m:ss of `ms`. */
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export interface MachineLine {
  tone: "done" | "accent" | "muted" | "error";
  text: string;
  /** **Remove now** on an idle machine, **Retry** on a failing removal. */
  action: "remove" | "retry" | null;
}

/** A machine's state line under its name. `sessions` by id. */
export function machineLine(m: CloudMachine, now: number, sessions: Record<string, { name: string; cloud?: boolean }>): MachineLine {
  if (m.state === "removing" && m.error)
    return { tone: "error", text: `Could not remove: ${providerName(m.provider)} answered ${m.error}. Billed until removed.`, action: "retry" };
  if (m.state === "removing") return { tone: "muted", text: "Removing", action: null };
  if (m.state === "creating" || m.state === "starting") {
    const s = m.for_session ? sessions[m.for_session] : undefined;
    const why = s ? ` · for ${s.name}${s.cloud ? ", which asked for the cloud" : ""}` : "";
    return { tone: "accent", text: `Starting · ${clock(now - m.since)}${why}`, action: null };
  }
  if (m.running > 0) return { tone: "done", text: `Running ${m.running} · ${providerName(m.provider)} ${m.type} · ${m.location} · ${m.project}`, action: null };
  const left = m.idle_until != null ? ` · removed in ${Math.max(1, Math.ceil((m.idle_until - now) / 60_000))} min` : "";
  return { tone: "muted", text: `Idle${left}`, action: "remove" };
}

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** "moonlet-shop-4hn0 removed after 15 min idle · 10:42", kept for an hour. */
export function removedLine(m: CloudMachine): string {
  const reason = m.reason ?? "";
  const what = m.state === "failed" ? `failed: ${reason}` : reason.startsWith("removed") ? reason : reason ? `removed: ${reason}` : "removed";
  return `${m.name} ${what} · ${hhmm(m.since)}`;
}

export interface StartupCard {
  name: string;
  /** "cpx41 · fsn1". */
  kind: string;
  steps: { label: string; state: CloudStep["state"]; took: string | null; error: string | null }[];
  /** "Removed if it isn't ready by 10:59.", while it is starting. */
  deadline: string | null;
}

/** The machine card in a job waiting for it: its startup steps and their times. */
export function startupCard(m: CloudMachine): StartupCard {
  const starting = m.state === "creating" || m.state === "starting";
  return {
    name: m.name,
    kind: `${m.type} · ${m.location}`,
    steps: m.steps.map((s) => ({ label: s.label, state: s.state, took: s.took_ms != null ? clock(s.took_ms) : null, error: s.error ?? null })),
    deadline: starting && m.deadline ? `Removed if it isn't ready by ${hhmm(m.deadline)}.` : null,
  };
}

/** Whether the composer offers **Run heavy commands in the cloud**: the
 * project has a cloud setting on its central host (`projects` of `cloud.get`). */
export function cloudOffered(projects: CloudInfo["projects"] | null, identity: ProjectIdentity | null | undefined): boolean {
  const key = identity ? projectCloudKey(identity) : null;
  return !!key && !!projects?.[key];
}

/** Under a waiting job's state line. */
export const waitingNote = (session: string, central: string): string =>
  `${session} runs its heavy commands in the cloud, so this one waits for its machine instead of running on ${central}.`;
