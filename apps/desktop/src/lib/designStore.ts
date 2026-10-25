// Design mode's state (X64, X65): each workspace's design systems and
// designs, from its host's daemon, listed again when its design folder
// changes or an agent starts or stops waiting for the user; the design shown,
// its pages' reloads, the page its agent is writing and its check problems.

import { create } from "zustand";
import { onDaemonEvent, onHostStatus, rpc } from "./daemon";
import { EV, M, type ChatState, type Design, type DesignCard, type CommentChange, type DesignComment, type DesignChanged, type DesignSnapshot, type DesignCover, type DesignCreated, type DesignOpen, type DesignSystem, type DesignSystemCreated } from "./protocol";
import { parseWsKey, wsKey } from "./workspaces";
import { syncNotice } from "./designSync";
import { agentSeen, notify, registerAgentsElsewhere, shownWorkspace, switchWorkspace, toast, useStore } from "./store";
import { alertFor } from "./alerts";
import { modeOf, setMode } from "./mode";
import { latestPerKey } from "./prPoll";
import { latestSends } from "./latestSend";
import { designOpenAction } from "./design";
import { changedPages, reloadsPage } from "./designCanvas";
import { pageOfPath } from "./designPage";
import type { PageProblem } from "./designBars";
import { COMMENTS_FILE, commentsMessage, withMid, withPins, type PageMids } from "./designComments";

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
  /** Every design system's name ever listed (`wsKey/slug`), kept after it is
   *  removed, for the designs still on it. */
  systemNames: Record<string, string>;
  /** Each design's comments (`wsKey/slug`), once listed. */
  comments: Record<string, DesignComment[]>;
  /** The `data-mid`s each page of a design (`wsKey/slug`) reported after it
   *  last loaded on the canvas, by page. */
  mids: Record<string, PageMids>;
  /** The pins of each design (`wsKey/slug`) a Send is on its way with, by number. */
  sending: Record<string, number[]>;
  /** Each design's snapshots (`wsKey/slug`), newest first, once listed. */
  histories: Record<string, DesignSnapshot[]>;
}

export const useDesign = create<DesignState>(() => ({ systems: {}, shown: {}, cards: {}, opened: {}, changes: {}, designs: {}, designShown: {}, pageRevs: {}, latest: {}, problems: {}, systemNames: {}, comments: {}, mids: {}, sending: {}, histories: {} }));

/** A design system's or a design's key, `wsKey/slug`. */
export const itemKey = (host: string, workspace: string, slug: string) => `${wsKey(host, workspace)}/${slug}`;

/** A design page's key, `wsKey/slug/page`. */
export const pageKey = (host: string, workspace: string, slug: string, page: string) => `${itemKey(host, workspace, slug)}/${page}`;

/** The page a key of {@link pageKey} names in design `slug`, or null for
 *  another design's or host's key: its parse. */
