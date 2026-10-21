import { describe, expect, it } from "vitest";
import { openInChoices, syncedOpenIn, syncedWorkspaceOpenIn, workspaceOpenTargets } from "./openIn";

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
  const copy = "/Users/alex/.moonlet/worktrees/shop/fix-cart";

  it("opens the entry in the copy on this Mac, with this Mac's apps", () => {
    expect(syncedOpenIn(withVscode, { dir: false, kind: "tailnet" }, copy, "/Users/alex/.moonlet/worktrees/shop/fix-cart", "/Users/alex/.moonlet/worktrees/shop/fix-cart/src/cart.ts")).toEqual({
      path: "/Users/alex/.moonlet/worktrees/shop/fix-cart/src/cart.ts",
      choices: [
        { id: "reveal", label: "Finder" },
        { id: "cursor", label: "Cursor" },
        { id: "zed", label: "Zed" },
        { id: "vscode", label: "VS Code" },
      ],
    });
  });

  it("offers the workspace's apps for the session folder itself", () => {
    expect(syncedWorkspaceOpenIn(withVscode, copy).map((t) => t.id)).toEqual(["finder", "cursor", "zed", "ghostty", "terminal", "vscode"]);
  });

  it("has nothing to offer without a copy", () => {
    expect(syncedOpenIn(withVscode, { dir: false, kind: "tailnet" }, null, "/s", "/s/a")).toBeNull();
    expect(syncedWorkspaceOpenIn(withVscode, null)).toEqual([]);
  });
});
