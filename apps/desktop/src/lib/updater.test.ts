import { afterEach, describe, expect, it, vi } from "vitest";
import { afterBundleCheck, afterCheck, afterDownloadEvent, checkError, scheduleUpdateChecks, updateButton, updateStatus } from "./updater";

const AUTO = { manual: false, running: "0.1.14" };
const available = { text: "moonlet 0.1.15 is available", kind: "info", install: true } as const;

describe("afterCheck", () => {
  it("offers a found version and announces it", () => {
    expect(afterCheck({ phase: "idle" }, { found: "0.1.15" }, AUTO)).toEqual({ state: { phase: "available", version: "0.1.15" }, notice: available, error: null });
  });

  it("is up to date when nothing newer was found", () => {
    expect(afterCheck({ phase: "idle" }, { found: null }, AUTO)).toEqual({ state: { phase: "current" }, notice: null, error: null });
  });

  it("announces a version once: the hourly check finding it again stays quiet", () => {
    expect(afterCheck({ phase: "available", version: "0.1.15" }, { found: "0.1.15" }, AUTO)).toEqual({ state: { phase: "available", version: "0.1.15" }, notice: null, error: null });
  });

  it("announces a newer version that was published since the last check", () => {
    expect(afterCheck({ phase: "available", version: "0.1.15" }, { found: "0.1.16" }, AUTO)).toEqual({
      state: { phase: "available", version: "0.1.16" },
      notice: { text: "moonlet 0.1.16 is available", kind: "info", install: true },
      error: null,
    });
  });

  it("leaves an update that is downloading, installing or waiting for a restart alone", () => {
    const downloading = { phase: "downloading", version: "0.1.15", received: 10, total: 100 } as const;
    expect(afterCheck(downloading, { found: "0.1.16" }, AUTO)).toEqual({ state: downloading, notice: null, error: null });
    expect(afterCheck({ phase: "installing", version: "0.1.15" }, { found: null }, AUTO)).toEqual({ state: { phase: "installing", version: "0.1.15" }, notice: null, error: null });
    expect(afterCheck({ phase: "ready", version: "0.1.15" }, { found: "0.1.15" }, AUTO)).toEqual({ state: { phase: "ready", version: "0.1.15" }, notice: null, error: null });
  });
});

describe("afterCheck when the user asked", () => {
  const MANUAL = { manual: true, running: "0.1.14" };

  it("says the running version is up to date", () => {
    expect(afterCheck({ phase: "idle" }, { found: null }, MANUAL)).toEqual({
      state: { phase: "current" },
      notice: { text: "moonlet 0.1.14 is up to date", kind: "info", install: false },
      error: null,
    });
  });

  it("repeats a version it already announced", () => {
    expect(afterCheck({ phase: "available", version: "0.1.15" }, { found: "0.1.15" }, MANUAL).notice).toEqual({ text: "moonlet 0.1.15 is available", kind: "info", install: true });
  });

  it("reports a failed check, and Settings keeps the error", () => {
    expect(afterCheck({ phase: "idle" }, { error: "error sending request for url" }, MANUAL)).toEqual({
      state: { phase: "idle" },
      notice: { text: "error sending request for url", kind: "error", install: false },
      error: "error sending request for url",
    });
  });

  it("says where an update in progress is instead of checking again", () => {
    const downloading = { phase: "downloading", version: "0.1.15", received: 1_700_000, total: 4_000_000 } as const;
    expect(afterCheck(downloading, { found: "0.1.16" }, MANUAL)).toEqual({ state: downloading, notice: { text: "moonlet 0.1.15: Downloading 42%", kind: "info", install: false }, error: null });
    expect(afterCheck({ phase: "ready", version: "0.1.15" }, { found: null }, MANUAL).notice).toEqual({ text: "moonlet 0.1.15: Restart to update", kind: "info", install: false });
  });

  it("keeps a failed automatic check quiet", () => {
    expect(afterCheck({ phase: "idle" }, { error: "error sending request for url" }, AUTO)).toEqual({ state: { phase: "idle" }, notice: null, error: null });
  });
});

describe("afterDownloadEvent", () => {
  it("counts the downloaded bytes against the announced size, then installs", () => {
    let s = afterDownloadEvent({ phase: "available", version: "0.1.15" }, { event: "Started", data: { contentLength: 4_000_000 } });
    expect(s).toEqual({ phase: "downloading", version: "0.1.15", received: 0, total: 4_000_000 });
    s = afterDownloadEvent(s, { event: "Progress", data: { chunkLength: 1_500_000 } });
    s = afterDownloadEvent(s, { event: "Progress", data: { chunkLength: 200_000 } });
    expect(s).toEqual({ phase: "downloading", version: "0.1.15", received: 1_700_000, total: 4_000_000 });
    expect(afterDownloadEvent(s, { event: "Finished" })).toEqual({ phase: "installing", version: "0.1.15" });
  });

  it("has no total when the server sends no size", () => {
    expect(afterDownloadEvent({ phase: "available", version: "0.1.15" }, { event: "Started", data: {} })).toEqual({ phase: "downloading", version: "0.1.15", received: 0, total: null });
  });
});