export function pageOfKey(host: string, workspace: string, slug: string, key: string): string | null {
  const prefix = `${itemKey(host, workspace, slug)}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/** A design system's cards; undefined until listed. */
export function cardsOf(s: DesignState, host: string, workspace: string, slug: string): DesignCard[] | undefined {
  return s.cards[itemKey(host, workspace, slug)];
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
  return s.changes[itemKey(host, workspace, slug)] ?? 0;
}

/** A list per design system or design (`itemKey`) in `field`, from the
 *  daemon's `method`: the latest answer lands, never an older one, and
 *  `wanted` holds those asked for, listed or not, to list again when they
 *  change. `changed` says the list changed here meanwhile: a listing on its
 *  way may have read before that change, so it is dropped and asked again. */
function itemListing<K extends "cards" | "comments" | "histories">(field: K, method: string) {
  const wanted = new Set<string>();
  const asked = latestPerKey();
  const onTheWay: Record<string, number> = {};
  const load = async (host: string, workspace: string, slug: string): Promise<void> => {
    const key = itemKey(host, workspace, slug);
    wanted.add(key);
    const latest = asked.start(key);
    onTheWay[key] = (onTheWay[key] ?? 0) + 1;
    try {
      const list = await rpc<DesignState[K][string]>(host, method, { workspace, slug });
      if (latest()) useDesign.setState((s) => ({ [field]: { ...s[field], [key]: list } }) as Partial<DesignState>);
    } finally {
      onTheWay[key] -= 1;
    }
  };
  const changed = (host: string, workspace: string, slug: string) => {
    if (onTheWay[itemKey(host, workspace, slug)]) void load(host, workspace, slug).catch(() => {});
  };
  return { load, wanted, changed };
}

const cardListing = itemListing("cards", M.designCards);

/** Lists a design system's cards (X64). */
export function loadCards(host: string, workspace: string, slug: string): Promise<void> {
  return cardListing.load(host, workspace, slug);
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

/** A workspace's designs; undefined until listed (X65). */
export function designsOf(s: DesignState, host: string, workspace: string): Design[] | undefined {
  return s.designs[wsKey(host, workspace)];
}

/** The design shown as the design screen in a workspace, or null. */
export function shownDesign(s: DesignState, host: string, workspace: string): Design | null {
  const slug = s.designShown[wsKey(host, workspace)];
  return (slug && designsOf(s, host, workspace)?.find((d) => d.slug === slug)) || null;
}

/** The visual editor's say over a page changed on disk: true when it
 *  takes the change, deciding itself whether the page loads again. */
export type PageOwner = (host: string, workspace: string, slug: string, page: string) => boolean;

let pageOwner: PageOwner = () => false;

/** The editor (designEditor.ts) says, once it starts, which changed pages
 *  it takes; it is told through this, not imported, as it imports the
 *  store, as Design mode tells the store where its agents are. */
export function registerPageOwner(owner: PageOwner) {
  pageOwner = owner;
}

/** Loads a design's page on the canvas again, as after a change. */
export function reloadPage(host: string, workspace: string, slug: string, page: string) {
  const key = pageKey(host, workspace, slug, page);
  useDesign.setState((s) => ({ pageRevs: { ...s.pageRevs, [key]: (s.pageRevs[key] ?? 0) + 1 } }));
}

/** How many times a design's page changed since the app started. */
export function pageRevOf(s: DesignState, host: string, workspace: string, slug: string, page: string): number {
  return s.pageRevs[pageKey(host, workspace, slug, page)] ?? 0;
}

/** The pages the latest change of a design wrote. */
export function latestOf(s: DesignState, host: string, workspace: string, slug: string): string[] {
  return s.latest[itemKey(host, workspace, slug)] ?? NONE;
}

/** A design's check problems, every page's. */
export function problemsOf(s: DesignState, host: string, workspace: string, slug: string): PageProblem[] {
  return s.problems[itemKey(host, workspace, slug)] ?? NO_PROBLEMS;
}

const NONE: string[] = [];
const NO_PROBLEMS: PageProblem[] = [];
const NO_COMMENTS: DesignComment[] = [];
const NO_MIDS: PageMids = {};

/** A design's comments, by number; none until listed. */
/** A design's snapshots, newest first; undefined until listed. */
export function historyOf(s: DesignState, host: string, workspace: string, slug: string): DesignSnapshot[] | undefined {
  return s.histories[itemKey(host, workspace, slug)];
}

const historyListing = itemListing("histories", M.designHistory);

/** Lists a design's snapshots (X65), and again as each is taken. */
export function loadHistory(host: string, workspace: string, slug: string): Promise<void> {
  return historyListing.load(host, workspace, slug);
}

/** A file of a design's snapshots: under `history/`. */
const isHistoryPath = (path: string) => path.startsWith("history/");

export function commentsOf(s: DesignState, host: string, workspace: string, slug: string): DesignComment[] {
  return s.comments[itemKey(host, workspace, slug)] ?? NO_COMMENTS;
}

/** The `data-mid`s of a design's pages, from their last load on the canvas. */
export function midsOf(s: DesignState, host: string, workspace: string, slug: string): PageMids {
  return s.mids[itemKey(host, workspace, slug)] ?? NO_MIDS;
}

const NOT_SENDING: number[] = [];

/** The pins of a design a Send is on its way with, by number: their Send
 *  is off until it is done. */
export function sendingOf(s: DesignState, host: string, workspace: string, slug: string): number[] {
  return s.sending[itemKey(host, workspace, slug)] ?? NOT_SENDING;
}

/** Records the `data-mid`s a page reported after it loaded (the bridge's). */
export function setPageMids(host: string, workspace: string, slug: string, page: string, mids: string[]) {
  const key = itemKey(host, workspace, slug);
  useDesign.setState((s) => ({ mids: { ...s.mids, [key]: { ...s.mids[key], [page]: mids } } }));
}

/** Records an element the user picked on a page as there (withMid): the
 *  page may have added it after its last report. */
export function addPageMid(host: string, workspace: string, slug: string, page: string, mid: string) {
  const key = itemKey(host, workspace, slug);
  useDesign.setState((s) => ({ mids: { ...s.mids, [key]: { ...s.mids[key], [page]: withMid(s.mids[key]?.[page], mid) } } }));
}

const commentListing = itemListing("comments", M.designComments);

/** Lists a design's comments (X65). */
export function loadComments(host: string, workspace: string, slug: string): Promise<void> {
  return commentListing.load(host, workspace, slug);
}

/** Puts the pins the daemon gave back in the design's list at once, so the
 *  box, the pins and the tab follow without waiting: the change's
 *  design.changed, which lists them all again, comes 150 ms or more later.
 *  A listing still on its way may have read before the change, so it is
 *  asked again, never left to land over the change. */
function mergePins(host: string, workspace: string, slug: string, pins: DesignComment[]) {
  const key = itemKey(host, workspace, slug);
  useDesign.setState((s) => ({ comments: { ...s.comments, [key]: withPins(s.comments[key] ?? [], pins) } }));
  commentListing.changed(host, workspace, slug);
}

/** `design.comment.put` with one change, its pins merged at once. */
async function changeComments(host: string, workspace: string, slug: string, change: CommentChange): Promise<DesignComment[]> {
  const pins = await rpc<DesignComment[]>(host, M.designCommentPut, { workspace, slug, ...change });
  mergePins(host, workspace, slug, pins);
  return pins;
}

/** A new pin's element and comment. */
export interface NewComment {
  page: string;
  mid: string;
  tag: string;
  text: string;
  comment: string;
}

/** **Keep**: saves a new pin, not sent. */
export async function keepComment(host: string, workspace: string, slug: string, c: NewComment): Promise<DesignComment> {
  const [pin] = await changeComments(host, workspace, slug, { new: c });
  return pin;
}

/** Changes a kept pin's comment; a changed one is not sent any more. */
export async function editComment(host: string, workspace: string, slug: string, n: number, comment: string): Promise<DesignComment> {
  const [pin] = await changeComments(host, workspace, slug, { edit: { n, comment } });
  return pin;
}

/** **Send** and **Send all**: the pins go to the design's agent as one
 *  message, one line each (by `ask`, which may put more before them), and
 *  only then are they marked sent. A pin a
 *  Send is already on its way with is left out, so a second click never
 *  sends it twice. */
export async function sendComments(host: string, workspace: string, slug: string, agent: number, pins: DesignComment[], ask: (text: string) => Promise<void> = (text) => askAgent(host, agent, text)): Promise<void> {
  const key = itemKey(host, workspace, slug);
  const busy = new Set(sendingOf(useDesign.getState(), host, workspace, slug));
  const going = pins.filter((p) => !busy.has(p.n));
  if (!going.length) return;
  const ns = going.map((p) => p.n);
  useDesign.setState((s) => ({ sending: { ...s.sending, [key]: [...(s.sending[key] ?? []), ...ns].sort((a, b) => a - b) } }));
  try {
    await ask(commentsMessage(going));
    // Each with the comment sent: one edited meanwhile is not marked sent.
    await changeComments(host, workspace, slug, { sent: { pins: going.map((p) => ({ n: p.n, comment: p.comment })) } });
  } finally {
    useDesign.setState((s) => ({ sending: { ...s.sending, [key]: (s.sending[key] ?? []).filter((n) => !ns.includes(n)) } }));
  }
}

/** **Resolve**: the pin is done. */
export async function resolveComment(host: string, workspace: string, slug: string, n: number): Promise<void> {
  mergePins(host, workspace, slug, [await rpc<DesignComment>(host, M.designCommentResolve, { workspace, slug, n })]);
}

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
  await loadDesigns(host, workspace, true).catch(() => {});
  showDesign(host, workspace, slug);
}

/** A listing per workspace (`wsKey`), as the design systems' and the
 *  designs' are: one request on its way at a time, shared by everyone asking
 *  meanwhile; `fresh` (something just changed) follows one on its way with
 *  one more, as it may have read before the change. `wanted` holds the
 *  workspaces asked for, listed or not, so a failed listing is asked for
 *  again when the host comes back or the folder changes. */
function listing(fetch: (host: string, workspace: string, key: string) => Promise<void>) {
  const onTheWay: Record<string, Promise<void>> = {};
  const stale = new Set<string>();
  const wanted = new Set<string>();
  const load = (host: string, workspace: string, fresh = false): Promise<void> => {
    const key = wsKey(host, workspace);
    wanted.add(key);
    if (fresh && key in onTheWay) stale.add(key);
    return (onTheWay[key] ??= fetch(host, workspace, key).finally(() => {
      delete onTheWay[key];
      if (stale.delete(key)) void load(host, workspace, true).catch(() => {});
    }));
  };
  return { load, wanted, reload: (host: string, workspace: string) => void load(host, workspace, true).catch(() => {}) };
}

const designListing = listing(async (host, workspace, key) => {
  const list = withPickedViewports(host, workspace, await rpc<Design[]>(host, M.designList, { workspace }));
  useDesign.setState((s) => ({ designs: { ...s.designs, [key]: list } }));
});

/** Lists a workspace's designs (X65). `fresh`: something just changed. */
export function loadDesigns(host: string, workspace: string, fresh = false): Promise<void> {
  return designListing.load(host, workspace, fresh);
}

const reloadDesigns = designListing.reload;

/** The latest check per design, so an older answer never lands last. */
const checksAsked = latestPerKey();

/** Checks a design's pages (`design.check`), for the canvas's red bar. A
 *  check that fails clears the earlier problems, which may no longer be the
 *  pages': the bar has no colour for a check that could not run. */
export async function checkDesign(host: string, workspace: string, slug: string): Promise<void> {
  const key = itemKey(host, workspace, slug);
  const latest = checksAsked.start(key);
  let found: PageProblem[];
  try {
    found = await rpc<PageProblem[]>(host, M.designCheck, { workspace, design: slug });
  } catch {
    // A design removed meanwhile, or a page that cannot be read: no bar.
    found = NO_PROBLEMS;
  }
  if (latest()) useDesign.setState((s) => ({ problems: { ...s.problems, [key]: found } }));
}

/** How long a design's files stay unchanged before it is checked again: an
 *  agent writes a page in a burst of saves. */
const CHECK_SETTLE_MS = 300;

/** Checks waiting for a burst of changes to end, per design. */
const checkTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function checkSoon(host: string, workspace: string, slug: string) {
  const key = itemKey(host, workspace, slug);
  clearTimeout(checkTimers[key]);
  checkTimers[key] = setTimeout(() => {
    delete checkTimers[key];
    void checkDesign(host, workspace, slug);
  }, CHECK_SETTLE_MS);
}

/** A change in a workspace's design folder: the pages it reloads, the page
 *  a design's agent is writing, and the design's check again. */
function onDesignChange(host: string, change: DesignChanged) {
  const st = useDesign.getState();
  const list = designsOf(st, host, change.workspace) ?? [];
  const revs: Record<string, number> = {};
  // A page the editor has read decides itself whether it loads again: not
  // for the editor's own save (designEditor.ts). Only when nothing but
  // pages changed: an asset changed loads every page.
  // A snapshot taken with the change (history/) is none of its pages.
  const pagesOnly = change.design !== null && change.paths.filter((p) => !isHistoryPath(p)).every((p) => pageOfPath(p) !== null);
  const owned = new Set(pagesOnly ? changedPages(change, change.design!).filter((page) => pageOwner(host, change.workspace, change.design!, page)) : []);
  const bump = (key: string, design: string, page: string) => {
    if (design !== change.design || !owned.has(page)) revs[key] ??= (st.pageRevs[key] ?? 0) + 1;
  };
  for (const d of list) {
    for (const p of d.pages) if (reloadsPage(change, { design: d.slug, system: d.system, page: p.name })) bump(pageKey(host, change.workspace, d.slug, p.name), d.slug, p.name);
  }
  if (change.design) {
    const key = itemKey(host, change.workspace, change.design);
    // A page not listed yet loads once it is: written again before that.
    const pages = changedPages(change, change.design);
    for (const page of pages) bump(pageKey(host, change.workspace, change.design, page), change.design, page);
    useDesign.setState((s) => ({ pageRevs: { ...s.pageRevs, ...revs }, latest: pages.length ? { ...s.latest, [key]: pages } : s.latest }));
    reloadDesigns(host, change.workspace);
    checkSoon(host, change.workspace, change.design);
    // Its comments, kept, sent or resolved here or written by its agent.
    if (commentListing.wanted.has(key) && change.paths.includes(COMMENTS_FILE)) void loadComments(host, change.workspace, change.design).catch(() => {});
    // Its snapshots, as the daemon takes or restores one.
    if (historyListing.wanted.has(key) && change.paths.some(isHistoryPath)) void loadHistory(host, change.workspace, change.design).catch(() => {});
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
  await loadDesigns(host, workspace, true).catch(() => {});
  return created;
}

/** **Create design** in the New design dialog (X65): makes the design, then
 *  shows it and closes the dialog while that dialog is still the one open.
 *  Dismissed meanwhile, the design is still made, but the view and any
 *  dialog opened since stay as they are; a toast offers the design. */
export async function createFromNewDesign(host: string, workspace: string, n: { name: string; system: string; brief: string }): Promise<DesignCreated> {
  const dialog = useStore.getState().dialog;
  const made = await createDesign(host, workspace, n);
  if (dialog?.kind === "new-design" && useStore.getState().dialog === dialog) {
    showDesign(host, workspace, made.slug);
    useStore.setState({ dialog: null });
  } else {
    toast(`${made.name} was made`, "info", { label: "Open", run: () => void openDesign(host, workspace, made.slug) });
  }
  if (made.agent_error) toast(`${made.name} was made, but its agent did not start: ${made.agent_error}`, "error");
  return made;
}

/** Removes a design and stops its agent. */
export async function removeDesign(host: string, workspace: string, slug: string): Promise<void> {
  await rpc(host, M.designRemove, { workspace, slug });
  const key = wsKey(host, workspace);
  useDesign.setState((s) => ({ designShown: s.designShown[key] === slug ? { ...s.designShown, [key]: null } : s.designShown }));
  const timer = itemKey(host, workspace, slug);
  clearTimeout(checkTimers[timer]);
  delete checkTimers[timer];
  await loadDesigns(host, workspace, true).catch(() => {});
}

/** Stops what a Design mode agent is doing: Stop and Stop sync. */
export async function stopAgent(host: string, agent: number): Promise<void> {
  await rpc(host, M.chatInterrupt, { id: agent });
}

/** Sends a Design mode agent a message: Ask the agent to fix. */
export async function askAgent(host: string, agent: number, text: string): Promise<void> {
  await rpc(host, M.chatSend, { id: agent, text, images: [] });
}

/** Opens New design for a workspace (X65): the sidebar's button and ⇧⌘N. */
export function openNewDesign(ws: { host: string; id: string }) {
  useStore.setState({ dialog: { kind: "new-design", host: ws.host, workspace: ws.id } });
}

/** The viewport picked last per design (`itemKey`) while it is not saved:
 *  shown, and laid over a listing that comes back meanwhile. */
const pickedViewports: Record<string, string> = {};
/** The viewport saves of each design, one at a time, the latest pick last. */
const viewportSaves = latestSends();

/** Shows `viewport` as the design's, in its listing. */
function showViewport(host: string, workspace: string, slug: string, viewport: string) {
  useDesign.setState((s) => {
    const key = wsKey(host, workspace);
    const list = s.designs[key];
    return list ? { designs: { ...s.designs, [key]: list.map((d) => (d.slug === slug ? { ...d, viewport } : d)) } } : {};
  });
}

/** A listing with each design's picked, not yet saved, viewport. */
function withPickedViewports(host: string, workspace: string, list: Design[]): Design[] {
  return list.map((d) => {
    const picked = pickedViewports[itemKey(host, workspace, d.slug)];
    return picked ? { ...d, viewport: picked } : d;
  });
}

/** Saves the viewport a design was last shown at in its design.toml. It
 *  shows at once; saves of one design go one at a time, and a pick made
 *  while one is on its way is saved after it, so the latest pick is what
 *  shows and what is kept. A failed save leaves the pick shown. */
export async function saveViewport(host: string, workspace: string, slug: string, viewport: string): Promise<void> {
  const key = itemKey(host, workspace, slug);
  pickedViewports[key] = viewport;
  showViewport(host, workspace, slug, viewport);
  let sent = viewport;
  await viewportSaves.send(key, async () => {
    sent = pickedViewports[key];
    await rpc(host, M.designViewport, { workspace, slug, viewport: sent });
  });
  if (!viewportSaves.busy(key) && pickedViewports[key] === sent) delete pickedViewports[key];
}

/** A design system's name, also after it was removed; null when never listed. */
export function systemNameOf(s: DesignState, host: string, workspace: string, slug: string): string | null {
  return s.systemNames[itemKey(host, workspace, slug)] ?? null;
}

/** A workspace's design systems; undefined until listed. */
export function systemsOf(s: DesignState, host: string, workspace: string): DesignSystem[] | undefined {
  return s.systems[wsKey(host, workspace)];
}

const systemListing = listing(async (host, workspace, key) => {
  const list = await rpc<DesignSystem[]>(host, M.designSystems, { workspace });
  const before = useDesign.getState().systems[key];
  useDesign.setState((s) => ({
    systems: { ...s.systems, [key]: list },
    systemNames: { ...s.systemNames, ...Object.fromEntries(list.map((x) => [itemKey(host, workspace, x.slug), x.name])) },
  }));
  // What a sync agent asks, also on a first listing (it still waits), or a
  // sync recorded since the last listing (X65).
  for (const sys of list) {
    const notice = syncNotice(before ? (before.find((b) => b.slug === sys.slug) ?? null) : null, sys);
    if (notice && bannerFor(notice.state, host, workspace, sys.slug)) void notify(notice.title, notice.body);
  }
});

/** Lists a workspace's design systems. `fresh`: something just changed, so a
 * listing already on its way is followed by one more. */
export function loadSystems(host: string, workspace: string, fresh = false): Promise<void> {
  return systemListing.load(host, workspace, fresh);
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

const reload = systemListing.reload;

/** What each sync agent's chat (`host/id`) last waited for. */
const waiting: Record<string, string> = {};

function onChatState(host: string, id: number, state: ChatState) {
  const asks = state.pending.map((p) => p.id).join(" ");
  const chat = `${host}/${id}`;
  if ((waiting[chat] ?? "") === asks) return;
  waiting[chat] = asks;
  // A sync agent's (X64) or a design's agent's (X65): its row, view and bar.
  const { systems, designs } = useDesign.getState();
  const lists: [Record<string, { agent: number | null }[]>, (host: string, workspace: string) => void][] = [
    [systems, reload],
    [designs, reloadDesigns],
  ];
  for (const [byWorkspace, again] of lists) {
    for (const [key, list] of Object.entries(byWorkspace)) {
      const ws = parseWsKey(key);
      if (ws.host === host && list.some((x) => x.agent === id)) again(host, ws.id);
    }
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
      if (systemListing.wanted.has(wsKey(e.host, d.workspace))) reload(e.host, d.workspace);
      if (d.system) {
        const key = itemKey(e.host, d.workspace, d.system);
        // Its frames load again, and its cards are listed again when asked for
        // (a newer request always lands last).
        useDesign.setState((s) => ({ changes: { ...s.changes, [key]: (s.changes[key] ?? 0) + 1 } }));
        if (cardListing.wanted.has(key)) void loadCards(e.host, d.workspace, d.system).catch(() => {});
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
        if (!systemListing.wanted.has(wsKey(host, w.id))) reload(host, w.id);
        if (!designListing.wanted.has(wsKey(host, w.id))) reloadDesigns(host, w.id);
      }
    }
  };
  // A design's agent is on screen while its design screen is shown, and a
  // notification or an approval of it opens its design.
  registerAgentsElsewhere({
    shown: (host, terminal) => {
      const s = useStore.getState();
      const ws = shownWorkspace(s);
      if (!ws || ws.host !== host || modeOf(s) !== "design") return false;
      return shownDesign(useDesign.getState(), host, ws.id)?.agent === terminal;
    },
    open: (host, d) => void openDesign(host, d.workspace, d.slug),
  });
  useStore.subscribe((s, prev) => {
    if (s.hosts !== prev.hosts || s.workspaces !== prev.workspaces) listAll();
  });
  listAll();
  await onHostStatus((h) => {
    if (h.status !== "connected") return;
    for (const { wanted, reload: again } of [systemListing, designListing]) {
      for (const key of wanted) {
        const ws = parseWsKey(key);
        if (ws.host === h.id) again(h.id, ws.id);
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
