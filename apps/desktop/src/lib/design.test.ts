import { describe, expect, it } from "vitest";
import type { Design, DesignSystem } from "./protocol";
import { briefShown, designAgentState, designOpenAction, isDesignModeChange, workspaceDesigns, designsEmpty, designSubtitle, designRow, designSlug, newDesignReady, newDesignSystem, systemSummary, picksInWorkspace, systemFolder, systemLabel } from "./design";

const NOW = 1_761_200_000_000;
const DAY = 86_400_000;

const system = (over: Partial<DesignSystem>): DesignSystem => ({
  slug: "moonlet-desktop",
  name: "moonlet desktop",
  sources: ["/Users/alex/Workspace/moonlet"],
  synced_at: NOW - 3 * DAY,
  synced_commit: "9c1e0a2",
  cards: 45,
  layouts: 4,
  changed_sources: [],
  check_problems: 0,
  to_settle: 0,
  step: null,
  step_summary: null,
  error: null,
  agent: 7,
  last_sync: [],
  needs_you: null,
  steps: [],
  sync_running: false,
  ...over,
});

describe("a design system's sidebar row (X65)", () => {
  it("shows its age once synced", () => {
    expect(systemLabel(system({}), NOW, false)).toEqual({ text: "3d", tone: "muted" });
    expect(systemLabel(system({ synced_at: NOW - 16 * DAY }), NOW, false)).toEqual({ text: "2w", tone: "muted" });
    expect(systemLabel(system({ synced_at: NOW - 5 * 3_600_000 }), NOW, false)).toEqual({ text: "5h", tone: "muted" });
    expect(systemLabel(system({ synced_at: NOW - 12 * 60_000 }), NOW, false)).toEqual({ text: "12m", tone: "muted" });
    expect(systemLabel(system({ synced_at: NOW - 20_000 }), NOW, false)).toEqual({ text: "now", tone: "muted" });
  });

  it("counts the source files changed since the sync", () => {
    expect(systemLabel(system({ changed_sources: ["src/ui.tsx", "src/Sidebar.tsx", "src/Toolbar.tsx"] }), NOW, false)).toEqual({ text: "3 changed", tone: "changed" });
  });

  it("counts what waits to be settled, before what changed", () => {
    expect(systemLabel(system({ to_settle: 2, changed_sources: ["src/ui.tsx"] }), NOW, false)).toEqual({ text: "2 to settle", tone: "changed" });
  });

  it("says syncing while its agent works on a sync or the first build", () => {
    expect(systemLabel(system({ step: "cards", to_settle: 2, sync_running: true }), NOW, true)).toEqual({ text: "syncing", tone: "muted" });
    expect(systemLabel(system({ synced_at: null, cards: 0, layouts: 0, sync_running: true }), NOW, true)).toEqual({ text: "syncing", tone: "muted" });
    // A turn of the agent after the sync was recorded, such as the user's chat, is no sync.
    expect(systemLabel(system({ sync_running: false }), NOW, true)).toEqual({ text: "3d", tone: "muted" });
  });

  it("stops saying syncing once its agent stopped without recording the sync", () => {
    // A re-sync left midway shows what it showed before.
    expect(systemLabel(system({ step: "cards", to_settle: 2 }), NOW, false)).toEqual({ text: "2 to settle", tone: "changed" });
    // A first build left midway was never built.
    expect(systemLabel(system({ synced_at: null, step: "tokens" }), NOW, false)).toEqual({ text: "not built", tone: "muted" });
  });

  it("says needs you over everything while its agent waits for an answer or an approval", () => {
    expect(systemLabel(system({ step: "inventory", needs_you: { kind: "question", text: "Which button set is current?" } }), NOW, false)).toEqual({ text: "needs you", tone: "attention" });
  });

  it("says not built when it never synced and has no agent", () => {
    expect(systemLabel(system({ synced_at: null, agent: null }), NOW, false)).toEqual({ text: "not built", tone: "muted" });
  });

  it("says unreadable when its folder could not be read", () => {
    expect(systemLabel(system({ error: "cannot read config.toml" }), NOW, false)).toEqual({ text: "unreadable", tone: "error" });
  });
});

describe("the New design system dialog's folder (X64)", () => {
  // The same cases as moonlet-core's design/store.rs a_slug_is_lowercase_letters_and_digits_joined_by_dashes.
  it("names the folder as the daemon will", () => {
    expect(designSlug("moonlet desktop")).toBe("moonlet-desktop");
    expect(designSlug("  Moonlet Desktop! ")).toBe("moonlet-desktop");
    expect(designSlug("Café UI")).toBe("caf-ui");
    expect(designSlug("App 2.0")).toBe("app-2-0");
    expect(designSlug("---")).toBe("design-system");
  });

  it("shows no folder until the workspace's systems are listed, as a used name would change it", () => {
    expect(systemFolder("w-1devstudio", "moonlet desktop", undefined)).toBeNull();
  });

  it("shows where it will be, numbered as the daemon numbers a used name", () => {
    expect(systemFolder("w-1devstudio", "moonlet desktop", [])).toBe("~/.moonlet/design/w-1devstudio/systems/moonlet-desktop");
    expect(systemFolder("w-1devstudio", "moonlet desktop", ["moonlet-desktop", "moonlet-desktop-2"])).toBe("~/.moonlet/design/w-1devstudio/systems/moonlet-desktop-3");
  });
});

