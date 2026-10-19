// Markdown preview (M1). Rendering happens here; the result is sanitized
// and shown in an iframe with an empty `sandbox` (no scripts, no same-origin
// access, so no IPC) and a CSP that blocks every remote request.

import MarkdownIt, { type Token } from "markdown-it";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  highlight(code, lang): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        /* fall through */
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
  },
});

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim().toLowerCase() === "mermaid") {
    const store = (env ?? {}) as { mermaid?: string[] };
    const list = (store.mermaid ??= []);
    list.push(token.content);
    return `<div class="mermaid" data-mermaid="${list.length - 1}"></div>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

let mermaidId = 0;
async function renderMermaid(source: string): Promise<string> {
  try {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "strict",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      fontFamily: "-apple-system, sans-serif",
    });
    const { svg } = await mermaid.render(`moonlet-mermaid-${++mermaidId}`, source);
    // As an image the SVG is inert (no scripts, no external loads) and the
    // sanitizer has nothing to strip from it.
    const bytes = new TextEncoder().encode(svg);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return `<img class="mermaid-img" alt="diagram" src="data:image/svg+xml;base64,${btoa(bin)}">`;
  } catch (e) {
    return `<pre class="mermaid-error">Mermaid: ${escapeHtml(e instanceof Error ? e.message : String(e))}</pre>`;
  }
}

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    // Mermaid SVGs carry their own <style>; CSS cannot fetch anything because
    // the preview CSP only allows data: URLs.
    ADD_TAGS: ["foreignObject", "style"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button"],
    FORBID_ATTR: ["srcset", "ping"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}

/** Renders markdown to sanitized HTML with Mermaid diagrams as inline SVG. */
export async function renderMarkdown(source: string, withMermaid = true): Promise<string> {
  const env: { mermaid?: string[] } = {};
  let html = md.render(source, env);
  if (withMermaid && env.mermaid?.length) {
    const svgs = await Promise.all(env.mermaid.map(renderMermaid));
    html = html.replace(/<div class="mermaid" data-mermaid="(\d+)"><\/div>/g, (_m: string, i: string) => `<div class="mermaid">${svgs[Number(i)]}</div>`);
  }
  return sanitizeHtml(html);
}

/** The preview's stylesheet, its text sized by the app's text scale. */
const css = (scale: number) => `
:root{color-scheme:dark}
body{margin:0;padding:20px 28px 60px;background:#121212;color:#e2e2e2;font:${14 * scale}px/1.65 -apple-system,BlinkMacSystemFont,"Inter",sans-serif;max-width:860px}
h1,h2,h3,h4{color:#f2f4f8;line-height:1.3;margin:1.4em 0 .5em}
h1{font-size:1.8em;border-bottom:1px solid #242424;padding-bottom:.3em}
h2{font-size:1.4em;border-bottom:1px solid #242424;padding-bottom:.25em}
a{color:#e8956f;text-decoration:none}
code{font:${12.5 * scale}px "JetBrains Mono","SF Mono",Menlo,monospace;background:#1f1f1f;padding:.1em .35em;border-radius:4px}
pre{background:#181818;border:1px solid #242424;border-radius:8px;padding:12px 14px;overflow:auto}
pre code{background:none;padding:0}
blockquote{margin:0;padding:0 1em;color:#9ba1ad;border-left:3px solid #2e2e2e}
table{border-collapse:collapse;margin:1em 0;display:block;overflow:auto}
th,td{border:1px solid #2e2e2e;padding:6px 12px}
th{background:#1a1a1a}
tr:nth-child(2n) td{background:#151515}
img{max-width:100%}
hr{border:0;border-top:1px solid #242424}
.mermaid{margin:1em 0;text-align:center}
.mermaid svg,.mermaid img{max-width:100%;height:auto}
.mermaid-error{color:#ef6b73}
ul.contains-task-list{list-style:none;padding-left:1.2em}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in{color:#c49bff}
.hljs-string,.hljs-attr{color:#8fd18e}
.hljs-number,.hljs-literal{color:#f5a97f}
.hljs-comment{color:#6b717d;font-style:italic}
.hljs-title,.hljs-function{color:#7aa7ff}
.hljs-type,.hljs-class{color:#e8c46b}
.hljs-variable,.hljs-template-variable{color:#ef8a91}
`;

/** Full document for the sandboxed iframe's `srcdoc`, its text sized by
 *  the app's text scale (see uiScale). */
export function previewDocument(bodyHtml: string, scale = 1): string {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${css(scale)}</style></head><body>${bodyHtml}</body></html>`;
}

// Agent messages (X6): no raw HTML at all, highlighted code, sanitized, and
// rendered straight into the app (no iframe) because nothing executable
// survives.
const chatMd = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(code, lang): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        /* fall through */
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
  },
});

// A path's directories, and its file name with an extension (dotfiles too).
const PATH_DIR = String.raw`[\w.@-]+/`;
const PATH_NAME = String.raw`\.?[\w@-][\w.@-]*\.([A-Za-z0-9]{1,8})`;

// A bare name like `item.text` is more often code than a file, so a name
// without a directory only counts with one of these extensions.
const FILE_EXTENSIONS = new Set(
  "md mdx txt json jsonc toml yaml yml lock ts tsx js jsx mjs cjs css scss html rs go py rb java kt swift c h cc cpp hpp sh zsh fish sql proto graphql vue svelte xml svg env".split(" "),
);

/** A file a chat message refers to, and the line it points at. */
type FileRef = { path: string; line?: number };

/**
 * A file inside the project that chat text refers to (X30): a relative path
 * with an extension, optionally `:line[:col]`. Absolute paths, `~/` and `..`
 * stay plain, so agent output cannot point outside the session's worktree.
 */
function projectPath(text: string): FileRef | null {
  const m = new RegExp(String.raw`^((?:\./)?(?:${PATH_DIR})*${PATH_NAME})(?::(\d+))?(?::\d+)?$`).exec(text);
  if (!m || m[1].split("/").includes("..")) return null;
  if (!m[1].includes("/") && !FILE_EXTENSIONS.has(m[2].toLowerCase())) return null;
  return m[3] ? { path: m[1], line: Number(m[3]) } : { path: m[1] };
}

/** `./src/a.ts` as `src/a.ts`, the form the project's file list uses. */
const withoutDotSlash = (path: string) => path.replace(/^\.\//, "");

/**
 * The file a click on a chat file link opens: its `data-file` and
 * `data-line`, under the session's worktree. A click that ends a text
 * selection opens nothing.
 */
export function fileToOpen(link: { file: string | null; line: string | null }, cwd: string, click: { selecting: boolean }): FileRef | null {
  const file = link.file && projectPath(link.file);
  if (!file || !cwd || click.selecting) return null;
  const path = `${cwd.replace(/\/+$/, "")}/${withoutDotSlash(file.path)}`;
  const line = Number(link.line);
  return line > 0 ? { path, line } : { path };
}

/** Whether a project-relative path is a file in the project. */
type FileCheck = (path: string) => boolean;

/** A path in chat text that gets a file link: a project path the file list knows. */
function linkedFile(text: string, env: unknown): FileRef | null {
  const file = projectPath(text);
  const exists = (env as { exists?: FileCheck } | undefined)?.exists;
  return file && exists?.(withoutDotSlash(file.path)) ? file : null;
}

/** The attributes that mark a link as a file link. */
function fileAttrs(file: FileRef): [string, string][] {
  return file.line ? [["data-file", file.path], ["data-line", String(file.line)]] : [["data-file", file.path]];
}

// In prose only a path with a directory counts, so "Node.js" stays a word.
// The look-behind keeps the match from starting inside `/abs`, `~/` or `../`.
const PROSE_PATH_RE = new RegExp(String.raw`(?<![\w./~@-])(?:\./)?(?:${PATH_DIR})+${PATH_NAME}(?::\d+(?::\d+)?)?(?![\w/])`, "g");

/**
 * Undoes underscore emphasis that is really part of a path: in
 * `pkg/__init__.py` the `__` pair parses as bold. Adjacent text is merged
 * so the path is one text token again.
 */
function unwrapPathUnderscores(children: Token[], text: (content: string) => Token): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < children.length; i++) {
    const [open, inner, close, after] = children.slice(i, i + 4);
    const before = out[out.length - 1];
    const pathEmphasis =
      (open.type === "strong_open" || open.type === "em_open") &&
      open.markup.startsWith("_") &&
      inner?.type === "text" &&
      close?.type === open.type.replace("_open", "_close") &&
      before?.type === "text" &&
      before.content.endsWith("/") &&
      after?.type === "text" &&
      after.content.startsWith(".");
    if (!pathEmphasis) {
      out.push(open);
      continue;
    }
    out[out.length - 1] = text(before.content + open.markup + inner.content + close.markup + after.content);
    i += 3;
  }
  return out;
}

// Project paths in plain text become file links (X30). Runs last, so text
// already inside a link (linkify URLs, Markdown links) is left alone.
chatMd.core.ruler.push("file_links", (state) => {
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    const text = (content: string) => Object.assign(new state.Token("text", "", 0), { content });
    const out = [];
    let inLink = 0;
    for (const tok of unwrapPathUnderscores(block.children, text)) {
      if (tok.type === "link_open") {
        inLink++;
        const file = linkedFile(String(tok.attrGet("href") ?? ""), state.env);
        if (file) fileAttrs(file).forEach(([name, value]) => tok.attrSet(name, value));
      }
      if (tok.type === "link_close") inLink--;
      if (tok.type !== "text" || inLink > 0) {
        out.push(tok);
        continue;
      }
      let last = 0;
      for (const m of tok.content.matchAll(PROSE_PATH_RE)) {
        const file = linkedFile(m[0], state.env);
        if (!file) continue;
        if (m.index > last) out.push(text(tok.content.slice(last, m.index)));
        const open = new state.Token("link_open", "a", 1);
        open.attrs = [["href", file.path], ...fileAttrs(file)];
        out.push(open, text(m[0]), new state.Token("link_close", "a", -1));
        last = m.index + m[0].length;
      }
      if (last === 0) out.push(tok);
      else if (last < tok.content.length) out.push(text(tok.content.slice(last)));
    }
    block.children = out;
  }
});

// Linkify skips code, but agents often wrap a URL in backticks: an inline
// code span that is exactly one URL becomes a link around the code, and so
// does one that is exactly a project path (X30).
const defaultCodeInline = chatMd.renderer.rules.code_inline!;
chatMd.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
  const code = defaultCodeInline(tokens, idx, options, env, self);
  const text = tokens[idx].content.trim();
  if (/^https?:\/\/\S+$/.test(text)) return `<a href="${escapeHtml(text)}">${code}</a>`;
  const file = linkedFile(text, env);
  if (!file) return code;
  const attrs = [["href", file.path], ...fileAttrs(file)].map(([name, value]) => `${name}="${escapeHtml(value)}"`);
  return `<a ${attrs.join(" ")}>${code}</a>`;
};

/** The URL a chat link may open in the browser, or null for anything else. */
export function openableUrl(href: string | null): string | null {
  if (!href) return null;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}

/**
 * The URL a click on a chat link opens. ⌘-click and keyboard activation
 * (Enter on a focused link) open; a plain mouse click only selects text.
 */
export function linkToOpen(href: string | null, click: { metaKey: boolean; keyboard: boolean }): string | null {
  return click.metaKey || click.keyboard ? openableUrl(href) : null;
}

/** Fixed position of the link's Open/Copy toolbar: above the link, below it near the window top. */
export function linkToolbarPosition(
  link: { left: number; top: number; bottom: number },
  win: { width: number; height: number },
  toolbarWidth = 72,
): { left: number; top?: number; bottom?: number } {
  const left = Math.max(4, Math.min(link.left, win.width - toolbarWidth));
  return link.top > 40 ? { left, bottom: win.height - link.top + 2 } : { left, top: link.bottom + 2 };
}

// In a task's description (X46), a checklist item (`- [ ]`, `- [x]`) starts
// with a box, ticked or not, in place of its brackets.
chatMd.core.ruler.push("task_checklists", (state) => {
  if (!(state.env as { task?: boolean } | undefined)?.task) return;
  state.tokens.forEach((tok, i) => {
    const first = tok.type === "inline" ? tok.children?.[0] : undefined;
    const item = state.tokens[i - 2];
    const m = first?.type === "text" && item?.type === "list_item_open" ? /^\[([ xX])\]\s+/.exec(first.content) : null;
    if (!first || !m) return;
    first.content = first.content.slice(m[0].length);
    const done = m[1] !== " ";
    const box = Object.assign(new state.Token("html_inline", "", 0), {
      content: `<span class="task-check${done ? " done" : ""}" aria-label="${done ? "Done" : "Not done"}"></span>`,
    });
    tok.children!.unshift(box);
    item.attrJoin("class", "task-item");
  });
});

// Chat shows no images (nothing remote loads); a task's description shows
// each as a link to it, named by its alt text.
const defaultImage = chatMd.renderer.rules.image!;
chatMd.renderer.rules.image = (tokens, idx, options, env, self) => {
  if (!(env as { task?: boolean } | undefined)?.task) return defaultImage(tokens, idx, options, env, self);
  const alt = self.renderInlineAsText(tokens[idx].children ?? [], options, env).trim();
  return `<a href="${escapeHtml(String(tokens[idx].attrGet("src") ?? ""))}">${escapeHtml(alt ? `Image: ${alt}` : "Image")}</a>`;
};

const chatSanitize = (html: string) =>
  DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "img", "style"],
    FORBID_ATTR: ["srcset", "ping", "style"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });

/** `source` without HTML comments (issue templates' hints), except in code fences. */
const withoutComments = (source: string) =>
  source
    .split(/(^```[^\n]*\n[\s\S]*?^```)/m)
    .map((part, i) => (i % 2 ? part : part.replace(/<!--[\s\S]*?-->/g, "")))
    .join("");

/**
 * A task's description (X46) as chat Markdown: checklist items with boxes,
 * images as links, and no HTML comments, as GitHub shows an issue.
 */
export function renderTaskMarkdown(source: string): string {
  return chatSanitize(chatMd.render(withoutComments(source), { task: true }));
}

/** Agent message HTML; only paths `exists` accepts become file links (X30), none without it. */
export function renderChatMarkdown(source: string, exists?: FileCheck): string {
  return chatSanitize(chatMd.render(source, { exists }));
}
