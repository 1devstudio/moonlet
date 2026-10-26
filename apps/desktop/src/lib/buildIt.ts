// Build it (X65): a workspace design opens the New session composer (X54)
// in its design system's first source project, with the design as its
// source chip, its pages and styles as attachments that follow X54's text
// contract, and the session made with `session.create {…, design}`.

import type { Attachment } from "./composer";
import { linePage, pageFile } from "./designPage";

/** The workspace design Build it starts a session from, as the composer
 *  gets it: its design system's name for the styles' line, and its
 *  viewport for the pages' thumbnails. */
export interface BuildDesign {
  workspace: string;
  slug: string;
  name: string;
  /** Its design system's slug. */
  system: string;
  systemName: string;
  /** `index` first, as `design.list` gives them. */
  pages: { name: string; label: string | null }[];
  viewport?: string;
}

/** The note under the composer while it builds a design. */
export const BUILD_NOTE = "The project is the design system's first source. The design keeps a link to the session it starts.";

/** The project Build it opens the composer on: the design system's first
 *  source (`sources`, folders) among the workspace's `projects`, else none. */
export function buildProject(sources: string[], projects: { id: string; path: string }[]): string | null {
  const first = sources[0];
  return (first !== undefined && projects.find((p) => p.path === first)?.id) || null;
}

/** Where Build it builds: the project of the design system's first source,
 *  or, when the workspace has no such project or the system no source,
 *  why Build it is disabled. It never falls back to another project, which
 *  would send the design to an unrelated repository. */
export function buildItTarget(sources: string[], projects: { id: string; path: string }[]): { project: string } | { unavailable: string } {
  const project = buildProject(sources, projects);
  if (project) return { project };
  if (sources[0] === undefined) return { unavailable: "The design system has no source project to build in" };
  const name = sources[0].split("/").filter(Boolean).pop() ?? sources[0];
  return { unavailable: `${name}, the design system's first source, is not a project of this workspace` };
}

/** The new branches' prefix, as the daemon takes it (X55): the project's
 *  `branch_prefix`, else the host's. */
export function branchPrefix(config: { branch_prefix?: string | null } | null | undefined, hostPrefix: string): string {
  return config?.branch_prefix?.trim() || hostPrefix;
}

/** What the composer says and makes while it builds design `d`: the chip,
 *  the session's name, its branch, `<prefix>implement-<slug>`, which
 *  `session.create` takes as given, the prompt and the note. */
export function buildNames(d: Pick<BuildDesign, "slug" | "name">, prefix: string): { chip: string; name: string; branch: string; prompt: string; note: string } {
  const name = `implement-${d.slug}`;
  return { chip: `Design · ${d.name}`, name, branch: `${prefix}${name}`, prompt: buildPrompt(d), note: BUILD_NOTE };
}

/** Whether Create may run: not while it is on its way, with a project, and
 *  while it builds a design only once the project's config is read, as the
 *  attachments' lines name its design folder. */
export function createReady(f: { busy: boolean; project: boolean; building: boolean; configRead: boolean }): boolean {
  return !f.busy && f.project && (!f.building || f.configRead);
}

/** Where a refused Create is said: in the composer while it builds a
 *  design, such as a design folder the base branch has already, which the
 *  user fixes there; else in a toast, as before. */
export function createFailure(building: boolean, message: string): { refused: string } | { toast: string } {
  return building ? { refused: message } : { toast: message };
}

/** The prompt Build it opens the composer with. */
const buildPrompt = (d: Pick<BuildDesign, "name">) => `Implement the ${d.name} design`;

/** The prompt after the chip's × (Build it dropped): the one Build it set
 *  goes, so the composer is a plain one again; one the user changed stays.
 *  The design's attachments and branch go with the design. */
export function promptAfterDrop(prompt: string, d: Pick<BuildDesign, "name">): string {
  return prompt === buildPrompt(d) ? "" : prompt;
}

/** The project's design folder for session designs, `[design] dir` of its
 *  `.moonlet/config.toml`, else `docs/design`. */
export function designDir(config: { design?: { dir?: string | null } } | null | undefined): string {
  return config?.design?.dir?.trim() || "docs/design";
}

/** The design's pages, `index` first, then as listed. */
function inOrder(pages: BuildDesign["pages"]): BuildDesign["pages"] {
  return [...pages.filter((p) => p.name === "index"), ...pages.filter((p) => p.name !== "index")];
}

/** Build it's attachments (X54's text contract): one per page not left out
 *  (`left`, by ×), `index` first, then one for the styles, which cannot be
 *  left out, nor the last page left: a build has at least one page. Each sends one line, its page's or the styles' path where the
 *  copy puts them in the worktree, under the project's design folder
 *  (`dir`): `<dir>/<slug>/pages/<page>.html · <design name>, <label>` and
 *  `<dir>/<slug>/system/styles.css · <design system> styles`. No HTML goes
 *  in the message, so it stays small whatever the design's size. */
export function designAttachments(d: Pick<BuildDesign, "slug" | "name" | "pages">, at: { systemName: string; dir: string; left: string[] }): Attachment[] {
  const folder = `${at.dir}/${d.slug}`;
  const kept = inOrder(d.pages).filter((p) => !at.left.includes(p.name));
  const pages = kept.map((p): Attachment => {
    const summary = p.label ? `${d.name}, ${p.label}` : d.name;
    const line = `${linePage(p.name, folder)} · ${summary}`;
    const remove = kept.length > 1 ? `Leave ${pageFile(p.name)} out of the copy and the message` : null;
    return { id: `page:${p.name}`, icon: "page", file: pageFile(p.name), lead: "", summary, body: line, remove, message: line, page: p.name };
  });
  const summary = `${at.systemName} styles`;
  const styles = `${folder}/system/styles.css · ${summary}`;
  return [...pages, { id: "styles", icon: "styles", file: "styles.css", lead: "", summary, body: styles, remove: null, message: styles }];
}

/** What `session.create`'s `design` copies into the worktree: the design's
 *  pages not left out, `index` first. */
export function buildPick(d: Pick<BuildDesign, "workspace" | "slug" | "pages">, left: string[]): { workspace: string; slug: string; pages: string[] } {
  return { workspace: d.workspace, slug: d.slug, pages: inOrder(d.pages).map((p) => p.name).filter((p) => !left.includes(p)) };
}

/** A built workspace design's header (X65): "Building in <project> ·
 *  <session>", and the session a click opens; null while it was never
 *  built, or once its session is gone, when Build it shows again. The
 *  session's project is its own, else `built_in`'s. */
export function buildingIn(
  d: { built_in?: { session: string; project?: string } },
  sessions: { id: string; name: string; project_id: string }[],
  projects: { id: string; name: string }[],
): { text: string; session: string } | null {
  const built = d.built_in;
  const session = built && sessions.find((s) => s.id === built.session);
  if (!session) return null;
  const project = projects.find((p) => p.id === session.project_id) ?? projects.find((p) => p.id === built.project);
  return { text: `Building in ${project ? `${project.name} · ` : ""}${session.name}`, session: session.id };
}
