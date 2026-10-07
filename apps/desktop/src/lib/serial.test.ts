import { describe, expect, it } from "vitest";
import { serial } from "./serial";

describe("serial (X26)", () => {
  it("runs calls one at a time, in the order they were made", async () => {
    const applied: string[] = [];
    let releaseFirst = () => {};
    const run = serial(async (theme: string) => {
      // The first theme loads slowly; the second would finish first.
      if (theme === "dark-plus") await new Promise<void>((r) => (releaseFirst = r));
      applied.push(theme);
    });
    const first = run("dark-plus");
    const second = run("github-dark");
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);
    expect(applied).toEqual(["dark-plus", "github-dark"]);
  });

  it("goes on after a call fails", async () => {
    const run = serial(async (n: number) => {
      if (n === 1) throw new Error("no such grammar");
      return n;
    });
    await expect(run(1)).rejects.toThrow("no such grammar");
    await expect(run(2)).resolves.toBe(2);
  });
});
