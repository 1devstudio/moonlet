import { describe, expect, it } from "vitest";
import { detailsCache } from "./detailsCache";

describe("detailsCache", () => {
  it("shares one load between rows asking at the same time", async () => {
    const c = detailsCache(60_000, () => 0);
    const [a, b] = await Promise.all([c.load("git:s1", async () => "first"), c.load("git:s1", async () => "second")]);
    expect([a, b]).toEqual(["first", "first"]);
  });

  it("keeps a value for its time, then loads it again", async () => {
    let now = 0;
    const c = detailsCache(60_000, () => now);
    await c.load("pr:s1", async () => "#147 open");
    now = 59_999;
    expect(await c.load("pr:s1", async () => "#147 merged")).toBe("#147 open");
    expect(c.peek("pr:s1")).toBe("#147 open");
    now = 60_000;
    expect(await c.load("pr:s1", async () => "#147 merged")).toBe("#147 merged");
  });

  it("loads again when asked to, or after its key was forgotten", async () => {
    const c = detailsCache(60_000, () => 0);
    await c.load("git:s1:base", async () => 1);
    expect(await c.load("git:s1:base", async () => 2, true)).toBe(2);
    c.forget("git:s1");
    expect(c.peek("git:s1:base")).toBeUndefined();
    expect(await c.load("git:s1:base", async () => 3)).toBe(3);
  });

  it("does not keep a failed load", async () => {
    const c = detailsCache(60_000, () => 0);
    await expect(c.load("pr:s1", async () => Promise.reject(new Error("gh failed")))).rejects.toThrow("gh failed");
    expect(await c.load("pr:s1", async () => "#147 open")).toBe("#147 open");
  });
});
