import { describe, expect, it } from "vitest";
import { completionModel, moveHighlight } from "./completion";

const dir = (name: string) => ({ name, kind: "dir" as const });
const file = (name: string) => ({ name, kind: "file" as const });

describe("completion popup (T8)", () => {
  it("lists directories, then files, each alphabetically, with the typed prefix to bold", () => {
    expect(completionModel([file("cipher.md"), dir("cipher-sdd"), dir("cipher-paas"), file("other")], "cipher")).toEqual([
      { name: "cipher-paas", kind: "dir", label: "Directory", match: 6, insert: "cipher-paas/" },
      { name: "cipher-sdd", kind: "dir", label: "Directory", match: 6, insert: "cipher-sdd/" },
      { name: "cipher.md", kind: "file", label: "File", match: 6, insert: "cipher.md " },
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
