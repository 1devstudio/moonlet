import { describe, expect, it } from "vitest";
import type { Copy } from "./protocol";
import { centralPrompt, composerSync, differsNotice, endedToast, markTone, setupPrompt, stopPrompt, syncChoice, syncLine, tooBigLine } from "./sync";

const copy = (patch: Partial<Copy> = {}): Copy => ({
  id: "c1",
  host: "studio-mini",
  session: "s1",
  path: "/Users/alex/.moonlet/worktrees/shop/fix-cart",
  state: { kind: "in_sync" },
  setup: null,
  differs: [],
  too_big: [],
  diverged: null,
  ...patch,
});

const at = { branch: "fix-cart", home: "/Users/alex" };

describe("syncLine (X60 status lines)", () => {
  it("says what the copy is doing, as the spec words it", () => {
    expect(syncLine(copy({ state: { kind: "copying" } }), at).text).toBe("Copying to this Mac…");
    expect(syncLine(copy(), at).text).toBe("In sync · ~/.moonlet/worktrees/shop/fix-cart");
    expect(syncLine(copy({ state: { kind: "syncing", files: 12 } }), at).text).toBe("Syncing 12 files…");
    expect(syncLine(copy({ state: { kind: "syncing", files: 1 } }), at).text).toBe("Syncing 1 file…");
    expect(syncLine(copy({ state: { kind: "waiting" } }), at).text).toBe("Waiting for studio-mini. Changes made on this Mac sync when it is back.");
    expect(syncLine(copy({ state: { kind: "paused", reason: "the copy is on main, not fix-cart." } }), at).text).toBe("Paused: the copy is on main, not fix-cart.");
  });

  it("puts setup, differing files and a diverged branch before In sync", () => {
    expect(syncLine(copy({ setup: { state: { kind: "running" }, command: "pnpm install" } }), at).text).toBe("Running setup…");
    expect(syncLine(copy({ setup: { state: { kind: "failed", exit: 1 }, command: "pnpm install" } }), at).text).toBe("Setup failed (exit 1)");
    expect(syncLine(copy({ differs: ["src/cart.ts"] }), at).text).toBe("1 file differs");
    expect(syncLine(copy({ differs: ["a", "b", "c"] }), at).text).toBe("3 files differ");
    expect(syncLine(copy({ diverged: { ahead: 1, behind: 2 } }), at).text).toBe("fix-cart has diverged: 1 commit on this Mac, 2 on studio-mini. Files still sync.");
    expect(syncLine(copy({ diverged: { ahead: 2, behind: 1 } }), at).text).toBe("fix-cart has diverged: 2 commits on this Mac, 1 on studio-mini. Files still sync.");
  });

  it("lets a paused or waiting copy say so over everything else", () => {
    const busy = { differs: ["a"], diverged: { ahead: 1, behind: 1 }, setup: { state: { kind: "running" as const }, command: "x" } };
    expect(syncLine(copy({ ...busy, state: { kind: "paused", reason: "studio-mini sent a path outside the copy." } }), at).text).toBe("Paused: studio-mini sent a path outside the copy.");
    expect(syncLine(copy({ ...busy, state: { kind: "waiting" } }), at).text).toBe("Waiting for studio-mini. Changes made on this Mac sync when it is back.");
  });

  it("leaves the path out where it is shown on its own, as in the popover", () => {
    expect(syncLine(copy(), { ...at, path: false }).text).toBe("In sync");
  });

  it("keeps a path outside the home folder as it is", () => {
    expect(syncLine(copy({ path: "/Volumes/work/fix-cart" }), at).text).toBe("In sync · /Volumes/work/fix-cart");
  });
});

describe("markTone (X60 sidebar mark)", () => {
  it("is muted while copying, waiting or paused, accent when a file differs or the branch diverged, plain otherwise", () => {
    expect(markTone(copy({ state: { kind: "copying" } }))).toBe("muted");
    expect(markTone(copy({ state: { kind: "waiting" } }))).toBe("muted");
    expect(markTone(copy({ state: { kind: "paused", reason: "x" } }))).toBe("muted");
    expect(markTone(copy({ differs: ["a"] }))).toBe("accent");
    expect(markTone(copy({ diverged: { ahead: 1, behind: 1 } }))).toBe("accent");
    expect(markTone(copy())).toBe("plain");
    expect(markTone(copy({ state: { kind: "syncing", files: 3 } }))).toBe("plain");
  });
});

describe("syncChoice (X60 the session menu's Keep in sync)", () => {
  const hosts = { local: "local", "studio-mini": "tailnet", "build-box": "tailnet", devbox: "ssh" } as const;
  it("offers it on the central host's sessions, and on another tailnet host's after making it the central host", () => {
    expect(syncChoice("studio-mini", hosts["studio-mini"], "studio-mini")).toEqual({ needsCentral: false });
    expect(syncChoice("build-box", hosts["build-box"], "studio-mini")).toEqual({ needsCentral: true });
    expect(syncChoice("build-box", hosts["build-box"], null)).toEqual({ needsCentral: true });
  });
  it("never on this Mac's or an SSH host's sessions", () => {
    expect(syncChoice("local", hosts.local, "studio-mini")).toBeNull();
    expect(syncChoice("devbox", hosts.devbox, "studio-mini")).toBeNull();
  });
});

