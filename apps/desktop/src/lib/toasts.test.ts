import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissToast, toast, useStore } from "./store";

vi.mock("./daemon", () => ({ rpc: vi.fn(() => Promise.resolve()), sendInput: vi.fn() }));

const shown = () => useStore.getState().toasts.map((t) => t.text);

describe("toasts (A3)", () => {
  beforeEach(() => {
    useStore.setState({ toasts: [] });
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("dismisses one toast and leaves the others", () => {
    toast("Copied command");
    toast("build-box needs attention", "info", { label: "Go to", run: () => {} });
    dismissToast(useStore.getState().toasts[1].id);
    expect(shown()).toEqual(["Copied command"]);
  });

  it("closes a toast with an action on its own after 10 s", () => {
    toast("build-box needs attention", "info", { label: "Go to", run: () => {} });
    vi.advanceTimersByTime(9_999);
    expect(shown()).toEqual(["build-box needs attention"]);
    vi.advanceTimersByTime(1);
    expect(shown()).toEqual([]);
  });

  it("keeps a sticky toast until it is dismissed", () => {
    toast("studio-mini opened a sign-in and waits for you", "info", { label: "Open", run: () => {} }, { sticky: true });
    vi.advanceTimersByTime(60 * 60_000);
    expect(shown()).toEqual(["studio-mini opened a sign-in and waits for you"]);
    dismissToast(useStore.getState().toasts[0].id);
    expect(shown()).toEqual([]);
  });
});
