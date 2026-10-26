import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameLoader, frameQueue, type FrameStep, type FrameTurn } from "./frameQueue";

/** Frames joining `queue`, each with the steps it was told. */
function frames(queue: ReturnType<typeof frameQueue>, names: string[]) {
  const steps: Record<string, FrameStep[]> = {};
  const turns: Record<string, FrameTurn> = {};
  for (const n of names) {
    steps[n] = [];
    turns[n] = queue.join((step) => steps[n].push(step));
  }
  const now = () => Object.fromEntries(names.map((n) => [n, steps[n].at(-1)]));
  return { steps, turns, now };
}

describe("the card frames' loading queue (X64)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("loads one frame at a time, the next once the one loading has loaded", () => {
    const { turns, now, steps } = frames(frameQueue(1000), ["colours", "type", "button"]);
    expect(now()).toEqual({ colours: "loading", type: "waiting", button: "waiting" });
    turns.colours.loaded();
    expect(now()).toEqual({ colours: "shown", type: "loading", button: "waiting" });
    turns.type.loaded();
    turns.button.loaded();
    expect(now()).toEqual({ colours: "shown", type: "shown", button: "shown" });
    expect(steps.type).toEqual(["waiting", "loading", "shown"]);
  });

  it("shows a frame that never says it loaded after the fallback, and lets the next one load", () => {
    const { turns, now } = frames(frameQueue(1000), ["loop", "calm"]);
    vi.advanceTimersByTime(999);
    expect(now()).toEqual({ loop: "loading", calm: "waiting" });
    vi.advanceTimersByTime(1);
    expect(now()).toEqual({ loop: "shown", calm: "loading" });
    // Its load, late, takes no turn from the frame loading now.
    turns.loop.loaded();
    expect(now()).toEqual({ loop: "shown", calm: "loading" });
  });

  it("gives up the place of a frame let go while it waits, and the turn of one let go while it loads", () => {
    const queue = frameQueue(1000);
    const { turns, now, steps } = frames(queue, ["colours", "type", "button"]);
    turns.type.leave();
    turns.colours.leave();
    expect(now()).toEqual({ colours: "loading", type: "waiting", button: "loading" });
    turns.button.loaded();
    expect(steps.type).toEqual(["waiting"]);
    // Nothing is left loading: the next frame loads at once.
    const next = frames(queue, ["kbd"]);
    expect(next.now()).toEqual({ kbd: "loading" });
  });
});

describe("a card frame's loads (X64)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A frame loading through `queue`, and what it was told last. */
  function frame(queue: ReturnType<typeof frameQueue>) {
    let seen: { src: string | null; step: FrameStep } = { src: null, step: "waiting" };
    const loader = frameLoader(queue, (s) => (seen = s));
    return { loader, seen: () => seen };
  }
  const v = (n: number) => `moonlet-design://5a1c3e0f9b2d4c67.w1/systems/s/components/buttons/button/button.html?v=${n}`;

  it("gets its address once its turn comes, and shows once it loaded", () => {
    const queue = frameQueue(1000);
    const colours = frame(queue);
    const button = frame(queue);
    colours.loader.load(v(1).replace("button", "colours"));
    button.loader.load(v(1));
    expect(button.seen()).toEqual({ src: null, step: "waiting" });
    colours.loader.loaded();
    expect(button.seen()).toEqual({ src: v(1), step: "loading" });
    button.loader.loaded();
    expect(button.seen()).toEqual({ src: v(1), step: "shown" });
  });

  it("is never sent to a new address while it loads: that waits until the load is done", () => {
    const button = frame(frameQueue(1000));
    button.loader.load(v(1));
    button.loader.load(v(2));
    button.loader.load(v(3));
    expect(button.seen()).toEqual({ src: v(1), step: "waiting" });
    button.loader.loaded();
    expect(button.seen()).toEqual({ src: v(3), step: "loading" });
    button.loader.loaded();
    expect(button.seen()).toEqual({ src: v(3), step: "shown" });
  });

  it("goes straight to the newest address when it changed while the frame waited", () => {
    const queue = frameQueue(1000);
    const colours = frame(queue);
    const button = frame(queue);
    colours.loader.load(v(1).replace("button", "colours"));
    button.loader.load(v(1));
    button.loader.load(v(2));
    colours.loader.loaded();
    expect(button.seen()).toEqual({ src: v(2), step: "loading" });
  });

  it("takes a load that comes while it waits for its turn as none of its own", () => {
    const queue = frameQueue(1000);
    const colours = frame(queue);
    const button = frame(queue);
    colours.loader.load(v(1).replace("button", "colours"));
    button.loader.load(v(1));
    // The empty frame's own first load, before it was given an address.
    button.loader.loaded();
    expect(button.seen()).toEqual({ src: null, step: "waiting" });
    expect(colours.seen().step).toBe("loading");
  });

  it("lets go of its turns when it is stopped, so the next frame loads", () => {
    const queue = frameQueue(1000);
    const colours = frame(queue);
    const button = frame(queue);
    colours.loader.load(v(1).replace("button", "colours"));
    button.loader.load(v(1));
    colours.loader.stop();
    expect(button.seen()).toEqual({ src: v(1), step: "loading" });
  });
});
