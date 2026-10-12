import { describe, expect, it } from "vitest";
import { afterCheck, updateButtonLabel, onDownload } from "./updater";

describe("afterCheck", () => {
  it("offers a found version and announces it", () => {
    expect(afterCheck({ phase: "idle" }, "0.1.15")).toEqual({ state: { phase: "available", version: "0.1.15" }, announce: true });
  });

  it("is up to date when nothing newer was found", () => {
    expect(afterCheck({ phase: "idle" }, null)).toEqual({ state: { phase: "current" }, announce: false });
  });

  it("announces a version once: the six-hour check finding it again stays quiet", () => {
    expect(afterCheck({ phase: "available", version: "0.1.15" }, "0.1.15")).toEqual({ state: { phase: "available", version: "0.1.15" }, announce: false });
  });

  it("announces a newer version that was published since the last check", () => {
    expect(afterCheck({ phase: "available", version: "0.1.15" }, "0.1.16")).toEqual({ state: { phase: "available", version: "0.1.16" }, announce: true });
  });

  it("leaves an update that is downloading, installing or waiting for a restart alone", () => {
    const downloading = { phase: "downloading", version: "0.1.15", received: 10, total: 100 } as const;
    expect(afterCheck(downloading, "0.1.16")).toEqual({ state: downloading, announce: false });
    expect(afterCheck({ phase: "installing", version: "0.1.15" }, null)).toEqual({ state: { phase: "installing", version: "0.1.15" }, announce: false });
    expect(afterCheck({ phase: "ready", version: "0.1.15" }, "0.1.15")).toEqual({ state: { phase: "ready", version: "0.1.15" }, announce: false });
  });
});

describe("onDownload", () => {
  it("counts the downloaded bytes against the announced size, then installs", () => {
    let s = onDownload({ phase: "available", version: "0.1.15" }, { event: "Started", data: { contentLength: 4_000_000 } });
    expect(s).toEqual({ phase: "downloading", version: "0.1.15", received: 0, total: 4_000_000 });
    s = onDownload(s, { event: "Progress", data: { chunkLength: 1_500_000 } });
    s = onDownload(s, { event: "Progress", data: { chunkLength: 200_000 } });
    expect(s).toEqual({ phase: "downloading", version: "0.1.15", received: 1_700_000, total: 4_000_000 });
    expect(onDownload(s, { event: "Finished" })).toEqual({ phase: "installing", version: "0.1.15" });
  });

  it("has no total when the server sends no size", () => {
    expect(onDownload({ phase: "available", version: "0.1.15" }, { event: "Started", data: {} })).toEqual({ phase: "downloading", version: "0.1.15", received: 0, total: null });
  });
});

describe("updateButtonLabel", () => {
  it("names the step the update is at", () => {
    expect(updateButtonLabel({ phase: "available", version: "0.1.15" })).toBe("Update to 0.1.15");
    expect(updateButtonLabel({ phase: "downloading", version: "0.1.15", received: 1_700_000, total: 4_000_000 })).toBe("Downloading 42%");
    expect(updateButtonLabel({ phase: "downloading", version: "0.1.15", received: 3_250_000, total: null })).toBe("Downloading 3.3 MB");
    expect(updateButtonLabel({ phase: "installing", version: "0.1.15" })).toBe("Installing…");
    expect(updateButtonLabel({ phase: "ready", version: "0.1.15" })).toBe("Restart to update");
  });

  it("shows nothing when there is no update", () => {
    expect(updateButtonLabel({ phase: "idle" })).toBeNull();
    expect(updateButtonLabel({ phase: "current" })).toBeNull();
  });
});
