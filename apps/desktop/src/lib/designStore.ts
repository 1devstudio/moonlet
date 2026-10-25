// Design mode's state (X64, X65): each workspace's design systems and
// designs, from its host's daemon, listed again when its design folder
// changes or an agent starts or stops waiting for the user; the design shown,
// its pages' reloads, the page its agent is writing and its check problems.

import { create } from "zustand";
import { onDaemonEvent, onHostStatus, rpc } from "./daemon";
import { EV, M, type ChatState, type Design, type DesignCard, type DesignChanged, type DesignCover, type DesignCreated, type DesignOpen, type DesignSystem, type DesignSystemCreated } from "./protocol";
import { parseWsKey, wsKey } from "./workspaces";
import { syncNotice } from "./designSync";
import { agentSeen, agentsShownElsewhere, notify, shownWorkspace, switchWorkspace, toast, useStore } from "./store";
import { alertFor } from "./alerts";
import { modeOf, setMode } from "./mode";
import { designOpenAction } from "./design";
import { changedPages, reloadsPage } from "./designCanvas";
import type { PageProblem } from "./designBars";

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
  /** Each workspace's designs, once listed (X65). */
  designs: Record<string, Design[]>;
  /** The design shown as the design screen in each workspace, by slug; else its design system. */
  designShown: Record<string, string | null>;
  /** How many times each design page (`wsKey/slug/page`) changed, so its frame loads again. */
  pageRevs: Record<string, number>;
  /** The pages the latest change of each design (`wsKey/slug`) wrote. */
  latest: Record<string, string[]>;
  /** Each design's check problems (`wsKey/slug`), once checked. */
  problems: Record<string, PageProblem[]>;
}

export const useDesign = create<DesignState>(() => ({ systems: {}, shown: {}, cards: {}, opened: {}, changes: {}, designs: {}, designShown: {}, pageRevs: {}, latest: {}, problems: {} }));

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
  useDesign.setState((s) => ({ shown: { ...s.shown, [key]: slug }, opened: { ...s.opened, [key]: null }, designShown: { ...s.designShown, [key]: null } }));
}

const designKey = (host: string, workspace: string, slug: string) => `${wsKey(host, workspace)}/${slug}`;

/** A workspace's designs; undefined until listed (X65). */
export function designsOf(s: DesignState, host: string, workspace: string): Design[] | undefined {
  return s.designs[wsKey(host, workspace)];
}

/** The design shown as the design screen in a workspace, or null. */
export function shownDesign(s: DesignState, host: string, workspace: string): Design | null {
  const slug = s.designShown[wsKey(host, workspace)];
  return (slug && designsOf(s, host, workspace)?.find((d) => d.slug === slug)) || null;
}

/** How many times a design's page changed since the app started. */
export function pageRevOf(s: DesignState, host: string, workspace: string, slug: string, page: string): number {
  return s.pageRevs[`${designKey(host, workspace, slug)}/${page}`] ?? 0;
}

/** The pages the latest change of a design wrote. */
export function latestOf(s: DesignState, host: string, workspace: string, slug: string): string[] {
  return s.latest[designKey(host, workspace, slug)] ?? NONE;
}

/** A design's check problems, every page's. */
export function problemsOf(s: DesignState, host: string, workspace: string, slug: string): PageProblem[] {
  return s.problems[designKey(host, workspace, slug)] ?? NO_PROBLEMS;
}

const NONE: string[] = [];
const NO_PROBLEMS: PageProblem[] = [];

/** Shows a design as the design screen (X65), and its agent as seen. */
export function showDesign(host: string, workspace: string, slug: string) {
  const key = wsKey(host, workspace);
  useDesign.setState((s) => ({ designShown: { ...s.designShown, [key]: slug } }));
  const agent = designsOf(useDesign.getState(), host, workspace)?.find((d) => d.slug === slug)?.agent;
  if (agent !== undefined && agent !== null) agentSeen(host, agent);
  void checkDesign(host, workspace, slug);
}

/** Switches the app to a design: its workspace, Design mode and its screen. */
export async function openDesign(host: string, workspace: string, slug: string) {
  const s = useStore.getState();
  const ws = shownWorkspace(s);
  if (ws?.host !== host || ws.id !== workspace) switchWorkspace({ host, id: workspace });
  setMode("design");
  await loadDesigns(host, workspace).catch(() => {});
  showDesign(host, workspace, slug);
}

/** The latest designs request per workspace, so an older answer never lands last. */
const designsAsked: Record<string, number> = {};

/** Lists a workspace's designs (X65). */
export async function loadDesigns(host: string, workspace: string): Promise<void> {
  const key = wsKey(host, workspace);
  const n = (designsAsked[key] = (designsAsked[key] ?? 0) + 1);
  const list = await rpc<Design[]>(host, M.designList, { workspace });
  if (designsAsked[key] === n) useDesign.setState((s) => ({ designs: { ...s.designs, [key]: list } }));
}

const reloadDesigns = (host: string, workspace: string) => void loadDesigns(host, workspace).catch(() => {});

/** The latest check per design, so an older answer never lands last. */
const checksAsked: Record<string, number> = {};

/** Checks a design's pages (`design.check`), for the canvas's red bar. */
export async function checkDesign(host: string, workspace: string, slug: string): Promise<void> {
  const key = designKey(host, workspace, slug);
  const n = (checksAsked[key] = (checksAsked[key] ?? 0) + 1);
  try {
    const found = await rpc<PageProblem[]>(host, M.designCheck, { workspace, design: slug });
    if (checksAsked[key] === n) useDesign.setState((s) => ({ problems: { ...s.problems, [key]: found } }));
  } catch {
    // A design removed meanwhile, or a page that cannot be read: no bar.
  }
}

