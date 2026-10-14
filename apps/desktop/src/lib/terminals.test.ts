import { describe, expect, it } from "vitest";
import { shortPath } from "./terminals";

describe("shortPath", () => {
  it("shortens a path under the home folder to ~, as a new chat shows its folder (X38)", () => {
    expect(shortPath("/Users/jane/code/app", "/Users/jane")).toBe("~/code/app");
    expect(shortPath("/Users/jane", "/Users/jane")).toBe("~");
    expect(shortPath("/Users/janet/app", "/Users/jane")).toBe("/Users/janet/app");
    expect(shortPath("/srv/app", null)).toBe("/srv/app");
  });
});
