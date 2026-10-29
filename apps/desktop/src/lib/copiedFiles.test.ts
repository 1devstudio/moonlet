import { describe, expect, it } from "vitest";
import { addPattern, listNote, removePattern } from "./copiedFiles";

describe("a project's copied files (X74)", () => {
  it("the_default_list_is_env_and_env_star", () => {
    expect(listNote({ patterns: [".env", ".env.*"], cloud: false, default: true })).toBe("The default: .env files in any folder.");
    expect(listNote({ patterns: ["config/local.yaml"], cloud: false, default: false })).toBeNull();
  });

  it("adds a pattern once, trimmed", () => {
    expect(addPattern([".env"], "  config/local.yaml ")).toEqual({ patterns: [".env", "config/local.yaml"] });
    expect(addPattern([".env"], ".env")).toEqual({ error: ".env is already in the list." });
  });

  it("a_refused_pattern_says_why", () => {
    expect(addPattern([], "!.env")).toEqual({ error: "A pattern cannot take files back (!)." });
    expect(addPattern([], "../secrets")).toEqual({ error: "A pattern stays inside the worktree (..)." });
    expect(addPattern([], "~/.aws/credentials")).toEqual({ error: "A pattern is relative to the worktree." });
    expect(addPattern([], "   ")).toEqual({ error: "Type a pattern, such as .env.local." });
  });

  it("removes a pattern", () => {
    expect(removePattern([".env", ".env.*"], ".env")).toEqual([".env.*"]);
  });
});
