import { describe, expect, it } from "vitest";
import { LOADING, loadStep, notLoadedOf, type LoadEvent, type PageLoad } from "./designLoad";

const run = (events: LoadEvent[], from: PageLoad = LOADING) => events.reduce(loadStep, from);

describe("whether the canvas's page loaded (X65)", () => {
  it("asks the bridge once the frame loads in a visible window, and fails the page when it does not answer in time", () => {
    expect(run([{ kind: "load", visible: true }])).toEqual({ phase: "waiting", asked: 1 });
    expect(run([{ kind: "load", visible: true }, { kind: "timeout", asked: 1 }])).toEqual({ phase: "failed", asked: 1, reason: null });
  });

  it("has loaded once the bridge answers, before or after the frame's load", () => {
    expect(run([{ kind: "answer" }, { kind: "load", visible: true }])).toEqual({ phase: "loaded", asked: 0 });
    expect(run([{ kind: "load", visible: true }, { kind: "answer" }, { kind: "timeout", asked: 1 }])).toEqual({ phase: "loaded", asked: 1 });
  });

  it("waits for a hidden window to show before it asks, asks again when the window hides while it waits, and ignores the wait of an earlier ask", () => {
    const hidden = run([{ kind: "load", visible: false }]);
    expect(hidden).toEqual({ phase: "hidden", asked: 0 });
    // However long it stays hidden: a suspended frame answers nothing.
    expect(run([{ kind: "timeout", asked: 0 }], hidden)).toEqual({ phase: "hidden", asked: 0 });
    expect(run([{ kind: "visible" }], hidden)).toEqual({ phase: "waiting", asked: 1 });
    expect(run([{ kind: "visible" }, { kind: "answer" }], hidden)).toEqual({ phase: "loaded", asked: 1 });
    const again = run([{ kind: "visible" }, { kind: "hidden" }, { kind: "timeout", asked: 1 }, { kind: "visible" }], hidden);
    expect(again).toEqual({ phase: "waiting", asked: 2 });
    expect(run([{ kind: "timeout", asked: 2 }], again)).toEqual({ phase: "failed", asked: 2, reason: null });
  });

  it("takes a late answer: a page said not to load that answers after all has loaded", () => {
    expect(run([{ kind: "load", visible: true }, { kind: "timeout", asked: 1 }, { kind: "answer" }])).toEqual({ phase: "loaded", asked: 1 });
  });

  it("starts again on a reload, where the wait of the load before does nothing", () => {
    const failed = run([{ kind: "load", visible: true }, { kind: "timeout", asked: 1 }]);
    expect(run([{ kind: "reload" }], failed)).toEqual({ phase: "loading", asked: 1 });
    expect(run([{ kind: "reload" }, { kind: "load", visible: true }, { kind: "timeout", asked: 1 }], failed)).toEqual({ phase: "waiting", asked: 2 });
    expect(run([{ kind: "reload" }, { kind: "load", visible: true }, { kind: "answer" }], failed)).toEqual({ phase: "loaded", asked: 2 });
  });

  it("fails a page the scheme could not serve at once, with its reason, in a hidden window too", () => {
    expect(run([{ kind: "refused", reason: "the file cannot be read" }, { kind: "load", visible: false }])).toEqual({ phase: "failed", asked: 0, reason: "the file cannot be read" });
    expect(run([{ kind: "load", visible: true }, { kind: "refused", reason: "the file is missing" }, { kind: "timeout", asked: 1 }])).toEqual({ phase: "failed", asked: 1, reason: "the file is missing" });
  });

  it("stays loaded when a link in the page loads its frame again, with no bridge", () => {
    expect(run([{ kind: "answer" }, { kind: "load", visible: true }, { kind: "load", visible: true }, { kind: "timeout", asked: 0 }])).toEqual({ phase: "loaded", asked: 0 });
  });
});

describe("why the canvas's page did not load (X65)", () => {
  const quote = { line: 3, message: "an attribute's quote is never closed" };

  it("is the page's first parse error when its bridge was silent, the scheme's reason when it refused it, and nothing for a page that loads or loaded", () => {
    expect(notLoadedOf({ phase: "failed", asked: 1, reason: null }, quote)).toEqual({ reason: null, parse: quote });
    expect(notLoadedOf({ phase: "failed", asked: 1, reason: null }, null)).toEqual({ reason: null, parse: null });
    // A page not served has no text of its own: a parse error read before is not its.
    expect(notLoadedOf({ phase: "failed", asked: 0, reason: "the file cannot be read" }, quote)).toEqual({ reason: "the file cannot be read", parse: null });
    // A page that loaded never shows its parse errors: a browser recovers from them.
    expect(notLoadedOf({ phase: "loaded", asked: 1 }, quote)).toBeNull();
    expect(notLoadedOf({ phase: "waiting", asked: 1 }, quote)).toBeNull();
    expect(notLoadedOf({ phase: "hidden", asked: 0 }, quote)).toBeNull();
  });
});

