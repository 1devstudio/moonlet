// The docs pages (X85): Markdown files with front matter, turned into the
// sidebar, previous and next links, "On this page" and the page's HTML.
import matter from "gray-matter";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import ini from "highlight.js/lib/languages/ini";
import json from "highlight.js/lib/languages/json";
import typescript from "highlight.js/lib/languages/typescript";
import { Marked, type Tokens } from "marked";

// The fences the docs use; `toml` is an alias of `ini`, `sh` of `bash`.
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("json", json);
hljs.registerLanguage("typescript", typescript);

export const GROUPS = ["Start here", "Mesh", "Work", "Reference"] as const;
export type Group = (typeof GROUPS)[number];

export interface Doc {
  slug: string;
  title: string;
  description: string;
  group: Group;
  order: number;
  tags: string[];
  body: string;
}

/** Reads one page. `file` is its name in content/docs, such as `glossary.md`. */
export function parseDoc(file: string, source: string): Doc {
  const { data, content } = matter(source);
  const fail = (why: string): never => {
    throw new Error(`content/docs/${file}: ${why}`);
  };
  if (typeof data.title !== "string" || !data.title) fail("front matter needs a title");
  if (typeof data.order !== "number") fail("front matter needs a number for order");
  if (!GROUPS.includes(data.group)) fail(`group must be one of ${GROUPS.join(", ")}`);
  const tags = data.tags ?? [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) fail("tags must be a list of words");
  return {
    slug: file.replace(/\.md$/, ""),
    title: data.title,
    description: typeof data.description === "string" ? data.description : "",
    group: data.group,
    order: data.order,
    tags,
    body: content,
  };
}

export interface NavPage {
  slug: string;
  title: string;
  /** The page being read: its sidebar entry is marked. */
  current?: true;
}

export interface NavGroup {
  title: Group;
  pages: NavPage[];
}

/** The sidebar: groups in the design's order, each page by `order`, empty groups left out. */
export function docsNav(docs: Doc[], current?: string): NavGroup[] {
  return GROUPS.map((title) => ({
    title,
    pages: docs
      .filter((d) => d.group === title)
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
      .map(({ slug, title }) => (slug === current ? { slug, title, current: true as const } : { slug, title })),
  })).filter((g) => g.pages.length > 0);
}

export interface Neighbours {
  previous?: NavPage;
  next?: NavPage;
}

/** The pages before and after `slug` in sidebar order. */
export function neighbours(docs: Doc[], slug: string): Neighbours {
  const pages = docsNav(docs).flatMap((g) => g.pages);
  const index = pages.findIndex((p) => p.slug === slug);
  const result: Neighbours = {};
  if (index > 0) result.previous = pages[index - 1];
  if (index >= 0 && index < pages.length - 1) result.next = pages[index + 1];
  return result;
}

/** The page with this slug, if there is one. */
export function findDoc(docs: Doc[], slug: string): Doc | undefined {
  return docs.find((d) => d.slug === slug);
}

/** The page `/docs` shows: the first page of the first group. */
export function firstDoc(docs: Doc[]): Doc {
  return findDoc(docs, docsNav(docs)[0].pages[0].slug)!;
}

export const REPO = "https://github.com/1devstudio/moonlet";

/** Where a page's Markdown file is on GitHub, for "Edit this page". */
export function editUrl(slug: string): string {
  return `${REPO}/blob/main/apps/homepage/content/docs/${slug}.md`;
}

export interface Heading {
  depth: 2 | 3;
  text: string;
  id: string;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** The text of some inline HTML, without its tags. */
function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]);
}

/** A heading's id: lower case, runs of anything but letters and digits become `-`. */
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** A page's body as HTML, with ids on its headings and the list for "On this page". */
export function renderDoc(body: string): { html: string; headings: Heading[] } {
  const headings: Heading[] = [];
  const used = new Set<string>();
  // The first free id among `base`, `base-2`, `base-3`, …
  const uniqueId = (base: string) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        if (depth !== 2 && depth !== 3) return `<h${depth}>${inner}</h${depth}>\n`;
        const text = plainText(inner);
        const id = uniqueId(slugify(text) || "section");
        headings.push({ depth, text, id });
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
      blockquote(this: { parser: { parse(t: Tokens.Generic[]): string } }, { tokens }: Tokens.Blockquote) {
        const inner = this.parser.parse(tokens);
        const note = inner.match(/^<p><strong>Note:<\/strong>\s*([\s\S]*)$/);
        if (note) return `<div role="note" class="alert-box alert-box--note alert-box--note-wide"><p>${note[1]}</div>\n`;
        return `<blockquote>\n${inner}</blockquote>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        const name = (lang ?? "").trim().split(/\s+/)[0];
        const known = name && hljs.getLanguage(name) ? name : "";
        const body = known ? hljs.highlight(text, { language: known }).value : escapeHtml(text);
        const cls = known ? ` class="hljs language-${name}"` : "";
        return `<pre><code${cls}>${body}</code></pre>\n`;
      },
    },
  });
  const html = marked.parse(body, { async: false });
  return { html, headings };
}

/** The docs pages a body links to as `/docs/<slug>`, in order, without any `#fragment`. */
export function docLinks(body: string): string[] {
  return [...body.matchAll(/\]\(\/docs\/([a-z0-9-]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
}
