import { describe, expect, it } from "vitest";
import { workspaceChoices } from "./workspaceChoices";
import { workspace } from "./fixtures";

describe("workspaceChoices", () => {
  it("lists each workspace name once, in the order hosts give them, with the first host's colour", () => {
    const mac = [workspace("p", "Personal"), { ...workspace("w", "Work"), color: "blue" as const }];
    const devbox = [{ ...workspace("p2", "Personal"), color: "violet" as const }, workspace("s", "Side projects")];
    expect(workspaceChoices([mac, devbox])).toEqual([
      { name: "Personal", color: "clay" },
      { name: "Work", color: "blue" },
      { name: "Side projects", color: "clay" },
    ]);
  });
});
