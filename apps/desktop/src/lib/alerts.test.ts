import { describe, expect, it } from "vitest";
import { DoneBursts, alertFor, alertsLikeASession, differsAlert } from "./alerts";

const away = { focused: false, visible: false, settings: { notifyWhenFocused: false }, now: 1_000_000 };

describe("a burst of done", () => {
  it("alerts the first done of a session with the done sound and a banner", () => {
    expect(alertFor({ ...away, state: "done" })).toEqual({ sound: "Hero", banner: true, unread: true });
  });

  it("stays silent for another done within 90 seconds of the last one", () => {
    expect(alertFor({ ...away, state: "done", lastDoneAt: 1_000_000 - 60_000 })).toEqual({ sound: null, banner: false, unread: true });
  });

  it("alerts a done again after 90 seconds", () => {
    expect(alertFor({ ...away, state: "done", lastDoneAt: 1_000_000 - 90_000 })).toEqual({ sound: "Hero", banner: true, unread: true });
  });

  it("always alerts needs you and failed", () => {
    expect(alertFor({ ...away, state: "blocked", lastDoneAt: 1_000_000 - 5_000 })).toEqual({ sound: "Glass", banner: true, unread: true });
    expect(alertFor({ ...away, state: "error", lastDoneAt: 1_000_000 - 5_000 })).toEqual({ sound: "Basso", banner: true, unread: true });
  });
});

describe("banners per event", () => {
  it("sends no banner for an event switched off, and still plays its sound", () => {
    const settings = { notifyWhenFocused: false, banners: { done: false } };
    expect(alertFor({ ...away, settings, state: "done" })).toEqual({ sound: "Hero", banner: false, unread: true });
    expect(alertFor({ ...away, settings, state: "blocked" })).toEqual({ sound: "Glass", banner: true, unread: true });
  });
});

describe("muted", () => {
  it("plays no sound for any event and keeps the banners", () => {
    const settings = { notifyWhenFocused: false, muted: true };
    expect(alertFor({ ...away, settings, state: "blocked" })).toEqual({ sound: null, banner: true, unread: true });
    expect(alertFor({ ...away, settings, state: "done" })).toEqual({ sound: null, banner: true, unread: true });
    expect(alertFor({ ...away, settings, state: "error" })).toEqual({ sound: null, banner: true, unread: true });
  });
});

describe("unread", () => {
  it("marks a session the user is not looking at, even when the alert is silenced", () => {
    expect(alertFor({ ...away, state: "done", lastDoneAt: 1_000_000 - 5_000 }).unread).toBe(true);
    expect(alertFor({ ...away, settings: { notifyWhenFocused: false, muted: true, banners: { done: false } }, state: "done" }).unread).toBe(true);
  });

  it("does not mark the agent on screen", () => {
    expect(alertFor({ ...away, focused: true, visible: true, state: "done" })).toEqual({ sound: null, banner: false, unread: false });
  });
});

describe("DoneBursts", () => {
  const at = (now: number, extra: Partial<typeof away> = {}) => ({ ...away, ...extra, state: "done", now });

  it("silences a session's second done within 90 seconds, not another session's", () => {
    const b = new DoneBursts();
    expect(b.alert("s1", at(0)).sound).toBe("Hero");
    expect(b.alert("s1", at(60_000)).sound).toBeNull();
    expect(b.alert("s2", at(60_000)).sound).toBe("Hero");
    expect(b.alert("s1", at(90_000)).sound).toBe("Hero");
  });

  it("starts no burst from a done the user watched", () => {
    const b = new DoneBursts();
    expect(b.alert("s1", at(0, { focused: true, visible: true }))).toEqual({ sound: null, banner: false, unread: false });
    expect(b.alert("s1", at(10_000)).sound).toBe("Hero");
  });

  it("alerts the next done once the user has looked at the session", () => {
    const b = new DoneBursts();
    b.alert("s1", at(0));
    b.seen("s1");
    expect(b.alert("s1", at(30_000)).sound).toBe("Hero");
  });
});

describe("differsAlert (X60 a file differs between machines)", () => {
  it("notifies in the background, and with a toast instead while moonlet is in front", () => {
    expect(differsAlert({ focused: false, notifyWhenFocused: false, banner: true })).toEqual({ banner: true, toast: false });
    expect(differsAlert({ focused: true, notifyWhenFocused: false, banner: true })).toEqual({ banner: false, toast: true });
  });
  it("notifies instead of the toast in front too when notifications are wanted while focused", () => {
    expect(differsAlert({ focused: true, notifyWhenFocused: true, banner: true })).toEqual({ banner: true, toast: false });
  });
  it("sends nothing with its switch off; the mark and the popover still show the files", () => {
    expect(differsAlert({ focused: false, notifyWhenFocused: false, banner: false })).toEqual({ banner: false, toast: false });
    expect(differsAlert({ focused: true, notifyWhenFocused: true, banner: false })).toEqual({ banner: false, toast: false });
  });
});

describe("a design system's sync agent (X65)", () => {
  it("never alerts like a session: Design mode notifies for it", () => {
    // The daemon tags a sync agent's attention with what it syncs.
    expect(alertsLikeASession({ design: { kind: "sync", workspace: "w1", slug: "moonlet-desktop", name: "moonlet desktop" } })).toBe(false);
    // A daemon from before the tag said which agent marks it `design: true`.
    expect(alertsLikeASession({ design: true })).toBe(false);
    // A standalone chat, with no session either, still alerts.
    expect(alertsLikeASession({ design: false })).toBe(true);
    expect(alertsLikeASession({})).toBe(true);
  });
});

describe("a design's agent (X65)", () => {
  it("alerts like a session, while a sync agent does not", () => {
    expect(alertsLikeASession({ design: { kind: "design", workspace: "w1", slug: "settings-page", name: "Settings page" } })).toBe(true);
    expect(alertsLikeASession({ design: { kind: "sync", workspace: "w1", slug: "moonlet-desktop", name: "moonlet desktop" } })).toBe(false);
  });
});
