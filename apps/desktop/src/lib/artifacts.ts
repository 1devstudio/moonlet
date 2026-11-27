// The Artifacts list (X114): a workspace's plans, from `artifact.list`,
// and its designs, from the designs Design mode lists, as one list.

import { shortAge } from "./design";
import type { ArtifactInfo, ArtifactMatch, ArtifactText, ArtifactVersion, Design } from "./protocol";

export type ArtifactKind = "all" | "plan" | "design";

/** One row of the Artifacts list. */
export interface ArtifactRow {
  host: string;
  info: ArtifactInfo;
  /** `storefront`, `storefront · archived`, `storefront · merged` or `Workspace`. */
  home: string;
  /** "12m", "3d". */
  age: string;
  /** `used by 2`, or none. */
  usedBy: string | null;
  /** The line a search found its text on. */
  snippet: string | null;
}

/** A design's artifact id: where it is, then its slug. */
export function designArtifactId(d: Design, workspace: string): string {
  if (d.kind === "session") return `design:session:${d.session ?? ""}:${d.slug}`;
  if (d.kind === "project") return `design:project:${d.project ?? ""}:${d.slug}`;
  return d.shared ? `design:library:${d.slug}` : `design:workspace:${workspace}:${d.slug}`;
}

/** A design as an artifact of `workspace`. */
export function designArtifact(d: Design, workspace: string): ArtifactInfo {
  const home =
    d.kind === "session" ? { workspace, session: d.session, project: d.project } : d.kind === "project" ? { workspace, project: d.project, merged: true } : { workspace };
  return { id: designArtifactId(d, workspace), kind: "design", name: d.name, home, updated_at: d.updated_at, used_by: [] };
}

/** Where a row says its artifact lives. */
export function homeLine(info: ArtifactInfo, host: string, projectName: (host: string, id: string) => string | undefined): string {
  const project = info.home.project ? (projectName(host, info.home.project) ?? "project") : null;
  if (!project) return "Workspace";
  if (info.home.archived) return `${project} · archived`;
  if (info.home.merged) return `${project} · merged`;
  return project;
}

/** Whether a design has `query` in its name, brief or page labels, and where. */
export function designMatch(d: Design, query: string): Omit<ArtifactMatch, "id"> | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  if (d.name.toLowerCase().includes(q)) return { field: "name" };
  if (d.brief?.toLowerCase().includes(q)) return { field: "brief", snippet: `Brief: ${d.brief.trim()}` };
  const label = d.pages.find((p) => p.label?.toLowerCase().includes(q))?.label;
  return label ? { field: "label", snippet: `Page: ${label}` } : null;
}

export interface ListInput {
  /** Each host's plans, from `artifact.list`. */
  plans: Record<string, ArtifactInfo[] | undefined>;
  /** Each host's designs of the workspace: its own, shared, session and project designs. */
  designs: Record<string, Design[] | undefined>;
  workspace: string;
  /** A project's name on a host: project ids are unique per host only. */
  projectName: (host: string, id: string) => string | undefined;
  now: number;
}

/**
 * The rows the Artifacts list shows: of `kind`, newest change first, and
 * while `query` is typed, only those found, with the line they were found
 * on. `matches` are each host's plans `artifact.search` found.
 */
export function artifactRows(input: ListInput, kind: ArtifactKind, query: string, matches: Record<string, ArtifactMatch[] | undefined>): ArtifactRow[] {
  const searching = query.trim() !== "";
  const rows: ArtifactRow[] = [];
  const add = (host: string, info: ArtifactInfo, snippet: string | null) =>
    rows.push({
      host,
      info,
      home: homeLine(info, host, input.projectName),
      age: shortAge(Math.max(0, input.now - info.updated_at)),
      usedBy: info.used_by.length > 0 ? `used by ${info.used_by.length}` : null,
      snippet,
    });
  for (const [host, plans] of Object.entries(input.plans)) {
    if (kind === "design") continue;
    for (const p of plans ?? []) {
      if (!searching) add(host, p, null);
      else {
        const m = matches[host]?.find((x) => x.id === p.id);
        if (m) add(host, p, m.snippet ?? null);
      }
    }
  }
  // A design copied to every member (X71) is listed once, from the Mac
  // that owns it: the copy that names no other owner.
  const owned = new Set<string>();
  for (const designs of Object.values(input.designs)) for (const d of designs ?? []) if (!d.owner) owned.add(designArtifactId(d, input.workspace));
  for (const [host, designs] of Object.entries(input.designs)) {
    if (kind === "plan") continue;
    for (const d of designs ?? []) {
      if (d.owner && owned.has(designArtifactId(d, input.workspace))) continue;
      const info = designArtifact(d, input.workspace);
      if (!searching) add(host, info, null);
      else {
        const m = designMatch(d, query);
        if (m) add(host, info, m.snippet ?? null);
      }
    }
  }
  rows.sort((a, b) => b.info.updated_at - a.info.updated_at || a.info.name.localeCompare(b.info.name));
  return rows;
}

/** A snippet cut into its parts, each marked where `query` is in it,
 *  ignoring case. Each character is lowercased on its own, so a match maps
 *  back to whole characters whatever lowercasing does to their length. */
export function markParts(text: string, query: string): { text: string; mark: boolean }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, mark: false }];
  const chars = Array.from(text);
  let folded = "";
  const starts: number[] = [];
  for (const c of chars) {
    starts.push(folded.length);
    folded += c.toLowerCase();
  }
  const charAt = (i: number) => {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= i) k++;
    return k;
  };
  const out: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (let i = folded.indexOf(q); i !== -1; i = folded.indexOf(q, i + q.length)) {
    const from = charAt(i);
    const to = i + q.length >= folded.length ? chars.length : charAt(i + q.length);
    if (from > at) out.push({ text: chars.slice(at, from).join(""), mark: false });
    out.push({ text: chars.slice(from, to).join(""), mark: true });
    at = to;
  }
  if (at < chars.length) out.push({ text: chars.slice(at).join(""), mark: false });
  return out;
}

/** What a plan's view says of the version shown: "v3, approved 12m ago". */
export function versionLine(read: Pick<ArtifactText, "version" | "versions">, now: number): string {
  const v = read.versions.find((x) => x.n === read.version) ?? read.versions.at(-1);
  if (!v) return "";
  const state = stateLabel(v.state);
  const age = shortAge(Math.max(0, now - v.at));
  return `v${v.n}, ${state} ${age === "now" ? "just now" : `${age} ago`}`;
}

/** The design an artifact id names, of those listed: never another design
 *  of the same slug elsewhere. */
export function designFor(designs: readonly Design[], id: string, workspace: string): Design | undefined {
  return designs.find((d) => designArtifactId(d, workspace) === id);
}

/** Whether a plan's view is read only: its session is archived, or an
 *  older version is shown. */
export function planReadOnly(home: { archived?: boolean }, shown: number | null, latest: number | null): boolean {
  return !!home.archived || (shown !== null && shown !== latest);
}

/** A version's state as the view says it. */
export function stateLabel(state: ArtifactVersion["state"]): string {
  return state === "edited" ? "edited by you" : state;
}

/** Which hosts' artifacts are missing because they cannot be reached; null
 *  when every host answers. */
export function unreachableLine(hosts: Record<string, { label: string; status: string }>): string | null {
  const away = Object.values(hosts).filter((h) => h.status !== "connected").map((h) => h.label);
  if (!away.length) return null;
  return `Not listed from ${away.join(", ")}: ${away.length === 1 ? "it" : "they"} can't be reached`;
}
