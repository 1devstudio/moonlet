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

describe("designsIndex (X65 Designs index)", () => {
  it("groups the designs as In sessions, Workspace designs and In projects, each with what its cards say", () => {
    const list = [
      design({ slug: "onboarding", name: "Onboarding", path: "/Users/alex/.moonlet/design/a1b2c3d4e5f6/designs/onboarding" }),
      design({ slug: "settings-page", name: "Settings page", kind: "session", session: "s7", project: "p-moon", path: "/Users/alex/.moonlet/worktrees/moonlet/settings-page/docs/design/settings-page" }),
      design({ slug: "checkout", name: "Checkout", kind: "project", project: "p-moon", path: "docs/design/checkout", pages: [{ name: "index", label: null }], updated_at: 0 }),
    ];
    expect(designsIndex(list, at)).toEqual([
      {
        title: "In sessions",
        note: "Their pages live in the session's branch; open the session to change them",
        cards: [
          {
            key: "session/s7/settings-page",
            kind: "session",
            slug: "settings-page",
            name: "Settings page",
            line: "moonlet · settings-page · docs/design/settings-page",
            action: "Open session",
            thumb: { place: { session: "s7" }, page: "index" },
            updated_at: 1_761_200_000_000,
          },
        ],
      },
      {
        title: "Workspace designs",
        note: "Their own agent, no branch",
        cards: [
          {
            key: "workspace/onboarding",
            kind: "workspace",
            slug: "onboarding",
            name: "Onboarding",
            line: "moonlet desktop · 3 pages",
            action: "Open",
            thumb: { place: "a1b2c3d4e5f6", page: "index" },
            updated_at: 1_761_200_000_000,
          },
        ],
      },
      {
        title: "In projects",
        note: "Merged to main: found under docs/design/. Read only; reuse them as a start",
        cards: [
          {
            key: "project/p-moon/docs/design/checkout",
            kind: "project",
            slug: "checkout",
            name: "Checkout",
            line: "moonlet · docs/design/checkout",
            action: "Use as a start",
            thumb: null,
            updated_at: null,
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
    expect(designsIndex(list, at)[0].cards.map((c) => [c.line, c.thumb])).toEqual([
      ["moonlet desktop · built in settings-page", { place: "a1b2c3d4e5f6", page: "index" }],
      ["moonlet desktop · 1 page", { place: "a1b2c3d4e5f6", page: "index" }],
      ["moonlet desktop · no pages yet", null],
    ]);
  });

  it("leaves out a group with no designs, and has none without designs", () => {
    expect(designsIndex([design({})], at).map((g) => g.title)).toEqual(["Workspace designs"]);
    expect(designsIndex([], at)).toEqual([]);
  });
});
