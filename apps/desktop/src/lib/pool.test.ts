import { describe, expect, it } from "vitest";
import { runPooled } from "./pool";

/** A task that waits until `release(i)` is called, recording when it runs. */
function gate() {
  const running = new Set<number>();
  const started: number[] = [];
  const waiting = new Map<number, { ok: () => void; fail: (e: Error) => void }>();
  let most = 0;
  const task = (i: number) =>
    new Promise<string>((resolve, reject) => {
      running.add(i);
      started.push(i);
      most = Math.max(most, running.size);
      waiting.set(i, {
        ok: () => (running.delete(i), resolve(`done ${i}`)),
        fail: (e) => (running.delete(i), reject(e)),
      });
    });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { task, started, waiting, most: () => most, tick };
}

describe("runPooled (X106)", () => {
  it("runs at most 5 at once, the next as one ends, in order", async () => {
    const g = gate();
    const done = runPooled([0, 1, 2, 3, 4, 5, 6], 5, g.task);
    await g.tick();
    expect(g.started).toEqual([0, 1, 2, 3, 4]);
    g.waiting.get(2)!.ok();
    await g.tick();
    expect(g.started).toEqual([0, 1, 2, 3, 4, 5]);
    for (const i of [0, 1, 3, 4, 5]) g.waiting.get(i)!.ok();
    await g.tick();
    g.waiting.get(6)!.ok();
    expect(await done).toEqual([
      { ok: true, value: "done 0" },
      { ok: true, value: "done 1" },
      { ok: true, value: "done 2" },
      { ok: true, value: "done 3" },
      { ok: true, value: "done 4" },
      { ok: true, value: "done 5" },
      { ok: true, value: "done 6" },
    ]);
    expect(g.most()).toBe(5);
  });

  it("goes on past one that fails", async () => {
    const g = gate();
    const done = runPooled([0, 1, 2], 2, g.task);
    await g.tick();
    const broken = new Error("git worktree remove failed");
    g.waiting.get(0)!.fail(broken);
    await g.tick();
    expect(g.started).toEqual([0, 1, 2]);
    g.waiting.get(1)!.ok();
    g.waiting.get(2)!.ok();
    expect(await done).toEqual([{ ok: false, error: broken }, { ok: true, value: "done 1" }, { ok: true, value: "done 2" }]);
  });
});
