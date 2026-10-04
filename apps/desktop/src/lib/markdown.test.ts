import { describe, expect, it } from "vitest";
import { openableUrl, previewDocument, renderChatMarkdown, renderMarkdown } from "./markdown";

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

describe("chat links", () => {
  it("links bare URLs and URLs in inline code", () => {
    expect(renderChatMarkdown("see https://example.com/a?b=1")).toContain('<a href="https://example.com/a?b=1">');
    expect(renderChatMarkdown("open `https://example.com/x`")).toContain('<a href="https://example.com/x"><code>https://example.com/x</code></a>');
  });

  it("leaves other inline code and fenced URLs alone", () => {
    expect(renderChatMarkdown("run `curl https://example.com`")).not.toContain("<a ");
    expect(renderChatMarkdown("```\nhttps://example.com\n```")).not.toContain("<a ");
    const doc = new DOMParser().parseFromString(renderChatMarkdown('`https://x.com/"onmouseover="alert(1)`'), "text/html");
    expect(doc.querySelector("a")?.getAttributeNames()).toEqual(["href"]);
  });

  it("only opens web and mail links", () => {
    expect(openableUrl("https://example.com")).toBe("https://example.com");
    expect(openableUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(openableUrl("javascript:alert(1)")).toBeNull();
    expect(openableUrl("file:///etc/passwd")).toBeNull();
    expect(openableUrl("src/main.rs")).toBeNull();
    expect(openableUrl(null)).toBeNull();
  });
});
