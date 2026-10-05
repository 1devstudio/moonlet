// Syntax colours for file contents in agent tool calls (X17): a Read's
// numbered lines and an Edit or Write diff.

import hljs from "highlight.js/lib/common";

/** highlight.js language id for a file, from its extension or name; null when unknown. */
export function languageFor(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  const key = (dot > 0 ? name.slice(dot + 1) : name).toLowerCase();
  const lang = key && hljs.getLanguage(key);
  return (lang && hljs.listLanguages().find((id) => hljs.getLanguage(id) === lang)) || null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Coloured HTML for each line of `lines`, highlighted as one text; escaped plain text when `lang` is null. */
export function highlightLines(lines: string[], lang: string | null): string[] {
  if (!lang) return lines.map(escapeHtml);
  const html = hljs.highlight(lines.join("\n"), { language: lang, ignoreIllegals: true }).value;
  // A span can cross a line break (a block comment); close it at the end of
  // the line and reopen it on the next, so each line stands alone.
  const out: string[] = [];
  const open: string[] = [];
  let line = "";
  for (const [tok] of html.matchAll(/<span[^>]*>|<\/span>|\n|[^<\n]+/g)) {
    if (tok === "\n") {
      out.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else {
      if (tok === "</span>") open.pop();
      else if (tok.startsWith("<span")) open.push(tok);
      line += tok;
    }
  }
  out.push(line);
  return out;
}

export type DiffRow = { kind: "add" | "del" | "context" | "hunk"; html: string };

type Row = { kind: DiffRow["kind"]; code: string };

/**
 * A unified diff's lines with the code coloured by the language of each
 * file's `+++` name (`---` for a deletion). Removed and added lines are
 * highlighted as the old and new file, so neither side's open comment or
 * string bleeds into the other.
 */
export function diffRows(diff: string): DiffRow[] {
  const lines = diff.replace(/\n$/, "").split("\n");
  const files: { path: string; rows: Row[] }[] = [];
  let file: { path: string; rows: Row[] } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      // A header pair names the file; it opens a new one unless `diff --git` just did.
      if (!file || file.path) files.push((file = { path: "", rows: [] }));
      const [from, to] = [l.slice(4).trim(), lines[++i].slice(4).trim()];
      file.path = to !== "/dev/null" ? to : from;
      continue;
    }
    if (l.startsWith("diff --git ") || !file) files.push((file = { path: "", rows: [] }));
    const kind = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith(" ") ? "context" : "hunk";
    file.rows.push({ kind, code: kind === "hunk" ? l : l.slice(1) });
  }
  const html = new Map<Row, string>();
  for (const f of files) {
    const lang = languageFor(f.path);
    for (const kind of ["del", "add"] as const) {
      const mine = f.rows.filter((r) => r.kind === kind || r.kind === "context");
      // Context lines are on both sides; the new side, last, wins.
      highlightLines(mine.map((r) => r.code), lang).forEach((h, i) => html.set(mine[i], h));
    }
  }
  return files.flatMap((f) => f.rows.map((r) => ({ kind: r.kind, html: r.kind === "hunk" ? escapeHtml(r.code) : html.get(r)! })));
}

/** A Read's numbered lines (`1\tcode`, or `1→code`) as gutter numbers and coloured code; null when the output is not numbered lines. */
export function readRows(output: string, path: string): { n: number; html: string }[] | null {
  const parsed = output.replace(/\n$/, "").split("\n").map((l) => /^\s*(\d+)[\t→](.*)$/.exec(l));
  if (parsed.some((m) => !m)) return null;
  const rows = parsed as RegExpExecArray[];
  const html = highlightLines(rows.map((m) => m[2]), languageFor(path));
  return rows.map((m, i) => ({ n: Number(m[1]), html: html[i] }));
}
