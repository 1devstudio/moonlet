import { describe, expect, it } from "vitest";
import { fileToOpen, linkToOpen, linkToolbarPosition, openableUrl, previewDocument, renderChatMarkdown, renderMarkdown, renderTaskMarkdown } from "./markdown";

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

  it("sizes its text with the app's text scale", () => {
    expect(previewDocument("<p>x</p>")).toContain("font:14px/1.65");
    const doc = previewDocument("<p>x</p>", 1.5);
    expect(doc).toContain("font:21px/1.65");
    expect(doc).toContain("code{font:18.75px");
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

  it("opens on ⌘-click or Enter, not a plain click, and only web and mail links", () => {
    expect(linkToOpen("https://example.com", { metaKey: true, keyboard: false })).toBe("https://example.com");
    expect(linkToOpen("https://example.com", { metaKey: false, keyboard: true })).toBe("https://example.com");
    expect(linkToOpen("https://example.com", { metaKey: false, keyboard: false })).toBeNull();
    expect(linkToOpen("src/main.rs", { metaKey: true, keyboard: true })).toBeNull();
  });

  it("puts the toolbar above the link, or below it near the window top", () => {
    const win = { width: 800, height: 600 };
    expect(linkToolbarPosition({ left: 100, top: 300, bottom: 318 }, win)).toEqual({ left: 100, bottom: 302 });
    expect(linkToolbarPosition({ left: 100, top: 20, bottom: 38 }, win)).toEqual({ left: 100, top: 40 });
    expect(linkToolbarPosition({ left: 790, top: 300, bottom: 318 }, win).left).toBe(728);
  });
});

describe("file links in chat (X30)", () => {
  // Every path counts as a project file, so these tests see the path rules alone.
  const md = (source: string) => renderChatMarkdown(source, () => true);

  it("links a project path in inline code", () => {
    expect(md("open `src/lib/chat.ts`")).toContain('<a href="src/lib/chat.ts" data-file="src/lib/chat.ts"><code>src/lib/chat.ts</code></a>');
  });

  it("links bare file names only with a file-type extension, and never paths that leave the project", () => {
    expect(md("see `README.md`")).toContain('<a href="README.md" data-file="README.md"><code>README.md</code></a>');
    expect(md("see `Cargo.toml:3`")).toContain('<a href="Cargo.toml" data-file="Cargo.toml" data-line="3">');
    for (const s of ["`item.text`", "`e.metaKey`", "`1.2.3`", "`../secret.txt`", "`src/../../x.md`", "`/etc/passwd.txt`", "`~/notes.md`", "`run src/a.ts`"]) {
      expect(md(s), s).not.toContain("<a ");
    }
  });

  it("links paths with a directory in plain text, keeping the punctuation around them", () => {
    expect(md("I changed apps/desktop/src/lib/markdown.ts:42, then (docs/specs/X9-chat-links.md).")).toBe(
      '<p>I changed <a href="apps/desktop/src/lib/markdown.ts" data-file="apps/desktop/src/lib/markdown.ts" data-line="42">apps/desktop/src/lib/markdown.ts:42</a>, then (<a href="docs/specs/X9-chat-links.md" data-file="docs/specs/X9-chat-links.md">docs/specs/X9-chat-links.md</a>).</p>\n',
    );
  });

  it("links prose paths with underscores and dotfiles", () => {
    expect(md("See pkg/__init__.py and config/.eslintrc.json, but __bold__ stays bold.")).toBe(
      '<p>See <a href="pkg/__init__.py" data-file="pkg/__init__.py">pkg/__init__.py</a> and <a href="config/.eslintrc.json" data-file="config/.eslintrc.json">config/.eslintrc.json</a>, but <strong>bold</strong> stays bold.</p>\n',
    );
    expect(md("`.eslintrc.json`")).toContain('data-file=".eslintrc.json"');
  });

  it("leaves bare names, versions, URLs and fenced code in plain text alone", () => {
    for (const s of ["Built on Node.js and README.md", "bump to 1.2.3", "and/or so", "see https://example.com/src/a.ts", "```\nsrc/a.ts\n```", "/etc/hosts.txt", "~/notes/a.md", "../up/a.md"]) {
      expect(md(s), s).not.toContain("data-file");
    }
  });

  it("marks Markdown links to project files as file links", () => {
    expect(md("[the spec](docs/specs/X9-chat-links.md)")).toBe('<p><a href="docs/specs/X9-chat-links.md" data-file="docs/specs/X9-chat-links.md">the spec</a></p>\n');
    expect(md("[home](https://example.com/a.md)")).not.toContain("data-file");
    expect(md("[up](../a.md)")).not.toContain("data-file");
  });

  it("opens a file link inside the session's worktree, at its line", () => {
    const click = { selecting: false };
    expect(fileToOpen({ file: "src/lib/chat.ts", line: "12" }, "/Users/me/repo", click)).toEqual({ path: "/Users/me/repo/src/lib/chat.ts", line: 12 });
    expect(fileToOpen({ file: "./README.md", line: null }, "/Users/me/repo/", click)).toEqual({ path: "/Users/me/repo/README.md" });
    expect(fileToOpen({ file: "../secret.md", line: null }, "/Users/me/repo", click)).toBeNull();
    expect(fileToOpen({ file: null, line: null }, "/Users/me/repo", click)).toBeNull();
    expect(fileToOpen({ file: "README.md", line: null }, "", click)).toBeNull();
  });

  it("opens nothing when the click ended a text selection", () => {
    expect(fileToOpen({ file: "src/lib/chat.ts", line: "12" }, "/Users/me/repo", { selecting: true })).toBeNull();
  });

  it("links only files that exist in the project when given its file list", () => {
    const files = new Set(["src/lib/chat.ts", "README.md"]);
    const exists = (path: string) => files.has(path);
    const html = renderChatMarkdown("Changed `src/lib/chat.ts:3`, ./README.md and src/lib/gone.ts; see `notes.md` and [old](docs/old.md).", exists);
    expect(html).toBe(
      '<p>Changed <a href="src/lib/chat.ts" data-file="src/lib/chat.ts" data-line="3"><code>src/lib/chat.ts:3</code></a>, <a href="./README.md" data-file="./README.md">./README.md</a> and src/lib/gone.ts; see <code>notes.md</code> and <a href="docs/old.md">old</a>.</p>\n',
    );
  });

  it("links no path while the project's file list is unknown", () => {
    expect(renderChatMarkdown("Changed `src/lib/chat.ts`, docs/specs/X9-chat-links.md and [it](src/a.ts).")).toBe(
      '<p>Changed <code>src/lib/chat.ts</code>, docs/specs/X9-chat-links.md and <a href="src/a.ts">it</a>.</p>\n',
    );
  });
});