describe("the projects a design system is built from (X64)", () => {
  it("are only the picked ones still in the workspace", () => {
    expect(picksInWorkspace(["p-web", "p-api", "p-gone"], ["p-api", "p-web", "p-docs"])).toEqual(["p-web", "p-api"]);
    expect(picksInWorkspace(["p-gone"], ["p-web"])).toEqual([]);
  });
});

const design = (over: Partial<Design>): Design => ({
  slug: "settings-page",
  name: "Settings page",
  kind: "workspace",
  system: "moonlet-desktop",
  path: "/Users/alex/.moonlet/design/w1/designs/settings-page",
  brief: "A left nav",
  viewport: "1440x900",
  pages: [{ name: "index", label: null }],
  updated_at: NOW - 2 * DAY,
  open_comments: 0,
  agent: 12,
  agent_state: "idle",
  needs_you: null,
  error: null,
  ...over,
});

describe("a design's agent's state (X65)", () => {
  it("is its chat's live state, else the one design.list gave, and none without an agent", () => {
    expect(designAgentState(design({ agent_state: "idle" }), "working")).toBe("working");
    expect(designAgentState(design({ agent_state: "idle" }), undefined)).toBe("idle");
    expect(designAgentState(design({ agent: null, agent_state: null }), "working")).toBeNull();
  });
});

describe("a design's sidebar row (X65)", () => {
  it("shows its agent's state and its age", () => {
    expect(designRow(design({}), NOW, "done")).toEqual({ state: "done", text: "2d", tone: "muted", comments: false });
    expect(designRow(design({ updated_at: NOW - 30_000 }), NOW, "working")).toEqual({ state: "working", text: "now", tone: "muted", comments: false });
  });

  it("counts its open comments in place of its age", () => {
    expect(designRow(design({ open_comments: 3 }), NOW, "idle")).toEqual({ state: "idle", text: "3", tone: "muted", comments: true });
  });

  it("says needs you while its agent asks a question or waits for an approval", () => {
    expect(designRow(design({ open_comments: 3, needs_you: { kind: "approval", text: "Bash: rm -rf assets" } }), NOW, "blocked")).toEqual({
      state: "blocked",
      text: "needs you",
      tone: "attention",
      comments: false,
    });
  });

  it("has no dot without an agent, and says unreadable when its design.toml could not be read", () => {
    expect(designRow(design({ agent: null, agent_state: null }), NOW, null)).toEqual({ state: null, text: "2d", tone: "muted", comments: false });
    expect(designRow(design({ error: "cannot read design.toml" }), NOW, null)).toEqual({ state: null, text: "unreadable", tone: "error", comments: false });
  });
});

describe("the New design dialog (X65)", () => {
  it("says what the picked design system holds, when it was synced and from where", () => {
    const projects = [{ path: "/Users/alex/Workspace/moonlet", name: "moonlet" }];
    expect(systemSummary(system({ cards: 11, layouts: 2 }), projects, NOW)).toBe("moonlet desktop: 11 cards, 2 layouts, synced 3 days ago from moonlet");
    expect(systemSummary(system({ cards: 1, layouts: 0, synced_at: null, sources: ["/Users/alex/Workspace/shop"] }), [], NOW)).toBe("moonlet desktop: 1 card, 0 layouts, not synced yet, from shop");
    // A system built from no project yet says nothing of where it is from.
    expect(systemSummary(system({ cards: 0, layouts: 0, synced_at: null, sources: [] }), [], NOW)).toBe("moonlet desktop: 0 cards, 0 layouts, not synced yet");
  });

  it("creates a design once it has a name, a design system the workspace has and a brief", () => {
    const systems = ["moonlet-desktop", "storefront"];
    expect(newDesignReady({ name: "Settings page", system: "storefront", brief: "A left nav" }, systems)).toEqual({ ready: true, why: null });
    expect(newDesignReady({ name: "  ", system: "storefront", brief: "A left nav" }, systems)).toEqual({ ready: false, why: "Name the design" });
    expect(newDesignReady({ name: "Settings page", system: "", brief: "A left nav" }, [])).toEqual({ ready: false, why: "A design starts from a design system" });
    expect(newDesignReady({ name: "Settings page", system: "gone", brief: "A left nav" }, systems)).toEqual({ ready: false, why: "A design starts from a design system" });
    expect(newDesignReady({ name: "Settings page", system: "storefront", brief: "\n " }, systems)).toEqual({ ready: false, why: "Say what to design: the brief is Claude's first message" });
  });

  it("picks the shown design system, else the first, also when the list comes after it opened", () => {
    // Opened with ⇧⌘N before design.systems answered: nothing to pick yet.
    expect(newDesignSystem("", [], undefined)).toBe("");
    // Then the list arrives.
    expect(newDesignSystem("", ["moonlet-desktop", "storefront"], undefined)).toBe("moonlet-desktop");
    expect(newDesignSystem("", ["moonlet-desktop", "storefront"], "storefront")).toBe("storefront");
    // The user's pick stays, while the workspace has it.
    expect(newDesignSystem("storefront", ["moonlet-desktop", "storefront"], "moonlet-desktop")).toBe("storefront");
    expect(newDesignSystem("gone", ["moonlet-desktop", "storefront"], undefined)).toBe("moonlet-desktop");
  });
});

