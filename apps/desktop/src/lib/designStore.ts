// Design mode's state (X64, X65): each workspace's design systems, from its
// host's daemon, listed again when its design folder changes or a sync
// agent starts or stops waiting for the user.

import { create } from "zustand";
import { onDaemonEvent, onHostStatus, rpc } from "./daemon";
import { EV, M, type ChatState, type DesignCard, type DesignChanged, type DesignCover, type DesignSystem, type DesignSystemCreated } from "./protocol";
import { parseWsKey, wsKey } from "./workspaces";
import { syncNotice } from "./designSync";
import { notify, shownWorkspace, useStore } from "./store";
import { alertFor } from "./alerts";
import { modeOf } from "./mode";

interface DesignState {
  /** By workspace (`wsKey(host, id)`), once listed. */
  systems: Record<string, DesignSystem[]>;
  /** The design system open in each workspace, by slug. */
  shown: Record<string, string>;
  /** Each design system's cards (`wsKey/slug`), once listed. */
  cards: Record<string, DesignCard[]>;
  /** The card open as the card page in each workspace: its system and path. */
  opened: Record<string, { slug: string; path: string } | null>;
  /** How many times each design system (`wsKey/slug`) changed, so its frames load again. */
  changes: Record<string, number>;
}

export const useDesign = create<DesignState>(() => ({ systems: {}, shown: {}, cards: {}, opened: {}, changes: {} }));

const systemKey = (host: string, workspace: string, slug: string) => `${wsKey(host, workspace)}/${slug}`;

/** A design system's cards; undefined until listed. */
export function cardsOf(s: DesignState, host: string, workspace: string, slug: string): DesignCard[] | undefined {
  return s.cards[systemKey(host, workspace, slug)];
}

/** The card of design system `slug` open as the card page, or null. */
export function shownCard(s: DesignState, host: string, workspace: string, slug: string): string | null {
  const open = s.opened[wsKey(host, workspace)];
  return open?.slug === slug ? open.path : null;
}

/** Opens a card of `slug` as the card page, or (null) goes back to its design system. */
export function openCard(host: string, workspace: string, slug: string, path: string | null) {
  useDesign.setState((s) => ({ opened: { ...s.opened, [wsKey(host, workspace)]: path === null ? null : { slug, path } } }));
}

/** How many times design system `slug` changed since the app started. */
export function revOf(s: DesignState, host: string, workspace: string, slug: string): number {
  return s.changes[systemKey(host, workspace, slug)] ?? 0;
}

/** Systems whose cards were asked for, listed or not: listed again when they change. */
const cardsWanted = new Set<string>();

/** The latest cards request per system, so an older answer never lands last. */
const cardsAsked: Record<string, number> = {};

export async function loadCards(host: string, workspace: string, slug: string): Promise<void> {
  const key = systemKey(host, workspace, slug);
  cardsWanted.add(key);
  const n = (cardsAsked[key] = (cardsAsked[key] ?? 0) + 1);
  const list = await rpc<DesignCard[]>(host, M.designCards, { workspace, slug });
  if (cardsAsked[key] === n) useDesign.setState((s) => ({ cards: { ...s.cards, [key]: list } }));
}

/** The design system open in a workspace: the one picked, else the first. */
export function shownSystem(s: DesignState, host: string, workspace: string): DesignSystem | null {
  const list = systemsOf(s, host, workspace) ?? [];
  return list.find((x) => x.slug === s.shown[wsKey(host, workspace)]) ?? list[0] ?? null;
}

/** Opens a design system in Design mode's main area. */
export function showSystem(host: string, workspace: string, slug: string) {
  const key = wsKey(host, workspace);
  useDesign.setState((s) => ({ shown: { ...s.shown, [key]: slug }, opened: { ...s.opened, [key]: null } }));
}

/** A workspace's design systems; undefined until listed. */
export function systemsOf(s: DesignState, host: string, workspace: string): DesignSystem[] | undefined {
  return s.systems[wsKey(host, workspace)];
}

