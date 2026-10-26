import { describe, expect, it } from "vitest";
import type { Design } from "./protocol";
import { worktreeFile } from "./sessionDesign";

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
