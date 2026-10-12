import { describe, expect, it } from "vitest";
import { completionInsert, completionModel, moveHighlight } from "./completion";

const dir = (name: string) => ({ name, kind: "dir" as const });
const file = (name: string) => ({ name, kind: "file" as const });

describe("completion popup (T8)", () => {
  it("lists directories, then files, each alphabetically, with the typed prefix to bold", () => {
    expect(completionModel([file("acme.md"), dir("acme-web"), dir("acme-api"), file("other")], "acme")).toEqual([
      { name: "acme-api", kind: "dir", label: "Directory", match: 4, insert: "acme-api/" },
      { name: "acme-web", kind: "dir", label: "Directory", match: 4, insert: "acme-web/" },
      { name: "acme.md", kind: "file", label: "File", match: 4, insert: "acme.md " },
    ]);
  });

  it("hides dotfiles unless the stem starts with a dot", () => {
    expect(completionModel([dir(".git"), file(".env"), file("env.ts")], "").map((c) => c.name)).toEqual(["env.ts"]);
    expect(completionModel([dir(".git"), file(".env"), file("env.ts")], ".").map((c) => c.name)).toEqual([".git", ".env"]);
  });

  it("completes commands with a trailing space", () => {
    expect(completionModel([{ name: "terraform", kind: "command" }, { name: "tee", kind: "command" }], "te")).toEqual([
      { name: "tee", kind: "command", label: "Command", match: 2, insert: "tee " },
      { name: "terraform", kind: "command", label: "Command", match: 2, insert: "terraform " },
    ]);
  });

  it("keeps at most 200 rows", () => {
    const many = Array.from({ length: 250 }, (_, i) => file(`f${String(i).padStart(3, "0")}`));
    expect(completionModel(many, "f")).toHaveLength(200);
  });

  it("moves the highlight with wrap-around", () => {
    expect(moveHighlight(3, 2, 1)).toBe(0);
    expect(moveHighlight(3, 0, -1)).toBe(2);
    expect(moveHighlight(3, 1, 1)).toBe(2);
  });
});

describe("text a completion inserts (T8)", () => {
  it("escapes characters the shell would split or expand", () => {
    expect(completionModel([file("my notes (1).txt")], "my")[0].insert).toBe("my\\ notes\\ \\(1\\).txt ");
    expect(completionModel([dir("it's")], "it")[0].insert).toBe("it\\'s/");
  });

  it("extends to the prefix common to every match, not only the rows shown", () => {
    const many = [...Array.from({ length: 200 }, (_, i) => file(`aa${String(i).padStart(3, "0")}`)), file("ab000")];
    expect(completionInsert(many, "a")).toBe("a");
  });

  it("completes a single match whole, and the shared prefix of several escaped", () => {
    expect(completionInsert([dir("src")], "s")).toBe("src/");
    expect(completionInsert([file("my file a"), file("my file b")], "m")).toBe("my\\ file\\ ");
  });
});
