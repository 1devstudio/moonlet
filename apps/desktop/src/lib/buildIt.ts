// Build it (X65): a workspace design opens the New session composer (X54)
// in its design system's first source project, with the design as its
// source chip, its pages and styles as attachments that follow X54's text
// contract, and the session made with `session.create {…, design}`.

import type { Attachment } from "./composer";
import { pageFile, pagePath } from "./designPage";

/** The workspace design Build it starts a session from. */
export interface BuildDesign {
  workspace: string;
  slug: string;
  name: string;
  /** Its design system's slug. */
  system: string;
  /** `index` first, as `design.list` gives them. */
  pages: { name: string; label: string | null }[];
}

/** The note under the composer while it builds a design. */
export const BUILD_NOTE = "The project is the design system's first source. The design keeps a link to the session it starts.";

/** What the composer opens with to build design `d`: the project, its
 *  design system's first source (`sources`, folders) among the workspace's
 *  `projects`, else none; the chip; the session's name and its branch,
 *  `<prefix>implement-<slug>`, the name the daemon would give it under the
 *  prefix; the prompt and the note. */
export function buildComposer(
  d: Pick<BuildDesign, "slug" | "name">,
  at: { sources: string[]; projects: { id: string; path: string }[]; prefix: string },
): { project: string | null; chip: string; name: string; branch: string; prompt: string; note: string } {
  const first = at.sources[0];
  const name = `implement-${d.slug}`;
  return {
    project: (first !== undefined && at.projects.find((p) => p.path === first)?.id) || null,
    chip: `Design · ${d.name}`,
    name,
    branch: `${at.prefix}${name}`,
    prompt: `Implement the ${d.name} design`,
    note: BUILD_NOTE,
  };
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
 *  left out. Each sends one line, its page's or the styles' path where the
 *  copy puts them in the worktree, under the project's design folder
 *  (`dir`): `<dir>/<slug>/pages/<page>.html · <design name>, <label>` and
 *  `<dir>/<slug>/system/styles.css · <design system> styles`. No HTML goes
 *  in the message, so it stays small whatever the design's size. */
export function designAttachments(d: Pick<BuildDesign, "slug" | "name" | "pages">, at: { systemName: string; dir: string; left: string[] }): Attachment[] {
  const folder = `${at.dir}/${d.slug}`;
  const pages = inOrder(d.pages)
    .filter((p) => !at.left.includes(p.name))
    .map((p): Attachment => {
      const summary = p.label ? `${d.name}, ${p.label}` : d.name;
      const line = `${folder}/${pagePath(p.name)} · ${summary}`;
      return { id: `page:${p.name}`, icon: "page", file: pageFile(p.name), lead: "", summary, body: line, remove: `Leave ${pageFile(p.name)} out of the copy and the message`, message: line, page: p.name };
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
