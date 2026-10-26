// The Designs index (X65): the workspace's designs as cards in three
// groups, In sessions, Workspace designs and In projects, each saying what
// it is and what its button does. Pure: the listing is designStore.ts, the
// view components/design/DesignsIndex.tsx.

import type { Design, DesignKind } from "./protocol";
import type { DesignPlace } from "./designPlace";
import { inWorktree } from "./sessionDesign";

/** A design's card in the index. `thumb`: its first page, framed on its
 *  place's host; null without a page, or for a project design, which is in
 *  the base branch's git objects and on no disk the scheme serves from.
 *  `updated_at`: its newest change, null for a project design, which has
 *  none of its own. */
export interface IndexCard {
  key: string;
  kind: DesignKind;
  slug: string;
  name: string;
  line: string;
  action: "Open session" | "Open" | "Use as a start";
  thumb: { place: DesignPlace; page: string } | null;
  updated_at: number | null;
}

export interface IndexGroup {
  title: "In sessions" | "Workspace designs" | "In projects";
  note: string;
  cards: IndexCard[];
}

/** What the index names designs by: the workspace's sessions (with their
 *  worktrees), projects and design systems. */
export interface IndexNames {
  workspace: string;
  sessions: { id: string; name: string; project_id: string; path: string }[];
  projects: { id: string; name: string }[];
  systems: { slug: string; name: string }[];
}

const pages = (n: number) => (n === 0 ? "no pages yet" : `${n} page${n === 1 ? "" : "s"}`);

/** The Designs index of `list`, `design.list`'s answer: its groups in
 *  order, each in the listing's order, a group with no designs left out. */
export function designsIndex(list: Design[], at: IndexNames): IndexGroup[] {
  const session = (id: string | undefined) => at.sessions.find((s) => s.id === id);
  const project = (id: string | undefined) => at.projects.find((p) => p.id === id)?.name ?? id ?? "";
  const first = (d: Design, place: DesignPlace) => (d.pages[0] ? { place, page: d.pages[0].name } : null);
  const groups: IndexGroup[] = [
    {
      title: "In sessions",
      note: "Their pages live in the session's branch; open the session to change them",
      cards: list
        .filter((d) => d.kind === "session" && d.session)
        .map((d) => {
          const s = session(d.session);
          const folder = s ? inWorktree(s.path, d.path) : d.path;
          return {
            key: `session/${d.session}/${d.slug}`,
            kind: d.kind,
            slug: d.slug,
            name: d.name,
            line: [project(s?.project_id ?? d.project), s?.name ?? d.session, folder].join(" · "),
            action: "Open session" as const,
            thumb: first(d, { session: d.session! }),
            updated_at: d.updated_at,
          };
        }),
    },
    {
      title: "Workspace designs",
      note: "Their own agent, no branch",
      cards: list
        .filter((d) => d.kind === "workspace")
        .map((d) => {
          const built = d.built_in && session(d.built_in.session);
          const system = at.systems.find((x) => x.slug === d.system)?.name ?? d.system;
          return {
            key: `workspace/${d.slug}`,
            kind: d.kind,
            slug: d.slug,
            name: d.name,
            line: `${system} · ${built ? `built in ${built.name}` : pages(d.pages.length)}`,
            action: "Open" as const,
            thumb: first(d, at.workspace),
            updated_at: d.updated_at,
          };
        }),
    },
    {
      title: "In projects",
      note: "Merged to main: found under docs/design/. Read only; reuse them as a start",
      cards: list
        .filter((d) => d.kind === "project")
        .map((d) => ({
          key: `project/${d.project}/${d.path}`,
          kind: d.kind,
          slug: d.slug,
          name: d.name,
          line: `${project(d.project)} · ${d.path}`,
          action: "Use as a start" as const,
          thumb: null,
          updated_at: null,
        })),
    },
  ];
  return groups.filter((g) => g.cards.length);
}
