import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OutputSink } from "./daemon";

// The daemon bridge, faked: what the app sends it, and the output sinks it
// would feed with the daemon's replay and live output.
const sent: [string, string, unknown][] = [];
const sinks = new Map<string, OutputSink>();
vi.mock("./daemon", () => ({
  rpc: async (host: string, method: string, params: unknown) => {
    sent.push([host, method, params]);
    return {};
  },
  sendInput: async () => {},
  registerSink: (host: string, session: number, sink: OutputSink) => {
    sinks.set(`${host}:${session}`, sink);
    return () => {
      if (sinks.get(`${host}:${session}`) === sink) sinks.delete(`${host}:${session}`);
    };
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));

import { disposeEntry, findEntry, getEntry, shortPath, terminalsToLetGo } from "./terminals";

describe("shortPath", () => {
  it("shortens a path under the home folder to ~, as a new chat shows its folder (X38)", () => {
    expect(shortPath("/Users/jane/code/app", "/Users/jane")).toBe("~/code/app");
    expect(shortPath("/Users/jane", "/Users/jane")).toBe("~");
    expect(shortPath("/Users/janet/app", "/Users/jane")).toBe("/Users/janet/app");
    expect(shortPath("/srv/app", null)).toBe("/srv/app");
  });
});

describe("terminalsToLetGo", () => {
  it("lets go of the least recently shown terminals beyond the limit (X80)", () => {
    expect(terminalsToLetGo(["h:1", "h:2", "h:3", "h:4", "h:5"], new Set(), 3)).toEqual(["h:1", "h:2"]);
    expect(terminalsToLetGo(["h:1", "h:2", "h:3"], new Set(), 3)).toEqual([]);
  });

  it("never lets go of a terminal on screen, even past the limit (X80)", () => {
    expect(terminalsToLetGo(["h:1", "h:2", "h:3", "h:4"], new Set(["h:1"]), 2)).toEqual(["h:2", "h:3"]);
    expect(terminalsToLetGo(["h:1", "h:2", "h:3"], new Set(["h:1", "h:2", "h:3"]), 1)).toEqual([]);
  });
});

describe("live terminals (X80)", () => {
  beforeAll(() => {
    // What jsdom lacks and xterm needs to open a terminal.
    const ctx: object = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 8 }) : k === "canvas" ? undefined : () => {}), set: () => true });
    HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
    window.matchMedia ??= (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as never;
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
    } as never;
  });

  const shown: [string, number][] = [];
  /** Shows a terminal in a pane, as a tab switched to does. */
  const show = (host: string, session: number) => {
    shown.push([host, session]);
    const pane = document.createElement("div");
    document.body.append(pane);
    const entry = getEntry(host, session);
    entry.mount(pane);
    return entry;
  };
  const detached = (host: string) => sent.filter(([h, m]) => h === host && m === "terminal.detach").map(([, , p]) => p);

  afterEach(() => {
    for (const [host, session] of shown) disposeEntry(host, session);
    shown.length = 0;
    sent.length = 0;
  });

  it("a ninth terminal shown lets go of the one shown longest ago, and detaches it (X80)", () => {
    for (let id = 1; id <= 9; id++) show("a", id).unmount();
    expect(findEntry("a", 1)).toBeUndefined();
    expect(findEntry("a", 2)).toBeDefined();
    expect(findEntry("a", 9)).toBeDefined();
    expect(detached("a")).toEqual([{ id: 1 }]);
  });

  it("a terminal let go of attaches again when shown, and the replay draws it (X80)", async () => {
    for (let id = 1; id <= 9; id++) show("b", id).unmount();
    sent.length = 0;
    const again = show("b", 1);
    expect(sent.filter(([, m]) => m === "terminal.attach")).toEqual([["b", "terminal.attach", { id: 1, cols: 80, rows: 24 }]]);
    sinks.get("b:1")!.reset(new TextEncoder().encode("$ make\r\nbuilt\r\n"));
    await vi.waitFor(() => expect([again.lineText(0), again.lineText(1)]).toEqual(["$ make", "built"]));
    expect(findEntry("b", 1)).toBe(again);
  });

  it("a terminal in a split on screen is kept however many others are shown (X80)", () => {
    const split = show("c", 1);
    for (let id = 2; id <= 10; id++) show("c", id).unmount();
    expect(findEntry("c", 1)).toBe(split);
    expect(detached("c")).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it("a block dropped past the 2000 kept lets go of its marks (X80)", async () => {
    const entry = show("d", 1);
    const write = (data: string) => new Promise<void>((done) => entry.term.write(data, done));
    // A finished command, with its prompt, output and end marks (OSC 133).
    const block = "\x1b]133;A\x07$ make\r\n\x1b]133;C\x07built\r\n\x1b]133;D;0\x07";
    await write(block.repeat(2000));
    const oldest = entry.blocks[0];
    await write(block);
    expect(entry.blocks.length).toBe(2000);
    expect([oldest.prompt.isDisposed, oldest.output?.isDisposed, oldest.end?.isDisposed]).toEqual([true, true, true]);
    expect(entry.term.markers.length).toBe(6000);
  });
});
