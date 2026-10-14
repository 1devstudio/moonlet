import { describe, expect, it } from "vitest";
import type { Section } from "@desktop/lib/protocol";
import { MODES, branchPreview, modeHelp, nameFromPrompt, projectChoices, setupLine } from "./newSession";
import { NOW, data, project, workspace } from "./fixtures";

describe("nameFromPrompt and branchPreview", () => {
  // The daemon's own cases (session.rs `names_and_agent_flags`, git.rs `slug`).
  it("names the session after the prompt's first line, as the daemon does", () => {
    expect(nameFromPrompt("")).toBe("Untitled");
    expect(nameFromPrompt("\n  Fix the Login bug!\nmore")).toBe("Fix the Login bug!");
    const n = nameFromPrompt("Refactor the authentication flow so that sessions survive token refresh");
    expect(n).toBe("Refactor the authentication flow so that…");
  });

  it("previews the branch the daemon will create", () => {
    expect(branchPreview("Fix the Login bug!")).toBe("moonlet/fix-the-login-bug");
    expect(branchPreview("***")).toBe("moonlet/task");
    // Captured from a real daemon's session.create.
    expect(nameFromPrompt("Add a “recently viewed” rail to the product page.")).toBe("Add a “recently viewed” rail to the product…");
    expect(branchPreview("Add a “recently viewed” rail to the product page.")).toBe("moonlet/add-a-recently-viewed-rail-to-the-product");
  });
});

describe("setupLine", () => {
  it("says where the worktree comes from and what setup runs", () => {
    expect(setupLine("main", "This Mac", "pnpm install")).toBe("Creates a worktree from main on This Mac and runs setup: pnpm install");
    expect(setupLine("develop", "devbox", null)).toBe("Creates a worktree from develop on devbox");
  });
});

describe("modes", () => {
  it("offers the design's four modes, Manual first chosen", () => {
    expect(MODES.map((m) => [m.label, m.id])).toEqual([
      ["Auto", "auto"],
      ["Manual", "manual"],
      ["Edits", "acceptEdits"],
      ["Plan", "plan"],
    ]);
    expect(modeHelp("manual")).toBe("Claude asks before every edit and command. Approve from the Inbox.");
    expect(modeHelp("plan")).toBe("Claude explores and proposes a plan before touching anything.");
  });
});

describe("projectChoices", () => {
  const section = (id: string, project_ids: string[]): Section => ({ id, name: id, project_ids, view: { group_by: "project", sort_by: "recent", filter: [] }, created_at: NOW });
  const hosts = {
    mac: { id: "mac", label: "This Mac", status: "connected" as const, via: null },
    "mac/devbox": { id: "mac/devbox", label: "devbox", status: "connected" as const, via: "This Mac" },
    gpu: { id: "gpu", label: "gpu-box", status: "error" as const, via: "This Mac" },
  };
  const d = {
    mac: data({
      workspaces: [{ ...workspace("p", "Personal"), section_ids: ["a"] }, { ...workspace("w", "Work"), section_ids: ["b"] }],
      sections: [section("a", ["storefront", "changedeck"]), section("b", ["storefront"])],
      projects: [project("storefront", "storefront"), project("changedeck", "changedeck")],
    }),
    "mac/devbox": data({
      workspaces: [{ ...workspace("p", "Personal"), section_ids: ["c"] }],
      sections: [section("c", ["payments"])],
      projects: [project("payments", "payments-api")],
    }),
    gpu: data({ workspaces: [{ ...workspace("p", "Personal"), section_ids: ["d"] }], sections: [section("d", ["ml"])], projects: [project("ml", "ml")] }),
  };

  it("lists the workspace's projects on connected hosts, once each, with the workspace to create in", () => {
    expect(projectChoices(hosts, d, "Personal").map((c) => [c.host, c.project.name, c.workspaceId])).toEqual([
      ["mac", "storefront", "p"],
      ["mac", "changedeck", "p"],
      ["mac/devbox", "payments-api", "p"],
    ]);
    expect(projectChoices(hosts, d, "Work").map((c) => c.project.name)).toEqual(["storefront"]);
    expect(projectChoices(hosts, d, null).map((c) => c.project.name)).toEqual(["storefront", "changedeck", "payments-api"]);
  });
});
