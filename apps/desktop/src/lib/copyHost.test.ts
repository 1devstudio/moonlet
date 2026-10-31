import { describe, expect, it } from "vitest";
import { EarlyOutput, PendingAttaches, copyHostId, parseCopyHost, routeCall, signInHostId, unwrapEvent } from "./copyHost";

describe("copy hosts (X72)", () => {
  it("names a session another member owns by its central host and its id", () => {
    const id = copyHostId("studio-mini", "5e7f9a1b3c5d");
    expect(id).toBe("studio-mini#copy:5e7f9a1b3c5d");
    expect(parseCopyHost(id)).toEqual({ host: "studio-mini", session: "5e7f9a1b3c5d" });
    expect(parseCopyHost("studio-mini")).toBeNull();
    expect(parseCopyHost("#copy:5e7f9a1b3c5d")).toBeNull();
  });

  it("sends a call through the central host, the session's terminals by relay", () => {
    const id = "studio-mini#copy:5e7f9a1b3c5d";
    expect(routeCall(id, "chat.send", { id: 3, text: "go" }, () => undefined)).toEqual({
      host: "studio-mini",
      method: "session.forward",
      params: { session: "5e7f9a1b3c5d", method: "chat.send", params: { id: 3, text: "go" } },
    });
    expect(routeCall(id, "terminal.attach", { id: 4, cols: 80, rows: 24 }, () => undefined)).toEqual({
      host: "studio-mini",
      method: "session.attach",
      params: { session: "5e7f9a1b3c5d", terminal: 4, cols: 80, rows: 24 },
    });
    expect(routeCall(id, "terminal.detach", { id: 4 }, (t) => (t === 4 ? 0x4000_0007 : undefined))).toEqual({
      host: "studio-mini",
      method: "session.detach",
      params: { relay: 0x4000_0007 },
    });
    // Not attached: nothing to detach.
    expect(routeCall(id, "terminal.detach", { id: 5 }, () => undefined)).toBeNull();
  });

  it("gives a session event as the copy host's own event", () => {
    const e = { host: "studio-mini", name: "session.event", data: { session: "5e7f9a1b3c5d", event: { t: "event", name: "chat.item", data: { id: 3, item: { id: "i1" } } } } };
    expect(unwrapEvent(e)).toEqual({ host: "studio-mini#copy:5e7f9a1b3c5d", name: "chat.item", data: { id: 3, item: { id: "i1" } } });
    expect(unwrapEvent({ host: "studio-mini", name: "chat.item", data: {} })).toBeNull();
  });
});

describe("relay output before the attach reply (X72)", () => {
  it("is kept for the relay, in order, and given once", () => {
    const early = new EarlyOutput();
    expect(early.keep("studio-mini:1073741832", 0x4000_0008, true, new Uint8Array([1]))).toBe(true);
    expect(early.keep("studio-mini:1073741832", 0x4000_0008, false, new Uint8Array([2]))).toBe(true);
    // Not a relay id: a terminal of the host's own, nothing to keep.
    expect(early.keep("studio-mini:3", 3, false, new Uint8Array([9]))).toBe(false);
    expect(early.take("studio-mini:1073741832").map((o) => [o.reset, [...o.data]])).toEqual([
      [true, [1]],
      [false, [2]],
    ]);
    expect(early.take("studio-mini:1073741832")).toEqual([]);
  });
});

describe("leaving a terminal while its attach is on its way (X72)", () => {
  it("lets go of the relay once the reply comes", () => {
    const a = new PendingAttaches();
    a.start("studio-mini#copy:s1:4");
    expect(a.leave("studio-mini#copy:s1:4")).toBe(true);
    expect(a.done("studio-mini#copy:s1:4")).toBe(true);
    // Left after the reply: nothing pending, the usual detach applies.
    a.start("studio-mini#copy:s1:5");
    expect(a.done("studio-mini#copy:s1:5")).toBe(false);
    expect(a.leave("studio-mini#copy:s1:5")).toBe(false);
  });
});

describe("another member's sign-in through the central host (X75)", () => {
  it("attaches by the member and terminal, detaches by relay, and sends nothing else", () => {
    const id = signInHostId("studio-mini", "5b2e8d4f-6a1c-4f3e-b7d9-0e2a4c6f8b15");
    expect(id).toBe("studio-mini#signin:5b2e8d4f-6a1c-4f3e-b7d9-0e2a4c6f8b15");
    expect(parseCopyHost(id)?.host).toBe("studio-mini");
    expect(routeCall(id, "terminal.attach", { id: 3, cols: 80, rows: 24 }, () => undefined)).toEqual({
      host: "studio-mini",
      method: "signins.attach",
      params: { member: "5b2e8d4f-6a1c-4f3e-b7d9-0e2a4c6f8b15", terminal: 3, cols: 80, rows: 24 },
    });
    expect(routeCall(id, "terminal.detach", { id: 3 }, (t) => (t === 3 ? 0x4000_0002 : undefined))).toEqual({
      host: "studio-mini",
      method: "session.detach",
      params: { relay: 0x4000_0002 },
    });
    expect(routeCall(id, "terminal.kill", { id: 3 }, () => undefined)).toBeNull();
  });
});
