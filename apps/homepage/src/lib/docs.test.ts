import { describe, expect, it } from "vitest";
import { allDocs } from "./content";
import { docLinks, docsNav, editUrl, findDoc, firstDoc, neighbours, parseDoc, renderDoc } from "./docs";

const ALWAYS_ON = `---
title: Add an always-on host
description: A Mac mini or a Linux VPS that stays on.
group: Mesh
order: 1
tags: [5 minutes, macOS or Linux]
---

## Before you start

Both machines need to be on the same tailnet.
`;

describe("parseDoc", () => {
  it("reads a page's front matter and body, and names it after its file", () => {
    const doc = parseDoc("add-an-always-on-host.md", ALWAYS_ON);
    expect(doc).toEqual({
      slug: "add-an-always-on-host",
      title: "Add an always-on host",
      description: "A Mac mini or a Linux VPS that stays on.",
      group: "Mesh",
      order: 1,
      tags: ["5 minutes", "macOS or Linux"],
      body: "\n## Before you start\n\nBoth machines need to be on the same tailnet.\n",
    });
  });

  it("fails with the file's name when the front matter lacks a title, an order or a known group", () => {
    expect(() => parseDoc("draft.md", "---\ngroup: Mesh\norder: 2\n---\nText")).toThrow(
      "content/docs/draft.md: front matter needs a title",
    );
    expect(() => parseDoc("draft.md", "---\ntitle: Draft\ngroup: Mesh\n---\nText")).toThrow(
      "content/docs/draft.md: front matter needs a number for order",
    );
    expect(() => parseDoc("draft.md", "---\ntitle: Draft\ngroup: Blog\norder: 1\n---\nText")).toThrow(
      "content/docs/draft.md: group must be one of Start here, Mesh, Work, Reference",
    );
  });
});

const page = (file: string, title: string, group: string, order: number) =>
  parseDoc(file, `---\ntitle: ${title}\ngroup: ${group}\norder: ${order}\n---\nText`);

// Shuffled on purpose: the sidebar orders groups as the design does, pages by order.
const PAGES = [
  page("glossary.md", "Glossary", "Reference", 3),
  page("heavy-commands.md", "Heavy commands", "Mesh", 3),
  page("introduction.md", "Introduction", "Start here", 1),
  page("add-an-always-on-host.md", "Add an always-on host", "Mesh", 1),
  page("installation.md", "Installation", "Start here", 2),
];

describe("docsNav", () => {
  it("lists the groups in the design's order, each page by its order, and leaves out empty groups", () => {
    expect(docsNav(PAGES)).toEqual([
      { title: "Start here", pages: [{ slug: "introduction", title: "Introduction" }, { slug: "installation", title: "Installation" }] },
      { title: "Mesh", pages: [{ slug: "add-an-always-on-host", title: "Add an always-on host" }, { slug: "heavy-commands", title: "Heavy commands" }] },
      { title: "Reference", pages: [{ slug: "glossary", title: "Glossary" }] },
    ]);
  });

  it("marks the page being read, and only that one", () => {
    const current = docsNav(PAGES, "heavy-commands")
      .flatMap((g) => g.pages)
      .filter((p) => p.current)
      .map((p) => p.slug);
    expect(current).toEqual(["heavy-commands"]);
  });
});

describe("neighbours", () => {
  it("links the pages before and after in sidebar order, across groups", () => {
    expect(neighbours(PAGES, "installation")).toEqual({
      previous: { slug: "introduction", title: "Introduction" },
      next: { slug: "add-an-always-on-host", title: "Add an always-on host" },
    });
  });

  it("has no previous page before the first, and no next page after the last", () => {
    expect(neighbours(PAGES, "introduction")).toEqual({ next: { slug: "installation", title: "Installation" } });
    expect(neighbours(PAGES, "glossary")).toEqual({ previous: { slug: "heavy-commands", title: "Heavy commands" } });
  });
});

