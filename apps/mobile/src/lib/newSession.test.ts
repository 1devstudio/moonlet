import { describe, expect, it } from "vitest";
import type { Section } from "@desktop/lib/protocol";
import { MODES, branchPrefix, branchPreview, composer, modeHelp, nameFromPrompt, projectChoices, setupLine, startPoint } from "./newSession";
import { NOW, data, project, workspace } from "./fixtures";

describe("nameFromPrompt and branchPreview", () => {
  // The daemon's own cases (session.rs `names_and_agent_flags`, git.rs `slug`).
  it("names the session after the prompt's first line, as the daemon does", () => {
    expect(nameFromPrompt("")).toBe("Untitled");
    expect(nameFromPrompt("\n  Fix the Login bug!\nmore")).toBe("Fix the Login bug!");
    const n = nameFromPrompt("Refactor the authentication flow so that sessions survive token refresh");
    expect(n).toBe("Refactor the authentication flow so that…");
  });

  it("cuts at a space past byte 24, as the daemon counts, not past character 24", () => {
    // 20 two-byte letters: the space is character 20 but byte 40.
    const prompt = `${"é".repeat(20)} ${"x".repeat(40)}`;
    expect(nameFromPrompt(prompt)).toBe(`${"é".repeat(20)}…`);
    expect(branchPreview(prompt, "moonlet/")).toBe("moonlet/task");
  });

  it("previews the branch the daemon will create", () => {
    expect(branchPreview("Fix the Login bug!", "moonlet/")).toBe("moonlet/fix-the-login-bug");
    expect(branchPreview("***", "moonlet/")).toBe("moonlet/task");
    // Captured from a real daemon's session.create.
    expect(nameFromPrompt("Add a “recently viewed” rail to the product page.")).toBe("Add a “recently viewed” rail to the product…");
    expect(branchPreview("Add a “recently viewed” rail to the product page.", "moonlet/")).toBe("moonlet/add-a-recently-viewed-rail-to-the-product");
  });

  it("takes the project's branch prefix, else the host's, as the daemon does (X55)", () => {
    expect(branchPreview("Fix the Login bug!", "mz/")).toBe("mz/fix-the-login-bug");
    expect(branchPreview("Fix the Login bug!", "")).toBe("fix-the-login-bug");
    expect(branchPrefix({ branch_prefix: "feature/" }, { branch_prefix: "mz/" })).toBe("feature/");
    expect(branchPrefix({ branch_prefix: "" }, { branch_prefix: "mz/" })).toBe("");
    expect(branchPrefix({ branch_prefix: null }, { branch_prefix: "mz/" })).toBe("mz/");
    expect(branchPrefix(null, null)).toBe("moonlet/");
  });
});

