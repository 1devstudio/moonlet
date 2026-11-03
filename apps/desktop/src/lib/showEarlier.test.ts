import { describe, expect, it } from "vitest";
import { showEarlierLabel } from "./showEarlier";

describe("Show earlier (X81)", () => {
  it("says how many lines it adds in a job's view, and nothing more in a chat", () => {
    expect(showEarlierLabel(1001, "line")).toBe("Show earlier (1,001 more lines)");
    expect(showEarlierLabel(1, "line")).toBe("Show earlier (1 more line)");
    expect(showEarlierLabel(250)).toBe("Show earlier");
  });
});
