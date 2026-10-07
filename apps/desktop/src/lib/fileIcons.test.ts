import { describe, expect, it } from "vitest";
import { fileIcon } from "./fileIcons";

describe("fileIcon (X25)", () => {
  it("picks the icons of the reference design's files", () => {
    expect(fileIcon(".audit-allowlist.json")).toBe("json");
    expect(fileIcon(".gitlab-ci.yml")).toBe("gitlab");
    expect(fileIcon("cloudbuild.migrate.yaml")).toBe("yaml");
    expect(fileIcon(".gitignore")).toBe("git");
    expect(fileIcon(".npmrc")).toBe("npm");
    expect(fileIcon(".nvmrc")).toBe("nodejs");
    expect(fileIcon(".prettierignore")).toBe("prettier");
    expect(fileIcon(".prettierrc.json")).toBe("prettier");
    expect(fileIcon(".env")).toBe("tune");
    expect(fileIcon("AGENTS.md")).toBe("markdown");
    expect(fileIcon("CODEOWNERS")).toBe("codeowners");
  });

  it("has no icon for an unknown file, so it gets the plain one", () => {
    expect(fileIcon(".trivyignore")).toBeNull();
    expect(fileIcon(".acmeco-local-cli-digest")).toBeNull();
    expect(fileIcon("notes.unknownext")).toBeNull();
  });
});

describe("fileIcon precedence (X25)", () => {
  it("prefers the longest known extension", () => {
    expect(fileIcon("store.test.ts")).toBe("test-ts");
    expect(fileIcon("protocol.d.ts")).toBe("typescript-def");
    expect(fileIcon("store.ts")).toBe("typescript");
    expect(fileIcon("archive.tar.gz")).toBe("zip");
  });

  it("prefers a known name over the extension", () => {
    expect(fileIcon("package.json")).toBe("nodejs");
    expect(fileIcon("tsconfig.app.json")).toBe("tsconfig");
    expect(fileIcon("pnpm-lock.yaml")).toBe("pnpm");
    expect(fileIcon("vite.config.ts")).toBe("vite");
  });

  it("ignores case", () => {
    expect(fileIcon("Dockerfile")).toBe("docker");
    expect(fileIcon("README.md")).toBe("readme");
    expect(fileIcon("LOGO.PNG")).toBe("image");
  });

  it("does not read a leading dot as an extension", () => {
    expect(fileIcon(".rs")).toBeNull();
  });
});