describe("startPoint", () => {
  it("is origin's base when the host starts from origin and the project's base is kept (X55)", () => {
    expect(startPoint(null, "main", "origin")).toBe("origin/main");
    expect(startPoint("main", "main", "origin")).toBe("origin/main");
    expect(startPoint(null, "main", "local")).toBe("main");
    // Another base is used as it is, as session.create's `from`.
    expect(startPoint("release/2.1", "main", "origin")).toBe("release/2.1");
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
    expect(modeHelp("manual")).toBe("Claude asks before every edit and command. Approve from Needs you.");
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

describe("composer (X54)", () => {
  // Shaped like `gh.issues` and `gh.prs` replies.
  const issue = { number: 57, title: "Search ignores accents", body: "Searching *creme* misses **Crème brûlée**.", url: "https://github.com/acme/storefront/issues/57" };
  const pr = { number: 214, title: "Product list search", body: "Adds search.", url: "https://github.com/acme/storefront/pull/214", head_branch: "mz/product-search" };
  const none = { typed: "", prefix: "moonlet/", issue: null, pr: null, prContext: null, prSend: true, base: null, projectBase: "main", startFrom: "local" as const, task: null, taskBranch: null, worktree: null };

  it("starts from what the user typed alone, on a new branch named after it", () => {
    const c = composer({ ...none, typed: "Fix the Login bug!" });
    expect(c.attachments).toEqual([]);
    expect(c.placeholder).toBe("What do you want to work on?");
    expect(c.branch).toEqual({ name: "moonlet/fix-the-login-bug", existing: false });
    expect(c.create).toEqual({ prompt: "Fix the Login bug!", name: null, pr: null, from: null });
    expect(composer(none).create).toBeNull();
  });

  it("sends a picked issue first, names the session after it, and can start with nothing typed", () => {
    const c = composer({ ...none, issue });
    expect(c.attachments.map((a) => [a.ref, a.summary, a.note])).toEqual([["#57", "Search ignores accents", " · GitHub issue"]]);
    expect(c.placeholder).toBe("Anything to add? Leave empty to start from the issue.");
    expect(c.create).toEqual({
      prompt: "#57 · Search ignores accents\n\nSearching *creme* misses **Crème brûlée**.\n\nhttps://github.com/acme/storefront/issues/57",
      name: "Search ignores accents",
      pr: null,
      from: null,
    });
    expect(composer({ ...none, issue, typed: "Keep it small" }).create?.prompt.endsWith("issues/57\n\nKeep it small")).toBe(true);
  });

  it("names the new branch after the issue, as the daemon names it after the session", () => {
    expect(composer({ ...none, issue, typed: "Keep it small" }).branch).toEqual({ name: "moonlet/search-ignores-accents", existing: false });
  });

  it("starts on a picked PR's branch and sends its reviews and comments once read", () => {
    const c = composer({ ...none, pr, prContext: "Adds search.\n\n**sam-rivera** reviewed: Debounce the input." });
    expect(c.branch).toEqual({ name: "mz/product-search", existing: true });
    expect(c.placeholder).toBe("What should the agent do on this PR? e.g. “Address the review comments”");
    expect(c.create).toEqual({
      prompt: "PR #214 · Product list search\n\nAdds search.\n\n**sam-rivera** reviewed: Debounce the input.\n\nhttps://github.com/acme/storefront/pull/214",
      name: "Product list search",
      pr: 214,
      from: null,
    });
  });

  it("starts from a picked base other than the project's, and says where the worktree starts", () => {
    const other = composer({ ...none, typed: "Backport the fix", base: "release/2.1", startFrom: "origin" });
    expect(other.create?.from).toBe("release/2.1");
    expect(other.start).toBe("release/2.1");
    const same = composer({ ...none, typed: "Backport the fix", base: "main", startFrom: "origin" });
    expect(same.create?.from).toBeNull();
    expect(same.start).toBe("origin/main");
    // On a PR, its branch: the picked base is not used.
    const onPr = composer({ ...none, pr, base: "release/2.1" });
    expect(onPr.create?.from).toBeNull();
    expect(onPr.start).toBe("mz/product-search");
  });

  it("starts from a task: its description sent first, named after it, on its tracker's branch, linked to it (X57)", () => {
    const task = { ref: { connection: "linear:acme", key: "MOON-151", url: "https://linear.app/acme/issue/MOON-151" }, key: "MOON-151", title: "Drag sessions between sections", description: "Let sessions move between sections." };
    const c = composer({ ...none, task, taskBranch: "moon-151-drag-sessions-between-sections" });
    expect(c.attachments.map((a) => a.lead)).toEqual(["MOON-151 description sent with your message · "]);
    expect(c.branch).toEqual({ name: "moon-151-drag-sessions-between-sections", existing: false });
    expect(c.create).toEqual({
      prompt: "MOON-151 · Drag sessions between sections\nLet sessions move between sections.",
      name: "Drag sessions between sections",
      pr: null,
      from: null,
      task: { connection: "linear:acme", key: "MOON-151", url: "https://linear.app/acme/issue/MOON-151" },
      branch: "moon-151-drag-sessions-between-sections",
    });
    // Started on a worktree without a session: its own branch, adopted.
    const adopted = composer({ ...none, task, taskBranch: null, worktree: { path: "/wt/ssh", branch: "moon-151-ssh-test" } });
    expect(adopted.branch).toEqual({ name: "moon-151-ssh-test", existing: true });
    expect(adopted.create).toMatchObject({ worktree: "/wt/ssh", task: task.ref });
    expect(adopted.create?.branch).toBeUndefined();
    // Until the branch is worked out, it shows quietly and Start waits.
    const waiting = composer({ ...none, task, taskBranch: null });
    expect([waiting.branch.name, waiting.create]).toEqual(["…", null]);
  });

  it("still starts on the PR's branch once its attachment is removed, sending only what was typed", () => {
    const c = composer({ ...none, pr, prSend: false, typed: "Rebase on main" });
    expect(c.attachments).toEqual([]);
    expect(c.create).toEqual({ prompt: "Rebase on main", name: "Product list search", pr: 214, from: null });
  });
});
