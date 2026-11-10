import { describe, expect, it } from "vitest";
import { findFiles, parseFileQuery } from "./openFileQuery";

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
