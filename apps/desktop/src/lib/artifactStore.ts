// The Artifacts list's state (X114): each host's plans of a workspace, what
// a search found, the kind shown, and the artifact open in the main area.

import { create } from "zustand";
import { rpc, onDaemonEvent } from "./daemon";
import { designsOf, loadDesigns, projectDesignsIn, sessionDesignsIn, type useDesign } from "./designStore";
import { LIBRARY } from "./designLibrary";
import type { Design } from "./protocol";
import { EV, M, type ArtifactInfo, type ArtifactMatch } from "./protocol";
import type { ArtifactKind } from "./artifacts";

/** An artifact picked to go with a session's next message (X114). */
export interface ArtifactChip {
  /** The host the artifact is listed from. */
  host: string;
  id: string;
  name: string;
  kind: "plan" | "design";
}

interface ArtifactState {
  /** The artifacts each session's next message refers to, by `<host>/<session>`. */
  chips: Record<string, ArtifactChip[] | undefined>;
  /** Each host's plans of a workspace, by `<host>/<workspace>`. */
  plans: Record<string, ArtifactInfo[] | undefined>;
  /** What `artifact.search` found, by `<host>/<workspace>`, for `query`. */
  matches: Record<string, ArtifactMatch[] | undefined>;
  query: string;
  kind: ArtifactKind;
  /** The artifact open in the main area. */
  shown: { host: string; id: string } | null;
}

export const useArtifacts = create<ArtifactState>(() => ({ chips: {}, plans: {}, matches: {}, query: "", kind: "all", shown: null }));

const chipKey = (host: string, session: string) => `${host}/${session}`;

/** The artifacts session `session` on `host` will refer to with its next message. */
/** One empty list, so a selector of a session with none returns the same one each time. */
const NO_CHIPS: ArtifactChip[] = [];

export const chipsOf = (s: ArtifactState, host: string, session: string): ArtifactChip[] => s.chips[chipKey(host, session)] ?? NO_CHIPS;

/** Picks an artifact for a session's next message; once is enough. */
export function addChip(host: string, session: string, chip: ArtifactChip) {
  useArtifacts.setState((s) => {
    const have = chipsOf(s, host, session);
    if (have.some((c) => c.id === chip.id)) return s;
    return { chips: { ...s.chips, [chipKey(host, session)]: [...have, chip] } };
  });
}

/** Takes an artifact out of a session's next message: it refers to nothing. */
export function removeChip(host: string, session: string, id: string) {
  useArtifacts.setState((s) => ({ chips: { ...s.chips, [chipKey(host, session)]: chipsOf(s, host, session).filter((c) => c.id !== id) } }));
}

/** Refers the session to every artifact picked for its message, and gives
 *  back each one's line for the message, in the order picked. The chips go
 *  once the message has its lines. An artifact of another host cannot be
 *  referred to yet: it says so and stays picked. */
export async function attachChips(host: string, session: string): Promise<string[]> {
  const chips = chipsOf(useArtifacts.getState(), host, session);
  const elsewhere = chips.find((c) => c.host !== host);
  if (elsewhere) throw new Error(`${elsewhere.name} is on another host: a session refers to the artifacts of its own host for now`);
  const lines: string[] = [];
  for (const c of chips) lines.push((await rpc<{ line: string }>(host, M.artifactAttach, { session, id: c.id })).line);
  useArtifacts.setState((s) => ({ chips: { ...s.chips, [chipKey(host, session)]: [] } }));
  return lines;
}

export const artifactKey = (host: string, workspace: string) => `${host}/${workspace}`;

/** Lists a workspace's plans on `host`. A host that cannot answer keeps what it listed before. */
export async function loadPlans(host: string, workspace: string): Promise<void> {
  const list = await rpc<ArtifactInfo[]>(host, M.artifactList, { workspace });
  useArtifacts.setState((s) => ({ plans: { ...s.plans, [artifactKey(host, workspace)]: list } }));
}

/** The latest search asked, so an older answer never lands last. */
let asked = 0;

/** Searches each host's plans of a workspace for `query`. */
export async function searchPlans(hosts: string[], workspace: string, query: string): Promise<void> {
  const n = ++asked;
  if (!query.trim()) {
    useArtifacts.setState({ query, matches: {} });
    return;
  }
  const found = await Promise.all(
    hosts.map(async (h) => [artifactKey(h, workspace), await rpc<ArtifactMatch[]>(h, M.artifactSearch, { workspace, query }).catch(() => undefined)] as const),
  );
  if (n !== asked) return;
  // The query and what it found land together, so rows never meet the
  // previous query's matches.
  useArtifacts.setState({ query, matches: Object.fromEntries(found) });
}

/** Lists a workspace's plans again on every host whose plans changed. */
let listening = false;
export function watchArtifacts(reload: (host: string) => void) {
  if (listening) return;
  listening = true;
  void onDaemonEvent((e) => {
    if (e.name === EV.artifactChanged || e.name === EV.designChanged) reload(e.host);
  });
}

/** A workspace's designs on `host`, as the Artifacts list shows them: its
 *  own, the library's (shared with every workspace, X95), its sessions'
 *  and those merged into its projects. */
export function artifactDesigns(d: ReturnType<typeof useDesign.getState>, host: string, workspace: string): Design[] {
  const shared = (designsOf(d, host, LIBRARY) ?? []).map((x) => ({ ...x, shared: true }));
  return [...(designsOf(d, host, workspace) ?? []), ...shared, ...(sessionDesignsIn(d, host, workspace) ?? []), ...(projectDesignsIn(d, host, workspace) ?? [])];
}

/** Lists a workspace's designs on `host`, the library's too. */
export function loadArtifactDesigns(host: string, workspace: string): void {
  void loadDesigns(host, workspace).catch(() => {});
  void loadDesigns(host, LIBRARY).catch(() => {});
}
