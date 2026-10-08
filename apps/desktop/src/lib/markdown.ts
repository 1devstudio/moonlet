// Markdown preview (M1). Rendering happens here; the result is sanitized
// and shown in an iframe with an empty `sandbox` (no scripts, no same-origin
// access, so no IPC) and a CSP that blocks every remote request.

import MarkdownIt from "markdown-it";
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

// Linkify skips code, but agents often wrap a URL in backticks: an inline
// code span that is exactly one URL becomes a link around the code.
const defaultCodeInline = chatMd.renderer.rules.code_inline!;
chatMd.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
  const code = defaultCodeInline(tokens, idx, options, env, self);
  const url = tokens[idx].content.trim();
  return /^https?:\/\/\S+$/.test(url) ? `<a href="${escapeHtml(url)}">${code}</a>` : code;
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

export function renderChatMarkdown(source: string): string {
  return DOMPurify.sanitize(chatMd.render(source), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "img", "style"],
    FORBID_ATTR: ["srcset", "ping", "style"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}
