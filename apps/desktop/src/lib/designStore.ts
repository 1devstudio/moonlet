// Design mode's state (X64, X65): each workspace's design systems and
// designs, from its host's daemon, listed again when its design folder
// changes or an agent starts or stops waiting for the user; the design shown,
// its pages' reloads, the page its agent is writing and its check problems.

import { create } from "zustand";
import { onDaemonEvent, onHostStatus, rpc } from "./daemon";
import { EV, M, type ChatState, type Design, type DesignCard, type CommentChange, type DesignComment, type DesignChanged, type DesignSnapshot, type DesignCover, type DesignCreated, type DesignOpen, type DesignSystem, type DesignSystemCreated, type DesignSystemUpdated } from "./protocol";
import { parseWsKey, wsKey } from "./workspaces";
import { syncNotice } from "./designSync";
import { agentSeen, errorMessage, notify, registerAgentsElsewhere, selectSession, shownWorkspace, switchWorkspace, toast, useStore } from "./store";
import { alertFor } from "./alerts";
import { modeOf, setMode } from "./mode";
import { latestPerKey } from "./prPoll";
import { latestSends } from "./latestSend";
import { designOpenAction, isDesignModeChange, workspaceDesigns } from "./design";
import { changedPages, changesOwnSystem, reloadsPage } from "./designCanvas";
import { changesBuilt } from "./designBuild";
import { pageOfPath } from "./designPage";
import type { PageProblem } from "./designBars";
import { COMMENTS_FILE, commentsMessage, withMid, withPins, type PageMids } from "./designComments";
import { cardsReloaded } from "./designView";
import { changePlace, designRef, isSession, placeOfDesign, type DesignPlace } from "./designPlace";

interface DesignState {
  /** By workspace (`wsKey(host, id)`), once listed. */
  systems: Record<string, DesignSystem[]>;
  /** The design system open in each workspace, by slug. */
  shown: Record<string, string>;
  /** Each design system's cards (`wsKey/slug`), once listed. */
  cards: Record<string, DesignCard[]>;
  /** The card open as the card page in each workspace: its system and path. */
  opened: Record<string, { slug: string; path: string } | null>;
  /** How many times each design system (`wsKey/slug`) changed, and each
   *  session design's own copy of its design system (`itemKey`), so a
   *  design's kit is read again (X65). */
  changes: Record<string, number>;
  /** How many times each design system's cards (`wsKey/slug`) loaded again:
   *  all of them, and each one by its path (X64). */
  cardRevs: Record<string, { all: number; cards: Record<string, number> }>;
  /** Each workspace's designs, once listed (X65): its workspace designs,
   *  which Design mode shows. */
  designs: Record<string, Design[]>;
  /** Each workspace's session designs (`wsKey`), once listed (X65), which
   *  their sessions' Design tabs show. */
  sessionDesigns: Record<string, Design[]>;
  /** Each workspace's project designs (`wsKey`), once listed (X65), which
   *  the Designs index shows. */
  projectDesigns: Record<string, Design[]>;
  /** The workspaces (`wsKey`) whose Design mode shows the Designs index. */
  indexShown: Record<string, boolean>;
  /** The design each session's Design tab shows (its place key), by slug. */
  sessionShown: Record<string, string>;
  /** The sessions (place keys) whose Design tab the app just opened itself,
   *  until the tab's canvas takes it: its keys work at once. */
  tabOpened: string[];
  /** The designs an agent started from a session that the user has not
   *  seen yet (`itemKey`), for the Design button's accent dot (X65). */
  unseen: string[];
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
  /** How many times each session design's built screenshots (`itemKey`)
   *  changed, so Design and build looks for them again (X65). */
  builtRevs: Record<string, number>;
  /** Each design's snapshots (`wsKey/slug`), newest first, once listed. */
  histories: Record<string, DesignSnapshot[]>;
}