describe("a task's description (X46)", () => {
  const parse = (html: string) => new DOMParser().parseFromString(html, "text/html").body;

  it("shows checklist items as ticked or unticked boxes", () => {
    // Jira's taskList as moonlet-trackers writes it.
    const body = parse(renderTaskMarkdown("- [ ] Add Evolve endpoints\n- [x] Add the alerting endpoint"));
    const items = [...body.querySelectorAll("li")].map((li) => [li.textContent?.trim(), li.querySelector("[aria-label]")?.getAttribute("aria-label")]);
    expect(items).toEqual([
      ["Add Evolve endpoints", "Not done"],
      ["Add the alerting endpoint", "Done"],
    ]);
  });

  it("shows an image as a link to it, named by its alt text", () => {
    const body = parse(renderTaskMarkdown("Before:\n\n![Safari console](https://example.com/console.png)\n\n![](https://example.com/after.png)"));
    expect(body.querySelector("img")).toBeNull();
    expect([...body.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent])).toEqual([
      ["https://example.com/console.png", "Image: Safari console"],
      ["https://example.com/after.png", "Image"],
    ]);
  });

  it("leaves out HTML comments, as GitHub does, except in code", () => {
    // An issue template's hints, as `gh issue view --json body` prints them.
    const body = parse(renderTaskMarkdown("### Steps\n<!-- What did you do? -->\nPress Checkout.\n\n<!--\nScreenshots help.\n-->\n\n```html\n<!-- kept -->\n```"));
    expect(body.textContent?.replace(/\s+/g, " ").trim()).toBe("Steps Press Checkout. <!-- kept -->");
  });
});

