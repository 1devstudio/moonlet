import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNow } from "./useNow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A component reading `useNow(active)`, rendered again with each `render`. */
function clock() {
  let now = 0;
  const Probe = ({ active }: { active: boolean }) => {
    now = useNow(active);
    return null;
  };
  const root = createRoot(document.createElement("div"));
  return {
    render: (active: boolean) => act(() => root.render(createElement(Probe, { active }))),
    shows: () => new Date(now).toISOString(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useNow (X82)", () => {
  it("reads the time at once when its clock starts again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
    const c = clock();
    c.render(true);
    c.render(false);
    vi.setSystemTime(new Date("2026-11-03T10:05:00Z"));
    c.render(true);
    expect(c.shows()).toBe("2026-11-03T10:05:00.000Z");
  });
});
