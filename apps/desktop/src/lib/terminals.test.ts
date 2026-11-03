import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OutputSink } from "./daemon";

// The daemon bridge, faked: what the app sends it, the output sinks it
// would feed with the daemon's replay and live output, and the terminals
// the daemon sends output for. While `daemon.hold` is set, attaches are
// answered (and subscribe) only once `daemon.answer()` is called.
const sent: [string, string, unknown][] = [];
const sinks = new Map<string, OutputSink>();
const daemon = {
  subscribed: new Set<string>(),
  hold: false,
  waiting: [] as (() => void)[],
  answer() {
    for (const done of this.waiting.splice(0)) done();
  },
};
vi.mock("./daemon", () => ({
  rpc: async (host: string, method: string, params: unknown) => {
    sent.push([host, method, params]);
    const key = `${host}:${(params as { id: number }).id}`;
    if (method === "terminal.attach") {
      if (daemon.hold) await new Promise<void>((done) => daemon.waiting.push(done));
      daemon.subscribed.add(key);
    }
    if (method === "terminal.detach") daemon.subscribed.delete(key);
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

import { disposeEntry, entryFor, findEntry, getEntry, shortPath, terminalsToLetGo } from "./terminals";

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
    // Characters 8 by 16 px, as xterm measures its font with a hidden span.
    const measured = (side: number) => ({
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? side : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", measured(8 * 32));
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", measured(16));
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
  /** Shows a terminal in a pane 960 by 480 px, laid out as the window lays
   * out a tab's pane before its terminal is mounted. */
  const showSized = (host: string, session: number) => {
    shown.push([host, session]);
    const style = document.createElement("style");
    style.textContent = ".moonlet-term { width: 960px; height: 480px; } .xterm { padding: 0px; }";
    document.head.append(style);
    const pane = document.createElement("div");
    Object.defineProperty(pane, "clientWidth", { value: 960 });
    Object.defineProperty(pane, "clientHeight", { value: 480 });
    document.body.append(pane);
    getEntry(host, session).mount(pane);
    style.remove();
  };
  /** The terminals of `host` the app sent `terminal.detach` for. */
  const detached = (host: string) => [...new Set(sent.filter(([h, m]) => h === host && m === "terminal.detach").map(([, , p]) => (p as { id: number }).id))];
  /** Once the panes shown together have all mounted. */
  const settled = () => new Promise((done) => setTimeout(done, 0));

  afterEach(() => {
    for (const [host, session] of shown) disposeEntry(host, session);
    shown.length = 0;
    sent.length = 0;
    daemon.hold = false;
    daemon.answer();
    daemon.subscribed.clear();
  });

  it("a ninth terminal shown lets go of the one shown longest ago, and detaches it (X80)", async () => {
    for (let id = 1; id <= 9; id++) show("a", id).unmount();
    await settled();
    expect(findEntry("a", 1)).toBeUndefined();
    expect(findEntry("a", 2)).toBeDefined();
    expect(findEntry("a", 9)).toBeDefined();
    expect(detached("a")).toEqual([1]);
    // The daemon sends it no more output, and none would reach its xterm.
    expect(daemon.subscribed.has("a:1")).toBe(false);
    expect(sinks.has("a:1")).toBe(false);
  });

  it("a terminal let go of attaches again when shown, and the replay draws it (X80)", async () => {
    for (let id = 1; id <= 9; id++) show("b", id).unmount();
    await settled();
    sent.length = 0;
    const again = show("b", 1);
    expect(sent.filter(([, m]) => m === "terminal.attach")).toEqual([["b", "terminal.attach", { id: 1, cols: 80, rows: 24 }]]);
    sinks.get("b:1")!.reset(new TextEncoder().encode("$ make\r\nbuilt\r\n"));
    await vi.waitFor(() => expect([again.lineText(0), again.lineText(1)]).toEqual(["$ make", "built"]));
    expect(findEntry("b", 1)).toBe(again);
  });

  it("a terminal shown again attaches at the size its pane fits, not 80x24 (X80)", async () => {
    for (let id = 1; id <= 9; id++) show("g", id).unmount();
    await settled();
    sent.length = 0;
    showSized("g", 1);
    // Past the 60 ms a resize waits for, so a resize after the attach shows.
    await new Promise((done) => setTimeout(done, 100));
    expect(sent.filter(([, , p]) => (p as { id: number }).id === 1)).toEqual([["g", "terminal.attach", { id: 1, cols: 119, rows: 26 }]]);
  });

  it("a terminal that leaves the screen counts as shown just then (X80)", async () => {
    const split = show("h", 1);
    for (let id = 2; id <= 8; id++) show("h", id).unmount();
    // The split is closed after the others were shown.
    split.unmount();
    show("h", 9).unmount();
    await settled();
    expect(findEntry("h", 1)).toBe(split);
    expect(detached("h")).toEqual([2]);
  });

  it("ten terminals on screen at once are all kept (X80)", async () => {
    const onScreen = [];
    for (let id = 1; id <= 10; id++) onScreen.push(show("k", id));
    await settled();
    for (let id = 1; id <= 10; id++) expect(findEntry("k", id)).toBe(onScreen[id - 1]);
    expect(detached("k")).toEqual([]);
  });

  it("a hidden pane creates no terminal, nor brings back one let go of (X80)", async () => {
    expect(entryFor("l", 1, false)).toBeUndefined();
    expect(findEntry("l", 1)).toBeUndefined();
    const live = show("l", 1);
    live.unmount();
    expect(entryFor("l", 1, false)).toBe(live);
    for (let id = 2; id <= 9; id++) show("l", id).unmount();
    await settled();
    expect(entryFor("l", 1, false)).toBeUndefined();
    // Shown, its pane creates it anew.
    const again = entryFor("l", 1, true);
    expect(again).toBeDefined();
    expect(findEntry("l", 1)).toBe(again);
  });

  it("a split of ten hidden lets go of the two shown longest ago (X80)", async () => {
    const split = [];
    for (let id = 1; id <= 10; id++) split.push(show("m", id));
    await settled();
    // Another tab is shown: the split's panes unmount, first to last.
    for (const pane of split) pane.unmount();
    await settled();
    expect(detached("m")).toEqual([1, 2]);
    expect(findEntry("m", 1)).toBeUndefined();
    expect(findEntry("m", 3)).toBe(split[2]);
  });

  it("a pane unmounted and mounted again in one go is kept (X80)", async () => {
    const panes = [];
    for (let id = 1; id <= 9; id++) panes.push(show("n", id));
    await settled();
    // Its pane's effect runs again: cleanup, then mount at once.
    const first = panes[0];
    const pane = document.createElement("div");
    document.body.append(pane);
    first.unmount();
    first.mount(pane);
    await settled();
    expect(findEntry("n", 1)).toBe(first);
    expect(detached("n")).toEqual([]);
  });

  it("a split tab shown keeps both its panes, though one was shown longest ago (X80)", async () => {
    const second = show("i", 1);
    second.unmount();
    for (let id = 2; id <= 8; id++) show("i", id).unmount();
    // A split tab is shown: its panes mount one after the other, the first a
    // new terminal, the second the one shown longest ago.
    show("i", 9);
    show("i", 1);
    await settled();
    expect(findEntry("i", 1)).toBe(second);
    expect(detached("i")).toEqual([2]);
  });

  it("a terminal in a split on screen is kept however many others are shown (X80)", async () => {
    const split = show("c", 1);
    for (let id = 2; id <= 10; id++) show("c", id).unmount();
    await settled();
    expect(findEntry("c", 1)).toBe(split);
    expect(detached("c")).toEqual([2, 3]);
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

  it("a command's input mark (B) leaves no mark behind in the terminal (X80)", async () => {
    const entry = show("d", 2);
    // As a shell sends it: prompt, input start, command start and end.
    const block = "\x1b]133;A\x07$ \x1b]133;B\x07make\r\n\x1b]133;C\x07built\r\n\x1b]133;D;0\x07";
    await new Promise<void>((done) => entry.term.write(block, done));
    expect(entry.blocks.length).toBe(1);
    expect(entry.term.markers.length).toBe(3);
  });

  it("a terminal let go of while its attach is on its way is detached once the attach answers (X80)", async () => {
    daemon.hold = true;
    for (let id = 1; id <= 9; id++) show("e", id).unmount();
    await settled();
    expect(findEntry("e", 1)).toBeUndefined();
    daemon.answer();
    await vi.waitFor(() => expect([...daemon.subscribed].sort()).toEqual(["e:2", "e:3", "e:4", "e:5", "e:6", "e:7", "e:8", "e:9"]));
  });

  it("a terminal shown again before its slow attach answers stays subscribed (X80)", async () => {
    daemon.hold = true;
    for (let id = 1; id <= 9; id++) show("f", id).unmount();
    await settled();
    // Shown again while the attach of the terminal let go of is on its way.
    show("f", 1);
    daemon.answer();
    await vi.waitFor(() => expect(daemon.subscribed.has("f:9")).toBe(true));
    await settled();
    expect([...daemon.subscribed].sort()).toEqual(["f:1", "f:3", "f:4", "f:5", "f:6", "f:7", "f:8", "f:9"]);
  });
});
