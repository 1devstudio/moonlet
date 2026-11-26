// The Artifacts list (X114): a workspace's plans, from `artifact.list`,
// and its designs, from the designs Design mode lists, as one list.

import { shortAge } from "./design";
import type { ArtifactInfo, ArtifactMatch, ArtifactText, Design } from "./protocol";

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
export function homeLine(info: ArtifactInfo, projectName: (id: string) => string | undefined): string {
  const project = info.home.project ? (projectName(info.home.project) ?? "project") : null;
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
  projectName: (id: string) => string | undefined;
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
      home: homeLine(info, input.projectName),
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
  for (const [host, designs] of Object.entries(input.designs)) {
    if (kind === "plan") continue;
    for (const d of designs ?? []) {
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

/** A snippet cut into its parts, each marked where `query` is in it. */
export function markParts(text: string, query: string): { text: string; mark: boolean }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, mark: false }];
  const out: { text: string; mark: boolean }[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + q.length)) {
    if (i > at) out.push({ text: text.slice(at, i), mark: false });
    out.push({ text: text.slice(i, i + q.length), mark: true });
    at = i + q.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}

/** What a plan's view says of the version shown: "v3, approved 12m ago". */
export function versionLine(read: Pick<ArtifactText, "version" | "versions">, now: number): string {
  const v = read.versions.find((x) => x.n === read.version) ?? read.versions.at(-1);
  if (!v) return "";
  const state = v.state === "edited" ? "edited by you" : v.state;
  const age = shortAge(Math.max(0, now - v.at));
  return `v${v.n}, ${state} ${age === "now" ? "just now" : `${age} ago`}`;
}
