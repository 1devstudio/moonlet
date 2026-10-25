import { describe, expect, it } from "vitest";
import type { Design, DesignSystem } from "./protocol";
import { designRow, designSlug, picksInWorkspace, systemFolder, systemLabel } from "./design";

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