describe("updateButton", () => {
  it("installs a found version", () => {
    expect(updateButton({ phase: "available", version: "0.1.15" })).toEqual({ label: "Update to 0.1.15", action: "install", title: "Update to 0.1.15" });
  });

  it("shows the download and install without an action", () => {
    expect(updateButton({ phase: "downloading", version: "0.1.15", received: 1_700_000, total: 4_000_000 })).toEqual({ label: "Downloading 42%", action: null, title: "Downloading 42%" });
    expect(updateButton({ phase: "downloading", version: "0.1.15", received: 3_250_000, total: null })?.label).toBe("Downloading 3.3 MB");
    expect(updateButton({ phase: "installing", version: "0.1.15" })).toEqual({ label: "Installing…", action: null, title: "Installing…" });
  });

  it("restarts into an installed update", () => {
    expect(updateButton({ phase: "ready", version: "0.1.15" })).toEqual({
      label: "Restart to update",
      action: "restart",
      title: "Restart moonlet into the new version. Terminals and agents keep running.",
    });
  });

  it("shows nothing when there is no update", () => {
    expect(updateButton({ phase: "idle" })).toBeNull();
    expect(updateButton({ phase: "current" })).toBeNull();
  });
});

describe("updateStatus", () => {
  it("names what the last check found", () => {
    expect(updateStatus({ phase: "current" }, false, null)).toBe("Up to date");
    expect(updateStatus({ phase: "available", version: "0.1.15" }, false, null)).toBe("0.1.15 is available");
    expect(updateStatus({ phase: "downloading", version: "0.1.15", received: 1_700_000, total: 4_000_000 }, false, null)).toBe("Downloading 42%");
    expect(updateStatus({ phase: "ready", version: "0.1.15" }, false, null)).toBe("0.1.15 is installed");
  });

  it("shows a running check, then the error of a failed one", () => {
    expect(updateStatus({ phase: "current" }, true, "error sending request for url")).toBe("Checking…");
    expect(updateStatus({ phase: "current" }, false, "error sending request for url")).toBe("error sending request for url");
  });

  it("is empty before the first check", () => {
    expect(updateStatus({ phase: "idle" }, false, null)).toBeNull();
  });
});

describe("scheduleUpdateChecks", () => {
  afterEach(() => vi.useRealTimers());

  it("checks ten seconds after launch, then every hour", () => {
    vi.useFakeTimers();
    const check = vi.fn();
    scheduleUpdateChecks(check, () => true);
    vi.advanceTimersByTime(9_999);
    expect(check).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_589_999);
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(check).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(3_600_000);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("skips the checks while automatic checking is off", () => {
    vi.useFakeTimers();
    const check = vi.fn();
    let on = false;
    scheduleUpdateChecks(check, () => on);
    vi.advanceTimersByTime(10_000 + 3_600_000);
    expect(check).toHaveBeenCalledTimes(0);
    on = true;
    vi.advanceTimersByTime(3_600_000);
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("why a check failed (X35, X43)", () => {
  it("says a development build doesn't update itself, instead of the plugin's error", () => {
    expect(checkError("plugin updater not found")).toBe("Development builds don't update themselves");
  });

  it("keeps any other error as it is", () => {
    expect(checkError("error sending request for url (https://github.com/1devstudio/moonlet/releases/latest/download/latest.json)")).toBe(
      "error sending request for url (https://github.com/1devstudio/moonlet/releases/latest/download/latest.json)",
    );
  });
});

describe("the app on a host updated from another Mac (X69)", () => {
  it("relaunches into a newer bundle on disk", () => {
    expect(afterBundleCheck("0.1.33", "0.1.34", false, "idle")).toBe("relaunch");
    // 0.1.9 is older than 0.1.10.
    expect(afterBundleCheck("0.1.9", "0.1.10", false, "current")).toBe("relaunch");
  });

  it("offers Restart to update instead while there are unsaved edits", () => {
    expect(afterBundleCheck("0.1.33", "0.1.34", true, "idle")).toBe("offer");
  });

  it("leaves this Mac's own update alone: the user restarts when they choose", () => {
    expect(afterBundleCheck("0.1.33", "0.1.34", false, "ready")).toBeNull();
    expect(afterBundleCheck("0.1.33", "0.1.34", false, "downloading")).toBeNull();
    expect(afterBundleCheck("0.1.33", "0.1.34", false, "installing")).toBeNull();
    expect(afterBundleCheck("0.1.33", "0.1.34", false, "available")).toBe("relaunch");
  });

  it("does nothing when the bundle is not newer, or there is none (a dev build)", () => {
    expect(afterBundleCheck("0.1.34", "0.1.34", false, "idle")).toBeNull();
    expect(afterBundleCheck("0.1.34", "0.1.33", false, "idle")).toBeNull();
    expect(afterBundleCheck("0.1.34", null, false, "idle")).toBeNull();
    expect(afterBundleCheck("", "0.1.34", false, "idle")).toBeNull();
  });
});
