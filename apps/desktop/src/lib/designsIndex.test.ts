import { describe, expect, it } from "vitest";
import type { Design } from "./protocol";
import { designsIndex } from "./designsIndex";

const design = (over: Partial<Design>): Design => ({
  slug: "settings-page",
  name: "Settings page",
  kind: "workspace",
  system: "moonlet-desktop",
  path: "/Users/alex/.moonlet/design/a1b2c3d4e5f6/designs/settings-page",
  pages: [
    { name: "index", label: "rows" },
    { name: "git-a", label: "cards" },
    { name: "git-b", label: "compact" },
  ],
  updated_at: 1_761_200_000_000,
  open_comments: 0,
  agent: null,
  agent_state: null,
  needs_you: null,
  error: null,
  ...over,
});

const at = {
  workspace: "a1b2c3d4e5f6",
  sessions: [{ id: "s7", name: "settings-page", project_id: "p-moon", path: "/Users/alex/.moonlet/worktrees/moonlet/settings-page" }],
  projects: [{ id: "p-moon", name: "moonlet" }],
  systems: [{ slug: "moonlet-desktop", name: "moonlet desktop" }],
};

/** What the index shows: each group's title and note, and each card's
 *  name, line, button, thumbnail and placeholder. */
const shown = (list: Design[]) =>
  designsIndex(list, at).map((g) => ({ title: g.title, note: g.note, cards: g.cards.map((c) => ({ name: c.name, line: c.line, action: c.act.label, thumb: c.thumb, placeholder: c.placeholder })) }));

describe("designsIndex (X65 Designs index)", () => {
  it("groups the designs as In sessions, Workspace designs and In projects, each with what its cards say", () => {
    const list = [
      design({ slug: "onboarding", name: "Onboarding", path: "/Users/alex/.moonlet/design/a1b2c3d4e5f6/designs/onboarding" }),
      design({ slug: "settings-page", name: "Settings page", kind: "session", session: "s7", project: "p-moon", path: "/Users/alex/.moonlet/worktrees/moonlet/settings-page/docs/design/settings-page" }),
      design({ slug: "checkout", name: "Checkout", kind: "project", project: "p-moon", path: "docs/design/checkout", pages: [{ name: "index", label: null }], updated_at: 0 }),
    ];
    expect(shown(list)).toEqual([
      {
        title: "In sessions",
        note: "Their pages live in the session's branch; open the session to change them",
        cards: [
          {
            name: "Settings page",
            line: "moonlet · settings-page · docs/design/settings-page",
            action: "Open session",
            thumb: "moonlet-design://19a1c555a197e847.s-s7/settings-page/pages/index.html",
            placeholder: null,
          },
        ],
      },
      {
        title: "Workspace designs",
        note: "Their own agent, no branch",
        cards: [{ name: "Onboarding", line: "moonlet desktop · 3 pages", action: "Open", thumb: "moonlet-design://163f264033417147.a1b2c3d4e5f6/designs/onboarding/pages/index.html", placeholder: null }],
      },
      {
        title: "In projects",
        note: "Merged to main: found under docs/design/. Read only; reuse them as a start",
        cards: [
          {
            name: "Checkout",
            line: "moonlet · docs/design/checkout",
            action: "Use as a start",
            thumb: "moonlet-design://f9ebfb4c1d9878d0s42fbb229c28a2459.p-p-moon/checkout/pages/index.html",
            placeholder: null,
          },
        ],
      },
    ]);
  });

  it("says a workspace design built in a session is built there, in place of its page count, and one page or none as such", () => {
    const list = [
      design({ slug: "empty-states", name: "Empty states", built_in: { session: "s7", project: "p-moon" } }),
      design({ slug: "one", name: "One", pages: [{ name: "index", label: null }] }),
      design({ slug: "blank", name: "Blank", pages: [] }),
    ];
    expect(shown(list)[0].cards.map((c) => [c.line, c.thumb, c.placeholder])).toEqual([
      ["moonlet desktop · built in settings-page", "moonlet-design://549859d2b6e08dd2.a1b2c3d4e5f6/designs/empty-states/pages/index.html", null],
      ["moonlet desktop · 1 page", "moonlet-design://abdc69590a52018e.a1b2c3d4e5f6/designs/one/pages/index.html", null],
      ["moonlet desktop · no pages yet", null, "No pages yet"],
    ]);
  });

  it("leaves out a group with no designs, and has none without designs", () => {
    expect(shown([design({})]).map((g) => g.title)).toEqual(["Workspace designs"]);
    expect(shown([])).toEqual([]);
  });

  it("opens a session design's session, a workspace design's screen, and starts a workspace design from a project design", () => {
    const session = design({ kind: "session", session: "s7", path: "/wt/docs/design/settings-page" });
    const own = design({ slug: "onboarding" });
    const merged = design({ slug: "checkout", kind: "project", project: "p-moon", path: "docs/design/checkout" });
    expect(designsIndex([session, own, merged], at).flatMap((g) => g.cards.map((c) => c.act))).toEqual([
      { label: "Open session", kind: "session", session: "s7", slug: "settings-page" },
      { label: "Open", kind: "workspace", slug: "onboarding" },
      { label: "Use as a start", kind: "project", design: merged },
    ]);
  });
});
