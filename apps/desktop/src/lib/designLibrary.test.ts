import { describe, expect, it } from "vitest";
import { changedWorkspaces } from "./designLibrary";

describe("a design change (X95)", () => {
  const workspaces = ["a1b2c3d4e5f6", "f6e5d4c3b2a1"];

  it("is every workspace's when it is in a library design system", () => {
    expect(
      changedWorkspaces({ workspace: "library", system: "acme-web", paths: ["styles.css"] }, workspaces),
    ).toEqual(["a1b2c3d4e5f6", "f6e5d4c3b2a1"]);
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
