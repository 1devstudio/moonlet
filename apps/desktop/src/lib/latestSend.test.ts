import { describe, expect, it } from "vitest";
import { latestSends } from "./latestSend";

describe("saves of the latest state (X65)", () => {
  it("still send the latest state after a send that failed, when a call came while it was on its way", async () => {
    const saves = latestSends();
    let state = "first edit";
    const sent: string[] = [];
    let fail = (_: Error) => {};
    const send = () => {
      const now = state;
      if (!sent.length) return new Promise<void>((_, reject) => ((fail = reject), sent.push(now)));
      sent.push(now);
      return Promise.resolve();
    };
    const first = saves.send("index", send);
    state = "second edit";
    const second = saves.send("index", send);
    fail(new Error("disk full"));
    await Promise.allSettled([first, second]);
    await saves.settle();
    expect(sent).toEqual(["first edit", "second edit"]);
    expect(saves.busy("index")).toBe(false);
  });

  it("reject with the error of a send that failed when no call came while it was on its way", async () => {
    const saves = latestSends();
    await expect(saves.send("index", () => Promise.reject(new Error("disk full")))).rejects.toThrow("disk full");
    expect(saves.busy("index")).toBe(false);
  });
});
