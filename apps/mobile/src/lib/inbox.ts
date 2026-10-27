// The Inbox (X40): what needs the user across every connected host.

import { planOf } from "@desktop/lib/chat";
import { askerName } from "@desktop/lib/subagents";
import type { AgentState, HostStatus, PermissionAsk, ReadRequest, Session } from "@desktop/lib/protocol";
import type { WorkspaceRef } from "@desktop/lib/workspaces";
import type { HostData } from "./app";
import { inShown } from "./workspaceChoices";

export type CardKind = "permission" | "plan" | "question" | "read" | "setup";

/** A copy's setup waiting for the user's approval on a Mac (X60, X62). */
export interface SetupAsk {
  copy: string;
  /** The exact command, as `sync.run_setup` must name it. */
  command: string;
  message: string;
}

export interface InboxCard {
  kind: CardKind;
  key: string;
  host: string;
  hostLabel: string;
  /** Reached through a Mac over SSH. */
  remote: boolean;
  /** The chat terminal that asks, or the terminal that wants to read. */
  terminal: number;
  session: Session | null;
  /** The session's name, else the terminal's title. */
  title: string;
  project: string | null;
  agent: string | null;
  askedAt: number | null;
  ask?: PermissionAsk;
  /** The subagent that asks (X42); null for the main agent. */
  asker?: string | null;
  read?: ReadRequest;
  setup?: SetupAsk;
}

export interface InboxHost {
  id: string;
  label: string;
  status: HostStatus;
  via: string | null;
}

export interface Inbox {
  needs: InboxCard[];
  /** Sessions whose agent is working. */
  working: number;
  /** Connected hosts, whatever the workspace. */
  hostsOnline: number;
}

/** A session's agent state: the most urgent of its agent terminals'. */
export function sessionState(d: HostData, s: Session): AgentState {
  const states = Object.values(d.terminals)
    .filter((t) => t.session_id === s.id && (t.kind === "agent" || t.chat))
    .map((t) => t.agent_state);
  for (const st of ["blocked", "error", "working", "done"] as const) if (states.includes(st)) return st;
  return "idle";
}

/** The session on `host` belongs to the workspace shown, on any member of
 * its account (X68). An agent without a session shows in every workspace. */
export function inWorkspace(host: string, d: HostData, s: Session | null, shown: WorkspaceRef | null): boolean {
  return !s || inShown(shown, host, d.account, s.workspace_id ?? "");
}

function kindOf(ask: PermissionAsk): CardKind {
  if (planOf(ask)) return "plan";
  if (ask.tool === "AskUserQuestion") return "question";
  return "permission";
}

export function buildInbox(hosts: Record<string, InboxHost>, data: Record<string, HostData>, shown: WorkspaceRef | null): Inbox {
  const needs: InboxCard[] = [];
  let working = 0;
  let hostsOnline = 0;
  for (const h of Object.values(hosts)) {
    const d = data[h.id];
    if (h.status !== "connected" || !d) continue;
    hostsOnline++;
    for (const s of d.sessions) {
      if (s.archived || !inWorkspace(h.id, d, s, shown)) continue;
      if (sessionState(d, s) === "working") working++;
    }
    const sessionOf = (id?: string | null) => d.sessions.find((s) => s.id === id) ?? null;
    const base = (terminal: number, s: Session | null) => ({
      host: h.id,
      hostLabel: h.label,
      remote: !!h.via,
      terminal,
      session: s,
      title: s?.name ?? d.terminals[terminal]?.title ?? "Agent",
      project: d.projects.find((p) => p.id === s?.project_id)?.name ?? null,
      agent: d.terminals[terminal]?.agent ?? null,
    });
    for (const [id, st] of Object.entries(d.chats)) {
      const t = Number(id);
      const s = sessionOf(d.terminals[t]?.session_id);
      if (!inWorkspace(h.id, d, s, shown)) continue;
      for (const ask of st.pending) {
        needs.push({ ...base(t, s), kind: kindOf(ask), key: `${h.id}:${t}:${ask.id}`, askedAt: ask.asked_at ?? null, ask, asker: askerName(ask, st.subagents ?? []) });
      }
    }
    for (const r of d.reads) {
      const s = sessionOf(r.session_id);
      if (!inWorkspace(h.id, d, s, shown)) continue;
      needs.push({ ...base(r.caller, s), kind: "read", key: `${h.id}:read:${r.request_id}`, askedAt: r.asked_at ?? null, read: r });
    }
  }
  needs.push(...setupCards(hosts, data));
  needs.sort((a, b) => (b.askedAt ?? 0) - (a.askedAt ?? 0));
  return { needs, working, hostsOnline };
}

/** Every copy's setup waiting on a connected Mac, live copies (X60) and
 * routing copies (X62). A copy belongs to no workspace on its Mac. A live
 * copy's session is named from its central host, while that is connected. */
function setupCards(hosts: Record<string, InboxHost>, data: Record<string, HostData>): InboxCard[] {
  const out: InboxCard[] = [];
  const card = (h: InboxHost, title: string, project: string | null, ask: Omit<SetupAsk, "message">, where: string): InboxCard => ({
    kind: "setup",
    key: `${h.id}:setup:${ask.copy}`,
    host: h.id,
    hostLabel: h.label,
    remote: !!h.via,
    terminal: 0,
    session: null,
    title,
    project,
    agent: null,
    askedAt: null,
    setup: { ...ask, message: `Run ${project ?? "the project"}'s setup in ${where} on ${h.label}? (from .moonlet/config.toml)` },
  });
  for (const h of Object.values(hosts)) {
    const d = data[h.id];
    if (h.status !== "connected" || !d) continue;
    for (const c of d.copies) {
      if (c.setup?.state.kind !== "needs_approval") continue;
      // A copy names its central host as the Mac knows it, which is the name
      // the phone paired with it under; the phone's host ids are device ids.
      const central = Object.values(hosts).find((x) => x.label === c.host && x.status === "connected");
      const s = central && data[central.id]?.sessions.find((x) => x.id === c.session);
      const project = (s && data[central.id].projects.find((p) => p.id === s.project_id)?.name) ?? null;
      out.push(card(h, s?.name ?? "The session", project, { copy: c.id, command: c.setup.command }, "the copy"));
    }
    for (const a of d.setups) {
      const project = a.project || null;
      out.push(card(h, `${project ?? "The project"}'s routing copy`, project, { copy: a.copy, command: a.command }, "its routing copy"));
    }
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `3 need you · 2 working · 2 hosts online` */
export function summaryLine(i: Inbox): string {
  const parts = [
    i.needs.length ? `${i.needs.length} need you` : "",
    i.working ? `${i.working} working` : "",
    `${plural(i.hostsOnline, "host")} online`,
  ];
  return parts.filter(Boolean).join(" · ");
}
