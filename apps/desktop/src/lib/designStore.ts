// Design mode's state (X64, X65): each workspace's design systems, from its
// host's daemon, listed again when its design folder changes or a sync
// agent starts or stops waiting for the user.

import { create } from "zustand";
import { onDaemonEvent, onHostStatus, rpc } from "./daemon";
import { EV, M, type ChatState, type DesignChanged, type DesignCover, type DesignSystem, type DesignSystemCreated } from "./protocol";
import { parseWsKey, wsKey } from "./workspaces";

interface DesignState {
  /** By workspace (`wsKey(host, id)`), once listed. */
  systems: Record<string, DesignSystem[]>;
  /** The design system open in each workspace, by slug. */
  shown: Record<string, string>;
}

export const useDesign = create<DesignState>(() => ({ systems: {}, shown: {} }));

/** The design system open in a workspace: the one picked, else the first. */
export function shownSystem(s: DesignState, host: string, workspace: string): DesignSystem | null {
  const list = systemsOf(s, host, workspace) ?? [];
  return list.find((x) => x.slug === s.shown[wsKey(host, workspace)]) ?? list[0] ?? null;
}

/** Opens a design system in Design mode's main area. */
export function showSystem(host: string, workspace: string, slug: string) {
  useDesign.setState((s) => ({ shown: { ...s.shown, [wsKey(host, workspace)]: slug } }));
}

/** A workspace's design systems; undefined until listed. */
export function systemsOf(s: DesignState, host: string, workspace: string): DesignSystem[] | undefined {
  return s.systems[wsKey(host, workspace)];
}

/** The latest request per workspace, so an older answer never lands last. */
const asked: Record<string, number> = {};

export async function loadSystems(host: string, workspace: string): Promise<void> {
  const key = wsKey(host, workspace);
  const n = (asked[key] = (asked[key] ?? 0) + 1);
  const list = await rpc<DesignSystem[]>(host, M.designSystems, { workspace });
  if (asked[key] === n) useDesign.setState((s) => ({ systems: { ...s.systems, [key]: list } }));
}

const reload = (host: string, workspace: string) => void loadSystems(host, workspace).catch(() => {});

/** What each sync agent's chat (`host/id`) last waited for. */
const waiting: Record<string, string> = {};

function onChatState(host: string, id: number, state: ChatState) {
  const asks = state.pending.map((p) => p.id).join(" ");
  const chat = `${host}/${id}`;
  if ((waiting[chat] ?? "") === asks) return;
  waiting[chat] = asks;
  for (const [key, list] of Object.entries(useDesign.getState().systems)) {
    const ws = parseWsKey(key);
    if (ws.host === host && list.some((s) => s.agent === id)) reload(host, ws.id);
  }
}

let started = false;

export async function startDesign() {
  if (started) return;
  started = true;
  await onDaemonEvent((e) => {
    if (e.name === EV.designChanged) {
      const d = e.data as DesignChanged;
      if (systemsOf(useDesign.getState(), e.host, d.workspace)) reload(e.host, d.workspace);
    } else if (e.name === EV.chatState) {
      const d = e.data as { id: number; state: ChatState };
      onChatState(e.host, d.id, d.state);
    }
  });
  await onHostStatus((h) => {
    if (h.status !== "connected") return;
    for (const key of Object.keys(useDesign.getState().systems)) {
      const ws = parseWsKey(key);
      if (ws.host === h.id) reload(h.id, ws.id);
    }
  });
}

export interface NewSystem {
  name: string;
  /** Project ids. */
  projects: string[];
  cover: DesignCover;
}

/** **Build design system**: makes the system and starts its sync agent. */
export async function createSystem(host: string, workspace: string, n: NewSystem): Promise<DesignSystemCreated> {
  const created = await rpc<DesignSystemCreated>(host, M.designSystemCreate, { workspace, name: n.name, sources: n.projects.map((project) => ({ project })), cover: n.cover });
  await loadSystems(host, workspace).catch(() => {});
  return created;
}

/** A project's stack as the dialog shows it ("React · Tailwind"), or "" when moonlet cannot tell. */
export async function detectStack(host: string, workspace: string, path: string): Promise<string> {
  try {
    return (await rpc<string[]>(host, M.designDetect, { workspace, path })).join(" · ");
  } catch {
    return "";
  }
}
