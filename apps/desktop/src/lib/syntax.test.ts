import { describe, expect, it } from "vitest";
import { createSyntax, editorLanguage, resolveEditorTheme } from "./syntax";

describe("editor language of a file (X26)", () => {
  it("picks Shiki's language by the file's name, then its extension", () => {
    expect(editorLanguage("App.tsx")).toBe("tsx");
    expect(editorLanguage("store.ts")).toBe("typescript");
    expect(editorLanguage("Cargo.toml")).toBe("toml");
    expect(editorLanguage("main.rs")).toBe("rust");
    expect(editorLanguage("install.sh")).toBe("shellscript");
    expect(editorLanguage(".env")).toBe("dotenv");
    expect(editorLanguage(".env.local")).toBe("dotenv");
    expect(editorLanguage("Makefile")).toBe("make");
    expect(editorLanguage("Dockerfile")).toBe("docker");
    expect(editorLanguage("README.md")).toBe("markdown");
  });

  it("shows an unknown file as plain text", () => {
    expect(editorLanguage(".trivyignore")).toBe("plaintext");
    expect(editorLanguage("notes.unknownext")).toBe("plaintext");
  });
});

describe("editor colour theme setting (X26)", () => {
  it("keeps a known dark theme and falls back to Dark+", () => {
    expect(resolveEditorTheme("github-dark")).toBe("github-dark");
    expect(resolveEditorTheme(undefined)).toBe("dark-plus");
    expect(resolveEditorTheme("no-such-theme")).toBe("dark-plus");
    expect(resolveEditorTheme("github-light")).toBe("dark-plus");
  });
});

describe("editor colours (X26)", () => {
  it("colours TypeScript with Dark+'s TextMate colours", async () => {
    // No time limit: a busy machine would otherwise leave the line half coloured.
    const syntax = createSyntax({ timeLimitMs: 0 });
    await syntax.load("typescript", "dark-plus");
    const line = "const a = 1;";
    const { tokens } = syntax.tokenize("typescript", line, syntax.initial);
    const rules = syntax.theme().rules;
    const colourAt = (i: number) => {
      const token = [...tokens].reverse().find((t) => t.startIndex <= i)!;
      return rules.find((r) => r.token === token.scopes)?.foreground?.toUpperCase();
    };
    expect(colourAt(line.indexOf("const"))).toBe("569CD6");
    expect(colourAt(line.indexOf("1"))).toBe("B5CEA8");
    expect(colourAt(line.indexOf(";"))).toBe("D4D4D4");
  });
});
