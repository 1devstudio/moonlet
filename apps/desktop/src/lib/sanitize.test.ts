import { expect, it } from "vitest";
import { sanitize } from "./sanitize";

it("strips escapes and control characters", () => {
  expect(sanitize("\x1b[31mred\x1b[0m \x1b]0;title\x07ok\x00\n next")).toBe("red ok next");
  expect(sanitize("x".repeat(10), 5)).toBe("xxxx…");
  expect(sanitize(null)).toBe("");
});
