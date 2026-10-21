import { describe, expect, it } from "vitest";
import { openInChoices, syncedOpenIn, workspaceOpenIn, workspaceOpenTargets } from "./openIn";

// What `open_targets` returns on a Mac with Cursor, Zed, Ghostty and Terminal installed.
const targets = [
  { id: "finder", label: "Finder" },
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
  { id: "ghostty", label: "Ghostty" },
  { id: "terminal", label: "Terminal" },
];

describe("openInChoices (X25)", () => {
  it("reveals a local file in Finder and offers the editors, not the terminals", () => {
    expect(openInChoices(targets, { dir: false, kind: "local" })).toEqual([
      { id: "reveal", label: "Finder" },
      { id: "cursor", label: "Cursor" },
      { id: "zed", label: "Zed" },
    ]);
  });

  it("reveals a local folder in Finder, and offers the editors and the terminals", () => {
    // `open` on a folder named Foo.app would launch it, so Finder reveals.
    expect(openInChoices(targets, { dir: true, kind: "local" })).toEqual([{ id: "reveal", label: "Finder" }, ...targets.slice(1)]);
  });

  it("offers only VS Code and Cursor on a remote host", () => {
    const withVsCode = [...targets, { id: "vscode", label: "VS Code" }];
    const remote = [
      { id: "cursor", label: "Cursor" },
      { id: "vscode", label: "VS Code" },
    ];
    expect(openInChoices(withVsCode, { dir: false, kind: "ssh" })).toEqual(remote);
    expect(openInChoices(withVsCode, { dir: true, kind: "ssh" })).toEqual(remote);
  });
});

describe("Open in for a tailnet host (X57)", () => {
  // `ssh-remote+` needs SSH; a tailnet host has none.
  const withVscode = [...targets, { id: "vscode", label: "VS Code" }];

  it("offers nothing for an entry on a tailnet host", () => {
    expect(openInChoices(withVscode, { dir: true, kind: "tailnet" })).toEqual([]);
  });

  it("offers VS Code and Cursor for a workspace on an SSH host, everything here, nothing on a tailnet host", () => {
    expect(workspaceOpenTargets(withVscode, "ssh").map((t) => t.id)).toEqual(["cursor", "vscode"]);
    expect(workspaceOpenTargets(withVscode, "local")).toEqual(withVscode);
    expect(workspaceOpenTargets(withVscode, "tailnet")).toEqual([]);
  });
});

describe("Open in for a session kept in sync (X60)", () => {
  const withVscode = [...targets, { id: "vscode", label: "VS Code" }];
  // The copy sits elsewhere than the session, as when its path was taken.
  const roots = { copy: "/Users/alex/.moonlet/copies/studio-mini/shop/fix-cart", session: "/Users/sam/.moonlet/worktrees/shop/fix-cart" };

  it("opens the entry in the copy on this Mac, at the same place, with this Mac's apps", () => {
    expect(syncedOpenIn(withVscode, false, roots, "/Users/sam/.moonlet/worktrees/shop/fix-cart/src/cart.ts")).toEqual({
      path: "/Users/alex/.moonlet/copies/studio-mini/shop/fix-cart/src/cart.ts",
      choices: [
        { id: "reveal", label: "Finder" },
        { id: "cursor", label: "Cursor" },
        { id: "zed", label: "Zed" },
        { id: "vscode", label: "VS Code" },
      ],
    });
    expect(syncedOpenIn(withVscode, true, roots, "/Users/sam/.moonlet/worktrees/shop/fix-cart")?.path).toBe("/Users/alex/.moonlet/copies/studio-mini/shop/fix-cart");
  });

  it("has nothing to offer without a copy, or for a path outside the session", () => {
    expect(syncedOpenIn(withVscode, false, { copy: null, session: "/s" }, "/s/a")).toBeNull();
    expect(syncedOpenIn(withVscode, false, roots, "/Users/sam/.moonlet/worktrees/shop/fix-cart-2/a")).toBeNull();
  });
});

describe("workspaceOpenIn: the session header's Open in (X25, X60)", () => {
  const withVscode = [...targets, { id: "vscode", label: "VS Code" }];
  it("opens a session kept in sync from its copy, with every app on this Mac", () => {
    expect(workspaceOpenIn(withVscode, { kind: "tailnet", host: "studio-mini", path: "/Users/sam/.moonlet/worktrees/shop/fix-cart" }, "/Users/alex/.moonlet/copies/studio-mini/shop/fix-cart")).toEqual({
      choices: withVscode,
      path: "/Users/alex/.moonlet/copies/studio-mini/shop/fix-cart",
      host: undefined,
    });
  });
  it("opens any other session where it is, with its host's apps", () => {
    expect(workspaceOpenIn(withVscode, { kind: "tailnet", host: "studio-mini", path: "/w" }, null)).toEqual({ choices: [], path: "/w", host: "studio-mini" });
    expect(workspaceOpenIn(withVscode, { kind: "ssh", host: "devbox", path: "/w" }, null)).toEqual({ choices: [{ id: "cursor", label: "Cursor" }, { id: "vscode", label: "VS Code" }], path: "/w", host: "devbox" });
  });
});