/** Checks waiting for a burst of changes to end, per design. */
const checkTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function checkSoon(host: string, workspace: string, slug: string) {
  const key = designKey(host, workspace, slug);
  clearTimeout(checkTimers[key]);
  checkTimers[key] = setTimeout(() => void checkDesign(host, workspace, slug), 300);
}

/** A change in a workspace's design folder: the pages it reloads, the page
 *  a design's agent is writing, and the design's check again. */
function onDesignChange(host: string, change: DesignChanged) {
  const st = useDesign.getState();
  const list = designsOf(st, host, change.workspace) ?? [];
  const revs: Record<string, number> = {};
  for (const d of list) {
    for (const p of d.pages) {
      if (!reloadsPage(change, { design: d.slug, system: d.system, page: p.name })) continue;
      const key = `${designKey(host, change.workspace, d.slug)}/${p.name}`;
      revs[key] = (st.pageRevs[key] ?? 0) + 1;
    }
  }
  // A page new to the list loads once it is listed; one written again before.
  if (change.design) {
    const key = designKey(host, change.workspace, change.design);
    for (const page of changedPages(change, change.design)) {
      const k = `${key}/${page}`;
      revs[k] ??= (st.pageRevs[k] ?? 0) + 1;
    }
    const pages = changedPages(change, change.design);
    useDesign.setState((s) => ({ pageRevs: { ...s.pageRevs, ...revs }, latest: pages.length ? { ...s.latest, [key]: pages } : s.latest }));
    reloadDesigns(host, change.workspace);
    checkSoon(host, change.workspace, change.design);
  } else if (Object.keys(revs).length) {
    useDesign.setState((s) => ({ pageRevs: { ...s.pageRevs, ...revs } }));
  }
}

/** `design.open`: show the design, or offer one an agent started (X65). */
function onDesignOpen(host: string, ev: DesignOpen) {
  const action = designOpenAction(ev, useStore.getState().sessions[host] ?? []);
  const open = () => void openDesign(host, ev.workspace, ev.slug);
  if (action.kind === "show") open();
  else {
    reloadDesigns(host, ev.workspace);
    toast(action.text, "info", { label: "Open", run: open });
  }
}

/** **Create design**: makes the design and starts its agent with the brief (X65). */
export async function createDesign(host: string, workspace: string, n: { name: string; system: string; brief: string }): Promise<DesignCreated> {
  const created = await rpc<DesignCreated>(host, M.designCreate, { workspace, name: n.name, system: n.system, brief: n.brief });
  await loadDesigns(host, workspace).catch(() => {});
  return created;
}

/** Removes a design and stops its agent. */
export async function removeDesign(host: string, workspace: string, slug: string): Promise<void> {
  await rpc(host, M.designRemove, { workspace, slug });
  const key = wsKey(host, workspace);
  useDesign.setState((s) => ({ designShown: s.designShown[key] === slug ? { ...s.designShown, [key]: null } : s.designShown }));
  await loadDesigns(host, workspace).catch(() => {});
}

/** Saves the viewport a design was last shown at in its design.toml. */
export async function saveViewport(host: string, workspace: string, slug: string, viewport: string): Promise<void> {
  await rpc(host, M.designViewport, { workspace, slug, viewport });
  useDesign.setState((s) => {
    const key = wsKey(host, workspace);
    const list = s.designs[key];
    return list ? { designs: { ...s.designs, [key]: list.map((d) => (d.slug === slug ? { ...d, viewport } : d)) } } : {};
  });
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
  // A design's agent's question or approval: its row and bar (X65).
  for (const [key, list] of Object.entries(useDesign.getState().designs)) {
    const ws = parseWsKey(key);
    if (ws.host === host && list.some((d) => d.agent === id)) reloadDesigns(host, ws.id);
  }
}

let started = false;

export async function startDesign() {
  if (started) return;
  started = true;
  await onDaemonEvent((e) => {
    if (e.name === EV.designOpen) onDesignOpen(e.host, e.data as DesignOpen);
    else if (e.name === EV.designChanged) {
      const d = e.data as DesignChanged;
      onDesignChange(e.host, d);
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
  // session notifies even when Design mode was never opened (X64); and its
  // designs, so their agents' notifications and approvals open them (X65).
  const listAll = () => {
    const s = useStore.getState();
    for (const [host, info] of Object.entries(s.hosts)) {
      if (info.status !== "connected") continue;
      for (const w of s.workspaces[host] ?? []) {
        if (wanted.has(wsKey(host, w.id))) continue;
        reload(host, w.id);
        reloadDesigns(host, w.id);
      }
    }
  };
  // A notification or an approval of a design's agent opens its design.
  window.addEventListener("moonlet:open-design", (e) => {
    const d = (e as CustomEvent<{ host: string; workspace: string; slug: string }>).detail;
    void openDesign(d.host, d.workspace, d.slug);
  });
  // A design's agent is on screen while its design screen is shown.
  agentsShownElsewhere.shown = (host, terminal) => {
    const s = useStore.getState();
    const ws = shownWorkspace(s);
    if (!ws || ws.host !== host || modeOf(s) !== "design") return false;
    return shownDesign(useDesign.getState(), host, ws.id)?.agent === terminal;
  };
  useStore.subscribe((s, prev) => {
    if (s.hosts !== prev.hosts || s.workspaces !== prev.workspaces) listAll();
  });
  listAll();
  await onHostStatus((h) => {
    if (h.status !== "connected") return;
    for (const key of wanted) {
      const ws = parseWsKey(key);
      if (ws.host === h.id) {
        reload(h.id, ws.id);
        reloadDesigns(h.id, ws.id);
      }
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
