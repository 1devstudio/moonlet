import { describe, expect, it } from "vitest";
import { lastOf, limitAfter, showEarlierLabel } from "./showEarlier";

describe("Show earlier (X81)", () => {
  it("says how many lines it adds in a job's view, and nothing more in a chat", () => {
    expect(showEarlierLabel(1001, "line")).toBe("Show earlier (1,001 more lines)");
    expect(showEarlierLabel(1, "line")).toBe("Show earlier (1 more line)");
    expect(showEarlierLabel(250)).toBe("Show earlier");
  });

  // Rows numbered from `from` to `to`, keyed by their number.
  const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const key = (n: number) => n;

  it("keeps the first row rendered in place while the reader is scrolled up and rows arrive", () => {
    // Rows 1–250 render from 51. 50 more arrive while the reader is up.
    expect(lastOf(rows(1, 250), 200).rendered[0]).toBe(51);
    const limit = limitAfter(rows(1, 300), key, { limit: 200, last: 250, atEnd: false });
    expect(limit).toBe(250);
    expect(lastOf(rows(1, 300), limit).rendered[0]).toBe(51);
    // A job's output drops 100 lines from its start meanwhile: still from 51.
    const trimmed = limitAfter(rows(101, 400), key, { limit: 200, last: 350, atEnd: false });
    expect(trimmed).toBe(250);
    expect(lastOf(rows(101, 400), trimmed).rendered[0]).toBe(151);
  });

  it("follows the end while the reader is there, and as it was when the last row only grew or the rows changed", () => {
    expect(limitAfter(rows(1, 300), key, { limit: 200, last: 250, atEnd: true })).toBe(200);
    // The last message streams more text: the same row.
    expect(limitAfter(rows(1, 250), key, { limit: 200, last: 250, atEnd: false })).toBe(200);
    // A filter or Find leaves other rows: none to count from.
    expect(limitAfter(rows(1, 40), key, { limit: 200, last: 250, atEnd: false })).toBe(200);
    expect(limitAfter(rows(1, 40), key, { limit: 200, last: undefined, atEnd: false })).toBe(200);
  });
});
