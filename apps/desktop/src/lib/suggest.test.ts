import { expect, it } from "vitest";
import { commonPrefix, firstWord, suggest } from "./suggest";

const h = ["git status", "git stash pop", "cargo test --workspace", "git stash list"];

it("suggests from the newest matching entry", () => {
  expect(suggest(h, "git st")).toBe("ash list");
  expect(suggest(h, "cargo")).toBe(" test --workspace");
  expect(suggest(h, "Git")).toBeNull();
  expect(suggest(h, "")).toBeNull();
  expect(suggest(h, "git status")).toBeNull();
});

it("accepts one word at a time", () => {
  expect(firstWord(" test --workspace")).toBe(" test");
  expect(firstWord("ash list")).toBe("ash");
});

it("finds the common prefix of completions", () => {
  expect(commonPrefix(["src/", "scripts/"])).toBe("s");
  expect(commonPrefix(["README.md"])).toBe("README.md");
  expect(commonPrefix([])).toBe("");
});
