import { describe, expect, it } from "vitest";
import { downloadNote, playCounter, playFile, playFrame, playKey, playShown, playStep } from "./designPlay";

describe("playing a design full screen (X99)", () => {
  it("fills the area at 100% with Fill, and fits the viewport into it, never above 100%, with Fit", () => {
    expect(playFrame([1600, 1000], [1440, 900], "fill")).toEqual({ size: [1600, 1000], scale: 1 });
    expect(playFrame([720, 900], [1440, 900], "fit")).toEqual({ size: [1440, 900], scale: 0.5 });
    expect(playFrame([1600, 300], [1440, 900], "fit")).toEqual({ size: [1440, 900], scale: 1 / 3 });
    expect(playFrame([2000, 2000], [390, 844], "fit")).toEqual({ size: [390, 844], scale: 1 });
  });

  it("steps through the pages, stopping at the first and the last", () => {
    const pages = ["index", "settings", "billing"];
    expect(playStep(pages, "index", 1)).toBe("settings");
    expect(playStep(pages, "billing", 1)).toBe("billing");
    expect(playStep(pages, "settings", -1)).toBe("index");
    expect(playStep(pages, "index", -1)).toBe("index");
    expect(playStep(pages, "gone", 1)).toBe("index");
  });

  it("counts the page shown among the design's pages", () => {
    expect(playCounter(["index", "settings", "billing"], "settings")).toBe("2 / 3");
    expect(playCounter(["index"], "index")).toBe("1 / 1");
  });

  it("names the page shown as design.file names it, a snapshot's page in the snapshot's folder", () => {
    expect(playFile("ws1", "settings-page", "billing", null)).toEqual({ workspace: "ws1", path: "designs/settings-page/pages/billing.html" });
    expect(playFile("ws1", "settings-page", "billing", 3)).toEqual({ workspace: "ws1", path: "designs/settings-page@3/pages/billing.html" });
    expect(playFile({ session: "s7" }, "checkout", "index", null)).toEqual({ session: "s7", path: "checkout/pages/index.html" });
  });

  it("goes back on Esc and through the pages on ← and →, never while typing", () => {
    expect(playKey("escape", false)).toBe("back");
    expect(playKey("arrowleft", false)).toBe("prev");
    expect(playKey("arrowright", false)).toBe("next");
    expect(playKey("arrowright", true)).toBeNull();
    expect(playKey("p", false)).toBeNull();
  });

  it("says where Download saved the page, and what it could not read; nothing when cancelled", () => {
    expect(downloadNote({ path: "/Users/me/Downloads/settings.html", missing: [] })).toEqual({ text: "Saved settings.html", tone: "info" });
    expect(downloadNote({ path: "/tmp/settings.html", missing: ["../assets/gone.png", "fonts/x.woff2"] })).toEqual({
      text: "Saved settings.html, without 2 files it could not read: ../assets/gone.png, fonts/x.woff2",
      tone: "error",
    });
    expect(downloadNote({ path: null, missing: [] })).toBeNull();
  });

  it("shows the page played while it is there, else the design's first page, and none when no page is left", () => {
    expect(playShown(["index", "settings"], "settings")).toBe("settings");
    expect(playShown(["index", "billing"], "settings")).toBe("index");
    expect(playShown([], "settings")).toBeNull();
  });
});
