import { describe, expect, it } from "vitest";
import type { Design, ToolCall } from "./protocol";
import { opensDesignView, worktreeFile } from "./sessionDesign";

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
