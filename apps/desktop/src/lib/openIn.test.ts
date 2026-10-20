import { describe, expect, it } from "vitest";
import { openInChoices, workspaceOpenTargets } from "./openIn";

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
    expect(openInChoices(targets, { dir: false, remote: false })).toEqual([
      { id: "reveal", label: "Finder" },
      { id: "cursor", label: "Cursor" },
      { id: "zed", label: "Zed" },
    ]);
  });

  it("reveals a local folder in Finder, and offers the editors and the terminals", () => {
    // `open` on a folder named Foo.app would launch it, so Finder reveals.
    expect(openInChoices(targets, { dir: true, remote: false })).toEqual([{ id: "reveal", label: "Finder" }, ...targets.slice(1)]);
  });

  it("offers only VS Code and Cursor on a remote host", () => {
    const withVsCode = [...targets, { id: "vscode", label: "VS Code" }];
    const remote = [
      { id: "cursor", label: "Cursor" },
      { id: "vscode", label: "VS Code" },
    ];
    expect(openInChoices(withVsCode, { dir: false, remote: true })).toEqual(remote);
    expect(openInChoices(withVsCode, { dir: true, remote: true })).toEqual(remote);
  });
});

describe("Open in for a tailnet host (X57)", () => {
  // `ssh-remote+` needs SSH; a tailnet host has none.
  const withVscode = [...targets, { id: "vscode", label: "VS Code" }];

  it("offers nothing for an entry on a tailnet host", () => {
    expect(openInChoices(withVscode, { dir: true, remote: true, tailnet: true })).toEqual([]);
  });

  it("offers VS Code and Cursor for a workspace on an SSH host, everything here, nothing on a tailnet host", () => {
    expect(workspaceOpenTargets(withVscode, "ssh").map((t) => t.id)).toEqual(["cursor", "vscode"]);
    expect(workspaceOpenTargets(withVscode, "local")).toEqual(withVscode);
    expect(workspaceOpenTargets(withVscode, "tailnet")).toEqual([]);
  });
});
