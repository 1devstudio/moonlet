// Unified diff helpers for hunk staging (D2) and comment-to-agent (D3).

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface FileDiff {
  header: string[];
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses the diff of a single file. */
export function parseFileDiff(text: string): FileDiff {
  const out: FileDiff = { header: [], hunks: [] };
  let current: Hunk | null = null;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      current = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      out.hunks.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      out.header.push(line);
    }
  }
  return out;
}

/** A patch containing just one hunk, ready for `git apply --recount`. */
export function hunkPatch(diff: FileDiff, index: number): string {
  const h = diff.hunks[index];
  if (!h) throw new Error("no such hunk");
  return [...diff.header, h.header, ...h.lines].join("\n") + "\n";
}

/** Index of the hunk covering a line of the new file, if any. */
export function hunkForNewLine(diff: FileDiff, line: number): number {
  return diff.hunks.findIndex((h) => line >= h.newStart && line < h.newStart + Math.max(h.newLines, 1));
}

/** The prompt sent to the agent for a review comment on a diff line. */
export function commentPrompt(file: string, line: number, comment: string, snippet: string): string {
  const code = snippet.trim() ? `\n\n\`\`\`\n${snippet.trimEnd()}\n\`\`\`` : "";
  return `Review comment on ${file}:${line}:${code}\n\n${comment.trim()}`;
}