describe("composerSync (X60 the composer's checkbox and the project page switch)", () => {
  it("shows only for a project on the central host, ticked when the project keeps new sessions in sync", () => {
    expect(composerSync("studio-mini", "studio-mini", true)).toEqual({ show: true, checked: true });
    expect(composerSync("studio-mini", "studio-mini", false)).toEqual({ show: true, checked: false });
    expect(composerSync("build-box", "studio-mini", true)).toEqual({ show: false, checked: false });
    expect(composerSync("local", null, false)).toEqual({ show: false, checked: false });
  });
});

describe("prompts and notices (X60)", () => {
  it("asks to make another tailnet host the central host first", () => {
    expect(centralPrompt("fix-cart", "build-box")).toMatchObject({
      title: "Keep in sync",
      message: "Keeping fix-cart in sync needs build-box as this Mac's central host. Make it the central host?",
      action: "Make it the central host",
    });
  });

  it("asks before running a setup, showing the exact command", () => {
    expect(setupPrompt("shop", "pnpm install")).toMatchObject({
      title: "Run setup",
      message: "Run shop's setup in the copy on this Mac? (from .moonlet/config.toml)",
      code: "pnpm install",
      action: "Run setup",
      cancel: "Skip",
    });
  });

  it("says what turning sync off removes, and what it saves first", () => {
    expect(stopPrompt("fix-cart", 0, "/Users/alex/.moonlet/worktrees/shop/fix-cart", "/Users/alex/.moonlet", "/Users/alex").message).toBe(
      "Stop keeping fix-cart in sync? The copy on this Mac is removed.",
    );
    expect(stopPrompt("fix-cart", 2, "/Users/alex/.moonlet/worktrees/shop/fix-cart", "/Users/alex/.moonlet", "/Users/alex").message).toBe(
      "Stop keeping fix-cart in sync? The copy on this Mac is removed. 2 files that differ are saved to ~/.moonlet/sync-leftovers/fix-cart first.",
    );
    expect(stopPrompt("fix-cart", 1, "/Users/alex/.moonlet/worktrees/shop/fix-cart", "/Users/alex/.moonlet", "/Users/alex").message).toBe(
      "Stop keeping fix-cart in sync? The copy on this Mac is removed. 1 file that differs is saved to ~/.moonlet/sync-leftovers/fix-cart first.",
    );
  });

  it("tells the user a copy went and where its files are", () => {
    const folder = "/Users/alex/.moonlet/sync-leftovers/fix-cart";
    expect(endedToast("fix-cart", "studio-mini", { reason: "archived", folder, leftovers: ["src/cart.ts"] }, "/Users/alex")).toBe(
      "fix-cart was archived on studio-mini. 1 file from this Mac is in ~/.moonlet/sync-leftovers/fix-cart.",
    );
    expect(endedToast("fix-cart", "studio-mini", { reason: "archived", folder, leftovers: ["a", "b"] }, "/Users/alex")).toBe(
      "fix-cart was archived on studio-mini. 2 files from this Mac are in ~/.moonlet/sync-leftovers/fix-cart.",
    );
    expect(endedToast("fix-cart", "studio-mini", { reason: "archived", folder, leftovers: [] }, "/Users/alex")).toBe("fix-cart was archived on studio-mini. Its copy on this Mac is removed.");
    expect(endedToast("fix-cart", "studio-mini", { reason: "stopped", folder, leftovers: ["a"] }, "/Users/alex")).toBe(
      "Stopped keeping fix-cart in sync. 1 file from this Mac is in ~/.moonlet/sync-leftovers/fix-cart.",
    );
    expect(endedToast("fix-cart", "studio-mini", { reason: "stopped", folder, leftovers: [] }, "/Users/alex")).toBe("Stopped keeping fix-cart in sync.");
  });

  it("words the notification for one file and for several", () => {
    expect(differsNotice("fix-cart", "studio-mini", ["src/cart.ts"])).toEqual({
      title: "fix-cart",
      body: "src/cart.ts changed on both studio-mini and this Mac. Pick a version.",
      text: "fix-cart: src/cart.ts changed on both studio-mini and this Mac. Pick a version.",
    });
    expect(differsNotice("fix-cart", "studio-mini", ["a", "b", "c"]).text).toBe("fix-cart: 3 files changed on both studio-mini and this Mac. Pick a version for each.");
  });

});

describe("tooBigLine (X60)", () => {
  it("says a file over the limit stays on each machine", () => {
    expect(tooBigLine("big.bin")).toBe("big.bin is over 100 MB and stays on each machine.");
  });
});
