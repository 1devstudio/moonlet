import { describe, expect, it } from "vitest";
import type { Copy } from "./protocol";
import { centralChangePrompt, centralPrompt, compareReadError, composerSync, differsNotice, endedToast, markTone, setupActions, setupPrompt, stopPrompt, syncChoice, syncLine, syncOffered, tooBigLine } from "./sync";

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
    expect(syncLine(copy({ state: { kind: "copying" } }), at)).toBe("Copying to this Mac…");
    expect(syncLine(copy(), at)).toBe("In sync · ~/.moonlet/worktrees/shop/fix-cart");
    expect(syncLine(copy({ state: { kind: "syncing", files: 12 } }), at)).toBe("Syncing 12 files…");
    expect(syncLine(copy({ state: { kind: "syncing", files: 1 } }), at)).toBe("Syncing 1 file…");
    expect(syncLine(copy({ state: { kind: "waiting" } }), at)).toBe("Waiting for studio-mini. Changes made on this Mac sync when it is back.");
    expect(syncLine(copy({ state: { kind: "paused", reason: "the copy is on main, not fix-cart." } }), at)).toBe("Paused: the copy is on main, not fix-cart.");
  });

  it("puts setup, differing files and a diverged branch before In sync", () => {
    expect(syncLine(copy({ setup: { state: { kind: "running" }, command: "pnpm install", approved: true } }), at)).toBe("Running setup…");
    expect(syncLine(copy({ setup: { state: { kind: "failed", exit: 1 }, command: "pnpm install", approved: true } }), at)).toBe("Setup failed (exit 1)");
    expect(syncLine(copy({ differs: ["src/cart.ts"] }), at)).toBe("1 file differs");
    expect(syncLine(copy({ differs: ["a", "b", "c"] }), at)).toBe("3 files differ");
    expect(syncLine(copy({ diverged: { ahead: 1, behind: 2 } }), at)).toBe("fix-cart has diverged: 1 commit on this Mac, 2 on studio-mini. Files still sync.");
    expect(syncLine(copy({ diverged: { ahead: 2, behind: 1 } }), at)).toBe("fix-cart has diverged: 2 commits on this Mac, 1 on studio-mini. Files still sync.");
  });

  it("lets a paused or waiting copy say so over everything else", () => {
    const busy = { differs: ["a"], diverged: { ahead: 1, behind: 1 }, setup: { state: { kind: "running" as const }, command: "x", approved: true } };
    expect(syncLine(copy({ ...busy, state: { kind: "paused", reason: "studio-mini sent a path outside the copy." } }), at)).toBe("Paused: studio-mini sent a path outside the copy.");
    expect(syncLine(copy({ ...busy, state: { kind: "waiting" } }), at)).toBe("Waiting for studio-mini. Changes made on this Mac sync when it is back.");
  });

  it("leaves the path out where it is shown on its own, as in the popover", () => {
    expect(syncLine(copy(), { ...at, path: false })).toBe("In sync");
  });

  it("keeps a path outside the home folder as it is", () => {
    expect(syncLine(copy({ path: "/Volumes/work/fix-cart" }), at)).toBe("In sync · /Volumes/work/fix-cart");
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

describe("syncOffered (X60 the composer's checkbox and the project page switch)", () => {
  it("is offered only for a project on the central host", () => {
    expect(syncOffered("studio-mini", "studio-mini")).toBe(true);
    expect(syncOffered("build-box", "studio-mini")).toBe(false);
    expect(syncOffered("local", null)).toBe(false);
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

  it("says what turning sync off removes, and where it saves what would be lost", () => {
    expect(stopPrompt("fix-cart", 0, "/Users/alex/.moonlet", "/Users/alex").message).toBe("Stop keeping fix-cart in sync? The copy on this Mac is removed.");
    expect(stopPrompt("fix-cart", 2, "/Users/alex/.moonlet", "/Users/alex").message).toBe(
      "Stop keeping fix-cart in sync? The copy on this Mac is removed. 2 files that differ are saved to a folder in ~/.moonlet/sync-leftovers first.",
    );
    expect(stopPrompt("fix-cart", 1, "/Users/alex/.moonlet", null).message).toBe(
      "Stop keeping fix-cart in sync? The copy on this Mac is removed. 1 file that differs is saved to a folder in /Users/alex/.moonlet/sync-leftovers first.",
    );
  });

  it("tells the user a copy went and where its files are", () => {
    const folder = "/Users/alex/.moonlet/sync-leftovers/fix-cart-20261022-091500";
    expect(endedToast("fix-cart", "studio-mini", { reason: "archived", folder, leftovers: ["src/cart.ts"] }, "/Users/alex")).toBe(
      "fix-cart was archived on studio-mini. 1 file from this Mac is in ~/.moonlet/sync-leftovers/fix-cart-20261022-091500.",
    );
    expect(endedToast("fix-cart", "studio-mini", { reason: "archived", folder, leftovers: ["a", "b"] }, "/Users/alex")).toBe(
      "fix-cart was archived on studio-mini. 2 files from this Mac are in ~/.moonlet/sync-leftovers/fix-cart-20261022-091500.",
    );
    expect(endedToast("fix-cart", "studio-mini", { reason: "archived", folder, leftovers: [] }, "/Users/alex")).toBe("fix-cart was archived on studio-mini. Its copy on this Mac is removed.");
    expect(endedToast("fix-cart", "studio-mini", { reason: "stopped", folder, leftovers: ["a"] }, "/Users/alex")).toBe(
      "Stopped keeping fix-cart in sync. 1 file from this Mac is in ~/.moonlet/sync-leftovers/fix-cart-20261022-091500.",
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
    expect(tooBigLine("big.bin")).toBe("big.bin is over 100 MiB and stays on each machine.");
  });
});

describe("syncLine while this Mac's link is refused (X41, X60)", () => {
  it("says to pair again rather than wait", () => {
    expect(syncLine(copy({ state: { kind: "waiting" } }), { ...at, link: { kind: "refused" } })).toBe("Paused: studio-mini no longer accepts this Mac. Pair it again.");
    expect(syncLine(copy({ state: { kind: "waiting" } }), { ...at, link: { kind: "reconnecting" } })).toBe("Waiting for studio-mini. Changes made on this Mac sync when it is back.");
  });
});

describe("setupActions (X60 the popover's setup row)", () => {
  const setup = (state: NonNullable<Copy["setup"]>["state"], approved = true) => ({ state, command: "pnpm install", approved });
  it("offers Run setup, asking first, before it ran", () => {
    expect(setupActions(setup({ kind: "needs_approval" }, false))).toEqual({ log: false, run: { label: "Run setup", asks: true } });
    expect(setupActions(setup({ kind: "skipped" }, false))).toEqual({ log: false, run: { label: "Run setup", asks: true } });
    expect(setupActions(setup({ kind: "skipped" }, true))).toEqual({ log: false, run: { label: "Run setup", asks: false } });
  });
  it("shows the output while it runs and after, and runs it again asking only for a command not approved", () => {
    expect(setupActions(setup({ kind: "running" }))).toEqual({ log: true, run: null });
    expect(setupActions(setup({ kind: "done" }))).toEqual({ log: true, run: { label: "Run setup again", asks: false } });
    expect(setupActions(setup({ kind: "failed", exit: 1 }, false))).toEqual({ log: true, run: { label: "Run setup again", asks: true } });
  });
});

describe("compareReadError (X60 Compare)", () => {
  it("reads a file missing on one side as deleted there, and says why any other read failed", () => {
    // `fs.read` errors as the daemon words them (`cannot open <path>: <io error>`).
    expect(compareReadError(new Error("cannot open /Users/alex/.moonlet/worktrees/shop/fix-cart/src/cart.ts: No such file or directory (os error 2)"))).toBeNull();
    expect(compareReadError(new Error("cannot open /Users/alex/.moonlet/worktrees/shop/fix-cart/src/cart.ts: Permission denied (os error 13)"))).toBe(
      "cannot open /Users/alex/.moonlet/worktrees/shop/fix-cart/src/cart.ts: Permission denied (os error 13)",
    );
    expect(compareReadError(new Error("disconnected: studio-mini is not reachable"))).toBe("disconnected: studio-mini is not reachable");
  });
});

describe("moving or clearing the central host while sessions are kept in sync (X41, X60)", () => {
  it("asks only when copies of the current central host would be left behind", () => {
    expect(centralChangePrompt("studio-mini", "studio-mini", 2, "/Users/alex/.moonlet", "/Users/alex")).toBeNull();
    expect(centralChangePrompt("studio-mini", "build-box", 0, "/Users/alex/.moonlet", "/Users/alex")).toBeNull();
    expect(centralChangePrompt(null, "studio-mini", 0, "/Users/alex/.moonlet", "/Users/alex")).toBeNull();
  });

  it("says what moving it does", () => {
    expect(centralChangePrompt("studio-mini", "build-box", 2, "/Users/alex/.moonlet", "/Users/alex")).toEqual({
      title: "Change the central host",
      message:
        "2 sessions are kept in sync with studio-mini. Making build-box the central host stops keeping them in sync: their copies on this Mac are removed, and files only this Mac has are saved to a folder in ~/.moonlet/sync-leftovers first.",
      action: "Stop keeping in sync",
      variant: "danger",
    });
  });

  it("says what clearing it does, for one session", () => {
    expect(centralChangePrompt("studio-mini", null, 1, "/Users/alex/.moonlet", "/Users/alex")?.message).toBe(
      "1 session is kept in sync with studio-mini. Clearing the central host stops keeping it in sync: its copy on this Mac is removed, and files only this Mac has are saved to a folder in ~/.moonlet/sync-leftovers first.",
    );
  });
});

describe("composerSync (X60 what the composer's checkbox does once the session is made)", () => {
  it("keeps or declines as the box reads once its default is known or the user ticked it", () => {
    expect(composerSync({ shown: true, value: true, touched: false })).toBe("keep");
    expect(composerSync({ shown: true, value: false, touched: false })).toBe("decline");
    expect(composerSync({ shown: true, value: true, touched: true })).toBe("keep");
    expect(composerSync({ shown: true, value: false, touched: true })).toBe("decline");
  });

  it("says nothing while the project's choice is unknown and the user left the box alone", () => {
    expect(composerSync({ shown: true, value: null, touched: false })).toBeNull();
  });

  it("says nothing for a project that does not offer it", () => {
    expect(composerSync({ shown: false, value: true, touched: true })).toBeNull();
  });
});
