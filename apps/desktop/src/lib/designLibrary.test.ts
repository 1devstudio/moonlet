import { describe, expect, it } from "vitest";
import { changedWorkspaces, sourcesByWorkspace } from "./designLibrary";

describe("a design change (X95)", () => {
  const workspaces = ["a1b2c3d4e5f6", "f6e5d4c3b2a1"];

  it("is every workspace's when it is in a library design system, and the library's own, for its shared designs", () => {
    expect(
      changedWorkspaces({ workspace: "library", system: "acme-web", paths: ["styles.css"] }, workspaces),
    ).toEqual(["a1b2c3d4e5f6", "f6e5d4c3b2a1", "library"]);
  });

  it("is its own workspace's otherwise", () => {
    expect(
      changedWorkspaces(
        { workspace: "a1b2c3d4e5f6", system: null, design: "pricing", paths: ["pages/index.html"] },
        workspaces,
      ),
    ).toEqual(["a1b2c3d4e5f6"]);
  });
});

describe("a new design system's source projects (X95)", () => {
  const workspaces = [
    { id: "a1b2c3d4e5f6", name: "Acme app" },
    { id: "f6e5d4c3b2a1", name: "Acme site" },
    { id: "0123456789ab", name: "Empty" },
  ];
  const projects: Record<string, { id: string; name: string }[]> = {
    a1b2c3d4e5f6: [{ id: "p-web", name: "acme-web" }, { id: "p-mobile", name: "acme-mobile" }],
    f6e5d4c3b2a1: [{ id: "p-site", name: "acme-site" }, { id: "p-web", name: "acme-web" }],
  };

  it("are every workspace's, the shown one's first, each project once and a workspace without any left out", () => {
    expect(sourcesByWorkspace(workspaces, "f6e5d4c3b2a1", (ws) => projects[ws] ?? [])).toEqual([
      { workspace: { id: "f6e5d4c3b2a1", name: "Acme site" }, projects: [{ id: "p-site", name: "acme-site" }, { id: "p-web", name: "acme-web" }] },
      { workspace: { id: "a1b2c3d4e5f6", name: "Acme app" }, projects: [{ id: "p-mobile", name: "acme-mobile" }] },
    ]);
  });
});
