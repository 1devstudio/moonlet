import { describe, expect, it } from "vitest";
import { ageText, askHeadline, needsFaceId, planBlurb, readMessage } from "./cards";
import { MIN, NOW, read } from "./fixtures";

describe("ageText", () => {
  it("says how long an ask has waited, short", () => {
    expect(ageText(NOW - 20_000, NOW)).toBe("now");
    expect(ageText(NOW - 2 * MIN, NOW)).toBe("2m");
    expect(ageText(NOW - 3 * 60 * MIN, NOW)).toBe("3h");
    expect(ageText(NOW - 2 * 24 * 60 * MIN, NOW)).toBe("2d");
    expect(ageText(null, NOW)).toBe("");
  });
});

describe("askHeadline", () => {
  it("asks to allow the tool by name", () => {
    expect(askHeadline("Bash")).toBe("Allow Bash?");
    expect(askHeadline("Edit")).toBe("Allow Edit?");
  });

  it("names an MCP tool by its server and tool", () => {
    expect(askHeadline("mcp__linear__create_issue")).toBe("Allow linear · create_issue?");
  });
});

describe("planBlurb", () => {
  it("is the plan's first sentence after its heading", () => {
    expect(planBlurb("# Idempotent refund webhooks\n\nStore event ids, retry with backoff, add a replay script. Then backfill.")).toBe(
      "Store event ids, retry with backoff, add a replay script.",
    );
  });

  it("skips Markdown marks and cuts a long sentence", () => {
    expect(planBlurb("## Plan\n\n- **Add** a `SearchBox` to the list")).toBe("Add a SearchBox to the list");
    const long = planBlurb(`# T\n\n${"word ".repeat(60)}`);
    expect(long.length).toBeLessThanOrEqual(141);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("readMessage", () => {
  it("is the X31 question, with the session's name", () => {
    expect(readMessage(read(), "Fix login")).toBe("Claude in Fix login wants the output of pnpm test (exit 1, 84 lines) from terminal zsh.");
  });
});

describe("needsFaceId", () => {
  it("asks before allowing, never before denying", () => {
    expect(needsFaceId("allow", true)).toBe(true);
    expect(needsFaceId("always", true)).toBe(true);
    expect(needsFaceId("approve", true)).toBe(true);
    expect(needsFaceId("deny", true)).toBe(false);
    expect(needsFaceId("feedback", true)).toBe(false);
  });

  it("asks before letting an agent read a terminal", () => {
    expect(needsFaceId("read", true)).toBe(true);
  });

  it("never asks with the setting off", () => {
    expect(needsFaceId("allow", false)).toBe(false);
  });
});
