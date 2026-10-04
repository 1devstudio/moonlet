import { describe, expect, it } from "vitest";
import { latestOnly, stackView } from "./prStack";
import type { PrStack, StackPr } from "./protocol";

const pr = (number: number, state = "open"): StackPr => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  state,
  draft: false,
  branch: `b${number}`,
});
// As `gh.pr_stack` returns it for #3: bottom first.
const stack: PrStack = { number: 17, base: "main", position: 2, size: 3, prs: [pr(1, "merged"), pr(3), pr(4)] };

describe("stackView", () => {
  it("lists the stack top first with the current PR's position", () => {
    const v = stackView(stack, 3)!;
    expect(v.position).toBe(2);
    expect(v.size).toBe(3);
    expect(v.rows.map((p) => p.number)).toEqual([4, 3, 1]);
    expect(stack.prs.map((p) => p.number)).toEqual([1, 3, 4]);
  });

  it("takes the position from the current PR, not the loaded stack", () => {
    // The session's PR changed to #4 while the stack loaded for #3 is shown.
    expect(stackView(stack, 4)!.position).toBe(3);
  });

  it("hides a stack that does not contain the current PR", () => {
    expect(stackView(stack, 9)).toBeNull();
    expect(stackView(stack, null)).toBeNull();
    expect(stackView(null, 3)).toBeNull();
  });
});

describe("latestOnly", () => {
  it("lets only the most recent poll apply", () => {
    const gate = latestOnly();
    const first = gate.start();
    expect(first()).toBe(true);
    const second = gate.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
