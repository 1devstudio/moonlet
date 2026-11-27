// The Artifacts list's state (X114): each host's plans of a workspace, what
// a search found, the kind shown, and the artifact open in the main area.

import { create } from "zustand";
import { rpc, onDaemonEvent } from "./daemon";
import { designsOf, loadDesigns, projectDesignsIn, sessionDesignsIn, type useDesign } from "./designStore";
import { LIBRARY } from "./designLibrary";
import type { Design } from "./protocol";
import { EV, M, type ArtifactInfo, type ArtifactMatch } from "./protocol";
import type { ArtifactKind } from "./artifacts";

interface ArtifactState {
  /** Each host's plans of a workspace, by `<host>/<workspace>`. */
  plans: Record<string, ArtifactInfo[] | undefined>;
  /** What `artifact.search` found, by `<host>/<workspace>`, for `query`. */
  matches: Record<string, ArtifactMatch[] | undefined>;
  query: string;
  kind: ArtifactKind;
  /** The artifact open in the main area. */
  shown: { host: string; id: string } | null;
}

export const useArtifacts = create<ArtifactState>(() => ({ plans: {}, matches: {}, query: "", kind: "all", shown: null }));

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
