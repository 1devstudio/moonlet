// Colours for command output in agent tool calls (X18). The agent's commands
// run without a terminal, so colour comes from recognising common shapes.

import { highlightLines } from "./codeHighlight";

export type Tone = "add" | "del" | "dim" | "error" | "warn" | "ok";
export type Segment = { text: string; tone?: Tone };
export type OutputView = { kind: "diff"; diff: string } | { kind: "code"; html: string[] } | { kind: "lines"; lines: Segment[][] } | null;

function isJson(text: string): boolean {
  if (!/^[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** One output line as text segments, some of them toned. */
function lineSegments(line: string): Segment[] {
  const stat = /^(.*\S\s+)(\|)(\s+\d+ )(\+*)(-*)$/.exec(line);
  if (stat && (stat[4] || stat[5])) {
    const [, path, bar, count, add, del] = stat;
    return [{ text: path }, { text: bar, tone: "dim" as const }, { text: count }, { text: add, tone: "add" as const }, { text: del, tone: "del" as const }].filter((s) => s.text);
  }
  if (/^\s*\d+ files? changed\b/.test(line)) return [{ text: line, tone: "dim" }];
  // `path:12:` or `path:12:5:` (grep -rn, rg, compilers), or `12:` (grep -n).
  const at = /^(?:[^\s:]+:\d+(?::\d+)?:|\d+:)/.exec(line)?.[0] ?? "";
  const rest = line.slice(at.length);
  return [...(at ? [{ text: at, tone: "dim" as const }] : []), ...words(rest)];
}

// A zero count comes first so `0 failed` is matched, and left plain, before `failed`.
const WORDS = /\b0 (?:failed|errors?|warnings?)\b|\b(error|ERROR|fatal|FAIL|FAILED|failed|panicked)\b|(×)|\b(warning|WARN|WARNING)\b|\b(ok|passed|PASS)\b|(✓)/g;

/** `text` with its status words toned. */
function words(text: string): Segment[] {
  const out: Segment[] = [];
  let from = 0;
  for (const m of text.matchAll(WORDS)) {
    const tone: Tone | undefined = m[1] || m[2] ? "error" : m[3] ? "warn" : m[4] || m[5] ? "ok" : undefined;
    if (!tone) continue;
    if (m.index > from) out.push({ text: text.slice(from, m.index) });
    out.push({ text: m[0], tone });
    from = m.index + m[0].length;
  }
  if (from < text.length || !out.length) out.push({ text: text.slice(from) });
  return out;
}

/** How a shell or Grep call's output is shown; null for plain text. */
export function outputView(output: string): OutputView {
  if (/^(diff --git |--- .*\n\+\+\+ )/.test(output)) return { kind: "diff", diff: output };
  const text = output.trim();
  if (isJson(text)) return { kind: "code", html: highlightLines(text.split("\n"), "json") };
  const lines = output.replace(/^\n+|\n+$/g, "").split("\n").map(lineSegments);
  return lines.some((l) => l.some((s) => s.tone)) ? { kind: "lines", lines } : null;
}