export const useDesign = create<DesignState>(() => ({ systems: {}, shown: {}, cards: {}, opened: {}, changes: {}, cardRevs: {}, designs: {}, sessionDesigns: {}, projectDesigns: {}, indexShown: {}, builtRevs: {}, sessionShown: {}, tabOpened: [], unseen: [], designShown: {}, pageRevs: {}, latest: {}, problems: {}, systemNames: {}, comments: {}, mids: {}, sending: {}, histories: {} }));

/** A place's key: a workspace's `wsKey`, a session's `host/s:<session>`,
 *  so a session design never shares a workspace design's state (X65). */
const placeKey = (host: string, place: DesignPlace) => (isSession(place) ? `${host}/s:${place.session}` : wsKey(host, place));

/** A design system's or a design's key, `<place key>/slug`: a design
 *  system's place is its workspace. */
export const itemKey = (host: string, place: DesignPlace, slug: string) => `${placeKey(host, place)}/${slug}`;

/** The key a design's canvas is shown under, the design screen's and a
 *  session's Design tab's: its place and slug, as {@link itemKey}, so a
 *  design of the same slug in another session or workspace is another
 *  canvas, its comment box, snapshot previewed and selection afresh. */
export const designCanvasKey = itemKey;

/** A design page's key, `<place key>/slug/page`. */
export const pageKey = (host: string, place: DesignPlace, slug: string, page: string) => `${itemKey(host, place, slug)}/${page}`;

/** The place key a key of {@link itemKey} is under: its parse (a slug has
 *  no `/`). */
const placeKeyOfItem = (key: string) => key.slice(0, key.lastIndexOf("/"));

/** The page a key of {@link pageKey} names in design `slug`, or null for
 *  another design's or host's key: its parse. */
