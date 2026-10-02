import { describe, expect, it } from "vitest";
import { previewDocument, renderMarkdown } from "./markdown";

describe("markdown preview", () => {
  it("renders tables, code and highlights", async () => {
    const html = await renderMarkdown("# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```rust\nfn main() {}\n```\n", false);
    expect(html).toContain("<table>");
    expect(html).toContain("hljs-keyword");
  });

  it("strips scripts, handlers and javascript: links", async () => {
    const html = await renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">x</a><iframe src="https://evil"></iframe>', false);
    expect(html).not.toMatch(/<script|onerror|javascript:|<iframe/);
  });

  it("wraps output in a locked-down document", () => {
    const doc = previewDocument("<p>x</p>");
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toContain("script-src");
  });
});