describe("renderDoc", () => {
  it("gives each ## and ### heading an id, and lists them for On this page", () => {
    const { html, headings } = renderDoc(
      "## Before you start\n\nText.\n\n### Let it take *heavy* commands\n\n## Before you start\n\n## What's new in 0.1?\n",
    );
    expect(headings).toEqual([
      { depth: 2, text: "Before you start", id: "before-you-start" },
      { depth: 3, text: "Let it take heavy commands", id: "let-it-take-heavy-commands" },
      { depth: 2, text: "Before you start", id: "before-you-start-2" },
      { depth: 2, text: "What's new in 0.1?", id: "what-s-new-in-0-1" },
    ]);
    expect(html).toContain('<h2 id="before-you-start">Before you start</h2>');
    expect(html).toContain('<h3 id="let-it-take-heavy-commands">Let it take <em>heavy</em> commands</h3>');
    expect(html).toContain('<h2 id="before-you-start-2">Before you start</h2>');
  });

  it("never gives two headings the same id, even when one's text looks like a numbered repeat", () => {
    const { headings } = renderDoc("## Foo\n\n## Foo\n\n## Foo 2\n\n## !!!\n");
    expect(headings.map((h) => h.id)).toEqual(["foo", "foo-2", "foo-2-2", "section"]);
  });

  it("renders a blockquote that starts with Note: as the design's note, and leaves other quotes alone", () => {
    const { html } = renderDoc("> **Note:** A code works once, for five minutes.\n\n> Plain quote.\n");
    expect(html).toContain('<div role="note" class="alert-box alert-box--note alert-box--note-wide"><p>A code works once, for five minutes.</p>\n</div>');
    expect(html).toContain("<blockquote>\n<p>Plain quote.</p>\n</blockquote>");
  });

  it("highlights a toml fence with the design system's hljs classes", () => {
    const { html } = renderDoc('```toml\n[heavy]\ncommands = ["pnpm test"]\n```\n');
    expect(html).toBe(
      '<pre><code class="hljs language-toml"><span class="hljs-section">[heavy]</span>\n' +
        '<span class="hljs-attr">commands</span> = [<span class="hljs-string">&quot;pnpm test&quot;</span>]</code></pre>\n',
    );
  });
});


describe("docLinks", () => {
  it("lists the docs pages a body links to, without their #fragment", () => {
    expect(
      docLinks("See [heavy commands](/docs/heavy-commands#approve) and [the repo](https://github.com/1devstudio/moonlet), then [pair](/docs/pair-your-phone)."),
    ).toEqual(["heavy-commands", "pair-your-phone"]);
  });

  it("finds only pages that exist, in every file of content/docs", () => {
    const docs = allDocs();
    const broken = docs.flatMap((d) =>
      docLinks(d.body)
        .filter((slug) => !findDoc(docs, slug))
        .map((slug) => `${d.slug}.md -> /docs/${slug}`),
    );
    expect(broken).toEqual([]);
  });
});

describe("firstDoc and findDoc", () => {
  it("opens /docs on the first page of the first group", () => {
    expect(firstDoc(PAGES).slug).toBe("introduction");
  });

  it("finds a page by its slug, and nothing for a slug no page has", () => {
    expect(findDoc(PAGES, "glossary")?.title).toBe("Glossary");
    expect(findDoc(PAGES, "nope")).toBeUndefined();
  });
});

describe("editUrl", () => {
  it("links a page to its Markdown file on main", () => {
    expect(editUrl("heavy-commands")).toBe(
      "https://github.com/1devstudio/moonlet/blob/main/apps/homepage/content/docs/heavy-commands.md",
    );
  });
});

describe("code highlighting", () => {
  it("highlights sh, json and ts fences too", () => {
    const { html } = renderDoc(
      '```sh\nmoonlet ls # list sessions\n```\n\n```json\n{"ok": true}\n```\n\n```ts\nconst max = 3;\n```\n',
    );
    expect(html).toBe(
      '<pre><code class="hljs language-sh">moonlet <span class="hljs-built_in">ls</span> <span class="hljs-comment"># list sessions</span></code></pre>\n' +
        '<pre><code class="hljs language-json"><span class="hljs-punctuation">{</span><span class="hljs-attr">&quot;ok&quot;</span><span class="hljs-punctuation">:</span> <span class="hljs-literal"><span class="hljs-keyword">true</span></span><span class="hljs-punctuation">}</span></code></pre>\n' +
        '<pre><code class="hljs language-ts"><span class="hljs-keyword">const</span> max = <span class="hljs-number">3</span>;</code></pre>\n',
    );
  });
});