/** The latest request per workspace, so an older answer never lands last. */
const asked: Record<string, number> = {};
/** The listing on its way per workspace, shared by everyone asking meanwhile. */
const onTheWay: Record<string, Promise<void>> = {};
/** Workspaces whose systems were asked for, listed or not: a failed listing
 * is asked for again when its host comes back or its folder changes. */
const wanted = new Set<string>();
/** Workspaces where something changed while a listing was on its way, which
 * may have been read before it: they are listed once more after it. */
const stale = new Set<string>();

/** Lists a workspace's design systems. `fresh`: something just changed, so a
 * listing already on its way is followed by one more. */
export function loadSystems(host: string, workspace: string, fresh = false): Promise<void> {
  const key = wsKey(host, workspace);
  wanted.add(key);
  if (fresh && key in onTheWay) stale.add(key);
  return (onTheWay[key] ??= fetchSystems(host, workspace, key).finally(() => {
    delete onTheWay[key];
    if (stale.delete(key)) reload(host, workspace);
  }));
}

async function fetchSystems(host: string, workspace: string, key: string) {
  const n = (asked[key] = (asked[key] ?? 0) + 1);
  const list = await rpc<DesignSystem[]>(host, M.designSystems, { workspace });
  if (asked[key] !== n) return;
  const before = useDesign.getState().systems[key];
  useDesign.setState((s) => ({ systems: { ...s.systems, [key]: list } }));
  // What a sync agent asks, also on a first listing (it still waits), or a
  // sync recorded since the last listing (X65).
  for (const sys of list) {
    const notice = syncNotice(before ? (before.find((b) => b.slug === sys.slug) ?? null) : null, sys);
    if (notice && bannerFor(notice.state, host, workspace, sys.slug)) void notify(notice.title, notice.body);
  }
}

/** Whether a notification goes out, as a session's would (X47): by the
 *  banner settings, and while the window has focus only when asked to and
 *  the design system is not on screen. */
function bannerFor(state: "blocked" | "done", host: string, workspace: string, slug: string): boolean {
  const s = useStore.getState();
  const ws = shownWorkspace(s);
  const visible = modeOf(s) === "design" && ws?.host === host && ws.id === workspace && shownSystem(useDesign.getState(), host, workspace)?.slug === slug;
  return alertFor({ state, focused: document.hasFocus(), visible, settings: s.settings, now: Date.now() }).banner;
}

const reload = (host: string, workspace: string) => void loadSystems(host, workspace, true).catch(() => {});

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
      if (wanted.has(wsKey(e.host, d.workspace))) reload(e.host, d.workspace);
      if (d.system) {
        const key = systemKey(e.host, d.workspace, d.system);
        // Its frames load again, and its cards are listed again when asked for
        // (a newer request always lands last).
        useDesign.setState((s) => ({ changes: { ...s.changes, [key]: (s.changes[key] ?? 0) + 1 } }));
        if (cardsWanted.has(key)) void loadCards(e.host, d.workspace, d.system).catch(() => {});
      }
    } else if (e.name === EV.chatState) {
      const d = e.data as { id: number; state: ChatState };
      onChatState(e.host, d.id, d.state);
    }
  });
  // Every connected workspace's systems are listed, so a sync started from a
  // session notifies even when Design mode was never opened (X64).
  const listAll = () => {
    const s = useStore.getState();
    for (const [host, info] of Object.entries(s.hosts)) {
      if (info.status !== "connected") continue;
      for (const w of s.workspaces[host] ?? []) if (!wanted.has(wsKey(host, w.id))) reload(host, w.id);
    }
  };
  useStore.subscribe((s, prev) => {
    if (s.hosts !== prev.hosts || s.workspaces !== prev.workspaces) listAll();
  });
  listAll();
  await onHostStatus((h) => {
    if (h.status !== "connected") return;
    for (const key of wanted) {
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
