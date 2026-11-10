import { describe, expect, it } from "vitest";
import { findFiles, openFileMessage, parseFileQuery, rangeLabel, rangeToShow } from "./openFileQuery";

describe("what is typed in Open file (X96)", () => {
  it("reads a file name with a line range", () => {
    expect(parseFileQuery("tenant-acme.yaml:49-53")).toEqual({ name: "tenant-acme.yaml", line: 49, endLine: 53 });
  });

  it("reads a single line, and ignores a column", () => {
    expect(parseFileQuery("app.ts:12")).toEqual({ name: "app.ts", line: 12 });
    expect(parseFileQuery("src/app.ts:12:7")).toEqual({ name: "src/app.ts", line: 12 });
  });

  it("reads a name alone, ignoring spaces around it and a leading ./", () => {
    expect(parseFileQuery("  ./src/app.ts  ")).toEqual({ name: "src/app.ts" });
  });

  it("turns a backwards range around", () => {
    expect(parseFileQuery("tenant-acme.yaml:53-49")).toEqual({ name: "tenant-acme.yaml", line: 49, endLine: 53 });
  });

  it("opens with no line for line 0 or a trailing colon", () => {
    expect(parseFileQuery("app.ts:0")).toEqual({ name: "app.ts" });
    expect(parseFileQuery("app.ts:")).toEqual({ name: "app.ts" });
  });

  it("reads a range ending at line 0 as its first line only", () => {
    expect(parseFileQuery("app.ts:5-0")).toEqual({ name: "app.ts", line: 5 });
  });

  it("keeps a one-line range as one line", () => {
    expect(parseFileQuery("app.ts:7-7")).toEqual({ name: "app.ts", line: 7 });
  });
});

describe("which files match in Open file (X96)", () => {
  const files = [
    "README.md",
    "config/tenants/tenant-acme.yaml.bak",
    "deploy/old/config/tenants/tenant-acme.yaml",
    "config/tenants/tenant-acme.yaml",
    "config/tenants/tenant-globex.yaml",
    "src/app.ts",
    "src/apps/index.ts",
    "test/app.test.ts",
  ];

  it("puts the exact name first, shortest path first, then names that start with it", () => {
    expect(findFiles(files, "tenant-acme.yaml")).toEqual([
      "config/tenants/tenant-acme.yaml",
      "deploy/old/config/tenants/tenant-acme.yaml",
      "config/tenants/tenant-acme.yaml.bak",
    ]);
  });

  it("ignores case", () => {
    expect(findFiles(files, "README.MD")).toEqual(["README.md"]);
  });

  it("matches a typed path against the end of a file's path first", () => {
    expect(findFiles(files, "old/config/tenants/tenant-acme.yaml")[0]).toBe("deploy/old/config/tenants/tenant-acme.yaml");
  });

  it("lists the rest by the fuzzy match, the file name before the directory", () => {
    expect(findFiles(files, "app")).toEqual(["src/app.ts", "test/app.test.ts", "src/apps/index.ts"]);
    expect(findFiles(files, "tglobex")).toEqual(["config/tenants/tenant-globex.yaml"]);
  });

  it("lists nothing for an empty name or one nothing matches", () => {
    expect(findFiles(files, "")).toEqual([]);
    expect(findFiles(files, "zzz")).toEqual([]);
  });

  it("keeps at most 50 rows", () => {
    const many = Array.from({ length: 80 }, (_, i) => `src/file${i}.ts`);
    expect(findFiles(many, "file")).toHaveLength(50);
  });
});

describe("what Open file says (X96)", () => {
  it("names the line or range typed beside the field", () => {
    expect(rangeLabel({ name: "a.yaml", line: 49, endLine: 53 })).toBe("lines 49–53");
    expect(rangeLabel({ name: "a.yaml", line: 12 })).toBe("line 12");
    expect(rangeLabel({ name: "a.yaml" })).toBe("");
  });

  it("asks for a name, waits for the files, then says when nothing matches", () => {
    expect(openFileMessage("", null, 0)).toBe("Type a file name");
    expect(openFileMessage("app", null, 0)).toBe("Loading files…");
    expect(openFileMessage("zzz", ["src/app.ts"], 0)).toBe("No file matches “zzz”");
    expect(openFileMessage("app", ["src/app.ts"], 1)).toBeNull();
  });
});

describe("where the editor goes (X96)", () => {
  /** A file of 60 lines, each 15 characters long (column 16 is a line's end). */
  const file = { lineCount: 60, lineEnd: () => 16 };

  it("puts the cursor at the start of a line", () => {
    expect(rangeToShow(12, undefined, file)).toEqual({ startLineNumber: 12, startColumn: 1, endLineNumber: 12, endColumn: 1 });
  });

  it("selects a range from the start of its first line to the end of its last", () => {
    expect(rangeToShow(49, 53, file)).toEqual({ startLineNumber: 49, startColumn: 1, endLineNumber: 53, endColumn: 16 });
  });

  it("goes to the last line for a line past the end of the file", () => {
    expect(rangeToShow(90, undefined, file)).toEqual({ startLineNumber: 60, startColumn: 1, endLineNumber: 60, endColumn: 1 });
    expect(rangeToShow(55, 90, file)).toEqual({ startLineNumber: 55, startColumn: 1, endLineNumber: 60, endColumn: 16 });
  });

  it("goes nowhere without a line", () => {
    expect(rangeToShow(undefined, undefined, file)).toBeNull();
  });
});
