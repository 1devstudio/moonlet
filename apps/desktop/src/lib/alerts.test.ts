import { describe, expect, it } from "vitest";
import { alertFor } from "./alerts";

const away = { focused: false, visible: false, settings: { notifyWhenFocused: false }, now: 1_000_000 };

describe("a burst of done", () => {
  it("alerts the first done of a session with the done sound and a banner", () => {
    expect(alertFor({ ...away, state: "done" })).toEqual({ sound: "Hero", banner: true });
  });

  it("stays silent for another done within 90 seconds of the last one", () => {
    expect(alertFor({ ...away, state: "done", lastDoneAt: 1_000_000 - 60_000 })).toEqual({ sound: null, banner: false });
  });

  it("alerts a done again after 90 seconds", () => {
    expect(alertFor({ ...away, state: "done", lastDoneAt: 1_000_000 - 90_000 })).toEqual({ sound: "Hero", banner: true });
  });

  it("always alerts needs you and failed", () => {
    expect(alertFor({ ...away, state: "blocked", lastDoneAt: 1_000_000 - 5_000 })).toEqual({ sound: "Glass", banner: true });
    expect(alertFor({ ...away, state: "error", lastDoneAt: 1_000_000 - 5_000 })).toEqual({ sound: "Basso", banner: true });
  });
});

describe("banners per event", () => {
  it("sends no banner for an event switched off, and still plays its sound", () => {
    const settings = { notifyWhenFocused: false, banners: { done: false } };
    expect(alertFor({ ...away, settings, state: "done" })).toEqual({ sound: "Hero", banner: false });
    expect(alertFor({ ...away, settings, state: "blocked" })).toEqual({ sound: "Glass", banner: true });
  });
});

describe("muted", () => {
  it("plays no sound for any event and keeps the banners", () => {
    const settings = { notifyWhenFocused: false, muted: true };
    expect(alertFor({ ...away, settings, state: "blocked" })).toEqual({ sound: null, banner: true });
    expect(alertFor({ ...away, settings, state: "done" })).toEqual({ sound: null, banner: true });
    expect(alertFor({ ...away, settings, state: "error" })).toEqual({ sound: null, banner: true });
  });
});