export function pageOfKey(host: string, place: DesignPlace, slug: string, key: string): string | null {
  const prefix = `${itemKey(host, place, slug)}/`;
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

/** How many times card `path` of design system `slug` was to load again:
 *  after a change to what every card loads, or to its own page (X64). */
export function cardRevOf(s: DesignState, host: string, workspace: string, slug: string, path: string): number {
  return cardRev(cardRevsOf(s, host, workspace, slug), path);
}

/** How many times design system `slug`'s cards were to load again, as the
 *  store keeps it: one object until the next time (for a selector). */
export type CardRevs = DesignState["cardRevs"][string] | undefined;
export function cardRevsOf(s: DesignState, host: string, workspace: string, slug: string): CardRevs {
  return s.cardRevs[itemKey(host, workspace, slug)];
}

/** Card `path`'s count in `revs`. */
export function cardRev(revs: CardRevs, path: string): number {
  return revs ? revs.all + (revs.cards[path] ?? 0) : 0;
}

/** How many times the design system a design's kit is read from changed:
 *  a workspace design's, design system `system`; a session design's, its
 *  own copy (X65). */
export function kitRevOf(s: DesignState, host: string, place: DesignPlace, slug: string, system: string): number {
  return isSession(place) ? (s.changes[itemKey(host, place, slug)] ?? 0) : revOf(s, host, place, system);
}

/** How many times a session design's built screenshots changed since the
 *  app started (X65). */
export function builtRevOf(s: DesignState, host: string, place: DesignPlace, slug: string): number {
  return s.builtRevs[itemKey(host, place, slug)] ?? 0;
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
  const load = async (host: string, place: DesignPlace, slug: string): Promise<void> => {
    const key = itemKey(host, place, slug);
    wanted.add(key);
    const latest = asked.start(key);
    onTheWay[key] = (onTheWay[key] ?? 0) + 1;
    try {
      const list = await rpc<DesignState[K][string]>(host, method, designRef(place, slug));
      if (latest()) useDesign.setState((s) => ({ [field]: { ...s[field], [key]: list } }) as Partial<DesignState>);
    } finally {
      onTheWay[key] -= 1;
    }
  };
  const changed = (host: string, place: DesignPlace, slug: string) => {
    if (onTheWay[itemKey(host, place, slug)]) void load(host, place, slug).catch(() => {});
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
  useDesign.setState((s) => ({ shown: { ...s.shown, [key]: slug }, opened: { ...s.opened, [key]: null }, designShown: { ...s.designShown, [key]: null }, indexShown: { ...s.indexShown, [key]: false } }));
}

/** Shows the Designs index in Design mode's main area (X65). */
export function showIndex(host: string, workspace: string) {
  const key = wsKey(host, workspace);
  useDesign.setState((s) => ({ designShown: { ...s.designShown, [key]: null }, indexShown: { ...s.indexShown, [key]: true } }));
}

/** Whether a workspace's Design mode shows the Designs index. */
export function indexShownIn(s: DesignState, host: string, workspace: string): boolean {
  return !!s.indexShown[wsKey(host, workspace)];
}

/** A workspace's project designs (X65); undefined until listed. */
export function projectDesignsIn(s: DesignState, host: string, workspace: string): Design[] | undefined {
  return s.projectDesigns[wsKey(host, workspace)];
}

/** **Use as a start** (X65): a project design copied into a new workspace
 *  design, under its name (numbered by the daemon when taken), which then
 *  shows, from `design.copy`'s answer: it shows also when the designs
 *  cannot be listed again after it, which a toast says. */
export async function startFromProjectDesign(host: string, workspace: string, d: Design): Promise<DesignCreated> {
  const made = await rpc<DesignCreated>(host, M.designCopy, { workspace, from: { project: d.project, path: d.path }, name: d.name });
  const unlisted = await loadDesigns(host, workspace, true).then(
    () => null,
    (e: unknown) => e,
  );
  const { agent_error: _, ...copied } = made;
  const key = wsKey(host, workspace);
  useDesign.setState((s) => {
    const list = s.designs[key] ?? [];
    return list.some((x) => x.slug === made.slug) ? {} : { designs: { ...s.designs, [key]: [...list, copied] } };
  });
  showDesign(host, workspace, made.slug);
  if (unlisted) toast(`The designs could not be listed again: ${errorMessage(unlisted)}`, "error");
  if (made.agent_error) toast(`${made.name} was made, but its agent did not start: ${made.agent_error}`, "error");
  return made;
}

/** A workspace's designs; undefined until listed (X65). */
export function designsOf(s: DesignState, host: string, workspace: string): Design[] | undefined {
  return s.designs[wsKey(host, workspace)];
}

/** A workspace's session designs, every session's (X65); undefined until listed. */
export function sessionDesignsIn(s: DesignState, host: string, workspace: string): Design[] | undefined {
  return s.sessionDesigns[wsKey(host, workspace)];
}

const NO_DESIGNS: Design[] = [];
/** Each listing of session designs by session, so a session's list is the
 *  same array until the next listing. */
const bySession = new WeakMap<Design[], Record<string, Design[]>>();

/** A session's designs (X65), none until its workspace's are listed. */
export function sessionDesignsOf(s: DesignState, host: string, session: string): Design[] {
  for (const [key, list] of Object.entries(s.sessionDesigns)) {
    if (parseWsKey(key).host !== host) continue;
    let groups = bySession.get(list);
    if (!groups) {
      groups = {};
      for (const d of list) if (d.session) (groups[d.session] ??= []).push(d);
      bySession.set(list, groups);
    }
    if (groups[session]) return groups[session];
  }
  return NO_DESIGNS;
}

/** The design a session's Design tab shows: the one picked while the
 *  session has it, else its first; null without designs (X65). */
export function shownSessionDesign(s: DesignState, host: string, session: string): Design | null {
  const list = sessionDesignsOf(s, host, session);
  const slug = s.sessionShown[placeKey(host, { session })];
  return list.find((d) => d.slug === slug) ?? list[0] ?? null;
}

/** Shows design `slug` in a session's Design tab. */
export function showSessionDesign(host: string, session: string, slug: string) {
  useDesign.setState((s) => ({ sessionShown: { ...s.sessionShown, [placeKey(host, { session })]: slug } }));
}

/** Switches the app to a session design: its session, with the design in
 *  its Design tab (X65). `select`: the session is not the one shown yet. */
export async function openSessionDesign(host: string, workspace: string, session: string, slug: string, select: boolean) {
  if (select) selectSession(host, session);
  showSessionDesign(host, session, slug);
  pickDesignTab(host, session);
  useStore.setState({ rightOpen: true });
  await loadDesigns(host, workspace, true).catch(() => {});
}

/** Shows a session's Design tab, entered, as the user picking it or the
 *  app opening it does (X65): its canvas takes its keys at once
 *  (justOpened), as the tab's own button is outside the canvas. */
export function pickDesignTab(host: string, session: string) {
  const key = placeKey(host, { session });
  useDesign.setState((s) => (s.tabOpened.includes(key) ? {} : { tabOpened: [...s.tabOpened, key] }));
  useStore.setState({ rightTab: "design" });
}

/** Whether the app just opened this session's Design tab itself, or the
 *  user just picked it. */
export function justOpened(s: DesignState, host: string, session: string): boolean {
  return s.tabOpened.includes(placeKey(host, { session }));
}

/** The session's Design tab's canvas took the app's opening. */
export function tookOpened(host: string, session: string) {
  const key = placeKey(host, { session });
  useDesign.setState((s) => ({ tabOpened: s.tabOpened.filter((k) => k !== key) }));
}

/** How many designs of a workspace an agent started that are unseen: once
 *  its designs are listed, only those still listed. */
export function unseenOf(s: DesignState, host: string, workspace: string): number {
  const place = placeKey(host, workspace);
  const listed = designsOf(s, host, workspace);
  return s.unseen.filter((k) => placeKeyOfItem(k) === place && (!listed || listed.some((d) => itemKey(host, workspace, d.slug) === k))).length;
}

/** The design shown as the design screen in a workspace, or null. */
export function shownDesign(s: DesignState, host: string, workspace: string): Design | null {
  const slug = s.designShown[wsKey(host, workspace)];
  return (slug && designsOf(s, host, workspace)?.find((d) => d.slug === slug)) || null;
}

/** The visual editor's say over a page changed on disk: true when it
 *  takes the change, deciding itself whether the page loads again. */
export type PageOwner = (host: string, place: DesignPlace, slug: string, page: string) => boolean;

let pageOwner: PageOwner = () => false;

/** The editor (designEditor.ts) says, once it starts, which changed pages
 *  it takes; it is told through this, not imported, as it imports the
 *  store, as Design mode tells the store where its agents are. */
export function registerPageOwner(owner: PageOwner) {
  pageOwner = owner;
}

/** Loads a design's page on the canvas again, as after a change. */
export function reloadPage(host: string, place: DesignPlace, slug: string, page: string) {
  const key = pageKey(host, place, slug, page);
  useDesign.setState((s) => ({ pageRevs: { ...s.pageRevs, [key]: (s.pageRevs[key] ?? 0) + 1 } }));
}

/** How many times a design's page changed since the app started. */
export function pageRevOf(s: DesignState, host: string, place: DesignPlace, slug: string, page: string): number {
  return pageRevReader(s.pageRevs, host)(place, slug, page);
}

/** Each page's revision on `host`, from the store's `pageRevs`, as the
 *  Designs index's thumbnails carry it (X65). */
export function pageRevReader(pageRevs: DesignState["pageRevs"], host: string): (place: DesignPlace, slug: string, page: string) => number {
  return (place, slug, page) => pageRevs[pageKey(host, place, slug, page)] ?? 0;
}

/** The pages the latest change of a design wrote. */
export function latestOf(s: DesignState, host: string, place: DesignPlace, slug: string): string[] {
  return s.latest[itemKey(host, place, slug)] ?? NONE;
}

/** A design's check problems, every page's. */
export function problemsOf(s: DesignState, host: string, place: DesignPlace, slug: string): PageProblem[] {
  return s.problems[itemKey(host, place, slug)] ?? NO_PROBLEMS;
}

const NONE: string[] = [];
const NO_PROBLEMS: PageProblem[] = [];
const NO_COMMENTS: DesignComment[] = [];
const NO_MIDS: PageMids = {};

/** A design's snapshots, newest first; undefined until listed. */
export function historyOf(s: DesignState, host: string, place: DesignPlace, slug: string): DesignSnapshot[] | undefined {
  return s.histories[itemKey(host, place, slug)];
}

const historyListing = itemListing("histories", M.designHistory);

/** Lists a design's snapshots (X65), and again as each is taken. */
export function loadHistory(host: string, place: DesignPlace, slug: string): Promise<void> {
  return historyListing.load(host, place, slug);
}

/** A file of a design's snapshots: under `history/`. */
const isHistoryPath = (path: string) => path.startsWith("history/");

/** A design's comments, by number; none until listed. */
export function commentsOf(s: DesignState, host: string, place: DesignPlace, slug: string): DesignComment[] {
  return s.comments[itemKey(host, place, slug)] ?? NO_COMMENTS;
}

/** The `data-mid`s of a design's pages, from their last load on the canvas. */
export function midsOf(s: DesignState, host: string, place: DesignPlace, slug: string): PageMids {
  return s.mids[itemKey(host, place, slug)] ?? NO_MIDS;
}

const NOT_SENDING: number[] = [];

/** The pins of a design a Send is on its way with, by number: their Send
 *  is off until it is done. */
export function sendingOf(s: DesignState, host: string, place: DesignPlace, slug: string): number[] {
  return s.sending[itemKey(host, place, slug)] ?? NOT_SENDING;
}

/** Records the `data-mid`s a page reported after it loaded (the bridge's). */
export function setPageMids(host: string, place: DesignPlace, slug: string, page: string, mids: string[]) {
  const key = itemKey(host, place, slug);
  useDesign.setState((s) => ({ mids: { ...s.mids, [key]: { ...s.mids[key], [page]: mids } } }));
}

/** Records an element the user picked on a page as there (withMid): the
 *  page may have added it after its last report. */
export function addPageMid(host: string, place: DesignPlace, slug: string, page: string, mid: string) {
  const key = itemKey(host, place, slug);
  useDesign.setState((s) => ({ mids: { ...s.mids, [key]: { ...s.mids[key], [page]: withMid(s.mids[key]?.[page], mid) } } }));
}

const commentListing = itemListing("comments", M.designComments);

/** Lists a design's comments (X65). */
export function loadComments(host: string, place: DesignPlace, slug: string): Promise<void> {
  return commentListing.load(host, place, slug);
}

/** Puts the pins the daemon gave back in the design's list at once, so the
 *  box, the pins and the tab follow without waiting: the change's
 *  design.changed, which lists them all again, comes 150 ms or more later.
 *  A listing still on its way may have read before the change, so it is
 *  asked again, never left to land over the change. */
function mergePins(host: string, place: DesignPlace, slug: string, pins: DesignComment[]) {
  const key = itemKey(host, place, slug);
  useDesign.setState((s) => ({ comments: { ...s.comments, [key]: withPins(s.comments[key] ?? [], pins) } }));
  commentListing.changed(host, place, slug);
}

/** `design.comment.put` with one change, its pins merged at once. */
async function changeComments(host: string, place: DesignPlace, slug: string, change: CommentChange): Promise<DesignComment[]> {
  const pins = await rpc<DesignComment[]>(host, M.designCommentPut, { ...designRef(place, slug), ...change });
  mergePins(host, place, slug, pins);
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
export async function keepComment(host: string, place: DesignPlace, slug: string, c: NewComment): Promise<DesignComment> {
  const [pin] = await changeComments(host, place, slug, { new: c });
  return pin;
}

/** Changes a kept pin's comment; a changed one is not sent any more. */
export async function editComment(host: string, place: DesignPlace, slug: string, n: number, comment: string): Promise<DesignComment> {
  const [pin] = await changeComments(host, place, slug, { edit: { n, comment } });
  return pin;
}

/** **Send** and **Send all**: the pins go to the design's agent as one
 *  message, one line each (by `ask`, which may put more before them), and
 *  only then are they marked sent. A pin a
 *  Send is already on its way with is left out, so a second click never
 *  sends it twice. */
export async function sendComments(host: string, place: DesignPlace, slug: string, agent: number, pins: DesignComment[], ask: (text: string) => Promise<void> = (text) => askAgent(host, agent, text), folder: string | null = null): Promise<void> {
  const key = itemKey(host, place, slug);
  const busy = new Set(sendingOf(useDesign.getState(), host, place, slug));
  const going = pins.filter((p) => !busy.has(p.n));
  if (!going.length) return;
  const ns = going.map((p) => p.n);
  useDesign.setState((s) => ({ sending: { ...s.sending, [key]: [...(s.sending[key] ?? []), ...ns].sort((a, b) => a - b) } }));
  try {
    await ask(commentsMessage(going, folder));
    // Each with the comment sent: one edited meanwhile is not marked sent.
    await changeComments(host, place, slug, { sent: { pins: going.map((p) => ({ n: p.n, comment: p.comment })) } });
  } finally {
    useDesign.setState((s) => ({ sending: { ...s.sending, [key]: (s.sending[key] ?? []).filter((n) => !ns.includes(n)) } }));
  }
}

/** **Resolve**: the pin is done. */
export async function resolveComment(host: string, place: DesignPlace, slug: string, n: number): Promise<void> {
  mergePins(host, place, slug, [await rpc<DesignComment>(host, M.designCommentResolve, { ...designRef(place, slug), n })]);
}

/** Shows a design as the design screen (X65), and its agent as seen. */
export function showDesign(host: string, workspace: string, slug: string) {
  const key = wsKey(host, workspace);
  const item = itemKey(host, workspace, slug);
  useDesign.setState((s) => ({ designShown: { ...s.designShown, [key]: slug }, indexShown: { ...s.indexShown, [key]: false }, unseen: s.unseen.includes(item) ? s.unseen.filter((k) => k !== item) : s.unseen }));
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
  // An unseen design of the workspace, unseen before this listing was asked
  // and not in it, was removed: it is unseen no more (X65).
  const asked = useDesign.getState().unseen.filter((k) => placeKeyOfItem(k) === key);
  const list = withPickedViewports(host, workspace, await rpc<Design[]>(host, M.designList, { workspace }));
  const designs = workspaceDesigns(list);
  const gone = new Set(asked.filter((k) => !designs.some((d) => itemKey(host, workspace, d.slug) === k)));
  useDesign.setState((s) => ({
    designs: { ...s.designs, [key]: designs },
    sessionDesigns: { ...s.sessionDesigns, [key]: list.filter((d) => d.kind === "session") },
    projectDesigns: { ...s.projectDesigns, [key]: list.filter((d) => d.kind === "project") },
    unseen: gone.size ? s.unseen.filter((k) => !gone.has(k)) : s.unseen,
  }));
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
export async function checkDesign(host: string, place: DesignPlace, slug: string): Promise<void> {
  const key = itemKey(host, place, slug);
  const latest = checksAsked.start(key);
  let found: PageProblem[];
  try {
    found = await rpc<PageProblem[]>(host, M.designCheck, { design: designRef(place, slug) });
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

function checkSoon(host: string, place: DesignPlace, slug: string) {
  const key = itemKey(host, place, slug);
  clearTimeout(checkTimers[key]);
  checkTimers[key] = setTimeout(() => {
    delete checkTimers[key];
    void checkDesign(host, place, slug);
  }, CHECK_SETTLE_MS);
}

/** A change in a workspace's design folder, or in a session design's
 *  folders (with its session): the pages it reloads, the page a design's
 *  agent is writing, and the design's check again. */
function onDesignChange(host: string, change: DesignChanged) {
  const st = useDesign.getState();
  const place = changePlace(change);
  const list = isSession(place) ? sessionDesignsOf(st, host, place.session) : (designsOf(st, host, place) ?? []);
  const revs: Record<string, number> = {};
  // A page the editor has read decides itself whether it loads again: not
  // for the editor's own save (designEditor.ts). Only when nothing but
  // pages changed: an asset changed loads every page.
  // A snapshot taken with the change (history/) is none of its pages.
  const pagesOnly = change.design !== null && change.paths.filter((p) => !isHistoryPath(p)).every((p) => pageOfPath(p) !== null);
  const owned = new Set(pagesOnly ? changedPages(change, change.design!).filter((page) => pageOwner(host, place, change.design!, page)) : []);
  const bump = (key: string, design: string, page: string) => {
    if (design !== change.design || !owned.has(page)) revs[key] ??= (st.pageRevs[key] ?? 0) + 1;
  };
  for (const d of list) {
    for (const p of d.pages) if (reloadsPage(change, { design: d.slug, system: d.system, page: p.name })) bump(pageKey(host, place, d.slug, p.name), d.slug, p.name);
  }
  if (change.design) {
    const key = itemKey(host, place, change.design);
    // A page not listed yet loads once it is: written again before that.
    const pages = changedPages(change, change.design);
    for (const page of pages) bump(pageKey(host, place, change.design, page), change.design, page);
    // A session design's own copy of its design system: its kit is read again.
    const own = isSession(place) && changesOwnSystem(change);
    // Its built screenshots, saved by its agent after implementing it.
    const built = isSession(place) && changesBuilt(change.paths);
    useDesign.setState((s) => ({
      builtRevs: built ? { ...s.builtRevs, [key]: (s.builtRevs[key] ?? 0) + 1 } : s.builtRevs,
      pageRevs: { ...s.pageRevs, ...revs },
      latest: pages.length ? { ...s.latest, [key]: pages } : s.latest,
      changes: own ? { ...s.changes, [key]: (s.changes[key] ?? 0) + 1 } : s.changes,
    }));
    reloadDesigns(host, change.workspace);
    checkSoon(host, place, change.design);
    // Its comments, kept, sent or resolved here or written by its agent.
    if (commentListing.wanted.has(key) && change.paths.includes(COMMENTS_FILE)) void loadComments(host, place, change.design).catch(() => {});
    // Its snapshots, as the daemon takes or restores one.
    if (historyListing.wanted.has(key) && change.paths.some(isHistoryPath)) void loadHistory(host, place, change.design).catch(() => {});
  } else if (Object.keys(revs).length) {
    useDesign.setState((s) => ({ pageRevs: { ...s.pageRevs, ...revs } }));
  }
}

/** `design.open`: show the design, or offer one an agent started (X65): a
 *  workspace design one until it is seen, with the Design button's dot; a
 *  session design in its session's Design tab while the session is shown. */
function onDesignOpen(host: string, ev: DesignOpen) {
  const st = useStore.getState();
  const shown = modeOf(st) === "sessions" && st.selected?.host === host ? st.selected.session : null;
  const action = designOpenAction(ev, st.sessions[host] ?? [], shown);
  const session = ev.kind === "session" ? ev.session : undefined;
  const open = () => void (session ? openSessionDesign(host, ev.workspace, session, ev.slug, true) : openDesign(host, ev.workspace, ev.slug));
  if (action.kind === "none") return;
  if (action.kind === "show") open();
  else if (action.kind === "tab") void openSessionDesign(host, ev.workspace, action.session, ev.slug, false);
  else {
    reloadDesigns(host, ev.workspace);
    // A workspace design started from a session (/moonlet-design new).
    if (!session && ev.session) {
      const item = itemKey(host, ev.workspace, ev.slug);
      useDesign.setState((s) => (s.unseen.includes(item) ? {} : { unseen: [...s.unseen, item] }));
    }
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
  await rpc(host, M.designRemove, designRef(workspace, slug));
  const key = wsKey(host, workspace);
  useDesign.setState((s) => ({ designShown: s.designShown[key] === slug ? { ...s.designShown, [key]: null } : s.designShown }));
  const timer = itemKey(host, workspace, slug);
  clearTimeout(checkTimers[timer]);
  delete checkTimers[timer];
  await loadDesigns(host, workspace, true).catch(() => {});
}

/** **Update** (X65): a session design's two copies of its design system
 *  replaced with the system as it is now, its anchor recorded; the cards
 *  that changed since its copy, for its agent. Its bar goes at once: the
 *  listing its design.changed brings says so too. */
export async function updateSystem(host: string, place: { session: string }, slug: string): Promise<DesignSystemUpdated> {
  const updated = await rpc<DesignSystemUpdated>(host, M.designSystemUpdate, designRef(place, slug));
  // Its own host's listing only: a session id is unique per host.
  const mine = (d: Design) => d.session === place.session && d.slug === slug;
  useDesign.setState((s) => ({
    sessionDesigns: Object.fromEntries(Object.entries(s.sessionDesigns).map(([key, list]) => [key, parseWsKey(key).host === host && list.some(mine) ? list.map((d) => (mine(d) ? { ...d, system_updated: false } : d)) : list])),
  }));
  return updated;
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


/** Shows `viewport` as the design's, in its host's listing: an id is
 *  unique per host only. */
function showViewport(host: string, place: DesignPlace, slug: string, viewport: string) {
  const key = itemKey(host, place, slug);
  const shown = (byWorkspace: Record<string, Design[]>) =>
    Object.fromEntries(
      Object.entries(byWorkspace).map(([wk, list]) => {
        const ws = parseWsKey(wk);
        const mine = (d: Design) => itemKey(ws.host, placeOfDesign(d, ws.id), d.slug) === key;
        return [wk, list.some(mine) ? list.map((d) => (mine(d) ? { ...d, viewport } : d)) : list];
      }),
    );
  useDesign.setState((s) => ({ designs: shown(s.designs), sessionDesigns: shown(s.sessionDesigns) }));
}

/** A listing with each design's picked, not yet saved, viewport. */
function withPickedViewports(host: string, workspace: string, list: Design[]): Design[] {
  return list.map((d) => {
    const picked = pickedViewports[itemKey(host, placeOfDesign(d, workspace), d.slug)];
    return picked ? { ...d, viewport: picked } : d;
  });
}

/** Saves the viewport a design was last shown at in its design.toml. It
 *  shows at once; saves of one design go one at a time, and a pick made
 *  while one is on its way is saved after it, so the latest pick is what
 *  shows and what is kept. A failed save leaves the pick shown. */
export async function saveViewport(host: string, place: DesignPlace, slug: string, viewport: string): Promise<void> {
  const key = itemKey(host, place, slug);
  pickedViewports[key] = viewport;
  showViewport(host, place, slug, viewport);
  let sent = viewport;
  await viewportSaves.send(key, async () => {
    sent = pickedViewports[key];
    await rpc(host, M.designViewport, { ...designRef(place, slug), viewport: sent });
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
  const { systems, designs, sessionDesigns } = useDesign.getState();
  const lists: [Record<string, { agent: number | null }[]>, (host: string, workspace: string) => void][] = [
    [systems, reload],
    [designs, reloadDesigns],
    [sessionDesigns, reloadDesigns],
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
    else if (e.name === EV.designChanged && !isDesignModeChange(e.data as DesignChanged)) onDesignChange(e.host, e.data as DesignChanged);
    else if (e.name === EV.designChanged) {
      const d = e.data as DesignChanged;
      onDesignChange(e.host, d);
      if (systemListing.wanted.has(wsKey(e.host, d.workspace))) reload(e.host, d.workspace);
      if (d.system) {
        const key = itemKey(e.host, d.workspace, d.system);
        // Its cards load again only for what they show (X64).
        const toLoad = cardsReloaded(d);
        useDesign.setState((s) => {
          const revs = s.cardRevs[key] ?? { all: 0, cards: {} };
          const cards = { ...revs.cards };
          for (const path of toLoad.cards) cards[path] = (cards[path] ?? 0) + 1;
          return {
            changes: { ...s.changes, [key]: (s.changes[key] ?? 0) + 1 },
            cardRevs: toLoad.all || toLoad.cards.length ? { ...s.cardRevs, [key]: { all: revs.all + (toLoad.all ? 1 : 0), cards } } : s.cardRevs,
          };
        });
        // Its cards are listed again when asked for (a newer request always
        // lands last).
        if (cardListing.wanted.has(key)) void loadCards(e.host, d.workspace, d.system).catch(() => {});
        // A session design on it may now be pinned to an older sync (X65).
        if (designListing.wanted.has(wsKey(e.host, d.workspace))) reloadDesigns(e.host, d.workspace);
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
