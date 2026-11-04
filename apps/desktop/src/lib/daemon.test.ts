import { afterEach, describe, expect, it, vi } from "vitest";

// The Tauri core, faked as a central host (X72): each `session.attach`
// answers with a new relay id, the relays it is asked to detach and the
// input typed into them are recorded. A method in `held` is answered only
// once `release(method)` is called, in the order it was called.
const central = {
  nextRelay: 101,
  detached: [] as unknown[],
  typed: [] as unknown[],
  held: new Set<string>(),
  waiting: new Map<string, (() => void)[]>(),
  release(method: string) {
    this.held.delete(method);
    for (const done of this.waiting.get(method)?.splice(0) ?? []) done();
  },
};
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: { host: string; method: string; params: unknown; session: number; data: string }) => {
    if (cmd === "send_input") {
      central.typed.push({ host: args.host, session: args.session, data: args.data });
      return;
    }
    if (cmd !== "rpc") return;
    if (central.held.has(args.method)) {
      const queue = central.waiting.get(args.method) ?? [];
      central.waiting.set(args.method, queue);
      await new Promise<void>((done) => queue.push(done));
    }
    if (args.method === "session.attach") return { info: { id: central.nextRelay++ } };
    if (args.method === "session.detach") central.detached.push(args.params);
    return true;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { copyHostId } from "./copyHost";
import { rpc, sendInput } from "./daemon";

describe("a copy host's terminals (X72)", () => {
  afterEach(() => {
    central.release("session.attach");
    central.release("session.detach");
    central.detached.length = 0;
    central.typed.length = 0;
  });

  it("a shared terminal shown again while its detach is on its way is typed into through its new relay (X80)", async () => {
    const host = copyHostId("hub", "s1");
    await rpc(host, "terminal.attach", { id: 5, cols: 80, rows: 24 });
    // Let go of; shown again, and attached anew, before the detach answers.
    central.held.add("session.detach");
    const leaving = rpc(host, "terminal.detach", { id: 5 });
    await rpc(host, "terminal.attach", { id: 5, cols: 80, rows: 24 });
    central.release("session.detach");
    await leaving;
    await sendInput(host, 5, "ls\r");
    expect(central.typed).toEqual([{ host: "hub", session: 102, data: "ls\r" }]);
  });

  it("a shared terminal shown again while its first attach is on its way detaches the first relay only (X80)", async () => {
    const host = copyHostId("hub", "s2");
    central.nextRelay = 201;
    central.held.add("session.attach");
    const first = rpc(host, "terminal.attach", { id: 7, cols: 80, rows: 24 });
    // Let go of, then shown again, before the first attach answers.
    await rpc(host, "terminal.detach", { id: 7 });
    const again = rpc(host, "terminal.attach", { id: 7, cols: 80, rows: 24 });
    central.release("session.attach");
    await Promise.all([first, again]);
    await vi.waitFor(() => expect(central.detached).toEqual([{ relay: 201 }]));
    await sendInput(host, 7, "ls\r");
    expect(central.typed).toEqual([{ host: "hub", session: 202, data: "ls\r" }]);
  });
});