describe("design.open in the app (X65)", () => {
  const sessions = [{ id: "s1", name: "Fix checkout button" }];

  it("shows the design when the user asked for it", () => {
    expect(designOpenAction({ workspace: "w1", slug: "settings-page", name: "Settings page" }, sessions)).toEqual({ kind: "show" });
  });

  it("offers it in a toast, and leaves the focus where it is, when an agent started it", () => {
    expect(designOpenAction({ workspace: "w1", slug: "settings-page", name: "Settings page", spawned_by: 4, session: "s1" }, sessions)).toEqual({
      kind: "toast",
      text: "Fix checkout button started the design Settings page",
    });
    expect(designOpenAction({ workspace: "w1", slug: "onboarding", name: "Onboarding", spawned_by: 9 }, sessions)).toEqual({ kind: "toast", text: "An agent started the design Onboarding" });
  });

  it("leaves a session design to its session's Design tab, never the design screen", () => {
    expect(designOpenAction({ workspace: "w1", slug: "settings-page", name: "Settings page", session: "s1", kind: "session" }, sessions)).toEqual({ kind: "none" });
  });
});

describe("design.changed in Design mode (X65)", () => {
  it("is a workspace's design folder's, and a session design's is left to its session's Design tab", () => {
    expect(isDesignModeChange({ workspace: "w1", system: null, design: "settings-page", paths: ["pages/index.html"] })).toBe(true);
    expect(isDesignModeChange({ workspace: "w1", system: null, design: "settings-page", session: "s1", paths: ["pages/index.html"] })).toBe(false);
  });
});

describe("the designs Design mode lists (X65)", () => {
  it("are the workspace designs of design.list, its session and project designs left to their own places", () => {
    const listed: Design[] = [
      design({ slug: "settings-page", kind: "workspace" }),
      design({ slug: "checkout", kind: "session", session: "s1", project: "p1" }),
      design({ slug: "onboarding", kind: "project", project: "p1", path: "docs/design/onboarding" }),
    ];
    expect(workspaceDesigns(listed).map((d) => d.slug)).toEqual(["settings-page"]);
  });
});

describe("the design's chat (X65)", () => {
  it("shows the first message as the brief alone, since the README and the design rules went with it", () => {
    const sent = "A left nav and a Git section\n\n---\nThis is the design \"Settings page\" in this folder. Its README.md:\n\n# moonlet desktop";
    expect(briefShown(sent, "A left nav and a Git section", true)).toBe("A left nav and a Git section");
    // Any other message shows as it was sent.
    expect(briefShown("Two more variants", "A left nav and a Git section", true)).toBeNull();
    expect(briefShown("A left nav and a Git section", "A left nav and a Git section", true)).toBeNull();
    expect(briefShown("anything", "", true)).toBeNull();
  });

  it("keeps a later message that starts with the brief, or a first one not as the daemon sends it, whole", () => {
    const sent = "A left nav and a Git section\n\n---\nThis is the design \"Settings page\" in this folder. Its README.md:\n\n# moonlet desktop";
    expect(briefShown(sent, "A left nav and a Git section", false)).toBeNull();
    expect(briefShown("A left nav and a Git section, and a search field", "A left nav and a Git section", true)).toBeNull();
    expect(briefShown("A left nav and a Git section\n\n---\nmy own notes", "A left nav and a Git section", true)).toBeNull();
  });

  it("shows the first message whole when an older daemon's design.list gives no brief", () => {
    const sent = "A left nav and a Git section\n\n---\nThis is the design \"Settings page\" in this folder. Its README.md:\n\n# moonlet desktop";
    expect(briefShown(sent, undefined, true)).toBeNull();
  });
});

describe("the design screen's header (X65)", () => {
  it("names the design system and counts the pages, or says there are none yet", () => {
    expect(designSubtitle("moonlet desktop", 3)).toBe("moonlet desktop · 3 pages");
    expect(designSubtitle("moonlet desktop", 1)).toBe("moonlet desktop · 1 page");
    expect(designSubtitle("moonlet desktop", 0)).toBe("moonlet desktop · no pages yet");
  });
});

describe("the sidebar's Designs when it has none (X65)", () => {
  it("says a design starts from a design system, or that there are no designs yet, once listed", () => {
    expect(designsEmpty([], [])).toBe("A design starts from a design system.");
    expect(designsEmpty(undefined, [])).toBe("A design starts from a design system.");
    expect(designsEmpty([], [system({})])).toBe("No designs yet.");
    expect(designsEmpty([design({})], [system({})])).toBeNull();
    // Nothing before either is listed.
    expect(designsEmpty(undefined, undefined)).toBeNull();
    expect(designsEmpty(undefined, [system({})])).toBeNull();
  });
});
