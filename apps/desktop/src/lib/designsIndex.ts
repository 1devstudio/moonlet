// The Designs index (X65): the workspace's designs as cards in three
// groups, In sessions, Workspace designs and In projects, each saying what
// it is and what its button does. Pure: the listing is designStore.ts, the
// view components/design/DesignsIndex.tsx.

import type { Design, DesignKind } from "./protocol";
import type { DesignPlace } from "./designPlace";
import { inWorktree } from "./sessionDesign";
import { pageUrl, projectPageUrl } from "./designView";
import { builtSession } from "./buildIt";

/** What a card's button does: open a session design's session, a
 *  workspace design's screen, or start a workspace design from a project
 *  design (`design.copy`). */
export type CardAction =
  | { label: "Open session"; kind: "session"; session: string; slug: string }
  | { label: "Open"; kind: "workspace"; slug: string }
  | { label: "Use as a start"; kind: "project"; design: Design };

/** A design's card in the index. `thumb`: its first page's address, framed
 *  near the screen; null without a page, when `placeholder` says so.
 *  `updated_at`: its newest change, null for a project design, which has
 *  none of its own. `key`: the card's, unique in the index. */
export interface IndexCard {
  key: string;
  design: Design;
  name: string;
  line: string;
  act: CardAction;
  thumb: string | null;
  placeholder: string | null;
  updated_at: number | null;
}

export interface IndexGroup {
  title: "In sessions" | "Workspace designs" | "In projects";
  note: string;
  cards: IndexCard[];
}

/** What the index names designs by: the workspace's sessions (with their
 *  worktrees), projects and design systems. `pageRev`: how many times a
 *  page changed (`pageRevOf`), carried by its thumbnail's address so a
 *  changed first page is framed again; none, 0. */
export interface IndexNames {
  workspace: string;
  sessions: { id: string; name: string; project_id: string; path: string; archived?: boolean }[];
  projects: { id: string; name: string }[];
  systems: { slug: string; name: string }[];
  pageRev?: (place: DesignPlace, slug: string, page: string) => number;
}

const revOf = (at: IndexNames, place: DesignPlace, slug: string, page: string) => at.pageRev?.(place, slug, page) ?? 0;

const pages = (n: number) => (n === 0 ? "no pages yet" : `${n} page${n === 1 ? "" : "s"}`);

/** Each kind of design's group and card, in the index's order. */
const KINDS: { kind: DesignKind; title: IndexGroup["title"]; note: string; card: (d: Design, at: IndexNames) => Omit<IndexCard, "design" | "name" | "placeholder"> | null }[] = [
  {
    kind: "session",
    title: "In sessions",
    note: "Their pages live in the session's branch; open the session to change them",
    card: (d, at) => {
      if (!d.session) return null;
      const s = at.sessions.find((x) => x.id === d.session);
      const folder = s ? inWorktree(s.path, d.path) : d.path;
      return {
        key: `session/${d.session}/${d.slug}`,
        line: [projectName(at, s?.project_id ?? d.project), s?.name ?? d.session, folder].join(" · "),
        act: { label: "Open session", kind: "session", session: d.session, slug: d.slug },
        thumb: d.pages[0] ? pageUrl({ session: d.session }, d.slug, d.pages[0].name, revOf(at, { session: d.session }, d.slug, d.pages[0].name)) : null,
        updated_at: d.updated_at,
      };
    },
  },
  {
    kind: "workspace",
    title: "Workspace designs",
    note: "Their own agent, no branch",
    card: (d, at) => {
      const built = builtSession(d.built_in, at.sessions);
      const system = at.systems.find((x) => x.slug === d.system)?.name ?? d.system;
      return {
        key: `workspace/${d.slug}`,
        line: `${system} · ${built ? `built in ${built.name}` : pages(d.pages.length)}`,
        act: { label: "Open", kind: "workspace", slug: d.slug },
        thumb: d.pages[0] ? pageUrl(at.workspace, d.slug, d.pages[0].name, revOf(at, at.workspace, d.slug, d.pages[0].name)) : null,
        updated_at: d.updated_at,
      };
    },
  },
  {
    kind: "project",
    title: "In projects",
    note: "Merged to main: found under docs/design/. Read only; reuse them as a start",
    card: (d, at) => ({
      key: `project/${d.project}/${d.path}`,
      line: `${projectName(at, d.project)} · ${d.path}`,
      act: { label: "Use as a start", kind: "project", design: d },
      thumb: d.pages[0] && d.project ? projectPageUrl(d.project, d.slug, d.pages[0].name) : null,
      updated_at: null,
    }),
  },
];

const projectName = (at: IndexNames, id: string | undefined) => at.projects.find((p) => p.id === id)?.name ?? id ?? "";

/** The Designs index of `list`, `design.list`'s answer: its groups in
 *  order, each in the listing's order, a group with no designs left out. */
export function designsIndex(list: Design[], at: IndexNames): IndexGroup[] {
  return KINDS.map(({ kind, title, note, card }) => ({
    title,
    note,
    cards: list.flatMap((d) => {
      const c = d.kind === kind ? card(d, at) : null;
      return c ? [{ ...c, design: d, name: d.name, placeholder: c.thumb ? null : "No pages yet" }] : [];
    }),
  })).filter((g) => g.cards.length);
}
