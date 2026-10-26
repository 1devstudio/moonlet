import { describe, expect, it } from "vitest";
import type { Design, DesignSystem, ToolCall } from "./protocol";
import { designMark, designPanelWidth, designSystemFooter, designTab, opensDesignView, slashMenu, worktreeFile } from "./sessionDesign";

const design = (over: Partial<Design> = {}): Design => ({
  slug: "settings-page",
  name: "Settings page",
  kind: "session",
  system: "moonlet-desktop",
  path: "/Users/alex/.moonlet/worktrees/moonlet/settings-page/docs/design/settings-page",
  pages: [{ name: "index", label: null }],
  updated_at: 0,
  open_comments: 0,
  agent: 31,
  agent_state: "idle",
  needs_you: null,
  error: null,
  session: "4f2a9c1e7b3d",
  project: "p-moonlet",
  ...over,
});

describe("the file above a session design's page (X65)", () => {
  it("is the page's path in the worktree", () => {
    expect(worktreeFile("/Users/alex/.moonlet/worktrees/moonlet/settings-page", design(), "index")).toBe("docs/design/settings-page/pages/index.html");
    expect(worktreeFile("/Users/alex/.moonlet/worktrees/moonlet/settings-page/", design(), "git-a")).toBe("docs/design/settings-page/pages/git-a.html");
    // A design folder the project's config puts elsewhere in the worktree.
    expect(worktreeFile("/wt/s", design({ path: "/wt/s/design/prototypes/onboarding" }), "index")).toBe("design/prototypes/onboarding/pages/index.html");
  });
});

describe("a session's row in Sessions mode (X65)", () => {
  it("shows the pen icon while the session has a design, titled with its designs", () => {
    expect(designMark([])).toBeNull();
    expect(designMark([design()])).toBe("Design: Settings page");
    expect(designMark([design(), design({ slug: "onboarding", name: "Onboarding" })])).toBe("Designs: Settings page, Onboarding");
  });
});

describe("the chat's note that the Design view opened (X65)", () => {
  const bash = (command: string, status: ToolCall["status"] = "ok"): ToolCall => ({ name: "Bash", summary: command, input: { command, description: "Make the session design" }, status });

  it("follows the agent's design new --here once it ran", () => {
    expect(opensDesignView(bash('"$MOONLET_BIN" design new --here "Prototype the page from the agreed requirements"'))).toBe(true);
    expect(opensDesignView(bash('/Applications/moonlet.app/Contents/MacOS/moonlet design new --system moonlet-desktop --here "Settings page"'))).toBe(true);
  });

  it("is not there for a workspace design, another command, or a run that failed or is still going", () => {
    expect(opensDesignView(bash('"$MOONLET_BIN" design new --system moonlet-desktop "Onboarding screens"'))).toBe(false);
    expect(opensDesignView(bash('"$MOONLET_BIN" design check --here settings-page'))).toBe(false);
    expect(opensDesignView(bash('"$MOONLET_BIN" design new --here "Settings page"', "error"))).toBe(false);
    expect(opensDesignView(bash('"$MOONLET_BIN" design new --here "Settings page"', "running"))).toBe(false);
    expect(opensDesignView({ name: "Read", summary: "docs/design/settings-page/design.toml", input: { file_path: "docs/design/settings-page/design.toml" }, status: "ok" })).toBe(false);
  });
});

describe("the chat input's slash menu in a session (X65)", () => {
  const footer = "Uses moonlet desktop, the design system built from this project";
  const forms = [
    { value: "/moonlet-design", hint: "Prototype it here, in this session's Design view" },
    { value: "/moonlet-design new", hint: "A separate design in Design mode, with its own agent" },
    { value: "/moonlet-design sync", hint: "Sync the design system built from this project" },
  ];

  it("lists /moonlet-design, /moonlet-design new and /moonlet-design sync, each with what it does, and a footer naming the design system", () => {
    expect(slashMenu(["compact", "review", "moonlet-design"], "/moon", { start: 0, query: "moon" }, { footer })).toEqual({ rows: forms, footer });
    // The agent's other commands follow, as they match.
    expect(slashMenu(["compact", "moonlet-design"], "/", { start: 0, query: "" }, { footer })).toEqual({ rows: [...forms, { value: "/compact", hint: null }], footer });
  });

  it("is the agent's commands alone outside a session, mid-message, or when the query is another command's", () => {
    expect(slashMenu(["compact", "moonlet-design"], "/moon", { start: 0, query: "moon" }, null)).toEqual({ rows: [{ value: "/moonlet-design", hint: null }], footer: null });
    expect(slashMenu(["compact", "moonlet-design"], "then /moon", { start: 5, query: "moon" }, { footer })).toEqual({ rows: [{ value: "/moonlet-design", hint: null }], footer: null });
    expect(slashMenu(["compact", "moonlet-design"], "/comp", { start: 0, query: "comp" }, { footer })).toEqual({ rows: [{ value: "/compact", hint: null }], footer: null });
  });
});

describe("the slash menu before the session's design systems are listed (X65)", () => {
  it("still lists /moonlet-design's three forms, with no footer until the design system it will use is known", () => {
    expect(slashMenu(["compact"], "/moon", { start: 0, query: "moon" }, { footer: null })).toEqual({
      rows: [
        { value: "/moonlet-design", hint: "Prototype it here, in this session's Design view" },
        { value: "/moonlet-design new", hint: "A separate design in Design mode, with its own agent" },
        { value: "/moonlet-design sync", hint: "Sync the design system built from this project" },
      ],
      footer: null,
    });
  });
});

describe("the design system /moonlet-design will use (X65)", () => {
  const system = (slug: string, name: string, sources: string[]): DesignSystem => ({
    slug,
    name,
    sources,
    synced_at: null,
    synced_commit: null,
    cards: 0,
    layouts: 0,
    changed_sources: [],
    check_problems: 0,
    to_settle: 0,
    step: null,
    step_summary: null,
    error: null,
    agent: null,
    last_sync: [],
    needs_you: null,
    steps: [],
    sync_running: false,
  });

  it("is the one built from the session's project, as design new --here picks it, or which to pick, or how to make one", () => {
    const desktop = system("moonlet-desktop", "moonlet desktop", ["/Users/alex/Workspace/moonlet"]);
    const mobile = system("moonlet-mobile", "moonlet mobile", ["/Users/alex/Workspace/moonlet"]);
    const shop = system("storefront", "storefront", ["/Users/alex/Workspace/shop"]);
    expect(designSystemFooter([desktop, shop], "/Users/alex/Workspace/moonlet")).toBe("Uses moonlet desktop, the design system built from this project");
    expect(designSystemFooter([desktop, mobile, shop], "/Users/alex/Workspace/moonlet")).toBe("Asks which design system to use: moonlet desktop or moonlet mobile, both built from this project");
    expect(designSystemFooter([shop], "/Users/alex/Workspace/moonlet")).toBe("No design system is built from this project yet: /moonlet-design sync builds one");
  });
});

describe("a session's Design tab in its right panel (X65)", () => {
  it("is there while the session has a design, counting the open comments of its designs", () => {
    expect(designTab([])).toBeNull();
    expect(designTab([design({ open_comments: 2 }), design({ slug: "onboarding", open_comments: 1 })])).toEqual({ count: 3 });
    expect(designTab([design()])).toEqual({ count: 0 });
  });

  it("widens the right panel to 55% of the window until the user drags it", () => {
    expect(designPanelWidth(null, 1440)).toBe(792);
    expect(designPanelWidth(640, 1440)).toBe(640);
  });
});
